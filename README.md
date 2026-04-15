# 虚拟聊天角色

基于 Vue 3 + Express + Qwen API 的虚拟聊天角色网页应用。

支持自定义角色名称、性别、预设/自定义性格描述，并通过通义千问大模型进行中文多轮对话。

## 功能

- 🎭 自定义角色：名称、性别、性格（预设/自定义）、角色描述
- 💬 中文多轮对话，角色保持一致性
- 📱 响应式布局，移动端适配
- 🚀 前后端分离，Vue 3 + Express

## 技术栈

- **前端**：Vue 3 + Vite + TypeScript
- **后端**：Express + TypeScript
- **AI 模型**：通义千问 (Qwen) API（OpenAI 兼容接口）

## 快速开始

### 1. 安装依赖

```bash
# 安装后端依赖
npm install

# 安装前端依赖
cd client && npm install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env`，填入你的 Qwen API Key：

```bash
cp .env.example .env
```

编辑 `.env`：

```
QWEN_API_KEY=sk-xxxxxxxxxxxxxxxx
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen-turbo
PORT=3000

# Embedding 配置（EMBEDDING_API_KEY 不填则复用 QWEN_API_KEY）
# EMBEDDING_API_KEY=            # 可选，不填则复用 QWEN_API_KEY
EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBEDDING_MODEL=text-embedding-v3

# 记忆系统配置
MEMORY_TOP_K=3                  # 每次检索返回的相关记忆条数
RECENT_MESSAGE_LIMIT=10         # 每次发送给模型的最近消息条数
```

