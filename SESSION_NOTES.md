# 会话记录

> 此文件供下次会话快速上手，用完可删。

---

## 2026-06-26 会话

### 已完成（commits: d59624a、458bc11、本次文档统一提交）

1. **外部技能采用**：`scripts/install-skills.sh` + `scripts/skills-config.json` 一键 vendoring 14 个工程技能到 `~/.claude/skills`（pin commit + allowlist + 安全 marker + `--update` 看 diff）；文档 `ai-docs/external-skills-adoption.md`。决策：只装节点技能，不装 orchestrator（gstack/GSD 黑盒且抢 PA 工作流）。
2. **CONTEXT.md**：`supervisor/CONTEXT.md` 领域术语表种子（17 术语，4 分组）；`src/scripts.ts` 新增"缺 CONTEXT.md → spawn 自动提醒 PA/Dev 用 `domain-modeling` 技能起种子"。
3. **prompts 强化**：`prompts/arch.md` 新增 codebase-design 审查词汇（模块深度评估/驳回浅模块）+ scope-creep 驳回；`prompts/dev.md` 7 条代码输出约束（先搜后写/最小 diff/不预先抽象/最小 API 面/注释只写"为什么"/跟邻近风格/不堆防御）。
4. **README 中英拆分**：根目录 `README.md` 全文英文（含"Why Three Separate Processes"节）；新建 `docs/zh-CN/README.md` 中文原文（图片路径修正为 `../../`）；两文件互有语言切换链接。PPT 同步新增"为什么是三个独立进程"页。
5. **commits**：`d59624a` 功能主提交（7 文件）、`458bc11` README i18n + 外部技能概览（3 文件）、本次文档统一提交（5 文件）。

### 后续

- 团队化路线见 `ai-docs/team-roadmap.md`（Phase 1 知识共享 → Phase 2 轻量团队服务器 → Phase 3 完整多租户）
- rotation.ts「手动 Rotate 按钮」仍未实现

---

## 2026-06-22 会话

### 已完成（已 commit + 合并 master，commit `d7fad08`）

1. **角色按需启用**：PA / Dev / QA 三角色目录均可空（`archDir`/`devDir` 改为 `string|null`），建房至少启用一个角色；后端只 spawn 有目录的角色，前端详情页自适应 1~3 列，relay 按钮按两端启用与否显隐。
2. **左侧房间 tab 壳（iframe 方案，新首页）**：左侧 tab 栏 + 右侧 iframe 区，切换瞬时、后台保活零重连；打开的房间用服务端 `pinned` 标记常驻，刷新/服务重启后自动恢复；手动关 tab → POST `/rooms/:id/close` 取消 pinned 并杀该房间 PTY。
   - 改动文件：`src/types.ts` `src/routes.ts` `src/scripts.ts` `src/distiller.ts` `frontend/app.ts` `public/index.html`
   - 文档已同步：README「功能特性」、DESIGN「多 Room / 前端 / API / 最佳实践」。

### 待办 / 注意

- **开发约定（重要）**：本地验证一律 git worktree + 独立端口（`PORT=3999 ROOMS_FILE=/tmp/xxx`）+ 真实 rooms.json 用副本；**停进程按端口 kill**（`kill $(lsof -nP -iTCP:3999 -sTCP:LISTEN -t)`），**绝不用 `pkill -f "tsx src/server.ts"`**（会误杀 3458 真实实例，本次曾误杀过）。详见 DESIGN「开发工具最佳实践」。
- rotation.ts「手动 Rotate 按钮」仍未实现（用户暂不做）。

---

## 2026-06-16 会话

## 本次会话做了什么

### 1. Bug 修复

| Bug | 根因 | 修复位置 |
|-----|------|---------|
| xterm 右边框截字 | FitAddon 双减 padding：读父元素 content-box 宽度后再减 padding，导致多减一次 | `public/index.html` → `.term-wrap { padding-right: 6px }` |
| Session Picker 预选旧会话 | spawn 成功后 `currentRoom.{role}SessionId` 未同步，下次打开仍是旧值 | `frontend/app.ts` → spawn 成功后立即同步三个 sessionId |

### 2. 新功能（已 commit + push）

- **移动端适配**：`@media (max-width: 768px)` + JS `matchMedia` tab 栏切换 arch/dev/qa
- **局域网访问**：绑定 `0.0.0.0`，启动打印 LAN IP
- **运行时配置**：`supervisor.config.json` deepMerge 覆盖默认值，无需重启
- **会话轮转模块**：`src/rotation.ts`（disabled，`rotation.enabled: false`）
- **知识蒸馏模块**：`src/distiller.ts`（disabled，`distiller.enabled: false`）

### 3. 文档更新

- `DESIGN.md`：新增后端模块表、前端特性描述、目录结构、设计决策（rotation/distiller 未实现原因）
- `README.md`：新增移动端/LAN/运行时配置特性、supervisor.config.json 配置段、更新项目结构

### 4. 知乎文章

- 文章草稿：`supervisor/article.md`（含 `# 标题行`，完整版）
- 导入用正文：`supervisor/article_body.md`（去掉第一行 `# 标题行`，直接用于知乎「导入文档」）
- **状态：已填入知乎编辑器草稿，未发布**（URL: `https://zhuanlan.zhihu.com/p/2050328676328289711/edit`）
- 知乎还有两个损坏的旧草稿（操作过程中产生），可在草稿管理页删除

---

## 待办

- [x] 知乎文章已发布，损坏的旧草稿已清理（2026-06-22 完成）
- [ ] rotation.ts「手动 Rotate 按钮」— 在 relay bar 加一个按钮，让用户自己判断时机触发会话轮转（见 DESIGN.md）

---

## 关键文件路径

```
supervisor/
├── src/rotation.ts          # 会话轮转（disabled）
├── src/distiller.ts         # 知识蒸馏（disabled）
├── src/config.ts            # 运行时配置加载
├── supervisor.config.json   # 可调参数覆盖
├── article.md               # 知乎文章（完整，含 # 标题行）
└── article_body.md          # 知乎导入用正文（无标题行）
```

---

## 知乎 MCP 操作经验（下次用得到）

**有效流程**：
1. 打开 Page 5（`https://zhuanlan.zhihu.com/write`）
2. 点标题框 → 输入标题
3. 点「导入」→「导入文档」→ 上传 `article_body.md`（**不含 `# 标题行`**，否则导入后正文开头会多出一个标题段落）
4. 验证字数和格式，点「发布」

**踩过的坑**：
- `navigator.clipboard.writeText` 在 DevTools MCP 里不共享系统剪贴板，粘贴无效
- `document.execCommand('insertText')` 只插入了最后几十个字符（编辑器对长文本有截断）
- `range.selectNode(firstChild)` + `execCommand('delete')` 会破坏 ProseMirror 状态，导致全部内容丢失
- 正确删除方式：`editor.firstElementChild.firstElementChild` 才是真正的第一段，用 `setStartBefore/setEndAfter` 后 execCommand 删除，但仍有风险
- **最稳方案**：提前从 md 文件去掉 `# 标题行`，这样导入后不需要任何 DOM 操作
