import http from 'http'
import { WebSocketServer } from 'ws'
import { readFileSync, readdirSync, writeFileSync, realpathSync, statSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import pty from 'node-pty'
import {
  setBroadcast, startArchitect, chatWithArchitect,
  sendToDeveloper, stopAll, getStatus
} from './sessions.js'

function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[=>MHJ78]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

function encodePath(absPath) {
  try { absPath = realpathSync(absPath) } catch {}
  return absPath.replace(/\//g, '-')
}

function listSessions(projectDir) {
  const encoded = encodePath(projectDir)
  const claudeDir = join(homedir(), '.claude', 'projects', encoded)
  try {
    const files = readdirSync(claudeDir).filter(f => f.endsWith('.jsonl'))
    return files.map(file => {
      const filePath = join(claudeDir, file)
      const sessionId = file.replace('.jsonl', '')
      let lastPrompt = '', firstPrompt = ''
      let mtime = 0
      try { mtime = statSync(filePath).mtimeMs } catch {}
      try {
        const lines = readFileSync(filePath, 'utf8').trim().split('\n')
        for (const line of lines) {
          try {
            const d = JSON.parse(line)
            if (d.type === 'last-prompt') lastPrompt = d.lastPrompt || ''
            if (d.type === 'user' && !firstPrompt) {
              const content = d.message?.content
              if (typeof content === 'string' && content.trim()) firstPrompt = content.slice(0, 120)
              else if (Array.isArray(content)) {
                const txt = content.find(c => c.type === 'text' && c.text?.trim())
                if (txt) firstPrompt = txt.text.slice(0, 120)
              }
            }
          } catch {}
        }
      } catch {}
      return { sessionId, firstPrompt, lastPrompt: lastPrompt.slice(0, 120), lastTs: mtime || null }
    }).filter(s => s.firstPrompt || s.lastPrompt)
      .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
  } catch { return [] }
}

function loadSessionHistory(projectDir, sessionId) {
  const encoded = encodePath(projectDir)
  const file = join(homedir(), '.claude', 'projects', encoded, sessionId + '.jsonl')
  const messages = []
  try {
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    for (const line of lines) {
      try {
        const d = JSON.parse(line)
        if (d.type === 'user') {
          const content = d.message?.content
          let text = ''
          if (typeof content === 'string') text = content
          else if (Array.isArray(content)) text = content.filter(c => c.type === 'text').map(c => c.text).join('')
          if (text.trim()) messages.push({ role: 'user', text: text.trim() })
        } else if (d.type === 'assistant') {
          const content = d.message?.content
          if (Array.isArray(content)) {
            const text = content.filter(c => c.type === 'text').map(c => c.text).join('')
            if (text.trim()) messages.push({ role: 'assistant', text: text.trim(), uuid: d.uuid || null, ts: d.timestamp ? new Date(d.timestamp).getTime() : 0 })
          }
        }
      } catch {}
    }
  } catch {}
  return messages
}

function readAiDocs(dir) {
  try {
    const docsDir = join(dir, 'ai-docs')
    return readdirSync(docsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => `### ${f}\n\n${readFileSync(join(docsDir, f), 'utf8')}`)
      .join('\n\n---\n\n')
  } catch { return '' }
}

function buildMemoryContext(roomId, archDir, devDir) {
  let roomMem = ''
  try { roomMem = readFileSync(join(ROOM_MEMORIES_DIR, `${roomId}.md`), 'utf8') } catch {}
  const archDocs = readAiDocs(archDir)
  const devDocs  = archDir === devDir ? archDocs : readAiDocs(devDir)
  const block = (title, body) => body ? `## ${title}\n\n${body}` : ''
  const sharedDocs = archDir === devDir
    ? [block('项目文档', archDocs)]
    : [block('项目文档（架构师目录）', archDocs), block('项目文档（开发目录）', devDocs)]
  const shared = [block('Room 记忆', roomMem), ...sharedDocs].filter(Boolean).join('\n\n')
  return {
    archCtx: shared,
    devCtx:  shared,
    qaCtx:   [block('Room 记忆', roomMem), block('项目文档（开发目录）', devDocs)].filter(Boolean).join('\n\n'),
  }
}

const PORT = 3458

// ── CLI Profiles ──────────────────────────────────────────────────────────────
const CLI_PROFILES = {
  claude: {
    buildCmd: (model, promptFile, sessionId, silent, role) => {
      const parts = ['claude', '--model', model]
      if (role === 'arch') parts.push('--disallowedTools', 'Write,Edit,MultiEdit,NotebookEdit,Task')
      parts.push('--append-system-prompt-file', promptFile)
      if (silent) parts.push('--dangerously-skip-permissions')
      if (sessionId) parts.push('--resume', sessionId)
      return parts.join(' ')
    },
    getEnv: (_promptFile, _roomId, _role) => ({}),
    writeConfig: null,
    supportsResume: true,
    trustTexts: ['Do you trust the files', 'MCP server'],
    trustKey: '\r',
    models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5-20251001'],
    defaultModel: 'claude-sonnet-4-6',
  },
  gemini: {
    buildCmd: (model, _promptFile, sessionId, _silent, _role) => {
      const parts = ['gemini']
      if (model) parts.push('-m', model)
      if (sessionId) parts.push('-r', sessionId)
      return parts.join(' ')
    },
    getEnv: (promptFile, _roomId, _role) => ({ GEMINI_SYSTEM_MD: promptFile }),
    writeConfig: null,
    supportsResume: true,
    trustTexts: ['Open documentation', 'Would you like to enable'],
    trustKey: 'D\r',
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-3-pro-preview', 'gemini-3.1-pro-preview'],
    defaultModel: 'gemini-2.5-flash',
  },
  codex: {
    buildCmd: (model, _promptFile, sessionId, _silent, _role) => {
      // sessionId='last' → resume most recent; truthy UUID → resume specific; null → new session
      const parts = sessionId === 'last'  ? ['codex', 'resume', '--last']
                  : sessionId             ? ['codex', 'resume', sessionId]
                  :                         ['codex']
      if (model) parts.push('-m', model)
      return parts.join(' ')
    },
    getEnv: (_promptFile, roomId, role) => ({
      XDG_CONFIG_HOME: `/tmp/codex-cfg-${roomId}-${role}`,
    }),
    writeConfig: (promptFile, roomId, role) => {
      const cfgDir = `/tmp/codex-cfg-${roomId}-${role}/codex`
      mkdirSync(cfgDir, { recursive: true })
      writeFileSync(`${cfgDir}/config.toml`, `model_instructions_file = "${promptFile}"\n`)
    },
    supportsResume: true,
    trustTexts: ['Allow', 'trust this directory'],
    trustKey: '\r',
    models: ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-mini', 'o4-mini', 'o3'],
    defaultModel: 'gpt-5.5',
  },
  kimi: {
    buildCmd: (model, promptFile, sessionId, silent, role) => {
      const roomId = promptFile.match(/\/tmp\/\w+-prompt-(.+)\.md$/)?.[1] || 'unknown'
      const yamlFile = `/tmp/kimi-agent-${roomId}-${role}.yaml`
      const parts = ['kimi', '--agent-file', yamlFile]
      if (model) parts.push('--model', model)
      if (silent) parts.push('--afk')
      if (sessionId === 'last' || sessionId === 'latest') parts.push('--continue')
      else if (sessionId) parts.push('-r', sessionId)
      return parts.join(' ')
    },
    getEnv: () => ({}),
    writeConfig: (promptFile, roomId, role) => {
      writeFileSync(`/tmp/kimi-agent-${roomId}-${role}.yaml`,
        `version: 1\nagent:\n  name: "supervisor-${role}-${roomId}"\n  extend: default\n  system_prompt_path: "${promptFile}"\n`)
    },
    supportsResume: true,
    trustTexts: [],
    trustKey: '',
    models: ['kimi-for-coding', 'kimi-k2.6', 'kimi-k2.5', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    defaultModel: 'kimi-for-coding',
  },
}

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOMS_FILE = join(__dir, 'rooms.json')
const ROOM_MEMORIES_DIR = join(__dir, 'room-memories')
mkdirSync(ROOM_MEMORIES_DIR, { recursive: true })

// ── Rooms persistence ─────────────────────────────────────────────────────────
let rooms = {}
try { rooms = JSON.parse(readFileSync(ROOMS_FILE, 'utf8')) } catch {}
function saveRooms() { try { writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2)) } catch {} }

// ── Broadcast ─────────────────────────────────────────────────────────────────
const clients = new Set()
function broadcast(event) {
  const msg = JSON.stringify(event)
  for (const ws of clients) if (ws.readyState === 1) ws.send(msg)
}
setBroadcast(broadcast)

// ── PTY storage: key = '${roomId}-arch' / '${roomId}-dev' / '${roomId}-qa' ───
const ptys = {}

// ── Per-room state ────────────────────────────────────────────────────────────
const roomStates = {}
function getRoomState(roomId) {
  if (!roomStates[roomId]) {
    roomStates[roomId] = {
      autoReviewEnabled: false, lastReviewAt: 0, devReviewWatermark: 0,
      watchdogEnabled: false, watchdogTimer: null,
      lastActivityTs: { arch: 0, dev: 0, qa: 0 },
    }
  }
  return roomStates[roomId]
}

// ── Inbox ─────────────────────────────────────────────────────────────────────
const INBOX_IDLE_MS = 2000
const inboxes = {}
function getInbox(termId) {
  if (!inboxes[termId]) inboxes[termId] = { queue: [], idleTimer: null }
  return inboxes[termId]
}

// '${roomId}-arch' → { roomId, role: 'arch' }; roomId is a UUID (no hyphens in role)
function parseTermId(termId) {
  const i = termId.lastIndexOf('-')
  return { roomId: termId.slice(0, i), role: termId.slice(i + 1) }
}

function inboxDeliver(termId, from, text) {
  const entry = ptys[termId]
  if (!entry?.alive) { console.log(`[inbox] deliver to ${termId} skipped: not alive`); return }
  const wrapped = `<cross-session-message from="${from}">\n${text}\n</cross-session-message>`
  console.log(`[inbox] delivering to ${termId} from ${from}, len=${wrapped.length}`)
  entry.proc.write('\x1b[200~' + wrapped + '\x1b[201~')
  setTimeout(() => { if (entry.alive) entry.proc.write('\r') }, 200)
  broadcast({ type: 'inbox_delivered', to: termId, from })
  // Advance dev review watermark when arch sends to dev (prevents re-sending already-reviewed content)
  if (termId.endsWith('-dev') && from === 'arch') {
    const { roomId } = parseTermId(termId)
    const st = getRoomState(roomId)
    st.devReviewWatermark = ptys[termId]?.textBuf.length || st.devReviewWatermark
    st.lastReviewAt = Date.now()
  }
}

function inboxSend(to, from, text, priority = 'normal') {
  const box = getInbox(to)
  if (!box.idleTimer && ptys[to]?.alive) {
    inboxDeliver(to, from, text)
  } else {
    if (priority === 'urgent') {
      box.queue.unshift({ from, text, priority })
      // Send ESC to interrupt Claude Code's current operation so the message
      // is delivered at the next idle tick rather than waiting indefinitely
      const entry = ptys[to]
      if (entry?.alive) {
        entry.proc.write('\x1b')
        console.log(`[inbox] ESC sent to interrupt ${to} for urgent message`)
      }
    } else {
      box.queue.push({ from, text, priority })
    }
    broadcast({ type: 'inbox_queued', to, from, priority, queueLen: box.queue.length })
  }
}

function inboxOnIdle(termId) {
  const entry = ptys[termId]
  if (entry?.resumeInterrupt) {
    entry.resumeInterrupt = false
    const { role } = parseTermId(termId)
    const roleMsg = role === 'arch'
      ? 'Wait for the user to give you a new assignment.'
      : role === 'qa'
      ? 'Wait for a new QA assignment from the Product Architect via <cross-session-message from="arch">.'
      : 'Wait for a new task from the Architect via <cross-session-message from="arch">.'
    inboxDeliver(termId, 'system',
      `[SUPERVISOR SESSION RESTARTED]\n` +
      `This is a new Supervisor session. Your previous conversation context is still loaded, ` +
      `but you must STOP any work in progress immediately.\n` +
      `Do NOT continue previous tasks or run any commands.\n` + roleMsg
    )
    return
  }
  const box = getInbox(termId)
  if (box.queue.length) {
    const next = box.queue.shift()
    inboxDeliver(termId, next.from, next.text)
    return
  }
  // Only dev going idle triggers arch auto-review
  if (termId.endsWith('-dev')) {
    const { roomId } = parseTermId(termId)
    triggerArchReview(roomId)
  }
}

const REVIEW_COOLDOWN_MS = 60_000
function triggerArchReview(roomId) {
  const st = getRoomState(roomId)
  if (!st.autoReviewEnabled) return
  const now = Date.now()
  if (now - st.lastReviewAt < REVIEW_COOLDOWN_MS) return
  const devTermId  = `${roomId}-dev`
  const archTermId = `${roomId}-arch`
  const devEntry   = ptys[devTermId]
  const archEntry  = ptys[archTermId]
  if (!devEntry?.alive || !archEntry?.alive) return
  const buf = devEntry.textBuf
  if (buf.length <= st.devReviewWatermark) return
  const newContent = buf.slice(st.devReviewWatermark).trim()
  if (newContent.length < 500) return
  st.devReviewWatermark = buf.length
  st.lastReviewAt = now
  console.log(`[review] injecting ${newContent.length} chars of new Dev output into Arch (room: ${roomId})`)
  inboxSend(archTermId, 'system', `[AUTO-REVIEW] Developer's latest activity — assess direction, intervene only if off-track:\n${newContent.slice(-2000)}`)
}

// ── Watchdog ──────────────────────────────────────────────────────────────────
const WATCHDOG_INTERVAL_MS      = 10 * 60 * 1000
const WATCHDOG_IDLE_THRESHOLD_MS = 10 * 60 * 1000

function runWatchdogCheck(roomId) {
  const now        = Date.now()
  const st         = getRoomState(roomId)
  const archTermId = `${roomId}-arch`
  const devTermId  = `${roomId}-dev`
  const qaTermId   = `${roomId}-qa`
  const archEntry  = ptys[archTermId]
  const devEntry   = ptys[devTermId]
  const qaEntry    = ptys[qaTermId]

  // [TASK_COMPLETE] in Arch's recent output → done, stop watchdog
  if (archEntry?.alive && archEntry.textBuf.slice(-3000).includes('[TASK_COMPLETE]')) {
    stopWatchdog(roomId)
    broadcast({ type: 'watchdog_done', roomId })
    return
  }

  const issues = []

  // Check Arch
  if (!archEntry?.alive) {
    issues.push({ role: 'arch', issue: 'exited' })
  } else {
    const idleMs = now - (st.lastActivityTs.arch || 0)
    if (idleMs > WATCHDOG_IDLE_THRESHOLD_MS) {
      issues.push({ role: 'arch', issue: 'idle', idleMin: Math.floor(idleMs / 60000) })
      inboxSend(archTermId, 'system',
        `[WATCHDOG] 距上次活动已超过 ${Math.floor(idleMs / 60000)} 分钟。\n` +
        `请检查当前任务状态：\n` +
        `- 如任务仍在进行，请继续指导开发者完成\n` +
        `- 如任务已全部完成，请在输出中写一行 [TASK_COMPLETE]`
      )
    }
  }

  // Check Dev
  if (!devEntry?.alive) {
    issues.push({ role: 'dev', issue: 'exited' })
  } else {
    const idleMs = now - (st.lastActivityTs.dev || 0)
    if (idleMs > WATCHDOG_IDLE_THRESHOLD_MS) {
      issues.push({ role: 'dev', issue: 'idle', idleMin: Math.floor(idleMs / 60000) })
      inboxSend(devTermId, 'system',
        `[WATCHDOG] 距上次活动已超过 ${Math.floor(idleMs / 60000)} 分钟。\n` +
        `请检查当前任务状态：\n` +
        `- 如还有未完成的工作，请继续实现\n` +
        `- 如当前任务已完成，请通过 notify-arch.sh 通知架构师`
      )
    }
  }

  // Check QA (only if it's running)
  if (qaEntry) {
    if (!qaEntry.alive) {
      issues.push({ role: 'qa', issue: 'exited' })
    } else {
      const idleMs = now - (st.lastActivityTs.qa || 0)
      if (idleMs > WATCHDOG_IDLE_THRESHOLD_MS) {
        issues.push({ role: 'qa', issue: 'idle', idleMin: Math.floor(idleMs / 60000) })
        inboxSend(qaTermId, 'system',
          `[WATCHDOG] 距上次活动已超过 ${Math.floor(idleMs / 60000)} 分钟。\n` +
          `请完成当前测试工作并将结果汇报给产品架构师。`
        )
      }
    }
  }

  if (issues.length > 0) {
    console.log(`[watchdog] room ${roomId} issues:`, issues.map(i => `${i.role}:${i.issue}`).join(', '))
    broadcast({ type: 'watchdog_triggered', roomId, issues })
  }
}

function startWatchdog(roomId) {
  const st = getRoomState(roomId)
  if (st.watchdogTimer) clearInterval(st.watchdogTimer)
  st.watchdogEnabled = true
  st.watchdogTimer   = setInterval(() => runWatchdogCheck(roomId), WATCHDOG_INTERVAL_MS)
  broadcast({ type: 'watchdog_status', roomId, enabled: true })
  console.log(`[watchdog] started for room ${roomId}`)
}

function stopWatchdog(roomId) {
  const st = getRoomState(roomId)
  if (st.watchdogTimer) { clearInterval(st.watchdogTimer); st.watchdogTimer = null }
  st.watchdogEnabled = false
  broadcast({ type: 'watchdog_status', roomId, enabled: false })
  console.log(`[watchdog] stopped for room ${roomId}`)
}

function captureNewSession(dir, roomId, roleKey) {
  // Snapshot raw filenames (not filtered sessions) so files without firstPrompt yet are still tracked
  const claudeDir = join(homedir(), '.claude', 'projects', encodePath(dir))
  let beforeFiles
  try { beforeFiles = new Set(readdirSync(claudeDir).filter(f => f.endsWith('.jsonl'))) } catch { beforeFiles = new Set() }
  let attempts = 0
  const MAX_ATTEMPTS = 15  // poll every 2s for up to 30s
  const poll = () => {
    attempts++
    try {
      const newFile = readdirSync(claudeDir).filter(f => f.endsWith('.jsonl')).find(f => !beforeFiles.has(f))
      if (newFile) {
        const sessionId = newFile.replace('.jsonl', '')
        if (rooms[roomId]) {
          rooms[roomId][`${roleKey}SessionId`] = sessionId
          saveRooms()
          broadcast({ type: 'session_captured', roomId, role: roleKey, sessionId })
          console.log(`[session] captured ${roleKey} session ${sessionId} for room ${roomId}`)
        }
        return
      }
    } catch {}
    if (attempts < MAX_ATTEMPTS) setTimeout(poll, 2000)
    else console.log(`[session] gave up capturing ${roleKey} session for room ${roomId}`)
  }
  setTimeout(poll, 3000)  // first check after 3s
}

// ── Write per-room notify scripts and prompt files ────────────────────────────
function writeRoomScripts(roomId, archDir, devDir, archCli = 'claude', devCli = 'claude', qaCli = 'claude') {
  const arch_p = CLI_PROFILES[archCli] || CLI_PROFILES.claude
  const dev_p  = CLI_PROFILES[devCli]  || CLI_PROFILES.claude
  const qa_p   = CLI_PROFILES[qaCli]   || CLI_PROFILES.claude

  // Each script encodes `to`, `from`, and optionally `priority` so the server routes correctly
  const makeScript = (toId, fromId, label, priority = 'normal') => `#!/bin/bash
message=$(cat)
[ -z "$message" ] && { echo "No message provided" >&2; exit 1; }
python3 -c '
import json, http.client, sys
msg = sys.argv[1]
conn = http.client.HTTPConnection("localhost", ${PORT})
body = json.dumps({"to": "${toId}", "from": "${fromId}", "roomId": "${roomId}", "message": msg, "priority": "${priority}"})
conn.request("POST", "/notify", body, {"Content-Type": "application/json"})
r = conn.getresponse(); r.read()
print("ok - ${label} notified${priority === 'urgent' ? ' [URGENT]' : ''}" if r.status == 200 else "fail - send error")
' "$message"`

  // Model switch script: takes model name as $1, calls server to respawn with new model
  const makeSwitchScript = (roleId, defaultModel) => `#!/bin/bash
model="\${1:-${defaultModel}}"
python3 -c '
import json, http.client, sys
model = sys.argv[1]
conn = http.client.HTTPConnection("localhost", ${PORT})
body = json.dumps({"role": "${roleId}", "model": model})
conn.request("POST", "/rooms/${roomId}/switch-model", body, {"Content-Type": "application/json"})
r = conn.getresponse(); r.read()
print(("ok - ${roleId} switched to " + model) if r.status == 200 else "fail - switch error")
' "$model"`

  try {
    // Notify script paths
    const archScript          = `/tmp/notify-${roomId}-arch.sh`
    const archFromQaScript    = `/tmp/notify-${roomId}-arch-from-qa.sh`
    const devScript           = `/tmp/notify-${roomId}-dev.sh`
    const devUrgentScript     = `/tmp/notify-${roomId}-dev-urgent.sh`
    const qaScript            = `/tmp/notify-${roomId}-qa.sh`
    const qaUrgentScript      = `/tmp/notify-${roomId}-qa-urgent.sh`
    // Switch-model script paths
    const switchArchScript    = `/tmp/switch-model-${roomId}-arch.sh`
    const switchDevScript     = `/tmp/switch-model-${roomId}-dev.sh`
    const switchQaScript      = `/tmp/switch-model-${roomId}-qa.sh`
    // Memory update script path
    const memoryScript        = `/tmp/update-room-memory-${roomId}.sh`

    writeFileSync(archScript,       makeScript('arch', 'dev',  'Product Architect'),          { mode: 0o755 })
    writeFileSync(archFromQaScript, makeScript('arch', 'qa',   'Product Architect'),          { mode: 0o755 })
    writeFileSync(devScript,        makeScript('dev',  'arch', 'Developer'),                  { mode: 0o755 })
    writeFileSync(devUrgentScript,  makeScript('dev',  'arch', 'Developer',  'urgent'),       { mode: 0o755 })
    writeFileSync(qaScript,         makeScript('qa',   'arch', 'QA Engineer'),                { mode: 0o755 })
    writeFileSync(qaUrgentScript,   makeScript('qa',   'arch', 'QA Engineer', 'urgent'),      { mode: 0o755 })
    writeFileSync(switchArchScript, makeSwitchScript('arch', arch_p.defaultModel), { mode: 0o755 })
    writeFileSync(switchDevScript,  makeSwitchScript('dev',  dev_p.defaultModel),  { mode: 0o755 })
    writeFileSync(switchQaScript,   makeSwitchScript('qa',   qa_p.defaultModel),   { mode: 0o755 })
    writeFileSync(memoryScript, `#!/bin/bash
timestamp=$(date '+%Y-%m-%d %H:%M:%S')
message=$(cat)
[ -z "$message" ] && exit 1
printf '[%s] %s\\n' "$timestamp" "$message" >> "${ROOM_MEMORIES_DIR}/${roomId}.md"
echo "ok - memory updated"`, { mode: 0o755 })

    // Build memory context for this room
    const { archCtx, devCtx, qaCtx } = buildMemoryContext(roomId, archDir, devDir)
    const memBlock = ctx => ctx ? `\n\n---\n\n## 上下文记忆（Spawn 时注入）\n\n${ctx}\n\n---\n` : ''

    // Role-specific script info appended to each prompt file
    const archModelHints = arch_p.models.join(', ')
    const devModelHints  = dev_p.models.join(', ')
    const qaModelHints   = qa_p.models.join(', ')
    const archScriptInfo = `\n\n---\n_Supervisor scripts (room: ${roomId}):_\n` +
      `消息通知：\n` +
      `- 普通消息给开发者: \`echo "..." | ${devScript}\`\n` +
      `- 紧急纠正给开发者（跳过队列）: \`echo "..." | ${devUrgentScript}\`\n` +
      `- 普通消息给QA工程师: \`echo "..." | ${qaScript}\`\n` +
      `- 紧急消息给QA工程师: \`echo "..." | ${qaUrgentScript}\`\n` +
      `模型切换：\n` +
      `- 切换自己的模型: \`${switchArchScript} <model>\`\n` +
      `- 切换开发者的模型: \`${switchDevScript} <model>\`\n` +
      `- 切换QA的模型: \`${switchQaScript} <model>\`\n` +
      `可用模型: ${archModelHints}\n` +
      `- 记录关键决策: \`echo "..." | ${memoryScript}\`\n`
    const devScriptInfo = `\n\n---\n_Supervisor scripts (room: ${roomId}):_\n` +
      `- 发消息给产品架构师: \`echo "..." | ${archScript}\`\n` +
      `- 升级/切换自己的模型: \`${switchDevScript} <model>\`\n` +
      `可用模型: ${devModelHints}\n` +
      `- 记录关键决策: \`echo "..." | ${memoryScript}\`\n`
    const qaScriptInfo = `\n\n---\n_Supervisor scripts (room: ${roomId}):_\n` +
      `- 发消息给产品架构师: \`echo "..." | ${archFromQaScript}\`\n` +
      `- 升级/切换自己的模型: \`${switchQaScript} <model>\`\n` +
      `可用模型: ${qaModelHints}\n` +
      `- 记录关键决策: \`echo "..." | ${memoryScript}\`\n`

    const archBase = readFileSync(join(__dir, 'prompts', 'arch.md'), 'utf8')
    const devBase  = readFileSync(join(__dir, 'prompts', 'dev.md'),  'utf8')
    const qaBase   = readFileSync(join(__dir, 'prompts', 'qa.md'),   'utf8')

    // Substitute placeholder paths with actual room-specific script paths
    const archContent = archBase
      .replace(/\/tmp\/notify-dev\.sh/g,          devScript)
      .replace(/\/tmp\/notify-dev-urgent\.sh/g,   devUrgentScript)
      .replace(/\/tmp\/notify-qa\.sh/g,           qaScript)
      .replace(/<switch-model-arch-script>/g,     switchArchScript)
      .replace(/<switch-model-dev-script>/g,      switchDevScript)
      .replace(/<switch-model-qa-script>/g,       switchQaScript)
      .replace(/<update-room-memory-script>/g,    memoryScript)
      .replace(/<archDir>/g,                      archDir)
      .replace(/<devDir>/g,                       devDir)
    const devContent = devBase
      .replace(/\/tmp\/notify-arch\.sh/g,         archScript)
      .replace(/<switch-model-dev-script>/g,      switchDevScript)
      .replace(/<update-room-memory-script>/g,    memoryScript)
      .replace(/<archDir>/g,                      archDir)
      .replace(/<devDir>/g,                       devDir)
    const qaContent = qaBase
      .replace(/\/tmp\/notify-arch-from-qa\.sh/g, archFromQaScript)
      .replace(/<switch-model-qa-script>/g,       switchQaScript)
      .replace(/<update-room-memory-script>/g,    memoryScript)
      .replace(/<devDir>/g,                       devDir)

    writeFileSync(`/tmp/arch-prompt-${roomId}.md`, archContent + memBlock(archCtx) + archScriptInfo)
    writeFileSync(`/tmp/dev-prompt-${roomId}.md`,  devContent  + memBlock(devCtx)  + devScriptInfo)
    writeFileSync(`/tmp/qa-prompt-${roomId}.md`,   qaContent   + memBlock(qaCtx)   + qaScriptInfo)
  } catch(e) { console.error('[writeRoomScripts]', e) }
}

function spawnTerminal(termId, projectDir, sessionId, cols = 80, rows = 24, silent = false, model = 'claude-sonnet-4-6', cli = 'claude') {
  if (ptys[termId]) {
    try { ptys[termId].proc.kill() } catch {}
    delete ptys[termId]
  }
  const { roomId, role } = parseTermId(termId)

  const profile    = CLI_PROFILES[cli] || CLI_PROFILES.claude
  const promptFile = role === 'arch' ? `/tmp/arch-prompt-${roomId}.md`
                   : role === 'qa'   ? `/tmp/qa-prompt-${roomId}.md`
                   :                   `/tmp/dev-prompt-${roomId}.md`

  // Write CLI-specific config files (e.g. Codex config.toml)
  if (profile.writeConfig) profile.writeConfig(promptFile, roomId, role)

  const extraEnv = profile.getEnv(promptFile, roomId, role)
  const proc = pty.spawn(process.env.SHELL || '/bin/zsh', [], {
    name: 'xterm-256color',
    cols: Math.max(2, cols),
    rows: Math.max(2, rows),
    cwd: projectDir || process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...extraEnv },
  })

  const entry = { proc, clients: new Set(), alive: true, textBuf: '', rawBuf: '', resumeInterrupt: !!sessionId }
  ptys[termId] = entry

  if (role === 'dev') {
    const st = getRoomState(roomId)
    st.devReviewWatermark = 0; st.autoReviewEnabled = false; st.lastReviewAt = 0
  }

  const cmd = profile.buildCmd(model, promptFile, sessionId, silent, role) + '\r'
  setTimeout(() => { if (ptys[termId] === entry) proc.write(cmd) }, 900)

  const trustTexts = profile.trustTexts || []
  const trustKey   = profile.trustKey   || '\r'
  let lastTrustDismissAt = 0

  proc.onData(data => {
    if (!entry.alive) return
    entry.textBuf = (entry.textBuf + stripAnsi(data)).slice(-12288)
    entry.rawBuf  = (entry.rawBuf + data).slice(-262144)
    const rSt = getRoomState(roomId)
    rSt.lastActivityTs[role] = Date.now()
    const box = getInbox(termId)
    clearTimeout(box.idleTimer)
    box.idleTimer = setTimeout(() => { box.idleTimer = null; inboxOnIdle(termId) }, INBOX_IDLE_MS)
    // Auto-dismiss trust/permission prompts (debounce 5s to avoid spamming)
    if (trustTexts.length > 0 && Date.now() - lastTrustDismissAt > 5000) {
      const recent = entry.textBuf.slice(-600)
      if (trustTexts.some(t => recent.includes(t))) {
        lastTrustDismissAt = Date.now()
        setTimeout(() => { if (entry.alive) proc.write(trustKey) }, 300)
        console.log(`[trust] auto-dismissed for ${termId} (cli=${cli})`)
      }
    }
    for (const ws of entry.clients) if (ws.readyState === 1) ws.send(data)
  })

  proc.onExit(() => {
    entry.alive = false
    for (const ws of entry.clients) try { ws.close(4001, 'PTY exited') } catch {}
    entry.clients.clear()
    if (ptys[termId] === entry) delete ptys[termId]
    broadcast({ type: 'pty_exited', termId })
  })
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return }

  const url = new URL(req.url, 'http://localhost:' + PORT)
  const json = (data, s = 200) => {
    res.writeHead(s, { 'Content-Type': 'application/json', ...cors })
    res.end(JSON.stringify(data))
  }

  if (req.method === 'GET' && url.pathname === '/') {
    const html = readFileSync(join(__dir, 'index.html'), 'utf8')
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
    return
  }

  if (req.method === 'GET' && url.pathname === '/status') {
    json(getStatus()); return
  }

  if (req.method === 'GET' && url.pathname === '/pty/buffer') {
    const termId = url.searchParams.get('termId')
    const e = ptys[termId]
    json({ text: e ? e.textBuf.slice(-4000) : '', alive: !!(e?.alive) }); return
  }

  if (req.method === 'GET' && url.pathname === '/sessions') {
    const projectDir = url.searchParams.get('projectDir')
    if (!projectDir) { json({ error: 'projectDir required' }, 400); return }
    json(listSessions(projectDir)); return
  }

  if (req.method === 'GET' && url.pathname === '/sessions/history') {
    const projectDir = url.searchParams.get('projectDir')
    const sessionId  = url.searchParams.get('sessionId')
    const limit      = parseInt(url.searchParams.get('limit') || '0')
    if (!projectDir || !sessionId) { json({ error: 'projectDir and sessionId required' }, 400); return }
    const all = loadSessionHistory(projectDir, sessionId)
    json({ messages: limit > 0 ? all.slice(-limit) : all, total: all.length }); return
  }

  // GET /rooms — list all rooms with live PTY status
  if (req.method === 'GET' && url.pathname === '/rooms') {
    const result = Object.values(rooms).map(r => ({
      ...r,
      archAlive:       !!(ptys[`${r.id}-arch`]?.alive),
      devAlive:        !!(ptys[`${r.id}-dev`]?.alive),
      qaAlive:         !!(ptys[`${r.id}-qa`]?.alive),
      watchdogEnabled: !!(getRoomState(r.id).watchdogEnabled),
    })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    json(result); return
  }

  // GET /rooms/:id/memory
  const memGetMatch = url.pathname.match(/^\/rooms\/([^/]+)\/memory$/)
  if (req.method === 'GET' && memGetMatch) {
    const id = memGetMatch[1]
    const room = rooms[id]
    if (!room) { json({ error: 'Room not found' }, 404); return }
    if (url.searchParams.get('info') === '1') {
      const archFiles = (() => { try { return readdirSync(join(room.archDir, 'ai-docs')).filter(f => f.endsWith('.md')) } catch { return [] } })()
      const devFiles  = (() => { try { return readdirSync(join(room.devDir,  'ai-docs')).filter(f => f.endsWith('.md')) } catch { return [] } })()
      json({ archFiles, devFiles }); return
    }
    let content = ''
    try { content = readFileSync(join(ROOM_MEMORIES_DIR, `${id}.md`), 'utf8') } catch {}
    json({ content }); return
  }

  // Body-requiring routes
  let body = ''
  req.on('data', d => body += d)
  req.on('end', async () => {
    let parsed = {}
    try { parsed = JSON.parse(body) } catch {}

    // POST /rooms — create room
    if (req.method === 'POST' && url.pathname === '/rooms') {
      const { name, archDir, devDir, qaDir, archSilent, devSilent, qaSilent, archModel, devModel, qaModel, archCli, devCli, qaCli } = parsed
      if (!archDir || !devDir) { json({ error: 'archDir and devDir required' }, 400); return }
      for (const dir of [archDir, devDir]) {
        try { if (!statSync(dir).isDirectory()) throw new Error() }
        catch { json({ error: `Directory not found: ${dir}` }, 400); return }
      }
      if (qaDir) {
        try { if (!statSync(qaDir).isDirectory()) throw new Error() }
        catch { json({ error: `Directory not found: ${qaDir}` }, 400); return }
      }
      const id = randomUUID().slice(0, 8)
      const now = Date.now()
      const validClis = Object.keys(CLI_PROFILES)
      const effArchCli = validClis.includes(archCli) ? archCli : 'claude'
      const effDevCli  = validClis.includes(devCli)  ? devCli  : 'claude'
      const effQaCli   = validClis.includes(qaCli)   ? qaCli   : 'claude'
      rooms[id] = {
        id, name: name || 'New Room', archDir, devDir, qaDir: qaDir || null,
        archSilent: !!archSilent, devSilent: !!devSilent, qaSilent: !!qaSilent,
        archModel: archModel || CLI_PROFILES[effArchCli].defaultModel,
        devModel:  devModel  || CLI_PROFILES[effDevCli].defaultModel,
        qaModel:   qaModel   || CLI_PROFILES[effQaCli].defaultModel,
        archCli: effArchCli, devCli: effDevCli, qaCli: effQaCli,
        createdAt: now, updatedAt: now,
      }
      saveRooms()
      json({ ok: true, room: rooms[id] }); return
    }

    // PUT /rooms/:id — update room
    const roomMatch = url.pathname.match(/^\/rooms\/([^/]+)$/)
    if (req.method === 'PUT' && roomMatch) {
      const id = roomMatch[1]
      if (!rooms[id]) { json({ error: 'Room not found' }, 404); return }
      const { name, archDir, devDir, qaDir, archSilent, devSilent, qaSilent, archModel, devModel, qaModel, archCli, devCli, qaCli } = parsed
      const validClis = Object.keys(CLI_PROFILES)
      if (name       !== undefined) rooms[id].name       = name
      if (archDir    !== undefined) rooms[id].archDir    = archDir
      if (devDir     !== undefined) rooms[id].devDir     = devDir
      if (qaDir      !== undefined) rooms[id].qaDir      = qaDir
      if (archSilent !== undefined) rooms[id].archSilent = archSilent
      if (devSilent  !== undefined) rooms[id].devSilent  = devSilent
      if (qaSilent   !== undefined) rooms[id].qaSilent   = qaSilent
      if (archModel  !== undefined) rooms[id].archModel  = archModel
      if (devModel   !== undefined) rooms[id].devModel   = devModel
      if (qaModel    !== undefined) rooms[id].qaModel    = qaModel
      if (archCli !== undefined && validClis.includes(archCli)) rooms[id].archCli = archCli
      if (devCli  !== undefined && validClis.includes(devCli))  rooms[id].devCli  = devCli
      if (qaCli   !== undefined && validClis.includes(qaCli))   rooms[id].qaCli   = qaCli
      rooms[id].updatedAt = Date.now()
      saveRooms()
      json({ ok: true, room: rooms[id] }); return
    }

    // PUT /rooms/:id/memory
    const memPutMatch = url.pathname.match(/^\/rooms\/([^/]+)\/memory$/)
    if (req.method === 'PUT' && memPutMatch) {
      const id = memPutMatch[1]
      if (!rooms[id]) { json({ error: 'Room not found' }, 404); return }
      const { content = '' } = parsed
      writeFileSync(join(ROOM_MEMORIES_DIR, `${id}.md`), content)
      json({ ok: true }); return
    }

    // DELETE /rooms/:id
    if (req.method === 'DELETE' && roomMatch) {
      const id = roomMatch[1]
      if (rooms[id]) {
        for (const role of ['arch', 'dev', 'qa']) {
          const termId = `${id}-${role}`
          if (ptys[termId]) { try { ptys[termId].proc.kill() } catch {}; delete ptys[termId] }
        }
        delete rooms[id]
        saveRooms()
      }
      json({ ok: true }); return
    }

    // POST /rooms/:id/spawn — spawn PTYs for a room
    const spawnMatch = url.pathname.match(/^\/rooms\/([^/]+)\/spawn$/)
    if (req.method === 'POST' && spawnMatch) {
      const id = spawnMatch[1]
      if (!rooms[id]) { json({ error: 'Room not found' }, 404); return }
      const room = rooms[id]
      const { archSessionId, devSessionId, qaSessionId, archModel, devModel, qaModel, archCli, devCli, qaCli, cols, rows } = parsed
      const validClis = Object.keys(CLI_PROFILES)
      if (archModel) rooms[id].archModel = archModel
      if (devModel)  rooms[id].devModel  = devModel
      if (qaModel)   rooms[id].qaModel   = qaModel
      if (archCli && validClis.includes(archCli)) rooms[id].archCli = archCli
      if (devCli  && validClis.includes(devCli))  rooms[id].devCli  = devCli
      if (qaCli   && validClis.includes(qaCli))   rooms[id].qaCli   = qaCli
      for (const dir of [room.archDir, room.devDir]) {
        try { if (!statSync(dir).isDirectory()) throw new Error() }
        catch { json({ error: `Directory not found: ${dir}` }, 400); return }
      }
      if (room.qaDir) {
        try { if (!statSync(room.qaDir).isDirectory()) throw new Error() }
        catch { json({ error: `Directory not found: ${room.qaDir}` }, 400); return }
      }
      const rArchCli = rooms[id].archCli || 'claude'
      const rDevCli  = rooms[id].devCli  || 'claude'
      const rQaCli   = rooms[id].qaCli   || 'claude'
      // Persist selected session IDs
      if (archSessionId) rooms[id].archSessionId = archSessionId
      if (devSessionId)  rooms[id].devSessionId  = devSessionId
      if (qaSessionId)   rooms[id].qaSessionId   = qaSessionId
      writeRoomScripts(id, room.archDir, room.devDir, rArchCli, rDevCli, rQaCli)
      spawnTerminal(`${id}-arch`, room.archDir, archSessionId || null, cols || 80, rows || 24, room.archSilent, room.archModel || 'claude-sonnet-4-6', rArchCli)
      spawnTerminal(`${id}-dev`,  room.devDir,  devSessionId  || null, cols || 80, rows || 24, room.devSilent,  room.devModel  || 'claude-sonnet-4-6', rDevCli)
      if (room.qaDir) {
        spawnTerminal(`${id}-qa`, room.qaDir, qaSessionId || null, cols || 80, rows || 24, room.qaSilent || false, room.qaModel || 'claude-sonnet-4-6', rQaCli)
      }
      rooms[id].updatedAt = Date.now()
      saveRooms()
      // Background-capture session IDs for new Claude sessions (dedup by dir to avoid same-dir conflict)
      const _capturingDirs = new Set()
      if (!archSessionId && rArchCli === 'claude') { captureNewSession(room.archDir, id, 'arch'); _capturingDirs.add(room.archDir) }
      if (!devSessionId  && rDevCli  === 'claude' && !_capturingDirs.has(room.devDir))  { captureNewSession(room.devDir, id, 'dev'); _capturingDirs.add(room.devDir) }
      if (!qaSessionId   && rQaCli   === 'claude' && room.qaDir && !_capturingDirs.has(room.qaDir)) captureNewSession(room.qaDir, id, 'qa')
      json({ ok: true }); return
    }

    // POST /rooms/:id/watchdog — enable or disable watchdog
    const watchdogMatch = url.pathname.match(/^\/rooms\/([^/]+)\/watchdog$/)
    if (req.method === 'POST' && watchdogMatch) {
      const id = watchdogMatch[1]
      if (!rooms[id]) { json({ error: 'Room not found' }, 404); return }
      const { enabled } = parsed
      if (enabled) startWatchdog(id); else stopWatchdog(id)
      json({ ok: true, enabled: !!enabled }); return
    }

    // POST /rooms/:id/switch-model — respawn PTY with new model (context preserved via --resume)
    const switchModelMatch = url.pathname.match(/^\/rooms\/([^/]+)\/switch-model$/)
    if (req.method === 'POST' && switchModelMatch) {
      const id = switchModelMatch[1]
      if (!rooms[id]) { json({ error: 'Room not found' }, 404); return }
      const { role, model } = parsed
      if (!role || !model) { json({ error: 'role and model required' }, 400); return }
      const room = rooms[id]
      const termId = `${id}-${role}`
      const projectDir = role === 'arch' ? room.archDir : role === 'qa' ? room.qaDir : room.devDir
      const silent = role === 'arch' ? room.archSilent : role === 'qa' ? (room.qaSilent || false) : room.devSilent
      const roleCli = room[`${role}Cli`] || 'claude'
      const profile = CLI_PROFILES[roleCli] || CLI_PROFILES.claude
      if (!projectDir) { json({ error: `No directory configured for role: ${role}` }, 400); return }
      // Determine session ID based on CLI's resume capability
      let sessionId = null
      if (profile.supportsResume) {
        if (roleCli === 'gemini') {
          sessionId = 'latest'   // gemini -r latest
        } else if (roleCli === 'codex') {
          sessionId = 'last'     // codex resume --last
        } else if (roleCli === 'kimi') {
          sessionId = 'last'     // kimi --continue
        } else {
          const sessions = listSessions(projectDir)
          sessionId = sessions[0]?.sessionId || null
        }
      }
      // Update persisted model
      rooms[id][`${role}Model`] = model
      saveRooms()
      // Regenerate prompt files with latest memory context before respawning
      writeRoomScripts(id, room.archDir, room.devDir, room.archCli || 'claude', room.devCli || 'claude', room.qaCli || 'claude')
      // Respawn with new model; session resume preserves context where CLI supports it
      spawnTerminal(termId, projectDir, sessionId, 120, 30, silent, model, roleCli)
      broadcast({ type: 'model_switched', roomId: id, role, model, cli: roleCli, sessionId: sessionId || null })
      console.log(`[switch-model] room=${id} role=${role} model=${model} cli=${roleCli} session=${sessionId}`)
      json({ ok: true, role, model, cli: roleCli, sessionId }); return
    }

    // POST /notify — agent-to-agent messaging
    if (req.method === 'POST' && url.pathname === '/notify') {
      const { to, from: explicitFrom, roomId, message } = parsed
      if (!to || !message) { json({ error: 'to and message required' }, 400); return }
      if (!roomId) { json({ error: 'roomId required' }, 400); return }
      const toTermId = `${roomId}-${to}`
      // Use explicit from if provided (new scripts send it); fall back to inference for backward compat
      const from = explicitFrom || (to === 'arch' ? 'dev' : 'arch')
      const priority = parsed.priority === 'urgent' ? 'urgent' : 'normal'
      if (to === 'dev') getRoomState(roomId).autoReviewEnabled = true
      inboxSend(toTermId, from, message, priority)
      json({ ok: true }); return
    }

    // POST /pty/write — inject text into a terminal
    if (req.method === 'POST' && url.pathname === '/pty/write') {
      const { termId, text } = parsed
      const e = ptys[termId]
      if (!e || !e.alive) { json({ error: 'PTY not alive' }, 400); return }
      if (text.includes('\n')) {
        e.proc.write('\x1b[200~' + text + '\x1b[201~')
        setTimeout(() => { if (e.alive) e.proc.write('\r') }, 200)
      } else {
        e.proc.write(text + '\r')
      }
      json({ ok: true }); return
    }

    // POST /pty/kill
    if (req.method === 'POST' && url.pathname === '/pty/kill') {
      const { termId } = parsed
      if (ptys[termId]) { try { ptys[termId].proc.kill() } catch {}; delete ptys[termId] }
      json({ ok: true }); return
    }

    // Legacy endpoints (kept for compatibility)
    if (req.method === 'POST' && url.pathname === '/chat') {
      try { json({ reply: await chatWithArchitect(parsed.message, parsed.projectDir) }) }
      catch (e) { json({ error: e.message }, 500) }
      return
    }
    if (req.method === 'POST' && url.pathname === '/dev/send') {
      try { await sendToDeveloper(parsed.message); json({ ok: true }) }
      catch (e) { json({ error: e.message }, 500) }
      return
    }
    if (req.method === 'POST' && url.pathname === '/start') {
      try { await startArchitect(parsed.projectDir || process.cwd(), parsed.resumeSessionId); json({ ok: true }) }
      catch (e) { json({ error: e.message }, 500) }
      return
    }
    if (req.method === 'POST' && url.pathname === '/stop') {
      await stopAll(); json({ ok: true }); return
    }

    res.writeHead(404, cors); res.end('Not found')
  })
})

