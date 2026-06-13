import pty from 'node-pty'
import { ptys, rooms, broadcast, getRoomState } from './state.js'
import { parseTermId, stripAnsi } from './utils.js'
import { CLI_PROFILES } from './cli-profiles.js'
import { commSend } from './comm.js'
import { inboxSend, getInbox, inboxOnIdle } from './inbox.js'
import { TEXT_BUF_MAX, RAW_BUF_MAX, INBOX_IDLE_MS, INBOX_IDLE_MS_RESUME, CODEX_QUOTA_PATTERNS, CODEX_QUOTA_RETRY_MS, TRUST_DISMISS_DEBOUNCE_MS, KIMI_QUICK_EXIT_WINDOW_MS } from './constants.js'

function parseClaudeResetMs(text: string): number | null {
  const m = text.match(/resets\s+(\d+)(?::(\d+))?\s*(am|pm)\s+\(([^)]+)\)/i)
  if (!m) return null
  const [, hourStr, minStr, ampm, tz] = m
  let resetHour = parseInt(hourStr)
  const resetMin = parseInt(minStr || '0')
  if (ampm.toLowerCase() === 'pm' && resetHour !== 12) resetHour += 12
  if (ampm.toLowerCase() === 'am' && resetHour === 12) resetHour = 0
  try {
    const parts: Record<string, string> = {}
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false
    }).formatToParts(new Date()).forEach(({ type, value }) => { parts[type] = value })
    const curMins   = parseInt(parts.hour) * 60 + parseInt(parts.minute)
    const resetMins = resetHour * 60 + resetMin
    let diffMins = resetMins - curMins
    if (diffMins <= 1) diffMins += 24 * 60
    return diffMins * 60 * 1000
  } catch (e) {
    console.warn('[claude-limit] timezone parse failed:', (e as Error).message)
    return 60 * 60 * 1000
  }
}

export function scheduleLimitRetry(termId: string, entry: (typeof ptys)[string], delayMs: number): void {
  const { roomId, role } = parseTermId(termId)
  const room = rooms[roomId]
  if (!room) return
  if (entry._quotaRetryTimer) clearTimeout(entry._quotaRetryTimer)
  const retryAt = Date.now() + delayMs
  entry._quotaRetryAt = retryAt
  const cli = (room as Record<string, string>)[`${role}Cli`] || 'claude'
  console.log(`[${cli}] limit retry scheduled for ${termId} in ${Math.round(delayMs/60000)}m`)
  broadcast({ type: 'agent_quota_exceeded', termId, roomId, role, retryAt })
  const archTermId = `${roomId}-arch`
  entry._quotaRetryTimer = setTimeout(() => {
    entry._quotaRetryTimer = null
    entry._quotaRetryAt   = null
    entry._quotaExceeded  = false
    if (!entry.alive || ptys[termId] !== entry) return
    const profile    = CLI_PROFILES[cli] ?? CLI_PROFILES.claude
    const model      = (room as Record<string, string>)[`${role}Model`] || profile.defaultModel
    const promptFile = role === 'arch' ? `/tmp/arch-prompt-${roomId}.md`
                     : role === 'qa'   ? `/tmp/qa-prompt-${roomId}.md`
                     :                   `/tmp/dev-prompt-${roomId}.md`
    if (profile.writeConfig) profile.writeConfig(promptFile, roomId, role, entry.projectDir)
    const resumeId = cli === 'gemini' ? 'latest' : cli === 'kimi' ? ((room as Record<string, string>)[`${role}SessionId`] || 'last') : 'last'
    const cmd = profile.buildCmd(model, promptFile, resumeId, false, role)
    entry.proc.write('\x03')
    setTimeout(() => {
      if (!entry.alive || ptys[termId] !== entry) return
      entry.proc.write(cmd + '\r')
      broadcast({ type: 'agent_restarted', termId, roomId, role })
      if (role !== 'arch' && ptys[archTermId]?.alive) {
        inboxSend(archTermId, 'system',
          `[SUPERVISOR] ${cli} ${role} 已自动重启，恢复上次会话，请继续之前任务。`)
      }
    }, 1000)
  }, delayMs)
}

