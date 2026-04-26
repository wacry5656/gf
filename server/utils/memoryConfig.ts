/**
 * 记忆系统全局配置中心
 *
 * 所有参数从环境变量读取，带合理默认值。
 * 其他模块统一通过此处获取配置，避免硬编码散落。
 */

function num(key: string, fallback: number): number {
  const v = process.env[key];
  return v !== undefined && v !== '' ? Number(v) : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
}

export const memoryConfig = {
  // ---- 检索参数 ----
  get topK() { return num('MEMORY_TOP_K', 5); },
  get coreMemoryLimit() { return num('MEMORY_CORE_LIMIT', 4); },
  get recentMessageLimit() { return num('RECENT_MESSAGE_LIMIT', 20); },
  get maxPromptTokens() { return num('CONTEXT_MAX_TOKENS', 5200); },
  get systemTokenBudget() { return num('CONTEXT_SYSTEM_TOKENS', 1900); },
  get recentTokenBudget() { return num('CONTEXT_RECENT_TOKENS', 1800); },
  get singleMessageTokenBudget() { return num('CONTEXT_SINGLE_MESSAGE_TOKENS', 260); },
  get summaryTokenBudget() { return num('CONTEXT_SUMMARY_TOKENS', 360); },
  get memoryTokenBudget() { return num('CONTEXT_MEMORY_TOKENS', 850); },
  get maxCandidates() { return num('MEMORY_RE_RANK_CANDIDATES', 20); },
  get recallThreshold() { return num('MEMORY_RECALL_THRESHOLD', 0.35); },
  get dedupThreshold() { return num('MEMORY_DEDUP_THRESHOLD', 0.88); },
  get maxContextChars() { return num('MEMORY_MAX_CONTEXT_CHARS', 1500); },

  // ---- 重排序权重 ----
  get semanticWeight() { return num('MEMORY_SEMANTIC_WEIGHT', 0.70); },
  get importanceWeight() { return num('MEMORY_IMPORTANCE_WEIGHT', 0.12); },
  get recencyWeight() { return num('MEMORY_RECENCY_WEIGHT', 0.10); },
  get usageWeight() { return num('MEMORY_USAGE_WEIGHT', 0.08); },
  get keywordWeight() { return num('MEMORY_KEYWORD_WEIGHT', 0.16); },
  get keywordRecallThreshold() { return num('MEMORY_KEYWORD_RECALL_THRESHOLD', 0.25); },

  // ---- Summary ----
  get summaryEnabled() { return bool('MEMORY_SUMMARY_ENABLED', true); },
  get summaryRefreshCount() { return num('MEMORY_SUMMARY_REFRESH_COUNT', 5); },

  // ---- 写入去重 ----
  get writeDedupThreshold() { return num('MEMORY_WRITE_DEDUP_THRESHOLD', 0.92); },

  // ---- 冲突更新 ----
  get enableConflictResolution() { return bool('MEMORY_ENABLE_CONFLICT_RESOLUTION', true); },

  // ---- 记忆过期（天） ----
  get stateTtlDays() { return num('MEMORY_STATE_TTL_DAYS', 7); },
  get planTtlDays() { return num('MEMORY_PLAN_TTL_DAYS', 30); },

  // ---- 调试 ----
  get debugRetrieval() { return bool('DEBUG_MEMORY_RETRIEVAL', false); },
};
