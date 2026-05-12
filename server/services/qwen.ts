interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

const DEFAULT_TIMEOUT_MS = 30000;
const STREAM_TIMEOUT_MS = 60000;
const MAX_RETRIES = 2;

/**
 * 根据用户输入长度动态决定 max_tokens
 */
export function getMaxTokens(userInput: string): number {
  const len = userInput.trim().length;
  if (len < 20) return 400;
  if (len <= 100) return 600;
  return 900;
}

interface ApiConfig {
  apiKey: string;
  apiUrl: string;
  model: string;
  timeoutMs: number;
  temperature: number;
  topP: number;
  provider: 'deepseek' | 'qwen';
}

function getApiConfig(): ApiConfig {
  // 优先检查 DeepSeek 配置
  const dsKey = process.env.DEEPSEEK_API_KEY;
  const dsBase = process.env.DEEPSEEK_BASE_URL;
  const dsModel = process.env.DEEPSEEK_MODEL;

  if (dsKey && dsKey !== 'your_api_key_here') {
    return {
      apiKey: dsKey,
      apiUrl: `${(dsBase || 'https://api.deepseek.com').replace(/\/+$/, '')}/chat/completions`,
      model: dsModel || 'deepseek-chat',
      timeoutMs: Number(process.env.DEEPSEEK_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
      temperature: Number(process.env.DEEPSEEK_TEMPERATURE) || 0.85,
      topP: Number(process.env.DEEPSEEK_TOP_P) || 0.9,
      provider: 'deepseek',
    };
  }

  // Fallback 到 Qwen
  const qwenKey = process.env.QWEN_API_KEY;
  const qwenBase = process.env.QWEN_BASE_URL;
  const qwenModel = process.env.QWEN_MODEL;

  if (!qwenKey || qwenKey === 'your_api_key_here') {
    console.error('[LLM] DEEPSEEK_API_KEY 和 QWEN_API_KEY 均未配置');
    throw new Error('请在 .env 文件中配置 DEEPSEEK_API_KEY 或 QWEN_API_KEY');
  }

  if (!qwenBase) {
    console.error('[LLM] QWEN_BASE_URL 未配置');
    throw new Error('请在 .env 文件中配置 QWEN_BASE_URL');
  }

  return {
    apiKey: qwenKey,
    apiUrl: `${qwenBase.replace(/\/+$/, '')}/chat/completions`,
    model: qwenModel || 'qwen-turbo',
    timeoutMs: Number(process.env.QWEN_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    temperature: Number(process.env.QWEN_TEMPERATURE) || 0.85,
    topP: Number(process.env.QWEN_TOP_P) || 0.9,
    provider: 'qwen',
  };
}

export async function callQwenAPI(messages: ChatMessage[], maxTokens?: number): Promise<string> {
  const { apiKey, apiUrl, model, timeoutMs, temperature, topP, provider } = getApiConfig();

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
          temperature,
          top_p: topP,
          max_tokens: maxTokens || 600,
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const errorText = await response.text();
        const err = new Error(`${provider} API 返回错误 (${response.status}): ${errorText}`);
        if (response.status >= 400 && response.status < 500) throw err;
        throw err;
      }

      const data: any = await response.json();
      const content = data?.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error(`${provider} API 返回数据格式异常`);
      }

      return content;
    } catch (err: any) {
      clearTimeout(timer);
      lastError = err;

      if (err.name === 'AbortError') {
        lastError = new Error(`${provider} API 请求超时，请稍后重试`);
      }

      if (err.message?.includes('返回错误 (4')) {
        throw err;
      }

      if (attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }

  throw lastError || new Error('API 调用失败');
}

/**
 * 流式调用 API，每收到一个 chunk 调用 onChunk 回调
 */
export async function callQwenAPIStream(
  messages: ChatMessage[],
  onChunk: (content: string) => void,
  signal?: AbortSignal,
  maxTokens?: number
): Promise<string> {
  const { apiKey, apiUrl, model, temperature, topP, provider } = getApiConfig();
  const streamTimeout = Number(process.env.DEEPSEEK_STREAM_TIMEOUT_MS)
    || Number(process.env.QWEN_STREAM_TIMEOUT_MS)
    || STREAM_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), streamTimeout);

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
        temperature,
        top_p: topP,
        max_tokens: maxTokens || 600,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${provider} API 返回错误 (${response.status}): ${errorText}`);
    }

    if (!response.body) {
      throw new Error(`${provider} API 响应体为空`);
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
      throw new Error(`${provider} API 请求超时，请稍后重试`);
    }
    throw err;
  }
}
