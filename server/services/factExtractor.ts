/**
 * 事实抽取层
 *
 * 将用户原始消息转化为更适合长期存储和检索的"事实文本"。
 * 纯规则实现，不依赖 LLM 调用（保持写入轻量）。
 */

import type { MemoryType } from './memoryConflict';

export type RelationshipSubtype = 'affection' | 'trust' | 'intimacy' | 'conflict' | 'expectation' | null;

interface FactExtractionResult {
  /** 归一化事实文本（用于 embedding 和展示） */
  normalizedFact: string;
  /** 原始文本 */
  rawText: string;
  /** 提取到的事实类别 */
  category: string;
}

interface ExtractionRule {
  pattern: RegExp;
  category: string;
  /** 返回归一化描述；$1 等引用 capture group */
  normalize: (match: RegExpMatchArray, fullText: string) => string;
}

const EXTRACTION_RULES: ExtractionRule[] = [
  // ---- 身份 / 个人信息 ----
  {
    pattern: /我(叫|名字是|名字叫)(.{1,8})/,
    category: 'identity',
    normalize: (m) => `用户名字：${m[2].replace(/[，。！？,!?]/g, '').trim()}`,
  },
  {
    pattern: /我(今年|现在)?(\d{1,3})(岁|了)/,
    category: 'identity',
    normalize: (m) => `用户年龄：${m[2]}岁`,
  },
  {
    pattern: /我(是|属)(属?)(.{1,2})(的|座)/,
    category: 'identity',
    normalize: (m) => `用户星座/生肖：${m[3]}`,
  },

  // ---- 地点 ----
  {
    pattern: /我(在|住在?|老家|家在|来自|是)(.{1,15}?)(的人|人|这边|这里|市|省|区|工作|上班|生活|读书|$)/,
    category: 'location',
    normalize: (m) => `用户所在地或老家：${m[2]}${m[3] === '$' ? '' : m[3]}`.replace(/[。，！？]/g, '').trim(),
  },

  // ---- 工作 / 学校 ----
  {
    pattern: /我(的|是)?(.{0,4})(工作|职业|岗位)(是)?(.{1,20})/,
    category: 'identity',
    normalize: (m) => `用户职业：${m[5].replace(/[。，！？,!?]/g, '').trim()}`,
  },
  {
    pattern: /我(在|是)(.{1,20}?)(上班|工作|实习|上学|读书|念书)/,
    category: 'identity',
    normalize: (m) => `用户在${m[2]}${m[3]}`,
  },
  {
    pattern: /我(的|是)?(.{0,2})(学校|大学|专业)(是)?(.{1,20})/,
    category: 'identity',
    normalize: (m) => `用户${m[3]}：${m[5].replace(/[。，！？,!?]/g, '').trim()}`,
  },

  // ---- 偏好 ----
  {
    pattern: /我(喜欢|最喜欢|爱|最爱|特别喜欢|超喜欢)(.{1,25})/,
    category: 'preference',
    normalize: (m) => `用户喜欢：${m[2].replace(/[。，！？,!?]/g, '').trim()}`,
  },
  {
    pattern: /我(讨厌|不喜欢|最怕|受不了|不爱|害怕)(.{1,25})/,
    category: 'preference',
    normalize: (m) => `用户不喜欢：${m[2].replace(/[。，！？,!?]/g, '').trim()}`,
  },

  // ---- 宠物 ----
  {
    pattern: /(养了|有一只|有一个|家里有|我家有?)(.{0,4}?)(猫|狗|宠物|鱼|兔|仓鼠|鸟|龟|蜥蜴)(.{0,10})/,
    category: 'pet',
    normalize: (m) => `用户养了${m[3]}${m[4] ? '，' + m[4].replace(/[。，！？,!?]/g, '').trim() : ''}`,
  },

  // ---- 家庭关系 ----
  {
    pattern: /我(的?)(爸|妈|父亲|母亲|哥|姐|弟|妹|爷爷|奶奶|外公|外婆|老公|老婆|儿子|女儿)(.{1,30})/,
    category: 'family',
    normalize: (m) => `用户的${m[2]}：${m[3].replace(/[。！？!?]/g, '').trim()}`,
  },

  // ---- 感情关系 ----
  {
    pattern: /我(的?)?(男朋友|女朋友|对象|前任|暗恋的人|喜欢的人|男友|女友|老公|老婆)(.{0,30})/,
    category: 'relationship',
    normalize: (m) => `用户的${m[2]}${m[3] ? '：' + m[3].replace(/[。！？!?]/g, '').trim() : ''}`,
  },

  // ---- 计划 ----
  {
    pattern: /(计划|打算|准备|决定|想去|要去|要做|想做)(.{2,30})/,
    category: 'plan',
    normalize: (m) => `用户计划：${m[2].replace(/[。！？!?]/g, '').trim()}`,
  },

  // ---- 重大事件 ----
  {
    pattern: /我(今天|昨天|上周|上个月|最近|刚|刚才|前几天)(.{4,40})/,
    category: 'event',
    normalize: (m) => `用户${m[1]}${m[2].replace(/[。！？!?]/g, '').trim()}`,
  },

  // ---- 生日 / 纪念日 ----
  {
    pattern: /我(的?)?(生日|纪念日)(是|在)(.{1,15})/,
    category: 'milestone',
    normalize: (m) => `用户${m[2]}：${m[4].replace(/[。，！？,!?]/g, '').trim()}`,
  },

  // ---- 习惯 ----
  {
    pattern: /我(每天|经常|总是|一直|习惯|一般都|平时)(.{3,30})/,
    category: 'habit',
    normalize: (m) => `用户习惯：${m[1]}${m[2].replace(/[。！？!?]/g, '').trim()}`,
  },
];

