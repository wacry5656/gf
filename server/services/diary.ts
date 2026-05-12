/**
 * AI 日记服务
 *
 * 每天根据聊天记录生成一段 AI 的第一人称日记。
 * 异步执行，不阻塞聊天主流程。
 */

import db from '../db';
import { callQwenAPI } from './qwen';
import { addLocalDays, formatLocalDate } from '../utils/dateTime';

interface ChatRow {
  role: string;
  content: string;
  created_at: string;
}

/**
 * 为指定角色生成某一天的日记（如果不存在）
 */
export async function generateDiaryForDate(
  characterId: number,
  dateStr: string // YYYY-MM-DD
): Promise<string | null> {
  // 检查是否已存在
  const existing = db
    .prepare('SELECT content FROM diary_entries WHERE character_id = ? AND entry_date = ?')
    .get(characterId, dateStr) as { content: string } | undefined;
  if (existing) return existing.content;

  // 获取当天的聊天记录
  const messages = db.prepare(
    `SELECT role, content, created_at FROM chat_messages
     WHERE character_id = ? AND date(created_at) = ?
     ORDER BY id ASC`
  ).all(characterId, dateStr) as ChatRow[];

  if (messages.length < 3) return null; // 聊天太少，不生成

  const dialogText = messages
    .map(m => `${m.role === 'user' ? '对方' : '我'}：${m.content}`)
    .join('\n');

  const prompt = `以下是我今天和对方的聊天记录：\n\n${dialogText}\n\n请帮我写一段日记（80~150字），用第一人称"我"来写。不要写成流水账，像真实的人在睡前回顾今天聊天的感受。可以写对方说了什么让我印象深刻的话、我的心情变化、或者一些悄悄话。语气自然、口语化。只输出日记正文，不要写日期和标题。`;

  try {
    const content = await callQwenAPI(
      [
        { role: 'system', content: '你是一个写日记的人，只输出日记正文，不加标题和日期。' },
        { role: 'user', content: prompt },
      ],
      300
    );

    const trimmed = content.trim();
    if (!trimmed || trimmed.length < 10) return null;

    db.prepare(
      'INSERT INTO diary_entries (character_id, entry_date, content) VALUES (?, ?, ?)'
    ).run(characterId, dateStr, trimmed);

    return trimmed;
  } catch (err: any) {
    console.error('[Diary] 生成日记失败:', err?.message);
    return null;
  }
}

/**
 * 获取某角色的日记列表（最近 30 天）
 */
export function getDiaryEntries(characterId: number, limit = 30): Array<{ entry_date: string; content: string }> {
  return db.prepare(
    `SELECT entry_date, content FROM diary_entries
     WHERE character_id = ?
     ORDER BY entry_date DESC
     LIMIT ?`
  ).all(characterId, limit) as Array<{ entry_date: string; content: string }>;
}

/**
 * 获取单条日记
 */
export function getDiaryForDate(characterId: number, dateStr: string): string | null {
  const row = db
    .prepare('SELECT content FROM diary_entries WHERE character_id = ? AND entry_date = ?')
    .get(characterId, dateStr) as { content: string } | undefined;
  return row?.content || null;
}

/**
 * 检查昨天是否有日记，没有则异步生成
 */
export function maybeGenerateYesterdayDiary(characterId: number): void {
  const yesterday = formatLocalDate(addLocalDays(new Date(), -1));
  const exists = db.prepare(
    'SELECT 1 FROM diary_entries WHERE character_id = ? AND entry_date = ?'
  ).get(characterId, yesterday);
  if (exists) return;

  generateDiaryForDate(characterId, yesterday).catch(() => {});
}
