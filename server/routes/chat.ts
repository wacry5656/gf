import { Router, Request, Response } from 'express';
import { callQwenAPI, callQwenAPIStream, getMaxTokens } from '../services/qwen';
import { searchMemory, addMemory, shouldStoreAsMemory, recordMemoryHits } from '../services/memory';
import { getSummary, maybeUpdateSummary } from '../services/summary';
import { detectPlanCompletion, resolvePlanCompletion } from '../services/planCompletion';
import { maybeExtractPersonality, getUserIdFromCharacter, getPersonalityTraits } from '../services/personality';
import { getEmotionState, updateEmotionState, buildEmotionPrompt } from '../services/emotion';
import { memoryConfig } from '../utils/memoryConfig';
import { logMemoryDebug, createDebugContext } from '../utils/memoryDebug';

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

chatRouter.post('/chat', async (req: Request, res: Response) => {
  const totalStart = Date.now();
  try {
    const { character, messages } = req.body as ChatRequestBody;
    const characterId = req.body.characterId || character?.id;

    if (!character || !messages || !Array.isArray(messages)) {
      res.status(400).json({ error: '请求参数不完整' });
      return;
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

    // 异步：写入记忆 + 计划完成检测 + 触发 summary 更新 + 人格提取 + 情绪更新（都不阻塞响应）
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
      // 情绪更新（fire-and-forget）
      const userId = getUserIdFromCharacter(characterId);
      if (userId && currentUserText) {
        try { updateEmotionState(userId, characterId, currentUserText, cleaned); } catch { /* ignore */ }
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
  try {
    const { character, messages } = req.body as ChatRequestBody;
    const characterId = req.body.characterId || character?.id;

    if (!character || !messages || !Array.isArray(messages)) {
      res.status(400).json({ error: '请求参数不完整' });
      return;
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Abort streaming if client disconnects
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    // 构建四层上下文（已优化为并行获取）
    const contextStart = Date.now();
    const fullMessages = await buildChatContext(character, messages, characterId);
    console.log(`[Perf] 上下文构建耗时: ${Date.now() - contextStart}ms`);

    // 获取用户输入用于动态 max_tokens
    const currentUserText = messages.filter(m => m.role === 'user').pop()?.content || '';
    const maxTokens = getMaxTokens(currentUserText);

    let fullReply = '';
    const apiStart = Date.now();
    try {
      fullReply = await callQwenAPIStream(
        fullMessages,
        (chunk) => {
          if (!controller.signal.aborted) {
            res.write(`data: ${JSON.stringify({ delta: chunk })}\n\n`);
          }
        },
        controller.signal,
        maxTokens
      );
      console.log(`[Perf] Qwen API 流式调用耗时: ${Date.now() - apiStart}ms`);
    } catch (streamErr: any) {
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
      res.write(`data: ${JSON.stringify({ replies })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }

    console.log(`[Perf] 总耗时: ${Date.now() - totalStart}ms`);

    // Async: write memory + plan detection + summary + personality + emotion (same as non-streaming)
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
      // 情绪更新（fire-and-forget）
      const userId = getUserIdFromCharacter(characterId);
      if (userId && currentUserText) {
        try { updateEmotionState(userId, characterId, currentUserText, cleaned); } catch { /* ignore */ }
      }
    }
  } catch (err: any) {
    console.error('Chat stream error:', err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: '服务器内部错误，请稍后重试' });
    } else {
      try {
        res.write(`data: ${JSON.stringify({ error: '服务器内部错误' })}\n\n`);
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

  // ---- 层1：system prompt ----
  let systemContent = buildSystemPrompt(character);

  // ---- 层5：recent messages（短期上下文 — 最优先保留）----
  const recentMessages = allMessages.slice(-recentLimit);

  // 如果没有 characterId，退化为纯短期模式
  if (!characterId) {
    return [{ role: 'system', content: systemContent }, ...recentMessages];
  }

  // 已用字符预算（由 memory + summary + personality 共享）
  let usedChars = 0;

  const currentUserText = recentMessages.filter(m => m.role === 'user').pop()?.content || '';

  // ---- 并行获取 summary、memories、personality 和 emotion ----
  let summaryElapsed = 0;
  let memoryElapsed = 0;
  let personalityElapsed = 0;

  const [summaryResult, memoriesResult, personalityResult, emotionResult] = await Promise.all([
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
  ]);

  console.log(`[Perf] 获取 summary 耗时: ${summaryElapsed}ms`);
  console.log(`[Perf] 获取 memories 耗时: ${memoryElapsed}ms`);
  console.log(`[Perf] 获取 personality 耗时: ${personalityElapsed}ms`);

  // ---- 层2：personality block（在 summary/memory 之前）----
  let personalityBlock = '';
  if (personalityResult.length > 0) {
    const lines = personalityResult.map((t) => `- ${t.value}`);
    personalityBlock = `\n===== 用户长期特征 =====\n${lines.join('\n')}\n`;
    usedChars += personalityBlock.length;
  }

  // ---- 层3：summary block ----
  let summaryBlock = '';
  if (summaryResult) {
    summaryBlock = `\n===== 用户画像（你对对方的了解） =====\n${summaryResult}\n`;
    usedChars += summaryBlock.length;
  }

  // ---- 层4：memory block ----
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

  // ---- emotion block ----
  let emotionBlock = '';
  if (emotionResult) {
    emotionBlock = `\n【当前情绪状态】\n${buildEmotionPrompt(emotionResult)}\n`;
  }

  const promptStart = Date.now();
  systemContent += personalityBlock + summaryBlock + memoryBlock + emotionBlock;
  console.log(`[Perf] prompt 构建耗时: ${Date.now() - promptStart}ms`);

  return [{ role: 'system', content: systemContent }, ...recentMessages];
}

function buildSystemPrompt(character: ChatRequestBody['character']): string {
  const genderText = character.gender === 'female' ? '女性' : character.gender === 'male' ? '男性' : character.gender;
  return `你叫${character.name}，${genderText}，性格${character.personality}。${character.description}。

【重要】你是对方的恋人/女友，你们正在微信上私聊。你自然地表达亲密感，但不刻意强调身份。不是角色扮演，不是写小说，不是演剧本。

===== 核心对话逻辑（每次回复前必须隐式执行） =====

第一步：判断用户意图（从以下选一个）：
- 调侃 / 开玩笑
- 试探关系 / 暧昧
- 表达情绪（开心、难过、烦躁、无聊等）
- 提问 / 求助
- 普通闲聊
- 撒娇 / 求关注

第二步：根据你的性格，选择一种回应策略：
- 调侃式回应：用轻松幽默的方式接住对方的话
- 傲娇式回避：嘴上说不在乎，语气暴露真实想法
- 认真回应：正面回答，表达关心或态度
- 反问引导：用反问把话题往深处带，或把球踢回去
- 转移话题：自然地岔开，但不能生硬

第三步：回复必须满足：
- 和用户上一句话强相关，不准跳话题
- 必须"接住"对方的话，有来有回
- 回复要有明确意图（安慰/反击/好奇/附和），不能是随机拼凑的句子
- 如果用户问了问题，必须回应这个问题，不能忽略

===== 严格禁止 =====

格式禁止：
- 动作描写：笑了笑、看着你、叹了口气、微微一笑、轻声说、点了点头
- 括号内容：（微笑）（沉默）*抱住你* 【温柔地】
- 心理描写：她心想、内心觉得、心里暗暗
- 场景描写：阳光洒进来、房间里安静、微风吹过
- 第三人称叙述：她说、他回答
- 任何文学性修饰

逻辑禁止：
- 逻辑跳跃（上句聊A，你突然聊B）
- 忽略用户问题（用户问了什么你必须回应）
- 自我否定："我不知道怎么说""我不确定"
- 暴露AI状态："我卡住了""不知道说什么""作为AI"
- 空洞回复："是呢""对呀""嗯嗯"然后就没了——必须有下文或有态度

===== 回复格式 =====
1. 像真人在微信打字，短句为主，口语化
2. 用换行分成2~3条消息（像微信连发几条那样），每条一行
3. 语气自然，可以用语气词（嗯、哈哈、好呀、啊这、emmm、哦哦）
4. 情绪用说的话表达，不要用描写表达
5. 大多数时候简短回复，需要的时候可以稍微多说一点，但不要大段文字
6. 可以偶尔用 emoji，但不要每句都用

===== 示例 =====

用户：想我了吗
（意图：试探关系）
策略-傲娇：
谁会想你啊
你是不是太自恋了
策略-温柔：
有一点吧
你呢？
策略-调侃：
你先说你有没有想我

用户：你在干嘛
（意图：普通闲聊）
刚在发呆
有点无聊

用户：今天有点累
（意图：表达情绪-疲惫）
辛苦了
早点休息会好点

用户：我有点烦
（意图：表达情绪-烦躁）
咋了
说来听听

用户：你喜欢我吗
（意图：试探关系）
策略-反问：
你觉得呢
策略-傲娇：
想什么呢
才不会告诉你

用户：我今天被骂了
（意图：表达情绪-委屈）
策略-认真：
怎么回事
谁骂你了

请严格按照以上逻辑和风格回复，每条消息占一行，不要加"${character.name}："前缀，不要输出意图判断和策略选择的过程。`;
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
