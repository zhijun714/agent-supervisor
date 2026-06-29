# 团队化路线图

## 核心判断

**把两件事拆开：**

| 需求 | 成本 | 路径 |
|------|------|------|
| **团队知识共享**：需求/决策/术语沉淀，复用已有代码上下文 | 便宜，走 git | Phase 1，不碰服务器 |
| **托管多租户**：共享实例、计费、隔离 | 贵，需要服务端工作 | Phase 2/3 |

不要为了"团队化"而直接跳到多租户，Phase 1 可以在不动服务器的前提下完成大部分知识复用价值。

---

## Phase 1 — 知识共享（不碰服务器）

**目标**：需求沉淀进 repo、新会话自动获得历史上下文、PA 审查后才入库。

**工作流：**

1. **房间接 Gitee Team**：PA spawn 时从 Gitee Team 拉取分配给该项目的需求条目，注入 Room 记忆
2. **完成自动沉淀**：启用 `distiller`（`distiller.enabled: true`），Dev 完成任务后自动提炼关键决策/约定
3. **沉淀进 repo**：提炼结果写入 `ai-docs/requirements/<id>.md`；涉及新领域概念时追加到 `CONTEXT.md`
4. **PA review 闸**：沉淀内容通过 PA 审批（飞书消息确认）后再 git commit，防止噪音进库
5. **spawn 注入复用**：下次启动时，`ai-docs/requirements/` 和 `CONTEXT.md` 自动注入所有角色的 prompt

**现有零件复用：**
- `distiller.ts`（已实现，disabled）→ 开启即用
- `ai-docs/` 注入（已实现）→ 无需改动
- 飞书审批通道（已实现）→ 沉淀审批走此通道
- `CONTEXT.md` 提醒（已实现）→ 无需改动

**主要新增工作：**
- Gitee Team MCP 集成：拉取需求条目注入 Room 记忆
- 沉淀结果写入 `ai-docs/requirements/<id>.md` 的路由逻辑

---

## Phase 2 — 轻量团队服务器

**目标**：多人共享一个 Supervisor 实例，有基础访问控制和看板。

**入口决策（go/no-go 前置，尚未决定）：**
- **认证模型**：OAuth（GitHub/飞书）还是简单 token？
- **计费模型**：按用量计费还是按座位？谁承担 Claude API 费用？

上述两个问题未决定前，Phase 2 不开始。

**主要工作：**
- 共享实例部署（Docker / 云主机）
- 用户认证（与认证模型决策一致）
- 看板：跨 Room 任务状态、AI 用量统计
- 代码工作区隔离：每个用户/团队的 `devDir` 隔离（容器 or 路径 namespace）
- Room 访问权限：谁可以看/操作哪个 Room
- **Agent 间通信对齐 A2A 标准**（Linux 基金会托管，150+ 组织参与）：Agent Card 能力发现 + JSON-RPC over HTTPS。现有自研 inbox（`HTTP POST /notify`）可升级为 A2A 标准协议，利于跨工具/跨团队互通。单机阶段非必需，团队化时再上。

---

## Phase 3 — 完整多租户

**目标**：SaaS 级别的多租户隔离与弹性。

**主要工作：**
- 并发同房间模型：多人同时操作同一个 Room（conflict resolution）
- **沙箱隔离**（具体选型）：不可信生成代码默认 **microVM**（Firecracker / E2B / Blaxel，硬件级隔离，冷启动 150ms~2s）；或 **gVisor**（用户态内核，冷启动更友好、兼容性广）、**Kata Containers**。参考实践：Modal（gVisor）、Northflank（Kata+gVisor，月处理 200 万+ 隔离负载）。原则：跑不可信代码默认 microVM，威胁模型允许时才降到 gVisor/容器。
- 配额与成本看板：按租户追踪 token 用量、费用分摊
- 弹性伸缩：按并发房间数自动扩缩

---

## 当前优先级

**Phase 1** 是最高性价比的下一步：大部分复用现有零件，不需要服务端工作，直接带来需求上下文复用价值。

Phase 2 的 go/no-go 取决于认证/计费模型决策，这是团队层面的商业决策，技术实现等待决策后启动。
