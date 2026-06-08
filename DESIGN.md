# Supervisor — 多 Agent 协作开发工具

## 概述

Supervisor 是一个基于浏览器的本地 Web 工具，通过最多三个并行的 AI CLI 终端（产品架构师 + 开发工程师 + 可选 QA 工程师）实现多智能体协作开发。支持 Claude / Gemini / Codex 三种 CLI，各角色可独立选择不同 CLI 和模型。产品架构师负责需求定义、计划审核和验收，开发工程师负责具体实现，QA 工程师对交付物做独立对抗性测试，三者通过跨会话消息机制自动协调。

---

## 需求背景

### 痛点

手动在一个 Claude 会话里做所有事效率低，上下文容易污染。希望模拟真实团队的分工模式：一个 AI 角色负责架构决策，另一个负责编码实现，互相制衡、互相审查，可选引入独立 QA 进行对抗性验证。

### 目标

- 最多三个 AI CLI 进程并行运行，角色严格分离；支持 Claude / Gemini / Codex 混用
- 浏览器可视化所有终端，无需 SSH
- 消息自动路由：PA → Dev（任务派发）、Dev → PA（进度汇报）、PA → QA（测试委托）、QA → PA（测试报告）
- 消息优先级：紧急消息跳队列并 ESC 中断目标 Agent
- 会话持久化：刷新页面或重启浏览器不中断 AI 进程
- 多项目支持：不同项目用不同 Room 隔离
- 模型切换：运行时切换任意角色的模型，会话上下文通过各 CLI 对应的 resume 机制保留

---

## 架构设计

```
Browser (xterm.js)
    │  WebSocket /pty/${roomId}-arch
    │  WebSocket /pty/${roomId}-dev
    │  WebSocket /pty/${roomId}-qa   (可选)
    │  WebSocket /events
    ▼
Node.js Server (server.js)
    │  node-pty (spawn shell)
    │  Inbox 消息队列（含优先级 + ESC 中断）
    │  Auto-review 触发器
    │  Watchdog 定时检查
    │  Model Switch (respawn + CLI-specific resume)
    │  CLI_PROFILES（Claude / Gemini / Codex 命令构建 + 信任处理）
    ▼
AI CLI（各角色独立选择）
    ├── Product Architect  (claude / gemini / codex，--disallowedTools 仅 claude 生效)
    ├── Developer          (claude / gemini / codex)
    └── QA Engineer        (claude / gemini / codex)  [可选]
```

**核心原则：会话生命周期由 Node.js 维护，浏览器只是显示层。** 关闭浏览器不会停止 Claude 进程，刷新页面会自动重连已运行的终端。

---

## 核心功能

### 1. 多 Room 管理

每个 Room = 一组独立的角色终端（PA + Dev + 可选 QA），各自拥有独立的：
- 项目目录（arch/dev/qa 可以不同）
- Claude 会话（含选定的模型）
- 消息 inbox
- Auto-review 状态
- Watchdog 定时器

Room 配置持久化到 `rooms.json`，服务器重启后仍可查看（PTY 需手动重启）。

**URL 路由：**
- `/` — Room 列表页
- `/?room={id}` — Room 详情页（双/三终端视图）

### 2. Inbox 消息机制

```
Agent A → inboxSend(to, from, text, priority)
         ├─ 目标 PTY 空闲 → 立即 inboxDeliver
         └─ 目标 PTY 忙碌 → 加入队列，等待 2s 无输出后投递
                           └─ priority=urgent → unshift 到队首 + 发 ESC 中断
```

消息用 bracketed paste 注入（`\x1b[200~...message...\x1b[201~` + `\r`），避免触发 shell 的特殊字符处理，Claude 将其识别为 `<cross-session-message>` 标签。

**优先级机制：**
- `normal`（默认）：`push` 到队列末尾，等 Agent 当前输出结束后投递
- `urgent`：`unshift` 到队列最前，同时向目标 PTY 发送 `\x1b`（ESC）打断当前生成，下一个 idle tick 立即投递

**水印机制：** `devReviewWatermark` 记录上次 review 的 buffer 位置，防止架构师重复派发已完成的任务。

### 3. TDD 工作流

产品架构师在派发每个任务时必须附带验收测试清单，开发者必须让所有验收测试通过后才能报告完成：

```
PA 派发任务（含验收测试）
  → Dev 发送实现计划（等待批准）
  → PA 批准计划
  → Dev 实现 + 跑测试
  → Dev 报告完成（所有测试通过）
  → PA 验收 或 路由给 QA
```

