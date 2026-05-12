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
 *   - 情绪变化参考 relationship_state，使变化更连续合理
 */
import db from '../db';
import { auditInteraction } from './interactionAudit';
import { readRelationshipState } from './relationship';

// ========== 类型定义 ==========

export type Mood = 'warm' | 'happy' | 'playful' | 'shy' | 'caring' | 'upset' | 'jealous' | 'distant' | 'sulking' | 'disappointed' | 'anticipating';

export interface EmotionState {
  user_id: number;
  character_id: number;
  mood: Mood;
  affection: number;
  trust_score: number;
  jealousy_score: number;
  anger_score: number;
  stability_score: number;
  last_trigger: string | null;
  updated_at: string;
}

// ========== 默认状态 ==========

const DEFAULT_EMOTION = {
  mood: 'warm' as Mood,
  affection: 0.65,
  trustScore: 0.55,
  jealousyScore: 0,
  angerScore: 0,
  stabilityScore: 0.75,
};

// ========== Helpers ==========

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function getCharacterRelationshipMode(characterId: number): 'lover' | 'friend' {
  const row = db
    .prepare('SELECT relationship_mode FROM characters WHERE id = ?')
    .get(characterId) as { relationship_mode?: string } | undefined;
  return row?.relationship_mode === 'friend' ? 'friend' : 'lover';
}

function sensitivity(): number {
  const value = Number(process.env.RELATIONSHIP_STATE_SENSITIVITY || process.env.EMOTION_STATE_SENSITIVITY || 1.65);
  return Number.isFinite(value) && value > 0 ? value : 1.65;
}

function delta(value: number, text: string): number {
  const lengthBoost = text.trim().length >= 20 ? 1.15 : 1;
  return value * sensitivity() * lengthBoost;
}

function positiveChangeFactor(currentValue: number, lastTrigger: string | null, updatedAt: string, nextTrigger: string | null): number {
  const headroom = 0.35 + 0.65 * (1 - clamp(currentValue));
  if (!lastTrigger || !nextTrigger || lastTrigger !== nextTrigger) return headroom;
  const updated = Date.parse(`${updatedAt.replace(' ', 'T')}Z`);
  if (!Number.isFinite(updated)) return headroom;
  const minutes = (Date.now() - updated) / 60000;
  if (minutes < 30) return headroom * 0.3;
  if (minutes < 360) return headroom * 0.6;
  return headroom;
}

