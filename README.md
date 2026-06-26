English | [中文](docs/zh-CN/README.md)

# Agent Supervisor

> Multi-role AI coding orchestrator — Architect, Developer and QA agents in real PTY terminals.

> ⚠️ **Personal vibe-coding toy, built for fun. Evaluate code quality and stability on your own terms.**
>
> Claude Code CLI is the primary backend; other CLIs (Gemini / Codex / Kimi) work with varying degrees of roughness.

A multi-role AI coding collaboration tool. Run a **Product Architect**, **Developer**, and **QA Engineer** side by side in the browser — each Agent in a real PTY terminal with full tool access.

Supports **Claude Code**, **Gemini CLI**, **Codex CLI**, and **Kimi Code**; each role can use a different CLI and model.

![Supervisor UI — Architect reviewing code while Dev and QA work in parallel](screenshot.png)

<video src="https://github.com/user-attachments/assets/c06b96c2-7339-4244-a242-1dbbd5c71a68" controls width="100%"></video>

---

## How It Works

Three agents collaborate on your real codebase:

| Role | Responsibility |
|------|---------------|
| **Product Architect** | Receives requirements, breaks down tasks, reviews output, makes product decisions |
| **Developer** | Implements code inside the real project directory using the full CLI toolset |
| **QA Engineer** | Verifies implementations, finds bugs, reports results back to the Architect |

Watch all terminals in real time from the browser. Intervene at any time via the inbox — messages are delivered the next time an Agent goes idle.

---

## Why Three Separate Processes

Many tools let a single AI play the whole team — but there are three things no single session can do, no matter how capable:

- **Context isolation makes QA adversarial for real** — QA is an independent process that has never seen the implementation, so it can't be anchored by "its own code." An AI playing QA inside the same session already read its own implementation and can only pretend not to know. That's a structural difference no prompt can fix.
- **Long-lived · parallel · individually interruptible** — Dev and QA are peer processes running concurrently: they can work at the same time, you can inject an urgent correction to Dev mid-task without interrupting QA, and you can switch Dev's model independently to handle rate limits. These are not fire-and-forget subtasks.
- **Visible, takeover-ready control plane** — Room, terminal replay, memory panel, Feishu relay — every role's activity is visible in real time and you can intervene at any moment. Tools are skill packs with no control plane.

> Tools make each role individually stronger; separate processes provide the real isolation between them — they stack, not substitute.

---

## Features

- **Theme switching** — 16 built-in color schemes (7 light, 9 dark: Dracula / One Dark / Tokyo Night / Nord / Catppuccin / Solarized / GitHub, etc., Tabby/iTerm2 format). Applied instantly from the room header dropdown to both the terminal and the UI; stored server-side in `ui-prefs.json` (survives cache clears) and synced across tabs. Adding a new theme only requires pasting a 16-color set into `frontend/themes.ts`.
- **On-demand roles** — PA / Dev / QA can be combined freely; leave a directory empty to disable that role. Run a single Agent (Dev-only mode), and the terminal columns adapt automatically to 1–3 columns.
- **Left-side room tabs** — Multiple rooms as persistent left-side tabs; click to switch instantly while keeping sessions alive in the background. Open rooms restore automatically on page reload or server restart; manually close to disconnect. Tabs are split into two groups by a divider: **Pinned** / **Normal** — drag within a group to reorder, drag across the divider to change group; order and grouping are persisted server-side.
- **Real PTY terminals** — Full color output, interactive, identical to a local shell.
- **Inbox message queue** — Send instructions to any Agent; delivered at the next idle moment.
- **Auto-Review loop** — When Dev goes idle, the Architect automatically reviews recent output and intervenes if needed.
- **Watchdog** — Detects stuck sessions and wakes them automatically.
- **Session persistence** — Automatically resumes the last Claude / Gemini / Codex / Kimi session on restart; Session Picker pre-selects the previously used session.
- **Cross-session memory** — Room-level decision log + project `ai-docs/` documents are injected into the prompt on every spawn.
- **Feishu integration** — Architect pushes notifications over a long-lived connection; your replies go directly into the Architect's inbox.
- **Runtime model switching** — Switch models without breaking the session.
- **Multiple rooms** — Run multiple projects in parallel, each with its own Agent combination.
- **Mobile support** — Tab bar to switch between Architect / Dev / QA terminals, optimized for phone browsers.
- **PWA-installable** — Install as a standalone desktop app from Chrome/Edge (no address bar or tabs). Title bar behavior: browser tab shows "Supervisor — room name" / "Supervisor"; installed PWA shows "Supervisor - room name" (inside a room) / "Supervisor" (home). Zero-cache Service Worker satisfies installability requirements only — no offline caching, changes reflect immediately on refresh.
- **LAN access** — Binds to `0.0.0.0` by default; LAN IP is printed at startup.
- **Runtime configuration** — `supervisor.config.json` overrides any parameter without redeployment.

