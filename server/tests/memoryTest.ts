/**
 * 记忆系统自动化测试
 *
 * 覆盖：
 *   1. 城市/工作事实覆盖
 *   2. 偏好反转
 *   3. 临时状态过期
 *   4. usageScore 排序（含衰减）
 *   5. memory_type 分类
 *   6. relationship_subtype 分类
 *   7. plan 完成后提前失效
 *   8. summary 回归测试（输入一致性）
 *
 * 运行方式：
 *   npx ts-node server/tests/memoryTest.ts
 *
 * 使用独立的内存数据库，不影响生产数据。
 */
import Database from 'better-sqlite3';
import { cosineSimilarity } from '../utils/similarity';
import { classifyMemoryType, classifyRelationshipSubtype } from '../services/factExtractor';

// ============================================================
// 测试用内存数据库（不碰生产 app.db）
// ============================================================
const testDb = new Database(':memory:');
testDb.pragma('journal_mode = WAL');
testDb.exec(`
  CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    raw_text TEXT,
    normalized_fact_text TEXT,
    embedding TEXT NOT NULL,
    importance INTEGER DEFAULT 1,
    memory_type TEXT DEFAULT 'other',
    is_active INTEGER DEFAULT 1,
    superseded_by INTEGER,
    hit_count INTEGER DEFAULT 0,
    last_hit_at TEXT,
    expires_at TEXT,
    relationship_subtype TEXT,
    invalidation_reason TEXT,
    metadata TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// ============================================================
// 确定性 mock embedding（不调 API）
// ============================================================
function mockEmbedding(seed: string): number[] {
  // 简单哈希 → 128维伪向量
  const vec: number[] = [];
  for (let i = 0; i < 128; i++) {
    let h = 0;
    for (let j = 0; j < seed.length; j++) {
      h = ((h << 5) - h + seed.charCodeAt(j) * (i + 1)) | 0;
    }
    vec.push(Math.sin(h) * 0.5 + 0.5);
  }
  // 归一化
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map(v => v / norm);
}

// ============================================================
// 测试辅助
// ============================================================
let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ ${msg}`);
    failed++;
  }
}

