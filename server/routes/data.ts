import { Router, Request, Response } from 'express';
import db from '../db';
import { readEmotionState, type Mood } from '../services/emotion';
import { readRelationshipState, type RelationshipPhase } from '../services/relationship';
import { ensureCharacterOwnership } from '../utils/ownership';
import { checkInitiativeEligibility, generateInitiativeMessage, checkLongAbsence, generateLongAbsenceGreeting, shouldTriggerRandomEvent, generateRandomEvent, triggerDueReminders, shouldSendLongAbsenceGreeting } from '../services/initiative';
import { getMemoryCount, getAllMemoryTexts, searchMemory, getCoreMemories, correctMemory } from '../services/memory';
import { getSummary } from '../services/summary';
import { getPersonalityTraits, getUserIdFromCharacter } from '../services/personality';
import { getDiaryEntries, getDiaryForDate, generateDiaryForDate } from '../services/diary';
import { getPendingReminders, getTodayDueReminders, deleteReminder } from '../services/reminder';

export const dataRouter = Router();

function userExists(userId: number): boolean {
  if (!Number.isFinite(userId) || userId <= 0) return false;
  return Boolean(db.prepare('SELECT id FROM users WHERE id = ?').get(userId));
}

function getCharacterRelationshipMode(characterId: number): 'lover' | 'friend' {
  const row = db
    .prepare('SELECT relationship_mode FROM characters WHERE id = ?')
    .get(characterId) as { relationship_mode?: string } | undefined;
  return row?.relationship_mode === 'friend' ? 'friend' : 'lover';
}

// ====== 角色管理 ======

// 获取用户的所有角色
dataRouter.get('/characters', (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) { res.status(400).json({ error: '缺少 userId' }); return; }
    const numericUserId = Number(userId);
    if (!userExists(numericUserId)) {
      res.status(401).json({ error: '登录已失效，请重新登录' });
      return;
    }

    const characters = db.prepare(
      `SELECT id, name, gender, user_gender AS userGender, relationship_mode AS relationshipMode,
              personality, description, created_at
       FROM characters
       WHERE user_id = ?
       ORDER BY created_at DESC`
    ).all(numericUserId);

    res.json({ characters });
  } catch (err: any) {
    console.error('Get characters error:', err?.message);
    res.status(500).json({ error: '获取角色失败' });
  }
});

