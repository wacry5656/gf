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

// ====== 认证 ======

export async function register(username: string, password: string): Promise<User> {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '注册失败');
  return data;
}

export async function login(username: string, password: string): Promise<User> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '登录失败');
  return data;
}

// ====== 聊天 ======

export async function sendMessage(
  character: Character,
  messages: ChatMessage[]
): Promise<string[]> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character, messages, characterId: character.id }),
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

export async function getMessages(characterId: number): Promise<ChatMessage[]> {
  const res = await fetch(`/api/data/messages/${characterId}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '获取消息失败');
  return data.messages;
}

export async function saveMessage(characterId: number, role: string, content: string): Promise<void> {
  await fetch('/api/data/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterId, role, content }),
  });
}

export async function clearMessages(characterId: number): Promise<void> {
  await fetch(`/api/data/messages/${characterId}`, { method: 'DELETE' });
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
  onDelta: (content: string) => void
): Promise<string[]> {
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character, messages, characterId: character.id }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `请求失败 (${res.status})`);
  }

  if (!res.body) {
    throw new Error('响应体为空');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let replies: string[] = [];
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      const data = trimmed.slice(6).trim();
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        if (parsed.delta) onDelta(parsed.delta);
        if (parsed.replies) replies = parsed.replies;
        if (parsed.error) throw new Error(parsed.error);
      } catch (e: any) {
        // Only rethrow application errors, not JSON parse errors from partial SSE chunks
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }

  return replies;
}
