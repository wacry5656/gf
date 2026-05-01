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
import { auditInteraction } from './interactionAudit';

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

// ========== 默认状态 ==========

const DEFAULT_RELATIONSHIP = {
  closeness: 0.68,
  trust: 0.58,
  dependence: 0.48,
  comfortLevel: 0.68,
  phase: 'attached' as RelationshipPhase,
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
  const value = Number(process.env.RELATIONSHIP_STATE_SENSITIVITY || 1.65);
  return Number.isFinite(value) && value > 0 ? value : 1.65;
}

function delta(value: number, text: string): number {
  const lengthBoost = text.trim().length >= 20 ? 1.15 : 1;
  return value * sensitivity() * lengthBoost;
}

function positiveChangeFactor(currentValue: number, lastEvent: string | null, updatedAt: string, nextEvent: string | null): number {
  const headroom = 0.35 + 0.65 * (1 - clamp(currentValue));
  if (!lastEvent || !nextEvent || lastEvent !== nextEvent) return headroom;
  const updated = Date.parse(`${updatedAt.replace(' ', 'T')}Z`);
  if (!Number.isFinite(updated)) return headroom;
  const minutes = (Date.now() - updated) / 60000;
  if (minutes < 30) return headroom * 0.3;
  if (minutes < 360) return headroom * 0.6;
  return headroom;
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
  const relationshipMode = getCharacterRelationshipMode(characterId);
  const defaults = relationshipMode === 'friend'
    ? { closeness: 0.42, trust: 0.52, dependence: 0.18, comfortLevel: 0.56, phase: 'close' as RelationshipPhase }
    : DEFAULT_RELATIONSHIP;

  db.prepare(
    `INSERT OR IGNORE INTO relationship_state
       (user_id, character_id, closeness, trust, dependence, comfort_level, phase)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId,
    characterId,
    defaults.closeness,
    defaults.trust,
    defaults.dependence,
    defaults.comfortLevel,
    defaults.phase
  );

  db.prepare(
    `UPDATE relationship_state
     SET closeness = ?, trust = ?, dependence = ?, comfort_level = ?, phase = ?, updated_at = datetime('now')
     WHERE user_id = ? AND character_id = ?
       AND closeness = 0.5 AND trust = 0.5 AND dependence = 0.3 AND comfort_level = 0.5
       AND phase = 'close' AND last_event IS NULL`
  ).run(
    defaults.closeness,
    defaults.trust,
    defaults.dependence,
    defaults.comfortLevel,
    defaults.phase,
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
  const relationshipMode = getCharacterRelationshipMode(characterId);

  let { closeness, trust, dependence, comfort_level } = state;
  let lastEvent: string | null = state.last_event;
  const audit = auditInteraction(userInput, relationshipMode);
  const partnerConflict = audit.partnerConflict;

  // 规则1：亲密表达/索取确认只记录事件，不直接涨分，避免关键词刷好感。
  if (relationshipMode === 'lover' && !partnerConflict && (audit.intimateExpression || audit.reassuranceSeeking)) {
    lastEvent = audit.primaryEvent || '亲密互动';
  }

  // 规则2：通过审核的真实关心/修复/承诺才小幅增长。
  if (audit.canIncreaseBond) {
    const scoreBoost = Math.min(1.5, audit.positiveScore) / 1.5;
    const changeFactor = positiveChangeFactor(closeness, state.last_event, state.updated_at, audit.primaryEvent);
    trust += delta(0.025 + 0.025 * scoreBoost, userInput) * changeFactor;
    closeness += delta(0.014 + 0.018 * scoreBoost, userInput) * changeFactor;
    comfort_level += delta(0.024 + 0.024 * scoreBoost, userInput) * changeFactor;
    dependence += delta(0.008 + 0.012 * scoreBoost, userInput) * changeFactor;
    lastEvent = audit.primaryEvent || '正向互动';
  }

  // 规则3：冷淡/攻击
  if (audit.cold || audit.attack) {
    trust -= delta(audit.attack ? 0.09 : 0.06, userInput);
    closeness -= delta(audit.attack ? 0.075 : 0.045, userInput);
    comfort_level -= delta(audit.attack ? 0.085 : 0.055, userInput);
    dependence -= delta(audit.attack ? 0.035 : 0.02, userInput);
    lastEvent = audit.primaryEvent || '冷淡或攻击互动';
  }

  // 规则4：第三者/他人优先
  if (relationshipMode === 'lover' && audit.thirdParty) {
    closeness -= delta(partnerConflict ? 0.18 : 0.055, userInput);
    trust -= delta(partnerConflict ? 0.16 : 0.055, userInput);
    comfort_level -= delta(partnerConflict ? 0.12 : 0.04, userInput);
    dependence -= delta(partnerConflict ? 0.08 : 0.02, userInput);
    lastEvent = audit.primaryEvent || (partnerConflict ? '关系冲突' : '第三者话题');
  }

  // 规则5：中性聊天 — 不改变关系状态（不再自动升温）
  // 只有明确正向互动（亲密、关心）才提升关系
  if (relationshipMode === 'friend') {
    dependence = Math.min(dependence, 0.35);
  }

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
  const relationshipMode = getCharacterRelationshipMode(state.character_id);
  if (relationshipMode === 'friend') {
    return '你们是熟悉的普通聊天对象，只按日常朋友/熟人聊天，不制造恋爱、暧昧或吃醋。';
  }

  const phaseMap: Record<RelationshipPhase, string> = {
    close: '你们是恋人，但聊天方式是日常短消息，不写暧昧剧情。',
    attached: '你们是稳定恋人关系，可以更主动一点，但仍然像真实聊天。',
    deep_attached: '你们关系很亲近，可以表达在意，但不要变成乙游台词或占有欲表演。',
    strained: '你们仍是恋人，只是现在有点别扭，短句表达情绪，不冷暴力。',
  };

  const phase = (state.phase as RelationshipPhase) || 'close';
  return phaseMap[phase] || phaseMap.close;
}
