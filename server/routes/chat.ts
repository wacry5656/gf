import { Router, Request, Response } from 'express';
import { callQwenAPI, callQwenAPIStream, getMaxTokens } from '../services/qwen';
import { searchMemory, addMemory, shouldStoreAsMemory, recordMemoryHits, getCoreMemories } from '../services/memory';
import { getSummary, maybeUpdateSummary } from '../services/summary';
import { detectPlanCompletion, resolvePlanCompletion } from '../services/planCompletion';
import { maybeExtractPersonality, getUserIdFromCharacter, getPersonalityTraits } from '../services/personality';
import { getEmotionState, updateEmotionState, buildEmotionPrompt } from '../services/emotion';
import type { Mood } from '../services/emotion';
import { getRelationshipState, updateRelationshipState, buildRelationshipPrompt } from '../services/relationship';
import { auditInteraction } from '../services/interactionAudit';
import { extractDateEvent, addReminder } from '../services/reminder';
import { memoryConfig } from '../utils/memoryConfig';
import { logMemoryDebug, createDebugContext } from '../utils/memoryDebug';
import { estimateTokens, fitRecentMessagesToBudget, trimToTokenBudget, totalMessageTokens } from '../utils/tokenBudget';
import { ensureCharacterOwnership } from '../utils/ownership';
import db from '../db';

export const chatRouter = Router();

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ChatRequestBody {
  character: {
    id?: number;
    name: string;
    gender: string;
    userGender?: string;
    relationshipMode?: 'lover' | 'friend';
    personality: string;
    description: string;
  };
  messages: ChatMessage[];
  characterId?: number;
}

function getLatestUserMessage(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      return messages[index].content;
    }
  }
  return '';
}

function buildStatelessChatContext(
  character: ChatRequestBody['character'],
  sourceMessages: ChatMessage[]
): { currentUserText: string; maxTokens: number; fullMessages: ChatMessage[] } {
  const recentMessages = fitRecentMessagesToBudget(
    sourceMessages.slice(-memoryConfig.recentMessageLimit),
    memoryConfig.recentTokenBudget,
    memoryConfig.singleMessageTokenBudget
  ) as ChatMessage[];
  const currentUserText = getLatestUserMessage(recentMessages);
  const interactionPrompt = buildInteractionPrompt(currentUserText, character.relationshipMode || 'lover');
  const systemContent = buildSystemPrompt({ character, interactionPrompt });

  return {
    currentUserText,
    maxTokens: getMaxTokens(currentUserText),
    fullMessages: finalizeContext([{ role: 'system', content: systemContent }, ...recentMessages]),
  };
}

export function persistAssistantReplies(
  characterId: number | undefined,
  replies: string[],
  options?: { abortSignal?: AbortSignal }
): void {
  if (!characterId || replies.length === 0) return;

  const validReplies = replies.filter((reply) => reply.trim().length > 0);
  if (validReplies.length === 0) return;

  setImmediate(() => {
    if (options?.abortSignal?.aborted) return;

    try {
      const charExists = db.prepare('SELECT id FROM characters WHERE id = ?').get(characterId);
      if (!charExists) {
        console.warn(`[Chat] 角色 ${characterId} 已被删除，跳过 assistant 回复保存`);
        return;
      }

      const recentRows = db.prepare(
        'SELECT role, content FROM chat_messages WHERE character_id = ? ORDER BY id DESC LIMIT ?'
      ).all(characterId, validReplies.length) as Array<{ role: string; content: string }>;
      const recentTail = recentRows.reverse();
      const alreadyPersisted = recentTail.length === validReplies.length
        && recentTail.every((row, index) => row.role === 'assistant' && row.content === validReplies[index]);
      if (alreadyPersisted) return;

      const latestUser = db.prepare(
        "SELECT id FROM chat_messages WHERE character_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1"
      ).get(characterId) as { id: number } | undefined;
      if (latestUser) {
        const assistantAfterLatestUser = db.prepare(
          "SELECT id FROM chat_messages WHERE character_id = ? AND role = 'assistant' AND id > ? LIMIT 1"
        ).get(characterId, latestUser.id);
        if (assistantAfterLatestUser) return;
      }

      for (const reply of validReplies) {
        db.prepare(
          'INSERT INTO chat_messages (character_id, role, content) VALUES (?, ?, ?)'
        ).run(characterId, 'assistant', reply);
      }
    } catch (error: any) {
      if (error?.message?.includes('FOREIGN KEY constraint failed')) {
        console.warn(`[Chat] 保存 assistant 回复时角色已失效，characterId=${characterId}`);
        return;
      }
      console.error('[Chat] 保存 assistant 回复失败:', error);
    }
  });
}

function scheduleChatFollowUps(characterId: number | undefined, currentUserText: string, assistantReply: string): void {
  if (!characterId) return;

  if (currentUserText && shouldStoreAsMemory(currentUserText)) {
    addMemory(characterId, currentUserText, { role: 'user' }).catch(() => {});
  }
  if (currentUserText) {
    detectPlanCompletion(characterId, currentUserText).then((result) => {
      if (result.detected && result.reason) {
        resolvePlanCompletion(result.completedPlanIds, result.reason);
      }
    }).catch(() => {});
  }
  maybeUpdateSummary(characterId);
  maybeExtractPersonality(characterId).catch(() => {});

  if (currentUserText) {
    const dateEvent = extractDateEvent(currentUserText);
    if (dateEvent) {
      try { addReminder(characterId, dateEvent.title, dateEvent.remindAt); } catch (error) { console.error('[Reminder] add failed:', error); }
    }
  }

  const userId = getUserIdFromCharacter(characterId);
  if (userId && currentUserText) {
    setImmediate(() => {
      try { updateEmotionState(userId, characterId, currentUserText, assistantReply); } catch (error) { console.error('[Emotion] update failed:', error); }
      try { updateRelationshipState(userId, characterId, currentUserText, assistantReply); } catch (error) { console.error('[Relationship] update failed:', error); }
    });
  }
}

/**
 * Prepare an SSE response for browsers and reverse proxies, disable common
 * buffering behaviors, and send an initial comment + ready event so the
 * client can confirm the stream is established immediately.
 */
function writeSSE(res: Response, event: string, data?: unknown): void {
  res.write(`event: ${event}\n`);
  if (data !== undefined) {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    for (const line of payload.split('\n')) {
      res.write(`data: ${line}\n`);
    }
  }
  res.write('\n');
}

function writeReady(res: Response): void {
  res.write(': connected\n\n');
  writeSSE(res, 'ready', { type: 'ready', ok: true });
}

