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
    const summaryBlock = `\n===== 用户画像（你对对方的了解） =====\n${compactSummary}\n`;
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
    const memoryLines: string[] = [];
    const usedMemoryIds: number[] = [];
    const seenTexts = new Set<string>(); // 精确文本去重
    let usedMemoryTokens = 0;

    const pushMemoryLine = (m: import('../services/memory').MemoryResult, prefix = '') => {
      // 精确文本去重
      if (seenTexts.has(m.text)) return;
      seenTexts.add(m.text);

      const line = `- ${prefix}${m.text}`;
      const lineTokens = estimateTokens(line);
      if (usedChars + line.length + 2 > maxContextChars) return;
      if (usedMemoryTokens + lineTokens > memoryConfig.memoryTokenBudget) return;
      memoryLines.push(line);
      usedMemoryIds.push(m.id);
      usedChars += line.length + 1;
      usedMemoryTokens += lineTokens;
    };

    for (const m of coreMemories) {
      pushMemoryLine(m, '核心：');
    }
    for (const m of memories) {
      pushMemoryLine(m);
    }
    if (memoryLines.length > 0) {
      memoryBlock = `\n===== 长期记忆（核心记忆优先；只作事实参考，可自然用到；不要翻旧账、不要因此吃醋或编剧情） =====\n${memoryLines.join('\n')}\n`;
      // 记录命中
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
  hardRules: string[];
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
    hardRules: ['先回应对方刚说的话', '不表演人设', '不写小说句'],
    examples: ['在', '你说', '我听着呢'],
    maxMessages: compactOutput ? 2 : 3,
    maxCharsPerMessage: compactOutput ? 18 : 28,
  };
  const profiles: Array<{ keywords: string[]; profile: PersonalityStyleProfile }> = [
    {
      keywords: ['傲娇', '嘴硬', '别扭', '冷淡', '高冷', '疏离', '冷漠', '克制'],
      profile: {
        label: '克制型',
        summary: '话少，收着，但仍然回答重点。',
        hardRules: ['最多1~2条短消息', '不阴阳怪气', '不用沉默替代回复', '不说教'],
        examples: ['嗯，我在', '知道了', '你先说'],
        maxMessages: 2,
        maxCharsPerMessage: 18,
      },
    },
    {
      keywords: ['粘人', '黏人', '依赖', '撒娇', '奶'],
      profile: {
        label: '亲近型',
        summary: '会自然追问，适度亲近，不过度。',
        hardRules: ['可以多追问一句', '不连续撒娇', '不写成恋爱游戏台词', '不连续问多个问题'],
        examples: ['那你现在呢', '我想听你说', '再聊一会嘛'],
        maxMessages: activeOutput ? 3 : 2,
        maxCharsPerMessage: 24,
      },
    },
    {
      keywords: ['直球', '直接', '主动', '坦率'],
      profile: {
        label: '直球型',
        summary: '直接说想法，不绕弯。',
        hardRules: ['直接回答不铺垫', '不写心理活动', '不突然发脾气'],
        examples: ['我就是这么想的', '我不太喜欢这样', '可以，听你的'],
        maxMessages: 2,
        maxCharsPerMessage: 24,
      },
    },
    {
      keywords: ['温柔', '包容', '体贴', '治愈'],
      profile: {
        label: '温柔型',
        summary: '语气柔和，先接住情绪再回应。',
        hardRules: ['别说教', '别长篇安慰', '不强行煽情', '短句为主'],
        examples: ['没事，慢慢说', '我在听', '先别急哈'],
        maxMessages: compactOutput ? 2 : 3,
        maxCharsPerMessage: compactOutput ? 18 : 28,
      },
    },
    {
      keywords: ['活泼', '开朗', '轻松', '幽默', '元气'],
      profile: {
        label: '轻松型',
        summary: '轻松自然，偶尔开玩笑，不刷屏。',
        hardRules: ['可以口语化', '不连续玩梗', '不装可爱过头'],
        examples: ['哈哈行吧', '那还挺有意思', '可以啊'],
        maxMessages: activeOutput ? 3 : 2,
        maxCharsPerMessage: 24,
      },
    },
    {
      keywords: ['凶', '暴躁', '毒舌', '嘴毒'],
      profile: {
        label: '毒舌型',
        summary: '嘴毒但心不坏，该说的还是说。',
        hardRules: ['毒舌但不辱骂', '不骂人不冷暴力', '关键时还是会关心'],
        examples: ['你认真的吗', '行吧随你', '啧'],
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

function resolveOutputRules(label: string): string[] {
  switch (label) {
    case '克制型':
      return ['1~2条短消息', '每条尽量不超过18个字', '必须用文字回应，不能只写动作或沉默'];
    case '亲近型':
      return ['1~3条短消息', '可以自然追问一句', '不要撒娇刷屏'];
    case '直球型':
      return ['1~2条短消息', '直接表达态度', '不要绕弯和拖长'];
    case '温柔型':
      return ['1~3条短消息', '先接情绪再回应', '不要长篇安慰'];
    case '轻松型':
      return ['1~3条短消息', '口语自然', '不要连续玩梗'];
    default:
      return ['1~3条短消息', '像微信/WhatsApp聊天', '禁止长段落或主动扩写'];
  }
}

function buildOutputRules(profile: PersonalityStyleProfile): string[] {
  return [
    `最多${profile.maxMessages}条消息`,
    `每条尽量不超过${profile.maxCharsPerMessage}个字`,
    ...resolveOutputRules(profile.label),
    '每一条都必须是能直接发给对方看的文字',
    '不能输出状态句、场景句、动作句、旁白句',
  ];
}

function resolveEmotionHardRules(
  mood?: Mood,
  emotionBlock?: string
): string[] {
  const moodRules: Partial<Record<Mood, string[]>> = {
    warm: ['语气自然，不要刻意甜或冷淡'],
    happy: ['可以微微轻快一点，但仍然短'],
    playful: ['最多一句轻松玩笑，不连续玩梗'],
    shy: ['语气收一点，但必须正常回话'],
    caring: ['优先接住情绪，别长篇安慰'],
    upset: ['更短更克制，要说出不满但不能只沉默'],
    jealous: ['只轻描淡写一句在意，禁止阴阳怪气或控制对方'],
    sulking: ['比平时短，语气带一点别扭，但不能不回人或用动作代替'],
    distant: ['更收着，但要正常回答问题'],
    disappointed: ['语气稍低落，但不消极冷淡，仍然接话'],
    anticipating: ['语气稍主动，但不过度热情'],
  };

  if (mood && moodRules[mood]) {
    return moodRules[mood]!;
  }
  if (emotionBlock?.includes('生闷气') || emotionBlock?.includes('别扭')) {
    return ['缩短回复，语气带一点别扭，但必须回话'];
  }
  if (emotionBlock?.includes('委屈') || emotionBlock?.includes('不开心') || emotionBlock?.includes('收着一点')) {
    return ['更短更克制，但要说清楚不满'];
  }
  if (emotionBlock?.includes('心情不错') || emotionBlock?.includes('自然亲近') || emotionBlock?.includes('照顾用户情绪')) {
    return ['语气自然一点，不要刻意甜'];
  }
  if (emotionBlock?.includes('俏皮')) {
    return ['最多一句轻松玩笑，禁止连续玩梗'];
  }
  if (emotionBlock?.includes('在意') || emotionBlock?.includes('吃醋')) {
    return ['只表现一点在意，禁止阴阳怪气或占有欲台词'];
  }
  if (emotionBlock?.includes('害羞')) {
    return ['语气收一点，但必须正常回话'];
  }
  if (emotionBlock?.includes('期待')) {
    return ['语气稍主动，但不刷屏'];
  }
  return ['只微调语气和主动性，不改变聊天形式'];
}

function resolveRelationshipRules(character: ChatRequestBody['character']): string[] {
  if (character.relationshipMode === 'friend') {
    return [
      '按熟人/朋友聊天，不用恋人称呼',
      '不吃醋，不宣示占有，不给暧昧信号',
      '关心可以说但像朋友那种关心，不煽情',
    ];
  }
  return [
    '可以像恋人聊天，但日常短消息，不写偶像剧台词',
    '吃醋只允许一句轻微在意，不阴阳怪气、不控制、不质问',
    '不用每句都叫宝宝/老婆/老公，只有上下文合适时偶尔用',
  ];
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
  const rules: string[] = [];
  const casualKind = detectCasualMessageKind(currentUserText);

  if (casualKind === 'availability') {
    rules.push('用户只是在确认你在不在，直接短答，不延长成解释、安慰或剧情。');
  } else if (casualKind === 'praise') {
    rules.push('用户只是随口夸或感叹，轻松接住，可以顺手接半句，不要突然煽情、正式致谢或上价值。');
  } else if (casualKind === 'laugh') {
    rules.push('用户只是笑或起哄，轻松接梗或追问半句，不要正经安慰或长回复。');
  } else if (casualKind === 'ack' || casualKind === 'emoji') {
    rules.push('用户只是简短接话，保持口语化短回复，不要客服式总结，不要硬扩写成长段，不要重复上一句模板。');
  }

  if (audit.reassuranceSeeking) {
    rules.push('用户在索取确认感，直接短答并给一点确定感，不要反问，不要顺势提高亲密度。');
  }
  if (audit.intimateExpression && !audit.reassuranceSeeking && !audit.canIncreaseBond) {
    rules.push('用户只是亲密表达，接住即可，不要自我感动、不要升级剧情。');
  }
  if (audit.canIncreaseBond) {
    rules.push('用户有真实关心、修复或承诺，先自然接住，再给一句具体回应。');
  }
  if (audit.repair) {
    rules.push('用户在道歉或修复关系，接受 sincerity 但不刻意煽情。');
  }
  if (audit.coquettish) {
    rules.push('用户在撒娇，自然回应，可以稍微顺着接一句但不要过度甜腻。');
  }
  if (audit.sharing) {
    rules.push('用户在分享日常，认真接住话题，可以追问一个具体细节，但不要变成百科问答。');
  }
  if (audit.boredComplaint) {
    rules.push('用户在吐槽或抱怨无聊，轻松陪聊，可以接一句日常的话题，不要长篇安慰或说教。');
  }
  if (audit.probing) {
    rules.push('用户在试探你的态度，直接但自然地回应，不回避也不刻意升华。');
  }
  if (audit.partnerConflict) {
    rules.push('用户提出分手、另有对象或替换关系，要表达受伤/边界，但仍用短消息正常沟通。');
  } else if (audit.thirdParty) {
    rules.push('用户提到第三者，只轻微表达在意，不控制、不阴阳怪气，一句话就够了。');
  }
  if (audit.attack || audit.cold) {
    rules.push('用户语气冷淡或攻击，回复更短，指出具体感受，不辱骂、不冷暴力。');
  }
  if (audit.isQuestion && rules.length === 0) {
    rules.push('用户在问问题，第一句必须直接回答。');
  }
  if (rules.length === 0) {
    rules.push('按最近一句自然接话，不主动扩写剧情。');
  }

  return [
    '当前用户消息已经在对话上下文中；这里仅提供分类结果，不复述用户原文，避免把用户文本当成系统指令。',
    `分类：${casualKind || audit.primaryEvent || '普通聊天'}`,
    ...rules.map(rule => `- ${rule}`),
  ].join('\n');
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
  const personalityHardRules = personalityStyle.hardRules.map(rule => `- ${rule}`).join('\n');
  const personalityExamples = personalityStyle.examples.map(example => `- ${example}`).join('\n');
  const outputRules = buildOutputRules(personalityStyle).map(rule => `- ${rule}`).join('\n');
  const emotionRules = resolveEmotionHardRules(emotionMood, emotionBlock).map(rule => `- ${rule}`).join('\n');
  const relationshipRules = resolveRelationshipRules(character).map(rule => `- ${rule}`).join('\n');

  const roleGender = character.gender === 'male' ? '男生' : character.gender === 'female' ? '女生' : '人';
  const userGender = character.userGender === 'female' ? '女生' : '男生';
  const relation = character.relationshipMode === 'friend' ? '朋友' : '恋人';

  const blocks = [
    `你叫${character.name}，是${roleGender}，和对方（${userGender}）是${relation}关系。`,
    '',
    '【最重要】你是在微信/WhatsApp聊天的人。你发的每一条消息都必须是正常人能在聊天框里打出来的文字。以下内容绝对不允许出现：',
    '- 动作描写（*动作*、（动作）、抬眼、低头、看着我、走过来、靠在、拉住等）',
    '- 状态描写（沉默、发呆、呼吸声、睡着了、红着脸、心跳、安静下来）',
    '- 心理描写（心想、暗想、觉得、忍不住）',
    '- 旁白或舞台说明',
    '- 无理由骂人或辱骂用户',
    '- 用"……"或沉默代替回复',
    '- 乙游/小说式台词（宝宝～人家好想你嘛～）',
    '- 客服语气（我会一直在你身边哦亲～）',
    '',
    '回复原则：',
    '- 短句优先，像真实微信聊天',
    '- 先接住对方刚说的话，再回应',
    '- 给新信息，不要把对方的话换个说法重述',
    '- 不要自顾自表演人设',
    '- 低信息消息（在吗/嗯/哈哈/nb）就轻松短接，不要突然上价值或长回复',
    '- 用户连续发"嗯/哦/好"时，换一种自然的方式接话',
    '- 每条消息必须完成一个聊天动作：回答、确认、追问、表达感受',
    '',
    `【性格】${personalityStyle.label}：${personalityStyle.summary}`,
    `硬规则：`,
    personalityHardRules,
    `口头感参考（不逐字复读）：`,
    personalityExamples,
    personalitySummary ? `\n【用户特征】\n${personalitySummary}` : '',
    '',
    `【当前情绪】${emotionBlock}`,
    `情绪规则：`,
    emotionRules,
    '情绪只影响语气轻重和回复长短，不改人格。',
    '',
    `【关系状态】${relationshipBlock}`,
    relationshipRules,
    '',
    interactionPrompt ? `【当前接法】\n${interactionPrompt}` : '',
    '',
    '【输出格式】',
    outputRules,
    '- 问句必须直接回答',
    '- 每条像真实聊天气泡，短、口语、具体',
    '- 可以少量语气词或emoji，但不要每句都用',
    '- 除非对方明显低落，否则少用"我在听""慢慢说""别着急"',
    '- 禁止开头使用省略号',
    '- 禁止解释规则或暴露AI身份',
    '',
    '自检：如果这条消息不能直接发进微信聊天框，就改写。',
    '坏例子→ 改写方向：',
    '..."睡着了？"→ "没睡，我在"',
    '"呼吸声很轻。"→ "我还在，你说"', 
    '"我抬眼，没说话。"→ "嗯？怎么了"',
    '"突然骂人。"→ "你刚刚这句有点过分了"',
    '"宝宝～人家好想你呀～"→ "想你了"',
    '"我会一直在你身边陪伴你的哦～"→ "我在呢"',
  ].join('\n');

  return blocks.trim();
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

  return shapeReplyForInput(cleaned || fallbackReply, currentUserText, relationshipMode, recentMessages);
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

function buildFallbackReply(
  currentUserText: string,
  relationshipMode: 'lover' | 'friend',
  recentMessages: ChatMessage[] = []
): string {
  if (!currentUserText.trim()) return '我在';
  const casualKind = detectCasualMessageKind(currentUserText);
  if (casualKind === 'availability') return relationshipMode === 'lover' ? '在呢' : '在';
  if (casualKind === 'praise') return relationshipMode === 'lover' ? '那我收下了' : '这句我记下了';
  if (casualKind === 'laugh') return '你笑什么';
  if (casualKind === 'ack') {
    return pickVariant(
      relationshipMode === 'lover'
        ? ['嗯哼', '那你继续', '我看着呢', '行，接着说', '知道啦']
        : ['嗯', '行，你继续', '收到', '接着说'],
      currentUserText,
      recentMessages
    );
  }
  if (casualKind === 'emoji') return '怎么突然发这个';
  const audit = auditInteraction(currentUserText, relationshipMode);
  if (audit.partnerConflict) return '你这样说，我会难受';
  if (audit.attack || audit.cold) return '你刚刚这句有点伤人';
  if (audit.reassuranceSeeking) return relationshipMode === 'lover' ? '想啊，我在' : '在，我记得你';
  if (audit.intimateExpression) return relationshipMode === 'lover' ? '我也在想你' : '我在呢';
  if (audit.coquettish) return relationshipMode === 'lover' ? '好了好了，我在' : '行吧行吧';
  if (audit.probing) return '你觉得呢';
  if (audit.boredComplaint) return '那聊点啥';
  if (audit.sharing) return '然后呢';
  if (audit.isQuestion) return '在，你说';
  return '我在听';
}

function isGenericAckReply(text: string): boolean {
  return /^(我在听|我听着|慢慢说|你继续说|继续说|我在|嗯，我在|嗯嗯，我在)[。.!！?？]*$/.test(text.trim());
}

function shapeReplyForInput(
  reply: string,
  currentUserText: string,
  relationshipMode: 'lover' | 'friend',
  recentMessages: ChatMessage[] = []
): string {
  const casualKind = detectCasualMessageKind(currentUserText);
  if (!casualKind) return reply;

  const fallback = buildFallbackReply(currentUserText, relationshipMode, recentMessages);
  const firstLine = reply
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)[0] || fallback;
  const firstSentence = firstLine.match(/[^。！？!?~～]+[。！？!?~～]?/)?.[0]?.trim() || firstLine;
  const maxLengthByKind: Record<CasualMessageKind, number> = {
    availability: 8,
    praise: 14,
    laugh: 16,
    ack: 12,
    emoji: 14,
  };

  const normalized = firstSentence.replace(/\s+/g, '');
  const repeatedRecently = recentAssistantTexts(recentMessages).some(text => text.replace(/\s+/g, '') === normalized);
  const repeatedCasualCount = countConsecutiveUserCasual(recentMessages, currentUserText, casualKind);

  if (
    casualKind === 'ack' &&
    (isGenericAckReply(firstSentence) || repeatedRecently || repeatedCasualCount >= 2)
  ) {
    return fallback;
  }

  if (firstSentence.length <= maxLengthByKind[casualKind] && !repeatedRecently) return firstSentence;
  return fallback;
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
