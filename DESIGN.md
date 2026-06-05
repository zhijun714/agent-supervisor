# Supervisor — 多 Agent 协作开发工具

## 概述

Supervisor 是一个基于浏览器的本地 Web 工具，通过两个并行的 Claude Code CLI 终端（架构师 + 开发者）实现 AI 多智能体协作开发。架构师负责任务规划和代码审查，开发者负责具体实现，两者通过跨会话消息机制自动协调。

---

## 需求背景

### 痛点

手动在一个 Claude 会话里做所有事效率低，上下文容易污染。希望模拟真实团队的分工模式：一个 AI 角色负责架构决策，另一个负责编码实现，互相制衡、互相审查。

### 目标

- 两个 Claude Code 进程并行运行，角色分离
- 浏览器可视化两个终端，无需 SSH
- 消息自动路由：架构师 → 开发者（任务派发），开发者 → 架构师（进度汇报）
- 会话持久化：刷新页面或重启浏览器不中断 Claude 进程
- 多项目支持：不同项目用不同 Room 隔离

---

## 架构设计

```
Browser (xterm.js)
    │  WebSocket /pty/${roomId}-arch
    │  WebSocket /pty/${roomId}-dev
    │  WebSocket /events
    ▼
Node.js Server (server.js)
    │  node-pty (spawn shell)
    │  Inbox 消息队列
    │  Auto-review 触发器
    │  Watchdog 定时检查
    ▼
Claude Code CLI (claude --model ...)
    ├── Architect  (--disallowedTools Write,Edit,...)
    └── Developer  (--append-system-prompt-file ...)
```

**核心原则：会话生命周期由 Node.js 维护，浏览器只是显示层。** 关闭浏览器不会停止 Claude 进程，刷新页面会自动重连已运行的终端。

---

## 核心功能

### 1. 多 Room 管理

每个 Room = 一对独立的架构师 + 开发者终端，各自拥有独立的：
- 项目目录（arch/dev 可以不同）
- Claude 会话
- 消息 inbox
- Auto-review 状态
- Watchdog 定时器

Room 配置持久化到 `rooms.json`，服务器重启后仍可查看（PTY 需手动重启）。

**URL 路由：**
- `/` — Room 列表页
- `/?room={id}` — Room 详情页（双终端视图）

### 2. Inbox 消息机制

```
Agent A → inboxSend(to, from, text)
         ├─ 目标 PTY 空闲 → 立即 inboxDeliver
         └─ 目标 PTY 忙碌 → 加入队列，等待 2s 无输出后投递
```

消息用 bracketed paste 注入（`\x1b[200~...message...\x1b[201~` + `\r`），避免触发 shell 的特殊字符处理，Claude 将其识别为 `<cross-session-message>` 标签。

**水印机制：** `devReviewWatermark` 记录上次 review 的 buffer 位置，防止架构师重复派发已完成的任务。

### 3. Auto-Review

Dev PTY 空闲 2s 后触发 `triggerArchReview`：
- 条件：`autoReviewEnabled`（Arch 发出首条消息后激活）、60s 冷却、新增内容 > 500 字符
- 行为：取 Dev textBuf 新增部分注入 Arch，让 Arch 评估进度

### 4. 终端回放（rawBuf）

服务端维护两个 buffer：
- `textBuf`（stripped ANSI，12KB）— 供 inbox/review 使用
- `rawBuf`（原始 ANSI，256KB）— 供新 WS 客户端回放

新 WebSocket 连接成功后立即发送 `rawBuf`，刷新页面后终端内容完整恢复。

### 5. Resume 中断保护

`--resume {sessionId}` 重启的会话，首次 idle 时注入 STOP 消息，防止 Claude 自动继续上次未完成的任务，等待用户重新指派。

### 6. Watchdog 定时监控

每 10 分钟检查 Room 内所有 PTY：
- **PTY 存活 + 超过 10 分钟无输出** → 向对应 Agent 注入 nudge 消息
- **PTY 已退出** → 广播 `watchdog_triggered` 事件，UI 显示警告（不自动重启）
- **Arch 输出出现 `[TASK_COMPLETE]`** → 自动停止该 Room 的 Watchdog

---

## 技术方案

### 后端 (server.js)

| 模块 | 实现 |
|------|------|
| PTY | `node-pty` spawn shell，key = `${roomId}-arch` / `${roomId}-dev` |
| WebSocket | `ws` 库，`/pty/*` 路由到 PTY WS，`/` 路由到事件 WS |
| 会话查找 | 读 `~/.claude/projects/{encoded-path}/*.jsonl`，按 mtime 排序 |
| 路径编码 | `realpathSync` 解析符号链接（macOS `/tmp` → `/private/tmp`），`/` 替换为 `-` |
| Room 持久化 | `rooms.json` 本地文件，增删改查时同步写入 |
| 通知脚本 | 每个 Room spawn 时写入 `/tmp/notify-{roomId}-arch.sh` 和 `dev.sh`，Python 实现 HTTP POST |

