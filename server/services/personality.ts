/**
 * 人格记忆服务（Personality Memory）
 *
 * 通过分析用户对话，提取长期人格特征（性格、偏好、兴趣、关系态度），
 * 存入 personality_memory 表，在 prompt 构建时注入，提升人格连续性。
 *
 * 设计原则：
 *   - 增强型：不修改/削弱已有 memory / summary / 向量检索
 *   - 异步执行：不阻塞聊天主流程
 *   - 增量更新：不覆盖全部人格，confidence 取 max(旧, 新)
 */
import db from '../db';
import { callQwenAPI } from './qwen';
import { memoryConfig } from '../utils/memoryConfig';

// ========== 类型定义 ==========

export interface PersonalityTrait {
  key: string;
  value: string;
  confidence: number;
}

interface PersonalityRow {
  id: number;
  user_id: number;
  key: string;
  value: string;
  confidence: number;
  updated_at: string;
}

// ========== 节流控制 ==========

/** 记录每个 characterId 的上次提取时间 */
const lastExtractTime = new Map<number, number>();

// ========== 公开 API ==========

/**
 * 通过 characterId 获取对应的 userId
 */
export function getUserIdFromCharacter(characterId: number): number | null {
  const row = db
    .prepare('SELECT user_id FROM characters WHERE id = ?')
    .get(characterId) as { user_id: number } | undefined;
  return row?.user_id ?? null;
}

/**
 * 获取用户的人格特征列表（用于 prompt 构建）
 *
 * 按 confidence 降序，取前 N 条
 */
export function getPersonalityTraits(userId: number): PersonalityTrait[] {
  const limit = memoryConfig.personalityTopK;
  const rows = db
    .prepare(
      'SELECT key, value, confidence FROM personality_memory WHERE user_id = ? ORDER BY confidence DESC LIMIT ?'
    )
    .all(userId, limit) as PersonalityRow[];

  return rows.map((r) => ({
    key: r.key,
    value: r.value,
    confidence: r.confidence,
  }));
}

/**
 * 异步提取人格特征（节流控制，不阻塞主流程）
 *
 * 调用方应在 chat 响应后 fire-and-forget：
 *   maybeExtractPersonality(characterId).catch(() => {})
 */
export async function maybeExtractPersonality(characterId: number): Promise<void> {
  if (!memoryConfig.personalityEnabled) return;

  // 节流：距上次提取不足 interval 则跳过
  const now = Date.now();
  const lastTime = lastExtractTime.get(characterId) || 0;
  if (now - lastTime < memoryConfig.personalityExtractIntervalMs) return;

  // 检查是否有足够的新消息
  const msgThreshold = memoryConfig.personalityExtractMessageThreshold;
  const msgCount = (
    db
      .prepare('SELECT COUNT(*) as cnt FROM chat_messages WHERE character_id = ?')
      .get(characterId) as { cnt: number }
  ).cnt;

  if (msgCount < msgThreshold) return;

  // 标记提取时间（即使失败也标记，避免反复重试）
  lastExtractTime.set(characterId, now);

  await extractPersonality(characterId);
}

// ========== 内部实现 ==========

/**
 * 从最近 N 条对话中提取人格特征并写入 personality_memory
 */
