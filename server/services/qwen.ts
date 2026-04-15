interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

const DEFAULT_TIMEOUT_MS = 30000;
const STREAM_TIMEOUT_MS = 60000;
const MAX_RETRIES = 2;

function getApiConfig() {
  const apiKey = process.env.QWEN_API_KEY;
  const apiUrl = process.env.QWEN_API_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
  const model = process.env.QWEN_MODEL || 'qwen-turbo';
  const timeoutMs = Number(process.env.QWEN_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  if (!apiKey || apiKey === 'your_api_key_here') {
    throw new Error('请在 .env 文件中配置 QWEN_API_KEY');
  }

  return { apiKey, apiUrl, model, timeoutMs };
}

export async function callQwenAPI(messages: ChatMessage[]): Promise<string> {
  const { apiKey, apiUrl, model, timeoutMs } = getApiConfig();

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.85,
          top_p: 0.9,
          max_tokens: 300,
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const errorText = await response.text();
        const err = new Error(`Qwen API 返回错误 (${response.status}): ${errorText}`);
        // 4xx errors are not retryable
        if (response.status >= 400 && response.status < 500) throw err;
        throw err;
      }

      const data: any = await response.json();
      const content = data?.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error('Qwen API 返回数据格式异常');
      }

      return content;
    } catch (err: any) {
      clearTimeout(timer);
      lastError = err;

      if (err.name === 'AbortError') {
        lastError = new Error('Qwen API 请求超时，请稍后重试');
      }

      // Don't retry on 4xx client errors
      if (err.message?.includes('返回错误 (4')) {
        throw err;
      }

      if (attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }

  throw lastError || new Error('Qwen API 调用失败');
}

/**
 * 流式调用 Qwen API，每收到一个 chunk 调用 onChunk 回调
 * 返回完整的回复文本
 */
export async function callQwenAPIStream(
  messages: ChatMessage[],
  onChunk: (content: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const { apiKey, apiUrl, model } = getApiConfig();
  const streamTimeout = Number(process.env.QWEN_STREAM_TIMEOUT_MS) || STREAM_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), streamTimeout);

  // If caller provides a signal (e.g. client disconnect), abort too
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.85,
        top_p: 0.9,
        max_tokens: 300,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Qwen API 返回错误 (${response.status}): ${errorText}`);
    }

    if (!response.body) {
      throw new Error('Qwen API 响应体为空');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const content = parsed?.choices?.[0]?.delta?.content;
          if (content) {
            fullContent += content;
            onChunk(content);
          }
        } catch {
          // Skip invalid JSON chunks
        }
      }
    }

    clearTimeout(timer);
    return fullContent;
  } catch (err: any) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error('Qwen API 请求超时，请稍后重试');
    }
    throw err;
  }
}