### 前端 (index.html)

- **xterm.js 5.3.0** + **xterm-addon-fit 0.8.0**（无框架，原生 JS）
- 两个视图：Room 列表（grid cards）和 Room 详情（双终端）
- `?room=xxx` URL 参数路由，全页面刷新导航
- Session Picker：每次 room PTY 未启动时自动弹出，目录从 room 配置预填充
- Room 名称点击内联编辑，自动 PUT `/rooms/:id`

### 系统提示词设计

提示词存放于 `prompts/` 目录，spawn 时读取并追加 Room 特定的脚本路径：

**架构师 (`prompts/arch.md`)**
- 禁止输出代码块，禁用 Write/Edit 工具
- 任务派发、计划审核、中途纠错、验收的标准格式
- 所有通知必须通过 Bash 工具实际执行，不能只输出文本

**开发者 (`prompts/dev.md`)**
- 5 步工作流：等待任务 → 提交计划 → 等待批准 → 实现 → 汇报完成
- 不得自主开始工作，不得跳过计划步骤

---

## API 接口

| Method | Path | 说明 |
|--------|------|------|
| GET | `/rooms` | 列出所有 Room（含 archAlive/devAlive/watchdogEnabled） |
| POST | `/rooms` | 创建 Room |
| PUT | `/rooms/:id` | 更新 Room（name/dirs/silent） |
| DELETE | `/rooms/:id` | 删除 Room（杀进程） |
| POST | `/rooms/:id/spawn` | 启动 Room 的双 PTY |
| POST | `/rooms/:id/watchdog` | 开启/关闭 Watchdog |
| POST | `/notify` | Agent 间消息路由（需 `roomId`） |
| GET | `/sessions` | 列出项目历史会话 |
| GET | `/pty/buffer` | 获取 PTY 文本缓冲 |
| POST | `/pty/write` | 向 PTY 注入文本 |
| WS | `/pty/{termId}` | PTY 双向流（连接时回放 rawBuf） |
| WS | `/` | 事件流（inbox/watchdog/pty_exited 等） |

---

## 已知问题与修复历史

| 问题 | 根因 | 修复 |
|------|------|------|
| 历史会话为空 | macOS `/tmp` → `/private/tmp` 符号链接导致路径编码不匹配 | `realpathSync` 解析真实路径 |
| 会话排序错误 | `last-prompt.timestamp` 字段始终为 null | 改用文件 `mtime` 排序 |
| Resume 后 Claude 自动继续工作 | 恢复会话会载入上下文并继续 | 首次 idle 注入 STOP 消息（`resumeInterrupt` 标志） |
| 工具审批 TUI 被消息破坏 | 注入 `isTerminalInteractive` 检测误判 | 移除检测，直接投递（接受视觉干扰） |
| 开发者收不到任务（死锁） | `isTerminalInteractive` 把正常提示符也判定为交互中，所有消息进队列 | 同上 |
| 重复派发已完成任务 | `devReviewWatermark` 未在派发时更新 | `inboxDeliver` 中 arch→dev 时推进水印 |
| 重连创建新会话 | reconnect 逻辑总是 spawn 新进程 | 先尝试 WS 直连，4001 才 respawn |
| 目录变更不触发会话刷新 | `change` 事件需要失焦才触发 | 改用 `input` 事件 + 400ms 防抖 |
| 刷新页面终端内容丢失 | WS 重连后无历史回放 | 服务端维护 `rawBuf`，新连接立即发送 |
| Room 详情页未启动时不知道下一步 | 状态文字 "stopped" 含义不清 | PTY 未启动时自动弹出 Session Picker |

---

## 启动方式

```bash
cd supervisor
npm install       # 首次安装依赖
npm start         # node server.js
# 或
npm run open      # 启动并自动打开浏览器
```

访问 `http://localhost:3458`

---

## 目录结构

```
supervisor/
├── server.js          # 后端：PTY 管理、HTTP/WS 服务、Inbox、Watchdog
├── index.html         # 前端：Room 列表 + 双终端视图（单文件，无构建）
├── sessions.js        # 遗留：旧版 orchestrator 兼容层
├── rooms.json         # Room 配置持久化（git 忽略）
├── package.json
├── prompts/
│   ├── arch.md        # 架构师系统提示词模板
│   └── dev.md         # 开发者系统提示词模板
└── DESIGN.md          # 本文档
```
