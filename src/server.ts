import http from 'http'
import { WebSocketServer } from 'ws'
import { existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { networkInterfaces } from 'os'
import type { WebSocket } from 'ws'

function getLanIp(): string | null {
  for (const nets of Object.values(networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address
    }
  }
  return null
}

const HOST = process.env.HOST || '0.0.0.0'

// Auto-load .env from project root
;(() => {
  const envFile = join(dirname(fileURLToPath(import.meta.url)), '..', '.env')
  if (!existsSync(envFile)) return
  try {
    readFileSync(envFile, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (!m) return
      const key = m[1], val = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
      if (!(key in process.env)) process.env[key] = val
    })
    console.log('[env] loaded .env')
  } catch (e) { console.warn('[env] .env parse error:', (e as Error).message) }
})()

import { PORT } from './config.js'
import { WS_PING_INTERVAL_MS } from './constants.js'
import { clients, ptys } from './state.js'
import { loadRooms, loadGroups } from './persistence.js'
import { setInboxSend, commSend, maybeAutoStartComm } from './comm.js'
import { inboxSend } from './inbox.js'
import { registerCommSend } from './distiller.js'
import { createRequestHandler } from './routes.js'

setInboxSend(inboxSend)
registerCommSend(commSend)
loadRooms()
loadGroups()

const server = http.createServer(createRequestHandler(PORT))

// ── Event WebSocket ───────────────────────────────────────────────────────────
const eventWss = new WebSocketServer({ noServer: true })
eventWss.on('connection', (ws: WebSocket) => {
  clients.add(ws)
  ws.send(JSON.stringify({ type: 'connected' }))
  ws.on('close', () => clients.delete(ws))
})

// ── PTY WebSocket ─────────────────────────────────────────────────────────────
const ptyWss = new WebSocketServer({ noServer: true })
ptyWss.on('connection', (ws: WebSocket & { isAlive?: boolean }, req: http.IncomingMessage) => {
  const url = new URL(req.url!, 'http://localhost')
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

  ws.on('message', (rawMsg: Buffer | string) => {
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
  for (const ws of ptyWss.clients as Set<WebSocket & { isAlive?: boolean }>) {
    if (ws.isAlive === false) { ws.terminate(); continue }
    ws.isAlive = false
    ws.ping()
  }
}, WS_PING_INTERVAL_MS)

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url!, 'http://localhost')
  if (url.pathname.startsWith('/pty/')) {
    ptyWss.handleUpgrade(req, socket, head, ws => ptyWss.emit('connection', ws, req))
  } else {
    eventWss.handleUpgrade(req, socket, head, ws => eventWss.emit('connection', ws, req))
  }
})

server.listen(PORT, HOST, () => {
  console.log(`Supervisor running: http://localhost:${PORT}`)
  const lan = getLanIp()
  if (lan && HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.log(`  Remote access:    http://${lan}:${PORT}`)
  }
  maybeAutoStartComm()
})
