/**
 * 向量检索记忆系统 v4
 *
 * 分层架构：
 *   short-term: 最近 N 条消息（不走向量检索）
 *   long-term:  高价值消息 → 事实抽取 → 分类 → 冲突检测 → embedding → 多因素重排序检索
 *
 * v4 改进：
 *   - memory_type 自动分类（fact/state/preference/plan/relationship/other）
 *   - 事实冲突检测与自动覆盖（supersede 机制）
 *   - 命中反馈（hit_count / usageScore）
 *   - 检索仅返回 active 记忆
 */
import db from '../db';
import { getEmbedding } from './embedding';
import { cosineSimilarity } from '../utils/similarity';
import { memoryConfig } from '../utils/memoryConfig';
import { getTextForEmbedding, classifyMemoryType, classifyRelationshipSubtype } from './factExtractor';
import { detectMemoryConflict, resolveMemoryConflict } from './memoryConflict';
import type { MemoryType } from './memoryConflict';
import type { RelationshipSubtype } from './factExtractor';
import type { MemoryDebugEntry } from '../utils/memoryDebug';

// ========== 记忆重要性评估 ==========

interface ImportanceRule {
  pattern: RegExp;
  score: number; // 额外加分
  category: string;
}

const IMPORTANCE_RULES: ImportanceRule[] = [
  // 5 分 — 关系 / 重大事件
  { pattern: /(男朋友|女朋友|对象|暗恋|喜欢的人|前任|表白|分手|复合|结婚|离婚)/, score: 5, category: 'relationship' },
  { pattern: /(生日|纪念日|周年)/, score: 5, category: 'milestone' },
  { pattern: /我(爱你|喜欢你|想你|离不开你)/, score: 5, category: 'affection' },

  // 4 分 — 个人信息 / 身份
  { pattern: /我(的|是).{0,6}(工作|专业|学校|公司|职业|岗位)/, score: 4, category: 'identity' },
  { pattern: /我(在|住|老家|家在|来自).{0,10}(市|省|区|县|镇|国|城市)/, score: 4, category: 'location' },
  { pattern: /(爸|妈|父亲|母亲|哥|姐|弟|妹|爷爷|奶奶|外公|外婆|儿子|女儿)/, score: 4, category: 'family' },
  { pattern: /我(叫|名字|姓|今年|岁|属)/, score: 4, category: 'identity' },

  // 3 分 — 偏好 / 计划
  { pattern: /我(喜欢|讨厌|不喜欢|爱吃|不爱吃|最怕|最爱|受不了)/, score: 3, category: 'preference' },
  { pattern: /(计划|打算|准备|决定|想去|要去|要做|目标|梦想)/, score: 3, category: 'plan' },
  { pattern: /(养了|有一只|有一个|家里有|我家).{0,6}(猫|狗|宠物|鱼|兔|仓鼠|鸟)/, score: 3, category: 'pet' },
  { pattern: /(毕业|入职|辞职|跳槽|升职|加薪|创业|考研|考公)/, score: 3, category: 'career' },

  // 2 分 — 情绪 / 事件
  { pattern: /(开心|难过|伤心|生气|烦|崩溃|焦虑|压力|委屈|感动|幸福|郁闷|无聊|孤独|害怕|紧张|兴奋|激动)/, score: 2, category: 'emotion' },
  { pattern: /我(今天|昨天|上周|上个月|最近|刚才|之前).{4,}/, score: 2, category: 'event' },
  { pattern: /我(觉得|认为|感觉|发现).{4,}/, score: 2, category: 'opinion' },

  // 1 分 — 习惯
  { pattern: /(每天|经常|总是|一直|习惯|一般都|平时)/, score: 1, category: 'habit' },
];