function pickMood(candidates: Mood[], current: Mood, stability: number): Mood {
  if (Math.random() < stability * 0.55) return current;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function naturalMoodDecay(mood: Mood, angerScore: number, jealousyScore: number): Mood | null {
  const roll = Math.random();
  if (mood === 'upset' && angerScore < 0.25 && roll < 0.35) return 'warm';
  if (mood === 'jealous' && jealousyScore < 0.2 && roll < 0.3) return 'warm';
  if (mood === 'sulking' && roll < 0.25) return 'warm';
  if (mood === 'distant' && roll < 0.15) return 'warm';
  if (mood === 'disappointed' && roll < 0.2) return 'warm';
  return null;
}

// ========== 公开 API ==========

/**
 * 确保 emotion_state 记录存在，不存在则插入默认值
 */
export function ensureEmotionState(userId: number, characterId: number): void {
  const relationshipMode = getCharacterRelationshipMode(characterId);
  const defaults = relationshipMode === 'friend'
    ? { ...DEFAULT_EMOTION, affection: 0.38, trustScore: 0.52, stabilityScore: 0.78 }
    : DEFAULT_EMOTION;

  db.prepare(
    `INSERT OR IGNORE INTO emotion_state
       (user_id, character_id, mood, affection, trust_score, jealousy_score, anger_score, stability_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId,
    characterId,
    defaults.mood,
    defaults.affection,
    defaults.trustScore,
    defaults.jealousyScore,
    defaults.angerScore,
    defaults.stabilityScore
  );

  db.prepare(
    `UPDATE emotion_state
     SET mood = ?, affection = ?, trust_score = ?, jealousy_score = ?, anger_score = ?, stability_score = ?, updated_at = datetime('now')
     WHERE user_id = ? AND character_id = ?
       AND mood = 'warm' AND affection = 0.5 AND trust_score = 0.5
       AND jealousy_score = 0.0 AND stability_score = 0.8 AND last_trigger IS NULL`
  ).run(
    defaults.mood,
    defaults.affection,
    defaults.trustScore,
    defaults.jealousyScore,
    defaults.angerScore,
    defaults.stabilityScore,
    userId,
    characterId
  );
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
 *
 * 情绪变化参考 relationship_state：
 * - closeness 高时：更容易保持 warm/caring/shy，不容易因一句冷淡话直接变 distant
 * - trust 高时：upset/jealous 时也更克制，更容易回到 warm
 * - trust 低或 comfort_level 低时：更容易偏 distant/upset
 * - jealousy 高但 closeness 高时：更偏"轻微在意"，不变攻击性吃醋
 */
export function updateEmotionState(
  userId: number,
  characterId: number,
  userInput: string,
  _aiReply: string
): void {
  const state = getEmotionState(userId, characterId);

  const relationshipMode = getCharacterRelationshipMode(characterId);
  const rel = readRelationshipState(userId, characterId);
  const closeness = rel?.closeness ?? 0.5;
  const relTrust = rel?.trust ?? 0.5;
  const comfortLevel = rel?.comfort_level ?? 0.5;

  let { affection, trust_score, jealousy_score, anger_score = 0, stability_score, mood } = state;
  let trigger: string | null = state.last_trigger;
  let moodChanged = false;

  const trimmed = userInput.trim();
  const isTooShort = trimmed.length <= 1;
  const audit = auditInteraction(userInput, relationshipMode);
  const partnerConflict = audit.partnerConflict;

  // 规则0：撒娇 → 亲密度微涨，心情变好或害羞
  if (relationshipMode === 'lover' && !partnerConflict && audit.coquettish) {
    affection += delta(0.02, userInput);
    jealousy_score -= delta(0.03, userInput);
    mood = pickMood(['happy', 'shy', 'playful'], mood, stability_score);
    trigger = '撒娇';
    moodChanged = true;
  }

  // 规则0b：分享日常 → 心情微暖，信任微涨
  if (!isTooShort && audit.sharing && !audit.cold && !audit.attack) {
    trust_score += delta(0.012, userInput);
    if (!moodChanged) {
      mood = pickMood(['warm', 'happy'], mood, stability_score);
      trigger = '分享日常';
      moodChanged = true;
    }
  }

  // 规则0c：无聊/抱怨生活 → 当下心情微低，但不影响感情
  if (!isTooShort && audit.boredComplaint && !audit.cold && !audit.attack) {
    if (!moodChanged) {
      mood = pickMood(['caring', 'warm'], mood, stability_score);
      trigger = '无聊或吐槽';
      moodChanged = true;
    }
  }

  // 规则1：亲密表达/索取确认只影响语气，不直接涨好感
  if (relationshipMode === 'lover' && !partnerConflict && (audit.intimateExpression || audit.reassuranceSeeking)) {
    anger_score -= delta(0.035, userInput);
    jealousy_score -= delta(0.02, userInput);
    if (!moodChanged) {
      mood = pickMood(['warm', 'happy', 'shy'], mood, stability_score);
      trigger = audit.primaryEvent || '亲密表达';
      moodChanged = true;
    }
  }

  // 规则2：冷淡/攻击（单字不触发）
  if (!isTooShort && (audit.cold || audit.attack)) {
    const dampening = closeness >= 0.7 ? 0.5 : 1.0;
    affection -= delta(audit.attack ? 0.09 : 0.06, userInput) * dampening;
    trust_score -= delta(audit.attack ? 0.09 : 0.06, userInput) * dampening;
    anger_score += delta(audit.attack ? 0.13 : 0.08, userInput) * dampening;
    if (relTrust >= 0.6) {
      mood = pickMood(['upset', 'sulking'], mood, stability_score);
    } else {
      mood = pickMood(['upset', 'distant'], mood, stability_score);
    }
    trigger = audit.primaryEvent || '冷淡或攻击表达';
    moodChanged = true;
  }

  // 规则3：第三者/其他异性话题
  if (relationshipMode === 'lover' && audit.thirdParty) {
    affection -= delta(partnerConflict ? 0.16 : 0.03, userInput);
    trust_score -= delta(partnerConflict ? 0.12 : 0.02, userInput);
    jealousy_score += delta(partnerConflict ? 0.18 : 0.12, userInput);
    anger_score += delta(partnerConflict ? 0.08 : 0.03, userInput);
    if (closeness >= 0.6) {
      mood = pickMood(['jealous', 'sulking'], mood, stability_score);
    } else {
      mood = pickMood(['jealous', 'upset'], mood, stability_score);
    }
    trigger = audit.primaryEvent || (partnerConflict ? '关系冲突' : '第三者话题');
    moodChanged = true;
  }

  // 规则4：通过审核的真实关心/修复/承诺才小幅增长
  if (audit.canIncreaseBond) {
    const scoreBoost = Math.min(1.5, audit.positiveScore) / 1.5;
    const changeFactor = positiveChangeFactor(affection, state.last_trigger, state.updated_at, audit.primaryEvent);
    affection += delta(0.018 + 0.02 * scoreBoost, userInput) * changeFactor;
    trust_score += delta(0.028 + 0.025 * scoreBoost, userInput) * changeFactor;
    anger_score -= delta(0.06, userInput);
    jealousy_score -= delta(0.03, userInput);
    if (!moodChanged) {
      mood = pickMood(['caring', 'warm', 'anticipating'], mood, stability_score);
      trigger = audit.primaryEvent || '正向互动';
      moodChanged = true;
    }
  }

  // 规则5：道歉/修复互动 → 降低生气和嫉妒
  if (!isTooShort && audit.repair && !audit.cold && !audit.attack) {
    anger_score -= delta(0.08, userInput);
    jealousy_score -= delta(0.06, userInput);
    trust_score += delta(0.02, userInput);
    if (!moodChanged) {
      mood = pickMood(['warm', 'shy'], mood, stability_score);
      trigger = '道歉修复';
      moodChanged = true;
    }
  }

  // 规则6：试探/暗示
  if (!isTooShort && audit.probing && !audit.cold && !audit.attack && !audit.thirdParty) {
    if (!moodChanged) {
      mood = pickMood(['shy', 'playful', 'anticipating'], mood, stability_score);
      trigger = '试探暗示';
      moodChanged = true;
    }
  }

  // 自然衰减：jealousy 缓慢回落
  if (relationshipMode === 'friend') {
    jealousy_score -= 0.04;
  } else if (!audit.thirdParty) {
    jealousy_score -= 0.015;
  }

  if (!audit.cold && !audit.attack) {
    anger_score -= 0.018;
  }

  // 情绪稳定机制：没有明显触发时尝试回到warm
  if (!moodChanged) {
    const decayedMood = naturalMoodDecay(mood, anger_score, jealousy_score);
    if (decayedMood) {
      mood = decayedMood;
      trigger = '自然回温';
    } else if (relTrust >= 0.65 && (mood === 'upset' || mood === 'distant' || mood === 'sulking')) {
      if (Math.random() < 0.25) {
        mood = 'warm';
        trigger = '自然回温';
      }
    }
  }

  // comfort_level 低时更容易偏 distant
  if (comfortLevel < 0.35 && !moodChanged && Math.random() < 0.15) {
    mood = 'distant';
  }

  // clamp
  affection = clamp(affection);
  trust_score = clamp(trust_score);
  jealousy_score = clamp(jealousy_score);
  anger_score = clamp(anger_score);
  stability_score = clamp(stability_score);

  db.prepare(
    `UPDATE emotion_state
     SET mood = ?, affection = ?, trust_score = ?, jealousy_score = ?, anger_score = ?,
         stability_score = ?, last_trigger = ?, updated_at = datetime('now')
     WHERE user_id = ? AND character_id = ?`
  ).run(mood, affection, trust_score, jealousy_score, anger_score, stability_score, trigger, userId, characterId);

  db.prepare(
    `INSERT INTO emotion_snapshots (user_id, character_id, mood, affection, trust_score, jealousy_score, anger_score)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, characterId, mood, affection, trust_score, jealousy_score, anger_score);
}

/**
 * 构建情绪 prompt 片段（1 句话，省 token）
 */
export function buildEmotionPrompt(state: EmotionState): string {
  const relationshipMode = getCharacterRelationshipMode(state.character_id);
  if (relationshipMode === 'friend' && state.mood === 'jealous') {
    return '当前只是普通朋友关系，不表现吃醋或占有欲，正常接话。';
  }

  const moodMap: Record<Mood, string> = {
    warm: '当前情绪稳定，自然聊天，语气不刻意甜也不冷淡。',
    happy: '当前心情不错，回复可以轻快一些，但一两句就够，不要刷屏。',
    playful: '当前有点想轻松调侃，可以俏皮一两句，但不连续玩梗。',
    shy: '当前稍有点害羞，语气收一点，但必须正常回话不躲。',
    caring: '当前更想照顾对方情绪，先接住对方的话，但不长篇安慰。',
    upset: state.anger_score >= 0.45
      ? '当前明显不高兴，会直接说不满，短句、明确，不写动作也不冷暴力。'
      : '当前有点不高兴，回复会更短更克制，但仍正常回话。',
    jealous: '当前有一点在意/吃醋，只轻描淡写一句表达，不阴阳怪气不控制对方。',
    sulking: '当前在生闷气，回复比平时短，语气带一点别扭，但不会不理人。',
    distant: '当前有点收着，回复更短，但不用沉默或动作代替回答。',
    disappointed: '当前有一点小失望，语气稍低落，但仍然平静地回话。',
    anticipating: '当前有点期待，语气比平时稍主动一点，自然地接话。',
  };

  const mood = state.mood || 'warm';
  return moodMap[mood] || moodMap.warm;
}
