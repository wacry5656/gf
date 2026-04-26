/**
 * 关系进化服务（Relationship Evolution）
 *
 * 基于关键词规则引擎，按 user_id + character_id 维度持久化关系状态。
 * 不调用大模型，不阻塞主回复流程。
 *
 * 设计原则：
 *   - 增强型：不修改/削弱已有 memory / summary / 向量检索 / personality / emotion
 *   - 纯规则引擎：轻量关键词匹配，无 LLM 调用
 *   - fire-and-forget 更新：不阻塞聊天响应
 *   - 高敏但不乱跳：明显亲密/冷淡表达会立刻反馈，普通闲聊不刷分
 */
import db from '../db';

// ========== 类型定义 ==========

export type RelationshipPhase = 'close' | 'attached' | 'deep_attached' | 'strained';

export interface RelationshipState {
  user_id: number;
  character_id: number;
  closeness: number;
  trust: number;
  dependence: number;
  comfort_level: number;
  phase: RelationshipPhase;
  last_event: string | null;
  updated_at: string;
}

// ========== 关键词规则 ==========

const DEFAULT_RELATIONSHIP = {
  closeness: 0.72,
  trust: 0.62,
  dependence: 0.64,
  comfortLevel: 0.74,
  phase: 'attached' as RelationshipPhase,
};

const INTIMATE_KEYWORDS = ['想你', '爱你', '抱抱', '亲亲', '宝宝', '老婆', '老公', '宝贝', '乖', '对象', '女朋友', '男朋友', '贴贴', 'mua', '陪我', '想我'];
const CARING_KEYWORDS = ['辛苦了', '你没事吧', '别难过', '抱抱你', '你还好吗', '我陪你', '别怕', '有我在', '心疼你', '照顾你'];
const COLD_KEYWORDS = ['随便', '算了', '滚', '闭嘴', '烦死了', '别吵', '懒得理你', '无所谓', '不想理你', '别烦我'];
const THIRD_PARTY_KEYWORDS = ['我陪别人', '别的女生', '别的男生', '别人更好', '她比你好', '他比你好', '前任', '另一个'];

// ========== Helpers ==========

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function containsAny(text: string, keywords: string[]): boolean {
  return keywords.some(k => text.includes(k));
}

function sensitivity(): number {
  const value = Number(process.env.RELATIONSHIP_STATE_SENSITIVITY || 1.65);
  return Number.isFinite(value) && value > 0 ? value : 1.65;
}

function delta(value: number, text: string): number {
  const lengthBoost = text.trim().length >= 20 ? 1.15 : 1;
  return value * sensitivity() * lengthBoost;
}

function determinePhase(closeness: number, trust: number, comfortLevel: number): RelationshipPhase {
  if (trust < 0.35 || comfortLevel < 0.35) return 'strained';
  if (closeness >= 0.75 && trust >= 0.7) return 'deep_attached';
  if (closeness >= 0.6 && trust >= 0.6) return 'attached';
  return 'close';
}

// ========== 公开 API ==========

/**
 * 确保 relationship_state 记录存在，不存在则插入默认值
 */
export function ensureRelationshipState(userId: number, characterId: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO relationship_state
       (user_id, character_id, closeness, trust, dependence, comfort_level, phase)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId,
    characterId,
    DEFAULT_RELATIONSHIP.closeness,
    DEFAULT_RELATIONSHIP.trust,
    DEFAULT_RELATIONSHIP.dependence,
    DEFAULT_RELATIONSHIP.comfortLevel,
    DEFAULT_RELATIONSHIP.phase
  );

  db.prepare(
    `UPDATE relationship_state
     SET closeness = ?, trust = ?, dependence = ?, comfort_level = ?, phase = ?, updated_at = datetime('now')
     WHERE user_id = ? AND character_id = ?
       AND closeness = 0.5 AND trust = 0.5 AND dependence = 0.3 AND comfort_level = 0.5
       AND phase = 'close' AND last_event IS NULL`
  ).run(
    DEFAULT_RELATIONSHIP.closeness,
    DEFAULT_RELATIONSHIP.trust,
    DEFAULT_RELATIONSHIP.dependence,
    DEFAULT_RELATIONSHIP.comfortLevel,
    DEFAULT_RELATIONSHIP.phase,
    userId,
    characterId
  );
}