---

## Quick Start

### Prerequisites

- Node.js 18+
- At least one of: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Codex CLI](https://github.com/openai/codex), [Kimi Code](https://github.com/moonshot-ai/kimi-code)

### Install & Run

```bash
git clone git@github.com:zhijun714/agent-supervisor.git
cd agent-supervisor
npm install
npm start
# Open http://localhost:3458
```

### Create a Room

1. Click **+ New Room** and enter the project directory path.
2. Click **Start** → choose a CLI (Claude / Gemini / Codex / Kimi) and model for each role.
3. Type your requirements into the Architect terminal.

---

## Configuration

### Port

```bash
PORT=8080 npm start
```

### Multiple Instance Isolation

```bash
PORT=19999 ROOMS_FILE=/tmp/test/rooms.json npm start
```

### Feishu Notifications (optional)

Create a `.env` file (see `.env.example`):

```env
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Install the SDK:

```bash
npm install @larksuiteoapi/node-sdk
```

Enable per room in the **📡 Communication** panel in the UI. The Architect will push task milestones and decision requests to your Feishu; your replies go into the Architect's inbox.

### Runtime Parameter Tuning

Create `supervisor.config.json` in the project root to override defaults without restarting (deep merge):

```json
{
  "review": {
    "enabled": true,
    "idleMs": 120000
  },
  "watchdog": {
    "enabled": true,
    "intervalMs": 30000,
    "stuckThresholdMs": 180000
  },
  "distiller": {
    "enabled": false
  },
  "rotation": {
    "enabled": false
  }
}
```

See [DESIGN.md](DESIGN.md) for the full list of tunable parameters.

### Cross-Session Memory

- **Room memory** — Key decisions are appended to `room-memories/<roomId>.md` via the `update-room-memory` script and injected into the prompt on the next spawn.
- **Project docs** — Place architecture notes, API contracts, and coding conventions in `<projectDir>/ai-docs/*.md`; they are injected automatically on every spawn.

---

## Supported CLIs

| CLI | Resume session | Silent mode | Notes |
|-----|---------------|-------------|-------|
| Claude Code | ✅ | ✅ `--dangerously-skip-permissions` | Architect role has Write/Edit tools force-disabled |
| Gemini CLI | ✅ | — | System prompt injected via `GEMINI_SYSTEM_MD` |
| Codex CLI | ✅ | — | Config isolated via `XDG_CONFIG_HOME` |
| Kimi Code | ✅ | ✅ `--yolo` | Auto-restarts on context overflow; PTY layer intercepts file writes for arch role |

---

## Project Structure

```
agent-supervisor/
├── src/                   # TypeScript backend (run via tsx)
│   ├── server.ts          # Entry point, HTTP + WebSocket server
│   ├── routes.ts          # All HTTP route handlers
│   ├── pty-manager.ts     # PTY lifecycle management
│   ├── cli-profiles.ts    # CLI command builders per profile
│   ├── inbox.ts           # Agent message queue
│   ├── watchdog.ts        # Stuck session detection and recovery
│   ├── comm.ts            # Communication adapter registry
│   ├── comm-feishu.ts     # Feishu long-connection adapter
│   ├── state.ts           # Shared runtime state
│   ├── persistence.ts     # rooms.json read/write
│   ├── scripts.ts         # Notify script generation
│   ├── sessions.ts        # Session list
│   ├── types.ts           # TypeScript type definitions
│   ├── constants.ts       # Tunable timeouts and buffer sizes
│   ├── config.ts          # Runtime config loader (supervisor.config.json)
│   ├── rotation.ts        # Session rotation (context-overflow auto-resume, off by default)
│   └── distiller.ts       # Knowledge distillation (PTY output → ai-docs, off by default)
├── frontend/
│   ├── app.ts             # Browser UI (bundled by esbuild → public/app.js)
│   └── themes.ts          # 16 terminal/UI color schemes + theme derivation utilities
├── public/
│   └── index.html         # HTML shell
├── prompts/
│   ├── arch.md            # Architect system prompt template
│   ├── dev.md             # Developer system prompt template
│   └── qa.md              # QA system prompt template
├── build.mjs              # esbuild frontend bundler script
├── supervisor.config.json # Runtime parameter overrides (optional, deep-merged)
├── .env.example           # Environment variable template
├── ui-prefs.json          # Global UI preferences (theme, etc. — in .gitignore)
└── room-memories/         # Room decision logs (in .gitignore)
```

---

## Design Docs

Full architecture, API reference, and data-flow diagrams: [DESIGN.md](DESIGN.md).

---

## License

MIT
