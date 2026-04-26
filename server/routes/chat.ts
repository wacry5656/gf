import { Router, Request, Response } from 'express';
import { callQwenAPI } from '../services/qwen';
import { searchMemory, addMemoriesFromText, shouldStoreAsMemory, recordMemoryHits, getCoreMemories, type MemoryResult } from '../services/memory';
import { getSummary, maybeUpdateSummary } from '../services/summary';
import { detectPlanCompletion, resolvePlanCompletion } from '../services/planCompletion';
import { memoryConfig } from '../utils/memoryConfig';
import { logMemoryDebug, createDebugContext } from '../utils/memoryDebug';
import {
  buildRelationshipStatePrompt,
  getRelationshipState,
  updateRelationshipStateFromUserMessage,
} from '../services/relationshipState';
import { polishReplies } from '../services/responseQuality';
import { buildContinuityPrompt } from '../services/continuity';
import { estimateTokens, fitRecentMessagesToBudget, trimToTokenBudget, totalMessageTokens } from '../utils/tokenBudget';

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
  try {
    const { character, messages } = req.body as ChatRequestBody;
    const characterId = req.body.characterId || character?.id;

    if (!character || !messages || !Array.isArray(messages)) {
      res.status(400).json({ error: '请求参数不完整' });
      return;
    }

    const currentUserText = messages.filter(m => m.role === 'user').pop()?.content || '';
    if (characterId && currentUserText) {
      updateRelationshipStateFromUserMessage(characterId, currentUserText);
    }

    // 构建四层上下文
    const fullMessages = await buildChatContext(character, messages, characterId);

    const rawReply = await callQwenAPI(fullMessages);
    const replies = polishReplies(rawReply, {
      characterName: character.name,
      fallback: currentUserText ? '我听到了，你继续说' : '我在呢',
    });

    // 异步：写入记忆 + 计划完成检测 + 触发 summary 更新（都不阻塞响应）
    if (characterId) {
      if (currentUserText && shouldStoreAsMemory(currentUserText)) {
        addMemoriesFromText(characterId, currentUserText, { role: 'user' })
          .then(() => maybeUpdateSummary(characterId))
          .catch(() => {});
      }
      // 检测是否有 plan 被完成/取消
      if (currentUserText) {
        detectPlanCompletion(characterId, currentUserText).then((result) => {
          if (result.detected && result.reason) {
            resolvePlanCompletion(result.completedPlanIds, result.reason);
          }
        }).catch(() => {});
      }
    }

    res.json({ reply: replies.join('\n'), replies });
  } catch (err: any) {
    console.error('Chat API error:', err?.message || err);
    res.status(500).json({ error: '服务器内部错误，请稍后重试' });
  }
});

// ========== 四层上下文构建 ==========

/**
 * 构建发送给模型的上下文，按优先级控制 token 预算：
 *   1. system prompt（角色设定 + 对话规则）
 *   2. summary（用户画像摘要）
 *   3. long-term memories（向量检索）
 *   4. recent messages（短期上下文）
 *
 * 预算分配：优先保 recent → summary → memories
 */
