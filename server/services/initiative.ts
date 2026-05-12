/**
 * AI 主动消息服务（Initiative Message Service）
 *
 * 当用户打开聊天窗口但暂时没有发消息时，AI 根据上下文主动发消息。
 * 控制频率防止过度打扰：
 *   - 用户至少 idle 2 分钟后才可能触发
 *   - 两次主动消息间隔至少 5 分钟
 *   - 每天最多 5 条
 *   - 每次打开聊天窗口最多 2 条
 */

import db from '../db';
import { callQwenAPI } from './qwen';
import { getEmotionState } from './emotion';
import { getRelationshipState } from './relationship';
import { buildSystemPrompt } from '../routes/chat';
import { memoryConfig } from '../utils/memoryConfig';
import { trimToTokenBudget, fitRecentMessagesToBudget } from '../utils/tokenBudget';
import { getSummary } from './summary';
import { getPersonalityTraits, getUserIdFromCharacter } from './personality';
import { searchMemory, getCoreMemories, recordMemoryHits } from './memory';
import { getTodayDueReminders, markReminderTriggered } from './reminder';
import type { MemoryResult } from './memory';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface Character {
  id?: number;
  name: string;
  gender: string;
  userGender?: string;
  relationshipMode?: 'lover' | 'friend';
  personality: string;
  description: string;
}

const CONFIG = {
  minIdleMinutes: 2,
  cooldownMinutes: 5,
  maxPerDay: 5,
  maxPerSession: 2,
  sleepStartHour: 0,
  sleepEndHour: 7,
};

function isSleepTime(): boolean {
  const hour = new Date().getHours();
  return hour >= CONFIG.sleepStartHour && hour < CONFIG.sleepEndHour;
}

function getScheduleDelay(): number {
  const hour = new Date().getHours();
  if (hour >= 0 && hour < 7) return 8000 + Math.floor(Math.random() * 12000);
  if (hour >= 7 && hour < 9) return 3000 + Math.floor(Math.random() * 4000);
  if (hour >= 23) return 5000 + Math.floor(Math.random() * 8000);
  return 1000 + Math.floor(Math.random() * 3000);
}

/**
 * 检查当前是否可以发送主动消息
 */
export function checkInitiativeEligibility(
  characterId: number,
  sessionInitiativeCount: number
): { eligible: boolean; reason?: string } {
  // 0. 作息时间：深夜不主动发消息
  if (isSleepTime()) {
    return { eligible: false, reason: '作息时间：深夜休息中' };
  }

  // 1. 每次会话最多 2 条
  if (sessionInitiativeCount >= CONFIG.maxPerSession) {
    return { eligible: false, reason: '本次会话已达主动消息上限' };
  }

  // 2. 今天最多 5 条
  const todayCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM initiative_log WHERE character_id = ? AND date(created_at) = date('now')"
  ).get(characterId) as { cnt: number };
  if (todayCount.cnt >= CONFIG.maxPerDay) {
    return { eligible: false, reason: '今日主动消息已达上限' };
  }

  // 3. 检查冷却时间（距离上次主动消息至少 5 分钟）
  const lastInitiative = db.prepare(
    'SELECT created_at FROM initiative_log WHERE character_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(characterId) as { created_at: string } | undefined;
  if (lastInitiative) {
    const minutesSince = (Date.now() - new Date(lastInitiative.created_at).getTime()) / 60000;
    if (minutesSince < CONFIG.cooldownMinutes) {
      return { eligible: false, reason: '主动消息冷却中' };
    }
  }

  // 4. 检查用户是否 idle 足够时间（按最后一条用户消息计算）
  const lastMessage = db.prepare(
    "SELECT created_at FROM chat_messages WHERE character_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1"
  ).get(characterId) as { created_at: string } | undefined;

  if (!lastMessage) {
    return { eligible: false, reason: '没有用户发言记录' };
  }

  const idleMinutes = (Date.now() - new Date(lastMessage.created_at).getTime()) / 60000;
  if (idleMinutes < CONFIG.minIdleMinutes) {
    return { eligible: false, reason: '用户活跃时间太近' };
  }

  return { eligible: true };
}

