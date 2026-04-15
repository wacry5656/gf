/**
 * Embedding 服务 —— 调用 DashScope text-embedding API 生成文本向量
 *
 * 复用 QWEN_API_KEY，也支持独立配置 EMBEDDING_* 环境变量
 *
 * v5: 增加内存缓存，避免相同文本重复调用 API
 */

// ========== Embedding 缓存 ==========
const embeddingCache = new Map<string, number[]>();
const MAX_CACHE_SIZE = 500;

export async function getEmbedding(text: string): Promise<number[]> {
  // 检查缓存
  const cacheKey = text.trim();
  const cached = embeddingCache.get(cacheKey);
  if (cached) return cached;

  const apiKey = process.env.EMBEDDING_API_KEY || process.env.QWEN_API_KEY;
  const baseUrl =
    process.env.EMBEDDING_BASE_URL ||
    'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings';
  const model = process.env.EMBEDDING_MODEL || 'text-embedding-v3';

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
      input: text,
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

  // 写入缓存（LRU 简易实现：超过上限时清除最早一半）
  if (embeddingCache.size >= MAX_CACHE_SIZE) {
    const keys = Array.from(embeddingCache.keys());
    const deleteCount = Math.floor(MAX_CACHE_SIZE / 2);
    for (let i = 0; i < deleteCount; i++) {
      embeddingCache.delete(keys[i]);
    }
  }
  embeddingCache.set(cacheKey, embedding);

  return embedding;
}