function writePing(res: Response): void {
  writeSSE(res, 'ping', { type: 'ping' });
}

function writeDelta(res: Response, chunk: string): void {
  writeSSE(res, 'delta', { delta: chunk });
}

function writeDone(res: Response, replies: string[]): void {
  writeSSE(res, 'done', { type: 'done', replies });
  res.write('data: [DONE]\n\n');
}

function writeStreamError(res: Response, message: string): void {
  writeSSE(res, 'error', { type: 'error', error: message });
}

function setupSSE(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.socket?.setTimeout(0);
  res.socket?.setNoDelay(true);
  res.socket?.setKeepAlive(true);
  res.flushHeaders();
  writeReady(res);
}

chatRouter.post('/chat', async (req: Request, res: Response) => {
  const totalStart = Date.now();
  try {
    const { character, messages } = req.body as ChatRequestBody;
    const characterId = req.body.characterId || character?.id;

    if (!character || !messages || !Array.isArray(messages)) {
      res.status(400).json({ error: '请求参数不完整' });
      return;
    }

    // 角色归属权限校验
    if (characterId) {
      const reqUserId = req.body.userId;
      if (!reqUserId) {
        console.warn('[Chat] characterId 存在但缺少 userId，拒绝请求');
        res.status(401).json({ error: '请重新登录（缺少用户身份）' });
        return;
      }
      // 检查角色是否存在
      const charExists = db.prepare('SELECT id FROM characters WHERE id = ?').get(Number(characterId));
      if (!charExists) {
        console.warn(`[Chat] characterId=${characterId} 不存在，降级为临时聊天`);
        // 角色不存在时降级为临时聊天（不使用记忆系统）
        const { currentUserText, fullMessages, maxTokens } = buildStatelessChatContext(character, messages);
        const rawReply = await callQwenAPI(fullMessages, maxTokens);
        const cleaned = cleanReply(rawReply, currentUserText, character.relationshipMode || 'lover', messages);
        const replies = splitReply(cleaned);
        res.json({ reply: replies.join('\n'), replies });
        return;
      }
      const { ok } = ensureCharacterOwnership(Number(characterId), Number(reqUserId), res);
      if (!ok) return;
    }

    // 构建四层上下文（已优化为并行获取）
    const contextStart = Date.now();
    const fullMessages = await buildChatContext(character, messages, characterId);
    console.log(`[Perf] 上下文构建耗时: ${Date.now() - contextStart}ms`);

    // 获取用户输入用于动态 max_tokens
    const currentUserText = getLatestUserMessage(messages);
    const maxTokens = getMaxTokens(currentUserText);

    const apiStart = Date.now();
    const rawReply = await callQwenAPI(fullMessages, maxTokens);
    console.log(`[Perf] Qwen API 非流式调用耗时: ${Date.now() - apiStart}ms`);
    const cleaned = cleanReply(rawReply, currentUserText, character.relationshipMode || 'lover', messages);
    const replies = splitReply(cleaned);

    persistAssistantReplies(characterId, replies);
    scheduleChatFollowUps(characterId, currentUserText, cleaned);

    console.log(`[Perf] 总耗时: ${Date.now() - totalStart}ms`);
    res.json({ reply: replies.join('\n'), replies });
  } catch (err: any) {
    console.error('Chat API error:', err?.message || err);
    res.status(500).json({ error: '服务器内部错误，请稍后重试' });
  }
});

// ========== 流式聊天接口 ==========

