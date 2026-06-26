# External Skills Adoption

## 背景与目标

为三个 Claude 角色（产品架构师 PA、开发工程师 Dev、QA 工程师）引入外部工程技能，提升 Dev 生成代码的可复用性，PA 用同一套词汇审查驳回浅模块。

核心技能来自两个来源：
- **Matt Pocock skills**（`github.com/mattpocock/skills`）：以"深模块/小接口"设计哲学为核心的工程技能集
- **Superpowers**（`github.com/obra/superpowers`）：Claude Code / Codex 跨 CLI 工程行为规范

安装目标：`~/.claude/skills/<skill-name>/`（Claude Code 用户级 skills 目录，三个角色共享，无需改 spawn 逻辑）。

---

## 治理铁律

| 铁律 | 说明 |
|------|------|
| 不装 SessionStart/hook | 不注册任何 hook |
| 不改 CLAUDE.md / settings.json | 不破坏现有 per-role 隔离与 `--append-system-prompt-file` 注入 |
| 不跑各工具自带的 setup/installer | 不用 `npx skills add`、`setup-matt-pocock-skills`、`gsd setup` 等 |
| orchestrator 技能不进目录 | 靠"不放"，不靠"放了再禁" |
| 纯 markdown 技能只 | 不引入需要运行时 SDK 或外部服务依赖的技能 |

---

## 四工具完整技能清单

### 1. Matt Pocock Skills（`mattpocock/skills`）

#### engineering/

| 技能 | 决策 | 说明 |
|------|------|------|
| `codebase-design` | ✅ 核心装 | 深模块/小接口设计词汇库，PA 审查+Dev 实现共用的核心语言 |
| `domain-modeling` | ✅ 核心装 | ADR 格式 + 领域上下文建模，提升接口设计质量 |
| `tdd` | ✅ 核心装 | TDD 节奏（mocking / refactoring / tests 参考 md 一并装） |
| `diagnosing-bugs` | ✅ 核心装 | 结构化 bug 定位流程 + hitl-loop 脚本 |
| `resolving-merge-conflicts` | ✅ 核心装 | Merge conflict 解决策略 |
| `improve-codebase-architecture` | 🔵 可选 | HTML 报告式架构分析；初期不强制，需要时启用 |
| `grill-with-docs` | 🔵 可选 | 以文档为锚点深度追问；PA 审查时有用，但不是日常必需 |
| `prototype` | 🔵 可选 | 快速原型（UI/Logic 两套思路）；初期不强制 |
| `ask-matt` | ❌ 排除 | Orchestrator：依赖外部 ask-matt 服务，不是独立 markdown 技能 |
| `implement` | ❌ 排除 | Orchestrator：驱动完整功能实现流程，会接管 Dev 行为 |
| `setup-matt-pocock-skills` | ❌ 排除 | Installer：写 CLAUDE.md / settings.json |
| `to-prd` | ❌ 排除 | Orchestrator：将需求转 PRD，属于规划编排 |
| `to-issues` | ❌ 排除 | Orchestrator：将 PRD 拆 issue，属于规划编排 |
| `triage` | ❌ 排除 | Orchestrator：issue 分级分配 |

#### misc/

| 技能 | 决策 | 说明 |
|------|------|------|
| `git-guardrails-claude-code` | ❌ 排除 | 安装 hook + 改 settings.json，违反铁律 |
| `setup-pre-commit` | ❌ 排除 | 安装 Husky hook，违反铁律 |
| `migrate-to-shoehorn` | ❌ 排除 | TypeScript 特定工具，项目无关 |
| `scaffold-exercises` | ❌ 排除 | 课程练习脚手架，无关 |

#### productivity/

| 技能 | 决策 | 说明 |
|------|------|------|
| `grilling` | 🔵 可选 | 追问设计决策的通用方法；批判性评审时有用 |
| `grill-me` | ❌ 排除 | 交互式自我追问，个人用途，非工程规范 |
| `handoff` | ❌ 排除 | 会话 handoff，个人用途 |
| `teach` | ❌ 排除 | 教学模式，非工程规范 |
| `writing-great-skills` | ❌ 排除 | 元技能（写技能的技能），无需装入角色 |

#### personal/、deprecated/、in-progress/

全部 ❌ 排除：personal 是作者私人用途；deprecated 已废弃；in-progress 不稳定。

---

### 2. Superpowers（`obra/superpowers`）

只取 Matt Pocock 没有的，已装过等价技能的不重复装。

