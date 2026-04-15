interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * 根据用户输入长度动态决定 max_tokens
 */
export function getMaxTokens(userInput: string): number {
  const len = userInput.trim().length;
  if (len < 20) return 400;
  if (len <= 100) return 600;
  return 900;
}

export async function callQwenAPI(messages: ChatMessage[], maxTokens?: number): Promise<string> {
  const apiKey = process.env.QWEN_API_KEY;
  const apiUrl = process.env.QWEN_API_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
  const model = process.env.QWEN_MODEL || 'qwen-turbo';

  if (!apiKey || apiKey === 'your_api_key_here') {
    throw new Error('请在 .env 文件中配置 QWEN_API_KEY');
  }

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
      max_tokens: maxTokens || 600,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Qwen API 返回错误 (${response.status}): ${errorText}`);
  }

  const data: any = await response.json();
  const content = data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('Qwen API 返回数据格式异常');
  }

  return content;
}

/**
 * 流式调用 Qwen API，通过回调逐块返回内容
 */
export async function callQwenAPIStream(
  messages: ChatMessage[],
  onChunk: (chunk: string) => void,
  maxTokens?: number
): Promise<string> {
  const apiKey = process.env.QWEN_API_KEY;
  const apiUrl = process.env.QWEN_API_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
  const model = process.env.QWEN_MODEL || 'qwen-turbo';

  if (!apiKey || apiKey === 'your_api_key_here') {
    throw new Error('请在 .env 文件中配置 QWEN_API_KEY');
  }

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
      max_tokens: maxTokens || 600,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Qwen API 返回错误 (${response.status}): ${errorText}`);
  }

  if (!response.body) {
    throw new Error('Qwen API 未返回流式响应体');
  }

  let fullContent = '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === '[DONE]') continue;

      try {
        const parsed = JSON.parse(dataStr);
        const delta = parsed?.choices?.[0]?.delta?.content;
        if (delta) {
          fullContent += delta;
          onChunk(delta);
        }
      } catch {
        // 忽略解析失败的行
      }
    }
  }

  // 处理 buffer 中残留的数据
  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith('data:')) {
      const dataStr = trimmed.slice(5).trim();
      if (dataStr !== '[DONE]') {
        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            onChunk(delta);
          }
        } catch { /* ignore */ }
      }
    }
  }

  if (!fullContent) {
    throw new Error('Qwen API 流式响应未返回任何内容');
  }

  return fullContent;
}
