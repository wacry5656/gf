/**
 * 计划完成检测与失效
 *
 * 检测用户新消息是否表达了某条 active plan 已完成/取消，
 * 如果是则将该 plan 提前标记为 inactive。
 */
import db from '../db';
import { cosineSimilarity } from '../utils/similarity';
import { getEmbedding } from './embedding';
import { memoryConfig } from '../utils/memoryConfig';

// 完成类表达
const COMPLETION_PATTERNS: RegExp[] = [
  /(已经|都).{0,6}(做完|弄完|搞完|处理完|完成|结束|考完|看完|去过|买完|交完|写完|办完|准备好|搞定|拿到|通过)/,
  /^.{0,10}(做完了|弄完了|搞完了|处理完了|完成了|结束了|考完了|看完了|去过了|买完了|交完了|写完了|办完了|搞定了|拿到了|通过了)/,
  /(已完成|已经完成|已结束|已经结束)/,
  /(刚|刚刚|刚才).{0,6}(做完|弄完|处理完|完成|结束|考完|看完|搞定)/,
];

// 取消类表达
const CANCELLATION_PATTERNS: RegExp[] = [
  /(不用了|不去了|不做了|不想了|取消了|算了|放弃了|不打算|不准备|改主意|变卦)/,
  /(没必要|懒得|不想去|不想做|不考虑)/,
];

interface ActivePlan {
  id: number;
  text: string;
  normalized_fact_text: string | null;
  embedding: string;
}

export interface PlanCompletionResult {
  detected: boolean;
  completedPlanIds: number[];
  reason: 'completed' | 'cancelled' | null;
}

/**
 * 检测新消息是否暗示某条 active plan 已完成或取消
 */
export async function detectPlanCompletion(
  characterId: number,
  newText: string,
): Promise<PlanCompletionResult> {
  const trimmed = newText.trim();

  // 先判断是否包含完成/取消表达
  let reason: 'completed' | 'cancelled' | null = null;
  for (const p of COMPLETION_PATTERNS) {
    if (p.test(trimmed)) { reason = 'completed'; break; }
  }
  if (!reason) {
    for (const p of CANCELLATION_PATTERNS) {
      if (p.test(trimmed)) { reason = 'cancelled'; break; }
    }
  }

  if (!reason) {
    return { detected: false, completedPlanIds: [], reason: null };
  }

  // 获取所有 active plan 记忆
  const plans = db.prepare(
    "SELECT id, text, normalized_fact_text, embedding FROM memories WHERE character_id = ? AND is_active = 1 AND memory_type = 'plan' AND (expires_at IS NULL OR expires_at > datetime('now'))"
  ).all(characterId) as ActivePlan[];

  if (plans.length === 0) {
    return { detected: false, completedPlanIds: [], reason: null };
  }

  // 用 embedding 语义匹配，找到与新消息最相关的 plan
  const newEmbedding = await getEmbedding(trimmed);
  const matchedIds: number[] = [];

  for (const plan of plans) {
    const planEmb = JSON.parse(plan.embedding) as number[];
    const sim = cosineSimilarity(newEmbedding, planEmb);
    // 完成语义 + 相关度 > 0.45 视为该 plan 已完成
    if (sim > 0.45) {
      matchedIds.push(plan.id);
    }
  }

  return {
    detected: matchedIds.length > 0,
    completedPlanIds: matchedIds,
    reason,
  };
}

/**
 * 将已完成/取消的 plan 标记为 inactive，并记录失效原因
 */
export function resolvePlanCompletion(
  completedPlanIds: number[],
  reason: 'completed' | 'cancelled',
): void {
  if (completedPlanIds.length === 0) return;

  const stmt = db.prepare(
    "UPDATE memories SET is_active = 0, invalidation_reason = ?, updated_at = datetime('now') WHERE id = ?"
  );

  for (const id of completedPlanIds) {
    stmt.run(reason, id);
  }

  if (memoryConfig.debugRetrieval) {
    console.log(`[PlanCompletion] Plan [${completedPlanIds.join(', ')}] 已失效，原因: ${reason}`);
  }
}
