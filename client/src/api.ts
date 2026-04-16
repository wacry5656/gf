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

export type StreamErrorStage = 'pre-connect' | 'before-first-chunk' | 'after-partial';

interface AuthResponsePayload {
  userId?: number;
  username?: string;
  error?: string;
}

interface ChatResponsePayload {
  reply?: string;
  replies?: string[];
  error?: string;
}

interface CharactersResponsePayload {
  characters?: Character[];
  error?: string;
}

interface CharacterMutationPayload {
  characterId?: number;
  error?: string;
}

interface MessagesResponsePayload {
  messages?: ChatMessage[];
  error?: string;
}

interface ApiStatusPayload {
  success?: boolean;
  error?: string;
}

export class StreamChatError extends Error {
  readonly stage: StreamErrorStage;
  readonly cause?: unknown;

  constructor(stage: StreamErrorStage, message: string, cause?: unknown) {
    super(message);
    this.name = 'StreamChatError';
    this.stage = stage;
    this.cause = cause;
  }
}

const API_BASE = '/api';

function parseJsonText(text: string): unknown {
  if (!text || text.trim() === '') return null;
  // Callers intentionally handle invalid JSON so they can fall back to
  // proxy-safe error messages or partial stream recovery behavior.
  return JSON.parse(text);
}

function isHtmlLikeResponse(text: string, contentType: string | null): boolean {
  const normalized = text.trim().toLowerCase();
  return Boolean(
    contentType?.includes('text/html') ||
    normalized.startsWith('<!doctype html') ||
    normalized.startsWith('<html') ||
    normalized.startsWith('<body') ||
    normalized.startsWith('<head')
  );
}

/**
 * Handles proxy / gateway failures that may return HTML or empty bodies
 * instead of the JSON payloads produced by the application server.
 */
function getResponseErrorMessageFromText(
  text: string,
  fallback: string,
  contentType?: string | null,
  options?: { proxyHint?: string }
): string {
  try {
    const data = parseJsonText(text) as AuthResponsePayload | null;
    if (data?.error) return data.error;
  } catch {
    // Ignore non-JSON error bodies such as HTML error pages from proxies.
  }
  if (isHtmlLikeResponse(text, contentType ?? null)) {
    return options?.proxyHint || fallback;
  }
  if (!text.trim()) {
    return `${fallback}（服务返回空响应）`;
  }
  return fallback;
}

async function readJsonApiResponse<T>(
  res: Response,
  fallback: string,
  proxyHint: string
): Promise<T> {
  const raw = await res.text();
  const contentType = res.headers.get('content-type');

  try {
    return parseJsonText(raw) as T;
  } catch {
    throw new Error(getResponseErrorMessageFromText(raw, fallback, contentType, { proxyHint }));
  }
}

function getApiProxyHint(action: string): string {
  return `${action}：请求未命中后端接口，请检查 /api 代理或 Nginx 配置。`;
}

function createStreamStageError(
  stage: StreamErrorStage,
  message: string,
  cause?: unknown
): StreamChatError {
  return new StreamChatError(stage, message, cause);
}

function getInterruptedStreamError(
  receivedReady: boolean,
  receivedFirstDelta: boolean,
  replies: string[],
  cause?: unknown
): StreamChatError {
  if (receivedFirstDelta || replies.length > 0) {
    return createStreamStageError(
      'after-partial',
      '连接在回复过程中中断，已保留已收到的内容，可继续追问或重试。',
      cause
    );
  }

  if (receivedReady) {
    return createStreamStageError(
      'before-first-chunk',
      '连接已建立，但在首个回复分片返回前中断，请重试。',
      cause
    );
  }

  return createStreamStageError(
    'pre-connect',
    '流式连接失败，请检查网络或 /api 代理配置后重试。',
    cause
  );
}

// ====== 认证 ======

