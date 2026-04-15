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
    let errorMsg = `请求失败 (${res.status})`;
    try {
      const data = await res.json();
      if (data.error) errorMsg = data.error;
    } catch {
      // response body not JSON, use default error
    }
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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty lines and SSE comments (lines starting with ':')
      if (!trimmed || trimmed.startsWith(':')) continue;

      // Handle SSE event lines (e.g. "event: ready")
      if (trimmed.startsWith('event:')) {
        const eventName = trimmed.slice(6).trim();
        if (eventName === 'ready') {
          receivedReady = true;
          console.log(`[sendMessageStream] 收到 ready 事件`);
          if (onReady) onReady();
        }
        // event lines don't carry data themselves, skip further processing
        continue;
      }

      if (!trimmed.startsWith('data: ') && !trimmed.startsWith('data:')) continue;

      const data = trimmed.startsWith('data: ') ? trimmed.slice(6).trim() : trimmed.slice(5).trim();
      if (data === '[DONE]') {
        receivedDone = true;
        console.log(`[sendMessageStream] 收到 done, characterId=${character.id}`);
        continue;
      }

      // Skip empty data payloads
      if (!data) continue;

      try {
        const parsed = JSON.parse(data);

        // Skip control messages (ready, ping, etc.)
        if (parsed.ok === true || parsed.type === 'ready' || parsed.type === 'ping') {
          if (parsed.ok === true && !receivedReady) {
            receivedReady = true;
            console.log(`[sendMessageStream] 收到 ready (via data)`);
            if (onReady) onReady();
          }
          continue;
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
        // Only rethrow application errors, not JSON parse errors from partial SSE chunks
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }

  console.log(`[sendMessageStream] 流结束: characterId=${character.id}, receivedReady=${receivedReady}, receivedFirstDelta=${receivedFirstDelta}, receivedDone=${receivedDone}`);
  return replies;
}
