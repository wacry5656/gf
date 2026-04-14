/**
 * 记忆检索调试日志
 *
 * DEBUG_MEMORY_RETRIEVAL=true 时输出可读的检索过程日志
 */
import { memoryConfig } from './memoryConfig';

export interface MemoryDebugEntry {
  id: number;
  text: string;
  memoryType: string;
  relationshipSubtype: string | null;
  invalidationReason: string | null;
  semanticScore: number;
  importanceScore: number;
  recencyScore: number;
  usageScore: number;
  lengthPenalty: number;
  finalScore: number;
  hitCount: number;
  isActive: boolean;
}

export interface MemoryDebugContext {
  userInput: string;
  recentCount: number;
  summaryEnabled: boolean;
  summaryHit: boolean;
  summaryLength: number;
  candidateCount: number;
  prerankEntries: MemoryDebugEntry[];
  postrankEntries: MemoryDebugEntry[];
  dedupRemoved: number;
  finalMemoryCount: number;
  totalContextChars: number;
  contextParts: string[];
}

function enabled(): boolean {
  return memoryConfig.debugRetrieval;
}

function formatEntry(e: MemoryDebugEntry): string {
  const preview = e.text.length > 40 ? e.text.slice(0, 40) + '...' : e.text;
  const subtype = e.relationshipSubtype ? ` sub=${e.relationshipSubtype}` : '';
  const invalidation = e.invalidationReason ? ` inv=${e.invalidationReason}` : '';
  return `  [#${e.id}|${e.memoryType}${subtype}${invalidation}] sem=${e.semanticScore.toFixed(3)} imp=${e.importanceScore.toFixed(2)} rec=${e.recencyScore.toFixed(2)} use=${e.usageScore.toFixed(2)} len=${e.lengthPenalty} hits=${e.hitCount} → final=${e.finalScore.toFixed(4)} | "${preview}"`;
}

export function logMemoryDebug(ctx: MemoryDebugContext): void {
  if (!enabled()) return;

  const lines: string[] = [
    '',
    '╔══════════════ MEMORY RETRIEVAL DEBUG ══════════════╗',
    `║ User input: "${ctx.userInput.length > 50 ? ctx.userInput.slice(0, 50) + '...' : ctx.userInput}"`,
    `║ Recent messages: ${ctx.recentCount}`,
    `║ Summary: enabled=${ctx.summaryEnabled} hit=${ctx.summaryHit} (${ctx.summaryLength} chars)`,
    `║ Coarse candidates: ${ctx.candidateCount}`,
    '╠═══ Pre-rerank candidates ═══',
  ];

  for (const e of ctx.prerankEntries.slice(0, 10)) {
    lines.push(formatEntry(e));
  }
  if (ctx.prerankEntries.length > 10) {
    lines.push(`  ... +${ctx.prerankEntries.length - 10} more`);
  }

  lines.push('╠═══ Post-rerank + dedup results ═══');
  for (const e of ctx.postrankEntries) {
    lines.push(formatEntry(e));
  }

  lines.push(`║ Dedup removed: ${ctx.dedupRemoved}`);
  lines.push(`║ Final memories: ${ctx.finalMemoryCount}`);
  lines.push(`║ Total context chars (summary+memories): ${ctx.totalContextChars}`);
  lines.push(`║ Context parts: [${ctx.contextParts.join(', ')}]`);
  lines.push('╚═══════════════════════════════════════════════════╝');
  lines.push('');

  console.log(lines.join('\n'));
}

/**
 * 快速创建空的调试上下文
 */
export function createDebugContext(userInput: string): MemoryDebugContext {
  return {
    userInput,
    recentCount: 0,
    summaryEnabled: memoryConfig.summaryEnabled,
    summaryHit: false,
    summaryLength: 0,
    candidateCount: 0,
    prerankEntries: [],
    postrankEntries: [],
    dedupRemoved: 0,
    finalMemoryCount: 0,
    totalContextChars: 0,
    contextParts: [],
  };
}
