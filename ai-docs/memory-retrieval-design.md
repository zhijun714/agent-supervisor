# 记忆按需检索设计（Memory On-Demand Retrieval）

## 背景与现状

`src/scripts.ts` 的 `buildMemoryContext` 在 spawn 时把 `room-memories/{roomId}.md` 全文 + 所有 `ai-docs/*.md` 全文一次性注入 `archCtx`/`devCtx`/`qaCtx`。

**问题**：随项目变大注入体积线性增长 → context 膨胀、成本升、指令被稀释（context rot）。

**2026 SOTA**：从"全量注入"转向"分层 + 按需检索"（Letta 分层 OS 式、Mem0 向量+图、A-MEM 自组织）。

---

## 关键洞察

- `ai-docs/*.md` 是角色 cwd（`devDir`/`archDir`）下的真实文件，角色用 Read 工具本就能按需读 → 不必预注入全文，注索引即可。
- `room-memories/` 在 supervisor 仓库内、角色 cwd 之外，读不到 → 只能注入，但可瘦身。

---

## 方案

### Phase A（低成本高收益，先做）

1. **ai-docs 全文注入 → 清单注入**：每文件注"文件名 + 一行摘要（取首个标题或可选 frontmatter `description`）"，并写明"需要细节用 Read 读对应文件路径"。
2. **room-memory 全量 → 近期切片 + 旧摘要**：注入最近 N 条原文；旧条目用 `distiller`（现 disabled，启用它）压成摘要一并注入；设总上限（如 ≤8KB）。
3. **注入文案分区标注**：`【近期记忆】`、`【历史摘要】`、`【项目文档索引】`。

### Phase B（可选，验证 A 后再定）

给 room-memory 条目 + ai-docs 建关键词/向量索引；在任务派发时（PA 经 inbox 发任务）按任务内容检索 top-k 相关片段追加注入（而非仅 spawn 时）。需嵌入/检索基建，较重。

---

## 验收 / 效果

- spawn 注入体积显著下降（量化前后字节/token）
- 信息不丢：ai-docs 可 Read、近期记忆在上下文
- 不破坏 CONTEXT.md 缺失提醒、resume 不重复注入等现有行为

---

## 风险 / 注意

- 改清单后 agent 必须真去 Read——靠注入文案 + `dev.md` "先调查后回答"纪律保障。
- 摘要质量：建议 ai-docs 约定首行写 frontmatter `description` 或首个 H1/H2 作摘要源。
