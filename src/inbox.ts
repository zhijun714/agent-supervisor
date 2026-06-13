import { ptys, inboxes, rooms, broadcast, getRoomState } from './state.js'
import { parseTermId } from './utils.js'
import { INBOX_IDLE_MS, INBOX_IDLE_MS_RESUME, NOTIFY_DEDUP_TTL, REVIEW_COOLDOWN_MS, REVIEW_MIN_CONTENT_LEN } from './constants.js'

const _notifyDedup = new Map<string, number>()

function _ndKey(roomId: string, target: string, msg: string): string {
  let h = 0
  const s = `${roomId}:${target}:${msg.slice(0, 200)}`
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0
  return h.toString(36)
}

export function markNotifyDelivered(roomId: string, target: string, msg: string): void {
  _notifyDedup.set(_ndKey(roomId, target, msg), Date.now())
  const now = Date.now()
  for (const [k, ts] of _notifyDedup) if (now - ts > NOTIFY_DEDUP_TTL * 2) _notifyDedup.delete(k)
}

export function wasNotifyRecentlyDelivered(roomId: string, target: string, msg: string): boolean {
  const ts = _notifyDedup.get(_ndKey(roomId, target, msg))
  return !!ts && (Date.now() - ts < NOTIFY_DEDUP_TTL)
}

export function getInbox(termId: string) {
  if (!inboxes[termId]) inboxes[termId] = { queue: [], idleTimer: null }
  return inboxes[termId]
}

export function inboxDeliver(termId: string, from: string, text: string): void {
  const entry = ptys[termId]
  if (!entry?.alive) { console.log(`[inbox] deliver to ${termId} skipped: not alive`); return }
  const wrapped = `===FROM:${from}===\n${text}\n===END===`
  console.log(`[inbox] delivering to ${termId} from ${from}, len=${wrapped.length}`)
  entry.proc.write('\x1b[200~' + wrapped + '\x1b[201~')
  setTimeout(() => { if (entry.alive) entry.proc.write('\r') }, 200)
  const { roomId } = parseTermId(termId)
  broadcast({ type: 'inbox_delivered', to: termId, from, count: 1, queueLen: 0, roomId })
  if (termId.endsWith('-dev') && from === 'arch') {
    const st = getRoomState(roomId)
    st.devReviewWatermark = ptys[termId]?.textBuf.length || st.devReviewWatermark
    st.lastReviewAt = Date.now()
  }
}

export function inboxSend(to: string, from: string, text: string, priority = 'normal'): void {
  const box = getInbox(to)
  if (!box.idleTimer && ptys[to]?.alive) {
    inboxDeliver(to, from, text)
  } else {
    if (priority === 'urgent') {
      box.queue.unshift({ from, text, priority })
      const entry = ptys[to]
      if (entry?.alive) {
        entry.proc.write('\x1b')
        console.log(`[inbox] ESC sent to interrupt ${to} for urgent message`)
      }
    } else {
      box.queue.push({ from, text, priority })
    }
    const { roomId } = parseTermId(to)
    broadcast({ type: 'inbox_queued', to, from, priority, queueLen: box.queue.length, roomId })
  }
}

