/**
 * 提醒/日程服务
 *
 * 从用户消息中提取日期事件，到期时触发主动提醒。
 */

import db from '../db';

interface ReminderRow {
  id: number;
  title: string;
  remind_at: string;
  description: string | null;
}

interface DayPattern { pattern: RegExp; days: number }
interface HandlerPattern { pattern: RegExp; handler: string }

// 日期提取正则
const RELATIVE_DAY_PATTERNS: DayPattern[] = [
  { pattern: /明天/g, days: 1 },
  { pattern: /后天/g, days: 2 },
  { pattern: /大后天/g, days: 3 },
];

const DATE_PATTERNS: (DayPattern | HandlerPattern)[] = [
  ...RELATIVE_DAY_PATTERNS,
  { pattern: /下周[一二三四五六日]/g, handler: 'next_week' },
  { pattern: /(\d{1,2})月(\d{1,2})[日号]/g, handler: 'absolute_date' },
  { pattern: /这个?周末/g, handler: 'this_weekend' },
];

/**
 * 从用户消息中提取可能的日期事件
 */
export function extractDateEvent(text: string): { title: string; remindAt: string } | null {
  const trimmed = text.trim();
  if (trimmed.length < 5) return null;

  // 匹配 "明天/后天/大后天 + 事件"
  for (const item of RELATIVE_DAY_PATTERNS) {
    if (item.pattern.test(trimmed)) {
      const eventText = trimmed.replace(/[，。！？,.!?]/g, '').trim();
      const remindAt = getFutureDate(item.days);
      return { title: eventText, remindAt };
    }
  }

  // 匹配 "X月X日 + 事件"
  const absMatch = trimmed.match(/(\d{1,2})月(\d{1,2})[日号]/);
  if (absMatch) {
    const month = Number(absMatch[1]);
    const day = Number(absMatch[2]);
    const now = new Date();
    let year = now.getFullYear();
    const remindDate = new Date(year, month - 1, day);
    if (remindDate < now) {
      remindDate.setFullYear(year + 1);
    }
    const eventText = trimmed.replace(/[，。！？,.!?]/g, '').trim();
    return { title: eventText, remindAt: remindDate.toISOString().slice(0, 10) };
  }

  return null;
}

function getFutureDate(days: number): string {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

/**
 * 添加提醒
 */
export function addReminder(
  characterId: number,
  title: string,
  remindAt: string,
  description?: string
): void {
  db.prepare(
    'INSERT INTO reminders (character_id, title, remind_at, description) VALUES (?, ?, ?, ?)'
  ).run(characterId, title, remindAt, description || null);
}

/**
 * 获取某角色的所有未触发提醒
 */
export function getPendingReminders(characterId: number): ReminderRow[] {
  return db.prepare(
    `SELECT id, title, remind_at, description FROM reminders
     WHERE character_id = ? AND is_triggered = 0
     ORDER BY remind_at ASC`
  ).all(characterId) as ReminderRow[];
}

/**
 * 检查今天到期的提醒
 */
export function getTodayDueReminders(characterId: number): ReminderRow[] {
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare(
    `SELECT id, title, remind_at, description FROM reminders
     WHERE character_id = ? AND is_triggered = 0 AND date(remind_at) <= ?
     ORDER BY remind_at ASC`
  ).all(characterId, today) as ReminderRow[];
}

/**
 * 标记提醒为已触发
 */
export function markReminderTriggered(reminderId: number): void {
  db.prepare(
    "UPDATE reminders SET is_triggered = 1 WHERE id = ?"
  ).run(reminderId);
}

/**
 * 删除提醒
 */
export function deleteReminder(reminderId: number): void {
  db.prepare('DELETE FROM reminders WHERE id = ?').run(reminderId);
}
