export interface Character {
  id?: number;
  name: string;
  gender: 'male' | 'female' | 'other';
  personality: string;
  description: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface User {
  userId: number;
  username: string;
}

interface AuthResponsePayload {
  userId?: number;
  username?: string;
  error?: string;
}

function parseJsonText(text: string): unknown {
  if (!text || text.trim() === '') return null;
  // Callers intentionally handle invalid JSON so they can fall back to
  // proxy-safe error messages or partial stream recovery behavior.
  return JSON.parse(text);
}

/**
 * Handles proxy / gateway failures that may return HTML or empty bodies
 * instead of the JSON payloads produced by the application server.
 */
function getResponseErrorMessageFromText(text: string, fallback: string): string {
  try {
    const data = parseJsonText(text) as AuthResponsePayload | null;
    if (data?.error) return data.error;
  } catch {
    // Ignore non-JSON error bodies such as HTML error pages from proxies.
  }
  return fallback;
}

// ====== 认证 ======

export async function register(username: string, password: string): Promise<User> {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const raw = await res.text();
  let data: AuthResponsePayload | null = null;
  try {
    data = parseJsonText(raw) as AuthResponsePayload | null;
  } catch {
    throw new Error(getResponseErrorMessageFromText(raw, '注册失败，请稍后重试'));
  }
  if (!res.ok) throw new Error(data?.error || '注册失败');
  if (!data?.userId || !data?.username) {
    throw new Error('注册失败，请稍后重试');
  }
  return { userId: data.userId, username: data.username };
}

export async function login(username: string, password: string): Promise<User> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const raw = await res.text();
  let data: AuthResponsePayload | null = null;
  try {
    data = parseJsonText(raw) as AuthResponsePayload | null;
  } catch {
    throw new Error(getResponseErrorMessageFromText(raw, '登录失败，请稍后重试'));
  }
  if (!res.ok) throw new Error(data?.error || '登录失败');
  if (!data?.userId || !data?.username) {
    throw new Error('登录失败，请稍后重试');
  }
  return { userId: data.userId, username: data.username };
}

// ====== 聊天 ======

export async function sendMessage(
  character: Character,
  messages: ChatMessage[],
  userId: number
): Promise<string[]> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character, messages, characterId: character.id, userId }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  const data = await res.json();
  return data.replies || [data.reply];
}

// ====== 角色数据 ======

export async function getCharacters(userId: number): Promise<Character[]> {
  const res = await fetch(`/api/data/characters?userId=${userId}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '获取角色失败');
  return data.characters;
}

export async function createCharacter(userId: number, char: Character): Promise<number> {
  const res = await fetch('/api/data/characters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, ...char }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '创建角色失败');
  return data.characterId;
}

export async function deleteCharacter(characterId: number, userId: number): Promise<void> {
  const res = await fetch(`/api/data/characters/${characterId}?userId=${userId}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || '删除角色失败');
  }
}

// ====== 聊天记录 ======

export async function getMessages(characterId: number, userId: number): Promise<ChatMessage[]> {
  const res = await fetch(`/api/data/messages/${characterId}?userId=${userId}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '获取消息失败');
  return data.messages;
}

export async function saveMessage(characterId: number, role: string, content: string, userId: number): Promise<void> {
  const res = await fetch('/api/data/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterId, role, content, userId }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || '保存消息失败');
  }
}

export async function clearMessages(characterId: number, userId: number): Promise<void> {
  const res = await fetch(`/api/data/messages/${characterId}?userId=${userId}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || '清空消息失败');
  }
}

// ====== 情绪状态 ======

export interface EmotionInfo {
  mood: string;
  moodLabel: string;
  affection: number;
  trust_score: number;
  jealousy_score: number;
}