QA 工程师遵循**对抗性测试原则**：不提前阅读实现代码，测试边界值、错误路径、并发、回归，找 Bug 而非确认正常路径。

### 4. Auto-Review

Dev PTY 空闲 2s 后触发 `triggerArchReview`：
- 条件：`autoReviewEnabled`（PA 发出首条消息后激活）、60s 冷却、新增内容 > 500 字符
- 行为：取 Dev textBuf 新增部分注入 PA，让 PA 评估进度

### 5. 终端回放（rawBuf）

服务端维护两个 buffer：
- `textBuf`（stripped ANSI，12KB）— 供 inbox/review 使用
- `rawBuf`（原始 ANSI，256KB）— 供新 WS 客户端回放

新 WebSocket 连接成功后立即发送 `rawBuf`，刷新页面后终端内容完整恢复。

### 6. Resume 中断保护

`--resume {sessionId}` 重启的会话，首次 idle 时注入 STOP 消息，防止 Claude 自动继续上次未完成的任务，等待用户重新指派。

### 7. Watchdog 定时监控

每 10 分钟检查 Room 内所有 PTY（含 QA）：
- **PTY 存活 + 超过 10 分钟无输出** → 向对应 Agent 注入 nudge 消息
- **PTY 已退出** → 广播 `watchdog_triggered` 事件，UI 显示警告（不自动重启）
- **PA 输出出现 `[TASK_COMPLETE]`** → 自动停止该 Room 的 Watchdog

### 8. 模型切换

任意角色可在运行时切换模型，通过 `/tmp/switch-model-{roomId}-{role}.sh <model>` 脚本触发：
1. Server 根据角色的 CLI 类型确定 sessionId（Claude: `listSessions` 找最新、Gemini: `latest`、Codex: `last`）
2. 更新 `rooms.json` 中对应的 `archModel` / `devModel` / `qaModel`
3. 用新模型 + CLI 对应的 resume 参数 respawn PTY（会话上下文完整保留）
4. 广播 `model_switched` 事件，前端自动重连 PTY WS 并更新模型徽章

**各 CLI 可用模型：**

| CLI | 模型 |
|-----|------|
| Claude | `claude-sonnet-4-6`（默认）、`claude-opus-4-8`、`claude-haiku-4-5-20251001` |
| Gemini | `gemini-2.5-flash`（默认）、`gemini-2.5-pro`、`gemini-2.5-flash-lite`、`gemini-3-flash-preview` 等 |
| Codex | `gpt-5.5`（默认）、`gpt-5.5-pro`、`gpt-5.4`、`gpt-5.4-mini`、`o4-mini`、`o3` |

### 9. 多 CLI 支持

每个角色可独立选择 Claude / Gemini / Codex CLI，通过 `CLI_PROFILES` 常量统一管理各 CLI 的差异：

| 能力 | Claude | Gemini | Codex |
|------|--------|--------|-------|
| 命令构建 | `claude --model ... --append-system-prompt-file ...` | `gemini -m ...` + `GEMINI_SYSTEM_MD` env | `codex -m ...` + `XDG_CONFIG_HOME` + config.toml |
| 系统提示注入 | `--append-system-prompt-file <file>` | `GEMINI_SYSTEM_MD=<file>` | `model_instructions_file = "<file>"` in config.toml |
| 信任确认 | 扫描 "Do you trust the files" → 发 Enter | 扫描 "Open documentation" → 发 `D\r` | 扫描 "Allow" → 发 Enter |
| Resume | `--resume <sessionId>` | `-r latest` | `codex resume --last` |
| disallowedTools | 支持（arch 角色使用） | 不支持（忽略） | 不支持（忽略） |

---

## 技术方案

### 后端 (server.js)

| 模块 | 实现 |
|------|------|
| PTY | `node-pty` spawn shell，key = `${roomId}-arch` / `${roomId}-dev` / `${roomId}-qa` |
| WebSocket | `ws` 库，`/pty/*` 路由到 PTY WS，`/` 路由到事件 WS |
| 会话查找 | 读 `~/.claude/projects/{encoded-path}/*.jsonl`，按 mtime 排序（仅 Claude） |
| 路径编码 | `realpathSync` 解析符号链接（macOS `/tmp` → `/private/tmp`），`/` 替换为 `-` |
| Room 持久化 | `rooms.json` 本地文件，含 archModel/devModel/qaModel/archCli/devCli/qaCli 字段 |
| CLI 配置 | `CLI_PROFILES` 常量，每种 CLI 含 buildCmd / getEnv / writeConfig / trustTexts / trustKey / supportsResume |
| 信任自动处理 | spawn 后扫描 PTY 输出，检测到信任提示后 500ms debounce 发送 trustKey |
| 通知脚本 | 每个 Room spawn 时写 10 个脚本：6 个 notify（含 urgent）+ 3 个 switch-model + 1 个 update-room-memory（TODO） |
| 路径注入 | `writeRoomScripts` 在生成最终 prompt 文件时将占位符路径替换为实际房间路径 |

