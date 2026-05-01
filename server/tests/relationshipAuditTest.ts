import db from '../db';
import { auditInteraction } from '../services/interactionAudit';
import { readEmotionState, updateEmotionState } from '../services/emotion';
import { readRelationshipState, updateRelationshipState } from '../services/relationship';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${message}`);
  } else {
    failed += 1;
    console.error(`  ❌ ${message}`);
  }
}

function createFixture(mode: 'lover' | 'friend' = 'lover'): { userId: number; characterId: number } {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const user = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(`audit_${suffix}`, 'test1234');
  const userId = Number(user.lastInsertRowid);
  const char = db.prepare(
    `INSERT INTO characters (user_id, name, gender, user_gender, relationship_mode, personality, description)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, `audit-${mode}`, 'female', 'male', mode, '自然', 'test');
  return { userId, characterId: Number(char.lastInsertRowid) };
}

function cleanup(userId: number, characterId: number): void {
  db.prepare('DELETE FROM emotion_state WHERE character_id = ?').run(characterId);
  db.prepare('DELETE FROM relationship_state WHERE character_id = ?').run(characterId);
  db.prepare('DELETE FROM characters WHERE id = ?').run(characterId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

function runStateCase(input: string): { affection: number; closeness: number; trust: number } {
  const { userId, characterId } = createFixture('lover');
  try {
    updateEmotionState(userId, characterId, input, '');
    updateRelationshipState(userId, characterId, input, '');
    const emotion = readEmotionState(userId, characterId);
    const relationship = readRelationshipState(userId, characterId);
    return {
      affection: emotion?.affection ?? 0,
      closeness: relationship?.closeness ?? 0,
      trust: relationship?.trust ?? 0,
    };
  } finally {
    cleanup(userId, characterId);
  }
}

console.log('\n=== 关系审核系统回归测试 ===');

const askReassurance = auditInteraction('想我了吗', 'lover');
assert(askReassurance.primaryEvent === '索取确认', '“想我了吗”应识别为索取确认');
assert(!askReassurance.canIncreaseBond, '“想我了吗”不允许增长关系数值');

const intimateOnly = auditInteraction('我想你了', 'lover');
assert(intimateOnly.primaryEvent === '亲密表达', '单独亲密表达只记录亲密事件');
assert(!intimateOnly.canIncreaseBond, '单独亲密表达不允许增长关系数值');

const caringWithContext = auditInteraction('你今天辛苦了，我会陪你', 'lover');
assert(caringWithContext.canIncreaseBond, '带上下文的关心和陪伴允许小幅增长');

const conflict = auditInteraction('我有女朋友', 'lover');
assert(conflict.primaryEvent === '关系冲突', '“我有女朋友”应识别为关系冲突');
assert(conflict.negativeScore > conflict.positiveScore, '关系冲突的负面权重应高于正面权重');

const initialAffection = 0.68;
const initialCloseness = 0.68;
const reassuranceState = runStateCase('想我了吗');
assert(reassuranceState.affection <= initialAffection, '“想我了吗”不应提高好感');
assert(reassuranceState.closeness <= initialCloseness, '“想我了吗”不应提高亲近');

const intimateState = runStateCase('我想你了');
assert(intimateState.affection <= initialAffection, '“我想你了”不应提高好感');
assert(intimateState.closeness <= initialCloseness, '“我想你了”不应提高亲近');

const caringState = runStateCase('你今天辛苦了，我会陪你');
assert(caringState.affection > initialAffection, '真实关心可小幅提高好感');
assert(caringState.trust > 0.58, '真实关心可小幅提高信任');

const conflictState = runStateCase('我有女朋友');
assert(conflictState.affection < initialAffection, '第三者/关系冲突应降低好感');
assert(conflictState.closeness < initialCloseness, '第三者/关系冲突应降低亲近');

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
