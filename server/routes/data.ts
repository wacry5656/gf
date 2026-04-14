import { Router, Request, Response } from 'express';
import db from '../db';

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

// 删除角色（连带删除聊天记录）
dataRouter.delete('/characters/:id', (req: Request, res: Response) => {
  try {
    const charId = Number(req.params.id);
    db.prepare('DELETE FROM chat_messages WHERE character_id = ?').run(charId);
    db.prepare('DELETE FROM characters WHERE id = ?').run(charId);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Delete character error:', err?.message);
    res.status(500).json({ error: '删除角色失败' });
  }
});

// ====== 聊天记录管理 ======

// 获取某角色的聊天记录
dataRouter.get('/messages/:characterId', (req: Request, res: Response) => {
  try {
    const characterId = Number(req.params.characterId);
    const messages = db.prepare(
      'SELECT role, content FROM chat_messages WHERE character_id = ? ORDER BY id ASC'
    ).all(characterId);

    res.json({ messages });
  } catch (err: any) {
    console.error('Get messages error:', err?.message);
    res.status(500).json({ error: '获取聊天记录失败' });
  }
});

// 追加一条消息
dataRouter.post('/messages', (req: Request, res: Response) => {
  try {
    const { characterId, role, content } = req.body;
    if (!characterId || !role || !content) {
      res.status(400).json({ error: '参数不完整' });
      return;
    }

    db.prepare(
      'INSERT INTO chat_messages (character_id, role, content) VALUES (?, ?, ?)'
    ).run(characterId, role, content);

    res.json({ success: true });
  } catch (err: any) {
    console.error('Save message error:', err?.message);
    res.status(500).json({ error: '保存消息失败' });
  }
});

// 清空某角色的聊天记录
dataRouter.delete('/messages/:characterId', (req: Request, res: Response) => {
  try {
    const characterId = Number(req.params.characterId);
    db.prepare('DELETE FROM chat_messages WHERE character_id = ?').run(characterId);
    res.json({ success: true });
  } catch (err: any) {
    console.error('Clear messages error:', err?.message);
    res.status(500).json({ error: '清空聊天记录失败' });
  }
});