export { scheduleLimitRetry as scheduleCodexRetry }

function handleCodexQuota(termId: string, entry: (typeof ptys)[string]): void {
  const { roomId, role } = parseTermId(termId)
  const room = rooms[roomId]
  if (!room) return
  const archTermId = `${roomId}-arch`
  scheduleLimitRetry(termId, entry, CODEX_QUOTA_RETRY_MS)
  if (role !== 'arch' && ptys[archTermId]?.alive) {
    const t = new Date(entry._quotaRetryAt!).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    inboxSend(archTermId, 'system',
      `[SUPERVISOR] Codex ${role} 额度用尽，将在 ${t} 自动重启恢复上次会话，请等待。`)
  }
}

function handleClaudeLimit(termId: string, entry: (typeof ptys)[string], resetMs: number): void {
  const { roomId, role } = parseTermId(termId)
  const room = rooms[roomId]
  if (!room) return
  const archTermId = `${roomId}-arch`
  scheduleLimitRetry(termId, entry, resetMs)
  if (role !== 'arch' && ptys[archTermId]?.alive) {
    const t = new Date(entry._quotaRetryAt!).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    inboxSend(archTermId, 'system',
      `[SUPERVISOR] Claude ${role} 达到 session 限制，将在 ${t} 自动唤醒恢复会话，请等待。`)
  }
}

function handleKimiExit(termId: string, entry: (typeof ptys)[string]): void {
  const { roomId, role } = parseTermId(termId)
  if (!entry.alive || ptys[termId] !== entry) return
  const room = rooms[roomId]
  if (!room) return
  const now = Date.now()
  const lastRestart = entry._kimiLastRestartAt || 0
  const quickExit = (now - lastRestart) < KIMI_QUICK_EXIT_WINDOW_MS
  if (quickExit) {
    entry._kimiQuickExitCount = (entry._kimiQuickExitCount || 0) + 1
  } else {
    entry._kimiQuickExitCount = 0
  }
  if ((entry._kimiQuickExitCount || 0) > 3) {
    console.log(`[kimi] ${termId} quick-exited ${entry._kimiQuickExitCount} times, giving up`)
    broadcast({ type: 'agent_exited', termId, roomId, role, restarting: false })
    const archTermId2 = `${roomId}-arch`
    if (role !== 'arch' && ptys[archTermId2]?.alive) {
      inboxSend(archTermId2, 'system',
        `[SUPERVISOR] Kimi ${role} 连续快速退出 ${entry._kimiQuickExitCount} 次，已停止自动重启。请手动检查 kimi 是否正常安装。`)
    }
    return
  }
  const sessionId = quickExit ? null : ((room as Record<string, string>)[`${role}SessionId`] || 'last')
  const resumeDesc = quickExit ? '新建会话（上次会话恢复失败）' : '自动重连上次会话'
  console.log(`[kimi] exit detected for ${termId}, restarting: ${resumeDesc}`)
  broadcast({ type: 'agent_exited', termId, roomId, role, restarting: true })
  const archTermId = `${roomId}-arch`
  if (role !== 'arch' && ptys[archTermId]?.alive) {
    inboxSend(archTermId, 'system',
      `[SUPERVISOR] Kimi ${role} 已退出（context 超限或崩溃），正在${resumeDesc}...`)
  }
  const profile = CLI_PROFILES.kimi
  const model   = (room as Record<string, string>)[`${role}Model`] || profile.defaultModel
  const promptFile = role === 'arch' ? `/tmp/arch-prompt-${roomId}.md`
                   : role === 'qa'   ? `/tmp/qa-prompt-${roomId}.md`
                   :                   `/tmp/dev-prompt-${roomId}.md`
  profile.writeConfig!(promptFile, roomId, role, entry.projectDir)
  const rawCmd = profile.buildCmd(model, promptFile, sessionId, false, role)
  entry.proc.write('\x03')
  setTimeout(() => {
    if (!entry.alive || ptys[termId] !== entry) return
    entry._kimiExited = false
    entry._kimiLastRestartAt = Date.now()
    if (!quickExit) entry._kimiQuickExitCount = 0
    entry._kimiExitMarker = `KIMI_EXITED_${Math.random().toString(36).slice(2, 10)}`
    entry.proc.write(rawCmd + `; echo ${entry._kimiExitMarker}\r`)
    broadcast({ type: 'agent_restarted', termId, roomId, role })
    if (role !== 'arch' && ptys[archTermId]?.alive) {
      inboxSend(archTermId, 'system',
        `[SUPERVISOR] Kimi ${role} 已${quickExit ? '新建会话启动' : '重连上次会话'}，请继续之前任务。`)
    }
  }, 1000)
}

