# Agent Supervisor

[中文](README_CN.md)

Multi-role AI coding orchestrator. Run **Architect**, **Developer**, and **QA** agents side-by-side in the browser, each in a real PTY terminal with full tool access.

Supports **Claude Code**, **Gemini CLI**, **Codex CLI**, and **Kimi Code** — mix and match roles freely.

![Supervisor UI — Architect reviewing and auto-switching models while Dev and QA work in parallel](screenshot.png)

<video src="https://github.com/user-attachments/assets/c06b96c2-7339-4244-a242-1dbbd5c71a68" controls width="100%"></video>

---

## How it works

Three agents collaborate on your actual codebase:

| Role | Responsibility |
|------|---------------|
| **Architect** | Receives your requirement, breaks it into tasks, reviews Dev output, makes product decisions |
| **Developer** | Implements code in the real project directory using the full CLI toolkit |
| **QA** | Validates the implementation, finds bugs, reports back to Architect |

You watch everything live in the browser. Step in at any time via the inbox — messages are delivered the moment the agent goes idle.

---

## Features

- **Real PTY terminals** — full color, interactive, same environment as your local shell
- **Inbox message queue** — send instructions to any agent; delivered at the next idle tick
- **Auto-review loop** — when Dev goes idle, Architect automatically reviews progress and intervenes if needed
- **Watchdog** — detects stalled sessions and nudges agents back on track
- **Session persistence** — resumes previous Claude/Gemini/Codex/Kimi sessions across restarts
- **Cross-session memory** — room-level decision log + project `ai-docs/` injected into prompts on each spawn
- **Feishu (Lark) integration** — Architect pushes notifications to you via long-connection; your replies inject into the Architect's inbox
- **Model hot-swap** — switch model mid-session without losing context
- **Multiple rooms** — run separate projects in parallel, each with its own agent set

---

## Quick Start

### Prerequisites

- Node.js 18+
- At least one of: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Codex CLI](https://github.com/openai/codex), [Kimi Code](https://github.com/moonshot-ai/kimi-code)

### Install & run

```bash
git clone <repo-url>
cd supervisor
npm install
npm start
# open http://localhost:3458
```

### Create a room

1. Click **+ New Room** and point it to your project directory
2. Click **Spawn** → choose CLI (Claude/Gemini/Codex/Kimi) and model
3. Type your requirement into the Architect's terminal

---

## Configuration

### Port

```bash
PORT=8080 npm start
```

### Feishu (Lark) notifications (optional)

Create a `.env` file (see `.env.example`):

```env
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Then install the SDK:

```bash
npm install @larksuiteoapi/node-sdk
```

Enable per-room in the **📡 通信** panel. The Architect will push milestones and decision requests directly to your Feishu chat; your replies arrive in the Architect's inbox.

### Cross-session memory

- **Room memory** — key decisions are logged to `room-memories/<roomId>.md` via the `update-room-memory` script. Injected into prompts on next spawn.
- **Project docs** — place architecture, API contracts, and conventions in `<projectDir>/ai-docs/*.md`. Automatically included in prompts.

---

## Project Structure

```
supervisor/
├── src/                   # TypeScript backend (runs via tsx)
│   ├── server.ts          # Entry point, HTTP + WebSocket server
│   ├── routes.ts          # All HTTP route handlers
│   ├── pty-manager.ts     # PTY spawning and lifecycle
│   ├── cli-profiles.ts    # Per-CLI command builders
│   ├── inbox.ts           # Agent message queue
│   ├── watchdog.ts        # Stall detection and recovery
│   ├── comm.ts            # Communication adapter registry
│   ├── comm-feishu.ts     # Feishu long-connection adapter
│   ├── state.ts           # Shared runtime state
│   ├── persistence.ts     # rooms.json read/write
│   ├── scripts.ts         # Notify script generation
│   ├── sessions.ts        # Session listing
│   ├── types.ts           # TypeScript interfaces
│   └── constants.ts       # Tunable timeouts and buffer sizes
├── frontend/
│   └── app.ts             # Browser UI (bundled by esbuild → public/app.js)
├── public/
│   └── index.html         # HTML shell
├── prompts/
│   ├── arch.md            # Architect system prompt template
│   ├── dev.md             # Developer system prompt template
│   └── qa.md              # QA system prompt template
├── build.mjs              # esbuild frontend bundler
├── .env.example           # Environment variable template
└── room-memories/         # Per-room decision logs (gitignored)
```

---

## Supported CLIs

| CLI | Resume sessions | Silent mode | Notes |
|-----|----------------|-------------|-------|
| Claude Code | ✅ | ✅ `--dangerously-skip-permissions` | Arch role uses `--disallowedTools Write,Edit` |
| Gemini CLI | ✅ | — | System prompt via `GEMINI_SYSTEM_MD` |
| Codex CLI | ✅ | — | Config via `XDG_CONFIG_HOME` |
| Kimi Code | ✅ | ✅ `--yolo` | Auto-restart on context overflow |

---

## Design Doc

See [DESIGN.md](DESIGN.md) for full architecture, API reference, and data flow diagrams.

---

## License

MIT
