import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import { chatRouter } from './routes/chat';
import { authRouter } from './routes/auth';
import { dataRouter } from './routes/data';
import './db'; // 确保数据库初始化

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// API 路由
app.use('/api', chatRouter);
app.use('/api/auth', authRouter);
app.use('/api/data', dataRouter);

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
