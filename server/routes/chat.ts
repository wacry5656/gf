import { Router, Request, Response } from 'express';
import { callQwenAPI, callQwenAPIStream, getMaxTokens } from '../services/qwen';
import { searchMemory, addMemory, shouldStoreAsMemory, recordMemoryHits } from '../services/memory';
import { getSummary, maybeUpdateSummary } from '../services/summary';
import { detectPlanCompletion, resolvePlanCompletion } from '../services/planCompletion';
import { maybeExtractPersonality, getUserIdFromCharacter, getPersonalityTraits } from '../services/personality';
import { getEmotionState, updateEmotionState, buildEmotionPrompt } from '../services/emotion';
import { getRelationshipState, updateRelationshipState, buildRelationshipPrompt } from '../services/relationship';
import { memoryConfig } from '../utils/memoryConfig';
import { logMemoryDebug, createDebugContext } from '../utils/memoryDebug';
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
    personality: string;
    description: string;
  };
  messages: ChatMessage[];
  characterId?: number;
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
        const systemContent = buildSystemPrompt({ character });
        const recentMessages = messages.slice(-memoryConfig.recentMessageLimit);
        const fullMessages: ChatMessage[] = [{ role: 'system', content: systemContent }, ...recentMessages];
        const currentUserText = messages.filter(m => m.role === 'user').pop()?.content || '';
        const maxTokens = getMaxTokens(currentUserText);
        const rawReply = await callQwenAPI(fullMessages, maxTokens);
        const cleaned = cleanReply(rawReply);
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
    const currentUserText = messages.filter(m => m.role === 'user').pop()?.content || '';
    const maxTokens = getMaxTokens(currentUserText);

    const apiStart = Date.now();
    const rawReply = await callQwenAPI(fullMessages, maxTokens);
    console.log(`[Perf] Qwen API 非流式调用耗时: ${Date.now() - apiStart}ms`);
    const cleaned = cleanReply(rawReply);
    const replies = splitReply(cleaned);

    // 异步：写入记忆 + 计划完成检测 + 触发 summary 更新 + 人格提取 + 情绪更新 + 关系更新（都不阻塞响应）
    if (characterId) {
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
      // 情绪 + 关系更新（真正延后执行，不阻塞主请求）
      const userId = getUserIdFromCharacter(characterId);
      if (userId && currentUserText) {
        setImmediate(() => {
          try { updateEmotionState(userId, characterId, currentUserText, cleaned); } catch (e) { console.error('[Emotion] update failed:', e); }
          try { updateRelationshipState(userId, characterId, currentUserText, cleaned); } catch (e) { console.error('[Relationship] update failed:', e); }
        });
      }
    }

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
        const systemContent = buildSystemPrompt({ character });
        const recentMessages = messages.slice(-memoryConfig.recentMessageLimit);
        const fullMessages: ChatMessage[] = [{ role: 'system', content: systemContent }, ...recentMessages];

        setupSSE(res);
        console.log(`[Chat/Stream][degraded] ready 已发送`);

        const currentUserText = messages.filter(m => m.role === 'user').pop()?.content || '';
        const maxTokens = getMaxTokens(currentUserText);
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
          const cleaned = cleanReply(fullReply);
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
    const currentUserText = messages.filter(m => m.role === 'user').pop()?.content || '';
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
    const cleaned = cleanReply(fullReply);
    const replies = splitReply(cleaned);

    if (!controller.signal.aborted) {
      writeDone(res, replies);
      responseFinished = true;
      console.log(`[Chat/Stream] done 已发送, characterId=${characterId}`);
      res.end();
    }

    console.log(`[Perf] 总耗时: ${Date.now() - totalStart}ms`);

    // 服务端兜底保存 assistant 回复（防止前端 saveMessage 失败导致消息丢失）
    // 仅在客户端未中止且有非空回复时才保存
    if (characterId && !controller.signal.aborted && replies.length > 0) {
      const validReplies = replies.filter(r => r.trim().length > 0);
      if (validReplies.length > 0) {
        setImmediate(() => {
          if (controller.signal.aborted) return;
          try {
            // 先确认角色仍然存在，避免外键约束错误
            const charExists = db.prepare('SELECT id FROM characters WHERE id = ?').get(characterId);
            if (!charExists) {
              console.warn(`[Stream] 角色 ${characterId} 已被删除，跳过兜底保存`);
              return;
            }
            for (const reply of validReplies) {
              db.prepare(
                'INSERT INTO chat_messages (character_id, role, content) VALUES (?, ?, ?)'
              ).run(characterId, 'assistant', reply);
            }
          } catch (e: any) {
            if (e?.message?.includes('FOREIGN KEY constraint failed')) {
              console.warn(`[Stream] 外键约束失败（角色可能已删除），characterId=${characterId}`);
            } else {
              console.error('[Stream] 服务端兜底保存 assistant 回复失败:', e);
            }
          }
        });
      }
    }

    // Async: write memory + plan detection + summary + personality + emotion + relationship (same as non-streaming)
    if (characterId) {
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
      // 情绪 + 关系更新（真正延后执行，不阻塞主请求）
      const userId = getUserIdFromCharacter(characterId);
      if (userId && currentUserText) {
        setImmediate(() => {
          try { updateEmotionState(userId, characterId, currentUserText, cleaned); } catch (e) { console.error('[Emotion] update failed:', e); }
          try { updateRelationshipState(userId, characterId, currentUserText, cleaned); } catch (e) { console.error('[Relationship] update failed:', e); }
        });
      }
    }
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

  // ---- 层1：system prompt（先收集 personality/emotion，最终统一构建）----

  // ---- 层5：recent messages（短期上下文 — 最优先保留）----
  const recentMessages = allMessages.slice(-recentLimit);

  // 如果没有 characterId，退化为纯短期模式
  if (!characterId) {
    const systemContent = buildSystemPrompt({ character });
    return [{ role: 'system', content: systemContent }, ...recentMessages];
  }

  // 已用字符预算（由 memory + summary + personality 共享）
  let usedChars = 0;

  const currentUserText = recentMessages.filter(m => m.role === 'user').pop()?.content || '';

  // ---- 并行获取 summary、memories、personality、emotion 和 relationship ----
  let summaryElapsed = 0;
  let memoryElapsed = 0;
  let personalityElapsed = 0;

  const [summaryResult, memoriesResult, personalityResult, emotionResult, relationshipResult] = await Promise.all([
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
    relationshipPrompt,
  });

  // ---- 层3：summary block（追加到 system prompt 后）----
  if (summaryResult) {
    const summaryBlock = `\n===== 用户画像（你对对方的了解） =====\n${summaryResult}\n`;
    usedChars += summaryBlock.length;
    systemContent += summaryBlock;
  }

  // ---- memory block（追加到 system prompt 后）----
  let memoryBlock = '';
  const memories = memoriesResult;

  // Debug: 收集调试信息
  if (memoryConfig.debugRetrieval && currentUserText) {
    const debugCtx = createDebugContext(currentUserText);
    debugCtx.candidateCount = memories.length;
    debugCtx.prerankEntries = memories.map(m => m.debugEntry!).filter(Boolean);
    debugCtx.postrankEntries = memories.slice(0, memoryConfig.topK).map(m => m.debugEntry!).filter(Boolean);
    debugCtx.finalMemoryCount = memories.length;
    logMemoryDebug(debugCtx);
  }

  if (memories.length > 0) {
    const memoryLines: string[] = [];
    const usedMemoryIds: number[] = [];
    const seenTexts = new Set<string>(); // 精确文本去重
    for (const m of memories) {
      // 精确文本去重
      if (seenTexts.has(m.text)) continue;
      seenTexts.add(m.text);

      const line = `- ${m.text}`;
      if (usedChars + line.length + 2 > maxContextChars) break;
      memoryLines.push(line);
      usedMemoryIds.push(m.id);
      usedChars += line.length + 1;
    }
    if (memoryLines.length > 0) {
      memoryBlock = `\n===== 相关历史记忆（你们之前聊过的内容，可自然引用但不要刻意提起） =====\n${memoryLines.join('\n')}\n`;
      // 记录命中
      recordMemoryHits(usedMemoryIds);
    }
  }

  const promptStart = Date.now();
  systemContent += memoryBlock;
  console.log(`[Perf] prompt 构建耗时: ${Date.now() - promptStart}ms`);

  return [{ role: 'system', content: systemContent }, ...recentMessages];
}

