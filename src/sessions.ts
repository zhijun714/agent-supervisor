import { readFileSync, readdirSync, statSync, appendFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { rooms } from './state.js'
import { broadcast } from './state.js'
import { saveRooms } from './persistence.js'
import { encodePath } from './utils.js'
import { SESSION_POLL_MAX_ATTEMPTS, SESSION_POLL_INTERVAL_MS, SESSION_POLL_INITIAL_MS } from './constants.js'
import type { Session } from './types.js'

export function listSessions(projectDir: string): Session[] {
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
            const d = JSON.parse(line) as { type?: string; lastPrompt?: string; message?: { content?: unknown }; uuid?: string; timestamp?: string }
            if (d.type === 'last-prompt') lastPrompt = (d.lastPrompt as string) || ''
            if (d.type === 'user' && !firstPrompt) {
              const content = d.message?.content
              if (typeof content === 'string' && content.trim()) firstPrompt = content.slice(0, 120)
              else if (Array.isArray(content)) {
                const txt = content.find((c: { type?: string; text?: string }) => c.type === 'text' && c.text?.trim())
                if (txt) firstPrompt = (txt as { text: string }).text.slice(0, 120)
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

export function listKimiSessions(projectDir: string): Session[] {
  const indexFile = join(homedir(), '.kimi-code', 'session_index.jsonl')
  try {
    const lines = readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean)
    const sessions: Session[] = []
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { workDir?: string; sessionId?: string; sessionDir?: string }
        if (entry.workDir !== projectDir) continue
        let title = '', mtime = 0
        try {
          const state = JSON.parse(readFileSync(join(entry.sessionDir!, 'state.json'), 'utf8')) as { title?: string; updatedAt?: string }
          title = state.title || ''
          if (state.updatedAt) mtime = new Date(state.updatedAt).getTime()
        } catch {}
        sessions.push({ sessionId: entry.sessionId!, firstPrompt: title, lastPrompt: title, lastTs: mtime || null })
      } catch {}
    }
    return sessions.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
  } catch { return [] }
}

export function loadSessionHistory(projectDir: string, sessionId: string): Array<{ role: string; text: string; uuid?: string; ts?: number }> {
  const encoded = encodePath(projectDir)
  const file = join(homedir(), '.claude', 'projects', encoded, sessionId + '.jsonl')
  const messages: Array<{ role: string; text: string; uuid?: string; ts?: number }> = []
  try {
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    for (const line of lines) {
      try {
        const d = JSON.parse(line) as { type?: string; message?: { content?: unknown }; uuid?: string; timestamp?: string }
        if (d.type === 'user') {
          const content = d.message?.content
          let text = ''
          if (typeof content === 'string') text = content
          else if (Array.isArray(content)) text = (content as Array<{ type?: string; text?: string }>).filter(c => c.type === 'text').map(c => c.text).join('')
          if (text.trim()) messages.push({ role: 'user', text: text.trim() })
        } else if (d.type === 'assistant') {
          const content = d.message?.content
          if (Array.isArray(content)) {
            const text = (content as Array<{ type?: string; text?: string }>).filter(c => c.type === 'text').map(c => c.text).join('')
            if (text.trim()) messages.push({ role: 'assistant', text: text.trim(), uuid: d.uuid, ts: d.timestamp ? new Date(d.timestamp).getTime() : 0 })
          }
        }
      } catch {}
    }
  } catch {}
  return messages
}

function findCodexSessionFile(sessionId: string): string | null {
  const sessionsDir = join(homedir(), '.codex', 'sessions')
  const scan = (dir: string): string | null => {
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name)
        if (e.isDirectory()) { const r = scan(full); if (r) return r }
        else if (e.isFile() && e.name.includes(sessionId)) return full
      }
    } catch {}
    return null
  }
  return scan(sessionsDir)
}

export function listCodexSessions(projectDir: string): Session[] {
  const indexFile = join(homedir(), '.codex', 'session_index.jsonl')
  const sessionsDir = join(homedir(), '.codex', 'sessions')
  const results: Session[] = []
  const seenIds = new Set<string>()

  try {
    const entries = readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) as { id?: string; thread_name?: string; updated_at?: string } } catch { return null } }).filter(Boolean)
    for (const entry of entries as Array<{ id?: string; thread_name?: string; updated_at?: string }>) {
      if (!entry.id || seenIds.has(entry.id)) continue
      const file = findCodexSessionFile(entry.id)
      if (!file) continue
      try {
        const firstLine = readFileSync(file, 'utf8').split('\n')[0]
        const meta = JSON.parse(firstLine) as { payload?: { cwd?: string } }
        if (meta.payload?.cwd !== projectDir) continue
        seenIds.add(entry.id)
        results.push({
          sessionId: entry.id,
          firstPrompt: entry.thread_name || '',
          lastPrompt: entry.thread_name || '',
          lastTs: entry.updated_at ? new Date(entry.updated_at).getTime() : null,
        })
      } catch {}
    }
  } catch {}

  const scanForMissing = (dir: string) => {
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name)
        if (e.isDirectory()) { scanForMissing(full); continue }
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue
        try {
          const lines = readFileSync(full, 'utf8').split('\n').filter(Boolean)
          const meta = JSON.parse(lines[0]) as { type?: string; payload?: { id?: string; cwd?: string } }
          if (meta.type !== 'session_meta') continue
          const id = meta.payload?.id
          if (!id || seenIds.has(id) || meta.payload?.cwd !== projectDir) continue
          seenIds.add(id)
          let thread_name = ''
          for (const l of lines) {
            try {
              const d = JSON.parse(l) as { type?: string; payload?: { type?: string; message?: string } }
              if (d.type === 'event_msg' && d.payload?.type === 'user_message') {
                thread_name = d.payload.message?.slice(0, 80).replace(/\n/g, ' ').trim() || ''
                break
              }
            } catch {}
          }
          const lastTs = statSync(full).mtimeMs
          results.push({ sessionId: id, firstPrompt: thread_name, lastPrompt: thread_name, lastTs })
          try {
            appendFileSync(indexFile, JSON.stringify({ id, thread_name, updated_at: new Date(lastTs).toISOString() }) + '\n')
            console.log(`[codex] repaired missing index entry for session ${id}`)
          } catch {}
        } catch {}
      }
    } catch {}
  }
  scanForMissing(sessionsDir)
  return results.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
}

