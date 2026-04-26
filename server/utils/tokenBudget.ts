export interface BudgetChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;

  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const asciiWords = (text.match(/[A-Za-z0-9_]+/g) || []).length;
  const punctuation = (text.match(/[^\sA-Za-z0-9_\u4e00-\u9fff]/g) || []).length;
  return Math.ceil(cjk * 1.1 + asciiWords * 1.3 + punctuation * 0.5);
}

export function trimToTokenBudget(text: string, maxTokens: number): string {
  const trimmed = text.trim();
  if (estimateTokens(trimmed) <= maxTokens) return trimmed;

  let result = '';
  let tokens = 0;
  for (const char of trimmed) {
    const next = estimateTokens(char);
    if (tokens + next > maxTokens) break;
    result += char;
    tokens += next;
  }

  return result.trimEnd() + '...';
}

export function totalMessageTokens(messages: BudgetChatMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateTokens(msg.content) + 4, 0);
}

export function fitRecentMessagesToBudget(
  messages: BudgetChatMessage[],
  maxTokens: number,
  maxSingleMessageTokens: number,
): BudgetChatMessage[] {
  const kept: BudgetChatMessage[] = [];
  let used = 0;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    const content = trimToTokenBudget(msg.content, maxSingleMessageTokens);
    const cost = estimateTokens(content) + 4;
    if (used + cost > maxTokens) break;
    kept.unshift({ ...msg, content });
    used += cost;
  }

  return kept;
}

export function compactLines(lines: string[], maxTokens: number): string[] {
  const kept: string[] = [];
  let used = 0;

  for (const line of lines) {
    const cost = estimateTokens(line);
    if (used + cost > maxTokens) break;
    kept.push(line);
    used += cost;
  }

  return kept;
}
