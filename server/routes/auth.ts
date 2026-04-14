import { Router, Request, Response } from 'express';
import db from '../db';

export const authRouter = Router();

// 注册
authRouter.post('/register', (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: '用户名和密码不能为空' });
      return;
    }

    if (username.length < 2 || username.length > 20) {
      res.status(400).json({ error: '用户名长度需在 2-20 个字符之间' });
      return;
    }

    if (password.length < 4) {
      res.status(400).json({ error: '密码长度至少 4 个字符' });
      return;
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      res.status(409).json({ error: '用户名已存在' });
      return;
    }

    const result = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, password);
    res.json({ userId: result.lastInsertRowid, username });
  } catch (err: any) {
    console.error('Register error:', err?.message);
    res.status(500).json({ error: '注册失败' });
  }
});

// 登录
authRouter.post('/login', (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: '用户名和密码不能为空' });
      return;
    }

    const user: any = db.prepare('SELECT id, username, password FROM users WHERE username = ?').get(username);
    if (!user || user.password !== password) {
      res.status(401).json({ error: '用户名或密码错误' });
      return;
    }

    res.json({ userId: user.id, username: user.username });
  } catch (err: any) {
    console.error('Login error:', err?.message);
    res.status(500).json({ error: '登录失败' });
  }
});