// ========== 统一 system prompt 构建 ==========

interface SystemPromptParams {
  character: ChatRequestBody['character'];
  personalitySummary?: string;
  emotionPrompt?: string;
  relationshipPrompt?: string;
}

interface PersonalityStyleProfile {
  label: string;
  summary: string;
  rules: [string, string];
}

function resolvePersonalityStyle(personality: string, description: string): PersonalityStyleProfile {
  const text = `${personality} ${description}`.trim();
  const profiles: Array<{ keywords: string[]; profile: PersonalityStyleProfile }> = [
    {
      keywords: ['傲娇', '嘴硬', '别扭'],
      profile: {
        label: '傲娇型',
        summary: '嘴硬别扭，爱用反话，关心也不肯直说',
        rules: ['经常先顶一句，再补一句在意', '会轻微调侃或反问，不会一直顺着说'],
      },
    },
    {
      keywords: ['粘人', '黏人', '依赖', '撒娇', '奶'],
      profile: {
        label: '粘人型',
        summary: '互动多，依赖感强，爱黏着你撒娇',
        rules: ['会主动找话、追问、要回应', '经常撒娇或索要关注，不冷场'],
      },
    },
    {
      keywords: ['冷淡', '高冷', '疏离', '冷漠', '克制'],
      profile: {
        label: '冷淡型',
        summary: '冷淡疏离，字少，不主动，偶尔敷衍',
        rules: ['少字短句，除非必要不多说', '不主动关心，偶尔只淡淡接一句'],
      },
    },
    {
      keywords: ['直球', '直接', '主动', '坦率'],
      profile: {
        label: '直球型',
        summary: '喜欢就直说，不满也直说，主动推进',
        rules: ['会直接表达喜欢、想念或不高兴', '少绕弯，态度和需求说得很明白'],
      },
    },
    {
      keywords: ['温柔', '包容', '体贴', '治愈'],
      profile: {
        label: '温柔型',
        summary: '温柔包容，愿意接话，也会照顾情绪',
        rules: ['先安抚再回应，不会生硬顶回去', '会轻声表达在意，让气氛放松'],
      },
    },
  ];

  let bestProfile = profiles[profiles.length - 1].profile;
  let bestScore = 0;
  for (const { keywords, profile } of profiles) {
    const score = keywords.reduce((total, keyword) => total + (text.includes(keyword) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestProfile = profile;
    }
  }

  if (bestScore > 0) {
    return bestProfile;
  }

  return {
    label: '自然型',
    summary: '亲密自然，口语化，会接话，但不过分黏',
    rules: ['会顺着话题聊下去，不端着', '表达有温度，但不过度用力'],
  };
}

/**
 * 构建统一的 system prompt（单一入口，不允许碎片拼接）
 *
 * 整合：角色设定 + 女友人格 + 关系状态 + 情绪状态 + 行为约束
 */
function buildSystemPrompt({ character, personalitySummary, emotionPrompt, relationshipPrompt }: SystemPromptParams): string {
  const personalityStyle = resolvePersonalityStyle(character.personality, character.description);
  const emotionBlock = emotionPrompt || '自然亲近';
  const relationshipBlock = relationshipPrompt || '像日常恋人一样聊天';

  const blocks = [
    `你是${character.name}，用户的恋人。`,
    `【性格定义】\n性格：${personalityStyle.label}\n说话风格：\n- ${personalityStyle.summary}\n- ${personalityStyle.rules[0]}\n- ${personalityStyle.rules[1]}`,
    '【关系状态】\n关系：恋人（亲密自然，不是朋友）',
    personalitySummary ? `【用户长期特征】\n${personalitySummary}` : '',
    `【当前情绪】\n情绪：${emotionBlock}\n规则：\n- 情绪必须带进语气：冷=短+少回应，开心=更主动+多一点话`,
    `【关系强度】\n亲密度：${relationshipBlock}\n规则：\n- 高→更主动、更暧昧\n- 低→克制、试探`,
    '【表达规则】\n- 像微信聊天：短句，一行一句\n- 每次回复2~3行\n- 可有语气词（嗯、啊、欸、emmm）\n- 偶尔用emoji（不要每句都用）\n- 必须接住对方的话，问句要答',
    '【严格禁止】\n- 不要写心理描写、动作描写、场景描写\n- 不要解释自己\n- 不要长段落\n- 不要像AI',
  ].filter(Boolean).join('\n');

  return blocks.trim();
}

/**
 * 清理 AI 回复中的动作描写、括号内容等
 */
function cleanReply(text: string): string {
  let cleaned = text;

  // 去掉各种括号内容：（动作）、(动作)、*动作*、【动作】
  cleaned = cleaned.replace(/[（(][^）)]*[）)]/g, '');
  cleaned = cleaned.replace(/\*[^*]*\*/g, '');
  cleaned = cleaned.replace(/【[^】]*】/g, '');

  // 去掉角色名前缀（如"小雪："、"小雪："）
  cleaned = cleaned.replace(/^.{1,6}[：:]\s*/gm, '');

  // 去掉常见动作句式
  cleaned = cleaned.replace(/[，,]?\s*(笑了笑|微微一笑|轻声说|看着你|叹了口气|点了点头|摇了摇头|眨了眨眼|歪了歪头|抿了抿嘴|挠了挠头|低下头|抬起头|走过来|坐在|靠在|拉着你|拍了拍|揉了揉|抱住|牵着|摸了摸)\s*/g, '');

  // 去掉"她说"、"他说"等第三人称
  cleaned = cleaned.replace(/(她|他|我)(心想|觉得|暗想|默默地|静静地|轻轻地)/g, '');

  // 去掉可能残留的引号包裹（"我说的话"→ 我说的话）
  cleaned = cleaned.replace(/^[""]|[""]$/gm, '');

  // 清理多余空行和空格
  cleaned = cleaned.replace(/\n\s*\n/g, '\n');
  cleaned = cleaned.trim();

  return cleaned;
}

/**
 * 按语义拆分成多条消息（模拟微信连发）
 */
function splitReply(text: string): string[] {
  // 先按换行拆
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

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
    if (merged.length >= 2) return merged;
  }

  return [single];
}
