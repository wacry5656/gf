import crypto from 'crypto';
import db from '../db';

/**
 * Embedding 服务 —— 调用 DashScope text-embedding API 生成文本向量。
 * 带本地 SQLite 缓存，避免同一事实/查询反复消耗 embedding API。
 */

export async function getEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.EMBEDDING_API_KEY || process.env.QWEN_API_KEY;
  const baseUrl =
    process.env.EMBEDDING_BASE_URL ||
    'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings';
  const model = process.env.EMBEDDING_MODEL || 'text-embedding-v3';
  const normalizedText = normalizeEmbeddingText(text);
  const cacheKey = buildCacheKey(model, normalizedText);

  const cached = db
    .prepare("SELECT embedding FROM embedding_cache WHERE cache_key = ?")
    .get(cacheKey) as { embedding: string } | undefined;
  if (cached) {
    db.prepare("UPDATE embedding_cache SET hit_count = hit_count + 1, last_hit_at = datetime('now') WHERE cache_key = ?")
      .run(cacheKey);
    return JSON.parse(cached.embedding) as number[];
  }

  if (!apiKey || apiKey === 'your_api_key_here') {
    throw new Error(
      'Embedding API Key 未配置。请在 .env 中设置 EMBEDDING_API_KEY 或 QWEN_API_KEY'
    );
  }

  const response = await fetch(baseUrl, {
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

  db.prepare(
    `INSERT OR REPLACE INTO embedding_cache
      (cache_key, model, text_hash, text_preview, embedding, hit_count, last_hit_at)
     VALUES (?, ?, ?, ?, ?, 0, datetime('now'))`,
  ).run(
    cacheKey,
    model,
    sha256(normalizedText),
    normalizedText.slice(0, 160),
    JSON.stringify(embedding),
  );

  return embedding;
}

function normalizeEmbeddingText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, 1200);
}

function buildCacheKey(model: string, text: string): string {
  return `${model}:${sha256(text)}`;
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}
