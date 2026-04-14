/**
 * 记忆冲突检测与更新
 *
 * 当新事实与已有记忆冲突时（如地点变更、偏好反转），
 * 将旧记忆标记为 inactive（superseded），保留新记忆。
 */
import db from '../db';
import { cosineSimilarity } from '../utils/similarity';
import { memoryConfig } from '../utils/memoryConfig';

export type MemoryType = 'fact' | 'state' | 'preference' | 'plan' | 'relationship' | 'other';

// 不同类型的冲突检测阈值 —— state/plan 更容易被覆盖
const CONFLICT_THRESHOLDS: Record<MemoryType, number> = {
  fact: 0.78,
  state: 0.65,
  preference: 0.72,
  plan: 0.65,
  relationship: 0.75,
  other: 0.80,
};

// 冲突关键词模式：同一维度但内容不同的信息
const CONFLICT_DIMENSION_PATTERNS: Array<{
  dimension: string;
  patterns: RegExp[];
}> = [
  {
    dimension: 'location',
    patterns: [
      /用户(在|住在?|老家|家在|来自|所在地)/,
      /我(在|住在?|老家|家在|来自)/,
    ],
  },
  {
    dimension: 'work',
    patterns: [
      /用户(在.{1,15}(上班|工作|实习)|职业)/,
      /我(在.{1,15}(上班|工作|实习))/,
    ],
  },
  {
    dimension: 'school',
    patterns: [
      /用户(学校|大学|专业)/,
      /我(的?)(学校|大学|专业)/,
    ],
  },
  {
    dimension: 'like',
    patterns: [
      /用户(喜欢|最喜欢|爱|最爱)/,
      /我(喜欢|最喜欢|爱|最爱)/,
    ],
  },
  {
    dimension: 'dislike',
    patterns: [
      /用户(不喜欢|讨厌|最怕|受不了|不爱)/,
      /我(不喜欢|讨厌|最怕|受不了|不爱)/,
    ],
  },
  {
    dimension: 'mood',
    patterns: [
      /用户(最近|近期|这段时间|现在)(状态|情绪|心情|感觉)/,
      /我(最近|近期|这段时间|现在)/,
    ],
  },
  {
    dimension: 'plan',
    patterns: [
      /用户(计划|打算|准备|决定)/,
      /(计划|打算|准备|决定)/,
    ],
  },
];

interface ExistingMemory {
  id: number;
  text: string;
  normalized_fact_text: string | null;
  embedding: string;
  memory_type: string;
  importance: number;
}

interface ConflictResult {
  hasConflict: boolean;
  conflictingIds: number[];
  dimension: string | null;
}

/**
 * 检测新事实是否与已有记忆冲突
 */
export function detectMemoryConflict(
  characterId: number,
  newText: string,
  newNormalizedFact: string | null,
  newEmbedding: number[],
  newMemoryType: MemoryType,
): ConflictResult {
  if (!memoryConfig.enableConflictResolution) {
    return { hasConflict: false, conflictingIds: [], dimension: null };
  }

  const checkText = newNormalizedFact || newText;
  const threshold = CONFLICT_THRESHOLDS[newMemoryType] || 0.80;

  // 只检查同类型 + active 的记忆
  const rows = db.prepare(
    'SELECT id, text, normalized_fact_text, embedding, memory_type, importance FROM memories WHERE character_id = ? AND is_active = 1 AND memory_type = ?'
  ).all(characterId, newMemoryType) as ExistingMemory[];

  if (rows.length === 0) {
    return { hasConflict: false, conflictingIds: [], dimension: null };
  }

  // 1. 先用维度模式检测是否在同一个语义维度
  const newDimension = detectDimension(checkText);

  const conflictingIds: number[] = [];
  let matchedDimension: string | null = null;

  for (const row of rows) {
    const existingText = row.normalized_fact_text || row.text;
    const existingEmb = JSON.parse(row.embedding) as number[];
    const similarity = cosineSimilarity(newEmbedding, existingEmb);

    // 语义接近但不完全重复 → 可能是冲突
    if (similarity > threshold && similarity < memoryConfig.writeDedupThreshold) {
      // 同维度检测
      const existingDimension = detectDimension(existingText);
      if (newDimension && existingDimension && newDimension === existingDimension) {
        // 同维度 + 语义接近 = 冲突
        conflictingIds.push(row.id);
        matchedDimension = newDimension;
      }
    }

    // 对 state/plan 类型，放宽检测——高相似度直接视为更新
    if ((newMemoryType === 'state' || newMemoryType === 'plan') && similarity > 0.60 && similarity < memoryConfig.writeDedupThreshold) {
      const existingDimension = detectDimension(existingText);
      if (newDimension && existingDimension && newDimension === existingDimension && !conflictingIds.includes(row.id)) {
        conflictingIds.push(row.id);
        matchedDimension = newDimension;
      }
    }
  }

  return {
    hasConflict: conflictingIds.length > 0,
    conflictingIds,
    dimension: matchedDimension,
  };
}

/**
 * 解决冲突：将旧记忆标记为 inactive，并记录被谁替代
 */
export function resolveMemoryConflict(
  conflictingIds: number[],
  newMemoryId: number,
): void {
  if (conflictingIds.length === 0) return;

  const stmt = db.prepare(
    "UPDATE memories SET is_active = 0, superseded_by = ?, updated_at = datetime('now') WHERE id = ?"
  );

  for (const oldId of conflictingIds) {
    stmt.run(newMemoryId, oldId);
  }

  if (memoryConfig.debugRetrieval) {
    console.log(`[MemoryConflict] 新记忆 #${newMemoryId} 替代了旧记忆: [${conflictingIds.join(', ')}]`);
  }
}

/**
 * 检测文本所属的语义维度
 */
function detectDimension(text: string): string | null {
  for (const { dimension, patterns } of CONFLICT_DIMENSION_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        return dimension;
      }
    }
  }
  return null;
}