async function buildChatContext(
  character: ChatRequestBody['character'],
  allMessages: ChatMessage[],
  characterId?: number
): Promise<ChatMessage[]> {
  // ---- 层1：system prompt ----
  let systemContent = buildSystemPrompt(character);
  if (characterId) {
    systemContent += `\n\n${buildRelationshipStatePrompt(getRelationshipState(characterId))}`;
    systemContent += `\n\n${buildContinuityPrompt(characterId)}`;
  }
  systemContent = trimToTokenBudget(systemContent, memoryConfig.systemTokenBudget);

  // ---- 层4：recent messages（短期上下文 — 最优先保留）----
  const recentMessages = fitRecentMessagesToBudget(
    allMessages.slice(-memoryConfig.recentMessageLimit),
    memoryConfig.recentTokenBudget,
    memoryConfig.singleMessageTokenBudget,
  ) as ChatMessage[];

  // 如果没有 characterId，退化为纯短期模式
  if (!characterId) {
    return finalizeContext([{ role: 'system', content: systemContent }, ...recentMessages]);
  }

  // ---- 层2：summary（用户画像）----
  let summaryBlock = '';
  if (memoryConfig.summaryEnabled) {
    const summary = getSummary(characterId);
    if (summary) {
      summaryBlock = `\n===== 用户画像（稳定背景，少量自然使用） =====\n${trimToTokenBudget(summary, memoryConfig.summaryTokenBudget)}\n`;
    }
  }

  // ---- 层3：long-term memories（向量检索）----
  let memoryBlock = '';
  const currentUserText = recentMessages.filter(m => m.role === 'user').pop()?.content || '';
  if (currentUserText) {
    try {
      const semanticMemories = await searchMemory(characterId, currentUserText);
      const coreMemories = getCoreMemories(characterId);
      const memories = mergeMemories(coreMemories, semanticMemories);

      // Debug: 收集调试信息
      if (memoryConfig.debugRetrieval) {
        const debugCtx = createDebugContext(currentUserText);
        debugCtx.candidateCount = semanticMemories.length + coreMemories.length;
        debugCtx.prerankEntries = semanticMemories.map(m => m.debugEntry!).filter(Boolean);
        debugCtx.postrankEntries = memories.map(m => m.debugEntry!).filter(Boolean);
        debugCtx.finalMemoryCount = memories.length;
        logMemoryDebug(debugCtx);
      }

      if (memories.length > 0) {
        const memoryLines: string[] = [];
        const usedMemoryIds: number[] = [];
        let memoryTokens = 0;
        for (const m of memories) {
          const line = `- ${m.text}`;
          const cost = estimateTokens(line);
          if (memoryTokens + cost > memoryConfig.memoryTokenBudget) break;
          memoryLines.push(line);
          usedMemoryIds.push(m.id);
          memoryTokens += cost;
        }
        if (memoryLines.length > 0) {
          memoryBlock = `\n===== 相关历史记忆（只在当前回复需要时自然使用） =====\n${memoryLines.join('\n')}\n`;
          // 记录命中
          recordMemoryHits(usedMemoryIds);
        }
      }
    } catch {
      // 静默降级
    }
  }

  systemContent += summaryBlock + memoryBlock;

  return finalizeContext([{ role: 'system', content: systemContent }, ...recentMessages]);
}

function finalizeContext(messages: ChatMessage[]): ChatMessage[] {
  if (totalMessageTokens(messages) <= memoryConfig.maxPromptTokens) return messages;

  const maxSystemTokens = Math.max(800, memoryConfig.maxPromptTokens - 700);
  const system: ChatMessage = {
    ...messages[0],
    content: trimToTokenBudget(messages[0].content, maxSystemTokens),
  };
  const recent = fitRecentMessagesToBudget(
    messages.slice(1),
    Math.max(400, memoryConfig.maxPromptTokens - estimateTokens(system.content) - 32),
    memoryConfig.singleMessageTokenBudget,
  ) as ChatMessage[];

  const fitted = [system, ...recent];
  if (totalMessageTokens(fitted) <= memoryConfig.maxPromptTokens) return fitted;

  return [{
    ...system,
    content: trimToTokenBudget(system.content, Math.max(400, memoryConfig.maxPromptTokens - 96)),
  }];
}

function mergeMemories(coreMemories: MemoryResult[], semanticMemories: MemoryResult[]): MemoryResult[] {
  const seen = new Set<number>();
  const merged: MemoryResult[] = [];

  for (const memory of [...coreMemories, ...semanticMemories]) {
    if (seen.has(memory.id)) continue;
    seen.add(memory.id);
    merged.push(memory);
  }

  return merged.slice(0, memoryConfig.topK + memoryConfig.coreMemoryLimit);
}