export async function register(username: string, password: string): Promise<User> {
  const res = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await readJsonApiResponse<AuthResponsePayload>(
    res,
    '注册失败，请稍后重试',
    '注册失败：请求未命中后端认证接口，请检查 /api 代理或 Nginx 配置。'
  );
  if (!res.ok) throw new Error(data?.error || '注册失败');
  if (!data?.userId || !data?.username) {
    throw new Error('注册失败，请稍后重试');
  }
  return { userId: data.userId, username: data.username };
}

export async function login(username: string, password: string): Promise<User> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await readJsonApiResponse<AuthResponsePayload>(
    res,
    '登录失败，请稍后重试',
    '登录失败：请求未命中后端认证接口，请检查 /api 代理或 Nginx 配置。'
  );
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
  const data = await readJsonApiResponse<ChatResponsePayload>(
    res,
    `请求失败 (${res.status})`,
    getApiProxyHint('发送消息失败')
  );
  if (!res.ok) throw new Error(data?.error || `请求失败 (${res.status})`);
  return data?.replies || (data?.reply ? [data.reply] : []);
}

// ====== 角色数据 ======

export async function getCharacters(userId: number): Promise<Character[]> {
  const res = await fetch(`/api/data/characters?userId=${userId}`);
  const data = await readJsonApiResponse<CharactersResponsePayload>(
    res,
    '获取角色失败',
    getApiProxyHint('获取角色失败')
  );
  if (!res.ok) throw new Error(data?.error || '获取角色失败');
  return data?.characters || [];
}

export async function createCharacter(userId: number, char: Character): Promise<number> {
  const res = await fetch('/api/data/characters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, ...char }),
  });
  const data = await readJsonApiResponse<CharacterMutationPayload>(
    res,
    '创建角色失败',
    getApiProxyHint('创建角色失败')
  );
  if (!res.ok) throw new Error(data?.error || '创建角色失败');
  if (!data?.characterId) throw new Error('创建角色失败');
  return data.characterId;
}

export async function deleteCharacter(characterId: number, userId: number): Promise<void> {
  const res = await fetch(`/api/data/characters/${characterId}?userId=${userId}`, { method: 'DELETE' });
  const data = await readJsonApiResponse<ApiStatusPayload>(
    res,
    '删除角色失败',
    getApiProxyHint('删除角色失败')
  );
  if (!res.ok) throw new Error(data?.error || '删除角色失败');
}

// ====== 聊天记录 ======

export async function getMessages(characterId: number, userId: number): Promise<ChatMessage[]> {
  const res = await fetch(`/api/data/messages/${characterId}?userId=${userId}`);
  const data = await readJsonApiResponse<MessagesResponsePayload>(
    res,
    '获取消息失败',
    getApiProxyHint('获取消息失败')
  );
  if (!res.ok) throw new Error(data?.error || '获取消息失败');
  return data?.messages || [];
}

export async function saveMessage(characterId: number, role: string, content: string, userId: number): Promise<void> {
  const res = await fetch('/api/data/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterId, role, content, userId }),
  });
  const data = await readJsonApiResponse<ApiStatusPayload>(
    res,
    '保存消息失败',
    getApiProxyHint('保存消息失败')
  );
  if (!res.ok) throw new Error(data?.error || '保存消息失败');
}

