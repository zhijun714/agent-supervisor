# Supervisor — Domain Context

Shared vocabulary for the Supervisor multi-role AI coding orchestrator. Use these terms exactly across prompts, docs, and code comments; the _Avoid_ column lists words that carry conflicting connotations or overload common terms.

## Language

### 协作角色 Collaboration Roles

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Room** | A collaborative workspace that binds up to three role Agents to a single project. | session, project, tab |
| **Architect (PA)** | The role that defines requirements, reviews plans, accepts completed work, and never writes code. | supervisor, manager, boss |
| **Developer (Dev)** | The role that implements code inside the real project directory. | coder, worker |
| **QA** | The role that derives test cases independently from the specification without reading the implementation. | tester |
| **Role** | One of the three distinct responsibilities inside a Room, each running as an independent process. | agent (overloaded), worker |

### 运行时 Runtime

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **CLI** | The programming-agent program (Claude / Gemini / Codex / Kimi) that a Role runs. | model, tool |
| **PTY** | The real pseudo-terminal in which a Role's CLI executes. | terminal, shell, console |
| **Spawn** | The act of starting a Role's CLI process with injected prompts and memory. | launch, boot |
| **Session** | A CLI conversation that can be resumed by its session ID. | conversation, chat |

### 通信与质量 Communication & Quality

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Inbox** | A per-role message queue whose messages are delivered the next time that Role becomes idle. | queue, mailbox |
| **Relay** | The act of forwarding a message from one Role to another. | forward, pipe |
| **Acceptance Test** | A verifiable behaviour attached to a task by the Architect that the Developer must fully pass before reporting completion. | criteria, spec |

### 监控与记忆 Monitoring & Memory

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Auto-Review** | The mechanism by which the Architect automatically evaluates the Developer's new output when the Developer becomes idle. | check |
| **Watchdog** | A periodic monitor that detects and wakes a silent or exited PTY. | monitor, healthcheck |
| **Room Memory** | A per-Room markdown file recording cross-role decisions and progress, injected into every Spawn. | history, notes |
| **ai-docs** | A version-controlled set of design, contract, and convention documents for a project, injected into every Spawn. | docs |
| **Session Rotation** | The process of starting a fresh Session and carrying over distilled state to escape context rot. | restart, reset |

---

## Relationships

- A Room contains 1–3 Roles.
- Each Role runs exactly one CLI inside exactly one PTY.
- Each Role's CLI maintains one resumable Session at a time.
- The Architect dispatches tasks with Acceptance Tests to the Developer via the Developer's Inbox.
- The Watchdog monitors the PTY of every Role in the Room.