/**
 * 只读获取关系状态，不存在时返回 null
 */
export function readRelationshipState(userId: number, characterId: number): RelationshipState | null {
  const row = db
    .prepare('SELECT * FROM relationship_state WHERE user_id = ? AND character_id = ?')
    .get(userId, characterId) as RelationshipState | undefined;
  return row ?? null;
}

/**
 * 获取当前关系状态，若不存在先 ensure 再读取（供 chat 使用）
 */
export function getRelationshipState(userId: number, characterId: number): RelationshipState {
  ensureRelationshipState(userId, characterId);
  const row = db
    .prepare('SELECT * FROM relationship_state WHERE user_id = ? AND character_id = ?')
    .get(userId, characterId) as RelationshipState;
  return row;
}

/**
 * 根据用户输入做轻量规则更新（纯规则引擎，不调用大模型）
 *
 * 关系变化更敏感：明显情绪输入会有可见变化，普通闲聊不刷分。
 */
export function updateRelationshipState(
  userId: number,
  characterId: number,
  userInput: string,
  _aiReply: string
): void {
  const state = getRelationshipState(userId, characterId);

  let { closeness, trust, dependence, comfort_level } = state;
  let lastEvent: string | null = state.last_event;
  let matched = false;

  // 规则1：亲密表达
  if (containsAny(userInput, INTIMATE_KEYWORDS)) {
    closeness += delta(0.055, userInput);
    trust += delta(0.035, userInput);
    comfort_level += delta(0.045, userInput);
    dependence += delta(0.04, userInput);
    lastEvent = '亲密互动';
    matched = true;
  }

  // 规则2：安慰/关心
  if (containsAny(userInput, CARING_KEYWORDS)) {
    trust += delta(0.06, userInput);
    closeness += delta(0.035, userInput);
    comfort_level += delta(0.055, userInput);
    dependence += delta(0.025, userInput);
    lastEvent = '被关心安慰';
    matched = true;
  }

  // 规则3：冷淡/攻击
  if (containsAny(userInput, COLD_KEYWORDS)) {
    trust -= delta(0.075, userInput);
    closeness -= delta(0.06, userInput);
    comfort_level -= delta(0.07, userInput);
    dependence -= delta(0.03, userInput);
    lastEvent = '冷淡或攻击互动';
    matched = true;
  }

  // 规则4：第三者/他人优先
  if (containsAny(userInput, THIRD_PARTY_KEYWORDS)) {
    closeness -= delta(0.055, userInput);
    trust -= delta(0.055, userInput);
    comfort_level -= delta(0.04, userInput);
    lastEvent = '第三者话题';
    matched = true;
  }

  // 规则5：中性聊天 — 不改变关系状态（不再自动升温）
  // 只有明确正向互动（亲密、关心）才提升关系

  // clamp 所有分值
  closeness = clamp(closeness);
  trust = clamp(trust);
  dependence = clamp(dependence);
  comfort_level = clamp(comfort_level);

  // 判定关系阶段
  const phase = determinePhase(closeness, trust, comfort_level);

  db.prepare(
    `UPDATE relationship_state
     SET closeness = ?, trust = ?, dependence = ?, comfort_level = ?,
         phase = ?, last_event = ?, updated_at = datetime('now')
     WHERE user_id = ? AND character_id = ?`
  ).run(closeness, trust, dependence, comfort_level, phase, lastEvent, userId, characterId);
}

/**
 * 构建关系状态提示（1 句话，60~80 字）
 */
export function buildRelationshipPrompt(state: RelationshipState): string {
  const phaseMap: Record<RelationshipPhase, string> = {
    close: '她默认认同自己就是用户的对象，可以像日常恋人那样自然聊天。',
    attached: '她把自己当作用户的对象/恋人，会更主动、更自然，也更在意用户反应。',
    deep_attached: '她对用户有明显亲密感和信任感，会自然依赖，也更愿意表达真实情绪。',
    strained: '她默认仍是用户的对象，只是现在有点别扭，会稍微收着一点但不故意疏远。',
  };

  const phase = (state.phase as RelationshipPhase) || 'close';
  return phaseMap[phase] || phaseMap.close;
}
