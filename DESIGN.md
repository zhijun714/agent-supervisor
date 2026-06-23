# Supervisor — 多 Agent 协作开发工具

## 概述

Supervisor 是一个基于浏览器的本地 Web 工具，通过最多三个并行的 AI CLI 终端（产品架构师 + 开发工程师 + 可选 QA 工程师）实现多智能体协作开发。支持 Claude / Gemini / Codex / Kimi 四种 CLI，各角色可独立选择不同 CLI 和模型。产品架构师负责需求定义、计划审核和验收，开发工程师负责具体实现，QA 工程师对交付物做独立对抗性测试，三者通过跨会话消息机制自动协调。

---

## 需求背景

### 痛点

手动在一个 Claude 会话里做所有事效率低，上下文容易污染。希望模拟真实团队的分工模式：一个 AI 角色负责架构决策，另一个负责编码实现，互相制衡、互相审查，可选引入独立 QA 进行对抗性验证。

### 目标

- 最多三个 AI CLI 进程并行运行，角色严格分离；支持 Claude / Gemini / Codex / Kimi 混用
- 浏览器可视化所有终端，无需 SSH
- 消息自动路由：PA → Dev（任务派发）、Dev → PA（进度汇报）、PA → QA（测试委托）、QA → PA（测试报告）
- 消息优先级：紧急消息跳队列并 ESC 中断目标 Agent
- 会话持久化：刷新页面或重启浏览器不中断 AI 进程
- 多项目支持：不同项目用不同 Room 隔离
- 模型切换：运行时切换任意角色的模型，会话上下文通过各 CLI 对应的 resume 机制保留
- 跨会话记忆：Room 级协作决策 + 项目 ai-docs 在 spawn 时自动注入各角色 prompt

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
    │  CLI_PROFILES（Claude / Gemini / Codex / Kimi 命令构建 + 信任处理）
    │  Room 记忆（room-memories/{roomId}.md）
    ▼
AI CLI（各角色独立选择）
    ├── Product Architect  (claude / gemini / codex / kimi，--disallowedTools 仅 claude 生效)
    ├── Developer          (claude / gemini / codex / kimi)
    └── QA Engineer        (claude / gemini / codex / kimi)  [可选]
```

**核心原则：会话生命周期由 Node.js 维护，浏览器只是显示层。** 关闭浏览器不会停止 AI CLI 进程，刷新页面会自动重连已运行的终端。

---

## 核心功能

### 1. 多 Room 管理

每个 Room = 一组角色终端（PA / Dev / QA），各自拥有独立的：
- 项目目录（arch/dev/qa 可以不同）
- CLI 会话（含选定的 CLI 类型和模型）
- 消息 inbox
- Auto-review 状态
- Watchdog 定时器
- Room 记忆（room-memories/{roomId}.md）

**角色按需启用：** 三个角色的目录均可空（`archDir` / `devDir` / `qaDir` 都是 `string | null`），建房时至少启用一个角色即可。后端只为有目录的角色 spawn 终端、写 prompt/notify 脚本；前端详情页按启用角色自适应显示 1~3 列，relay 按钮（Dev→PA、Dev→QA）仅在两端都启用时显示。依赖某角色的自动逻辑（Auto-Review、飞书推送等）按 PTY 是否 alive 天然收敛，缺谁就不跑。

Room 配置持久化到 `rooms.json`，服务器重启后仍可查看（PTY 需手动重启）。

**URL 路由：**
- `/` — 房间壳（左侧 tab 栏 + 右侧 iframe 区，详见前端章节）
- `/?room={id}` — Room 详情页（单/双/三终端视图，也是壳内 iframe 的内容）

### 2. Inbox 消息机制

```
Agent A → inboxSend(to, from, text, priority)
         ├─ 目标 PTY 空闲 → 立即 inboxDeliver
         └─ 目标 PTY 忙碌 → 加入队列，等待 2s 无输出后批量投递
                           └─ priority=urgent → unshift 到队首 + 发 ESC 中断