### 前端 (index.html)

- **xterm.js 5.3.0** + **xterm-addon-fit 0.8.0**（无框架，原生 JS）
- 两个视图：Room 列表（grid cards）和 Room 详情（双/三终端）
- `?room=xxx` URL 参数路由，全页面刷新导航
- Session Picker：每次 room PTY 未启动时自动弹出，含 CLI 选择（紫色）+ 模型下拉选择；三角色时切换三列布局
- `CLI_MODELS` 常量：每种 CLI 对应的可选模型列表；CLI 切换时自动刷新模型选项
- Room 名称点击内联编辑，自动 PUT `/rooms/:id`
- Relay bar：Dev → PA 审查、Dev → QA 测试、Watchdog 开关
- 面板 header：模型徽章（Opus/非 Claude CLI 时显示对应颜色）
- `model_switched` 事件：自动重连对应 PTY WS + 更新模型徽章（含 CLI 信息）

### 系统提示词设计

提示词模板存放于 `prompts/` 目录，spawn 时读取后先替换占位符路径，再追加 Room 特定的脚本路径 footer：

**产品架构师 (`prompts/arch.md`)**
- 禁止输出代码块，禁用 Write/Edit/MultiEdit/NotebookEdit/Task 工具
- 任务派发模板（含验收测试清单）、计划审核、中途普通/紧急纠错、QA 路由、验收格式
- Auto-Review / Manual Review 处理规则
- 模型切换：可切换自己和下属角色的模型，附带升级判断标准

**开发工程师 (`prompts/dev.md`)**
- 5 步工作流：等待任务 → 提交计划 → 等待批准 → 实现（边跑测试）→ 报告完成
- 不得自主开始工作，不得跳过计划步骤，测试未全通过不得报完成
- 模型切换：卡住超过 2 次可自行升级

**QA 工程师 (`prompts/qa.md`)**
- 等待 PA 分配，收到分配前什么都不做
- 测试前不读实现代码，独立从规格推导测试用例
- 对抗性测试策略：边界值、错误路径、并发、集成接缝、回归
- Bug 报告格式：严重度（HIGH/MED/LOW）+ 精确复现步骤
- 模型切换：复杂安全/并发分析时可升级

---

## API 接口

| Method | Path | 说明 |
|--------|------|------|
| GET | `/rooms` | 列出所有 Room（含 archAlive/devAlive/qaAlive/watchdogEnabled） |
| POST | `/rooms` | 创建 Room（含 archModel/devModel/qaModel 可选） |
| PUT | `/rooms/:id` | 更新 Room（name/dirs/silent/model 字段） |
| DELETE | `/rooms/:id` | 删除 Room（杀所有角色进程） |
| POST | `/rooms/:id/spawn` | 启动 Room 的 PTY（含模型选择） |
| POST | `/rooms/:id/watchdog` | 开启/关闭 Watchdog |
| POST | `/rooms/:id/switch-model` | 切换角色模型（respawn + --resume 保留上下文） |
| GET | `/rooms/:id/memory` | 获取 Room 记忆内容（TODO） |
| PUT | `/rooms/:id/memory` | 覆写 Room 记忆内容（TODO） |
| POST | `/notify` | Agent 间消息路由（含 priority 字段：normal/urgent） |
| GET | `/sessions` | 列出项目历史会话 |
| GET | `/sessions/history` | 获取会话消息历史 |
| GET | `/pty/buffer` | 获取 PTY 文本缓冲 |
| POST | `/pty/write` | 向 PTY 注入文本 |
| POST | `/pty/kill` | 杀指定 PTY |
| WS | `/pty/{termId}` | PTY 双向流（连接时回放 rawBuf） |
| WS | `/` | 事件流（inbox_delivered/inbox_queued/watchdog_*/pty_exited/model_switched） |

---

## 脚本文件（每 Room 生成）