export function checkLongAbsence(characterId: number): { absent: boolean; daysSince: number } {
  const lastMsg = db.prepare(
    "SELECT created_at FROM chat_messages WHERE character_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1"
  ).get(characterId) as { created_at: string } | undefined;

  if (!lastMsg) return { absent: false, daysSince: 0 };

  const daysSince = (Date.now() - new Date(lastMsg.created_at).getTime()) / 86400000;
  return { absent: daysSince >= 3, daysSince };
}

export function shouldSendLongAbsenceGreeting(characterId: number): boolean {
  const lastUserMessage = db.prepare(
    "SELECT created_at FROM chat_messages WHERE character_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1"
  ).get(characterId) as { created_at: string } | undefined;

  if (!lastUserMessage) return false;

  const existingGreeting = db.prepare(
    "SELECT id FROM initiative_log WHERE character_id = ? AND trigger_reason = 'long_absence' AND created_at >= ? ORDER BY id DESC LIMIT 1"
  ).get(characterId, lastUserMessage.created_at) as { id: number } | undefined;

  return !existingGreeting;
}

function buildReminderAction(title: string): string {
  const stripped = title
    .replace(/大后天|后天|明天|今天|下周[一二三四五六日]|这个?周末|(\d{1,2})月(\d{1,2})[日号]/g, '')
    .replace(/[，。！？,.!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || title.trim();
}

export function triggerDueReminders(characterId: number): string[] {
  const dueReminders = getTodayDueReminders(characterId);
  if (dueReminders.length === 0) return [];

  const replies = dueReminders.map((reminder, index) => {
    const action = buildReminderAction(reminder.title);
    return index === 0
      ? `提醒你一下，今天别忘了${action}`
      : `还有，今天别忘了${action}`;
  });

  const persistAll = db.transaction(() => {
    for (const reply of replies) {
      db.prepare('INSERT INTO chat_messages (character_id, role, content) VALUES (?, ?, ?)')
        .run(characterId, 'assistant', reply);
    }
    db.prepare('INSERT INTO initiative_log (character_id, trigger_reason, content) VALUES (?, ?, ?)')
      .run(characterId, 'reminder_due', replies.join('\n'));
    for (const reminder of dueReminders) {
      markReminderTriggered(reminder.id);
    }
  });

  persistAll();
  return replies;
}

export async function generateLongAbsenceGreeting(
  character: Character,
  characterId: number,
  daysSince: number,
): Promise<string[]> {
  if (!shouldSendLongAbsenceGreeting(characterId)) return [];

  const userId = getUserIdFromCharacter(characterId);
  const emotionState = userId ? getEmotionState(userId, characterId) : null;

  const roleGender = character.gender === 'male' ? '男生' : character.gender === 'female' ? '女生' : '人';
  const userGender = character.userGender === 'female' ? '女生' : '男生';
  const relation = character.relationshipMode === 'friend' ? '朋友' : '恋人';
  const moodText = emotionState?.mood === 'warm' ? '还行' : emotionState?.mood === 'happy' ? '不错' : '一般';

  const systemPrompt = `你是${character.name}，${roleGender}，和对方（${userGender}）是${relation}关系。你在微信里给人发消息。对方已经${Math.round(daysSince)}天没跟你说话了，你想自然地打个招呼。心情${moodText}。要求：1~2条短消息，像真实的人好久没联系时发的那句。不要太煽情，不写动作旁白。`;

  try {
    const raw = await callQwenAPI(
      [{ role: 'system', content: systemPrompt }],
      150,
    );
    const cleaned = cleanInitiativeReply(raw, character.name);
    const replies = splitInitiativeReply(cleaned);
    if (replies.length === 0) return [];

    const insertAll = db.transaction(() => {
      for (const reply of replies) {
        db.prepare('INSERT INTO chat_messages (character_id, role, content) VALUES (?, ?, ?)')
          .run(characterId, 'assistant', reply);
      }
      db.prepare('INSERT INTO initiative_log (character_id, trigger_reason, content) VALUES (?, ?, ?)')
        .run(characterId, 'long_absence', replies.join('\n'));
    });
    insertAll();

    return replies;
  } catch {
    return [];
  }
}

const RANDOM_EVENT_SCENARIOS = [
  '今天加班好累，想吐槽一下',
  '刚看到一个超好笑的视频',
  '突然想起一件之前聊过的事',
  '今天吃了顿好吃的',
  '刚才出门遇到一只很可爱的猫',
  '刷到一个好玩的帖子',
  '今天天气突然变了',
  '刚听了一首好听的歌',
  '下班路上突然想找人说话',
];

export function shouldTriggerRandomEvent(characterId: number): boolean {
  if (isSleepTime()) return false;

  const lastMsg = db.prepare(
    "SELECT created_at FROM chat_messages WHERE character_id = ? ORDER BY id DESC LIMIT 1"
  ).get(characterId) as { created_at: string } | undefined;
  if (!lastMsg) return false;

  const idleMinutes = (Date.now() - new Date(lastMsg.created_at).getTime()) / 60000;
  if (idleMinutes < 5) return false;

  const todayRandom = db.prepare(
    "SELECT COUNT(*) as cnt FROM initiative_log WHERE character_id = ? AND trigger_reason = 'random_event' AND date(created_at) = date('now')"
  ).get(characterId) as { cnt: number };
  if (todayRandom.cnt >= 2) return false;

  return Math.random() < 0.15;
}

export async function generateRandomEvent(
  character: Character,
  characterId: number,
): Promise<string[]> {
  const userId = getUserIdFromCharacter(characterId);
  const emotionState = userId ? getEmotionState(userId, characterId) : null;

  const roleGender = character.gender === 'male' ? '男生' : character.gender === 'female' ? '女生' : '人';
  const userGender = character.userGender === 'female' ? '女生' : '男生';
  const relation = character.relationshipMode === 'friend' ? '朋友' : '恋人';

  const scenario = RANDOM_EVENT_SCENARIOS[Math.floor(Math.random() * RANDOM_EVENT_SCENARIOS.length)];

  const systemPrompt = `你是${character.name}，${roleGender}，和对方（${userGender}）是${relation}关系。你在微信里给人发消息。场景：${scenario}。要求：1~2条短消息，像真实的人随口分享日常。不写动作旁白，不过度热情。`;

  try {
    const raw = await callQwenAPI(
      [{ role: 'system', content: systemPrompt }],
      150,
    );
    const cleaned = cleanInitiativeReply(raw, character.name);
    const replies = splitInitiativeReply(cleaned);
    if (replies.length === 0) return [];

    const insertAll = db.transaction(() => {
      for (const reply of replies) {
        db.prepare('INSERT INTO chat_messages (character_id, role, content) VALUES (?, ?, ?)')
          .run(characterId, 'assistant', reply);
      }
      db.prepare('INSERT INTO initiative_log (character_id, trigger_reason, content) VALUES (?, ?, ?)')
        .run(characterId, 'random_event', replies.join('\n'));
    });
    insertAll();

    return replies;
  } catch {
    return [];
  }
}

/**
 * 生成主动消息
 */
export async function generateInitiativeMessage(
  character: Character,
  messages: ChatMessage[],
  characterId: number
): Promise<string[]> {
  const userId = getUserIdFromCharacter(characterId);

  // 构建上下文（复用 chat.ts 的逻辑，但 system prompt 不同）
  const recentMessages = fitRecentMessagesToBudget(
    messages.slice(-memoryConfig.recentMessageLimit),
    memoryConfig.recentTokenBudget,
    memoryConfig.singleMessageTokenBudget
  ) as ChatMessage[];

  // 获取情绪、关系、摘要、记忆
  const emotionState = userId ? getEmotionState(userId, characterId) : null;
  const relationshipState = userId ? getRelationshipState(userId, characterId) : null;
  const summary = getSummary(characterId);
  const personalityTraits = userId ? getPersonalityTraits(userId) : [];

  // 构建 personality summary
  let personalitySummary: string | undefined;
  if (personalityTraits.length > 0) {
    personalitySummary = personalityTraits.map(t => `- ${t.value}`).join('\n');
  }

  // 检索记忆
  let memoryBlock = '';
  let usedMemoryIds: number[] = [];
  const queryText = recentMessages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
  if (queryText && characterId) {
    try {
      const memories = await searchMemory(characterId, queryText);
      const coreMemories = getCoreMemories(characterId);
      const seenTexts = new Set<string>();
      const memoryTexts: string[] = [];
      let usedChars = 0;
      const maxContextChars = memoryConfig.maxContextChars;
      let usedMemoryTokens = 0;

      const pushMemory = (m: MemoryResult) => {
        if (seenTexts.has(m.text)) return;
        seenTexts.add(m.text);
        const lineTokens = JSON.stringify(m.text).length / 4;
        if (usedChars + m.text.length + 2 > maxContextChars) return;
        if (usedMemoryTokens + lineTokens > memoryConfig.memoryTokenBudget) return;
        memoryTexts.push(m.text);
        usedMemoryIds.push(m.id);
        usedChars += m.text.length + 1;
        usedMemoryTokens += lineTokens;
      };

      for (const m of coreMemories) pushMemory(m);
      for (const m of memories) pushMemory(m);

      if (memoryTexts.length > 0) {
        const joined = memoryTexts.join('；');
        memoryBlock = `你记得对方${joined}。自然提到就好，别主动翻旧账。\n`;
      }
    } catch {
      // 忽略记忆检索失败
    }
  }

  // 构建主动消息专用的 system prompt
  const systemPrompt = buildInitiativeSystemPrompt({
    character,
    emotionState,
    relationshipState,
    personalitySummary,
    summary,
    memoryBlock,
  });

  const fullMessages = [{ role: 'system' as const, content: systemPrompt }, ...recentMessages];

  // 调用 LLM
  const rawReply = await callQwenAPI(fullMessages, 120);

  // 清洗回复
  const cleaned = cleanInitiativeReply(rawReply, character.name);
  const replies = splitInitiativeReply(cleaned);

  if (replies.length === 0) {
    return [];
  }

  const insertAll = db.transaction(() => {
    for (const reply of replies) {
      db.prepare('INSERT INTO chat_messages (character_id, role, content) VALUES (?, ?, ?)')
        .run(characterId, 'assistant', reply);
    }
    db.prepare('INSERT INTO initiative_log (character_id, trigger_reason, content) VALUES (?, ?, ?)')
      .run(characterId, 'user_idle', replies.join('\n'));
  });
  insertAll();

  // 记录记忆命中
  if (usedMemoryIds.length > 0) {
    recordMemoryHits(usedMemoryIds);
  }

  return replies;
}

interface InitiativeSystemPromptParams {
  character: Character;
  emotionState: any;
  relationshipState: any;
  personalitySummary?: string;
  summary: string | null;
  memoryBlock: string;
}

function buildInitiativeSystemPrompt(params: InitiativeSystemPromptParams): string {
  const { character, emotionState, relationshipState, personalitySummary, summary, memoryBlock } = params;

  const roleGender = character.gender === 'male' ? '男生' : character.gender === 'female' ? '女生' : '人';
  const userGender = character.userGender === 'female' ? '女生' : '男生';
  const relation = character.relationshipMode === 'friend' ? '朋友' : '恋人';

  const emotionText = emotionState
    ? `你现在心情${emotionState.mood === 'warm' ? '还行' : emotionState.mood === 'happy' ? '不错' : emotionState.mood === 'upset' ? '有点烦' : emotionState.mood === 'jealous' ? '有点吃醋' : emotionState.mood === 'sulking' ? '在生闷气' : '一般'}。`
    : '';

  const relationshipText = relationshipState
    ? `你们关系${relationshipState.phase === 'deep_attached' ? '很深' : relationshipState.phase === 'strained' ? '最近有点别扭' : '还行'}。`
    : '';

  const parts: string[] = [
    `你是${character.name}，${roleGender}，和对方（${userGender}）是${relation}关系。你在微信里给人发消息。`,
    '',
    '注意：对方刚才发了一条消息，但几分钟没有继续回复了。你想找对方说句话。',
    '要求：',
    '- 自然地延续刚才的话题，或者根据上下文分享一个想法',
    '- 不要问"在吗"，不要只发一个表情',
    '- 像真实的人在等回复时忍不住又发了一条',
    '- 最多1到2条短消息，每条不超过28字',
    '- 只能发文字，不能写动作描写、旁白、心理描写',
    '- 不要自言自语，不要写小说',
    '',
    `${emotionText} ${relationshipText}`,
  ];

  if (personalitySummary) {
    parts.push(`你了解对方：${personalitySummary}`);
  }

  if (summary) {
    parts.push(`你对对方的整体印象：${trimToTokenBudget(summary, 200)}`);
  }

  if (memoryBlock) {
    parts.push(memoryBlock);
  }

  return parts.join('\n').trim();
}

function cleanInitiativeReply(text: string, characterName: string): string {
  let cleaned = text || '';

  // 去掉括号内容
  cleaned = cleaned.replace(/[（(][^）)]*[）)]/g, '');
  cleaned = cleaned.replace(/\*[^*]*\*/g, '');
  cleaned = cleaned.replace(/【[^】]*】/g, '');

  // 去掉角色名前缀
  cleaned = cleaned.replace(new RegExp(`^${characterName}[：:]\\s*`, 'gm'), '');
  cleaned = cleaned.replace(/^.{1,6}[：:]\s*/gm, '');

  // 去掉动作/旁白
  cleaned = cleaned.replace(/[，,]?\s*(笑了笑|微微一笑|轻声说|看着你|叹了口气|点了点头|摇了摇头|眨了眨眼|歪了歪头|抿了抿嘴|挠了挠头|低下头|抬起头|抬眼|垂眼|走过来|坐在|靠在|拉着你|拍了拍|揉了揉|抱住|牵着|摸了摸|沉默了一下|没说话)\s*/g, '');

  // 去掉第三人称心理
  cleaned = cleaned.replace(/(她|他|我)(心想|觉得|暗想|默默地|静静地|轻轻地)/g, '');

  // 清理空行
  cleaned = cleaned.replace(/\n\s*\n/g, '\n').trim();

  return cleaned;
}

function splitInitiativeReply(text: string): string[] {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length >= 2) return lines.slice(0, 2);

  const single = lines[0] || text.trim();
  if (!single) return [];
  if (single.length <= 28) return [single];

  // 尝试拆分
  const parts = single.match(/[^。！？~～!?]+[。！？~～!?]?/g);
  if (parts && parts.length >= 2) {
    const merged: string[] = [];
    let buffer = '';
    for (const part of parts) {
      buffer += part;
      if (buffer.length >= 5) {
        merged.push(buffer.trim());
        buffer = '';
      }
    }
    if (buffer.trim()) {
      if (merged.length > 0) merged[merged.length - 1] += buffer.trim();
      else merged.push(buffer.trim());
    }
    if (merged.length >= 1) return merged.slice(0, 2);
  }

  return [single.slice(0, 28)];
}
