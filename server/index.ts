import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import { chatRouter } from './routes/chat';
import { authRouter } from './routes/auth';
import { dataRouter } from './routes/data';
import './db'; // 确保数据库初始化

dotenv.config();

// ========== 启动时配置自检 ==========
function validateConfig() {
  const warnings: string[] = [];

  if (!process.env.QWEN_API_KEY || process.env.QWEN_API_KEY === 'your_api_key_here') {
    warnings.push('[Config] ⚠️  QWEN_API_KEY 未配置或为默认值，聊天功能将不可用');
  }
  if (!process.env.QWEN_BASE_URL) {
    warnings.push('[Config] ⚠️  QWEN_BASE_URL 未配置，聊天功能将不可用');
  }
  if (process.env.QWEN_API_URL) {
    warnings.push('[Config] ⚠️  检测到旧变量 QWEN_API_URL，请改为 QWEN_BASE_URL（不含 /chat/completions 后缀）');
  }
  if (!process.env.EMBEDDING_BASE_URL) {
    warnings.push('[Config] ⚠️  EMBEDDING_BASE_URL 未配置，记忆系统将不可用');
  }

  if (warnings.length > 0) {
    console.log('========== 配置检查 ==========');
    for (const w of warnings) {
      console.warn(w);
    }
    console.log('==============================');
  } else {
    console.log('[Config] ✅ 所有必要环境变量已配置');
  }
}

validateConfig();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// API 路由
app.use('/api', chatRouter);
app.use('/api/auth', authRouter);
app.use('/api/data', dataRouter);
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API 接口不存在，请检查 /api 路径或反向代理配置' });
});
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!req.originalUrl.startsWith('/api')) {
    next(err);
    return;
  }

  if (res.headersSent) {
    next(err);
    return;
  }

  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: '请求体不是有效的 JSON' });
    return;
  }

  const status = typeof err?.status === 'number' ? err.status : 500;
  console.error('[API] 未处理异常:', err?.message || err);
  res.status(status).json({ error: status >= 500 ? '服务器内部错误，请稍后重试' : '请求失败' });
});

// 生产环境：serve 前端静态文件
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.use((_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`服务已启动: http://localhost:${PORT}`);
}).on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请更换端口或关闭占用进程`);
  } else {
    console.error('服务启动失败:', err.message);
  }
  process.exit(1);
});
