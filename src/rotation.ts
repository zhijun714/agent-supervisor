import { cfg } from './config.js'
import { getRoomState } from './state.js'
import { parseTermId } from './utils.js'
import type { PTYEntry } from './types.js'

function parseRole(termId: string): { roomId: string; role: 'arch' | 'dev' | 'qa' } | null {
  const { roomId, role } = parseTermId(termId)
  if (!['arch', 'dev', 'qa'].includes(role)) return null
  return { roomId, role: role as 'arch' | 'dev' | 'qa' }
}

/**
 * Called on every PTY data chunk. Sets rotation.ready when threshold + boundary conditions are met.
 */
export function maybeMarkRotationReady(termId: string, entry: PTYEntry): void {
  if (!cfg.rotation.enabled) return
  const parsed = parseRole(termId)
  if (!parsed) return
  const { roomId, role } = parsed
  const rs = getRoomState(roomId)
  const rot = rs.rotation[role]

  if (rot.ready) return  // already pending, wait for idle

  const now = Date.now()
  if (entry.rawBuf.length < cfg.rotation.rawBufThreshold) return

  // Respect minimum session age (skip check when spawnedAt unknown)
  if (rot.spawnedAt > 0 && (now - rot.spawnedAt) < cfg.rotation.sessionMinMs) return

  // Require at least one boundary pattern in recent output
  const recent = entry.textBuf.slice(-2000)
  if (!cfg.rotation.boundaryPatterns.some(p => recent.includes(p))) return

  rot.ready = true
  rot.pendingAt = now
  console.log(`[rotation] ${termId} marked ready (rawBuf=${entry.rawBuf.length})`)
}

/**
 * Called when a role goes idle. Executes the rotation sequence when ready:
 * inject CHECKPOINT_PROMPT → wait → capture ledger → call spawnNewSession.
 */
export async function maybeRotate(
  termId: string,
  entry: PTYEntry,
  spawnNewSession: (termId: string, ledger: string) => Promise<void>,
): Promise<void> {
  if (!cfg.rotation.enabled) return
  const parsed = parseRole(termId)
  if (!parsed) return
  const { roomId, role } = parsed
  const rs = getRoomState(roomId)
  const rot = rs.rotation[role]

  if (!rot.ready) return
  rot.ready = false  // prevent re-entry

  const CHECKPOINT_PROMPT = [
    '[SUPERVISOR] 会话上下文即将轮转。请用中文写一份 LEDGER 摘要，内容包括：',
    '1. 已完成的工作（简要）',
    '2. 当前进行中的任务和上下文',
    '3. 下一步计划',
    '4. 重要决策或约定',
    '格式：直接输出纯文本，控制在 500 字以内。',
    '写完后输出：[LEDGER_END]',
  ].join('\n')

  console.log(`[rotation] injecting CHECKPOINT_PROMPT into ${termId}`)
  entry.proc.write('\x1b[200~' + CHECKPOINT_PROMPT + '\x1b[201~')
  setTimeout(() => { if (entry.alive) entry.proc.write('\r') }, 200)

  await new Promise<void>(resolve => setTimeout(resolve, cfg.rotation.checkpointWaitMs))

  const buf = entry.textBuf
  const ledgerMarker = '[LEDGER_END]'
  const endIdx = buf.lastIndexOf(ledgerMarker)
  const ledger = endIdx >= 0
    ? buf.slice(Math.max(0, endIdx - 3000), endIdx).trim()
    : buf.slice(-2000).trim()

  rot.ledger = ledger
  console.log(`[rotation] captured ledger for ${termId} (${ledger.length} chars), spawning fresh session`)

  await spawnNewSession(termId, ledger)
}

/** Record the spawn time for a fresh session. Called by pty-manager after spawning. */
export function onSessionSpawned(termId: string): void {
  const parsed = parseRole(termId)
  if (!parsed) return
  const rs = getRoomState(parsed.roomId)
  const rot = rs.rotation[parsed.role]
  rot.spawnedAt = Date.now()
  rot.ready = false
}