> API Key 可在 [阿里云百炼平台](https://bailian.console.aliyun.com/) 获取。

### 3. 开发模式

```bash
# 同时启动前端和后端
npm run dev
```

前端运行在 `http://localhost:5173`，后端运行在 `http://localhost:3000`。

前端已配置代理，开发时 API 请求会自动转发到后端。

### 4. 生产构建

```bash
# 构建前后端（编译 TS + Vite 打包）
npm run build

# 启动服务（同时 serve 前端静态文件）
npm start
```

访问 `http://localhost:3000`。

## 部署到 Linux VPS

### 使用 Node.js 直接部署

```bash
# 1. 克隆项目到服务器
git clone <your-repo-url> virtual-chat
cd virtual-chat

# 2. 安装依赖
npm install
cd client && npm install && cd ..

# 3. 配置环境变量
cp .env.example .env
nano .env  # 填入 API Key

# 4. 构建前后端
npm run build

# 5. 启动服务
npm start
```

### 使用 PM2 守护进程

```bash
npm install -g pm2

# 构建
npm run build

# 启动
pm2 start dist-server/index.js --name virtual-chat

# 查看日志
pm2 logs virtual-chat

# 开机自启
pm2 startup
pm2 save
```

### 使用 Nginx 反向代理（推荐）

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location /api/chat/stream {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Connection '';
        proxy_buffering off;
        chunked_transfer_encoding on;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

## 项目结构

```
├── server/                 # Express 后端
│   ├── index.ts           # 入口文件
│   ├── db.ts              # SQLite 数据库（memories + memory_summaries 表）
│   ├── routes/chat.ts     # 聊天 API（四层上下文构建 + 调试日志）
│   ├── routes/auth.ts     # 认证路由
│   ├── routes/data.ts     # 数据 CRUD 路由
│   ├── services/qwen.ts   # Qwen API 调用封装
│   ├── services/embedding.ts  # Embedding 向量生成
│   ├── services/memory.ts # 记忆写入、分类、冲突检测、多因素检索、命中追踪
│   ├── services/summary.ts # 记忆摘要生成与管理
│   ├── services/factExtractor.ts # 规则化事实提取 + memory_type 分类
│   ├── services/memoryConflict.ts # 事实冲突检测与覆盖
│   ├── utils/memoryConfig.ts  # 记忆系统参数中心（全部读取环境变量）
│   ├── utils/memoryDebug.ts   # 记忆检索调试日志
│   └── utils/similarity.ts   # 余弦相似度计算
├── client/                 # Vue 3 前端
│   ├── src/
│   │   ├── App.vue        # 主组件
│   │   ├── api.ts         # API 请求封装
│   │   ├── components/
│   │   │   ├── CharacterSetup.vue  # 角色设置组件
│   │   │   ├── ChatWindow.vue      # 聊天窗口组件
│   │   │   └── LoginPage.vue       # 登录组件
│   │   ├── main.ts
│   │   └── style.css
│   └── vite.config.ts
├── .env                    # 环境变量
├── .env.example            # 环境变量模板（含注释）
├── package.json
├── tsconfig.json
└── README.md
```

## 向量检索记忆系统 v4

### 四层上下文架构

每次调用模型时，输入按以下分层组织：

```
┌─────────────────────────────────────┐
│  1. System Prompt（角色设定+规则）   │
│  2. Summary（用户画像摘要）          │  ← 压缩的长期认知
│  3. Long-term Memories（向量检索）   │  ← 与当前话题相关的 active 历史
│  4. Recent Messages（最近 20 条）    │  ← 短期上下文
└─────────────────────────────────────┘
```

### v4 新增特性

#### 1. memory_type 分类存储

每条记忆写入时自动分类为以下类型之一：

| 类型 | 说明 | 示例 |
|------|------|------|
| `fact` | 身份、学校、工作、城市等稳定事实 | "用户在北京工作" |
| `state` | 近期情绪、当前状态 | "用户最近很焦虑" |
| `preference` | 喜好、厌恶、习惯 | "用户喜欢吃火锅" |
| `plan` | 未来安排、打算 | "用户计划下个月去旅游" |
| `relationship` | 与角色的关系、感情相关 | "用户表白了" |
| `other` | 无法明确归类的信息 | 其他有价值的消息 |

- 分类由 `classifyMemoryType()` 自动完成，基于规则匹配
- 不同类型有不同的冲突检测策略（state/plan 更容易被新信息覆盖）

#### 2. 事实冲突检测与自动覆盖

当新事实与已有记忆存在冲突时，自动将旧记忆标记为 `inactive`：

```
旧记忆: "用户在北京上学"  → is_active=0, superseded_by=新记忆ID
新记忆: "用户在伦敦上学"  → is_active=1（正常写入）
```

冲突检测机制：
1. **维度匹配**：检测新旧记忆是否涉及同一语义维度（地点、工作、喜好等）
2. **类型感知**：同类型记忆之间才做冲突检测
3. **阈值分级**：`state`/`plan` 更易被覆盖（阈值 0.65），`fact`/`preference` 需更强证据（阈值 0.72~0.78）
4. **非破坏性**：旧记忆不删除，只标记为 inactive，保留完整历史

检索和 summary 生成时**默认只使用 active 记忆**。

可通过 `MEMORY_ENABLE_CONFLICT_RESOLUTION=false` 关闭此功能。

#### 3. 命中反馈 (Usage Feedback)

经常被检索命中的记忆获得更高排名：

- 每条记忆新增 `hit_count` 和 `last_hit_at` 字段
- 当记忆进入 prompt 上下文时，自动 `hit_count += 1`
- 重排序时新增 `usageScore`，计算公式：`min(1.0, log(1 + hits) / log(11))`
  - 0 次命中 → 0.0
  - 3 次命中 → 0.58
  - 10 次命中 → 1.0
- `MEMORY_USAGE_WEIGHT` 控制权重（默认 0.08），不会压过语义相关性

#### 4. 事实提取层 (Fact Extraction)

用户消息在写入记忆前，先经过规则化事实提取：

- 原始消息 `"我在北京上班"` → 提取事实 `"用户在北京工作"`
- 覆盖 15+ 类模式：身份、地点、工作、偏好、宠物、家庭、计划等
- embedding 基于规范化的事实文本而非原始口语，提升检索精度

#### 5. 调试可观测性 (Debug Mode)

设置 `DEBUG_MEMORY_RETRIEVAL=true` 后，控制台输出完整检索过程，包含所有新字段：

```
╔══════════════ MEMORY RETRIEVAL DEBUG ══════════════╗
║ User input: "你还记得我在哪上班吗"
╠═══ Pre-rerank candidates ═══
  [#42|fact] sem=0.821 imp=0.80 rec=0.95 use=0.58 len=1.0 hits=3 → final=0.8010 | "用户在北京工作"
  [#38|preference] sem=0.654 imp=0.60 rec=0.82 use=0.00 len=1.0 hits=0 → final=0.6240 | "用户喜欢写代码"
╚═══════════════════════════════════════════════════╝
```

- **Short-term memory**：最近 20 条消息直接参与上下文，不走向量检索
- **Long-term memory**：通过 `shouldStoreAsMemory` 筛选出的高价值消息，写入 embedding 后通过向量检索召回
- **Summary**：当记忆累积到一定数量后，自动调用 LLM 压缩为用户画像摘要

### 多因素重排序

不再是简单的 cosine similarity topK。检索流程：

1. **粗筛**：仅 active 记忆，cosine similarity > 阈值的候选（最多 20 条）
2. **重排序**：综合评分 = 语义(70%) + 重要性(12%) + 时间衰减(10%) + 使用频率(8%) × 长度惩罚
3. **去重**：语义相似度 > 0.88 的重复记忆只保留最优一条
4. **预算控制**：总记忆字符不超过 MEMORY_MAX_CONTEXT_CHARS
5. **命中追踪**：进入 prompt 的记忆自动 hit_count += 1

### 记忆重要性评估

每条记忆写入时自动评分（1~5 分）：

| 分数 | 类型 | 示例 |
|------|------|------|
| 5 | 关系/重大事件 | 表白、分手、生日 |
| 4 | 个人身份信息 | 工作、学校、家庭成员 |
| 3 | 偏好/计划 | 喜欢什么、打算做什么 |
| 2 | 情绪/事件 | 今天发生了什么、心情 |
| 1 | 习惯/一般信息 | 经常做什么、长文本 |

### 写入去重

- 新消息与已有记忆 cosine > 0.92 时不重复写入
- 避免记忆库膨胀

### 记忆摘要 (Summary)

- 记忆达到 15 条后自动触发
- 调用 LLM 将碎片记忆压缩为 100~200 字的用户画像
- 每 4 小时最多更新一次
- 包含：基本信息、近期状态、偏好习惯、人际关系、近期计划
- 通过 `MEMORY_SUMMARY_ENABLED` 可关闭

### Token 消耗对比

| 方式 | Token 消耗 |
|------|-----------|
| 旧方案：全部历史消息 | 5000~10000+ tokens |
| v1：10条最近 + 3条记忆 | 800~1500 tokens |
| **v2：20条最近 + summary + 5条精选记忆** | **1200~2000 tokens** |

v2 用略多的 token 换来显著更好的上下文质量：summary 提供稳定认知，精选记忆提供话题相关性。

### 配置说明

| 环境变量 | 默认值 | 说明 |
|---------|-------|------|
| `EMBEDDING_API_KEY` | 复用 `QWEN_API_KEY` | Embedding API 密钥 |
| `EMBEDDING_BASE_URL` | 必须配置 | Embedding API 基础地址（代码自动拼接 /embeddings） |
| `EMBEDDING_MODEL` | `text-embedding-v3` | Embedding 模型名称 |
| `MEMORY_TOP_K` | `5` | 检索返回的记忆条数（建议 ≤8） |
| `RECENT_MESSAGE_LIMIT` | `20` | 短期上下文消息条数 |
| `MEMORY_MAX_CANDIDATES` | `20` | 粗筛阶段最大候选数 |
| `MEMORY_SIMILARITY_THRESHOLD` | `0.35` | cosine 相似度最低门槛 |
| `MEMORY_MAX_CONTEXT_CHARS` | `1500` | summary + 记忆的总字符预算 |
| `MEMORY_SEMANTIC_WEIGHT` | `0.70` | 重排序中语义相似度权重 |
| `MEMORY_IMPORTANCE_WEIGHT` | `0.12` | 重排序中重要性权重 |
| `MEMORY_RECENCY_WEIGHT` | `0.10` | 重排序中时间衰减权重 |
| `MEMORY_USAGE_WEIGHT` | `0.08` | 重排序中命中频率权重 |
| `MEMORY_DEDUP_THRESHOLD` | `0.88` | 检索结果去重阈值 |
| `MEMORY_WRITE_DEDUP_THRESHOLD` | `0.92` | 写入去重阈值 |
| `MEMORY_ENABLE_CONFLICT_RESOLUTION` | `true` | 是否启用事实冲突自动覆盖 |
| `MEMORY_SUMMARY_ENABLED` | `true` | 是否启用自动摘要 |
| `MEMORY_SUMMARY_REFRESH_COUNT` | `5` | 新增多少条记忆后触发摘要更新 |
| `DEBUG_MEMORY_RETRIEVAL` | `false` | 输出记忆检索调试日志 |

### 如何测试

#### 测试 memory_type 分类

发送以下消息后检查数据库 `memories` 表的 `memory_type` 字段：
- `"我在上海上班"` → 应分类为 `fact`
- `"我最近有点焦虑"` → 应分类为 `state`
- `"我喜欢吃火锅"` → 应分类为 `preference`
- `"我打算下个月去旅游"` → 应分类为 `plan`
- `"我喜欢你"` → 应分类为 `relationship`

#### 测试冲突覆盖

1. 先发 `"我在北京上班"`，记忆写入
2. 再发 `"我在上海上班"`，旧记忆应被标记为 `is_active=0`
3. 查数据库：旧记忆的 `superseded_by` 指向新记忆 ID

#### 测试命中反馈

1. 开启 `DEBUG_MEMORY_RETRIEVAL=true`
2. 多次发送与某条记忆相关的话题
3. 观察该记忆的 `hit_count` 递增，`usageScore` 在调试日志中逐渐提升

## API 接口

### POST /api/chat

请求体：

```json
{
  "character": {
    "name": "小雪",
    "gender": "female",
    "personality": "温柔体贴、善解人意",
    "description": "一个喜欢读书的文艺少女"
  },
  "messages": [
    { "role": "user", "content": "你好呀" }
  ]
}
```

响应：

```json
{
  "reply": "你好～我是小雪，今天过得怎么样呀？😊"
}
```