export function captureNewSession(dir: string, roomId: string, roleKey: string): void {
  const claudeDir = join(homedir(), '.claude', 'projects', encodePath(dir))
  let beforeFiles: Set<string>
  try { beforeFiles = new Set(readdirSync(claudeDir).filter(f => f.endsWith('.jsonl'))) } catch { beforeFiles = new Set() }
  let attempts = 0
  const poll = () => {
    attempts++
    try {
      const newFile = readdirSync(claudeDir).filter(f => f.endsWith('.jsonl')).find(f => !beforeFiles.has(f))
      if (newFile) {
        const sessionId = newFile.replace('.jsonl', '')
        if (rooms[roomId]) {
          (rooms[roomId] as Record<string, unknown>)[`${roleKey}SessionId`] = sessionId
          saveRooms()
          broadcast({ type: 'session_captured', roomId, role: roleKey, sessionId })
          console.log(`[session] captured ${roleKey} session ${sessionId} for room ${roomId}`)
        }
        return
      }
    } catch {}
    if (attempts < SESSION_POLL_MAX_ATTEMPTS) setTimeout(poll, SESSION_POLL_INTERVAL_MS)
    else console.log(`[session] gave up capturing ${roleKey} session for room ${roomId}`)
  }
  setTimeout(poll, SESSION_POLL_INITIAL_MS)
}

export function captureNewKimiSession(dir: string, roomId: string, roleKey: string): void {
  const indexFile = join(homedir(), '.kimi-code', 'session_index.jsonl')
  let beforeIds: Set<string>
  try {
    beforeIds = new Set(
      readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean)
        .map(l => { try { return (JSON.parse(l) as { sessionId?: string }).sessionId } catch { return null } }).filter((v): v is string => !!v)
    )
  } catch { beforeIds = new Set() }
  let attempts = 0
  const poll = () => {
    attempts++
    try {
      const lines = readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean)
      const found = lines.map(l => { try { return JSON.parse(l) as { workDir?: string; sessionId?: string } } catch { return null } })
        .find(e => e && e.workDir === dir && !beforeIds.has(e.sessionId!))
      if (found) {
        if (rooms[roomId]) {
          (rooms[roomId] as Record<string, unknown>)[`${roleKey}SessionId`] = found.sessionId
          saveRooms()
          broadcast({ type: 'session_captured', roomId, role: roleKey, sessionId: found.sessionId })
          console.log(`[session] captured kimi ${roleKey} session ${found.sessionId} for room ${roomId}`)
        }
        return
      }
    } catch {}
    if (attempts < SESSION_POLL_MAX_ATTEMPTS) setTimeout(poll, SESSION_POLL_INTERVAL_MS)
    else console.log(`[session] gave up capturing kimi ${roleKey} session for room ${roomId}`)
  }
  setTimeout(poll, SESSION_POLL_INITIAL_MS)
}

export function captureNewCodexSession(dir: string, roomId: string, roleKey: string): void {
  const indexFile = join(homedir(), '.codex', 'session_index.jsonl')
  let beforeIds: Set<string>
  try {
    beforeIds = new Set(
      readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean)
        .map(l => { try { return (JSON.parse(l) as { id?: string }).id } catch { return null } }).filter((v): v is string => !!v)
    )
  } catch { beforeIds = new Set() }
  let attempts = 0
  const poll = () => {
    attempts++
    try {
      const lines = readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as { id?: string }
          if (!entry.id || beforeIds.has(entry.id)) continue
          const file = findCodexSessionFile(entry.id)
          if (!file) continue
          const firstLine = readFileSync(file, 'utf8').split('\n')[0]
          const meta = JSON.parse(firstLine) as { payload?: { cwd?: string } }
          if (meta.payload?.cwd !== dir) continue
          if (rooms[roomId]) {
            (rooms[roomId] as Record<string, unknown>)[`${roleKey}SessionId`] = entry.id
            saveRooms()
            broadcast({ type: 'session_captured', roomId, role: roleKey, sessionId: entry.id })
            console.log(`[session] captured codex ${roleKey} session ${entry.id} for room ${roomId}`)
          }
          return
        } catch {}
      }
    } catch {}
    if (attempts < SESSION_POLL_MAX_ATTEMPTS) setTimeout(poll, SESSION_POLL_INTERVAL_MS)
    else console.log(`[session] gave up capturing codex ${roleKey} session for room ${roomId}`)
  }
  setTimeout(poll, SESSION_POLL_INITIAL_MS)
}
