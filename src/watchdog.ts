import { ptys, broadcast, getRoomState } from './state.js'
import { inboxSend } from './inbox.js'
import { WATCHDOG_INTERVAL_MS, WATCHDOG_IDLE_THRESHOLD_MS } from './constants.js'

function runWatchdogCheck(roomId: string): void {
  const now        = Date.now()
  const st         = getRoomState(roomId)
  const archTermId = `${roomId}-arch`
  const devTermId  = `${roomId}-dev`
  const qaTermId   = `${roomId}-qa`
  const archEntry  = ptys[archTermId]
  const devEntry   = ptys[devTermId]
  const qaEntry    = ptys[qaTermId]

  if (archEntry?.alive && archEntry.textBuf.slice(-3000).split('\n').some(l => l.trim() === '[TASK_COMPLETE]')) {
    stopWatchdog(roomId)
    broadcast({ type: 'watchdog_done', roomId })
    return
  }

  const issues: Array<{ role: string; issue: string; idleMin?: number }> = []
  if (!archEntry?.alive) issues.push({ role: 'arch', issue: 'exited' })
  if (!devEntry?.alive)  issues.push({ role: 'dev',  issue: 'exited' })
  if (qaEntry && !qaEntry.alive) issues.push({ role: 'qa', issue: 'exited' })

  const aliveRoles = [
    archEntry?.alive && 'arch',
    devEntry?.alive  && 'dev',
    qaEntry?.alive   && 'qa',
  ].filter((r): r is string => !!r)

  if (aliveRoles.length > 0) {
    const mostRecentActivity = Math.max(...aliveRoles.map(r => st.lastActivityTs[r as 'arch' | 'dev' | 'qa'] || 0))
    const allIdleMs = now - mostRecentActivity
    if (allIdleMs > WATCHDOG_IDLE_THRESHOLD_MS) {
      const idleMin = Math.floor(allIdleMs / 60000)
      aliveRoles.forEach(r => issues.push({ role: r, issue: 'idle', idleMin }))
      inboxSend(archTermId, 'system',
        `[WATCHDOG] 所有角色已全部静默超过 ${idleMin} 分钟。\n` +
        `请检查当前任务状态：\n` +
        `- 如任务仍在进行，请继续指导开发者完成\n` +
        `- 如任务已全部完成，请在输出中写一行 [TASK_COMPLETE]`
      )
    }
  }

  if (issues.length > 0) {
    console.log(`[watchdog] room ${roomId} issues:`, issues.map(i => `${i.role}:${i.issue}`).join(', '))
    broadcast({ type: 'watchdog_triggered', roomId, issues })
  }
}

export function startWatchdog(roomId: string): void {
  const st = getRoomState(roomId)
  if (st.watchdogTimer) clearInterval(st.watchdogTimer)
  st.watchdogEnabled = true
  st.watchdogTimer   = setInterval(() => runWatchdogCheck(roomId), WATCHDOG_INTERVAL_MS)
  broadcast({ type: 'watchdog_status', roomId, enabled: true })
  console.log(`[watchdog] started for room ${roomId}`)
}

export function stopWatchdog(roomId: string): void {
  const st = getRoomState(roomId)
  if (st.watchdogTimer) { clearInterval(st.watchdogTimer); st.watchdogTimer = null }
  st.watchdogEnabled = false
  broadcast({ type: 'watchdog_status', roomId, enabled: false })
  console.log(`[watchdog] stopped for room ${roomId}`)
}