```

消息用 bracketed paste 注入（`\x1b[200~...message...\x1b[201~` + `\r`），避免触发 shell 的特殊字符处理，Claude 将其识别为 `<cross-session-message>` 标签。

**优先级机制：**
- `normal`（默认）：`push` 到队列末尾，等 Agent 当前输出结束后投递
- `urgent`：`unshift` 到队列最前，同时向目标 PTY 发送 `\x1b`（ESC）打断当前生成，下一个 idle tick 立即投递

**批量投递（Batch Delivery）：**

idle tick 触发时，若队列中有多条消息，一次性全部合并投递：urgent 消息排在前面，随后是 normal 消息，每条消息保持独立的 `===FROM:===` 包裹，以 `\n\n` 分隔，合并成单次 bracketed paste 写入 PTY。Agent 一次性收到全部积压内容，只被打断一次。

```
idle 触发 → 队列中有 3 条消息
→ 合并为:
  ===FROM:arch===
  任务1
  ===END===

  ===FROM:arch===
  任务2
  ===END===

  ===FROM:arch===
  任务3
  ===END===
→ 单次 bracketed paste 写入
```

**队列积压可视化与清空：**

- 每个角色的终端 header 上有持久化 `📨 N` 积压徽章（amber；含 urgent 时变红），实时反映当前队列深度
- 点击徽章立即调用 `POST /rooms/:id/inbox/clear` 清空该角色队列，适合消息已过时需要放弃的场景
- 徽章在 `inbox_delivered` 或 `inbox_cleared` 事件后自动消失

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

QA 工程师遵循**对抗性测试原则**：不提前阅读实现代码，测试边界值、错误路径、并发、集成接缝、回归，找 Bug 而非确认正常路径。

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
1. Server 根据角色的 CLI 类型确定 sessionId（Claude: `listSessions` 找最新、Gemini: `latest`、Codex: `last`、Kimi: 已捕获的 sessionId 或 `-C`）
2. 更新 `rooms.json` 中对应的 `archModel` / `devModel` / `qaModel`
3. 用新模型 + CLI 对应的 resume 参数 respawn PTY（会话上下文完整保留）
4. 广播 `model_switched` 事件，前端自动重连 PTY WS 并更新模型徽章

**各 CLI 可用模型：**

| CLI | 模型 |
|-----|------|
| Claude | `claude-sonnet-4-6`（默认）、`claude-opus-4-8`、`claude-haiku-4-5-20251001` |
| Gemini | `gemini-2.5-flash`（默认）、`gemini-2.5-pro`、`gemini-2.5-flash-lite`、`gemini-3-flash-preview` 等 |
| Codex | `gpt-5.5`（默认）、`gpt-5.5-pro`、`gpt-5.4`、`gpt-5.4-mini`、`o4-mini`、`o3` |
| Kimi | `kimi-for-coding`（默认）、`kimi-k2.6`、`kimi-k2.5`、`moonshot-v1-8k/32k/128k` |

### 9. 多 CLI 支持

每个角色可独立选择 Claude / Gemini / Codex / Kimi CLI，通过 `CLI_PROFILES` 常量统一管理各 CLI 的差异：

| 能力 | Claude | Gemini | Codex | Kimi |
|------|--------|--------|-------|------|
| 命令构建 | `claude --model ... --append-system-prompt-file ...` | `gemini -m ...` + `GEMINI_SYSTEM_MD` env | `codex -m ...` + `XDG_CONFIG_HOME` + config.toml | `kimi -m ... --skills-dir /tmp/kimi-skills-{roomId}-{role}` |
| 系统提示注入 | `--append-system-prompt-file <file>` | `GEMINI_SYSTEM_MD=<file>` | `model_instructions_file = "<file>"` in config.toml | SKILL.md 写入 `/tmp/kimi-skills-{roomId}-{role}/`，通过 `--skills-dir` 加载 |
| 静默模式 | `--dangerously-skip-permissions` | 不支持 | 不支持 | `--yolo`（仅新建会话，不可与 `-C`/`-S` 同用） |
| 信任确认 | 扫描 "Do you trust the files" → 发 Enter | 扫描 "Open documentation" → 发 `D\r` | 扫描 "Allow" → 发 Enter | 无信任弹窗 |
| Resume | `--resume <sessionId>` | `-r latest` | `codex resume --last` | `-S <sessionId>` 或 `-C`（续最近） |
| Session 列表 | 读 `~/.claude/projects/{encoded}/*.jsonl` | 不支持 | 读 `~/.codex/session_index.jsonl`（含目录递归扫描兜底 + 自动修复索引缺项） | 读 `~/.kimi-code/session_index.jsonl` |
| disallowedTools | 支持（arch 角色使用） | 不支持（忽略） | 不支持（忽略） | 不支持（忽略） |

### 10. 会话 ID 持久化

每个 Room 在 `rooms.json` 中保存各角色上次使用的会话 ID：
```json
"archSessionId": "abc12345",
"devSessionId":  "ses_6a8b2ce0-...",
"qaSessionId":   null
```

**写入时机：**
- 用户手动选择 Resume → spawn 请求里已有 sessionId，直接存入
- 新建 Claude 会话 → spawn 后后台 poll `~/.claude/projects/{encoded}/` 等新 `.jsonl` 出现（最多 30s，每 2s 一次）
- 新建 Kimi 会话 → spawn 后后台 poll `~/.kimi-code/session_index.jsonl` 等新 entry 出现（同上）
- 新建 Codex 会话 → spawn 后后台 poll `~/.codex/session_index.jsonl`；若索引没更新则自动扫描 `~/.codex/sessions/` 目录树找到新 `.jsonl` 文件，并修复索引（最多轮询 15 次，每次 2s）

**Session Picker 变化：**
- 对 Claude / Kimi / Codex：拉取历史会话列表，预选 `room.{role}SessionId`（标注"上次使用"）
- 对 Gemini：无会话列表，显示"当前 CLI 不支持历史会话"
- 收到 `session_captured` 事件后静默更新本地 room 缓存

### 11. CLI 限制检测与自动重试

多种 CLI 在运行时可能遭遇中断：Codex 有 API 配额上限，Claude Code 有每日 session 用量限制。Supervisor 统一检测并调度自动重试，共用同一套基础设施。

#### 通用重试核心：`scheduleLimitRetry`

```js
scheduleLimitRetry(termId, entry, delayMs)
```

- 读 `room[${role}Cli]` 确定当前 CLI，按 CLI 类型选对应 resume 参数（Claude: `--resume last`、Gemini: `latest`、Codex: `resume --last`、Kimi: 已捕获 sessionId 或 `last`）
- 广播 `agent_quota_exceeded` 事件（含 `retryAt` 时间戳），UI 展示 `⏰` 倒计时徽章
- 定时到后自动重启，通知 arch 角色等待消息

`scheduleCodexRetry` 保留为向后兼容别名，内部调用 `scheduleLimitRetry`。

#### Codex 额度超限

检测到 PTY 输出含 `"Usage limit reached"` / `"quota exceeded"` / `"insufficient_quota"` 等字样时：
1. `handleCodexQuota` 触发，调用 `scheduleLimitRetry(termId, entry, 1小时)`
2. 向 arch 角色发消息："Codex ${role} 额度用尽，将于 HH:mm 自动重启"

#### Claude Session 到期

Claude Code 达到每日 session 用量限制时，终端输出：
```
You've hit your session limit · resets 5pm (Asia/Shanghai)
```

1. PTY 数据处理器检测 `"you've hit your session limit"` 字样（`cli === 'claude'`）
2. **`parseClaudeResetMs(text)`** 解析重置时间：
   - 匹配 `resets Xpm (TZ)` 或 `resets X:Ypm (TZ)` 格式
   - 用 `Intl.DateTimeFormat` 在目标时区计算当前时间，精确得到距重置的毫秒数
   - 解析失败兜底 1 小时
3. `handleClaudeLimit` 调用 `scheduleLimitRetry(termId, entry, resetMs)`，向 arch 发送等待通知
4. UI 复用相同的 `⏰ 额度用尽` 倒计时徽章（无需额外前端改动）

**`POST /rooms/:id/adjust-quota-retry`**：支持所有 CLI，`delayMs=0` 立即重试（已修复之前硬编码 `CLI_PROFILES.codex` 的 bug，现在读取实际 CLI）。

### 12. Kimi 退出检测健壮化

Kimi 进程退出由 PTY 输出中的退出标记触发。早期使用全局静态标记 `__KIMI_EXITED__`，导致两类问题：

**问题一：Kimi 工具调用循环触发退出处理器**
Kimi agent 运行时会调用 shell 工具执行历史命令，若 shell history 里恰好有带旧 exit marker 的命令，该命令输出标记字符串 → 服务端以为外层 Kimi 已退出 → 触发重启 → 循环。

**修复：每次 spawn 生成唯一标记**
```js
entry._kimiExitMarker = `KIMI_EXITED_${Math.random().toString(36).slice(2, 10)}`
const cmd = rawCmd + `; echo ${entry._kimiExitMarker}\r`
```
每次 spawn（含 `handleKimiExit` 重启）都轮换新标记，历史记录里的旧标记不再匹配。

**问题二：Kimi 恢复失败导致快速退出循环**
若 `-C`（续最近会话）失败，Kimi 立即退出 → `handleKimiExit` 再次用 `-C` → 循环。

**修复：快速退出检测**
```js
const quickExit = (now - entry._kimiLastRestartAt) < 15000
const sessionId = quickExit ? null : (room[`${role}SessionId`] || 'last')
```
15 秒内再次退出则降级为新建会话，避免无限恢复循环。

### 14. 通信工具集成（Communication Adapters）

AI 架构师可主动向用户发送通知，用户的回复也会自动注入架构师 inbox，实现双向异步沟通。采用可插拔适配器设计，目前内置飞书（Feishu/Lark）适配器，无需公网 IP，通过长连接（WebSocket）接收事件。

**架构（通用层）：**
- `getAdapterStatus(adapter)`：返回 `{ connected, error, configOk, hint }`，供 API 和 UI 使用
- `startComm(adapter)` / `stopComm(adapter)`：通用启停接口，按 adapter 名分发到具体实现
- `commSend(roomId, text)`：通用发送接口，按 Room 的 `commAdapter` 字段路由
- `maybeAutoStartComm()`：服务启动时扫描所有 Room，自动启动已启用的适配器

**飞书适配器（`comm-feishu.js`）：**
- `feishuState`：全局单例，维护 WS 长连接状态（client / wsClient / started / msgMap）
- lazy import `@larksuiteoapi/node-sdk`，未安装时优雅降级
- `feishuState.msgMap`：`message_id → roomId` 映射，用户回复时通过 `parent_id` 查 roomId

**架构师通知用户的两种方式：**
1. **输出标记（推荐）**：在终端输出 `[通知]` 开头的行，server 自动捕获并通过已配置的渠道发送，无需调用脚本
2. **脚本调用**：主动调用 `notify-user-{roomId}.sh`，脚本内部调 `POST /rooms/:id/comm/send`

**消息回复路由：**
1. 用户回复某条消息 → 适配器通过 `parent_id` 查 `msgMap` 找到 roomId
2. 找不到 `parent_id` → 降级路由到最近 spawn 的、开启了通信的 Room
3. 注入架构师 inbox（`inboxSend(archTermId, 'user', text)`）

**配置（per-Room）：**

| 字段 | 说明 |
|------|------|
| `commEnabled` | 是否启用通信 |
| `commAdapter` | 适配器名（目前支持 `'feishu'`）或 `null` |
| `commReceiveId` | 接收方 ID（格式因适配器而异，飞书：chat_id / open_id） |
| `commReceiveIdType` | 飞书适配器专用：`chat_id`（默认）/ `open_id` / `user_id` |

**环境变量（飞书适配器）：**
- `FEISHU_APP_ID`：飞书应用 ID
- `FEISHU_APP_SECRET`：飞书应用密钥

**UI：**
- Relay bar "📡 通信"按钮，圆点 = 适配器已连接
- 通信面板：适配器选择、适配器配置（Feishu 显示接收 ID 等）、连接状态、手动重连
- `comm_message_received` WS 事件：按钮闪绿光提示用户回复已注入

---

### 13. 跨会话记忆

spawn 时自动注入两层记忆，让新会话对历史协作上下文不陌生：

| 层 | 存储位置 | 内容 | 生命周期 |
|----|---------|------|---------|
| **Room 记忆** | `supervisor/room-memories/{roomId}.md` | 任务历史、角色间决策、当前进度、跨角色约定 | 跟 Room 走，UI 可手动编辑/清除 |
| **项目知识（ai-docs）** | `archDir/ai-docs/` + `devDir/ai-docs/` | 架构设计、API 契约、代码规范、ADR | 跟项目走，版本控制管理 |

**注入规则（Spawn 时）：**

| 角色 | 注入内容 |
|------|---------|
| arch | Room 记忆 + archDir/ai-docs/*.md（+ devDir/ai-docs/*.md，若两目录不同） |
| dev  | Room 记忆 + archDir/ai-docs/*.md（+ devDir/ai-docs/*.md，若两目录不同） |
| qa   | Room 记忆 + devDir/ai-docs/*.md |

**Agent 写记忆：**
- **ai-docs**：Agent 直接在对应目录写文件（推荐：`architecture.md`、`api-contracts.md`、`conventions.md`）
- **Room 记忆**：通过 `/tmp/update-room-memory-{roomId}.sh` 脚本追加（带时间戳）

**Memory 面板（UI）：**
- Relay bar 的"📝 记忆"按钮，角标小圆点表示记忆非空
- 上半：可编辑 Room 记忆 textarea（`GET/PUT /rooms/:id/memory`）
- 下半：只读显示 archDir/ai-docs 和 devDir/ai-docs 文件列表

---

## 技术方案

### 后端 (src/)

| 模块 | 实现 |
|------|------|
| PTY | `node-pty` spawn shell，key = `${roomId}-arch` / `${roomId}-dev` / `${roomId}-qa` |
| WebSocket | `ws` 库，`/pty/*` 路由到 PTY WS，`/` 路由到事件 WS |
| 会话查找 | Claude: 读 `~/.claude/projects/{encoded-path}/*.jsonl`，按 mtime 排序；Kimi: 读 `~/.kimi-code/session_index.jsonl` 按 updatedAt 排序；Codex: 读 `~/.codex/session_index.jsonl`，fallback 递归扫 `~/.codex/sessions/` 目录，扫描时自动修复索引缺项 |
| 路径编码 | `realpathSync` 解析符号链接（macOS `/tmp` → `/private/tmp`），`/` 替换为 `-` |
| Room 持久化 | `rooms.json` 本地文件，含 archModel/devModel/qaModel/archCli/devCli/qaCli/archSessionId/devSessionId/qaSessionId/commEnabled/commAdapter/commReceiveId/commReceiveIdType 字段 |
| 环境变量加载 | 启动时自动读取同目录 `.env` 文件（IIFE 解析，不覆盖已有 shell 环境变量） |
| **运行时配置** | `supervisor.config.json` 覆盖 `src/config.ts` 中的默认值（`deepMerge`）；涵盖 rotation / distiller / inbox / review / watchdog 五个子系统的所有可调参数 |
| CLI 配置 | `CLI_PROFILES` 常量，每种 CLI 含 buildCmd / getEnv / writeConfig / trustTexts / trustKey / supportsResume / models / defaultModel |
| 信任自动处理 | spawn 后扫描 PTY 输出，检测到信任提示后 500ms debounce 发送 trustKey |
| 通知脚本 | 每个 Room spawn 时写 11 个脚本：6 个 notify（含 urgent）+ 3 个 switch-model + 1 个 update-room-memory + 1 个 notify-user |
| 通信适配器 | 通用适配器层（`startComm/stopComm/commSend/getAdapterStatus`）按 adapter 名分发；飞书适配器：`@larksuiteoapi/node-sdk` lazy import，未安装时优雅降级；`msgMap` 记录 message_id → roomId 用于回复路由 |
| 路径注入 | `writeRoomScripts` 在生成最终 prompt 文件时替换所有占位符：`/tmp/notify-dev.sh` → 含 roomId 的真实路径、`<switch-model-*-script>` → 真实脚本路径、`<roomId>` → 实际 room ID（用于 prompt 内的启动验证命令）、`<devDir>/<archDir>` → 实际目录路径；替换完成后追加 Room 记忆上下文和脚本路径 footer |
| Room 记忆 | `room-memories/{roomId}.md`，`buildMemoryContext` 负责读取并合并 ai-docs |
| Inbox 批量投递 | `inboxOnIdle` 用 `splice(0)` 原子性清空队列；单条走 `inboxDeliver`；多条按 urgent-first 排序后合并成单次 bracketed paste；`POST /rooms/:id/inbox/clear` 支持运行时丢弃积压 |
| **会话轮转**（disabled） | `src/rotation.ts`：rawBuf 阈值 + 会话年龄 + 边界 pattern 三重条件触发；触发后注入 CHECKPOINT_PROMPT，提取 LEDGER，开新会话并注入 RECONCILE；`rotation.enabled: false` |
| **知识蒸馏**（disabled） | `src/distiller.ts`：PTY 空闲时运行 `claude -p` headless 提炼知识条目，经 commSend 发用户审批后写入 ai-docs；`distiller.enabled: false` |
| **远程访问** | `server.ts` 默认绑定 `0.0.0.0`（`HOST` 环境变量可改）；启动时打印 LAN IP |

### 前端 (frontend/app.ts → public/app.js)

- **xterm.js 5.3.0** + **xterm-addon-fit 0.8.0**（无框架，原生 JS，esbuild 打包）
- **主题系统（`frontend/themes.ts`）**：内置 16 套配色（Tabby/iTerm2 格式，仅含 `background/foreground/cursor` + 16 ANSI 色）。`toXtermTheme()` 映射成 xterm `ITheme`；`deriveUI()` 由配色用色彩混合（按 bg→fg 混合，自动适配深/浅）推导出界面 chrome 的 CSS 变量（`--bg/--bg2/--bg3/--border/--text/--text-dim/--term-bg` 等），实现「一套配色统一染整个 UI」。`applyTheme(name, terms?)` 同时设 `:root` 变量并热切换在场终端的 `term.options.theme`。选择器在房间头部（iframe 内）；持久化双写：服务端 `ui-prefs.json`（`GET/PUT /prefs`，清浏览器缓存不丢）+ `localStorage['sup-theme']`，后者经 `storage` 事件即时同步父壳与其他已开 iframe。加新主题 = 往 `THEMES` 粘一组 16 色。
- **房间壳（iframe 方案，新首页）**：`initShell()` 渲染左侧 tab 栏 + 右侧 `#shellMain`。每个打开的房间用 `<iframe src="/?room=id">` 装载，复用现有详情页；切 tab 只切 iframe 的显示/隐藏，已加载的 iframe 后台保活 → 切换瞬时、终端 WS 零重连。`#shellHome` 是 home 面板，内嵌原有房间卡片 grid 作为「打开已存在房间 / 新建」入口。详情页在 iframe 内运行时（`window.parent !== window.self`）隐藏自身的「← Rooms」返回按钮，导航交给壳的 tab 栏。
- **tab 常驻（服务端 pinned）**：打开房间 → PUT `/rooms/:id {pinned:true}` 落盘；壳启动时把所有 `pinned` 房间重新挂回左侧（刷新页面、服务重启后都恢复），上次激活的 tab 用 `localStorage['sup-active-room']` 记忆。手动关闭 tab → POST `/rooms/:id/close`：取消 pinned 并杀掉该房间 arch/dev/qa 的 PTY。删除房间也会移除其 tab。
- `?room=xxx` URL 参数路由：有 `room` → 详情页（壳内 iframe 即走此路径）；无 → 房间壳
- Session Picker：每次 room PTY 未启动时自动弹出，含 CLI 选择（紫色）+ 模型下拉选择；三列对应 PA/Dev/QA，任一目录可留空表示不启用该角色；Claude/Kimi/Codex 显示历史会话列表；spawn 成功后立即同步 `currentRoom.{role}SessionId`，确保下次 Session Picker 默认选中正确会话
- `CLI_MODELS` 常量：每种 CLI 对应的可选模型列表；CLI 切换时自动刷新模型选项和会话列表
- Room 名称点击内联编辑，自动 PUT `/rooms/:id`
- Relay bar：Dev → PA 审查、Dev → QA 测试、Watchdog 开关、📝 记忆按钮、📡 通信按钮
- 通信面板（📡）：适配器选择 + 适配器专属字段（飞书：接收 ID 及类型）+ 连接状态指示灯 + 重连按钮；`comm_status` / `comm_message_received` WS 事件实时更新
- 面板 header：模型徽章（Opus/非 Claude CLI 时显示对应颜色）；`📨 N` 积压徽章（点击清空队列）
- `model_switched` 事件：自动重连对应 PTY WS + 更新模型徽章（含 CLI 信息）
- Memory 面板：Room 记忆编辑 + ai-docs 文件列表，角标圆点表示有记忆
- **移动端适配**（≤768px）：顶部标签栏（🏛 架构师 / 🧑‍💻 开发 / 🔍 QA），默认只显示架构师终端，标签切换；Session Picker 单列滚动；Relay bar 横向滚动
- **xterm 右边界修复**：`.term-wrap { padding-right: 6px }` 使 FitAddon 在计算列数时正确扣除右侧空间，防止最后一列字符被裁剪
- **PWA（`public/index.html` + `src/routes.ts`）**：
  - **Manifest**：`GET /manifest.json` 返回 Web App Manifest（`display:standalone`、192/512 SVG data-URI 图标、`theme_color:#0f1117`），让 Chrome/Edge 地址栏出现安装按钮
  - **Service Worker**：`GET /sw.js` 返回最小 SW（`install` 触发 `skipWaiting`、`activate` 触发 `clients.claim`、空 `fetch` 事件监听器不调用 `respondWith`）；空 fetch handler 是 Chrome 可安装性的必要条件，同时不拦截任何请求、所有响应直接走网络；响应头 `Service-Worker-Allowed: /` 授权根路径注册
  - **零缓存**：manifest.json / sw.js / index.html / app.js 均带 `Cache-Control: no-cache, no-store, must-revalidate`；SW 不调用 `caches.open`/`cache.put`；改代码后刷新即时生效
  - **标题分场景**：`isStandalone()` 通过 `matchMedia('(display-mode: standalone)')` 判断运行场景；`setTitle(title)` 在 standalone 下截去 "Supervisor — " 前缀只传房间名（Chrome 自动拼成 "Supervisor - 房间名"），首页传 `''`（Chrome 回退显示 manifest.name "Supervisor"，无横杠）；普通浏览器下保持 "Supervisor — 房间名"/"Supervisor" 不变
  - **已知坑**：已安装 PWA 标题栏格式为 `manifest.name + " - " + document.title`（document.title 非空时）；`document.title=''` 时 Chrome 直接回退显示 manifest.name，正是首页理想取值；ASCII 空格会被 `document.title` getter trim，零宽空格（U+200B）虽不被 trim 但同样会产生 "Supervisor -" 尾巴，两者均已弃用

### 系统提示词设计

提示词模板存放于 `prompts/` 目录，spawn 时读取后先替换占位符路径，再插入 Room 记忆上下文块，最后追加 Room 特定的脚本路径 footer：

**产品架构师 (`prompts/arch.md`)**
- 禁止输出代码块，禁用 Write/Edit/MultiEdit/NotebookEdit/Task 工具
- **Session Start**：启动时立即 `ls /tmp/notify-{roomId}-*.sh` 验证脚本存在，缺失则不继续
- 任务派发模板（含验收测试清单）、计划审核、中途普通/紧急纠错、QA 路由、验收格式
- **指导风格**：只指出症状（输入/输出/期望行为），不追根溯源，不读工程师实现代码；外发动作（push/部署）要求工程师逐步汇报
- **验收独立性**：不信完成报告，对核心风险场景自己独立验；审计划时卡住"一笔带过"的隐患，转为硬性验证门槛；验证点拆成具体子场景（权限三态、状态五态等）；工程师过度分析简单改动时发 checkpoint 中断
- Auto-Review / Manual Review 处理规则
- 模型切换：可切换自己和下属角色的模型，附带升级判断标准
- 知识沉淀：写 ai-docs，关键决策写 Room 记忆
- **用户通知**：任务完成、需要用户决策时输出 `[通知] ...` 标记（Supervisor 自动转发至配置的通信渠道），或调用 `notify-user-{roomId}.sh` 脚本

**开发工程师 (`prompts/dev.md`)**
- **Session Start**：启动时立即 `ls /tmp/notify-{roomId}-arch.sh` 验证脚本存在
- 5 步工作流：等待任务 → 复述理解（echo back）→ 提交计划 → 等待批准 → 实现 → 报告完成
- Step 1 收到任务后先 echo 复述要点，确认理解正确（尤其模型切换/会话恢复后）
- Step 4 报告必须包含真实命令 + 真实输出，"code reads confirm"不是有效证据
- **Quality Standards**：只交最小改动（改一个版本须检查兄弟版本，提交前 `git diff`）；先用现有能力；简单改动不过度分析，直接落地
- Step 5 明确角色锚定：收到 QA 反馈后仍以 Developer 身份修 bug，不切换成测试模式
- 不得自主开始工作，不得跳过计划步骤，测试未全通过不得报完成
- 模型切换：卡住超过 2 次可自行升级

**QA 工程师 (`prompts/qa.md`)**
- **Session Start**：启动时立即 `ls /tmp/notify-{roomId}-arch-from-qa.sh` 验证脚本存在
- 等待 PA 分配，收到分配前什么都不做
- 测试前不读实现代码，独立从规格推导测试用例
- **Engineer Miss Patterns**：专门覆盖工程师常跳过的场景——happy path 停止、"一笔带过"声称不受影响、代码读推断而非实际运行；按功能类型枚举子场景（权限三态/状态五态/并发/边界值）
- 对抗性测试策略：边界值、错误路径、并发、集成接缝、回归、真实渲染验证（DOM/截图，非接口返回值）
- Bug 报告格式：严重度（HIGH/MED/LOW）+ 精确复现步骤 + 实际观察输出
- 模型切换：复杂安全/并发分析时可升级

---

## API 接口

| Method | Path | 说明 |
|--------|------|------|
| GET | `/rooms` | 列出所有 Room（含 archAlive/devAlive/qaAlive/watchdogEnabled） |
| POST | `/rooms` | 创建 Room（archDir/devDir/qaDir 均可空，至少启用一个角色） |
| PUT | `/rooms/:id` | 更新 Room（name/dirs/silent/model/`pinned` 字段；dirs 传空串即停用该角色） |
| POST | `/rooms/:id/close` | 关闭 tab：取消 `pinned` 并杀掉该房间 arch/dev/qa 的 PTY |
| DELETE | `/rooms/:id` | 删除 Room（杀所有角色进程） |
| POST | `/rooms/:id/spawn` | 启动 Room 的 PTY（仅 spawn 有目录的角色；含 CLI/模型/sessionId 选择） |
| POST | `/rooms/:id/watchdog` | 开启/关闭 Watchdog |
| POST | `/rooms/:id/switch-model` | 切换角色模型（respawn + resume 保留上下文） |
| GET | `/rooms/:id/memory` | 获取 Room 记忆内容；`?info=1` 返回 ai-docs 文件列表 |
| PUT | `/rooms/:id/memory` | 覆写 Room 记忆内容 |
| POST | `/rooms/:id/inbox/clear` | 清空指定角色的消息队列（`{ role: 'dev'|'arch'|'qa'|'all' }`）；返回 `{ ok, cleared }` |
| POST | `/rooms/:id/adjust-quota-retry` | 调整任意 CLI 限制后的重试延迟（`{ role, delayMs }`；`delayMs=0` 立即重试；自动使用实际 CLI 的 resume 机制） |
| POST | `/notify` | Agent 间消息路由（含 priority 字段：normal/urgent） |
| GET | `/prefs` | 读取全局 UI 偏好（含 `theme`） |
| PUT | `/prefs` | 写入全局 UI 偏好（merge，持久化到 `ui-prefs.json`） |
| GET | `/manifest.json` | Web App Manifest（`name/display:standalone/start_url/icons`）；SVG data-URI 图标，no-cache |
| GET | `/sw.js` | 最小 Service Worker（install+activate+空 fetch handler，无缓存）；`Service-Worker-Allowed: /` |
| GET | `/sessions` | 列出项目历史会话；`?cli=kimi` 查询 Kimi 会话 |
| GET | `/sessions/history` | 获取 Claude 会话消息历史 |
| GET | `/pty/buffer` | 获取 PTY 文本缓冲 |
| POST | `/pty/write` | 向 PTY 注入文本 |
| POST | `/pty/kill` | 杀指定 PTY |
| GET | `/rooms/:id/comm` | 获取通信配置 + 适配器连接状态（`adapterStatus`） |
| PUT | `/rooms/:id/comm` | 更新通信配置（adapter/receiveId/enable） |
| POST | `/rooms/:id/comm/send` | 发送消息给用户（由 notify-user 脚本调用） |
| POST | `/rooms/:id/comm/connect` | 重启通信适配器长连接（`/comm/feishu-start` 为向后兼容别名） |
| WS | `/pty/{termId}` | PTY 双向流（连接时回放 rawBuf） |
| WS | `/` | 事件流（inbox_delivered/inbox_queued/inbox_cleared/watchdog_*/pty_exited/model_switched/session_captured/agent_quota_exceeded/agent_restarted/comm_status/comm_message_received/comm_sent） |

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
| update-room-memory | `/tmp/update-room-memory-{roomId}.sh` | Agent 追加 Room 记忆（stdin → 带时间戳追加到 room-memories/{id}.md） |
| notify-user | `/tmp/notify-user-{roomId}.sh` | PA 向用户发通知（调 `POST /rooms/:id/comm/send`，需开启通信工具） |

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
| 新会话不知道脚本路径 / 写成文字不执行 | 每次新会话 Agent 需重新确认脚本可用，且易把调用写成文字标签而非真实 Bash 执行 | 三个 prompt 各加 Session Start 节，启动时立即 `ls` 验证；CRITICAL 节强调必须用 Bash tool 执行；`<roomId>` 占位符替换确保命令含真实路径 |
| captureNewSession 漏捕获 | 用 `listSessions` 过滤导致首次无内容文件被跳过 | 改为原始 `readdirSync` 文件名快照对比 |
| switch-model 记忆过时 | 切换模型时未重新生成 prompt（包含记忆） | switch-model 路由先调 `writeRoomScripts` 再 respawn |
| loadSessionsFor 切换 CLI 不刷新 | CLI change 事件未触发会话重载 | 增加 CLI select change → loadSessionsFor 联动 |
| Kimi 同目录 dev/qa 角色混淆 | QA spawn 覆盖 devDir 下的 AGENTS.md | 改用 `--skills-dir /tmp/kimi-skills-{roomId}-{role}`，角色完全隔离 |
| Dev 有时行为像 QA | Step 5 措辞不明确，收到 QA 反馈时模型可能切换角色 | dev.md Step 5 加明确角色锚定 |
| Kimi QA 无限重启循环（Phase 1）| `handleKimiExit` 始终用 `-C` 续上次会话，若会话恢复失败则 Kimi 立即退出，触发下一次 `-C`，死循环 | 快速退出检测（15s 窗口），快速退出时降级为新建会话 |
| Kimi QA 无限重启循环（Phase 2）| Kimi agent 内部运行 shell 工具时调用历史命令，输出了旧的全局 exit marker `__KIMI_EXITED__`，服务端误判外层 Kimi 退出并重启 | 每次 spawn 生成唯一 exit marker（`KIMI_EXITED_<random>`），历史记录旧标记永不匹配 |
| Codex 历史会话找不到 | Codex CLI bug：批量迁移后新建会话不写 `session_index.jsonl`，index 缺项 | `listCodexSessions` 增加目录递归扫描兜底；发现缺项时自动 `appendFileSync` 修复索引 |
| Session Picker 不显示 Codex 历史会话 | UI guard `if (cli !== 'claude' && cli !== 'kimi')` 把 codex 也排除 | 改为 `if (cli !== 'claude' && cli !== 'kimi' && cli !== 'codex')` |
| `adjust-quota-retry` 立即重试走错 CLI | 立即重试分支硬编码 `CLI_PROFILES.codex`，对 Claude/Kimi/Gemini 角色重试时用错命令 | 改为读 `room[${role}Cli]` 动态选 profile，resumeId 也按 CLI 类型确定 |
| Claude session 到期后无法自动恢复 | 只有 Codex 有额度检测，Claude 到期后进程挂起，无人重启 | 新增 `parseClaudeResetMs` 解析到期时间（支持任意时区），`handleClaudeLimit` 调用通用 `scheduleLimitRetry`，精确定时唤醒 |

---

## 设计决策与未实现功能

### 会话轮转（Session Rotation）

**背景：三类问题，三种解法**

运行时 Agent 面临三种本质不同的问题，必须分开处理：

| 问题 | 触发条件 | 现有解法 |
|------|----------|----------|
| **上下文溢出**（Context Overflow） | token 数超模型上限 | Claude 自动 sliding-window 压缩，继续运行 |
| **会话限额**（Session Quota / Rate Limit） | Claude 每 5 小时额度耗尽 | `scheduleLimitRetry`：解析重置时间，精确定时重启 |
| **上下文漂移**（Context Drift） | 长时间运行后模型幻觉增多、目标漂移 | **轮转**（唯一有效解法）|

关键认知：**压缩 ≠ 重置**。压缩保留全部历史，漂移跟着压缩一起延续下去。只有开启一个干净的新会话、通过结构化交接棒注入关键上下文，才能真正清除漂移。

**已实现代码（disabled）**

`src/rotation.ts` + `supervisor.config.json` 中 `rotation.enabled: false`：

- `maybeMarkRotationReady`：rawBuf 超阈值 + 会话存活时间 + 边界 pattern（`[TASK_COMPLETE]` 等）三重条件触发
- `maybeRotate`：bracketed paste 注入 CHECKPOINT_PROMPT → 等待 `checkpointWaitMs` → 从 textBuf 提取 LEDGER → 调 `spawnNewSessionForRotation`
- `spawnNewSessionForRotation`：在已有 prompt 文件末尾追加 RECONCILE 块，用 null sessionId（强制新建会话）启动

**为何没有提升为 UI 功能**

自动触发依赖 `[TASK_COMPLETE]` 等文本边界，Agent 输出格式不稳定，误触发代价高（中断进行中的工作）。  
手动成本也并不高——用户自己判断"这个 session 漂了"，手动 /clear 就能解决，但缺少 LEDGER 交接棒。

**有价值的残余：手动 Rotate 按钮**

比 auto-trigger 更合适的形态：在 relay bar 加一个 **"🔄 Rotate"** 按钮，点击时：
1. 向 Agent 注入 CHECKPOINT_PROMPT，让它写 LEDGER（关键决策、当前状态、未竟任务）
2. 等 LEDGER 写完后开一个干净新会话
3. 新会话 prompt 末尾附 RECONCILE 块注入 LEDGER

这本质是"带交接棒的 /clear"，比无记忆 /clear 强，比全自动触发稳，由用户判断时机。**此按钮尚未实现。**

---

### 知识蒸馏（Knowledge Distillation）

**问题本身有价值**

Agent 在长期工作过程中积累了大量推导、决策、踩坑——这些知识活在会话记录里，会话结束后消失，下次新会话需要重新推导。把这些知识持久化到 `ai-docs/` 或 Room 记忆是合理需求。

**已实现代码（disabled）**

`src/distiller.ts` + `supervisor.config.json` 中 `distiller.enabled: false`：

- PTY 空闲时（idle hook）触发 `triggerDistiller`
- 读取 PTY textBuf 的最近 N 字符
- 调用 `claude -p`（headless subprocess）提炼知识条目
- 通过 commSend 发给用户审批，用户回复 ok/取消 → `approveKnowledge`（写文件 + git commit）/ `rejectKnowledge`

**为何此方案过度工程化**

1. **Dev 本身更有判断力**：蒸馏是在会话之外运行一个独立 `claude -p` 看 textBuf，而 Dev 在整个任务过程中比任何外部观察者都清楚哪些内容值得记录。
2. **触发时机差**：PTY 空闲不等于任务完成，中间状态的知识噪音高。
3. **流程成本高**：每次蒸馏都需要用户在飞书审批，实际体验比 Dev 直接写文件更重。

**更好的替代方案**

在 `prompts/dev.md` 的任务完成步骤中加一条规范：

> 任务完成后，将关键决策/发现/约定写入 `ai-docs/`（推荐文件名：`architecture.md`、`conventions.md`、`api-contracts.md`）；重要跨角色决策写入 Room 记忆：`echo "..." | /tmp/update-room-memory-{roomId}.sh`

Dev 在报告完成前主动写文档，比外部蒸馏更准确、时机更好、不需要额外审批流程。这条规范已在 prompts 中有雏形，持续强化即可。

---

## 开发工具最佳实践

### 本地验证：隔离端口 + 按端口精准 kill（重要）

开发调试时**不要占用正在运行的真实实例的端口（默认 3458）和目录**。约定流程：

1. **隔离副本**：`git worktree add /tmp/supervisor-wt-xxx -b feature/xxx`（或直接 cp），并把 `node_modules` 软链过去；`rooms.json` / `public/app.js` 已被 gitignore，worktree 是干净起点。
2. **独立端口 + 独立 rooms 文件**启动：
   ```bash
   PORT=3999 ROOMS_FILE=/tmp/verify-rooms.json HOST=127.0.0.1 npx tsx src/server.ts
   ```
   想用真实房间验证可先 `cp` 真实 `rooms.json` 到副本路径，写入只落副本、绝不动原文件。
3. **停进程务必按端口/PID 精准 kill**：
   ```bash
   kill $(lsof -nP -iTCP:3999 -sTCP:LISTEN -t)
   ```
   **绝不要用 `pkill -f "tsx src/server.ts"` 这类宽匹配** —— 真实实例正是用 `tsx src/server.ts` 启动，宽匹配会把用户正在跑的 3458 实例一并杀掉。

### Codegraph MCP：代码探索提效

开发 Supervisor 本身时，推荐为 AI 工作区挂载 **Codegraph MCP**。Codegraph 在本地维护一张 SQLite 知识图谱，索引所有符号、调用边和文件，AI 可以通过单次工具调用获取精确的函数定义、调用链和影响面分析，而不需要逐文件 grep + 逐行 read。

**典型收益：**

| 场景 | 传统方式（grep + read） | Codegraph 方式 |
|------|----------------------|---------------|
| 找函数定义 | 2~5 次 grep + 1~2 次 read | 1 次 `codegraph_search` |
| 分析调用链 | 5~15 次 grep（动态调用遗漏） | 1 次 `codegraph_explore`，含动态调用跳转 |
| 影响面评估 | 手工 grep 所有引用 | 1 次 `codegraph_impact` |
| 架构概览 | 读多个文件再归纳 | 1 次 `codegraph_explore(自然语言问题)` |

**配置（`~/.claude/settings.json` 或项目 `.claude/settings.json`）：**

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "npx",
      "args": ["-y", "@codegraph/mcp", "--workspace", "/path/to/project"]
    }
  }
}
```

**在多 Agent 场景中的价值：** Supervisor 管理的三个角色终端都会使用同一套知识图谱。架构师用 `codegraph_explore` 做影响评估，工程师用 `codegraph_callers` 找到所有调用方，QA 用 `codegraph_impact` 确认改动范围——token 消耗约减少 40~60%，且符号引用更准确（不漏动态调用）。

---

## 启动方式

```bash
cd supervisor
npm install       # 首次安装依赖
npm start         # tsx src/server.ts（通过 tsx 直接运行 TypeScript）
# 或
npm run open      # 启动并自动打开浏览器
```

访问 `http://localhost:3458`，局域网设备可通过启动时打印的 LAN IP 访问。