function interceptPrintedNotifies(termId: string, entry: (typeof ptys)[string]): void {
  if (!entry?.textBuf) return
  const { roomId, role } = parseTermId(termId)
  const prevWatermark = entry._interceptWatermark || 0
  const fullBuf = entry.textBuf
  const scanFrom = Math.max(0, fullBuf.length - Math.max(4000, fullBuf.length - prevWatermark))
  entry._interceptWatermark = fullBuf.length
  const text = fullBuf.slice(scanFrom)
  if (!text.trim()) return

  const hits: Array<{ msg: string; sfx: string }> = []
  const echoRe = /echo\s+"((?:[^"\\]|\\.)*)"\s*\|\s*\/tmp\/notify-[a-f0-9]+-([a-z]+(?:-from-qa|-urgent)?)\.sh/g
  let m: RegExpExecArray | null
  while ((m = echoRe.exec(text)) !== null) {
    hits.push({ msg: m[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\'), sfx: m[2] })
  }
  const echoSqRe = /echo\s+'([^']*)'\s*\|\s*\/tmp\/notify-[a-f0-9]+-([a-z]+(?:-from-qa|-urgent)?)\.sh/g
  while ((m = echoSqRe.exec(text)) !== null) {
    hits.push({ msg: m[1], sfx: m[2] })
  }
  const heredocRe = /cat\s+<<\s+'?EOF'?\s*\|\s*\/tmp\/notify-[a-f0-9]+-([a-z]+(?:-from-qa|-urgent)?)\.sh[^\n]*\n([\s\S]*?)\nEOF/g
  while ((m = heredocRe.exec(text)) !== null) {
    hits.push({ msg: m[2].trim(), sfx: m[1] })
  }

  for (const { msg, sfx } of hits) {
    if (!msg) continue
    const targetRole = sfx.replace(/-from-qa$/, '').replace(/-urgent$/, '')
    if (!['arch', 'dev', 'qa'].includes(targetRole)) continue
    if (wasNotifyRecentlyDelivered(roomId, targetRole, msg)) continue
    console.log(`[intercept] kimi printed-not-executed (${role}→${targetRole}): ${msg.slice(0, 80)}`)
    inboxSend(`${roomId}-${targetRole}`, role, msg)
    markNotifyDelivered(roomId, targetRole, msg)
  }
}

export function triggerArchReview(roomId: string): void {
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
  if (newContent.length < REVIEW_MIN_CONTENT_LEN) return
  st.devReviewWatermark = buf.length
  st.lastReviewAt = now
  console.log(`[review] injecting ${newContent.length} chars of new Dev output into Arch (room: ${roomId})`)
  inboxSend(archTermId, 'system', `[AUTO-REVIEW] Developer's latest activity — assess direction, intervene only if off-track:\n${newContent.slice(-2000)}`)
}

export function inboxOnIdle(termId: string): void {
  const entry = ptys[termId]
  if (entry?.resumeInterrupt) {
    entry.resumeInterrupt = false
    const { role } = parseTermId(termId)
    const roleMsg = role === 'arch'
      ? 'Wait for the user to give you a new assignment.'
      : role === 'qa'
      ? 'Wait for a new QA assignment from the Product Architect.'
      : 'Wait for a new task from the Architect.'
    const msg = `[SUPERVISOR SESSION RESTARTED]\n` +
      `This is a new Supervisor session. Your previous conversation context is still loaded, ` +
      `but you must STOP any work in progress immediately.\n` +
      `Do NOT continue previous tasks or run any commands.\n` + roleMsg
    entry.proc.write('\x1b[200~' + msg + '\x1b[201~')
    setTimeout(() => { if (entry.alive) entry.proc.write('\r') }, 200)
    return
  }
  const box = getInbox(termId)
  if (box.queue.length) {
    const pending = box.queue.splice(0)
    if (pending.length === 1) {
      inboxDeliver(termId, pending[0].from, pending[0].text)
    } else {
      const urgent = pending.filter(m => m.priority === 'urgent')
      const normal = pending.filter(m => m.priority !== 'urgent')
      const all = [...urgent, ...normal]
      const e = ptys[termId]
      if (!e?.alive) return
      const combined = all.map(m => `===FROM:${m.from}===\n${m.text}\n===END===`).join('\n\n')
      console.log(`[inbox] batch delivering ${all.length} messages to ${termId}`)
      e.proc.write('\x1b[200~' + combined + '\x1b[201~')
      setTimeout(() => { if (e.alive) e.proc.write('\r') }, 200)
      const { roomId } = parseTermId(termId)
      broadcast({ type: 'inbox_delivered', to: termId, from: 'batch', count: all.length, queueLen: 0, roomId })
      if (termId.endsWith('-dev') && all.some(m => m.from === 'arch')) {
        const st = getRoomState(roomId)
        st.devReviewWatermark = e.textBuf.length || st.devReviewWatermark
        st.lastReviewAt = Date.now()
      }
    }
    return
  }
  if (entry?.cli === 'kimi') interceptPrintedNotifies(termId, entry)
  if (termId.endsWith('-dev')) {
    const { roomId } = parseTermId(termId)
    triggerArchReview(roomId)
  }
}

export { INBOX_IDLE_MS, INBOX_IDLE_MS_RESUME }
