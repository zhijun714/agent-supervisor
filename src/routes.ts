import { readFileSync, writeFileSync, statSync, readdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'
import { rooms, ptys, inboxes, broadcast, getRoomState } from './state.js'
import { saveRooms } from './persistence.js'
import { CLI_PROFILES } from './cli-profiles.js'
import { getAdapterStatus, startComm, stopComm, commSend } from './comm.js'
import { listSessions, listKimiSessions, listCodexSessions, loadSessionHistory, captureNewSession, captureNewKimiSession, captureNewCodexSession } from './sessions.js'
import { writeRoomScripts } from './scripts.js'
import { spawnTerminal, scheduleLimitRetry } from './pty-manager.js'
import { startWatchdog, stopWatchdog } from './watchdog.js'
import { inboxSend, markNotifyDelivered } from './inbox.js'
import { ROOT_DIR, ROOM_MEMORIES_DIR, PORT, PREFS_FILE } from './config.js'
import type { Room } from './types.js'

export function createRequestHandler(port: number) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  }

  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return }

    const url = new URL(req.url!, 'http://localhost:' + port)
    const json = (data: unknown, s = 200) => {
      res.writeHead(s, { 'Content-Type': 'application/json', ...cors })
      res.end(JSON.stringify(data))
    }

    // ── Static assets ──────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/') {
      const html = readFileSync(join(ROOT_DIR, 'public', 'index.html'), 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate', ...cors })
      res.end(html)
      return
    }

    if (req.method === 'GET' && url.pathname === '/app.js') {
      try {
        const js = readFileSync(join(ROOT_DIR, 'public', 'app.js'))
        res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache, no-store, must-revalidate', ...cors })
        res.end(js)
      } catch {
        res.writeHead(404, cors); res.end('app.js not found — run npm run build')
      }
      return
    }

    if (req.method === 'GET' && url.pathname === '/sw.js') {
      const sw = [
        "self.addEventListener('install', () => self.skipWaiting())",
        "self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))",
        "// Empty fetch handler: satisfies Chrome installability check without intercepting requests.",
        "// No respondWith() call → browser falls through to network, server no-cache headers always apply.",
        "self.addEventListener('fetch', () => {})",
      ].join('\n')
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Service-Worker-Allowed': '/', ...cors })
      res.end(sw)
      return
    }

    if (req.method === 'GET' && url.pathname === '/manifest.json') {
      const iconSvgB64 = 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxOTIgMTkyIj48cmVjdCB3aWR0aD0iMTkyIiBoZWlnaHQ9IjE5MiIgcng9IjMyIiBmaWxsPSIjMGYxMTE3Ii8+PHJlY3QgeD0iMzIiIHk9IjU2IiB3aWR0aD0iMTI4IiBoZWlnaHQ9IjE0IiByeD0iNCIgZmlsbD0iIzNmYjk1MCIvPjxyZWN0IHg9Ijc4IiB5PSI1NiIgd2lkdGg9IjE0IiBoZWlnaHQ9IjEwMCIgcng9IjQiIGZpbGw9IiM1OGE2ZmYiLz48cmVjdCB4PSIzMiIgeT0iNzAiIHdpZHRoPSIyMiIgaGVpZ2h0PSIxOCIgcng9IjQiIGZpbGw9IiNlM2IzNDEiLz48cmVjdCB4PSIxMjIiIHk9IjcwIiB3aWR0aD0iNCIgaGVpZ2h0PSI1NiIgcng9IjIiIGZpbGw9IiM4Yjk0OWUiLz48cmVjdCB4PSIxMTIiIHk9IjEyMiIgd2lkdGg9IjI0IiBoZWlnaHQ9IjEwIiByeD0iNCIgZmlsbD0iI2Y4NTE0OSIvPjxyZWN0IHg9IjY0IiB5PSIxNTYiIHdpZHRoPSI0MCIgaGVpZ2h0PSI4IiByeD0iMyIgZmlsbD0iIzU4YTZmZiIvPjwvc3ZnPg=='
      const iconUri = 'data:image/svg+xml;base64,' + iconSvgB64
      const manifest = {
        name: 'Supervisor',
        short_name: 'Supervisor',
        start_url: '/',
        display: 'standalone',
        background_color: '#0f1117',
        theme_color: '#0f1117',
        icons: [
          { src: iconUri, sizes: '192x192', type: 'image/svg+xml' },
          { src: iconUri, sizes: '512x512', type: 'image/svg+xml' },
        ],
      }
      res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache, no-store, must-revalidate', ...cors })
      res.end(JSON.stringify(manifest))
      return
    }

    // ── Simple GET API routes (no body needed) ─────────────────────────────
    if (req.method === 'GET' && url.pathname === '/prefs') {
      let prefs: Record<string, unknown> = {}
      try { prefs = JSON.parse(readFileSync(PREFS_FILE, 'utf8')) } catch {}
      json(prefs); return
    }

    if (req.method === 'GET' && url.pathname === '/pty/buffer') {
      const termId = url.searchParams.get('termId')!
      const e = ptys[termId]
      json({ text: e ? e.textBuf.slice(-4000) : '', alive: !!(e?.alive) }); return
    }

    if (req.method === 'GET' && url.pathname === '/sessions') {
      const projectDir = url.searchParams.get('projectDir')
      if (!projectDir) { json({ error: 'projectDir required' }, 400); return }
      const cli = url.searchParams.get('cli') || 'claude'
      json(cli === 'kimi' ? listKimiSessions(projectDir) : cli === 'codex' ? listCodexSessions(projectDir) : listSessions(projectDir)); return
    }

    if (req.method === 'GET' && url.pathname === '/sessions/history') {
      const projectDir = url.searchParams.get('projectDir')
      const sessionId  = url.searchParams.get('sessionId')
      const limit      = parseInt(url.searchParams.get('limit') || '0')
      if (!projectDir || !sessionId) { json({ error: 'projectDir and sessionId required' }, 400); return }
      const all = loadSessionHistory(projectDir, sessionId)
      json({ messages: limit > 0 ? all.slice(-limit) : all, total: all.length }); return
    }

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

    const memGetMatch = url.pathname.match(/^\/rooms\/([^/]+)\/memory$/)
    if (req.method === 'GET' && memGetMatch) {
      const id = memGetMatch[1]
      const room = rooms[id]
      if (!room) { json({ error: 'Room not found' }, 404); return }
      if (url.searchParams.get('info') === '1') {
        const archFiles = (() => { try { return room.archDir ? readdirSync(join(room.archDir, 'ai-docs')).filter(f => f.endsWith('.md')) : [] } catch { return [] } })()
        const devFiles  = (() => { try { return room.devDir  ? readdirSync(join(room.devDir,  'ai-docs')).filter(f => f.endsWith('.md')) : [] } catch { return [] } })()
        json({ archFiles, devFiles }); return
      }
      let content = ''
      try { content = readFileSync(join(ROOM_MEMORIES_DIR, `${id}.md`), 'utf8') } catch {}
      json({ content }); return
    }

    const commGetMatch = url.pathname.match(/^\/rooms\/([^/]+)\/comm$/)
    if (req.method === 'GET' && commGetMatch) {
      const id = commGetMatch[1]
      if (!rooms[id]) { json({ error: 'Room not found' }, 404); return }
      const r = rooms[id]
      json({
        commEnabled:       r.commEnabled      || false,
        commAdapter:       r.commAdapter      || null,
        commReceiveId:     r.commReceiveId    || '',
        commReceiveIdType: r.commReceiveIdType || 'chat_id',
        adapterStatus:     getAdapterStatus(r.commAdapter),
      }); return
    }

    const inboxPeekMatch = url.pathname.match(/^\/rooms\/([^/]+)\/inbox$/)
    if (req.method === 'GET' && inboxPeekMatch) {
      const id = inboxPeekMatch[1]
      if (!rooms[id]) { json({ error: 'Room not found' }, 404); return }
      const role = url.searchParams.get('role')
      if (!role) { json({ error: 'role required' }, 400); return }
      const box = inboxes[`${id}-${role}`]
      json({ queue: (box?.queue || []).map(m => ({ from: m.from, text: m.text, priority: m.priority })) }); return
    }

    // ── Body-requiring routes ──────────────────────────────────────────────
    let body = ''
    req.on('data', d => body += d)
    req.on('end', async () => {
      let parsed: Record<string, unknown> = {}
      try { parsed = JSON.parse(body) } catch {}

      // Global UI prefs (e.g. terminal theme) — durable backup beside localStorage.
      if (req.method === 'PUT' && url.pathname === '/prefs') {
        let prefs: Record<string, unknown> = {}
        try { prefs = JSON.parse(readFileSync(PREFS_FILE, 'utf8')) } catch {}
        prefs = { ...prefs, ...parsed }
        try { writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2)) } catch (e) { json({ error: (e as Error).message }, 500); return }
        json({ ok: true, prefs }); return
      }

      if (req.method === 'POST' && url.pathname === '/rooms') {
        const { name, archDir, devDir, qaDir, archSilent, devSilent, qaSilent, archModel, devModel, qaModel, archCli, devCli, qaCli } = parsed as Partial<Room> & { name?: string }
        if (!archDir && !devDir && !qaDir) { json({ error: '至少需要启用一个角色（填写至少一个目录）' }, 400); return }
        for (const dir of [archDir, devDir, qaDir]) {
          if (!dir) continue
          try { if (!statSync(dir as string).isDirectory()) throw new Error() }
          catch { json({ error: `Directory not found: ${dir}` }, 400); return }
        }
        const id = randomUUID().slice(0, 8)
        const now = Date.now()
        const validClis = Object.keys(CLI_PROFILES)
        const effArchCli = validClis.includes(archCli as string) ? archCli as string : 'claude'
        const effDevCli  = validClis.includes(devCli  as string) ? devCli  as string : 'claude'
        const effQaCli   = validClis.includes(qaCli   as string) ? qaCli   as string : 'claude'
        rooms[id] = {
          id, name: (name as string) || 'New Room', archDir: (archDir as string) || null, devDir: (devDir as string) || null, qaDir: (qaDir as string) || null,
          archSilent: !!(archSilent), devSilent: !!(devSilent), qaSilent: !!(qaSilent),
          archModel: (archModel as string) || CLI_PROFILES[effArchCli].defaultModel,
          devModel:  (devModel  as string) || CLI_PROFILES[effDevCli].defaultModel,
          qaModel:   (qaModel   as string) || CLI_PROFILES[effQaCli].defaultModel,
          archCli: effArchCli, devCli: effDevCli, qaCli: effQaCli,
          createdAt: now, updatedAt: now,
        }
        saveRooms()
        json({ ok: true, room: rooms[id] }); return
      }

      const roomMatch = url.pathname.match(/^\/rooms\/([^/]+)$/)

      if (req.method === 'PUT' && roomMatch) {
        const id = roomMatch[1]
        if (!rooms[id]) { json({ error: 'Room not found' }, 404); return }
        const { name, archDir, devDir, qaDir, archSilent, devSilent, qaSilent, archModel, devModel, qaModel, archCli, devCli, qaCli } = parsed
        const validClis = Object.keys(CLI_PROFILES)
        if (name       !== undefined) rooms[id].name       = name as string
        if (archDir    !== undefined) rooms[id].archDir    = (archDir as string) || null
        if (devDir     !== undefined) rooms[id].devDir     = (devDir as string) || null
        if (qaDir      !== undefined) rooms[id].qaDir      = (qaDir as string) || null
        if (archSilent !== undefined) rooms[id].archSilent = !!(archSilent)
        if (devSilent  !== undefined) rooms[id].devSilent  = !!(devSilent)
        if (qaSilent   !== undefined) rooms[id].qaSilent   = !!(qaSilent)
        if (archModel  !== undefined) rooms[id].archModel  = archModel as string
        if (devModel   !== undefined) rooms[id].devModel   = devModel as string
        if (qaModel    !== undefined) rooms[id].qaModel    = qaModel as string
        if (archCli !== undefined && validClis.includes(archCli as string)) rooms[id].archCli = archCli as string
        if (devCli  !== undefined && validClis.includes(devCli  as string)) rooms[id].devCli  = devCli  as string
        if (qaCli   !== undefined && validClis.includes(qaCli   as string)) rooms[id].qaCli   = qaCli   as string
        const p = parsed as { pinned?: unknown; opened?: unknown; order?: unknown }
        if (p.pinned  !== undefined) rooms[id].pinned  = !!(p.pinned)
        if (p.opened  !== undefined) rooms[id].opened  = !!(p.opened)
        if (p.order   !== undefined) rooms[id].order   = Number(p.order)
        rooms[id].updatedAt = Date.now()
        saveRooms()
        json({ ok: true, room: rooms[id] }); return
      }

      // Close a tab: mark opened=false AND kill its backend terminals.
      const closeMatch = url.pathname.match(/^\/rooms\/([^/]+)\/close$/)
      if (req.method === 'POST' && closeMatch) {
        const id = closeMatch[1]
        if (!rooms[id]) { json({ error: 'Room not found' }, 404); return }
        rooms[id].opened = false
        rooms[id].updatedAt = Date.now()
        for (const role of ['arch', 'dev', 'qa']) {
          const termId = `${id}-${role}`
          if (ptys[termId]) { try { ptys[termId].proc.kill() } catch {}; delete ptys[termId] }
        }
        saveRooms()
        broadcast({ type: 'room_closed', roomId: id })
        json({ ok: true }); return
      }

      // Batch update tab layout (drag-reorder / group change).
      // Body: [{id, pinned, order}]  — one saveRooms at the end to avoid race.
      if (req.method === 'POST' && url.pathname === '/tabs/layout') {
        const updates = parsed as { id: string; pinned: boolean; order: number }[]
        if (!Array.isArray(updates)) { json({ error: 'expected array' }, 400); return }
        for (const { id, pinned, order } of updates) {
          if (rooms[id]) { rooms[id].pinned = !!(pinned); rooms[id].order = Number(order) }
        }
        saveRooms()
        json({ ok: true }); return
      }

      const memPutMatch = url.pathname.match(/^\/rooms\/([^/]+)\/memory$/)
      if (req.method === 'PUT' && memPutMatch) {
        const id = memPutMatch[1]
        if (!rooms[id]) { json({ error: 'Room not found' }, 404); return }
        const { content = '' } = parsed
        writeFileSync(join(ROOM_MEMORIES_DIR, `${id}.md`), content as string)
        json({ ok: true }); return
      }

      const commPutMatch = url.pathname.match(/^\/rooms\/([^/]+)\/comm$/)
      if (req.method === 'PUT' && commPutMatch) {
        const id = commPutMatch[1]
        if (!rooms[id]) { json({ error: 'Room not found' }, 404); return }
        const { commEnabled, commAdapter, commReceiveId, commReceiveIdType } = parsed
        if (commEnabled       !== undefined) rooms[id].commEnabled      = !!(commEnabled)
        if (commAdapter       !== undefined) rooms[id].commAdapter      = (commAdapter as string) || null
        if (commReceiveId     !== undefined) rooms[id].commReceiveId    = commReceiveId as string
        if (commReceiveIdType !== undefined) rooms[id].commReceiveIdType = commReceiveIdType as string
        rooms[id].updatedAt = Date.now()
        saveRooms()
        if (rooms[id].commEnabled && rooms[id].commAdapter) startComm(rooms[id].commAdapter)
        json({ ok: true, room: rooms[id] }); return
      }

      const commSendMatch = url.pathname.match(/^\/rooms\/([^/]+)\/comm\/send$/)
      if (req.method === 'POST' && commSendMatch) {
        const id = commSendMatch[1]
        if (!rooms[id]) { json({ error: 'Room not found' }, 404); return }
        const { message } = parsed
        if (!message) { json({ error: 'message required' }, 400); return }
        if (!rooms[id].commEnabled) { json({ error: '通信未启用' }, 400); return }
        try {
          const result = await commSend(id, message as string)
          broadcast({ type: 'comm_sent', roomId: id, adapter: rooms[id].commAdapter, text: message })
          json({ ok: true, msgId: result.msgId }); return
        } catch (e) {
          json({ error: (e as Error).message }, 500); return
        }
      }

      const commConnectMatch = url.pathname.match(/^\/rooms\/([^/]+)\/comm\/(connect|feishu-start)$/)
      if (req.method === 'POST' && commConnectMatch) {
        const id = commConnectMatch[1]
        if (!rooms[id]) { json({ error: 'Room not found' }, 404); return }
        const adapter = rooms[id].commAdapter
        await stopComm(adapter)
        startComm(adapter).catch(e => console.error('[comm] reconnect error:', e))
        json({ ok: true }); return
      }

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

      const spawnMatch = url.pathname.match(/^\/rooms\/([^/]+)\/spawn$/)
      if (req.method === 'POST' && spawnMatch) {
        const id = spawnMatch[1]
        if (!rooms[id]) { json({ error: 'Room not found' }, 404); return }
        const room = rooms[id]
        const { archSessionId, devSessionId, qaSessionId, archModel, devModel, qaModel, archCli, devCli, qaCli, cols, rows } = parsed
        const validClis = Object.keys(CLI_PROFILES)
        if (archModel) rooms[id].archModel = archModel as string
        if (devModel)  rooms[id].devModel  = devModel  as string
        if (qaModel)   rooms[id].qaModel   = qaModel   as string
        if (archCli && validClis.includes(archCli as string)) rooms[id].archCli = archCli as string
        if (devCli  && validClis.includes(devCli  as string)) rooms[id].devCli  = devCli  as string
        if (qaCli   && validClis.includes(qaCli   as string)) rooms[id].qaCli   = qaCli   as string
        for (const dir of [room.archDir, room.devDir, room.qaDir]) {
          if (!dir) continue
          try { if (!statSync(dir).isDirectory()) throw new Error() }
          catch { json({ error: `Directory not found: ${dir}` }, 400); return }
        }
        const rArchCli = rooms[id].archCli || 'claude'
        const rDevCli  = rooms[id].devCli  || 'claude'
        const rQaCli   = rooms[id].qaCli   || 'claude'
        if (archSessionId) rooms[id].archSessionId = archSessionId as string
        if (devSessionId)  rooms[id].devSessionId  = devSessionId  as string
        if (qaSessionId)   rooms[id].qaSessionId   = qaSessionId   as string
        writeRoomScripts(id, room.archDir, room.devDir, rArchCli, rDevCli, rQaCli, (archSessionId as string) || null, (devSessionId as string) || null, (qaSessionId as string) || null)
        if (room.archDir) {
          spawnTerminal(`${id}-arch`, room.archDir, (archSessionId as string) || null, (cols as number) || 80, (rows as number) || 24, room.archSilent, room.archModel || 'claude-sonnet-4-6', rArchCli)
        }
        if (room.devDir) {
          spawnTerminal(`${id}-dev`,  room.devDir,  (devSessionId  as string) || null, (cols as number) || 80, (rows as number) || 24, room.devSilent,  room.devModel  || 'claude-sonnet-4-6', rDevCli)
        }
        if (room.qaDir) {
          spawnTerminal(`${id}-qa`, room.qaDir, (qaSessionId as string) || null, (cols as number) || 80, (rows as number) || 24, room.qaSilent || false, room.qaModel || 'claude-sonnet-4-6', rQaCli)
        }
        rooms[id].updatedAt = Date.now()
        saveRooms()
        const _capturingDirs = new Set<string>()
        if (!archSessionId && rArchCli === 'claude' && room.archDir) { captureNewSession(room.archDir, id, 'arch'); _capturingDirs.add(room.archDir) }
        if (!devSessionId  && rDevCli  === 'claude' && room.devDir && !_capturingDirs.has(room.devDir))  { captureNewSession(room.devDir, id, 'dev'); _capturingDirs.add(room.devDir) }
        if (!qaSessionId   && rQaCli   === 'claude' && room.qaDir && !_capturingDirs.has(room.qaDir)) captureNewSession(room.qaDir, id, 'qa')
        if (!archSessionId && rArchCli === 'kimi' && room.archDir) { captureNewKimiSession(room.archDir, id, 'arch'); _capturingDirs.add(room.archDir + ':kimi') }
        if (!devSessionId  && rDevCli  === 'kimi' && room.devDir && !_capturingDirs.has(room.devDir + ':kimi'))  { captureNewKimiSession(room.devDir, id, 'dev'); _capturingDirs.add(room.devDir + ':kimi') }
        if (!qaSessionId   && rQaCli   === 'kimi' && room.qaDir && !_capturingDirs.has(room.qaDir + ':kimi')) captureNewKimiSession(room.qaDir, id, 'qa')
        if (!archSessionId && rArchCli === 'codex' && room.archDir) captureNewCodexSession(room.archDir, id, 'arch')
        if (!devSessionId  && rDevCli  === 'codex' && room.devDir) captureNewCodexSession(room.devDir, id, 'dev')
        if (!qaSessionId   && rQaCli   === 'codex' && room.qaDir) captureNewCodexSession(room.qaDir, id, 'qa')
        json({ ok: true }); return
      }

      const restartRoleMatch = url.pathname.match(/^\/rooms\/([^/]+)\/restart-role$/)
      if (req.method === 'POST' && restartRoleMatch) {
        const id = restartRoleMatch[1]
        if (!rooms[id]) { json({ error: 'Room not found' }, 404); return }
        const { role } = parsed
        if (!['arch', 'dev', 'qa'].includes(role as string)) { json({ error: 'invalid role' }, 400); return }
        const termId  = `${id}-${role}`
        const entry   = ptys[termId]
        if (!entry?.alive) { json({ error: 'PTY not alive' }, 400); return }
        const room    = rooms[id]
        const cli     = (room as Record<string, string>)[`${role}Cli`] || 'claude'
        const profile = CLI_PROFILES[cli]
        if (!profile) { json({ error: 'unsupported cli' }, 400); return }
        const model   = (room as Record<string, string>)[`${role}Model`] || profile.defaultModel
        const promptFile = role === 'arch' ? `/tmp/arch-prompt-${id}.md` : role === 'qa' ? `/tmp/qa-prompt-${id}.md` : `/tmp/dev-prompt-${id}.md`
        if (profile.writeConfig) profile.writeConfig(promptFile, id, role as string)
        let sessionId: string | null = (parsed.sessionId !== undefined ? parsed.sessionId : null) as string | null
        if (sessionId === undefined || sessionId === null) {
          if (cli === 'gemini') sessionId = 'latest'
          else if (cli === 'codex') sessionId = 'last'
          else if (cli === 'kimi') sessionId = (room as Record<string, string>)[`${role}SessionId`] || 'last'
          else sessionId = (room as Record<string, string>)[`${role}SessionId`] || null
        }
        const cmd = profile.buildCmd(model, promptFile, sessionId, false, role as string)
        if (entry._quotaRetryTimer) { clearTimeout(entry._quotaRetryTimer); entry._quotaRetryTimer = null; entry._quotaRetryAt = null; entry._quotaExceeded = false }
        entry.proc.write('\x03')
        setTimeout(() => {
          if (!entry.alive || ptys[termId] !== entry) return
          entry._kimiExited = false
          entry.proc.write(cmd + '\r')
          broadcast({ type: 'agent_restarted', termId, roomId: id, role })
        }, 500)
        json({ ok: true }); return
      }

      const inboxClearMatch = url.pathname.match(/^\/rooms\/([^/]+)\/inbox\/clear$/)
      if (req.method === 'POST' && inboxClearMatch) {
        const id = inboxClearMatch[1]
        if (!rooms[id]) { json({ error: 'Room not found' }, 404); return }
        const { role } = parsed
        const roles = role === 'all' ? ['arch', 'dev', 'qa'] : [role as string]
        let cleared = 0
        for (const r of roles) {
          const box = inboxes[`${id}-${r}`]
          if (box?.queue.length) { cleared += box.queue.length; box.queue.length = 0 }
        }
        broadcast({ type: 'inbox_cleared', roomId: id, role, cleared })
        json({ ok: true, cleared }); return
      }

      const quotaRetryMatch = url.pathname.match(/^\/rooms\/([^/]+)\/adjust-quota-retry$/)
      if (req.method === 'POST' && quotaRetryMatch) {
        const id = quotaRetryMatch[1]
        const room = rooms[id]
        if (!room) { json({ error: 'Room not found' }, 404); return }
        const { role, delayMs } = parsed
        if (!role) { json({ error: 'role required' }, 400); return }
        const termId = `${id}-${role}`
        const entry = ptys[termId]
        if (!entry?.alive) { json({ error: 'terminal not alive' }, 400); return }
        if (!entry._quotaExceeded) { json({ error: 'no active quota limit for this role' }, 400); return }
        const ms = Math.max(0, parseInt(String(delayMs)) || 0)
        if (ms === 0) {
          if (entry._quotaRetryTimer) { clearTimeout(entry._quotaRetryTimer); entry._quotaRetryTimer = null }
          entry._quotaRetryAt = null; entry._quotaExceeded = false
          const cli     = (room as Record<string, string>)[`${role}Cli`] || 'claude'
          const profile = CLI_PROFILES[cli] ?? CLI_PROFILES.claude
          const model      = (room as Record<string, string>)[`${role}Model`] || profile.defaultModel
          const promptFile = role === 'arch' ? `/tmp/arch-prompt-${id}.md` : role === 'qa' ? `/tmp/qa-prompt-${id}.md` : `/tmp/dev-prompt-${id}.md`
          if (profile.writeConfig) profile.writeConfig(promptFile, id, role as string)
          const resumeId = cli === 'gemini' ? 'latest' : cli === 'kimi' ? ((room as Record<string, string>)[`${role}SessionId`] || 'last') : 'last'
          const cmd = profile.buildCmd(model, promptFile, resumeId, false, role as string)
          entry.proc.write('\x03')
          setTimeout(() => {
            if (!entry.alive || ptys[termId] !== entry) return
            entry.proc.write(cmd + '\r')
            broadcast({ type: 'agent_restarted', termId, roomId: id, role })
          }, 1000)
          console.log(`[${cli}] immediate retry triggered for ${termId}`)
          json({ ok: true, retryAt: null }); return
        }
        scheduleLimitRetry(termId, entry, ms)
        json({ ok: true, retryAt: entry._quotaRetryAt }); return
      }

      const watchdogMatch = url.pathname.match(/^\/rooms\/([^/]+)\/watchdog$/)
      if (req.method === 'POST' && watchdogMatch) {
        const id = watchdogMatch[1]
        if (!rooms[id]) { json({ error: 'Room not found' }, 404); return }
        const { enabled } = parsed
        if (enabled) startWatchdog(id); else stopWatchdog(id)
        json({ ok: true, enabled: !!(enabled) }); return
      }

      const switchModelMatch = url.pathname.match(/^\/rooms\/([^/]+)\/switch-model$/)
      if (req.method === 'POST' && switchModelMatch) {
        const id = switchModelMatch[1]
        if (!rooms[id]) { json({ error: 'Room not found' }, 404); return }
        const { role, model: reqModel, cli: reqCli } = parsed
        if (!role) { json({ error: 'role required' }, 400); return }
        const room = rooms[id]
        const termId = `${id}-${role}`
        const projectDir = role === 'arch' ? room.archDir : role === 'qa' ? room.qaDir : room.devDir
        const silent = role === 'arch' ? room.archSilent : role === 'qa' ? (room.qaSilent || false) : room.devSilent
        const roleCli = (reqCli as string) || (room as Record<string, string>)[`${role}Cli`] || 'claude'
        if (reqCli) (rooms[id] as Record<string, unknown>)[`${role}Cli`] = reqCli
        const profile = CLI_PROFILES[roleCli] ?? CLI_PROFILES.claude
        const model = (reqModel as string) || profile.defaultModel
        if (!projectDir) { json({ error: `No directory configured for role: ${role}` }, 400); return }
        let sessionId: string | null = null
        if (profile.supportsResume) {
          if (roleCli === 'gemini') sessionId = 'latest'
          else if (roleCli === 'codex') sessionId = 'last'
          else if (roleCli === 'kimi') sessionId = (room as Record<string, string>)[`${role}SessionId`] || 'last'
          else {
            const sessions = listSessions(projectDir)
            sessionId = sessions[0]?.sessionId || null
          }
        }
        (rooms[id] as Record<string, unknown>)[`${role}Model`] = model
        saveRooms()
        writeRoomScripts(id, room.archDir, room.devDir, rooms[id].archCli || 'claude', rooms[id].devCli || 'claude', rooms[id].qaCli || 'claude')
        spawnTerminal(termId, projectDir, sessionId, 120, 30, silent, model, roleCli)
        broadcast({ type: 'model_switched', roomId: id, role, model, cli: roleCli, sessionId: sessionId || null })
        console.log(`[switch-model] room=${id} role=${role} cli=${roleCli} model=${model} session=${sessionId}`)
        json({ ok: true, role, model, cli: roleCli, sessionId }); return
      }

      if (req.method === 'POST' && url.pathname === '/notify') {
        const { to, from: explicitFrom, roomId, message } = parsed
        if (!to || !message) { json({ error: 'to and message required' }, 400); return }
        if (!roomId) { json({ error: 'roomId required' }, 400); return }
        const toTermId = `${roomId}-${to}`
        const from = explicitFrom || (to === 'arch' ? 'dev' : 'arch')
        const priority = parsed.priority === 'urgent' ? 'urgent' : 'normal'
        if (to === 'dev') getRoomState(roomId as string).autoReviewEnabled = true
        markNotifyDelivered(roomId as string, to as string, message as string)
        inboxSend(toTermId, from as string, message as string, priority)
        json({ ok: true }); return
      }

      if (req.method === 'POST' && url.pathname === '/pty/write') {
        const { termId, text } = parsed
        const e = ptys[termId as string]
        if (!e || !e.alive) { json({ error: 'PTY not alive' }, 400); return }
        if ((text as string).includes('\n')) {
          e.proc.write('\x1b[200~' + text + '\x1b[201~')
          setTimeout(() => { if (e.alive) e.proc.write('\r') }, 200)
        } else {
          e.proc.write((text as string) + '\r')
        }
        json({ ok: true }); return
      }

      if (req.method === 'POST' && url.pathname === '/pty/kill') {
        const { termId } = parsed
        if (ptys[termId as string]) { try { ptys[termId as string].proc.kill() } catch {}; delete ptys[termId as string] }
        json({ ok: true }); return
      }

      res.writeHead(404, cors); res.end('Not found')
    })
  }
}
