/**
 * 情绪系统服务（Emotion System）
 *
 * 基于关键词规则引擎，按 user_id + character_id 维度持久化情绪状态。
 * 不调用大模型，不阻塞主回复流程。
 *
 * 设计原则：
 *   - 增强型：不修改/削弱已有 memory / summary / 向量检索 / personality
 *   - 纯规则引擎：轻量关键词匹配，无 LLM 调用
 *   - fire-and-forget 更新：不阻塞聊天响应
 */
import db from '../db';

// ========== 类型定义 ==========

export type Mood = 'warm' | 'happy' | 'playful' | 'shy' | 'caring' | 'upset' | 'jealous' | 'distant';

export interface EmotionState {
  user_id: number;
  character_id: number;
  mood: Mood;
  affection: number;
  trust_score: number;
  jealousy_score: number;
  stability_score: number;
  last_trigger: string | null;
  updated_at: string;
}

// ========== 关键词规则 ==========

const INTIMATE_KEYWORDS = ['想你', '抱抱', '亲亲', '爱你', '宝宝', '老婆', '乖', '宝贝'];
const COLD_KEYWORDS = ['随便', '算了', '滚', '闭嘴', '烦死了', '别吵', '懒得理你', '无所谓'];
const JEALOUSY_KEYWORDS = ['别的女生', '另一个女的', '她比你好', '我陪别人', '别人更好'];
const CARING_KEYWORDS = ['你没事吧', '别难过', '辛苦了', '抱抱你', '你还好吗'];

// ========== Helpers ==========

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function containsAny(text: string, keywords: string[]): boolean {
  return keywords.some(k => text.includes(k));
}

function pickMood(candidates: Mood[], current: Mood, stability: number): Mood {
  // stability 越高越不容易跳变；随机因子让表现不那么死板
  if (Math.random() < stability * 0.6) return current;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// ========== 公开 API ==========

/**
 * 确保 emotion_state 记录存在，不存在则插入默认值
 */
export function ensureEmotionState(userId: number, characterId: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO emotion_state (user_id, character_id) VALUES (?, ?)`
  ).run(userId, characterId);
}

/**
 * 只读获取情绪状态，不存在时返回 null（供 API 使用）
 */
export function readEmotionState(userId: number, characterId: number): EmotionState | null {
  const row = db
    .prepare('SELECT * FROM emotion_state WHERE user_id = ? AND character_id = ?')
    .get(userId, characterId) as EmotionState | undefined;
  return row ?? null;
}

/**
 * 获取当前情绪状态，若不存在先 ensure 再读取（供 chat 使用）
 */
export function getEmotionState(userId: number, characterId: number): EmotionState {
  ensureEmotionState(userId, characterId);
  const row = db
    .prepare('SELECT * FROM emotion_state WHERE user_id = ? AND character_id = ?')
    .get(userId, characterId) as EmotionState;
  return row;
}

/**
 * 根据用户输入和 AI 回复做轻量规则更新（纯规则引擎，不调用大模型）
 */
export function updateEmotionState(
  userId: number,
  characterId: number,
  userInput: string,
  _aiReply: string
): void {
  const state = getEmotionState(userId, characterId);

  let { affection, trust_score, jealousy_score, stability_score, mood } = state;
  let trigger: string | null = state.last_trigger;
  let moodChanged = false;

  // 规则1：亲密表达
  if (containsAny(userInput, INTIMATE_KEYWORDS)) {
    affection += 0.05;
    trust_score += 0.03;
    mood = pickMood(['warm', 'happy', 'shy'], mood, stability_score);
    trigger = '亲密表达';
    moodChanged = true;
  }

  // 规则2：冷淡/攻击
  if (containsAny(userInput, COLD_KEYWORDS)) {
    affection -= 0.04;
    trust_score -= 0.05;
    mood = pickMood(['upset', 'distant'], mood, stability_score);
    trigger = '冷淡或攻击表达';
    moodChanged = true;
  }

  // 规则3：第三者/其他异性话题
  if (containsAny(userInput, JEALOUSY_KEYWORDS)) {
    jealousy_score += 0.08;
    mood = pickMood(['jealous', 'upset'], mood, stability_score);
    trigger = '第三者话题';
    moodChanged = true;
  }

  // 规则4：安慰/关心
  if (containsAny(userInput, CARING_KEYWORDS)) {
    affection += 0.03;
    trust_score += 0.05;
    mood = pickMood(['caring', 'warm', 'shy'], mood, stability_score);
    trigger = '被安慰关心';
    moodChanged = true;
  }

  // 自然衰减：jealousy 缓慢回落
  if (!containsAny(userInput, JEALOUSY_KEYWORDS)) {
    jealousy_score -= 0.01;
  }

  // 情绪稳定机制：没有明显触发时不改 mood
  if (!moodChanged) {
    // 只做微调衰减，不变 mood
    affection += 0.001; // 微弱正向漂移
  }

  // clamp 所有分值
  affection = clamp(affection);
  trust_score = clamp(trust_score);
  jealousy_score = clamp(jealousy_score);
  stability_score = clamp(stability_score);

  db.prepare(
    `UPDATE emotion_state
     SET mood = ?, affection = ?, trust_score = ?, jealousy_score = ?,
         stability_score = ?, last_trigger = ?, updated_at = datetime('now')
     WHERE user_id = ? AND character_id = ?`
  ).run(mood, affection, trust_score, jealousy_score, stability_score, trigger, userId, characterId);
}

/**
 * 构建情绪 prompt 片段（~120 字），插入 system prompt
 */
export function buildEmotionPrompt(state: EmotionState): string {
  const moodMap: Record<Mood, string> = {
    warm: '她现在和用户的互动是自然亲近的，像熟悉恋人的日常聊天。语气可以更温柔或稍微有点在意，但要克制自然，不要直接把情绪说破。',
    happy: '她现在心情不错，互动会更轻快主动一点。语气自然愉悦，但不要浮夸或用力过猛。',
    playful: '她现在有点想逗用户，语气略带俏皮。可以开小玩笑，但保持自然不刻意。',
    shy: '她现在有一点害羞，语气稍微收一点但依然亲近。表达上会含蓄一些，不要太直白。',
    caring: '她现在更愿意照顾用户情绪，语气更体贴温和。关心自然流露，不要刻意强调。',
    upset: '她现在有点委屈或不开心，语气克制地带一点情绪。不要直接发脾气或无理取闹。',
    jealous: '她现在会有一点在意和试探，语气带轻微吃醋感。不要攻击性太强，保持克制。',
    distant: '她现在稍微收着一点，不像平时那么主动热情。保持交流但语气偏平淡。',
  };

  const mood = state.mood || 'warm';
  let text = moodMap[mood] || moodMap.warm;

  // 附加修饰（精简，避免 token 膨胀）
  const extras: string[] = [];
  if (state.affection >= 0.7) extras.push('整体语气更自然亲密。');
  else if (state.affection <= 0.3) extras.push('语气偏平淡克制。');
  if (state.trust_score >= 0.7) extras.push('她更愿意表达真实感受。');
  if (state.jealousy_score >= 0.3) extras.push('对第三者话题会更敏感一些。');

  if (extras.length > 0) text += extras.join('');

  return text;
}