const LOW_VALUE_PATTERNS = [
  /^(嗯+|哈+|哦+|啊+|嘿+|呵+|额+|唔+|emm+|ok+|好+的?|行+|对+|是+的?|在+吗?|嗯嗯+|哈哈+|呜呜+|嘻嘻+|噢+|啊?这+|可以|没事|随便|都行|无所谓|算了)$/i,
  /^.{0,3}$/,
  /^[?？!！.。,，~～…\s]+$/,
  /^(你好|hi|hello|hey|晚安|早安|拜拜|再见|88|886|gn|gm|谢谢|不客气|没关系)$/i,
  /^(你在吗|在不在|忙吗|睡了吗|吃了吗|干嘛呢|你呢|然后呢|真的吗|是吗|啊是吗)$/,
];

/**
 * 评估记忆重要性，返回 1~5 分
 */
export function extractMemoryImportance(text: string): number {
  const trimmed = text.trim();
  let maxScore = 0;

  for (const rule of IMPORTANCE_RULES) {
    if (rule.pattern.test(trimmed)) {
      maxScore = Math.max(maxScore, rule.score);
    }
  }

  // 长文本有基础信息量加成
  if (maxScore === 0 && trimmed.length >= 20) maxScore = 1;

  return Math.max(1, Math.min(5, maxScore));
}

/**
 * 判断是否值得存入 long-term memory
 */
export function shouldStoreAsMemory(text: string): boolean {
  const trimmed = text.trim();

  for (const pattern of LOW_VALUE_PATTERNS) {
    if (pattern.test(trimmed)) return false;
  }

  // 长度 < 5 且没命中任何高价值规则
  if (trimmed.length < 5) return false;

  // 命中任意重要性规则
  for (const rule of IMPORTANCE_RULES) {
    if (rule.pattern.test(trimmed)) return true;
  }

  // 12 字以上的消息有一定信息量；放宽写入，方便后续上下文召回。
  if (trimmed.length >= 12) return true;

  return false;
}

// ========== 写入记忆（含去重） ==========

interface MemoryMetadata {
  role?: string;
  importance?: number;
  category?: string;
  [key: string]: any;
}

/**
 * 写入记忆，写入前做事实抽取 + 分类 + 去重 + 冲突检测
 */
export async function addMemory(
  characterId: number,
  text: string,
  metadata: MemoryMetadata = {}
): Promise<void> {
  await addMemoriesFromText(characterId, text, metadata);
}

export async function addMemoriesFromText(
  characterId: number,
  text: string,
  metadata: MemoryMetadata = {}
): Promise<void> {
  const candidates = buildMemoryCandidates(text);
  for (const candidate of candidates) {
    await addSingleMemory(characterId, candidate, metadata);
  }
}