| 技能 | 决策 | 说明 |
|------|------|------|
| `verification-before-completion` | ✅ 核心装 | "完成前必须有真实验证证据"——与 Supervisor Dev 工作流直接契合 |
| `requesting-code-review` | ✅ 核心装 | 发起 code review 的结构化方式 |
| `receiving-code-review` | ✅ 核心装 | 接收 code review 反馈的处理规范 |
| `brainstorming` | 🔵 可选 | 结构化头脑风暴（含 spec-document-reviewer / visual-companion 参考） |
| `writing-plans` | 🔵 可选 | 计划文档撰写规范 |
| `test-driven-development` | ❌ 排除 | **去重**：与 Matt Pocock `tdd` 同装会产生矛盾指令，采用 MP 版本 |
| `systematic-debugging` | ❌ 排除 | **去重**：与 Matt Pocock `diagnosing-bugs` 等价，采用 MP 版本 |
| `using-superpowers` | ❌ 排除 | Orchestrator：加载整个 superpowers 工作流 |
| `subagent-driven-development` | ❌ 排除 | Orchestrator：多子 Agent 编排，与 Supervisor 自身机制冲突 |
| `executing-plans` | ❌ 排除 | Orchestrator：执行计划编排 |
| `dispatching-parallel-agents` | ❌ 排除 | Orchestrator：并行 Agent 派发 |
| `finishing-a-development-branch` | ❌ 排除 | Orchestrator：分支收尾完整流程 |
| `using-git-worktrees` | ❌ 排除 | 未在 ALLOWLIST，Supervisor 自带 worktree 隔离，不需要额外技能 |
| `writing-skills` | ❌ 排除 | 元技能（写技能的技能），无需装入角色 |

---

### 3. gstack（整体排除）

**排除原因**：
- `gstack ./setup` 会安装 hook + 改 settings.json，违反铁律
- 依赖 Bun 运行时 + Chromium（browse 功能），非纯 markdown 技能
- 绝大部分技能是 gstack 工具链的编排层，离开 gstack 单独使用无意义

---

### 4. Get-Shit-Done / GSD（整体排除）

**排除原因**：
- GSD 是完整多 Agent 编排器，核心假设是 AI 作为 orchestrator 分派子 Agent
- 安装过程改 settings.json（写入 `gsd` 命令路径）
- 依赖 `gsd-sdk`，需要额外 Node.js 包
- 明确不支持 Kimi Code（Supervisor 的可选 CLI）
- 与 Supervisor 自身的 PA→Dev→QA 编排机制存在职责重叠

---

## 去重决策记录

| 冲突对 | 保留 | 放弃 | 原因 |
|--------|------|------|------|
| MP `tdd` vs SP `test-driven-development` | Matt Pocock `tdd` | Superpowers `test-driven-development` | MP 版更聚焦 mocking/refactoring 设计，与 codebase-design 词汇体系一致 |
| MP `diagnosing-bugs` vs SP `systematic-debugging` | Matt Pocock `diagnosing-bugs` | Superpowers `systematic-debugging` | MP 版含 hitl-loop 脚本，更完整；同装会产生矛盾的 bug 定位流程 |

---

## 安装 ALLOWLIST（最终）

### 核心（8 个）—— 立即装

```
matt-pocock/engineering/codebase-design
matt-pocock/engineering/domain-modeling
matt-pocock/engineering/tdd
matt-pocock/engineering/diagnosing-bugs
matt-pocock/engineering/resolving-merge-conflicts
superpowers/verification-before-completion
superpowers/requesting-code-review
superpowers/receiving-code-review
```

### 可选（6 个）—— 配置中标记，脚本支持选择性装

```
matt-pocock/engineering/improve-codebase-architecture
matt-pocock/engineering/grill-with-docs
matt-pocock/engineering/prototype
matt-pocock/productivity/grilling
superpowers/brainstorming
superpowers/writing-plans
```

---

## 安装机制

### 目标目录

`~/.claude/skills/<skill-name>/`

这是 Claude Code 的用户级 skills 目录（与 Lark 系列等现有技能并存），三个角色 spawn 的 Claude 实例共享，无需修改 Supervisor spawn 逻辑。

### 脚本位置

`supervisor/scripts/install-skills.sh`

### 配置文件

`supervisor/scripts/skills-config.json`——ALLOWLIST 配置，脚本读取它决定装哪些，cherry-pick 选择写在这里不会丢。格式见 Phase 2 方案。

### 源仓库缓存

脚本在 `~/.cache/claude-skills-vendor/` 维护两个裸 clone（可通过 `SKILLS_VENDOR_DIR` 环境变量覆盖），并 pin 每个仓库的 commit SHA。不依赖 `/tmp/toolscan`。

### 幂等性

每次跑脚本用 `rsync --delete` 将技能目录同步到 `~/.claude/skills/`——重复跑等于原地更新，不堆叠。

### 更新机制

- **默认**：使用配置中 pin 的 commit，缓存存在时不需要网络
- **`--update` 模式**：拉最新 commit、打印每个技能的 diff 摘要，不自动覆盖；人看了确认后再带 `--apply` 写入并更新 pin

### 代理

脚本不写死代理。使用 git 自身对 `http_proxy` / `https_proxy` / `ALL_PROXY` 环境变量的原生支持。

---

## 任务清单

- [x] Phase 1：写本文档（四工具清单 + 决策记录 + 计划）
- [ ] Phase 2：实现 `install-skills.sh` + `skills-config.json`（方案待 PA 审批后执行）
- [ ] Phase 3：自测——跑脚本、验证装了哪些、确认未动 settings.json、可重复跑、新 Claude 会话能看到技能