---

## 目录结构

```
supervisor/
├── src/
│   ├── server.ts          # 入口：HTTP + WebSocket 服务，LAN IP 打印
│   ├── routes.ts          # 所有 HTTP 路由
│   ├── pty-manager.ts     # PTY 生命周期、idle hook、rotation/distiller 触发
│   ├── cli-profiles.ts    # 各 CLI 命令构建器（Claude/Gemini/Codex/Kimi）
│   ├── inbox.ts           # Agent 消息队列（bracketed paste 批量投递）
│   ├── watchdog.ts        # 卡死检测与恢复
│   ├── rotation.ts        # 会话轮转（disabled，rotation.enabled=false）
│   ├── distiller.ts       # 知识蒸馏（disabled，distiller.enabled=false）
│   ├── comm.ts            # 通信适配器注册 + 知识蒸馏审批门
│   ├── comm-feishu.ts     # 飞书长连接适配器
│   ├── config.ts          # AppConfig 类型 + deepMerge + loadConfig
│   ├── state.ts           # 运行时共享状态（rooms/ptys/clients/RotationRoleState）
│   ├── persistence.ts     # rooms.json 读写
│   ├── scripts.ts         # Notify / switch-model 脚本生成
│   ├── sessions.ts        # 会话列表 + captureNewSession 轮询
│   ├── types.ts           # TypeScript 类型（Room/RoomState/RotationRoleState 等）
│   ├── constants.ts       # 超时与缓冲区参数（从 cfg 读取）
│   └── utils.ts           # encodePath / stripAnsi
├── frontend/
│   ├── app.ts             # 浏览器 UI（esbuild 打包 → public/app.js）
│   └── themes.ts          # 16 套终端/界面配色 + 主题推导工具
├── public/
│   ├── index.html         # HTML 外壳 + 全部 CSS
│   └── app.js             # esbuild 打包产物（git 忽略）
├── prompts/
│   ├── arch.md            # 产品架构师系统提示词模板
│   ├── dev.md             # 开发工程师系统提示词模板
│   └── qa.md              # QA 工程师系统提示词模板
├── supervisor.config.json # 运行时可调参数覆盖（可选，deepMerge 到默认值）
├── build.mjs              # esbuild 前端打包脚本
├── rooms.json             # Room 配置持久化（git 忽略）
├── ui-prefs.json          # 全局 UI 偏好（主题等，git 忽略）
├── room-memories/         # Room 记忆文件（{roomId}.md，git 忽略）
├── .env.example           # 环境变量模板
└── DESIGN.md              # 本文档
```
