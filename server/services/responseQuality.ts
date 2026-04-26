export interface ReplyQualityOptions {
  characterName: string;
  fallback?: string;
}

const FORBIDDEN_LINE_PATTERNS = [
  /^用户[:：]/,
  /^助手[:：]/,
  /^AI[:：]/i,
  /^系统[:：]/,
  /^意图[:：]/,
  /^策略[:：]/,
  /^回复[:：]/,
  /作为AI|作为一个AI|系统提示|语言模型|我无法|我不能/,
];

const ACTION_PATTERNS = [
  /[（(][^）)]*[）)]/g,
  /\*[^*]*\*/g,
  /【[^】]*】/g,
  /[，,]?\s*(笑了笑|微微一笑|轻声说|看着你|叹了口气|点了点头|摇了摇头|眨了眨眼|歪了歪头|抿了抿嘴|挠了挠头|低下头|抬起头|走过来|坐在|靠在|拉着你|拍了拍|揉了揉|抱住|牵着|摸了摸)\s*/g,
  /(她|他|我)(心想|觉得|暗想|默默地|静静地|轻轻地)/g,
];

export function polishReplies(rawText: string, options: ReplyQualityOptions): string[] {
  const cleaned = cleanReplyText(rawText, options.characterName);
  const replies = splitReply(cleaned)
    .map(limitReplyLine)
    .filter((line) => line.length > 0 && !FORBIDDEN_LINE_PATTERNS.some((pattern) => pattern.test(line)));

  const uniqueReplies = dedupeAdjacent(replies).slice(0, 3);
  if (uniqueReplies.length === 0) return [options.fallback || '你这句我接住了'];

  if (uniqueReplies.length === 1 && isLowInformation(uniqueReplies[0])) {
    return [uniqueReplies[0], '然后呢，继续说'];
  }

  return uniqueReplies;
}

function cleanReplyText(text: string, characterName: string): string {
  let cleaned = text || '';

  for (const pattern of ACTION_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }

  cleaned = cleaned.replace(new RegExp(`^${escapeRegExp(characterName)}[：:]\\s*`, 'gm'), '');
  cleaned = cleaned.replace(/^.{1,8}[：:]\s*/gm, '');
  cleaned = cleaned.replace(/^[""']|[""']$/gm, '');
  cleaned = cleaned.replace(/\n\s*\n/g, '\n');

  return cleaned.trim();
}

function splitReply(text: string): string[] {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length >= 2) return lines;

  const single = lines[0] || text.trim();
  if (!single) return [];
  if (single.length <= 18) return [single];

  const parts = single.match(/[^。！？~～!?]+[。！？~～!?]?/g);
  if (!parts || parts.length < 2) return [single];

  const merged: string[] = [];
  let buffer = '';
  for (const part of parts) {
    buffer += part;
    if (buffer.length >= 6) {
      merged.push(buffer.trim());
      buffer = '';
    }
  }
  if (buffer.trim()) {
    if (merged.length > 0) merged[merged.length - 1] += buffer.trim();
    else merged.push(buffer.trim());
  }

  return merged;
}

function limitReplyLine(line: string): string {
  const cleaned = line.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 42) return cleaned;

  const cut = cleaned.slice(0, 42);
  const lastPunc = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('。'), cut.lastIndexOf('？'), cut.lastIndexOf('！'));
  if (lastPunc >= 12) return cut.slice(0, lastPunc + 1);
  return cut;
}

function dedupeAdjacent(lines: string[]): string[] {
  const result: string[] = [];
  for (const line of lines) {
    if (result[result.length - 1] !== line) result.push(line);
  }
  return result;
}

function isLowInformation(line: string): boolean {
  return /^(嗯+|哦+|好+|行+|对+|是啊|哈哈+|呜呜+|知道了|可以吧|随便吧)$/i.test(line.trim());
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