function buildMemoryCandidates(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const chunks = trimmed
    .split(/[。！？!?；;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const candidates = new Set<string>();
  for (const chunk of chunks) {
    if (shouldStoreAsMemory(chunk)) candidates.add(chunk);
  }

  if (candidates.size === 0 && shouldStoreAsMemory(trimmed)) {
    candidates.add(trimmed);
  }

  return [...candidates].slice(0, 4);
}

async function addSingleMemory(
  characterId: number,
  text: string,
  metadata: MemoryMetadata = {}
): Promise<void> {
  try {
    // ---- 事实抽取 ----
    const { textForEmbed, normalizedFact, category: factCategory } = getTextForEmbedding(text);
    // text 字段兼容旧逻辑（用于展示和检索退化）
    const displayText = normalizedFact || text;

    const embedding = await getEmbedding(textForEmbed);

    // ---- 写入前去重 ----
    const isDuplicate = checkDuplicate(characterId, embedding, displayText);
    if (isDuplicate) return;

    // ---- 计算重要性 ----
    const importance = extractMemoryImportance(text);
    const bestCategory = factCategory !== 'general' ? factCategory : getBestCategory(text);
    const keywords = extractMemoryKeywords(displayText, text);
    const enrichedMeta = { ...metadata, importance, category: bestCategory, keywords };

    // ---- 自动分类 memory_type ----
    const memoryType: MemoryType = classifyMemoryType(text, normalizedFact);

    // ---- relationship 子类型 ----
    const relationshipSubtype: RelationshipSubtype = memoryType === 'relationship'
      ? classifyRelationshipSubtype(text, normalizedFact)
      : null;

    const embeddingJson = JSON.stringify(embedding);
    const metadataJson = JSON.stringify(enrichedMeta);

    // ---- 冲突检测 ----
    const conflict = detectMemoryConflict(characterId, text, normalizedFact, embedding, memoryType);

    // ---- 计算过期时间（state / plan 支持 TTL）----
    let expiresAt: string | null = null;
    if (memoryType === 'state') {
      expiresAt = new Date(Date.now() + memoryConfig.stateTtlDays * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    } else if (memoryType === 'plan') {
      expiresAt = new Date(Date.now() + memoryConfig.planTtlDays * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    }

    const result = db.prepare(
      'INSERT INTO memories (character_id, text, raw_text, normalized_fact_text, embedding, importance, memory_type, keywords, expires_at, relationship_subtype, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(characterId, displayText, text, normalizedFact, embeddingJson, importance, memoryType, JSON.stringify(keywords), expiresAt, relationshipSubtype, metadataJson);

    // ---- 冲突解决：将旧记忆标记为 inactive ----
    if (conflict.hasConflict) {
      const newId = Number(result.lastInsertRowid);
      resolveMemoryConflict(conflict.conflictingIds, newId);
    }
  } catch (err: any) {
    console.error('addMemory 失败:', err?.message);
  }
}

function getBestCategory(text: string): string {
  let best = 'general';
  let bestScore = 0;
  for (const rule of IMPORTANCE_RULES) {
    if (rule.pattern.test(text) && rule.score > bestScore) {
      bestScore = rule.score;
      best = rule.category;
    }
  }
  return best;
}

/**
 * 检查新记忆是否与已有记忆重复
 */
function checkDuplicate(
  characterId: number,
  newEmbedding: number[],
  newText: string,
): boolean {
  const threshold = memoryConfig.writeDedupThreshold;
  const recentRows = db
    .prepare(
      'SELECT text, normalized_fact_text, embedding FROM memories WHERE character_id = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 30'
    )
    .all(characterId) as Array<{ text: string; normalized_fact_text: string | null; embedding: string }>;

  for (const row of recentRows) {
    const existingText = row.normalized_fact_text || row.text;
    const existing = JSON.parse(row.embedding) as number[];
    if (cosineSimilarity(newEmbedding, existing) > threshold) {
      if (looksLikeReplacement(newText, existingText)) {
        return false;
      }
      return true;
    }
  }
  return false;
}

function looksLikeReplacement(newText: string, existingText: string): boolean {
  if (newText === existingText) return false;

  const newKey = normalizedMemoryKey(newText);
  const oldKey = normalizedMemoryKey(existingText);
  if (newKey && oldKey && newKey === oldKey) return true;

  const positive = /(喜欢|爱|想要|接受|可以|愿意)/;
  const negative = /(不喜欢|讨厌|不爱|受不了|不想|不接受|不愿意|害怕|最怕)/;
  return (positive.test(existingText) && negative.test(newText)) ||
    (negative.test(existingText) && positive.test(newText));
}

function normalizedMemoryKey(text: string): string | null {
  const keyMatch = text.match(/^(用户(?:名字|年龄|星座\/生肖|职业|学校|大学|专业|所在地或老家|计划|喜欢|不喜欢|习惯)|用户在[^：:]{0,12}(?:工作|上班|实习|上学|读书))[:：]/);
  if (keyMatch) return keyMatch[1].replace(/不喜欢/g, '喜欢');

  const relationMatch = text.match(/^用户的(爸|妈|父亲|母亲|哥|姐|弟|妹|男朋友|女朋友|对象|前任)/);
  if (relationMatch) return `用户的${relationMatch[1]}`;

  return null;
}

export function extractMemoryKeywords(...texts: string[]): string[] {
  const source = texts.join(' ').toLowerCase();
  const tokens = new Set<string>();

  const normalized = source
    .replace(/[用户我你的她他是了呢啊呀哦嗯哈，。！？、；：,.!?;:"'()[\]{}【】（）]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const match of normalized.matchAll(/[a-z0-9_]{3,24}/g)) {
    tokens.add(match[0]);
  }

  for (const phrase of source.matchAll(/[\u4e00-\u9fff]{2,8}/g)) {
    const value = phrase[0];
    if (!isStopKeyword(value)) tokens.add(value);
  }

  for (const explicit of source.matchAll(/(?:喜欢|不喜欢|讨厌|计划|打算|名字|生日|对象|女朋友|男朋友|老家|住在|工作|学校|专业|猫|狗|考试|面试|旅游|游戏|电影|火锅|咖啡|奶茶)[\u4e00-\u9fff]{0,8}/g)) {
    const value = explicit[0];
    if (value.length >= 2) tokens.add(value);
  }

  return [...tokens].sort((a, b) => b.length - a.length).slice(0, 12);
}

function isStopKeyword(value: string): boolean {
  return /^(这个|那个|就是|然后|但是|因为|所以|如果|还是|可以|没有|不是|什么|怎么|觉得|感觉|今天|昨天|最近|一下|一点|真的|有点|比较|还是|时候)$/.test(value);
}

// ========== 检索记忆（多因素重排序） ==========

export interface MemoryResult {
  id: number;
  text: string;           // 优先 normalizedFactText，退化为 text
  rawText: string;        // 原始用户消息
  score: number;          // 最终综合评分
  semantic: number;       // 原始语义相似度
  importance: number;
  memoryType: string;
  hitCount: number;
  createdAt: string;
  debugEntry?: MemoryDebugEntry;
}

interface RawMemoryRow {
  id: number;
  text: string;
  raw_text: string | null;
  normalized_fact_text: string | null;
  embedding: string;
  importance: number;
  memory_type: string;
  keywords: string | null;
  relationship_subtype: string | null;
  invalidation_reason: string | null;
  hit_count: number;
  last_hit_at: string | null;
  metadata: string;
  created_at: string;
}

/**
 * 检索 + 多因素重排序，返回带调试信息的结果
 */
export async function searchMemory(
  characterId: number,
  query: string,
  topK?: number
): Promise<MemoryResult[]> {
  const k = topK || memoryConfig.topK;
  const maxCandidates = memoryConfig.maxCandidates;
  const threshold = memoryConfig.recallThreshold;

  try {
    ensureMemoryKeywords(characterId);
    const queryEmbedding = await getEmbedding(query);
    const queryKeywords = extractMemoryKeywords(query);

    const rows = db
      .prepare(
        'SELECT id, text, raw_text, normalized_fact_text, embedding, importance, memory_type, keywords, relationship_subtype, invalidation_reason, hit_count, last_hit_at, metadata, created_at FROM memories WHERE character_id = ? AND is_active = 1 AND (expires_at IS NULL OR expires_at > datetime(\'now\')) ORDER BY created_at DESC'
      )
      .all(characterId) as RawMemoryRow[];

    if (rows.length === 0) return [];

    // ---- 第一阶段：粗筛 ----
    const candidates = rows
      .map((row) => {
        const emb = JSON.parse(row.embedding) as number[];
        const semantic = cosineSimilarity(queryEmbedding, emb);
        const keywordScore = calculateKeywordScore(queryKeywords, parseKeywords(row.keywords));
        return { ...row, semantic, keywordScore, emb };
      })
      .filter((item) =>
        item.semantic > threshold ||
        item.keywordScore >= memoryConfig.keywordRecallThreshold ||
        (item.importance >= 4 && item.keywordScore > 0) ||
        item.importance >= 5
      )
      .sort((a, b) => (b.semantic + b.keywordScore) - (a.semantic + a.keywordScore))
      .slice(0, maxCandidates);

    if (candidates.length === 0) return [];

    // ---- 第二阶段：多因素重排序 ----
    const reranked = rerankMemoryResults(candidates);

    // ---- 第三阶段：检索后去重 ----
    const deduped = deduplicateResults(reranked);

    return deduped.slice(0, k);
  } catch (err: any) {
    console.error('searchMemory 失败:', err?.message);
    return [];
  }
}

export function getCoreMemories(characterId: number, limit = memoryConfig.coreMemoryLimit): MemoryResult[] {
  ensureMemoryKeywords(characterId);
  const rows = db.prepare(
    `SELECT id, text, raw_text, normalized_fact_text, importance, memory_type, hit_count, created_at
     FROM memories
     WHERE character_id = ?
       AND is_active = 1
       AND (expires_at IS NULL OR expires_at > datetime('now'))
       AND (
         importance >= 4
         OR memory_type IN ('fact', 'relationship')
         OR (memory_type = 'preference' AND importance >= 3)
       )
     ORDER BY importance DESC, hit_count DESC, created_at DESC
     LIMIT ?`
  ).all(characterId, limit) as Array<{
    id: number;
    text: string;
    raw_text: string | null;
    normalized_fact_text: string | null;
    importance: number;
    memory_type: string;
    hit_count: number;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    text: row.normalized_fact_text || row.text,
    rawText: row.raw_text || row.text,
    score: 1,
    semantic: 0,
    importance: row.importance || 1,
    memoryType: row.memory_type || 'other',
    hitCount: row.hit_count || 0,
    createdAt: row.created_at,
  }));
}

function ensureMemoryKeywords(characterId: number): void {
  const rows = db.prepare(
    `SELECT id, text, raw_text, normalized_fact_text
     FROM memories
     WHERE character_id = ?
       AND is_active = 1
       AND (keywords IS NULL OR keywords = '' OR keywords = '[]')
     LIMIT 60`,
  ).all(characterId) as Array<{ id: number; text: string; raw_text: string | null; normalized_fact_text: string | null }>;

  if (rows.length === 0) return;
  const stmt = db.prepare("UPDATE memories SET keywords = ?, updated_at = datetime('now') WHERE id = ?");
  for (const row of rows) {
    const keywords = extractMemoryKeywords(row.normalized_fact_text || row.text, row.raw_text || '');
    stmt.run(JSON.stringify(keywords), row.id);
  }
}

function parseKeywords(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function calculateKeywordScore(queryKeywords: string[], memoryKeywords: string[]): number {
  if (queryKeywords.length === 0 || memoryKeywords.length === 0) return 0;

  let score = 0;
  const memorySet = new Set(memoryKeywords);
  for (const keyword of queryKeywords) {
    if (memorySet.has(keyword)) {
      score += keyword.length >= 4 ? 0.35 : 0.22;
      continue;
    }

    if (memoryKeywords.some((candidate) => candidate.includes(keyword) || keyword.includes(candidate))) {
      score += 0.16;
    }
  }

  return Math.min(1, score);
}

interface ScoredCandidate {
  id: number;
  text: string;
  raw_text: string | null;
  normalized_fact_text: string | null;
  semantic: number;
  keywordScore: number;
  importance: number;
  memory_type: string;
  relationship_subtype: string | null;
  invalidation_reason: string | null;
  hit_count: number;
  last_hit_at: string | null;
  created_at: string;
  emb: number[];
}

/**
 * 多因素重排序：语义 × 重要性 × 时间衰减 × 使用频率 × 长度惩罚
 */
function rerankMemoryResults(candidates: ScoredCandidate[]): MemoryResult[] {
  const sw = memoryConfig.semanticWeight;
  const iw = memoryConfig.importanceWeight;
  const rw = memoryConfig.recencyWeight;
  const uw = memoryConfig.usageWeight;
  const kw = memoryConfig.keywordWeight;
  const now = Date.now();

  return candidates.map((c) => {
    const semanticScore = c.semantic;
    const importanceScore = (c.importance || 1) / 5;

    const ageMs = now - new Date(c.created_at).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const recencyScore = 1 / (1 + ageDays / 30);

    // usageScore: log(1 + hit_count) 归一化，叠加 last_hit_at 时间衰减
    // 很久没命中的记忆 usage 影响逐步下降
    const rawUsage = Math.min(1.0, Math.log(1 + (c.hit_count || 0)) / Math.log(11));
    let usageDecay = 1.0;
    if (c.last_hit_at) {
      const hitAgeMs = now - new Date(c.last_hit_at).getTime();
      const hitAgeDays = hitAgeMs / (1000 * 60 * 60 * 24);
      usageDecay = 1 / (1 + hitAgeDays / 60); // 60天半衰
    } else {
      usageDecay = 0.3; // 从未命中过，给一个低底分
    }
    const usageScore = rawUsage * usageDecay;

    const displayText = c.normalized_fact_text || c.text;
    const lengthPenalty = displayText.length < 8 ? 0.7 : 1.0;

    const finalScore =
      (semanticScore * sw +
        c.keywordScore * kw +
        importanceScore * iw +
        recencyScore * rw +
        usageScore * uw) *
      lengthPenalty;

    const debugEntry: MemoryDebugEntry = {
      id: c.id,
      text: displayText,
      memoryType: c.memory_type || 'other',
      relationshipSubtype: c.relationship_subtype || null,
      invalidationReason: c.invalidation_reason || null,
      semanticScore,
      keywordScore: c.keywordScore,
      importanceScore,
      recencyScore,
      usageScore,
      lengthPenalty,
      finalScore,
      hitCount: c.hit_count || 0,
      isActive: true,
    };

    return {
      id: c.id,
      text: displayText,
      rawText: c.raw_text || c.text,
      score: finalScore,
      semantic: semanticScore,
      importance: c.importance || 1,
      memoryType: c.memory_type || 'other',
      hitCount: c.hit_count || 0,
      createdAt: c.created_at,
      debugEntry,
    };
  }).sort((a, b) => b.score - a.score);
}

/**
 * 检索后去重：如果两条记忆语义极其接近，只保留得分更高的
 */
function deduplicateResults(results: MemoryResult[]): MemoryResult[] {
  if (results.length <= 1) return results;

  const threshold = memoryConfig.dedupThreshold;

  const ids = results.map(r => r.id);
  const embMap = new Map<number, number[]>();
  for (const id of ids) {
    const row = db.prepare('SELECT embedding FROM memories WHERE id = ?').get(id) as { embedding: string } | undefined;
    if (row) {
      embMap.set(id, JSON.parse(row.embedding));
    }
  }

  const kept: MemoryResult[] = [];
  for (const result of results) {
    const emb = embMap.get(result.id);
    if (!emb) { kept.push(result); continue; }

    let isDup = false;
    for (const existing of kept) {
      const existEmb = embMap.get(existing.id);
      if (existEmb && cosineSimilarity(emb, existEmb) > threshold) {
        isDup = true;
        break;
      }
    }
    if (!isDup) kept.push(result);
  }

  return kept;
}

// ========== 记忆统计 ==========

/**
 * 获取某角色的 active 记忆总数
 */
export function getMemoryCount(characterId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) as cnt FROM memories WHERE character_id = ? AND is_active = 1 AND (expires_at IS NULL OR expires_at > datetime(\'now\'))')
    .get(characterId) as { cnt: number };
  return row?.cnt || 0;
}

/**
 * 获取所有 active 记忆文本（用于生成 summary）
 */
export function getAllMemoryTexts(characterId: number): Array<{ text: string; normalizedFactText: string | null; importance: number; created_at: string }> {
  const rows = db
    .prepare('SELECT text, normalized_fact_text, importance, created_at FROM memories WHERE character_id = ? AND is_active = 1 AND (expires_at IS NULL OR expires_at > datetime(\'now\')) ORDER BY importance DESC, created_at DESC')
    .all(characterId) as Array<{ text: string; normalized_fact_text: string | null; importance: number; created_at: string }>;
  return rows.map(row => ({ text: row.text, normalizedFactText: row.normalized_fact_text, importance: row.importance, created_at: row.created_at }));
}

/**
 * 记录记忆命中：更新 hit_count 和 last_hit_at
 */
export function recordMemoryHits(memoryIds: number[]): void {
  if (memoryIds.length === 0) return;
  const stmt = db.prepare(
    "UPDATE memories SET hit_count = hit_count + 1, last_hit_at = datetime('now') WHERE id = ?"
  );
  for (const id of memoryIds) {
    stmt.run(id);
  }
}
