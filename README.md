# 虚拟聊天角色 / Virtual GF

基于 Vue 3 + Express + Qwen / DeepSeek API 的虚拟聊天角色网页应用。
支持多层上下文记忆（事实、偏好、情感、关系状态），涵盖回忆摘要、被动/主动消息、自动日记与日程提取等高层次 AI 互动功能。

## ✨ 核心特性

- 🎭 **自定义角色**：支持姓名、性别、性格、关系模式（恋人/朋友）定制。
- 🧠 **全方位记忆系统**：
  - **长期记忆 (Vector)**：通过 Embedding 抽取用户消息中的事实、状态、偏好、计划。
  - **关系与情绪 (State)**：实时计算并持久化“你”与角色的亲密度、信任度、好感与情绪模型。
  - **自动摘要 (Summary)**：基于大林量聊天记录定期压缩提取双方交互核心印象。
- 💌 **拟真互动机制**：
  - **主动消息 (Initiative)**：静置时随机随堂分享、久别寒暄重逢。
  - **日程提取 (Reminder)**：无感提取聊天中提及的“明天/周末/下周”事件，并在到期时主动发消息提醒。
  - **里程碑 (Milestones)**：自动捕获聊天条数与相识天数，并送出感叹。
- 📝 **专属日记 (Diary)**：根据一整天的对话，每日自动生成并记录 AI 视角的第一人称日记。
- 🔧 **安全与隐私**：自带本地 SQLite 存储，不依赖云端外部数据库库（大模型 API 例外）。

## 🛠️ 技术栈

- **前端**：Vue 3 + Vite + TypeScript (单文件组件 + 响应式状态)
- **后端**：Express + TypeScript + better-sqlite3
- **AI 枢纽**：支持 通义千问 (Qwen) 及 DeepSeek 等各类 OpenAI 兼容接口，并独立拆分 Embedding 与 Chat Completions。

## 📦 快速启动

### 1. 安装依赖

`ash
# 服务端依赖
npm install

# 客户端依赖
cd client && npm install
`

### 2. 环境配置

将对应的 \.env.example\ 拷贝并重命名为 \.env\，参考下面必填项：

`ini
# (优先支持 DeepSeek 等平替，亦可填入 Qwen API Key)
QWEN_API_KEY=sk-xxxxxxxxxxxxxxx
QWEN_BASE_URL=https://api.deepseek.com/v1
QWEN_MODEL=deepseek-chat

# Embedding 配置 (记忆向量，兼容 Qwen / OpenAI 等)
EMBEDDING_API_KEY=sk-xxxxxxxxxxxxxxx
EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBEDDING_MODEL=text-embedding-v3
`

### 3. 开发环境 (Dev)

会自动使用 ts-node/nodemon 和 vite 运行：

`ash
# 在根目录运行
npm run dev
`

- 前端：\http://localhost:5173\ (带跨域代理)
- 后端：\http://localhost:3000\

### 4. 生产构建 (Build)

`ash
# 全项目编译与前端静态打包
npm run build

# 启动产物环境
npm start
`
访问 \http://localhost:3000\ 即可。

### 5. 测试 (Test)

`ash
# 分别测试聊天流与系统工具函数
npm run test:chat
npm run test:memory
npm run test:relationship
npm run test:server
`

## 📂 核心目录结构

`	ext
├── client/
│   ├── src/components/
│   │   ├── ChatWindow.vue   # 主核心对话窗（含 SSE 流、主动消息轮询逻辑）
│   │   ├── MemoryPanel.vue  # 面板：查看日记、记忆、动态关系指数及日程记录
│   │   ├── CharacterSetup.vue
│   │   └── LoginPage.vue
├── server/
│   ├── db.ts                # SQLite 数据库表构建与迁移
│   ├── routes/
│   │   ├── chat.ts          # 流式与非流式对话集成与调用
│   │   └── data.ts          # 用户全链路 CRUD 及 UI 关联功能接口
│   ├── services/
│   │   ├── memory.ts        # Embedding + Memory 生命周期
│   │   ├── initiative.ts    # 随堂分享、久远寒暄
│   │   ├── reminder.ts      # 事件提取与主动排期
│   │   ├── diary.ts         # 单日复盘总结并生成日记
│   │   ├── emotion.ts       / relationship.ts / milestone.ts
│   │   └── qwen.ts          / embedding.ts (外层 API 代理层)
│   ├── tests/               # 相关特性的自动化回归单元测试
`

---
*本项目完全适合个人与朋友之间的内部部署和小范围高粘性互动。*