import http from 'http'
import { WebSocketServer } from 'ws'
import { readFileSync, readdirSync, writeFileSync, realpathSync, statSync } from 'fs'
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

const PORT = 3458
const __dir = dirname(fileURLToPath(import.meta.url))
const ROOMS_FILE = join(__dir, 'rooms.json')

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

// ── PTY storage: key = '${roomId}-arch' or '${roomId}-dev' ────────────────────
const ptys = {}

// ── Per-room state ────────────────────────────────────────────────────────────
const roomStates = {}
function getRoomState(roomId) {
  if (!roomStates[roomId]) {
    roomStates[roomId] = {
      autoReviewEnabled: false, lastReviewAt: 0, devReviewWatermark: 0,
      watchdogEnabled: false, watchdogTimer: null,
      lastActivityTs: { arch: 0, dev: 0 },
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

// '${roomId}-arch' → { roomId, role: 'arch' }; roomId can contain hyphens (UUID)
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
  if (termId.endsWith('-dev') && from === 'arch') {
    const { roomId } = parseTermId(termId)
    const st = getRoomState(roomId)
    st.devReviewWatermark = ptys[termId]?.textBuf.length || st.devReviewWatermark
    st.lastReviewAt = Date.now()
  }
}

function inboxSend(to, from, text) {
  const box = getInbox(to)
  if (!box.idleTimer && ptys[to]?.alive) {
    inboxDeliver(to, from, text)
  } else {
    box.queue.push({ from, text })
    broadcast({ type: 'inbox_queued', to, from, queueLen: box.queue.length })
  }
}

function inboxOnIdle(termId) {
  const entry = ptys[termId]
  if (entry?.resumeInterrupt) {
    entry.resumeInterrupt = false
    const role = termId.endsWith('-arch') ? 'arch' : 'dev'
    inboxDeliver(termId, 'system',
      `[SUPERVISOR SESSION RESTARTED]\n` +
      `This is a new Supervisor session. Your previous conversation context is still loaded, ` +
      `but you must STOP any work in progress immediately.\n` +
      `Do NOT continue previous tasks or run any commands.\n` +
      `${role === 'arch' ? 'Wait for the user to give you a new assignment.' : 'Wait for a new task from the Architect via <cross-session-message from="arch">.'}`
    )
    return
  }
  const box = getInbox(termId)
  if (box.queue.length) {
    const next = box.queue.shift()
    inboxDeliver(termId, next.from, next.text)
    return
  }
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
const WATCHDOG_INTERVAL_MS      = 10 * 60 * 1000  // check every 10 min
const WATCHDOG_IDLE_THRESHOLD_MS = 10 * 60 * 1000  // idle > 10 min = stuck

function runWatchdogCheck(roomId) {
  const now        = Date.now()
  const st         = getRoomState(roomId)
  const archTermId = `${roomId}-arch`
  const devTermId  = `${roomId}-dev`
  const archEntry  = ptys[archTermId]
  const devEntry   = ptys[devTermId]

  // [TASK_COMPLETE] in Arch's recent output → task done, stop watchdog
  if (archEntry?.alive) {
    if (archEntry.textBuf.slice(-3000).includes('[TASK_COMPLETE]')) {
      stopWatchdog(roomId)
      broadcast({ type: 'watchdog_done', roomId })
      return
    }
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

// Write per-room notify scripts and combined prompt files
function writeRoomScripts(roomId) {
  const devScript  = `/tmp/notify-${roomId}-dev.sh`
  const archScript = `/tmp/notify-${roomId}-arch.sh`
  const makeScript = (toId, label) => `#!/bin/bash
message=$(cat)
[ -z "$message" ] && { echo "No message provided" >&2; exit 1; }
python3 -c '
import json, http.client, sys
msg = sys.argv[1]
conn = http.client.HTTPConnection("localhost", ${PORT})
body = json.dumps({"to": "${toId}", "roomId": "${roomId}", "message": msg})
conn.request("POST", "/notify", body, {"Content-Type": "application/json"})
r = conn.getresponse(); r.read()
print("ok - ${label} notified" if r.status == 200 else "fail - send error")
' "$message"`
  try {
    writeFileSync(archScript, makeScript('arch', 'Architect'), { mode: 0o755 })
    writeFileSync(devScript,  makeScript('dev',  'Developer'),  { mode: 0o755 })
    const scriptInfo = `\n\n---\n_Supervisor notification scripts for this session (room: ${roomId}):_\n` +
      `- To send message to Developer: \`echo "your message" | ${devScript}\`\n` +
      `- To send message to Architect: \`echo "your message" | ${archScript}\`\n`
    const archBase = readFileSync(join(__dir, 'prompts', 'arch.md'), 'utf8')
    const devBase  = readFileSync(join(__dir, 'prompts', 'dev.md'),  'utf8')
    writeFileSync(`/tmp/arch-prompt-${roomId}.md`, archBase + scriptInfo)
    writeFileSync(`/tmp/dev-prompt-${roomId}.md`,  devBase  + scriptInfo)
  } catch {}
}

function spawnTerminal(termId, projectDir, sessionId, cols = 80, rows = 24, silent = false) {
  if (ptys[termId]) {
    try { ptys[termId].proc.kill() } catch {}
    delete ptys[termId]
  }
  const { roomId, role } = parseTermId(termId)

  const proc = pty.spawn(process.env.SHELL || '/bin/zsh', [], {
    name: 'xterm-256color',
    cols: Math.max(2, cols),
    rows: Math.max(2, rows),
    cwd: projectDir || process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  })

  const entry = { proc, clients: new Set(), alive: true, textBuf: '', rawBuf: '', resumeInterrupt: !!sessionId }
  ptys[termId] = entry

  if (role === 'dev') {
    const st = getRoomState(roomId)
    st.devReviewWatermark = 0; st.autoReviewEnabled = false; st.lastReviewAt = 0
  }

  const archPromptFile = `/tmp/arch-prompt-${roomId}.md`
  const devPromptFile  = `/tmp/dev-prompt-${roomId}.md`
  const silentFlag = silent ? ' --dangerously-skip-permissions' : ''
  const ARCH_FLAGS = `--disallowedTools Write,Edit,MultiEdit,NotebookEdit,Task --append-system-prompt-file ${archPromptFile}${silentFlag}`
  const DEV_FLAGS  = `--append-system-prompt-file ${devPromptFile}${silentFlag}`

  const cmd = role === 'arch'
    ? (sessionId ? `claude --model claude-sonnet-4-6 ${ARCH_FLAGS} --resume ${sessionId}\r` : `claude --model claude-sonnet-4-6 ${ARCH_FLAGS}\r`)
    : (sessionId ? `claude --model claude-sonnet-4-6 ${DEV_FLAGS}  --resume ${sessionId}\r` : `claude --model claude-sonnet-4-6 ${DEV_FLAGS}\r`)

  setTimeout(() => { if (ptys[termId] === entry) proc.write(cmd) }, 900)

  proc.onData(data => {
    if (!entry.alive) return
    entry.textBuf = (entry.textBuf + stripAnsi(data)).slice(-12288)
    // Keep raw ANSI output for replaying to newly-connected clients (last 256 KB)
    entry.rawBuf  = (entry.rawBuf + data).slice(-262144)
    // Track last activity time for watchdog idle detection
    const rSt = getRoomState(roomId)
    rSt.lastActivityTs[role] = Date.now()
    const box = getInbox(termId)
    clearTimeout(box.idleTimer)
    box.idleTimer = setTimeout(() => { box.idleTimer = null; inboxOnIdle(termId) }, INBOX_IDLE_MS)
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
      watchdogEnabled: !!(getRoomState(r.id).watchdogEnabled),
    })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    json(result); return
  }

  // Body-requiring routes
  let body = ''
  req.on('data', d => body += d)
  req.on('end', async () => {
    let parsed = {}
    try { parsed = JSON.parse(body) } catch {}

    // POST /rooms — create room
    if (req.method === 'POST' && url.pathname === '/rooms') {
      const { name, archDir, devDir, archSilent, devSilent } = parsed
      if (!archDir || !devDir) { json({ error: 'archDir and devDir required' }, 400); return }
      for (const dir of [archDir, devDir]) {
        try { if (!statSync(dir).isDirectory()) throw new Error() }
        catch { json({ error: `Directory not found: ${dir}` }, 400); return }
      }
      const id = randomUUID().slice(0, 8)
      const now = Date.now()
      rooms[id] = { id, name: name || 'New Room', archDir, devDir, archSilent: !!archSilent, devSilent: !!devSilent, createdAt: now, updatedAt: now }
      saveRooms()
      json({ ok: true, room: rooms[id] }); return
    }

    // PUT /rooms/:id — update room name or dirs
    const roomMatch = url.pathname.match(/^\/rooms\/([^/]+)$/)
    if (req.method === 'PUT' && roomMatch) {
      const id = roomMatch[1]
      if (!rooms[id]) { json({ error: 'Room not found' }, 404); return }
      const { name, archDir, devDir, archSilent, devSilent } = parsed
      if (name      !== undefined) rooms[id].name      = name
      if (archDir   !== undefined) rooms[id].archDir   = archDir
      if (devDir    !== undefined) rooms[id].devDir    = devDir
      if (archSilent !== undefined) rooms[id].archSilent = archSilent
      if (devSilent  !== undefined) rooms[id].devSilent  = devSilent
      rooms[id].updatedAt = Date.now()
      saveRooms()
      json({ ok: true, room: rooms[id] }); return
    }

    // DELETE /rooms/:id
    if (req.method === 'DELETE' && roomMatch) {
      const id = roomMatch[1]
      if (rooms[id]) {
        for (const role of ['arch', 'dev']) {
          const termId = `${id}-${role}`
          if (ptys[termId]) { try { ptys[termId].proc.kill() } catch {}; delete ptys[termId] }
        }
        delete rooms[id]
        saveRooms()
      }
      json({ ok: true }); return
    }

    // POST /rooms/:id/spawn — spawn both PTYs for a room
    const spawnMatch = url.pathname.match(/^\/rooms\/([^/]+)\/spawn$/)
    if (req.method === 'POST' && spawnMatch) {
      const id = spawnMatch[1]
      if (!rooms[id]) { json({ error: 'Room not found' }, 404); return }
      const room = rooms[id]
      const { archSessionId, devSessionId, cols, rows } = parsed
      for (const dir of [room.archDir, room.devDir]) {
        try { if (!statSync(dir).isDirectory()) throw new Error() }
        catch { json({ error: `Directory not found: ${dir}` }, 400); return }
      }
      writeRoomScripts(id)
      spawnTerminal(`${id}-arch`, room.archDir, archSessionId || null, cols || 80, rows || 24, room.archSilent)
      spawnTerminal(`${id}-dev`,  room.devDir,  devSessionId  || null, cols || 80, rows || 24, room.devSilent)
      rooms[id].updatedAt = Date.now()
      saveRooms()
      json({ ok: true }); return
    }

    // POST /rooms/:id/watchdog — enable or disable watchdog for a room
    const watchdogMatch = url.pathname.match(/^\/rooms\/([^/]+)\/watchdog$/)
    if (req.method === 'POST' && watchdogMatch) {
      const id = watchdogMatch[1]
      if (!rooms[id]) { json({ error: 'Room not found' }, 404); return }
      const { enabled } = parsed
      if (enabled) startWatchdog(id); else stopWatchdog(id)
      json({ ok: true, enabled: !!enabled }); return
    }

    // POST /notify — agent-to-agent messaging
    if (req.method === 'POST' && url.pathname === '/notify') {
      const { to, roomId, message } = parsed
      if (!to || !message) { json({ error: 'to and message required' }, 400); return }
      if (!roomId) { json({ error: 'roomId required' }, 400); return }
      const toTermId = `${roomId}-${to}`
      const from = to === 'arch' ? 'dev' : 'arch'
      if (to === 'dev') getRoomState(roomId).autoReviewEnabled = true
      inboxSend(toTermId, from, message)
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

// ── PTY WebSocket — termId extracted from path: /pty/${roomId}-arch ───────────
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

  // Replay buffered output so the new client sees current terminal state
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
