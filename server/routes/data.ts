import { Router, Request, Response } from 'express';
import db from '../db';
import { readEmotionState, type Mood } from '../services/emotion';
import { readRelationshipState, type RelationshipPhase } from '../services/relationship';
import { ensureCharacterOwnership } from '../utils/ownership';

export const dataRouter = Router();

// ====== 角色管理 ======

// 获取用户的所有角色
dataRouter.get('/characters', (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string;
    if (!userId) { res.status(400).json({ error: '缺少 userId' }); return; }

    const characters = db.prepare(
      'SELECT id, name, gender, personality, description, created_at FROM characters WHERE user_id = ? ORDER BY created_at DESC'
    ).all(Number(userId));

    res.json({ characters });
  } catch (err: any) {
    console.error('Get characters error:', err?.message);
    res.status(500).json({ error: '获取角色失败' });
  }
});

// 创建角色
dataRouter.post('/characters', (req: Request, res: Response) => {
  try {
    const { userId, name, gender, personality, description } = req.body;
    if (!userId || !name) { res.status(400).json({ error: '参数不完整' }); return; }

    const result = db.prepare(
      'INSERT INTO characters (user_id, name, gender, personality, description) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, name, gender || 'female', personality || '', description || '');

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

// ====== 情绪状态 ======

const MOOD_LABEL: Record<Mood, string> = {
  warm: '温柔',
  happy: '开心',
  playful: '俏皮',
  shy: '害羞',
  caring: '体贴',
  upset: '有点委屈',
  jealous: '吃醋',
  distant: '有点冷淡',
};

dataRouter.get('/emotion/:characterId', (req: Request, res: Response) => {
  try {
    const characterId = Number(req.params.characterId);
    const userId = req.query.userId ? Number(req.query.userId) : NaN;

    const { ok } = ensureCharacterOwnership(characterId, userId, res);
    if (!ok) return;

    // 只读获取，不隐式创建
    const state = readEmotionState(userId, characterId);
    if (!state) {
      res.json({
        mood: 'warm',
        moodLabel: MOOD_LABEL['warm'],
        affection: 0.72,
        trust_score: 0.62,
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

// ====== 关系状态 ======

const PHASE_LABEL: Record<RelationshipPhase, string> = {
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
    if (!state) {
      res.json({
        phase: 'attached',
        phaseLabel: PHASE_LABEL['attached'],
        closeness: 0.72,
        trust: 0.62,
        dependence: 0.64,
        comfort_level: 0.74,
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