| 脚本 | 路径 | 用途 |
|------|------|------|
| notify arch | `/tmp/notify-{roomId}-arch.sh` | Dev → PA 发消息 |
| notify arch from qa | `/tmp/notify-{roomId}-arch-from-qa.sh` | QA → PA 发消息 |
| notify dev | `/tmp/notify-{roomId}-dev.sh` | PA → Dev 普通消息 |
| notify dev urgent | `/tmp/notify-{roomId}-dev-urgent.sh` | PA → Dev 紧急消息（ESC 中断） |
| notify qa | `/tmp/notify-{roomId}-qa.sh` | PA → QA 普通消息 |
| notify qa urgent | `/tmp/notify-{roomId}-qa-urgent.sh` | PA → QA 紧急消息 |
| switch-model arch | `/tmp/switch-model-{roomId}-arch.sh` | 切换 PA 模型 |
| switch-model dev | `/tmp/switch-model-{roomId}-dev.sh` | 切换 Dev 模型 |
| switch-model qa | `/tmp/switch-model-{roomId}-qa.sh` | 切换 QA 模型 |
| update-room-memory | `/tmp/update-room-memory-{roomId}.sh` | Agent 追加 Room 记忆（stdin → 带时间戳追加到 room-memories/{id}.md）（TODO） |

---

## Room 会话 ID 持久化 (TODO)

> **状态：已设计，待实现。**

### 设计目标

同一个目录可能有多个 Claude 会话（多个功能并行开发），Room 应记住自己上次使用的那个会话 ID，下次打开时自动预选，避免用户不知道该恢复哪个。

### 实现方案

**rooms.json 新增字段：**
```json
"archSessionId": "abc12345",
"devSessionId":  "def67890",
"qaSessionId":   null
```

**写入时机：**
- 用户手动选择 Resume → spawn 请求里已有 sessionId，直接存入 rooms.json
- 新建会话（Claude）→ spawn 后后台 poll `listSessions(dir)` 等新 .jsonl 文件出现（最多 30s），保存；成功后广播 `session_captured` 事件

**Session Picker 变化：**
- 下拉列表中预选 `room.archSessionId`，并标注 "(上次使用)"
- 若 session 已被删除，显示 "(记录的会话不存在，将新建)" 提示
- Gemini / Codex 无需存储（本身只有 latest/last）

**改动文件：** `server.js`（spawn 存储 + 后台捕获 + session_captured 事件），`index.html`（预选逻辑）

---

## Kimi Code CLI 集成 (TODO)

> **状态：已调研，待实现。**

### 调研结论

Kimi Code CLI（`@moonshotai/kimi-code`，2026-06-06 开源）是 Moonshot AI 的 agentic coding 工具，功能对标 Claude Code，可直接集成为第四种 CLI。

### 关键差异（对比现有三种 CLI）

| 能力 | 实现方式 |
|------|---------|
| 系统提示注入 | `--agent-file <yaml>`，YAML 中指定 `system_prompt_path: <md文件>` |
| 静默模式 | `--afk`（全自动，等价于 skip-permissions） |
| 会话 Resume | `--continue`（最近会话）或 `-r <id>` |
| 信任弹窗 | 无首次信任弹窗，无需 auto-dismiss |
| 推荐模型 | `kimi-for-coding`、`kimi-k2.6`、`kimi-k2.5` |

### 实现要点

- `CLI_PROFILES.kimi.writeConfig`：需同时写两个文件——markdown 提示词 + agent YAML（含 `system_prompt_path` 指向 markdown）
- `CLI_PROFILES.kimi.buildCmd`：`kimi --agent-file <yaml> [--afk] [--continue]`
- `CLI_PROFILES.kimi.getEnv`：无需特殊环境变量
- `CLI_PROFILES.kimi.trustTexts`：空数组（无信任弹窗）
- 模型列表加入 `index.html` 的 `CLI_MODELS.kimi`

**安装：** `npm install -g @moonshotai/kimi-code`

---

## 跨会话记忆 (TODO)

> **状态：已设计，待实现。**

### 设计目标

每次开新会话，Agent 对上下文一无所知——不知道项目架构、上次的决策、当前任务进展。目标：通过两层记忆让跨会话、跨 CLI 的协作有延续性。

### 两层职责分离

| 层 | 存储位置 | 内容 | 生命周期 |
|----|---------|------|---------|
| **Room 记忆** | `supervisor/room-memories/{roomId}.md` | 任务历史、角色间决策、当前进度、跨角色约定 | 跟 Room 走，UI 可手动编辑/清除 |
| **项目知识（ai-docs）** | `archDir/ai-docs/` + `devDir/ai-docs/` | 架构设计、API 契约、代码规范、ADR | 跟项目走，版本控制管理 |

### 注入规则（Spawn 时）

