/**
 * Embedding 服务 —— 调用 DashScope text-embedding API 生成文本向量
 *
 * 复用 QWEN_API_KEY，也支持独立配置 EMBEDDING_* 环境变量
 *
 * v6: 内存缓存 + SQLite 持久缓存，避免重启后重复消耗 embedding token
 */
import crypto from 'crypto';
import db from '../db';

// ========== Embedding 缓存 ==========
const embeddingCache = new Map<string, number[]>();
const MAX_CACHE_SIZE = 500;

interface EmbeddingCacheRow {
  embedding: string;
}

function normalizeEmbeddingText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function buildCacheKey(model: string, text: string): { cacheKey: string; textHash: string } {
  const textHash = crypto.createHash('sha256').update(text).digest('hex');
  return { cacheKey: `${model}:${textHash}`, textHash };
}

function remember(cacheKey: string, embedding: number[]): void {
  if (embeddingCache.size >= MAX_CACHE_SIZE) {
    const keys = Array.from(embeddingCache.keys());
    const deleteCount = Math.floor(MAX_CACHE_SIZE / 2);
    for (let i = 0; i < deleteCount; i++) {
      embeddingCache.delete(keys[i]);
    }
  }
  embeddingCache.set(cacheKey, embedding);
}

export async function getEmbedding(text: string): Promise<number[]> {
  const model = process.env.EMBEDDING_MODEL || 'text-embedding-v3';
  const normalizedText = normalizeEmbeddingText(text);
  const { cacheKey, textHash } = buildCacheKey(model, normalizedText);

  // 检查内存缓存（命中时重新插入以模拟 LRU 行为）
  const cached = embeddingCache.get(cacheKey);
  if (cached) {
    // 重新插入使其成为最新条目（LRU 近似）
    embeddingCache.delete(cacheKey);
    embeddingCache.set(cacheKey, cached);
    return cached;
  }

  const diskCached = db
    .prepare('SELECT embedding FROM embedding_cache WHERE cache_key = ?')
    .get(cacheKey) as EmbeddingCacheRow | undefined;
  if (diskCached) {
    const parsed = JSON.parse(diskCached.embedding) as number[];
    remember(cacheKey, parsed);
    db.prepare(
      "UPDATE embedding_cache SET hit_count = hit_count + 1, updated_at = datetime('now') WHERE cache_key = ?"
    ).run(cacheKey);
    return parsed;
  }

  const apiKey = process.env.EMBEDDING_API_KEY || process.env.QWEN_API_KEY;
  const baseUrl = process.env.EMBEDDING_BASE_URL;

  if (!apiKey || apiKey === 'your_api_key_here') {
    console.error('[Embedding] API Key 未配置');
    throw new Error(
      'Embedding API Key 未配置。请在 .env 中设置 EMBEDDING_API_KEY 或 QWEN_API_KEY'
    );
  }

  if (!baseUrl) {
    console.error('[Embedding] EMBEDDING_BASE_URL 未配置');
    throw new Error(
      'EMBEDDING_BASE_URL 未配置。请在 .env 中设置 EMBEDDING_BASE_URL（如 https://dashscope.aliyuncs.com/compatible-mode/v1）'
    );
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/embeddings`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: normalizedText,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Embedding API 错误 (${response.status}): ${errText}`);
  }

  const data: any = await response.json();
  const embedding = data?.data?.[0]?.embedding;

  if (!embedding || !Array.isArray(embedding)) {
    throw new Error('Embedding API 返回数据格式异常');
  }

  remember(cacheKey, embedding);
  db.prepare(
    `INSERT OR REPLACE INTO embedding_cache
       (cache_key, model, text_hash, embedding, hit_count, updated_at)
     VALUES (?, ?, ?, ?, COALESCE((SELECT hit_count FROM embedding_cache WHERE cache_key = ?), 0), datetime('now'))`
  ).run(cacheKey, model, textHash, JSON.stringify(embedding), cacheKey);

  return embedding;
}
