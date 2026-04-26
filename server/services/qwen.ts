interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export async function callQwenAPI(messages: ChatMessage[]): Promise<string> {
  const apiKey = process.env.QWEN_API_KEY;
  const apiUrl = process.env.QWEN_API_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
  const model = process.env.QWEN_MODEL || 'qwen-turbo';
  const temperature = Number(process.env.QWEN_TEMPERATURE || 0.82);
  const topP = Number(process.env.QWEN_TOP_P || 0.88);
  const maxTokens = Number(process.env.QWEN_MAX_TOKENS || 520);

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
      temperature,
      top_p: topP,
      max_tokens: maxTokens,
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
