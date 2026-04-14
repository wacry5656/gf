/**
 * Embedding 服务 —— 调用 DashScope text-embedding API 生成文本向量
 *
 * 复用 QWEN_API_KEY，也支持独立配置 EMBEDDING_* 环境变量
 */

export async function getEmbedding(text: string): Promise<number[]> {
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

  return embedding;
}