export async function getEmotion(characterId: number, userId: number): Promise<EmotionInfo | null> {
  try {
    const res = await fetch(`/api/data/emotion/${characterId}?userId=${userId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ====== 关系状态 ======

export interface RelationshipInfo {
  phase: string;
  phaseLabel: string;
  closeness: number;
  trust: number;
}

export async function getRelationship(characterId: number, userId: number): Promise<RelationshipInfo | null> {
  try {
    const res = await fetch(`/api/data/relationship/${characterId}?userId=${userId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ====== 流式聊天 ======

export async function sendMessageStream(
  character: Character,
  messages: ChatMessage[],
  onDelta: (content: string) => void,
  userId: number,
  onReady?: () => void
): Promise<string[]> {
  const url = '/api/chat/stream';
  console.log(`[sendMessageStream] 开始请求: url=${url}, characterId=${character.id}, userId=${userId}`);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ character, messages, characterId: character.id, userId }),
    });
  } catch (networkErr: any) {
    console.error(`[sendMessageStream] 网络错误: url=${url}, characterId=${character.id}, userId=${userId}`, networkErr);
    throw new Error(`网络连接失败，请检查网络后重试 (${networkErr?.message || '未知错误'})`);
  }

  if (!res.ok) {
    const errorMsg = getResponseErrorMessageFromText(await res.text(), `请求失败 (${res.status})`);
    console.error(`[sendMessageStream] 服务端返回错误: status=${res.status}, error=${errorMsg}`);
    throw new Error(errorMsg);
  }

  if (!res.body) {
    throw new Error('响应体为空');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let replies: string[] = [];
  let buffer = '';
  let receivedReady = false;
  let receivedFirstDelta = false;
  let receivedDone = false;
  let streamReadError: unknown = null;

  // Parse one SSE event block (blank-line delimited) so ready/delta/done
  // messages still work even when proxies coalesce or split TCP chunks.
  const processEvent = (eventBlock: string) => {
    const normalized = eventBlock.replace(/\r/g, '');
    if (!normalized.trim()) return;

    const lines = normalized.split('\n');
    let eventName = '';
    const dataLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith(':')) continue;

      if (trimmed.startsWith('event:')) {
        eventName = trimmed.slice(6).trim();
        continue;
      }

      if (trimmed.startsWith('data:')) {
        dataLines.push(trimmed.slice(5).trimStart());
      }
    }

    if (eventName === 'ready') {
      receivedReady = true;
      console.log(`[sendMessageStream] 收到 ready 事件`);
      if (onReady) onReady();
    }

    const data = dataLines.join('\n').trim();
    if (!data) return;

    if (data === '[DONE]') {
      receivedDone = true;
      console.log(`[sendMessageStream] 收到 done, characterId=${character.id}`);
      return;
    }

    try {
      const parsed = JSON.parse(data);

      if (parsed.ok === true || parsed.type === 'ready' || parsed.type === 'ping') {
        if (parsed.ok === true && !receivedReady) {
          receivedReady = true;
          console.log(`[sendMessageStream] 收到 ready (via data)`);
          if (onReady) onReady();
        }
        return;
      }

      if (parsed.delta) {
        if (!receivedFirstDelta) {
          receivedFirstDelta = true;
          console.log(`[sendMessageStream] 收到第一个 delta, characterId=${character.id}`);
        }
        onDelta(parsed.delta);
      }
      if (parsed.replies) replies = parsed.replies;
      if (parsed.error) throw new Error(parsed.error);
    } catch (e: any) {
      if (e instanceof SyntaxError) return;
      throw e;
    }
  };

  const flushBufferedEvents = () => {
    const normalized = buffer.replace(/\r\n/g, '\n');
    const eventBlocks = normalized.split('\n\n');
    buffer = eventBlocks.pop() || '';
    for (const eventBlock of eventBlocks) {
      processEvent(eventBlock);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // Final flush for any bytes buffered inside TextDecoder at stream end.
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      flushBufferedEvents();
    }
  } catch (readErr) {
    streamReadError = readErr;
    // Final flush even on read failure so already-received bytes can be parsed.
    buffer += decoder.decode();
  }

  flushBufferedEvents();
  if (buffer.trim()) {
    processEvent(buffer);
    buffer = '';
  }

  const shouldPropagateStreamError =
    Boolean(streamReadError) && !receivedDone && !receivedFirstDelta && replies.length === 0;

  if (shouldPropagateStreamError) {
    throw streamReadError;
  }

  console.log(`[sendMessageStream] 流结束: characterId=${character.id}, receivedReady=${receivedReady}, receivedFirstDelta=${receivedFirstDelta}, receivedDone=${receivedDone}`);
  return replies;
}