| 角色 | 注入内容 |
|------|---------|
| arch | Room 记忆 + archDir/ai-docs/*.md + devDir/ai-docs/*.md |
| dev  | Room 记忆 + archDir/ai-docs/*.md + devDir/ai-docs/*.md |
| qa   | Room 记忆 + devDir/ai-docs/*.md |

文件/目录不存在则静默跳过。

### Agent 写记忆

- **ai-docs**：Agent 直接在对应目录写文件（推荐文件名：`architecture.md`、`api-contracts.md`、`conventions.md`）
- **Room 记忆**：通过 `/tmp/update-room-memory-{roomId}.sh` 脚本追加（带时间戳），例如：`echo "决定用 PostgreSQL" | /tmp/update-room-memory-{roomId}.sh`

### 实现要点

**server.js 改动：**
- 新增 `ROOM_MEMORIES_DIR = join(__dirname, 'room-memories')`（启动时 `mkdirSync`）
- 新增 `readAiDocs(dir)` — `readdirSync(dir/ai-docs)` 读所有 .md 拼接
- 新增 `buildMemoryContext(roomId, archDir, devDir)` — 返回 `{ archCtx, devCtx, qaCtx }` 三个 markdown 字符串块
- 更新 `writeRoomScripts` 签名增加 `archDir, devDir, qaDir` 参数，在写 prompt 文件前注入记忆上下文
- 新增 `/tmp/update-room-memory-{roomId}.sh` 脚本（cat stdin + 时间戳追加到 room-memories 文件）
- 新增 `GET /rooms/:id/memory` 和 `PUT /rooms/:id/memory` 路由

**prompts/*.md 改动：**
- 各角色 prompt 末尾加知识沉淀规范段（含 `<devDir>` 和 `<update-room-memory-script>` 占位符，由 `writeRoomScripts` 替换）

**index.html 改动：**
- Relay bar 新增"📝 记忆"按钮，打开 Memory 面板
- Memory 面板上半：可编辑 Room 记忆 textarea（`GET/PUT /rooms/:id/memory`）
- Memory 面板下半：只读显示 archDir/ai-docs 和 devDir/ai-docs 文件列表
- 记忆按钮角标：Room 记忆非空时显示小圆点

---

## 已知问题与修复历史

| 问题 | 根因 | 修复 |
|------|------|------|
| 历史会话为空 | macOS `/tmp` → `/private/tmp` 符号链接导致路径编码不匹配 | `realpathSync` 解析真实路径 |
| 会话排序错误 | `last-prompt.timestamp` 字段始终为 null | 改用文件 `mtime` 排序 |
| Resume 后 Claude 自动继续工作 | 恢复会话会载入上下文并继续 | 首次 idle 注入 STOP 消息（`resumeInterrupt` 标志） |
| 工具审批 TUI 被消息破坏 | 注入 `isTerminalInteractive` 检测误判 | 移除检测，直接投递（接受视觉干扰） |
| 开发者收不到任务（死锁） | `isTerminalInteractive` 把正常提示符也判定为交互中 | 同上 |
| 重复派发已完成任务 | `devReviewWatermark` 未在派发时更新 | `inboxDeliver` 中 arch→dev 时推进水印 |
| 重连创建新会话 | reconnect 逻辑总是 spawn 新进程 | 先尝试 WS 直连，4001 才 respawn |
| 目录变更不触发会话刷新 | `change` 事件需要失焦才触发 | 改用 `input` 事件 + 400ms 防抖 |
| 刷新页面终端内容丢失 | WS 重连后无历史回放 | 服务端维护 `rawBuf`，新连接立即发送 |
| Room 详情页未启动时不知道下一步 | 状态文字含义不清 | PTY 未启动时自动弹出 Session Picker |
| QA 消息 from 字段推断错误 | `/notify` 对所有发往 arch 的消息都推断 from='dev' | 脚本显式传 from 字段，服务端优先使用 |
| 提示词脚本路径错误 | base prompt 里用通用占位符，Agent 复制后发送失败 | `writeRoomScripts` 替换占位符后再写文件 |

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
├── server.js          # 后端：PTY 管理、HTTP/WS 服务、Inbox、Watchdog、Model Switch、CLI_PROFILES
├── index.html         # 前端：Room 列表 + 多终端视图（单文件，无构建）
├── sessions.js        # 遗留：旧版 orchestrator 兼容层
├── rooms.json         # Room 配置持久化（git 忽略，含 archCli/devCli/qaCli 字段）
├── package.json
├── prompts/
│   ├── arch.md        # 产品架构师系统提示词模板
│   ├── dev.md         # 开发工程师系统提示词模板
│   └── qa.md          # QA 工程师系统提示词模板
├── room-memories/     # Room 记忆文件（{roomId}.md，git 忽略）（TODO）
└── DESIGN.md          # 本文档
```
