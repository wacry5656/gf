/**
 * 记忆摘要服务
 *
 * 当 long-term memory 积累到一定数量时，自动生成/更新用户画像摘要，
 * 压缩碎片记忆为结构化的简短描述。
 */
import db from '../db';
import { callQwenAPI } from './qwen';
import { getMemoryCount, getAllMemoryTexts } from './memory';
import { memoryConfig } from '../utils/memoryConfig';

const SUMMARY_TRIGGER_COUNT = 15; // 记忆达到此数量触发 summary 生成
const SUMMARY_UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000; // 最短更新间隔：4小时

interface SummaryRow {
  id: number;
  character_id: number;
  content: string;
  updated_at: string;
}

/**
 * 获取当前 summary（如果有）
 */
export function getSummary(characterId: number): string | null {
  const row = db
    .prepare('SELECT content FROM memory_summaries WHERE character_id = ?')
    .get(characterId) as SummaryRow | undefined;
  return row?.content || null;
}

/**
 * 检查是否需要更新 summary，如果需要则异步触发
 * 不阻塞调用方
 */
export function maybeUpdateSummary(characterId: number): void {
  if (!memoryConfig.summaryEnabled) return;

  try {
    const count = getMemoryCount(characterId);
    if (count < SUMMARY_TRIGGER_COUNT) return;

    // 检查是否需要增量更新（记忆数增长超过阈值才触发）
    const row = db
      .prepare('SELECT updated_at, memory_count_at_update FROM memory_summaries WHERE character_id = ?')
      .get(characterId) as { updated_at: string; memory_count_at_update: number | null } | undefined;

    if (row) {
      const lastUpdate = new Date(row.updated_at).getTime();
      if (Date.now() - lastUpdate < SUMMARY_UPDATE_INTERVAL_MS) return;

      // 增量刷新检查：记忆数量需要增长超过 summaryRefreshCount
      const lastCount = row.memory_count_at_update || 0;
      if (count - lastCount < memoryConfig.summaryRefreshCount) return;
    }

    // 异步生成，不阻塞
    generateSummary(characterId).catch((err) => {
      console.error('Summary 生成失败:', err?.message);
    });
  } catch {
    // 静默
  }
}

/**
 * 调用 LLM 生成记忆摘要
 */
async function generateSummary(characterId: number): Promise<void> {
  const memories = getAllMemoryTexts(characterId);
  if (memories.length === 0) return;

  // 取最重要的 + 最近的记忆，最多 30 条
  const selected = memories.slice(0, 30);
  const memoryList = selected.map((m) => `- ${m.normalizedFactText || m.text}`).join('\n');

  const existingSummary = getSummary(characterId);
  const existingBlock = existingSummary
    ? `\n之前的摘要：\n${existingSummary}\n\n请在此基础上更新，保留仍然正确的信息，加入新内容。`
    : '';

  const prompt = `以下是用户在聊天中透露的一些个人信息和记忆片段：

${memoryList}
${existingBlock}
请将这些信息压缩成一段简短的用户画像摘要（100~200字以内），包含以下方面（如果有的话）：
1. 用户基本信息（名字、年龄、所在地、职业等）
2. 近期状态和情绪
3. 稳定偏好和习惯
4. 重要人际关系
5. 近期计划或关注的事

要求：
- 用简洁的陈述句，不要分点列举
- 只写确定的信息，不要猜测
- 不要写"用户表示""用户提到"这种前缀，直接写事实`;

  const messages = [
    { role: 'system' as const, content: '你是一个信息提取助手，只输出精简的摘要文本，不要输出其他内容。' },
    { role: 'user' as const, content: prompt },
  ];

  const summary = await callQwenAPI(messages);
  const trimmed = summary.trim();
  if (!trimmed || trimmed.length < 10) return;

  // upsert
  const existing = db
    .prepare('SELECT id FROM memory_summaries WHERE character_id = ?')
    .get(characterId) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      "UPDATE memory_summaries SET content = ?, memory_count_at_update = ?, updated_at = datetime('now') WHERE character_id = ?"
    ).run(trimmed, memories.length, characterId);
  } else {
    db.prepare(
      'INSERT INTO memory_summaries (character_id, content, memory_count_at_update) VALUES (?, ?, ?)'
    ).run(characterId, trimmed, memories.length);
  }
}