// 创建角色
dataRouter.post('/characters', (req: Request, res: Response) => {
  try {
    const { userId, name, gender, userGender, relationshipMode, personality, description } = req.body;
    if (!userId || !name) { res.status(400).json({ error: '参数不完整' }); return; }
    const numericUserId = Number(userId);
    if (!userExists(numericUserId)) {
      res.status(401).json({ error: '登录已失效，请重新登录' });
      return;
    }

    const result = db.prepare(
      `INSERT INTO characters
         (user_id, name, gender, user_gender, relationship_mode, personality, description)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      numericUserId,
      name,
      gender || 'female',
      userGender || 'male',
      relationshipMode || 'lover',
      personality || '',
      description || '',
    );

    res.json({ characterId: result.lastInsertRowid });
  } catch (err: any) {
    console.error('Create character error:', err?.message);
    res.status(500).json({ error: '创建角色失败' });
  }
});

// 删除角色（连带删除聊天记录、记忆、摘要）
dataRouter.delete('/characters/:id', (req: Request, res: Response) => {
  try {
    const charId = Number(req.params.id);
    const userId = req.query.userId ? Number(req.query.userId) : null;

    if (!charId || isNaN(charId)) {
      res.status(400).json({ error: '无效的角色 ID' });
      return;
    }

    if (!userId) {
      res.status(400).json({ error: '缺少 userId 参数' });
      return;
    }

    // 验证角色存在且属于当前用户
    const character = db.prepare(
      'SELECT id, user_id FROM characters WHERE id = ?'
    ).get(charId) as { id: number; user_id: number } | undefined;

    if (!character) {
      // 角色已不存在，返回合理响应（幂等）
      console.warn(`[DeleteCharacter] charId=${charId} 已不存在`);
      res.json({ success: true, deletedId: charId, message: '角色已不存在' });
      return;
    }

    if (character.user_id !== userId) {
      res.status(403).json({ error: '无权删除该角色' });
      return;
    }

    // 使用事务确保级联删除的原子性
    // 按依赖顺序先删所有引用 character_id 的表数据
    const deleteAll = db.transaction(() => {
      db.prepare('DELETE FROM chat_messages WHERE character_id = ?').run(charId);
      db.prepare('DELETE FROM memories WHERE character_id = ?').run(charId);
      db.prepare('DELETE FROM memory_summaries WHERE character_id = ?').run(charId);
      db.prepare('DELETE FROM emotion_state WHERE character_id = ?').run(charId);
      db.prepare('DELETE FROM relationship_state WHERE character_id = ?').run(charId);
      db.prepare('DELETE FROM initiative_log WHERE character_id = ?').run(charId);
      db.prepare('DELETE FROM diary_entries WHERE character_id = ?').run(charId);
      db.prepare('DELETE FROM reminders WHERE character_id = ?').run(charId);
      db.prepare('DELETE FROM emotion_snapshots WHERE character_id = ?').run(charId);
      // 删除角色记录（额外检查 user_id 作为安全防护，防止 TOCTOU 竞态）
      const result = db.prepare('DELETE FROM characters WHERE id = ? AND user_id = ?').run(charId, userId);
      // 如果用户已无其他角色，清理其 personality_memory
      if (result.changes > 0) {
        const remaining = db.prepare('SELECT COUNT(*) as cnt FROM characters WHERE user_id = ?').get(userId) as { cnt: number };
        if (remaining.cnt === 0) {
          db.prepare('DELETE FROM personality_memory WHERE user_id = ?').run(userId);
        }
      }
      return result;
    });

    const result = deleteAll();

    if (result.changes === 0) {
      res.status(500).json({ error: '删除角色失败，请重试' });
      return;
    }

    res.json({ success: true, deletedId: charId });
  } catch (err: any) {
    if (err?.message?.includes('FOREIGN KEY constraint failed')) {
      console.error(`[DeleteCharacter] 外键约束失败: ${err.message}`);
      res.status(500).json({ error: '删除角色失败：存在关联数据未清理，请联系管理员' });
      return;
    }
    console.error('Delete character error:', err?.message);
    res.status(500).json({ error: '删除角色失败' });
  }
});

// ====== 聊天记录管理 ======

// 获取某角色的聊天记录
dataRouter.get('/messages/:characterId', (req: Request, res: Response) => {
  try {
    const characterId = Number(req.params.characterId);
    const userId = req.query.userId ? Number(req.query.userId) : NaN;

    const { ok } = ensureCharacterOwnership(characterId, userId, res);
    if (!ok) return;

    const messages = db.prepare(
      'SELECT role, content FROM chat_messages WHERE character_id = ? ORDER BY id ASC'
    ).all(characterId);

    res.json({ messages });
  } catch (err: any) {
    console.error('Get messages error:', err?.message);
    // 读取消息失败时返回空数组而不是崩溃（可能是脏数据/旧角色）
    res.json({ messages: [] });
  }
});

// 追加一条消息
dataRouter.post('/messages', (req: Request, res: Response) => {
  try {
    const { characterId, role, content, userId } = req.body;
    if (!characterId || !role || !content) {
      res.status(400).json({ error: '参数不完整' });
      return;
    }

    // 归属校验（userId 必传）
    if (!userId) {
      res.status(401).json({ error: '请重新登录（缺少用户身份）' });
      return;
    }

    // 先检查角色是否存在，避免外键约束错误
    const character = db.prepare('SELECT id, user_id FROM characters WHERE id = ?').get(Number(characterId)) as { id: number; user_id: number } | undefined;
    if (!character) {
      console.warn(`[SaveMessage] characterId=${characterId} 不存在，跳过保存`);
      res.status(404).json({ error: '角色不存在，消息未保存' });
      return;
    }

    if (character.user_id !== Number(userId)) {
      console.warn(`[SaveMessage] 角色归属校验失败: characterId=${characterId}, userId=${userId}, owner=${character.user_id}`);
      res.status(403).json({ error: '无权操作该角色' });
      return;
    }

    db.prepare(
      'INSERT INTO chat_messages (character_id, role, content) VALUES (?, ?, ?)'
    ).run(characterId, role, content);

    res.json({ success: true });
  } catch (err: any) {
    // 捕获外键约束错误并返回友好提示
    if (err?.message?.includes('FOREIGN KEY constraint failed')) {
      console.error('[SaveMessage] 外键约束失败，角色可能已被删除:', err.message);
      res.status(409).json({ error: '角色已被删除，消息无法保存' });
      return;
    }
    console.error('Save message error:', err?.message);
    res.status(500).json({ error: '保存消息失败' });
  }
});

// 清空某角色的聊天记录
dataRouter.delete('/messages/:characterId', (req: Request, res: Response) => {
  try {
    const characterId = Number(req.params.characterId);
    const userId = req.query.userId ? Number(req.query.userId) : NaN;

    const { ok } = ensureCharacterOwnership(characterId, userId, res);
    if (!ok) return;

    db.prepare('DELETE FROM chat_messages WHERE character_id = ?').run(characterId);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Clear messages error:', err?.message);
    res.status(500).json({ error: '清空聊天记录失败' });
  }
});

// 撤回最后一条消息
dataRouter.delete('/messages/:characterId/last', (req: Request, res: Response) => {
  try {
    const characterId = Number(req.params.characterId);
    const userId = req.query.userId ? Number(req.query.userId) : NaN;
    const role = (req.query.role as string) || 'user';

    const { ok } = ensureCharacterOwnership(characterId, userId, res);
    if (!ok) return;

    const lastMsg = db.prepare(
      'SELECT id FROM chat_messages WHERE character_id = ? AND role = ? ORDER BY id DESC LIMIT 1'
    ).get(characterId, role) as { id: number } | undefined;

    if (!lastMsg) {
      res.status(404).json({ error: '没有可撤回的消息' });
      return;
    }

    db.prepare('DELETE FROM chat_messages WHERE id = ?').run(lastMsg.id);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Recall message error:', err?.message);
    res.status(500).json({ error: '撤回消息失败' });
  }
});

// ====== 情绪状态 ======

const MOOD_LABEL: Record<string, string> = {
  warm: '温柔',
  happy: '开心',
  playful: '俏皮',
  shy: '害羞',
  caring: '体贴',
  upset: '有点委屈',
  jealous: '吃醋',
  distant: '有点冷淡',
  sulking: '生闷气',
  disappointed: '小失望',
  anticipating: '期待',
};

dataRouter.get('/emotion/:characterId', (req: Request, res: Response) => {
  try {
    const characterId = Number(req.params.characterId);
    const userId = req.query.userId ? Number(req.query.userId) : NaN;

    const { ok } = ensureCharacterOwnership(characterId, userId, res);
    if (!ok) return;

    // 只读获取，不隐式创建
    const state = readEmotionState(userId, characterId);
    const relationshipMode = getCharacterRelationshipMode(characterId);
    if (!state) {
      res.json({
        mood: 'warm',
        moodLabel: MOOD_LABEL['warm'],
        affection: relationshipMode === 'friend' ? 0.38 : 0.68,
        trust_score: relationshipMode === 'friend' ? 0.52 : 0.58,
        jealousy_score: 0,
        anger_score: 0,
      });
      return;
    }

    res.json({
      mood: state.mood,
      moodLabel: MOOD_LABEL[state.mood || 'warm'] || '温柔',
      affection: state.affection,
      trust_score: state.trust_score,
      jealousy_score: state.jealousy_score,
      anger_score: state.anger_score ?? 0,
    });
  } catch (err: any) {
    console.error('Get emotion error:', err?.message);
    res.status(500).json({ error: '获取情绪状态失败' });
  }
});

dataRouter.get('/emotion-history/:characterId', (req: Request, res: Response) => {
  try {
    const characterId = Number(req.params.characterId);
    const userId = req.query.userId ? Number(req.query.userId) : NaN;
    const days = Math.min(30, Math.max(1, Number(req.query.days) || 30));

    const { ok } = ensureCharacterOwnership(characterId, userId, res);
    if (!ok) return;

    const snapshots = db.prepare(
      `SELECT mood, affection, trust_score, jealousy_score, anger_score, created_at
       FROM emotion_snapshots
       WHERE character_id = ? AND user_id = ?
         AND created_at >= datetime('now', '-' || ? || ' days')
       ORDER BY created_at ASC`
    ).all(characterId, userId, days) as Array<{
      mood: string;
      affection: number;
      trust_score: number;
      jealousy_score: number;
      anger_score: number;
      created_at: string;
    }>;

    res.json({ snapshots });
  } catch (err: any) {
    console.error('Get emotion history error:', err?.message);
    res.status(500).json({ error: '获取情绪历史失败' });
  }
});

// ====== 关系状态 ======

const PHASE_LABEL: Record<string, string> = {
  close: '熟悉',
  attached: '亲近',
  deep_attached: '深度依恋',
  strained: '有点别扭',
};

dataRouter.get('/relationship/:characterId', (req: Request, res: Response) => {
  try {
    const characterId = Number(req.params.characterId);
    const userId = req.query.userId ? Number(req.query.userId) : NaN;

    const { ok } = ensureCharacterOwnership(characterId, userId, res);
    if (!ok) return;

    // 只读获取，不隐式创建
    const state = readRelationshipState(userId, characterId);
    const relationshipMode = getCharacterRelationshipMode(characterId);
    if (!state) {
      res.json({
        phase: relationshipMode === 'friend' ? 'close' : 'attached',
        phaseLabel: relationshipMode === 'friend' ? PHASE_LABEL['close'] : PHASE_LABEL['attached'],
        closeness: relationshipMode === 'friend' ? 0.42 : 0.68,
        trust: relationshipMode === 'friend' ? 0.52 : 0.58,
        dependence: relationshipMode === 'friend' ? 0.18 : 0.48,
        comfort_level: relationshipMode === 'friend' ? 0.56 : 0.68,
      });
      return;
    }

    res.json({
      phase: state.phase,
      phaseLabel: PHASE_LABEL[(state.phase as RelationshipPhase) || 'close'],
      closeness: state.closeness,
      trust: state.trust,
      dependence: state.dependence,
      comfort_level: state.comfort_level,
    });
  } catch (err: any) {
    console.error('Get relationship error:', err?.message);
    res.status(500).json({ error: '获取关系状态失败' });
  }
});

// ====== 主动消息 ======

// 检查是否可以发送主动消息
 dataRouter.get('/unread-initiative/:characterId', (req: Request, res: Response) => {
  try {
    const characterId = Number(req.params.characterId);
    const userId = req.query.userId ? Number(req.query.userId) : NaN;

    const { ok } = ensureCharacterOwnership(characterId, userId, res);
    if (!ok) return;

    const sessionCount = Number(req.query.sessionCount || 0);
    const eligibility = checkInitiativeEligibility(characterId, sessionCount);

    res.json(eligibility);
  } catch (err: any) {
    console.error('Check initiative error:', err?.message);
    res.status(500).json({ eligible: false, reason: '检查失败' });
  }
});

// 生成主动消息
 dataRouter.post('/initiative/:characterId', async (req: Request, res: Response) => {
  try {
    const characterId = Number(req.params.characterId);
    const userId = req.query.userId ? Number(req.query.userId) : NaN;

    const { ok } = ensureCharacterOwnership(characterId, userId, res);
    if (!ok) return;

    const { character, messages } = req.body;
    if (!character || !messages) {
      res.status(400).json({ error: '参数不完整' });
      return;
    }

    const replies = await generateInitiativeMessage(character, messages, characterId);
    res.json({ replies });
  } catch (err: any) {
    console.error('Generate initiative error:', err?.message);
    res.status(500).json({ error: '生成主动消息失败' });
  }
});

dataRouter.post('/random-event/:characterId', async (req: Request, res: Response) => {
  try {
    const characterId = Number(req.params.characterId);
    const userId = req.query.userId ? Number(req.query.userId) : NaN;

    const { ok } = ensureCharacterOwnership(characterId, userId, res);
    if (!ok) return;

    const dueReminderReplies = triggerDueReminders(characterId);
    if (dueReminderReplies.length > 0) {
      res.json({ triggered: true, replies: dueReminderReplies });
      return;
    }

    if (!shouldTriggerRandomEvent(characterId)) {
      res.json({ triggered: false, replies: [] });
      return;
    }

    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(characterId) as any;
    if (!character) {
      res.json({ triggered: false, replies: [] });
      return;
    }

    const replies = await generateRandomEvent(character, characterId);
    res.json({ triggered: true, replies });
  } catch (err: any) {
    console.error('Random event error:', err?.message);
    res.status(500).json({ error: '随机事件生成失败' });
  }
});

dataRouter.get('/long-absence/:characterId', async (req: Request, res: Response) => {
  try {
    const characterId = Number(req.params.characterId);
    const userId = req.query.userId ? Number(req.query.userId) : NaN;

    const { ok } = ensureCharacterOwnership(characterId, userId, res);
    if (!ok) return;

    const { absent, daysSince } = checkLongAbsence(characterId);
    if (!absent || !shouldSendLongAbsenceGreeting(characterId)) {
      res.json({ absent: false, greeting: [] });
      return;
    }

    const character = db.prepare('SELECT * FROM characters WHERE id = ?').get(characterId) as any;
    if (!character) {
      res.json({ absent: false, greeting: [] });
      return;
    }

    const greeting = await generateLongAbsenceGreeting(character, characterId, daysSince);
    res.json({ absent: true, daysSince, greeting });
  } catch (err: any) {
    console.error('Long absence error:', err?.message);
    res.status(500).json({ error: '久别寒暄失败' });
  }
});

// ====== 记忆可视化 ======

// 获取某角色的记忆列表
 dataRouter.get('/memories/:characterId', (req: Request, res: Response) => {
  try {
    const characterId = Number(req.params.characterId);
    const userId = req.query.userId ? Number(req.query.userId) : NaN;

    const { ok } = ensureCharacterOwnership(characterId, userId, res);
    if (!ok) return;

    const rows = db.prepare(
      `SELECT id, text, raw_text, memory_type, importance, keywords, hit_count, created_at
       FROM memories
       WHERE character_id = ? AND is_active = 1
         AND (expires_at IS NULL OR expires_at > datetime('now'))
       ORDER BY importance DESC, created_at DESC`
    ).all(characterId);

    res.json({ memories: rows });
  } catch (err: any) {
    console.error('Get memories error:', err?.message);
    res.status(500).json({ error: '获取记忆失败' });
  }
});

// 更正单条记忆
dataRouter.post('/memories/:memoryId/correct', async (req: Request, res: Response) => {
  try {
    const memoryId = Number(req.params.memoryId);
    const userId = req.query.userId ? Number(req.query.userId) : NaN;
    const correctedText = typeof req.body?.text === 'string' ? req.body.text.trim() : '';

    if (!memoryId || isNaN(memoryId)) {
      res.status(400).json({ error: '无效的记忆 ID' });
      return;
    }

    if (!correctedText) {
      res.status(400).json({ error: '更正后的记忆不能为空' });
      return;
    }

    const memory = db.prepare('SELECT character_id, is_active FROM memories WHERE id = ?').get(memoryId) as
      | { character_id: number; is_active: number }
      | undefined;

    if (!memory) {
      res.status(404).json({ error: '记忆不存在' });
      return;
    }

    if (!memory.is_active) {
      res.status(400).json({ error: '记忆已失效，无法更正' });
      return;
    }

    const { ok } = ensureCharacterOwnership(memory.character_id, userId, res);
    if (!ok) return;

    await correctMemory(memory.character_id, memoryId, correctedText, { role: 'user' });
    res.json({ success: true });
  } catch (err: any) {
    console.error('Correct memory error:', err?.message);
    res.status(500).json({ error: '更正记忆失败' });
  }
});

// 删除单条记忆
 dataRouter.delete('/memories/:memoryId', (req: Request, res: Response) => {
  try {
    const memoryId = Number(req.params.memoryId);
    const userId = req.query.userId ? Number(req.query.userId) : NaN;

    if (!memoryId || isNaN(memoryId)) {
      res.status(400).json({ error: '无效的记忆 ID' });
      return;
    }

    // 先查出 memory 对应的 character_id，再做归属校验
    const memory = db.prepare('SELECT character_id FROM memories WHERE id = ?').get(memoryId) as
      | { character_id: number }
      | undefined;

    if (!memory) {
      res.status(404).json({ error: '记忆不存在' });
      return;
    }

    const { ok } = ensureCharacterOwnership(memory.character_id, userId, res);
    if (!ok) return;

    db.prepare('UPDATE memories SET is_active = 0, updated_at = datetime(\'now\') WHERE id = ?').run(memoryId);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Delete memory error:', err?.message);
    res.status(500).json({ error: '删除记忆失败' });
  }
});

// 获取用户画像摘要
 dataRouter.get('/summary/:characterId', (req: Request, res: Response) => {
  try {
    const characterId = Number(req.params.characterId);
    const userId = req.query.userId ? Number(req.query.userId) : NaN;

    const { ok } = ensureCharacterOwnership(characterId, userId, res);
    if (!ok) return;

    const summary = getSummary(characterId);
    const memoryCount = getMemoryCount(characterId);

    res.json({ summary: summary || '', memoryCount });
  } catch (err: any) {
    console.error('Get summary error:', err?.message);
    res.status(500).json({ error: '获取摘要失败' });
  }
});

// 获取人格特征
 dataRouter.get('/personality/:characterId', (req: Request, res: Response) => {
  try {
    const characterId = Number(req.params.characterId);
    const userId = req.query.userId ? Number(req.query.userId) : NaN;

    const { ok } = ensureCharacterOwnership(characterId, userId, res);
    if (!ok) return;

    const charUserId = getUserIdFromCharacter(characterId);
    if (!charUserId) {
      res.json({ traits: [] });
      return;
    }

    const traits = getPersonalityTraits(charUserId);
    res.json({ traits });
  } catch (err: any) {
    console.error('Get personality error:', err?.message);
    res.status(500).json({ error: '获取人格特征失败' });
  }
});

// ====== 日记 ======

 dataRouter.get('/diary/:characterId', (req: Request, res: Response) => {
  try {
    const characterId = Number(req.params.characterId);
    const userId = req.query.userId ? Number(req.query.userId) : NaN;

    const { ok } = ensureCharacterOwnership(characterId, userId, res);
    if (!ok) return;

    const entries = getDiaryEntries(characterId, 30);
    res.json({ entries });
  } catch (err: any) {
    console.error('Get diary error:', err?.message);
    res.status(500).json({ error: '获取日记失败' });
  }
});

 dataRouter.get('/diary/:characterId/:date', async (req: Request, res: Response) => {
  try {
    const characterId = Number(req.params.characterId);
    const dateStr = String(req.params.date);
    const userId = req.query.userId ? Number(req.query.userId) : NaN;

    const { ok } = ensureCharacterOwnership(characterId, userId, res);
    if (!ok) return;

    let content = getDiaryForDate(characterId, dateStr);
    if (!content) {
      content = await generateDiaryForDate(characterId, dateStr);
    }

    res.json({ date: dateStr, content: content || '' });
  } catch (err: any) {
    console.error('Get diary date error:', err?.message);
    res.status(500).json({ error: '获取日记失败' });
  }
});

// ====== 提醒 ======

 dataRouter.get('/reminders/:characterId', (req: Request, res: Response) => {
  try {
    const characterId = Number(req.params.characterId);
    const userId = req.query.userId ? Number(req.query.userId) : NaN;

    const { ok } = ensureCharacterOwnership(characterId, userId, res);
    if (!ok) return;

    const reminders = getPendingReminders(characterId);
    res.json({ reminders });
  } catch (err: any) {
    console.error('Get reminders error:', err?.message);
    res.status(500).json({ error: '获取提醒失败' });
  }
});

 dataRouter.delete('/reminders/:reminderId', (req: Request, res: Response) => {
  try {
    const reminderId = Number(req.params.reminderId);
    const userId = req.query.userId ? Number(req.query.userId) : NaN;

    const reminder = db.prepare('SELECT character_id FROM reminders WHERE id = ?').get(reminderId) as
      | { character_id: number }
      | undefined;
    if (!reminder) {
      res.status(404).json({ error: '提醒不存在' });
      return;
    }

    const { ok } = ensureCharacterOwnership(reminder.character_id, userId, res);
    if (!ok) return;

    deleteReminder(reminderId);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Delete reminder error:', err?.message);
    res.status(500).json({ error: '删除提醒失败' });
  }
});

// ====== 聊天记录搜索 ======

 dataRouter.get('/search/:characterId', (req: Request, res: Response) => {
  try {
    const characterId = Number(req.params.characterId);
    const userId = req.query.userId ? Number(req.query.userId) : NaN;
    const q = (req.query.q as string || '').trim();

    const { ok } = ensureCharacterOwnership(characterId, userId, res);
    if (!ok) return;

    if (!q || q.length < 1) {
      res.json({ results: [] });
      return;
    }

    const results = db.prepare(
      `SELECT role, content, created_at
       FROM chat_messages
       WHERE character_id = ? AND content LIKE '%' || ? || '%'
       ORDER BY id DESC
       LIMIT 50`
    ).all(characterId, q) as Array<{ role: string; content: string; created_at: string }>;

    res.json({ results: results.reverse() });
  } catch (err: any) {
    console.error('Search error:', err?.message);
    res.status(500).json({ error: '搜索失败' });
  }
});

// ====== 聊天统计 ======

 dataRouter.get('/stats/:characterId', (req: Request, res: Response) => {
  try {
    const characterId = Number(req.params.characterId);
    const userId = req.query.userId ? Number(req.query.userId) : NaN;

    const { ok } = ensureCharacterOwnership(characterId, userId, res);
    if (!ok) return;

    // 总消息数
    const totalRow = db.prepare(
      "SELECT COUNT(*) as total, SUM(CASE WHEN role='user' THEN 1 ELSE 0 END) as user_count, SUM(CASE WHEN role='assistant' THEN 1 ELSE 0 END) as assistant_count FROM chat_messages WHERE character_id = ?"
    ).get(characterId) as { total: number; user_count: number; assistant_count: number };

    // 今日消息数
    const todayRow = db.prepare(
      "SELECT COUNT(*) as today FROM chat_messages WHERE character_id = ? AND date(created_at) = date('now')"
    ).get(characterId) as { today: number };

    // 平均消息长度
    const avgLenRow = db.prepare(
      "SELECT AVG(LENGTH(content)) as avg_len FROM chat_messages WHERE character_id = ? AND role = 'assistant'"
    ).get(characterId) as { avg_len: number };

    // 最近7天消息数
    const weeklyRows = db.prepare(
      `SELECT date(created_at) as day, COUNT(*) as count
       FROM chat_messages
       WHERE character_id = ? AND created_at >= datetime('now', '-7 days')
       GROUP BY date(created_at)
       ORDER BY day ASC`
    ).all(characterId) as Array<{ day: string; count: number }>;

    // 最常出现的词（简单分词，只取2字以上中文词）
    const allContent = db.prepare(
      "SELECT content FROM chat_messages WHERE character_id = ? AND role = 'user'"
    ).all(characterId) as Array<{ content: string }>;

    const wordCount = new Map<string, number>();
    for (const row of allContent) {
      const matches = row.content.match(/[\u4e00-\u9fff]{2,8}/g);
      if (matches) {
        for (const word of matches) {
          if (word.length >= 2 && !/^(这个|那个|就是|然后|但是|因为|所以|如果|还是|可以|没有|不是|什么|怎么|觉得|感觉|今天|昨天|最近|一下|一点|真的|有点|比较|还是|时候|我们|你们|他们|自己|知道|认为|觉得|一下)$/.test(word)) {
            wordCount.set(word, (wordCount.get(word) || 0) + 1);
          }
        }
      }
    }
    const topWords = Array.from(wordCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([word, count]) => ({ word, count }));

    // 第一条消息时间
    const firstRow = db.prepare(
      'SELECT created_at FROM chat_messages WHERE character_id = ? ORDER BY id ASC LIMIT 1'
    ).get(characterId) as { created_at: string } | undefined;

    res.json({
      totalMessages: totalRow.total || 0,
      userMessages: totalRow.user_count || 0,
      assistantMessages: totalRow.assistant_count || 0,
      todayMessages: todayRow.today || 0,
      avgReplyLength: Math.round(avgLenRow.avg_len || 0),
      weeklyActivity: weeklyRows,
      topWords,
      firstChatDate: firstRow?.created_at || null,
    });
  } catch (err: any) {
    console.error('Get stats error:', err?.message);
    res.status(500).json({ error: '获取统计失败' });
  }
});