async function extractPersonality(characterId: number): Promise<void> {
  const userId = getUserIdFromCharacter(characterId);
  if (!userId) return;

  // 取最近 N 条对话
  const recentMessages = db
    .prepare(
      'SELECT role, content FROM chat_messages WHERE character_id = ? ORDER BY id DESC LIMIT ?'
    )
    .all(characterId, memoryConfig.personalityExtractMessageThreshold) as Array<{
    role: string;
    content: string;
  }>;

  if (recentMessages.length < 4) return; // 对话太少，不提取

  // 倒序恢复时间顺序
  recentMessages.reverse();

  const dialogText = recentMessages
    .map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${m.content}`)
    .join('\n');

  // 获取已有的人格记忆，作为上下文供 LLM 参考
  const existingTraits = getPersonalityTraits(userId);
  const existingBlock =
    existingTraits.length > 0
      ? `\n已有的用户特征（请在此基础上更新或补充，不要重复已有内容）：\n${existingTraits.map((t) => `- [${t.key}] ${t.value} (confidence: ${t.confidence})`).join('\n')}\n`
      : '';

  const prompt = `分析以下对话中"用户"的性格特征、偏好、兴趣和对AI的关系态度。
${existingBlock}
对话记录：
${dialogText}

请输出 JSON 数组（最多5条），每个元素包含：
- key：必须是以下之一：personality_trait / preference / interest / relationship_style
- value：简短描述（10~30字）
- confidence：0~1 的置信度，越确定越高

要求：
- 只提取能从对话中明确推断的特征
- 不要猜测，不确定的给低 confidence
- 只输出 JSON 数组，不要输出其他文字
- 如果没有可提取的特征，输出空数组 []

示例输出：
[{"key":"preference","value":"喜欢讨论技术和AI话题","confidence":0.8},{"key":"personality_trait","value":"表达直接，逻辑性强","confidence":0.7}]`;

  const messages = [
    {
      role: 'system' as const,
      content: '你是一个心理分析助手，只输出 JSON 格式的分析结果，不要输出其他内容。',
    },
    { role: 'user' as const, content: prompt },
  ];

  try {
    const raw = await callQwenAPI(messages, 500);
    const traits = parsePersonalityResponse(raw);
    if (traits.length === 0) return;

    upsertPersonalityTraits(userId, traits);

    if (memoryConfig.debugRetrieval) {
      console.log(
        `[Personality] 为 user_id=${userId} 提取了 ${traits.length} 条人格特征:`,
        traits.map((t) => `${t.key}=${t.value}(${t.confidence})`)
      );
    }
  } catch (err: any) {
    console.error('[Personality] 人格提取失败:', err?.message);
  }
}

/**
 * 解析 LLM 返回的人格特征 JSON
 */
function parsePersonalityResponse(raw: string): PersonalityTrait[] {
  try {
    // 尝试从回复中提取 JSON 数组
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    const validKeys = new Set([
      'personality_trait',
      'preference',
      'interest',
      'relationship_style',
    ]);

    return parsed
      .filter(
        (item: any) =>
          item &&
          typeof item.key === 'string' &&
          typeof item.value === 'string' &&
          validKeys.has(item.key) &&
          item.value.length >= 2 &&
          item.value.length <= 100
      )
      .map((item: any) => ({
        key: item.key,
        value: item.value,
        confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0.5)),
      }))
      .slice(0, 5); // 最多 5 条
  } catch {
    return [];
  }
}

/**
 * 增量写入人格特征
 *
 * 规则：
 *   - 如果 key+value 已存在：confidence 取 max(旧, 新)，更新时间
 *   - 如果 key 已存在但 value 不同：插入新记录（同一 key 可有多条）
 *   - 如果 key 不存在：插入新记录
 *
 * 每个 key 最多保留 3 条（按 confidence 降序，淘汰最低的）
 */
function upsertPersonalityTraits(
  userId: number,
  traits: PersonalityTrait[]
): void {
  const maxPerKey = 3;

  for (const trait of traits) {
    // 查找是否已有相同 key+value 的记录
    const existing = db
      .prepare(
        'SELECT id, confidence FROM personality_memory WHERE user_id = ? AND key = ? AND value = ?'
      )
      .get(userId, trait.key, trait.value) as
      | { id: number; confidence: number }
      | undefined;

    if (existing) {
      // 已存在：更新 confidence = max(旧, 新)
      const newConfidence = Math.max(existing.confidence, trait.confidence);
      db.prepare(
        "UPDATE personality_memory SET confidence = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(newConfidence, existing.id);
    } else {
      // 不存在：插入
      db.prepare(
        'INSERT INTO personality_memory (user_id, key, value, confidence) VALUES (?, ?, ?, ?)'
      ).run(userId, trait.key, trait.value, trait.confidence);

      // 检查该 key 是否超过上限，淘汰低 confidence 的
      const countRow = db
        .prepare(
          'SELECT COUNT(*) as cnt FROM personality_memory WHERE user_id = ? AND key = ?'
        )
        .get(userId, trait.key) as { cnt: number };

      if (countRow.cnt > maxPerKey) {
        // 删除 confidence 最低的多余记录
        const toDelete = db
          .prepare(
            'SELECT id FROM personality_memory WHERE user_id = ? AND key = ? ORDER BY confidence ASC LIMIT ?'
          )
          .all(userId, trait.key, countRow.cnt - maxPerKey) as Array<{
          id: number;
        }>;

        for (const row of toDelete) {
          db.prepare('DELETE FROM personality_memory WHERE id = ?').run(row.id);
        }
      }
    }
  }
}