export function spawnTerminal(
  termId: string,
  projectDir: string,
  sessionId: string | null,
  cols = 80,
  rows = 24,
  silent = false,
  model = 'claude-sonnet-4-6',
  cli = 'claude',
): void {
  if (ptys[termId]) {
    try { ptys[termId].proc.kill() } catch {}
    delete ptys[termId]
  }
  const { roomId, role } = parseTermId(termId)
  const profile    = CLI_PROFILES[cli] ?? CLI_PROFILES.claude
  const promptFile = role === 'arch' ? `/tmp/arch-prompt-${roomId}.md`
                   : role === 'qa'   ? `/tmp/qa-prompt-${roomId}.md`
                   :                   `/tmp/dev-prompt-${roomId}.md`

  if (profile.cleanProjectDir) profile.cleanProjectDir(projectDir)
  if (profile.writeConfig) profile.writeConfig(promptFile, roomId, role, projectDir)

  const extraEnv = profile.getEnv(promptFile, roomId, role)
  const effectiveCwd = profile.getEffectiveCwd
    ? profile.getEffectiveCwd(projectDir, roomId, role)
    : (projectDir || process.cwd())
  const proc = pty.spawn(process.env.SHELL || '/bin/zsh', [], {
    name: 'xterm-256color',
    cols: Math.max(2, cols),
    rows: Math.max(2, rows),
    cwd: effectiveCwd,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...extraEnv },
  })

  const entry: (typeof ptys)[string] = { proc, clients: new Set(), alive: true, textBuf: '', rawBuf: '', resumeInterrupt: !!sessionId, cli, projectDir }
  ptys[termId] = entry

  if (role === 'dev') {
    const st = getRoomState(roomId)
    st.devReviewWatermark = 0; st.autoReviewEnabled = false; st.lastReviewAt = 0
  }

  if (cli === 'kimi') {
    entry._kimiExitMarker = `KIMI_EXITED_${Math.random().toString(36).slice(2, 10)}`
  }
  const rawCmd = profile.buildCmd(model, promptFile, sessionId, silent, role)
  const cmd = cli === 'kimi' ? rawCmd + `; echo ${entry._kimiExitMarker}\r` : rawCmd + '\r'
  setTimeout(() => { if (ptys[termId] === entry) proc.write(cmd) }, 900)

  const trustTexts = profile.trustTexts || []
  const trustKey   = profile.trustKey   || '\r'
  let lastTrustDismissAt = 0

  proc.onData(data => {
    if (!entry.alive) return
    const strippedData = stripAnsi(data as string)
    entry.textBuf = (entry.textBuf + strippedData).slice(-TEXT_BUF_MAX)
    entry.rawBuf  = (entry.rawBuf + data).slice(-RAW_BUF_MAX)

    if (cli === 'kimi' && !entry._kimiExited && entry._kimiExitMarker && strippedData.includes(entry._kimiExitMarker)) {
      entry._kimiExited = true
      setTimeout(() => handleKimiExit(termId, entry), 2000)
    }
    if (cli === 'codex' && !entry._quotaExceeded) {
      const recent = entry.textBuf.slice(-800).toLowerCase()
      if (CODEX_QUOTA_PATTERNS.some(p => recent.includes(p))) {
        entry._quotaExceeded = true
        setTimeout(() => handleCodexQuota(termId, entry), 2000)
      }
    }
    if (cli === 'claude' && !entry._quotaExceeded) {
      const recent = entry.textBuf.slice(-800)
      if (recent.toLowerCase().includes("you've hit your session limit") || recent.toLowerCase().includes("hit your session limit")) {
        const resetMs = parseClaudeResetMs(recent) || (60 * 60 * 1000)
        entry._quotaExceeded = true
        setTimeout(() => handleClaudeLimit(termId, entry, resetMs), 2000)
      }
    }

    if (role === 'arch' && rooms[roomId]?.commEnabled && rooms[roomId]?.commAdapter) {
      entry._notifyLineBuf = (entry._notifyLineBuf || '') + strippedData.replace(/\r/g, '')
      let nlIdx: number
      while ((nlIdx = entry._notifyLineBuf.indexOf('\n')) !== -1) {
        const line = entry._notifyLineBuf.slice(0, nlIdx)
        entry._notifyLineBuf = entry._notifyLineBuf.slice(nlIdx + 1)
        const m = line.match(/\[通知\]\s*(.+)/)
        if (m && m[1].trim()) {
          commSend(roomId, m[1].trim()).catch(e => console.error('[comm-notify] auto-send failed:', (e as Error).message))
        }
      }
      if (entry._notifyLineBuf.length > 2000) entry._notifyLineBuf = entry._notifyLineBuf.slice(-2000)
    }

    const rSt = getRoomState(roomId)
    rSt.lastActivityTs[role as 'arch' | 'dev' | 'qa'] = Date.now()
    const box = getInbox(termId)
    clearTimeout(box.idleTimer ?? undefined)
    const idleDelay = entry.resumeInterrupt ? INBOX_IDLE_MS_RESUME : INBOX_IDLE_MS
    box.idleTimer = setTimeout(() => { box.idleTimer = null; inboxOnIdle(termId) }, idleDelay)

    if (trustTexts.length > 0 && Date.now() - lastTrustDismissAt > TRUST_DISMISS_DEBOUNCE_MS) {
      const recent = entry.textBuf.slice(-600)
      if (trustTexts.some(t => recent.includes(t))) {
        lastTrustDismissAt = Date.now()
        setTimeout(() => { if (entry.alive) proc.write(trustKey) }, 300)
        console.log(`[trust] auto-dismissed for ${termId} (cli=${cli})`)
      }
    }

    // Kimi arch-guard: auto-approve Bash/Read/Glob (for notify scripts),
    // auto-reject Write/Edit/Delete (arch must not touch files directly)
    if (cli === 'kimi' && role === 'arch' && !entry._kimiArchWriteBlocking) {
      const recent = entry.textBuf.slice(-800)
      const isFileModify = recent.includes('Write this file?') ||
                           recent.includes('Create this file?') ||
                           recent.includes('Edit this file?') ||
                           recent.includes('Delete this file?')
      const hasApprovalMenu = recent.includes('Approve once')

      if (isFileModify) {
        entry._kimiArchWriteBlocking = true
        console.log(`[arch-guard] blocking file-modify attempt from kimi arch ${termId}`)
        setTimeout(() => {
          if (!entry.alive) { entry._kimiArchWriteBlocking = false; return }
          proc.write('3') // 3 = Reject
          setTimeout(() => {
            entry._kimiArchWriteBlocking = false
            inboxSend(termId, 'system',
              '[SUPERVISOR] 操作已拦截：架构师角色禁止直接操作文件。你必须通过 notify 脚本将编码任务委派给开发工程师，由 Developer 来创建和修改文件。请立即运行 notify 脚本分配任务。')
          }, 800)
        }, 300)
      } else if (hasApprovalMenu) {
        // Bash / Read / Glob — approve for session so notify scripts run unblocked
        console.log(`[arch-guard] auto-approving non-file tool for kimi arch ${termId}`)
        setTimeout(() => { if (entry.alive) proc.write('2') }, 300) // 2 = Approve for session
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