// ── Event WebSocket ───────────────────────────────────────────────────────────
const eventWss = new WebSocketServer({ noServer: true })
eventWss.on('connection', ws => {
  clients.add(ws)
  ws.send(JSON.stringify({ type: 'connected', ...getStatus() }))
  ws.on('close', () => clients.delete(ws))
})

// ── PTY WebSocket ─────────────────────────────────────────────────────────────
const ptyWss = new WebSocketServer({ noServer: true })
ptyWss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost')
  const termId = url.pathname.replace('/pty/', '')

  if (!ptys[termId]) {
    ws.close(4001, 'No PTY running for ' + termId)
    return
  }

  const connEntry = ptys[termId]
  connEntry.clients.add(ws)
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })

  if (connEntry.rawBuf) ws.send(connEntry.rawBuf)

  ws.on('message', rawMsg => {
    const msg = rawMsg.toString()
    if (!connEntry?.alive) return
    if (msg.startsWith('{')) {
      try {
        const ctrl = JSON.parse(msg)
        if (ctrl.type === 'resize') connEntry.proc.resize(Math.max(2, ctrl.cols), Math.max(2, ctrl.rows))
        return
      } catch {}
    }
    connEntry.proc.write(msg)
  })

  ws.on('close', () => { if (connEntry) connEntry.clients.delete(ws) })
})

setInterval(() => {
  for (const ws of ptyWss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue }
    ws.isAlive = false
    ws.ping()
  }
}, 30_000)

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname.startsWith('/pty/')) {
    ptyWss.handleUpgrade(req, socket, head, ws => ptyWss.emit('connection', ws, req))
  } else {
    eventWss.handleUpgrade(req, socket, head, ws => eventWss.emit('connection', ws, req))
  }
})

server.listen(PORT, () => console.log('Supervisor running: http://localhost:' + PORT))