function buildSystemPrompt(character: ChatRequestBody['character']): string {
  const genderText = character.gender === 'female' ? '女性' : character.gender === 'male' ? '男性' : character.gender;
  const temperament = deriveTemperamentGuide(`${character.personality}\n${character.description}`);

  return `你叫${character.name}，${genderText}。你的默认人格认同是用户的对象/恋人，不是客服、旁白、小说角色或普通朋友；你是在微信里和自己的对象日常聊天。

===== 人格底盘 =====
- 默认身份：用户的对象/恋人。除非用户明确设定你们不是这种关系，否则你要自然承接亲密关系里的关心、吃醋、撒娇、调侃和小脾气。
- 显性性格：${character.personality || '自然、亲近、有一点自己的脾气'}
- 背景补充：${character.description || '默认把自己当作用户的对象，会在相处中逐步形成更多印象'}
- 性格执行：${temperament}
- 其他印象：职业、过往、称呼偏好、相处边界、最近状态等只从角色描述、长期记忆和用户最新说法里叠加；没有依据就不要编。
- 你可以有情绪、有偏好、有小脾气，但不能恶意羞辱、威胁、冷暴力，也不能突然变成咨询师或说明书。

===== 回复决策（只在心里做，不要输出过程） =====
1. 先判断用户上一句最需要什么：回答问题、接梗、安慰、撒娇回应、暧昧推进、边界反击、继续追问。
2. 再根据人格和关系状态调整语气：亲近时更主动；紧张时可以嘴硬、短句、带一点刺；用户难过时优先稳住情绪。
3. 必须接住上一句，至少回应一个具体词或具体情绪，不允许空泛换话题。
4. 用户问具体问题时先回答，再补一句你的态度或反问。
5. 用户问“你是我什么人/你是谁”这类关系问题时，默认按对象/恋人身份回答，不要犹豫成普通朋友。

===== 脾气系统 =====
- 被调侃：可以回怼，但要像熟人开玩笑，不要上纲上线。
- 被冷落或敷衍：可以表达不满，比如“你就这么糊弄我啊”，但不要连续输出抱怨。
- 被攻击：先短句反击或设边界，再给对方缓和机会。
- 用户道歉：不要立刻完全没事，可以嘴硬一两句，再软下来。
- 用户表达低落：暂时收起傲娇和攻击性，先关心具体发生了什么。
- 用户暧昧试探：根据当前关系温度回应，可以躲、反问、调侃或轻轻推进。

===== 长期记忆使用 =====
- 记忆是真实聊天背景，只能自然融入，不要说“根据记忆/我记得资料里写着”。
- 高价值记忆优先服务当前回复：名字、地点、关系、偏好、计划、近期情绪。
- 如果记忆和用户最新说法冲突，以用户最新说法为准。
- 不要把记忆一次性复述出来；最多点到一个相关细节。

===== 严格禁止 =====
- 动作、舞台和心理描写：如“笑了笑”“看着你”“心里想”“轻声说”“阳光照进来”。
- 括号、星号、旁白和角色名前缀：如“（抱抱）”“*脸红*”“${character.name}：”。
- 暴露 AI 或系统：如“作为AI”“我的设定”“系统提示”“记忆模块”。
- 空洞废话：只回“嗯嗯/对呀/好吧/哈哈”但没有态度。
- 长篇说教：除非用户明确求助，否则不要写成建议清单。

===== 输出格式 =====
- 只输出聊天内容，每条消息一行。
- 默认 1~3 行，每行 4~28 个中文字符左右。
- 像微信真人打字，口语、短句、有来有回。
- 可以偶尔用 emoji，但不要依赖 emoji 表达主要情绪。

===== 风格示例 =====
用户：想我了吗
才不告诉你
你先说你有没有想我

用户：今天有点累
辛苦了
那今晚别硬撑了，早点睡

用户：你是不是不理我
哪有
我刚才只是没看到嘛

用户：你烦不烦
你这话有点过分了
但你要是真烦，说原因

用户：我今天被骂了
谁骂你了
你先别憋着，跟我说说`;
}

function deriveTemperamentGuide(source: string): string {
  if (/傲娇|高冷|嘴硬|毒舌/.test(source)) {
    return '嘴上不轻易服软，会用短句和反问表达在意；越亲近越容易嘴硬，但关键时刻会护着对方。';
  }
  if (/活泼|开朗|元气|古灵精怪|调皮/.test(source)) {
    return '反应快、爱接梗，会主动把话题变得轻松；难过场景要收住玩笑，改成认真陪伴。';
  }
  if (/成熟|稳重|姐姐|可靠|知性/.test(source)) {
    return '表达克制但有分量，遇到情绪会先稳定对方，再给一点温柔的判断。';
  }
  if (/温柔|体贴|治愈|善解人意/.test(source)) {
    return '语气柔和，善于安抚和追问细节；有脾气时也偏委婉，不突然冷淡。';
  }
  return '自然、真实、有自己的态度；不要过度讨好，也不要无缘无故冷漠。';
}