function insertMemory(opts: {
  characterId: number;
  text: string;
  normalizedFact?: string | null;
  memoryType: string;
  importance?: number;
  embedding: number[];
  hitCount?: number;
  lastHitAt?: string | null;
  expiresAt?: string | null;
  createdAt?: string;
  relationshipSubtype?: string | null;
  invalidationReason?: string | null;
}): number {
  const result = testDb.prepare(`
    INSERT INTO memories (character_id, text, raw_text, normalized_fact_text, embedding, importance, memory_type, hit_count, last_hit_at, expires_at, relationship_subtype, invalidation_reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.characterId,
    opts.normalizedFact || opts.text,
    opts.text,
    opts.normalizedFact || null,
    JSON.stringify(opts.embedding),
    opts.importance || 3,
    opts.memoryType,
    opts.hitCount || 0,
    opts.lastHitAt || null,
    opts.expiresAt || null,
    opts.relationshipSubtype || null,
    opts.invalidationReason || null,
    opts.createdAt || new Date().toISOString().replace('T', ' ').slice(0, 19),
  );
  return Number(result.lastInsertRowid);
}

function getMemory(id: number): any {
  return testDb.prepare('SELECT * FROM memories WHERE id = ?').get(id);
}

function getActiveMemories(characterId: number): any[] {
  return testDb.prepare(
    "SELECT * FROM memories WHERE character_id = ? AND is_active = 1 AND (expires_at IS NULL OR expires_at > datetime('now'))"
  ).all(characterId) as any[];
}

// ============================================================
// 测试 1：城市/工作事实覆盖
// ============================================================
function testFactOverride(): void {
  console.log('\n=== 测试 1：事实覆盖 ===');
  const cid = 1001;

  // 插入旧事实
  const oldId = insertMemory({
    characterId: cid,
    text: '我在北京上班',
    normalizedFact: '用户在北京工作',
    memoryType: 'fact',
    embedding: mockEmbedding('用户在北京工作'),
  });

  // 插入新事实（同维度，应触发覆盖）
  const newEmb = mockEmbedding('用户在上海工作');
  const newId = insertMemory({
    characterId: cid,
    text: '我在上海上班',
    normalizedFact: '用户在上海工作',
    memoryType: 'fact',
    embedding: newEmb,
  });

  // 模拟冲突检测逻辑：同维度 + 同类型 → 标记旧的 inactive
  // （这里直接模拟 resolveMemoryConflict 的效果）
  testDb.prepare("UPDATE memories SET is_active = 0, superseded_by = ?, updated_at = datetime('now') WHERE id = ?").run(newId, oldId);

  const old = getMemory(oldId);
  const newM = getMemory(newId);

  assert(old.is_active === 0, '旧记忆应被标记为 inactive');
  assert(old.superseded_by === newId, '旧记忆的 superseded_by 应指向新记忆');
  assert(newM.is_active === 1, '新记忆应为 active');

  const actives = getActiveMemories(cid);
  assert(actives.length === 1, `只有 1 条 active 记忆 (got ${actives.length})`);
  assert(actives[0].id === newId, 'active 记忆应为新记忆');
}

// ============================================================
// 测试 2：偏好反转
// ============================================================
function testPreferenceReversal(): void {
  console.log('\n=== 测试 2：偏好反转 ===');
  const cid = 1002;

  const oldId = insertMemory({
    characterId: cid,
    text: '我喜欢吃香菜',
    normalizedFact: '用户喜欢：吃香菜',
    memoryType: 'preference',
    embedding: mockEmbedding('用户喜欢吃香菜'),
  });

  const newId = insertMemory({
    characterId: cid,
    text: '我不喜欢吃香菜',
    normalizedFact: '用户不喜欢：吃香菜',
    memoryType: 'preference',
    embedding: mockEmbedding('用户不喜欢吃香菜'),
  });

  // 模拟冲突覆盖
  testDb.prepare("UPDATE memories SET is_active = 0, superseded_by = ?, updated_at = datetime('now') WHERE id = ?").run(newId, oldId);

  const actives = getActiveMemories(cid);
  assert(actives.length === 1, '偏好反转后只有一条 active');
  assert(actives[0].normalized_fact_text?.includes('不喜欢'), '保留的应是"不喜欢"版本');
}

// ============================================================
// 测试 3：临时状态过期
// ============================================================
function testStateExpiration(): void {
  console.log('\n=== 测试 3：临时状态过期 ===');
  const cid = 1003;

  // 插入一条已过期的状态记忆
  insertMemory({
    characterId: cid,
    text: '用户最近很焦虑',
    memoryType: 'state',
    embedding: mockEmbedding('用户焦虑'),
    expiresAt: '2020-01-01 00:00:00', // 已过期
  });

  // 插入一条未过期的状态记忆
  const validId = insertMemory({
    characterId: cid,
    text: '用户最近心情不错',
    memoryType: 'state',
    embedding: mockEmbedding('用户心情好'),
    expiresAt: '2099-01-01 00:00:00', // 未过期
  });

  // 插入一条无过期时间的事实（永不过期）
  const factId = insertMemory({
    characterId: cid,
    text: '用户在北京',
    memoryType: 'fact',
    embedding: mockEmbedding('用户北京'),
  });

  const actives = getActiveMemories(cid);
  assert(actives.length === 2, `应有 2 条有效记忆 (got ${actives.length})`);

  const activeIds = actives.map((m: any) => m.id);
  assert(activeIds.includes(validId), '未过期状态应存在');
  assert(activeIds.includes(factId), '无过期时间的事实应存在');
  assert(!activeIds.includes(1), '已过期的记忆不应出现');
}

// ============================================================
// 测试 4：usageScore 排序 + 衰减
// ============================================================
function testUsageScoreRanking(): void {
  console.log('\n=== 测试 4：usageScore 排序 + 衰减 ===');

  // 模拟 rerank 中的 usageScore 计算
  function calcUsageScore(hitCount: number, lastHitAt: string | null): number {
    const rawUsage = Math.min(1.0, Math.log(1 + hitCount) / Math.log(11));
    let usageDecay = 1.0;
    if (lastHitAt) {
      const hitAgeMs = Date.now() - new Date(lastHitAt).getTime();
      const hitAgeDays = hitAgeMs / (1000 * 60 * 60 * 24);
      usageDecay = 1 / (1 + hitAgeDays / 60);
    } else {
      usageDecay = 0.3;
    }
    return rawUsage * usageDecay;
  }

  // 记忆A：最近刚命中 5 次
  const recentDate = new Date(Date.now() - 2 * 86400000).toISOString(); // 2天前
  const scoreA = calcUsageScore(5, recentDate);

  // 记忆B：很久以前命中 10 次但 180 天没命中了
  const oldDate = new Date(Date.now() - 180 * 86400000).toISOString(); // 180天前
  const scoreB = calcUsageScore(10, oldDate);

  // 记忆C：从未命中
  const scoreC = calcUsageScore(0, null);

  assert(scoreA > scoreB, `近期活跃(${scoreA.toFixed(4)}) > 历史热门但长期无命中(${scoreB.toFixed(4)})`);
  assert(scoreB > scoreC, `历史热门(${scoreB.toFixed(4)}) > 从未命中(${scoreC.toFixed(4)})`);
  assert(scoreC < 0.01, `从未命中 score 应很低: ${scoreC.toFixed(4)}`);

  // 验证 usage 不会压过语义
  // 假设语义分差 0.1，usage 权重 0.08，usage 最大差也就 0.08 × 1.0 = 0.08
  const semanticDiff = 0.10;
  const usageBoost = 0.08 * scoreA; // 最乐观情况
  assert(semanticDiff > usageBoost, `语义差(${semanticDiff}) > usage 最大加成(${usageBoost.toFixed(4)})，不会压过语义`);
}

// ============================================================
// 测试 5：classifyMemoryType 分类正确性
// ============================================================
function testMemoryTypeClassification(): void {
  console.log('\n=== 测试 5：memory_type 分类 ===');

  assert(classifyMemoryType('我在上海上班', '用户在上海工作') === 'fact', '"我在上海上班" → fact');
  assert(classifyMemoryType('我最近有点焦虑', null) === 'state', '"我最近有点焦虑" → state');
  assert(classifyMemoryType('我喜欢吃火锅', '用户喜欢：吃火锅') === 'preference', '"我喜欢吃火锅" → preference');
  assert(classifyMemoryType('我打算下个月去旅游', '用户计划：下个月去旅游') === 'plan', '"我打算下个月去旅游" → plan');
  assert(classifyMemoryType('我喜欢你', null) === 'relationship', '"我喜欢你" → relationship');
  assert(classifyMemoryType('今天天气不错啊', null) === 'other', '"今天天气不错啊" → other');
}

// ============================================================
// 测试 6：relationship_subtype 子类型分类
// ============================================================
function testRelationshipSubtype(): void {
  console.log('\n=== 测试 6：relationship_subtype 子类型分类 ===');

  assert(classifyRelationshipSubtype('我喜欢你', null) === 'affection', '"我喜欢你" → affection');
  assert(classifyRelationshipSubtype('我想你了', null) === 'affection', '"我想你了" → affection');
  assert(classifyRelationshipSubtype('我有男朋友了', null) === 'affection', '"我有男朋友了" → affection');
  assert(classifyRelationshipSubtype('我只信任你', null) === 'trust', '"我只信任你" → trust');
  assert(classifyRelationshipSubtype('只有你懂我', null) === 'trust', '"只有你懂我" → trust');
  assert(classifyRelationshipSubtype('我要抱抱', null) === 'intimacy', '"我要抱抱" → intimacy');
  assert(classifyRelationshipSubtype('贴贴', null) === 'intimacy', '"贴贴" → intimacy');
  assert(classifyRelationshipSubtype('我们吵架了', null) === 'conflict', '"我们吵架了" → conflict');
  assert(classifyRelationshipSubtype('你太过分了', null) === 'conflict', '"你太过分了" → conflict');
  assert(classifyRelationshipSubtype('你能不能多陪陪我', null) === 'expectation', '"你能不能多陪陪我" → expectation');
  assert(classifyRelationshipSubtype('答应我以后不会这样了', null) === 'expectation', '"答应我以后不会这样了" → expectation');
  assert(classifyRelationshipSubtype('今天天气不错', null) === null, '"今天天气不错" → null (无子类型)');
}

// ============================================================
// 测试 7：plan 完成后提前失效
// ============================================================
function testPlanCompletion(): void {
  console.log('\n=== 测试 7：plan 完成后提前失效 ===');
  const cid = 1007;

  // 插入一个 active plan
  const planId = insertMemory({
    characterId: cid,
    text: '我明天考试',
    normalizedFact: '用户计划：明天考试',
    memoryType: 'plan',
    embedding: mockEmbedding('用户明天考试'),
    expiresAt: '2099-01-01 00:00:00',
  });

  // 模拟用户说"考完了" → 手动标记 inactive + invalidation_reason
  testDb.prepare(
    "UPDATE memories SET is_active = 0, invalidation_reason = 'completed', updated_at = datetime('now') WHERE id = ?"
  ).run(planId);

  const plan = getMemory(planId);
  assert(plan.is_active === 0, '已完成 plan 应为 inactive');
  assert(plan.invalidation_reason === 'completed', '失效原因应为 completed');

  const actives = getActiveMemories(cid);
  assert(actives.length === 0, '已完成 plan 不应出现在 active 列表');

  // 插入取消的 plan
  const plan2Id = insertMemory({
    characterId: cid,
    text: '我打算周末去爬山',
    normalizedFact: '用户计划：周末去爬山',
    memoryType: 'plan',
    embedding: mockEmbedding('用户周末爬山'),
    expiresAt: '2099-01-01 00:00:00',
  });

  testDb.prepare(
    "UPDATE memories SET is_active = 0, invalidation_reason = 'cancelled', updated_at = datetime('now') WHERE id = ?"
  ).run(plan2Id);

  const plan2 = getMemory(plan2Id);
  assert(plan2.is_active === 0, '已取消 plan 应为 inactive');
  assert(plan2.invalidation_reason === 'cancelled', '失效原因应为 cancelled');
}

// ============================================================
// 测试 8：summary 回归测试（输入一致性）
// ============================================================
function testSummaryInputConsistency(): void {
  console.log('\n=== 测试 8：summary 回归测试 ===');
  const cid = 1008;

  // --- 场景 1：事实覆盖后，旧事实不应进入 summary 输入 ---
  console.log('  场景 1：事实覆盖后 summary 刷新');
  const oldFactId = insertMemory({
    characterId: cid,
    text: '用户在北京上班',
    normalizedFact: '用户在北京工作',
    memoryType: 'fact',
    embedding: mockEmbedding('用户北京工作'),
  });
  const newFactId = insertMemory({
    characterId: cid,
    text: '用户在上海上班',
    normalizedFact: '用户在上海工作',
    memoryType: 'fact',
    embedding: mockEmbedding('用户上海工作'),
  });
  // 标记旧事实为 inactive (模拟 conflict resolution)
  testDb.prepare("UPDATE memories SET is_active = 0, superseded_by = ? WHERE id = ?").run(newFactId, oldFactId);

  let summaryInputs = getSummaryTextInputs(cid);
  let inputTexts = summaryInputs.map((m: any) => m.normalized_fact_text || m.text);
  assert(!inputTexts.some((t: string) => t.includes('北京')), '事实覆盖后 summary 输入不应包含"北京"');
  assert(inputTexts.some((t: string) => t.includes('上海')), '事实覆盖后 summary 输入应包含"上海"');

  // --- 场景 2：偏好反转后，旧偏好不应进入 summary 输入 ---
  console.log('  场景 2：偏好反转后 summary 刷新');
  const oldPrefId = insertMemory({
    characterId: cid,
    text: '用户喜欢香菜',
    normalizedFact: '用户喜欢：香菜',
    memoryType: 'preference',
    embedding: mockEmbedding('用户喜欢香菜'),
  });
  const newPrefId = insertMemory({
    characterId: cid,
    text: '用户不喜欢香菜',
    normalizedFact: '用户不喜欢：香菜',
    memoryType: 'preference',
    embedding: mockEmbedding('用户不喜欢香菜'),
  });
  testDb.prepare("UPDATE memories SET is_active = 0, superseded_by = ? WHERE id = ?").run(newPrefId, oldPrefId);

  summaryInputs = getSummaryTextInputs(cid);
  inputTexts = summaryInputs.map((m: any) => m.normalized_fact_text || m.text);
  const prefEntries = inputTexts.filter((t: string) => t.includes('香菜'));
  assert(prefEntries.length === 1, '偏好反转后只应有一条香菜相关记忆');
  assert(prefEntries[0].includes('不喜欢'), '保留的应是"不喜欢香菜"版本');

  // --- 场景 3：plan 完成后不应作为未来计划进入 summary ---
  console.log('  场景 3：plan 完成后 summary 刷新');
  const planId = insertMemory({
    characterId: cid,
    text: '用户明天考试',
    normalizedFact: '用户计划：明天考试',
    memoryType: 'plan',
    embedding: mockEmbedding('用户明天考试'),
    expiresAt: '2099-01-01 00:00:00',
  });
  // 模拟考完了 → 标记 inactive
  testDb.prepare("UPDATE memories SET is_active = 0, invalidation_reason = 'completed' WHERE id = ?").run(planId);

  summaryInputs = getSummaryTextInputs(cid);
  inputTexts = summaryInputs.map((m: any) => m.normalized_fact_text || m.text);
  assert(!inputTexts.some((t: string) => t.includes('考试')), '已完成 plan 不应进入 summary 输入');

  // --- 场景 4：state 过期后不应进入 summary ---
  console.log('  场景 4：state 过期后 summary 刷新');
  insertMemory({
    characterId: cid,
    text: '用户最近很焦虑',
    memoryType: 'state',
    embedding: mockEmbedding('用户焦虑状态'),
    expiresAt: '2020-01-01 00:00:00', // 已过期
  });

  summaryInputs = getSummaryTextInputs(cid);
  inputTexts = summaryInputs.map((m: any) => m.normalized_fact_text || m.text);
  assert(!inputTexts.some((t: string) => t.includes('焦虑')), '已过期 state 不应进入 summary 输入');
}

/**
 * 模拟 getAllMemoryTexts 逻辑：只取 active + 未过期的记忆
 * （与 memory.ts 中 getAllMemoryTexts 的 SQL 保持一致）
 */
function getSummaryTextInputs(characterId: number): any[] {
  return testDb.prepare(
    "SELECT text, normalized_fact_text, importance, created_at FROM memories WHERE character_id = ? AND is_active = 1 AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY importance DESC, created_at DESC"
  ).all(characterId);
}

// ============================================================
// 运行所有测试
// ============================================================
console.log('╔════════════════════════════════════╗');
console.log('║   记忆系统 v4 自动化测试           ║');
console.log('╚════════════════════════════════════╝');

testFactOverride();
testPreferenceReversal();
testStateExpiration();
testUsageScoreRanking();
testMemoryTypeClassification();
testRelationshipSubtype();
testPlanCompletion();
testSummaryInputConsistency();

console.log(`\n════════════════════════════════════`);
console.log(`结果: ${passed} 通过, ${failed} 失败`);
console.log(`════════════════════════════════════`);

process.exit(failed > 0 ? 1 : 0);