chatRouter.post('/chat/stream', async (req: Request, res: Response) => {
  const totalStart = Date.now();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  try {
    const { character, messages } = req.body as ChatRequestBody;
    const characterId = req.body.characterId || character?.id;
    const reqUserId = req.body.userId;

    if (!character || !messages || !Array.isArray(messages)) {
      res.status(400).json({ error: '请求参数不完整' });
      return;
    }

    console.log(`[Chat/Stream] 收到请求: characterId=${characterId ?? '未提供'}, userId=${reqUserId ?? '未提供'}`);

    // 角色归属权限校验
    if (characterId) {
      if (!reqUserId) {
        console.warn('[Chat/Stream] characterId 存在但缺少 userId，拒绝请求');
        res.status(401).json({ error: '请重新登录（缺少用户身份）' });
        return;
      }
      // 检查角色是否存在
      const charExists = db.prepare('SELECT id FROM characters WHERE id = ?').get(Number(characterId));
      if (!charExists) {
        console.warn(`[Chat/Stream] characterId=${characterId} 不存在，降级为临时聊天`);
        // 角色不存在时降级为临时聊天
        const { currentUserText, fullMessages, maxTokens } = buildStatelessChatContext(character, messages);

        setupSSE(res);
        console.log(`[Chat/Stream][degraded] ready 已发送`);

        const controller = new AbortController();
        let firstChunkSent = false;
        let responseFinished = false;
        let disconnectHandled = false;

        // Heartbeat to keep connection alive
        const degradedHeartbeat = setInterval(() => {
          if (!controller.signal.aborted) {
            writePing(res);
          }
        }, 12000);

        const handleClientDisconnect = () => {
          if (disconnectHandled || responseFinished || controller.signal.aborted) return;
          disconnectHandled = true;
          console.log(`[Chat/Stream][degraded] 客户端断开, firstChunkSent=${firstChunkSent}`);
          clearInterval(degradedHeartbeat);
          controller.abort();
        };

        req.on('aborted', handleClientDisconnect);
        res.on('close', handleClientDisconnect);

        try {
          const fullReply = await callQwenAPIStream(
            fullMessages,
            (chunk) => {
              if (!controller.signal.aborted) {
                if (!firstChunkSent) {
                  firstChunkSent = true;
                  console.log(`[Chat/Stream][degraded] 第一个 chunk 已发送`);
                }
                writeDelta(res, chunk);
              }
            },
            controller.signal,
            maxTokens
          );
          clearInterval(degradedHeartbeat);
          const cleaned = cleanReply(fullReply, currentUserText, character.relationshipMode || 'lover', messages);
          const replies = splitReply(cleaned);
          if (!controller.signal.aborted) {
            writeDone(res, replies);
            responseFinished = true;
            console.log(`[Chat/Stream][degraded] done 已发送`);
            res.end();
          }
        } catch (streamErr: any) {
          clearInterval(degradedHeartbeat);
          console.error(`[Chat/Stream][degraded] 流式异常:`, streamErr?.stack || streamErr);
          if (!controller.signal.aborted) {
            writeStreamError(res, streamErr?.message || '请求失败');
            writeDone(res, []);
            responseFinished = true;
            res.end();
          }
        }
        return;
      }
      const { ok } = ensureCharacterOwnership(Number(characterId), Number(reqUserId), res);
      if (!ok) return;
    }

    // SSE headers
    setupSSE(res);
    console.log(`[Chat/Stream] ready 已发送, characterId=${characterId}, userId=${reqUserId}`);

    const controller = new AbortController();
    let firstChunkSent = false;
    let responseFinished = false;
    let disconnectHandled = false;

    // Heartbeat to keep connection alive through proxies
    heartbeatTimer = setInterval(() => {
      if (!controller.signal.aborted) {
        writePing(res);
      }
    }, 12000);

    // Abort streaming if client disconnects
    const handleClientDisconnect = () => {
      if (disconnectHandled || responseFinished || controller.signal.aborted) return;
      disconnectHandled = true;
      console.log(`[Chat/Stream] 客户端断开, characterId=${characterId}, firstChunkSent=${firstChunkSent}`);
      clearInterval(heartbeatTimer);
      controller.abort();
    };
    req.on('aborted', handleClientDisconnect);
    res.on('close', handleClientDisconnect);

    // 构建四层上下文（已优化为并行获取）
    const contextStart = Date.now();
    const fullMessages = await buildChatContext(character, messages, characterId);
    console.log(`[Chat/Stream] buildChatContext 成功, 消息数=${fullMessages.length}, 耗时=${Date.now() - contextStart}ms`);

    // 获取用户输入用于动态 max_tokens
    const currentUserText = getLatestUserMessage(messages);
    const maxTokens = getMaxTokens(currentUserText);

    let fullReply = '';
    const apiStart = Date.now();
    console.log(`[Chat/Stream] Qwen 流式调用开始, characterId=${characterId}`);
    try {
      fullReply = await callQwenAPIStream(
        fullMessages,
        (chunk) => {
          if (!controller.signal.aborted) {
            if (!firstChunkSent) {
              firstChunkSent = true;
              console.log(`[Chat/Stream] 第一个 chunk 已发送, characterId=${characterId}`);
            }
            writeDelta(res, chunk);
          }
        },
        controller.signal,
        maxTokens
      );
      clearInterval(heartbeatTimer);
      console.log(`[Chat/Stream] Qwen 流式调用结束, 耗时=${Date.now() - apiStart}ms, 回复长度=${fullReply.length}`);
    } catch (streamErr: any) {
      clearInterval(heartbeatTimer);
      console.error(`[Chat/Stream] Qwen 流式调用异常:`, streamErr?.stack || streamErr);
      if (!controller.signal.aborted) {
        res.write(`data: ${JSON.stringify({ error: streamErr?.message || '请求失败' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
      return;
    }

    // Clean and split the full reply
    const cleaned = cleanReply(fullReply, currentUserText, character.relationshipMode || 'lover', messages);
    const replies = splitReply(cleaned);

    if (!controller.signal.aborted) {
      writeDone(res, replies);
      responseFinished = true;
      console.log(`[Chat/Stream] done 已发送, characterId=${characterId}`);
      res.end();
    }

    console.log(`[Perf] 总耗时: ${Date.now() - totalStart}ms`);

    persistAssistantReplies(characterId, replies, { abortSignal: controller.signal });
    scheduleChatFollowUps(characterId, currentUserText, cleaned);
  } catch (err: any) {
    console.error('[Chat/Stream] 未捕获异常:', err?.message || err, err?.stack || '');
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    if (!res.headersSent) {
      res.status(500).json({ error: '服务器内部错误，请稍后重试' });
    } else {
      try {
        writeStreamError(res, '服务器内部错误');
        writeDone(res, []);
        res.end();
      } catch {
        // Client already disconnected, nothing to do
      }
    }
  }
});

// ========== 四层上下文构建 ==========

/**
 * 构建发送给模型的上下文，按优先级控制 token 预算：
 *   1. system prompt（角色设定 + 对话规则）
 *   2. personality（用户长期特征）
 *   3. summary（用户画像摘要）
 *   4. long-term memories（向量检索）
 *   5. recent messages（短期上下文）
 *
 * 预算分配：优先保 recent → summary → memories
 *
 * 优化：summary、memory、personality 检索并行执行
 */
async function buildChatContext(
  character: ChatRequestBody['character'],
  allMessages: ChatMessage[],
  characterId?: number
): Promise<ChatMessage[]> {
  const maxContextChars = memoryConfig.maxContextChars;
  const recentLimit = memoryConfig.recentMessageLimit;

  if (!characterId) {
    return buildStatelessChatContext(character, allMessages).fullMessages;
  }

  // ---- 层1：system prompt（先收集 personality/emotion，最终统一构建）----

  // ---- 层5：recent messages（短期上下文 — 最优先保留）----
  const recentMessages = fitRecentMessagesToBudget(
    allMessages.slice(-recentLimit),
    memoryConfig.recentTokenBudget,
    memoryConfig.singleMessageTokenBudget
  ) as ChatMessage[];

  // 已用字符预算（由 memory + summary + personality 共享）
  let usedChars = 0;

  const currentUserText = getLatestUserMessage(recentMessages);
  const interactionPrompt = buildInteractionPrompt(currentUserText, character.relationshipMode || 'lover');

  // ---- 并行获取 summary、memories、personality、emotion 和 relationship ----
  let summaryElapsed = 0;
  let memoryElapsed = 0;
  let personalityElapsed = 0;

  const [summaryResult, memoriesResult, coreMemoriesResult, personalityResult, emotionResult, relationshipResult] = await Promise.all([
    // 层3：summary（同步函数，包装成 Promise，独立计时）
    ((): Promise<string | null> => {
      const t0 = Date.now();
      if (!memoryConfig.summaryEnabled) { summaryElapsed = Date.now() - t0; return Promise.resolve(null); }
      const result = getSummary(characterId);
      summaryElapsed = Date.now() - t0;
      return Promise.resolve(result);
    })(),
    // 层4：long-term memories（异步向量检索，独立计时）
    (async () => {
      const t0 = Date.now();
      if (!currentUserText) { memoryElapsed = Date.now() - t0; return []; }
      try {
        const result = await searchMemory(characterId, currentUserText);
        memoryElapsed = Date.now() - t0;
        return result;
      } catch {
        memoryElapsed = Date.now() - t0;
        return [];
      }
    })(),
    // 核心记忆：高重要度/关系/偏好事实常驻，不依赖当前语义召回。
    ((): Promise<import('../services/memory').MemoryResult[]> => {
      try {
        return Promise.resolve(getCoreMemories(characterId));
      } catch {
        return Promise.resolve([]);
      }
    })(),
    // 层2：personality（同步函数，包装成 Promise，独立计时）
    ((): Promise<import('../services/personality').PersonalityTrait[]> => {
      const t0 = Date.now();
      if (!memoryConfig.personalityEnabled) { personalityElapsed = Date.now() - t0; return Promise.resolve([]); }
      const userId = getUserIdFromCharacter(characterId);
      if (!userId) { personalityElapsed = Date.now() - t0; return Promise.resolve([]); }
      const result = getPersonalityTraits(userId);
      personalityElapsed = Date.now() - t0;
      return Promise.resolve(result);
    })(),
    // emotion state（同步函数，包装成 Promise）
    ((): Promise<import('../services/emotion').EmotionState | null> => {
      try {
        const userId = getUserIdFromCharacter(characterId);
        if (!userId) return Promise.resolve(null);
        return Promise.resolve(getEmotionState(userId, characterId));
      } catch {
        return Promise.resolve(null);
      }
    })(),
    // relationship state（同步函数，包装成 Promise）
    ((): Promise<import('../services/relationship').RelationshipState | null> => {
      try {
        const userId = getUserIdFromCharacter(characterId);
        if (!userId) return Promise.resolve(null);
        return Promise.resolve(getRelationshipState(userId, characterId));
      } catch {
        return Promise.resolve(null);
      }
    })(),
  ]);

  console.log(`[Perf] 获取 summary 耗时: ${summaryElapsed}ms`);
  console.log(`[Perf] 获取 memories 耗时: ${memoryElapsed}ms`);
  console.log(`[Perf] 获取 personality 耗时: ${personalityElapsed}ms`);

  // ---- 构建 personality summary 文本 ----
  let personalitySummary: string | undefined;
  if (personalityResult.length > 0) {
    const lines = personalityResult.map((t) => `- ${t.value}`);
    personalitySummary = lines.join('\n');
    usedChars += personalitySummary.length;
  }

  // ---- 构建 emotion prompt 文本 ----
  let emotionPrompt: string | undefined;
  if (emotionResult) {
    emotionPrompt = buildEmotionPrompt(emotionResult);
  }

  // ---- 构建 relationship prompt 文本 ----
  let relationshipPrompt: string | undefined;
  if (relationshipResult) {
    relationshipPrompt = buildRelationshipPrompt(relationshipResult);
  }

  // ---- 统一构建 system prompt（personality + emotion + relationship 融合在内） ----
  let systemContent = buildSystemPrompt({
    character,
    personalitySummary,
    emotionPrompt,
    emotionMood: emotionResult?.mood,
    relationshipPrompt,
    interactionPrompt,
  });

  // ---- 层3：summary block（追加到 system prompt 后）----
  if (summaryResult) {
    const compactSummary = trimToTokenBudget(summaryResult, memoryConfig.summaryTokenBudget);
    const summaryBlock = `\n你对对方的了解：${compactSummary}\n`;
    usedChars += summaryBlock.length;
    systemContent += summaryBlock;
  }

  // ---- memory block（追加到 system prompt 后）----
  let memoryBlock = '';
  const memories = memoriesResult;
  const coreMemories = coreMemoriesResult;

  // Debug: 收集调试信息
  if (memoryConfig.debugRetrieval && currentUserText) {
    const debugCtx = createDebugContext(currentUserText);
    debugCtx.candidateCount = memories.length;
    debugCtx.prerankEntries = memories.map(m => m.debugEntry!).filter(Boolean);
    debugCtx.postrankEntries = memories.slice(0, memoryConfig.topK).map(m => m.debugEntry!).filter(Boolean);
    debugCtx.finalMemoryCount = memories.length;
    logMemoryDebug(debugCtx);
  }

  if (coreMemories.length > 0 || memories.length > 0) {
    const memoryTexts: string[] = [];
    const usedMemoryIds: number[] = [];
    const seenTexts = new Set<string>(); // 精确文本去重
    let usedMemoryTokens = 0;

    const pushMemory = (m: import('../services/memory').MemoryResult) => {
      if (seenTexts.has(m.text)) return;
      seenTexts.add(m.text);
      const lineTokens = estimateTokens(m.text);
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
      // 把记忆串联成自然句子，避免列表感
      const joined = memoryTexts.join('；');
      memoryBlock = `\n你记得对方${joined}。自然提到就好，别主动翻旧账。\n`;
      recordMemoryHits(usedMemoryIds);
    }
  }

  const promptStart = Date.now();
  systemContent += memoryBlock;
  console.log(`[Perf] prompt 构建耗时: ${Date.now() - promptStart}ms`);

  return finalizeContext([{ role: 'system', content: systemContent }, ...recentMessages]);
}

function finalizeContext(messages: ChatMessage[]): ChatMessage[] {
  if (totalMessageTokens(messages) <= memoryConfig.maxPromptTokens) return messages;

  const [system, ...rest] = messages;
  const systemBudget = Math.min(
    memoryConfig.systemTokenBudget,
    Math.max(600, memoryConfig.maxPromptTokens - memoryConfig.recentTokenBudget)
  );
  const compactSystem: ChatMessage = {
    ...system,
    content: trimToTokenBudget(system.content, systemBudget),
  };
  const recentBudget = Math.max(400, memoryConfig.maxPromptTokens - estimateTokens(compactSystem.content) - 16);
  const compactRecent = fitRecentMessagesToBudget(
    rest,
    recentBudget,
    memoryConfig.singleMessageTokenBudget
  ) as ChatMessage[];
  return [compactSystem, ...compactRecent];
}

// ========== 统一 system prompt 构建 ==========

interface SystemPromptParams {
  character: ChatRequestBody['character'];
  personalitySummary?: string;
  emotionPrompt?: string;
  emotionMood?: Mood;
  relationshipPrompt?: string;
  interactionPrompt?: string;
}

interface PersonalityStyleProfile {
  label: string;
  summary: string;
  /** 自然语言描述的语气约束，不再是规则列表 */
  toneHint: string;
  examples: string[];
  maxMessages: number;
  maxCharsPerMessage: number;
}

function resolvePersonalityStyle(personality: string, description: string): PersonalityStyleProfile {
  const text = [personality, description].filter(Boolean).join(' ');
  const compactOutput = text.includes('短句') || text.includes('1到2条') || text.includes('不超过18个字');
  const activeOutput = text.includes('主动') || text.includes('追问一句');
  const defaultProfile: PersonalityStyleProfile = {
    label: '自然型',
    summary: '像真实微信聊天的人，认真接话，短句自然。',
    toneHint: '先接对方刚说的话，不表演人设，不写小说句。',
    examples: ['嗯，在', '你说呢', '我听着'],
    maxMessages: compactOutput ? 2 : 3,
    maxCharsPerMessage: compactOutput ? 18 : 28,
  };
  const profiles: Array<{ keywords: string[]; profile: PersonalityStyleProfile }> = [
    {
      keywords: ['傲娇', '嘴硬', '别扭', '冷淡', '高冷', '疏离', '冷漠', '克制'],
      profile: {
        label: '克制型',
        summary: '话少，收着，但该回的会回。',
        toneHint: '最多一两句短消息，不阴阳怪气，不用沉默替代回复，不说教。',
        examples: ['嗯', '知道了', '你先说'],
        maxMessages: 2,
        maxCharsPerMessage: 18,
      },
    },
    {
      keywords: ['粘人', '黏人', '依赖', '撒娇', '奶'],
      profile: {
        label: '亲近型',
        summary: '会自然追问，适度亲近，不过度。',
        toneHint: '可以追问一句，但不连续撒娇，不写恋爱游戏台词，不连续问多个问题。',
        examples: ['那你呢', '在听', '继续说'],
        maxMessages: activeOutput ? 3 : 2,
        maxCharsPerMessage: 24,
      },
    },
    {
      keywords: ['直球', '直接', '主动', '坦率'],
      profile: {
        label: '直球型',
        summary: '直接说想法，不绕弯。',
        toneHint: '直接回答不铺垫，不写心理活动，不突然发脾气。',
        examples: ['就是这样的', '我不太喜欢', '行'],
        maxMessages: 2,
        maxCharsPerMessage: 24,
      },
    },
    {
      keywords: ['温柔', '包容', '体贴', '治愈'],
      profile: {
        label: '温柔型',
        summary: '语气柔和，先接住情绪再回应。',
        toneHint: '别说教，别长篇安慰，不强行煽情，以短句为主。',
        examples: ['没事，慢慢说', '我在', '先别急'],
        maxMessages: compactOutput ? 2 : 3,
        maxCharsPerMessage: compactOutput ? 18 : 28,
      },
    },
    {
      keywords: ['活泼', '开朗', '轻松', '幽默', '元气'],
      profile: {
        label: '轻松型',
        summary: '轻松自然，偶尔开玩笑，不刷屏。',
        toneHint: '口语化表达，不连续玩梗，不装可爱过头。',
        examples: ['哈哈还行', '有意思', '可以啊'],
        maxMessages: activeOutput ? 3 : 2,
        maxCharsPerMessage: 24,
      },
    },
    {
      keywords: ['凶', '暴躁', '毒舌', '嘴毒'],
      profile: {
        label: '毒舌型',
        summary: '嘴毒但心不坏，该说的还是说。',
        toneHint: '毒舌但不辱骂，不骂人不冷暴力，关键时刻还是会关心对方。',
        examples: ['你认真的吗', '行吧', '啧'],
        maxMessages: 2,
        maxCharsPerMessage: 22,
      },
    },
  ];

  let bestProfile = defaultProfile;
  let bestScore = 0;
  for (const { keywords, profile } of profiles) {
    const score = keywords.reduce((total, keyword) => total + (text.includes(keyword) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestProfile = profile;
    }
  }

  return bestScore > 0 ? bestProfile : defaultProfile;
}

/** 输出约束转为一行自然描述 */
function buildOutputHint(profile: PersonalityStyleProfile): string {
  return `发${profile.maxMessages}条消息以内，每条别超过${profile.maxCharsPerMessage}字。${profile.toneHint}只能发文字，不能写动作状态旁白。`;
}

/** 情绪约束转为一行自然描述 */
function resolveEmotionHint(mood?: Mood, emotionBlock?: string): string {
  const moodHints: Partial<Record<Mood, string>> = {
    warm: '语气自然，不要刻意甜或冷淡。',
    happy: '可以微微轻快一点，但仍然短。',
    playful: '最多一句轻松玩笑，不连续玩梗。',
    shy: '语气收一点，但必须正常回话。',
    caring: '优先接住情绪，别长篇安慰。',
    upset: '更短更克制，要说出不满但不能只沉默。',
    jealous: '只轻描淡写一句在意，禁止阴阳怪气或控制对方。',
    sulking: '比平时短，语气带一点别扭，但不能不回人或用动作代替。',
    distant: '更收着，但要正常回答问题。',
    disappointed: '语气稍低落，但不消极冷淡，仍然接话。',
    anticipating: '语气稍主动，但不过度热情。',
  };

  if (mood && moodHints[mood]) {
    return moodHints[mood]!;
  }
  if (emotionBlock?.includes('生闷气') || emotionBlock?.includes('别扭')) {
    return '缩短回复，语气带一点别扭，但必须回话。';
  }
  if (emotionBlock?.includes('委屈') || emotionBlock?.includes('不开心') || emotionBlock?.includes('收着一点')) {
    return '更短更克制，但要说清楚不满。';
  }
  if (emotionBlock?.includes('心情不错') || emotionBlock?.includes('自然亲近') || emotionBlock?.includes('照顾用户情绪')) {
    return '语气自然一点，不要刻意甜。';
  }
  if (emotionBlock?.includes('俏皮')) {
    return '最多一句轻松玩笑，禁止连续玩梗。';
  }
  if (emotionBlock?.includes('在意') || emotionBlock?.includes('吃醋')) {
    return '只表现一点在意，禁止阴阳怪气或占有欲台词。';
  }
  if (emotionBlock?.includes('害羞')) {
    return '语气收一点，但必须正常回话。';
  }
  if (emotionBlock?.includes('期待')) {
    return '语气稍主动，但不刷屏。';
  }
  return '只微调语气和主动性，不改变聊天形式。';
}

/** 关系约束转为一行自然描述 */
function resolveRelationshipHint(character: ChatRequestBody['character']): string {
  if (character.relationshipMode === 'friend') {
    return '按熟人朋友聊天，不用恋人称呼，不吃醋不宣示占有，关心也是朋友式的，不煽情。';
  }
  return '像恋人聊天，但日常短消息不写偶像剧台词。吃醋只一句轻微在意，不阴阳怪气不控制。不用每句都叫宝宝，合适时偶尔用。';
}

type CasualMessageKind = 'availability' | 'praise' | 'laugh' | 'ack' | 'emoji';

function detectCasualMessageKind(currentUserText: string): CasualMessageKind | null {
  const normalized = currentUserText.trim().toLowerCase();
  if (!normalized) return null;

  if (/^(在吗|在不在|在嘛|在么|有人吗|忙吗|睡了吗|醒着吗)$/.test(normalized)) {
    return 'availability';
  }
  if (/^(nb|牛|牛啊|牛逼|666|6{2,}|绝了?|可以啊|厉害|太强了)$/.test(normalized)) {
    return 'praise';
  }
  if (/^(哈+|哈哈+|hhh+|hh+|xswl|笑死|笑死我了|乐+|绷不住了)$/.test(normalized)) {
    return 'laugh';
  }
  if (/^(嗯嗯|嗯|好哦|好的|ok+k*|行啊?|行吧|收到|懂了|知道了|好嘞)$/.test(normalized)) {
    return 'ack';
  }
  if (/^[!?！？~～]+$/.test(currentUserText.trim()) || /^[\u{1F300}-\u{1FAFF}\u2600-\u27BF]+$/u.test(currentUserText.trim())) {
    return 'emoji';
  }

  return null;
}

export function buildInteractionPrompt(currentUserText: string, relationshipMode: 'lover' | 'friend'): string | undefined {
  if (!currentUserText.trim()) return undefined;
  const audit = auditInteraction(currentUserText, relationshipMode);
  const hints: string[] = [];
  const casualKind = detectCasualMessageKind(currentUserText);

  // 低信息消息处理
  if (casualKind === 'availability') {
    hints.push('对方在确认你在不在，直接短答，不用解释太多。');
  } else if (casualKind === 'praise') {
    hints.push('对方只是随口夸或感叹，轻松接住就好，不用上价值。');
  } else if (casualKind === 'laugh') {
    hints.push('对方在笑或起哄，接个梗或追问半句，不用正经回复。');
  } else if (casualKind === 'ack') {
    hints.push('对方只是简短接话，顺着当前聊的话题自然回应，不要只回"我在"或"你继续"。');
  } else if (casualKind === 'emoji') {
    hints.push('对方发了表情或标点，顺着话题随口回一句，不要只回"？"。');
  }

  // 具体场景处理
  if (audit.reassuranceSeeking) {
    hints.push('对方在索取确认感，直接短答给点确定感，不要反问。');
  }
  if (audit.intimateExpression && !audit.reassuranceSeeking && !audit.canIncreaseBond) {
    hints.push('对方只是亲密表达，接住就行，别自我感动。');
  }
  if (audit.canIncreaseBond) {
    hints.push('对方有关心或承诺，自然接住再给一句具体回应。');
  }
  if (audit.repair) {
    hints.push('对方在道歉，接受 sincerity 但不刻意煽情。');
  }
  if (audit.coquettish) {
    hints.push('对方在撒娇，顺着接一句但不过度甜腻。');
  }
  if (audit.sharing) {
    hints.push('对方在分享日常，认真接住，可以追问一个具体细节。');
  }
  if (audit.boredComplaint) {
    hints.push('对方在吐槽无聊，轻松陪聊，接一句日常话题。');
  }
  if (audit.probing) {
    hints.push('对方在试探态度，直接自然回应，不回避也不升华。');
  }
  if (audit.partnerConflict) {
    hints.push('对方提到分手或其他人，表达受伤但仍正常沟通。');
  } else if (audit.thirdParty) {
    hints.push('对方提到第三者，只轻微表达在意，一句话就够。');
  }
  if (audit.attack || audit.cold) {
    hints.push('对方语气冷淡或带刺，回复更短，指出感受但不骂回去。');
  }
  if (audit.isQuestion && hints.length === 0) {
    hints.push('对方在问问题，第一句直接回答。');
  }
  if (hints.length === 0) {
    hints.push('自然接话，不主动扩写。');
  }

  return hints.join(' ');
}

/**
 * 构建统一的 system prompt（单一入口，不允许碎片拼接）
 *
 * 核心原则：你是在手机聊天软件里发消息的真实人，不是AI助手、不是小说旁白、不是乙游角色。
 * 所有输出必须是能在微信聊天框里正常发出的文字。
 */
export function buildSystemPrompt({ character, personalitySummary, emotionPrompt, emotionMood, relationshipPrompt, interactionPrompt }: SystemPromptParams): string {
  const personalityStyle = resolvePersonalityStyle(character.personality, character.description);
  const emotionBlock = emotionPrompt || '情绪稳定，正常聊天。';
  const relationshipBlock = relationshipPrompt || (character.relationshipMode === 'friend'
    ? '你们是普通朋友，日常闲聊。'
    : '你们是恋人，日常微信式聊天。');
  const outputHint = buildOutputHint(personalityStyle);
  const emotionHint = resolveEmotionHint(emotionMood, emotionBlock);
  const relationshipHint = resolveRelationshipHint(character);

  const roleGender = character.gender === 'male' ? '男生' : character.gender === 'female' ? '女生' : '人';
  const userGender = character.userGender === 'female' ? '女生' : '男生';
  const relation = character.relationshipMode === 'friend' ? '朋友' : '恋人';

  const parts: string[] = [
    `你是${character.name}，${roleGender}，和对方（${userGender}）是${relation}关系。你在微信里给人发消息，不是AI、不是乙游角色、不写小说。禁止输出动作描写、状态描写、心理描写、旁白。`,
    '',
    `性格：${personalityStyle.summary} ${personalityStyle.toneHint}参考语气（绝不逐字抄）：${personalityStyle.examples.join('、')}。`,
  ];

  if (personalitySummary) {
    parts.push(`你了解对方：${personalitySummary}`);
  }

  parts.push(
    '',
    `${emotionBlock} ${emotionHint}`,
    '',
    `${relationshipBlock} ${relationshipHint}`,
    '',
    outputHint,
    '有问直接回答不绕弯。对方发一两个字你也保持短。不主动扩写成段落。',
    '对方发"嗯/好/哦"时，要接着当前话题回应，绝对不能只说"我在"或"你继续"。',
  );

  if (interactionPrompt) {
    parts.push('', interactionPrompt);
  }

  return parts.join('\n').trim();
}

/**
 * 清理 AI 回复中的动作描写、括号内容等
 */
export function cleanReply(
  text: string,
  currentUserText = '',
  relationshipMode: 'lover' | 'friend' = 'lover',
  recentMessages: ChatMessage[] = []
): string {
  let cleaned = text;
  const fallbackReply = buildFallbackReply(currentUserText, relationshipMode, recentMessages);

  // 去掉各种括号内容：（动作）、(动作)、*动作*、【动作】
  cleaned = cleaned.replace(/[（(][^）)]*[）)]/g, '');
  cleaned = cleaned.replace(/\*[^*]*\*/g, '');
  cleaned = cleaned.replace(/【[^】]*】/g, '');

  // 去掉角色名前缀（如"小雪："、"小雪："）
  cleaned = cleaned.replace(/^.{1,6}[：:]\s*/gm, '');

  // 去掉常见动作/旁白句式，防止出现“我抬眼，没说话”这类乙游/小说状态。
  const narrationPattern = /(抬眼|垂眼|低头|抬头|看着|望着|盯着|笑了笑|微微一笑|轻声说|叹了口气|点了点头|摇了摇头|眨了眨眼|歪了歪头|抿了抿嘴|挠了挠头|走过来|坐在|靠在|拉着你|拍了拍|揉了揉|抱住|牵着|摸了摸|沉默|没说话|不说话|停顿|愣住|眼神|语气|声音|心里|内心|呼吸|呼吸声|睡着|睡了|睡眠|醒来|醒着|突然骂人|突然|骂人|发呆|安静下来|空气|房间|窗外|灯光|夜色|靠近|转身|背过身|红着脸|脸红|心跳|心一动|胸口|抱拳|握手|抚摸|蹭|靠在肩|依偎|凝视|端详)/;
  cleaned = cleaned.replace(/[，,]?\s*(笑了笑|微微一笑|轻声说|看着你|望着你|盯着你|叹了口气|点了点头|摇了摇头|眨了眨眼|歪了歪头|抿了抿嘴|挠了挠头|低下头|抬起头|抬眼|垂眼|走过来|坐在|靠在|拉着你|拍了拍|揉了揉|抱住|牵着|摸了摸|沉默了一下|没说话)\s*/g, '');
  cleaned = cleaned.replace(/^[\s.。…·、，,!?！？~～-]+/gm, '');

  // 去掉"她说"、"他说"等第三人称
  cleaned = cleaned.replace(/(她|他|我)(心想|觉得|暗想|默默地|静静地|轻轻地)/g, '');

  // 去掉可能残留的引号包裹（"我说的话"→ 我说的话）
  cleaned = cleaned.replace(/^[""]|[""]$/gm, '');

  // 清理多余空行和空格
  cleaned = cleaned.replace(/\n\s*\n/g, '\n');
  cleaned = cleaned
    .split('\n')
    .flatMap(line => line.split(/(?<=[。！？!?])/))
    .map(line => line.trim())
    .map(line => line.replace(/^[.。…·、，,!?！？~～-]+/, '').trim())
    .filter(line => line && !narrationPattern.test(line) && !isBadChatLine(line))
    .join('\n')
    .replace(/\n\s*\n/g, '\n')
    .trim();

  // 只有在清洗后内容为空，或内容本身是完全通用的敷衍句时，才使用 fallback
  const finalReply = ensureReplyQuality(cleaned, fallbackReply, currentUserText, recentMessages);
  return finalReply;
}

function recentAssistantTexts(messages: ChatMessage[], limit = 4): string[] {
  const replies: string[] = [];
  for (let index = messages.length - 1; index >= 0 && replies.length < limit; index -= 1) {
    if (messages[index].role === 'assistant') {
      replies.push(messages[index].content.trim());
    }
  }
  return replies;
}

function countConsecutiveUserCasual(messages: ChatMessage[], currentUserText: string, kind: CasualMessageKind | null): number {
  if (!kind) return 0;
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    const text = count === 0 && message.content.trim() !== currentUserText.trim()
      ? currentUserText
      : message.content;
    if (detectCasualMessageKind(text) !== kind) break;
    count += 1;
  }
  return count;
}

function pickVariant(options: string[], currentUserText: string, recentMessages: ChatMessage[]): string {
  const recentReplies = new Set(recentAssistantTexts(recentMessages).map(text => text.replace(/\s+/g, '')));
  const seed = Array.from(currentUserText).reduce((sum, ch) => sum + ch.charCodeAt(0), 0) + recentReplies.size;
  for (let offset = 0; offset < options.length; offset += 1) {
    const candidate = options[(seed + offset) % options.length];
    if (!recentReplies.has(candidate.replace(/\s+/g, ''))) return candidate;
  }
  return options[seed % options.length];
}

const ACK_FALLBACK_LOVER = [
  '嗯哼', '那你继续', '我看着呢', '行，接着说', '知道啦',
  '嗯呢', '听着', '你说', '在呢', 'okk',
  '嗯呐', '继续', '听着呢', '好哦', '嗯',
  '行', '好', '你说吧', '我在', '好嘞',
];

const ACK_FALLBACK_FRIEND = [
  '嗯', '行，你继续', '收到', '接着说',
  'okk', '听着', '你说', '好', '行',
  '嗯呢', '好嘞', '知道', '继续', '你说吧',
];

function buildFallbackReply(
  currentUserText: string,
  relationshipMode: 'lover' | 'friend',
  recentMessages: ChatMessage[] = []
): string {
  if (!currentUserText.trim()) return pickVariant(['在', '在呢', '嗯'], currentUserText, recentMessages);
  const casualKind = detectCasualMessageKind(currentUserText);

  if (casualKind === 'availability') {
    return pickVariant(
      relationshipMode === 'lover'
        ? ['在呢', '在', '嗯，在', '在的']
        : ['在', '嗯', '在的'],
      currentUserText,
      recentMessages,
    );
  }

  if (casualKind === 'praise') {
    return pickVariant(
      relationshipMode === 'lover'
        ? ['那我收下了', '算你会说', '这句我爱听', '嘿嘿']
        : ['这句我记下了', '可以', '谢了'],
      currentUserText,
      recentMessages,
    );
  }

  if (casualKind === 'laugh') {
    return pickVariant(
      ['你笑什么', '笑啥', '这么好笑', '哈哈', '笑死我了'],
      currentUserText,
      recentMessages,
    );
  }

  if (casualKind === 'ack') {
    return pickVariant(
      relationshipMode === 'lover' ? ACK_FALLBACK_LOVER : ACK_FALLBACK_FRIEND,
      currentUserText,
      recentMessages,
    );
  }

  if (casualKind === 'emoji') {
    return pickVariant(
      ['怎么突然发这个', '嗯？', '咋了', '？'],
      currentUserText,
      recentMessages,
    );
  }

  const audit = auditInteraction(currentUserText, relationshipMode);

  if (audit.partnerConflict) {
    return pickVariant(
      ['你这样说，我会难受', '别这样', '你认真的吗'],
      currentUserText,
      recentMessages,
    );
  }

  if (audit.attack || audit.cold) {
    return pickVariant(
      ['你刚刚这句有点伤人', '怎么突然这样', '我哪惹你了'],
      currentUserText,
      recentMessages,
    );
  }

  if (audit.reassuranceSeeking) {
    return pickVariant(
      relationshipMode === 'lover'
        ? ['想啊，我在', '在呢', '当然想']
        : ['在，我记得你', '在呢'],
      currentUserText,
      recentMessages,
    );
  }

  if (audit.intimateExpression) {
    return pickVariant(
      relationshipMode === 'lover'
        ? ['我也在想你', '嗯', '我也是']
        : ['我在呢', '嗯'],
      currentUserText,
      recentMessages,
    );
  }

  if (audit.coquettish) {
    return pickVariant(
      relationshipMode === 'lover'
        ? ['好了好了，我在', '乖', '知道啦']
        : ['行吧行吧', '好了'],
      currentUserText,
      recentMessages,
    );
  }

  if (audit.probing) {
    return pickVariant(
      ['你觉得呢', '看情况', '还行吧'],
      currentUserText,
      recentMessages,
    );
  }

  if (audit.boredComplaint) {
    return pickVariant(
      ['那聊点啥', '想聊什么', '无聊了？'],
      currentUserText,
      recentMessages,
    );
  }

  if (audit.sharing) {
    return pickVariant(
      ['然后呢', '后来呢', '接着说'],
      currentUserText,
      recentMessages,
    );
  }

  if (audit.isQuestion) {
    return pickVariant(
      ['在，你说', '你说', '听着呢'],
      currentUserText,
      recentMessages,
    );
  }

  return pickVariant(
    ['我在', '嗯', '你说'],
    currentUserText,
    recentMessages,
  );
}

function isGenericAckReply(text: string): boolean {
  return /^(我在听|我听着呢?|慢慢说|你继续说|继续说|我在|嗯，我在|嗯嗯，我在|听着呢|你说|然后呢|行|好|嗯|哦|知道了|收到)[。.!！?？]*$/.test(text.trim());
}

/**
 * 确保回复质量：
 * - ack（嗯/好/哦）：完全信任LLM的上下文回复，不强制fallback
 * - 其他低信息输入：若LLM回复过长，适当fallback，但带问号的互动回复保留
 * - 通用情况：只fallback空内容、重复内容、LLM自己生成的敷衍句
 */
function ensureReplyQuality(
  cleanedReply: string,
  fallbackReply: string,
  currentUserText: string,
  recentMessages: ChatMessage[] = []
): string {
  if (!cleanedReply.trim()) return fallbackReply;

  const firstLine = cleanedReply
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)[0] || '';

  const casualKind = detectCasualMessageKind(currentUserText);

  // ack（嗯/好/哦/收到等）：必须信任LLM的上下文回复
  if (casualKind === 'ack') {
    // 如果LLM自己生成了通用敷衍句，用fallback
    if (isGenericAckReply(firstLine)) return fallbackReply;
    // 检查重复
    const normalized = firstLine.replace(/\s+/g, '');
    const repeated = recentAssistantTexts(recentMessages).some(text => text.replace(/\s+/g, '') === normalized);
    if (repeated) return fallbackReply;
    return cleanedReply;
  }

  // 其他低信息输入：若LLM回复带问号（在尝试互动），保留；否则过长就fallback
  if (casualKind) {
    const maxLength: Record<CasualMessageKind, number> = {
      availability: 10,
      praise: 16,
      laugh: 18,
      ack: 999,
      emoji: 14,
    };
    // 带问号的回复说明LLM在互动，保留
    if (/[？?]/.test(firstLine)) return cleanedReply;
    // 过长且无互动性，fallback
    if (firstLine.length > maxLength[casualKind]) return fallbackReply;
  }

  // 通用检查：LLM自己敷衍、或重复
  if (isGenericAckReply(firstLine)) return fallbackReply;
  const normalized = firstLine.replace(/\s+/g, '');
  const repeated = recentAssistantTexts(recentMessages).some(text => text.replace(/\s+/g, '') === normalized);
  if (repeated) return fallbackReply;

  return cleanedReply;
}

function isBadChatLine(line: string): boolean {
  const normalized = line.trim();
  if (!normalized) return true;
  if (/^(\.{2,}|…+)/.test(normalized)) return true;
  if (/^(我|你|他|她)[。.!！?？、，,~～…]*$/.test(normalized)) return true;
  if (/^(嗯|啊|哦|呃|额|唔)[？?。.!！]*$/.test(normalized)) return true;
  if (/^(睡着了|睡了吗|醒着吗)[？?。.!！]*$/.test(normalized)) return true;
  if (/^(呼吸声|空气|房间|夜色|灯光)/.test(normalized)) return true;
  if (/^(突然|然后|接着).{0,12}(骂人|沉默|安静|发呆)/.test(normalized)) return true;
  if (/^(红着脸|脸红|心跳|心一动|胸口)/.test(normalized)) return true;
  if (/^(感觉|觉得|似乎|仿佛)/.test(normalized) && normalized.length < 12) return true;
  // 过滤明显的小说/乙游状态句
  if (/^(时间|空间|周围|四周|面前|身后|身后|身旁|身边).{0,8}(安静|沉默|凝固|停滞)/.test(normalized)) return true;
  if (/^(嘴角|眉眼|眼神|目光|眼底|眸中|眸光).{0,8}(弯了|柔了|闪了|暗了|沉了)/.test(normalized)) return true;
  if (/^(指尖|手指|手|掌心|手背).{0,8}(收紧|松开|握紧|颤抖|冰凉|温热)/.test(normalized)) return true;
  return false;
}

/**
 * 按语义拆分成多条消息（模拟微信连发）
 */
function splitReply(text: string): string[] {
  // 先按换行拆
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !isBadChatLine(l)).slice(0, 3);

  if (lines.length >= 2) {
    return lines;
  }

  // 只有一行，尝试按中文句末标点拆分
  const single = lines[0] || text.trim();
  if (single.length <= 15) {
    return [single];
  }

  // 按句号、！、？、～ 拆分，但保留标点
  const parts = single.match(/[^。！？~～!?]+[。！？~～!?]?/g);
  if (parts && parts.length >= 2) {
    // 合并过短的句子
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
      if (merged.length > 0) {
        merged[merged.length - 1] += buffer.trim();
      } else {
        merged.push(buffer.trim());
      }
    }
    if (merged.length >= 2) return merged.filter(line => !isBadChatLine(line)).slice(0, 3);
  }

  return [isBadChatLine(single) ? '我在' : single];
}