export async function clearMessages(characterId: number, userId: number): Promise<void> {
  const res = await fetch(`/api/data/messages/${characterId}?userId=${userId}`, { method: 'DELETE' });
  const data = await readJsonApiResponse<ApiStatusPayload>(
    res,
    '清空消息失败',
    getApiProxyHint('清空消息失败')
  );
  if (!res.ok) throw new Error(data?.error || '清空消息失败');
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
    return await readJsonApiResponse<EmotionInfo>(
      res,
      '获取情绪状态失败',
      getApiProxyHint('获取情绪状态失败')
    );
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
    return await readJsonApiResponse<RelationshipInfo>(
      res,
      '获取关系状态失败',
      getApiProxyHint('获取关系状态失败')
    );
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
  const url = `${API_BASE}/chat/stream`;
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
    throw createStreamStageError(
      'pre-connect',
      `流式连接失败，请检查网络或 /api 代理配置后重试 (${networkErr?.message || '未知错误'})`,
      networkErr
    );
  }

  if (!res.ok) {
    const raw = await res.text();
    const errorMsg = getResponseErrorMessageFromText(
      raw,
      `请求失败 (${res.status})`,
      res.headers.get('content-type'),
      { proxyHint: '流式聊天失败：请求未命中后端接口，请检查 /api 代理或 Nginx 配置。' }
    );
    console.error(`[sendMessageStream] 服务端返回错误: status=${res.status}, error=${errorMsg}`);
    throw createStreamStageError('pre-connect', errorMsg);
  }

  if (!res.body) {
    throw createStreamStageError('pre-connect', '流式连接失败：响应体为空');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let replies: string[] = [];
  let accumulatedText = '';
  let buffer = '';
  let receivedReady = false;
  let receivedFirstDelta = false;
  let receivedDone = false;
  let streamReadError: unknown = null;
  let partialWarning: unknown = null;

  const getRecoveredReplies = (): string[] => {
    if (replies.length > 0) return replies;
    if (accumulatedText.length > 0) return [accumulatedText];
    return [];
  };

  const hasPartialContent = (): boolean => {
    return receivedFirstDelta || getRecoveredReplies().length > 0;
  };

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

    if (eventName === 'ping') {
      return;
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
        if ((parsed.ok === true || parsed.type === 'ready') && !receivedReady) {
          receivedReady = true;
          console.log(`[sendMessageStream] 收到 ready (via data)`);
          if (onReady) onReady();
        }
        return;
      }

      if (parsed.type === 'done') {
        receivedDone = true;
        if (Array.isArray(parsed.replies)) replies = parsed.replies;
        console.log(`[sendMessageStream] 收到 done 事件, characterId=${character.id}`);
        return;
      }

      if (parsed.delta) {
        if (!receivedFirstDelta) {
          receivedFirstDelta = true;
          console.log(`[sendMessageStream] 收到第一个 delta, characterId=${character.id}`);
        }
        accumulatedText += parsed.delta;
        onDelta(parsed.delta);
      }
      if (parsed.replies) replies = parsed.replies;
      if (parsed.error) {
        const streamError = getInterruptedStreamError(
          receivedReady,
          receivedFirstDelta,
          getRecoveredReplies(),
          parsed.error
        );
        if (hasPartialContent()) {
          partialWarning = streamError;
          console.warn('[sendMessageStream] 收到流式错误事件，但已保留部分内容', streamError);
          return;
        }
        throw streamError;
      }
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

  if (streamReadError instanceof StreamChatError) {
    if (hasPartialContent()) {
      partialWarning = streamReadError;
    } else {
      throw streamReadError;
    }
  }

  const recoveredReplies = getRecoveredReplies();

  if (streamReadError || !receivedDone) {
    if (hasPartialContent()) {
      partialWarning = partialWarning || streamReadError || new Error('流式响应在 done 前结束');
      console.warn('[sendMessageStream] 流提前结束，但已返回部分内容', partialWarning);
      console.log(`[sendMessageStream] 流结束(部分成功): characterId=${character.id}, receivedReady=${receivedReady}, receivedFirstDelta=${receivedFirstDelta}, receivedDone=${receivedDone}`);
      return recoveredReplies;
    }

    throw getInterruptedStreamError(receivedReady, receivedFirstDelta, recoveredReplies, streamReadError);
  }

  if (partialWarning) {
    console.warn('[sendMessageStream] 流式响应包含可恢复异常，已返回现有内容', partialWarning);
  }

  console.log(`[sendMessageStream] 流结束: characterId=${character.id}, receivedReady=${receivedReady}, receivedFirstDelta=${receivedFirstDelta}, receivedDone=${receivedDone}`);
  return recoveredReplies;
}
