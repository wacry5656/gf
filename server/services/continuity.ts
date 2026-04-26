import db from '../db';
import { trimToTokenBudget } from '../utils/tokenBudget';

interface MemoryRow {
  text: string;
  normalized_fact_text: string | null;
  memory_type: string;
  importance: number;
  created_at: string;
}

export interface CharacterInsight {
  summary: string | null;
  memoryCount: number;
  activePlans: string[];
  recentStates: string[];
  coreMemories: string[];
}

export function getCharacterInsights(characterId: number): CharacterInsight {
  const summaryRow = db
    .prepare('SELECT content FROM memory_summaries WHERE character_id = ?')
    .get(characterId) as { content: string } | undefined;

  const memoryCountRow = db
    .prepare("SELECT COUNT(*) as count FROM memories WHERE character_id = ? AND is_active = 1 AND (expires_at IS NULL OR expires_at > datetime('now'))")
    .get(characterId) as { count: number } | undefined;

  const activePlans = selectMemoryTexts(characterId, "memory_type = 'plan'", 4);
  const recentStates = selectMemoryTexts(characterId, "memory_type = 'state'", 4);
  const coreMemories = selectMemoryTexts(
    characterId,
    "(importance >= 4 OR memory_type IN ('fact', 'relationship'))",
    6,
  );

  return {
    summary: summaryRow?.content || null,
    memoryCount: memoryCountRow?.count || 0,
    activePlans,
    recentStates,
    coreMemories,
  };
}

export function buildContinuityPrompt(characterId: number): string {
  const insights = getCharacterInsights(characterId);
  const lines: string[] = [];

  if (insights.activePlans.length > 0) {
    lines.push('未完成计划：');
    lines.push(...insights.activePlans.map((item) => `- ${item}`));
  }

  if (insights.recentStates.length > 0) {
    lines.push('近期情绪/事件：');
    lines.push(...insights.recentStates.map((item) => `- ${item}`));
  }

  if (lines.length === 0) return '';

  return `===== 连续性提示（可顺手承接，不要强行提起） =====\n${trimToTokenBudget(lines.join('\n'), 260)}\n`;
}

function selectMemoryTexts(characterId: number, whereClause: string, limit: number): string[] {
  const rows = db.prepare(
    `SELECT text, normalized_fact_text, memory_type, importance, created_at
     FROM memories
     WHERE character_id = ?
       AND is_active = 1
       AND (expires_at IS NULL OR expires_at > datetime('now'))
       AND ${whereClause}
     ORDER BY importance DESC, created_at DESC
     LIMIT ?`,
  ).all(characterId, limit) as MemoryRow[];

  return rows.map((row) => row.normalized_fact_text || row.text);
}
