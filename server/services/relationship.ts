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
 *   - 变化缓慢：关系不会因为一句话大起大落
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

const INTIMATE_KEYWORDS = ['想你', '爱你', '抱抱', '亲亲', '宝宝', '老婆', '宝贝', '乖'];
const CARING_KEYWORDS = ['辛苦了', '你没事吧', '别难过', '抱抱你', '你还好吗'];
const COLD_KEYWORDS = ['随便', '算了', '滚', '闭嘴', '烦死了', '别吵', '懒得理你', '无所谓'];
const THIRD_PARTY_KEYWORDS = ['我陪别人', '别的女生', '别人更好', '她比你好'];

// ========== Helpers ==========

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function containsAny(text: string, keywords: string[]): boolean {
  return keywords.some(k => text.includes(k));
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
    `INSERT OR IGNORE INTO relationship_state (user_id, character_id) VALUES (?, ?)`
  ).run(userId, characterId);
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
 * 关系变化缓慢，不会因为一句话大跳变
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
    closeness += 0.03;
    trust += 0.02;
    comfort_level += 0.02;
    dependence += 0.01;
    lastEvent = '亲密互动';
    matched = true;
  }

  // 规则2：安慰/关心
  if (containsAny(userInput, CARING_KEYWORDS)) {
    trust += 0.04;
    closeness += 0.02;
    comfort_level += 0.03;
    lastEvent = '被关心安慰';
    matched = true;
  }

  // 规则3：冷淡/攻击
  if (containsAny(userInput, COLD_KEYWORDS)) {
    trust -= 0.04;
    closeness -= 0.03;
    comfort_level -= 0.03;
    lastEvent = '冷淡或攻击互动';
    matched = true;
  }

  // 规则4：第三者/他人优先
  if (containsAny(userInput, THIRD_PARTY_KEYWORDS)) {
    closeness -= 0.02;
    trust -= 0.02;
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
    close: '你们已经比较熟悉，互动自然放松，可以像日常恋人那样聊天。',
    attached: '你们关系更亲近，她会更主动、更自然，也更在意用户反应。',
    deep_attached: '你们已经有明显亲密感和信任感，她会更自然依赖，也更愿意表达真实情绪。',
    strained: '你们现在有点别扭，她会稍微收着一点，但不故意疏远。',
  };

  const phase = (state.phase as RelationshipPhase) || 'close';
  return phaseMap[phase] || phaseMap.close;
}