/**
 * 从用户消息中提取事实文本
 *
 * 优先匹配结构化规则，提取出归一化事实；
 * 如果没有命中任何规则，返回 null（调用方应退化为原始文本）。
 */
export function extractFactsFromText(text: string): FactExtractionResult | null {
  const trimmed = text.trim();

  // 尝试所有规则，取最高优先级匹配（按规则顺序）
  for (const rule of EXTRACTION_RULES) {
    const match = trimmed.match(rule.pattern);
    if (match) {
      const normalized = rule.normalize(match, trimmed);
      // 归一化结果至少要有一定长度
      if (normalized && normalized.length >= 4) {
        return {
          normalizedFact: normalized,
          rawText: trimmed,
          category: rule.category,
        };
      }
    }
  }

  return null;
}

/**
 * 获取事实文本用于 embedding：
 * 如果能提取到事实 → 用归一化文本
 * 否则 → 用原始文本
 */
export function getTextForEmbedding(text: string): { textForEmbed: string; normalizedFact: string | null; category: string } {
  const result = extractFactsFromText(text);
  if (result) {
    return {
      textForEmbed: result.normalizedFact,
      normalizedFact: result.normalizedFact,
      category: result.category,
    };
  }
  return {
    textForEmbed: text.trim(),
    normalizedFact: null,
    category: 'general',
  };
}

// ========== 记忆类型分类 ==========

const MEMORY_TYPE_RULES: Array<{ type: MemoryType; patterns: RegExp[] }> = [
  {
    type: 'fact',
    patterns: [
      /用户(名字|年龄|星座|生肖|职业|学校|大学|专业|所在地|老家)/,
      /我(叫|名字|姓|今年|岁|属|的工作|的职业|的学校|的大学|的专业)/,
      /我(是|在).{1,15}(工作|上班|上学|读书|念书)/,
      /我(在|住|老家|家在|来自).{1,10}(市|省|区|县|镇|国|城市)/,
      /(爸|妈|父亲|母亲|哥|姐|弟|妹|爷爷|奶奶|外公|外婆|儿子|女儿)/,
      /(毕业|入职|辞职|跳槽|升职|创业)/,
      /我(的?)(生日|纪念日)/,
    ],
  },
  {
    type: 'state',
    patterns: [
      /(开心|难过|伤心|生气|烦|崩溃|焦虑|压力|委屈|感动|郁闷|无聊|孤独|害怕|紧张|兴奋|激动)/,
      /我(今天|昨天|最近|刚|刚才|前几天).{4,}/,
      /(最近|近期|这段时间|现在)(状态|情绪|心情|感觉|很忙|很累)/,
      /我(觉得|认为|感觉|发现).{4,}/,
    ],
  },
  {
    type: 'relationship',
    patterns: [
      /(男朋友|女朋友|对象|暗恋|喜欢的人|前任|表白|分手|复合|结婚|离婚|男友|女友)/,
      /我(爱你|喜欢你|想你|离不开你)/,
      /用户的(男朋友|女朋友|对象|前任)/,
    ],
  },
  {
    type: 'preference',
    patterns: [
      /我(喜欢|最喜欢|爱|最爱|特别喜欢|超喜欢)/,
      /我(讨厌|不喜欢|最怕|受不了|不爱|害怕)/,
      /(每天|经常|总是|一直|习惯|一般都|平时)/,
      /用户(喜欢|不喜欢|习惯)/,
    ],
  },
  {
    type: 'plan',
    patterns: [
      /(计划|打算|准备|决定|想去|要去|要做|想做|目标|梦想)/,
      /用户计划/,
    ],
  },
];

/**
 * 根据文本内容和提取的事实自动分类 memory_type
 */
export function classifyMemoryType(text: string, normalizedFactText: string | null): MemoryType {
  const checkTexts = [normalizedFactText, text].filter(Boolean) as string[];

  for (const { type, patterns } of MEMORY_TYPE_RULES) {
    for (const t of checkTexts) {
      for (const pattern of patterns) {
        if (pattern.test(t)) {
          return type;
        }
      }
    }
  }

  return 'other';
}

// ========== relationship 子类型分类 ==========

const RELATIONSHIP_SUBTYPE_RULES: Array<{ subtype: RelationshipSubtype; patterns: RegExp[] }> = [
  {
    subtype: 'conflict',
    patterns: [
      /(吵架|闹别扭|生气|不理|分手|吃醋|不满|争|冷战|翻脸|骂|怼|发火|误会|道歉)/,
      /你(凭什么|为什么不|怎么能|太过分|烦死|讨厌)/,
      /(我们|咱们)(吵|闹|冷|分)/,
    ],
  },
  {
    subtype: 'expectation',
    patterns: [
      /(希望你|你能不能|你可以|答应我|承诺|保证|我想让你|你要|以后你|你别|不许你|约定)/,
      /(期待|等你|盼|等着你)/,
      /你(能|要|必须|应该).{2,}/,
    ],
  },
  {
    subtype: 'intimacy',
    patterns: [
      /(亲亲|抱抱|么么|mua|撒娇|蹭蹭|抱一下|亲一下|牵手|依偎|暧昧|依恋)/,
      /(好想(要|抱)|想(亲|抱|蹭|摸)|贴贴)/,
      /我(要|想)(亲|抱|贴|蹭|撒娇)/,
    ],
  },
  {
    subtype: 'trust',
    patterns: [
      /(信任|信你|靠你|依靠|倾诉|告诉你一个秘密|只跟你说|相信你|放心|安全感|踏实)/,
      /(只有你|你(是|最)懂我|有你(在|就))/,
    ],
  },
  {
    subtype: 'affection',
    patterns: [
      /(喜欢你|爱你|想你|离不开你|在乎你|心疼你|好喜欢|好爱|超爱|最爱)/,
      /(想念|思念|挂念|牵挂|舍不得)/,
      /(男朋友|女朋友|对象|前任|暗恋|表白|复合|结婚|男友|女友)/,
    ],
  },
];

/**
 * 对 relationship 类型记忆进行子类型分类
 * 仅当 memory_type === 'relationship' 时调用
 */
export function classifyRelationshipSubtype(text: string, normalizedFactText: string | null): RelationshipSubtype {
  const checkTexts = [normalizedFactText, text].filter(Boolean) as string[];

  for (const { subtype, patterns } of RELATIONSHIP_SUBTYPE_RULES) {
    for (const t of checkTexts) {
      for (const pattern of patterns) {
        if (pattern.test(t)) {
          return subtype;
        }
      }
    }
  }

  return null;
}
