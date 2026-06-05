import { PersistentClaudeSession } from '@enderfga/claw-orchestrator'

const MODEL = 'claude-sonnet-4-6'

let architect = null
let developer = null
let devMeta = { status: 'idle', buffer: '', turns: 0, corrections: [] }

let _broadcast = null
export function setBroadcast(fn) { _broadcast = fn }
function emit(type, data) { _broadcast?.({ type, ...data }) }

// ── ARCHITECT ─────────────────────────────────────────────────────────────────

const ARCHITECT_PROMPT = `You are a software architect supervising a developer agent.

CRITICAL RULES:
- You are READ-ONLY. You CANNOT write, edit, or create any files.
- You CANNOT run shell commands that modify anything.
- ALL code changes MUST be done by the developer via [TASK]...[/TASK].

Your job:
1. Understand requirements through conversation (read ai-docs/ for context)
2. When ready, delegate to the developer: [TASK] <clear task description> [/TASK]
3. After each developer turn, review progress and decide to intervene or not
4. Answer user questions at any time

You have READ access to \${projectDir}/ai-docs/ for specs and standards.

When reviewing developer output:
- Reply [INTERVENE: YES]\\n<specific correction> to correct the developer
- Reply [INTERVENE: NO] if progress is fine

Remember: you ONLY plan and review. The developer does ALL the coding.`

// Explicitly block all write/execute tools for architect
const ARCHITECT_DISALLOWED = ['Write', 'Edit', 'Bash', 'Task', 'NotebookEdit', 'MultiEdit']

export async function startArchitect(projectDir, resumeSessionId) {
  if (architect) { try { await architect.stop() } catch {} }
  architect = new PersistentClaudeSession({
    model: MODEL,
    cwd: projectDir,
    permissionMode: 'acceptEdits',
    disallowedTools: ARCHITECT_DISALLOWED,
    additionalDirs: [projectDir + '/ai-docs'],
    systemPrompt: ARCHITECT_PROMPT.replace('${projectDir}', projectDir),
    ...(resumeSessionId ? { claudeResumeId: resumeSessionId } : {}),
  })
  await architect.start()
  emit('architect_ready', { projectDir, resumed: !!resumeSessionId, sessionId: resumeSessionId })
}

export async function chatWithArchitect(userMessage, projectDir) {
  if (!architect) await startArchitect(projectDir || process.cwd())
  const result = await architect.send(userMessage, { waitForComplete: true })
  const reply = typeof result === 'string' ? result : (result?.text || '')

  // Check if architect issued a task to developer
  const taskMatch = reply.match(/\[TASK\]([\s\S]*?)\[\/TASK\]/m)
  if (taskMatch) {
    const task = taskMatch[1].trim()
    const cleanReply = reply.replace(/\[TASK\][\s\S]*?\[\/TASK\]/m, '').trim()
    // Start developer in background
    startDeveloper(task, projectDir || process.cwd())
    return cleanReply || 'Starting developer on the task...'
  }
  return reply
}

// ── DEVELOPER ─────────────────────────────────────────────────────────────────

const DEV_PROMPT = `You are a skilled full-stack developer. You implement tasks assigned by the architect.

IMPORTANT:
1. Read \${projectDir}/ai-docs/ for specs and standards BEFORE writing any code
2. Follow all specifications found there strictly
3. Work methodically: read specs → implement → verify → report

After completing each step, report what you did clearly so the architect can review.
If you receive an [ARCHITECT] correction, address it immediately.`

export async function startDeveloper(task, projectDir, resumeSessionId) {
  if (developer) { try { await developer.stop() } catch {} }
  devMeta = { status: 'running', buffer: '', turns: 0, corrections: [] }

  developer = new PersistentClaudeSession({
    model: MODEL,
    cwd: projectDir,
    permissionMode: 'acceptEdits',
    additionalDirs: [projectDir + '/ai-docs'],
    systemPrompt: DEV_PROMPT.replace('${projectDir}', projectDir),
    ...(resumeSessionId ? { claudeResumeId: resumeSessionId } : {}),
  })

  developer.on('text', (chunk) => {
    devMeta.buffer += chunk
    if (devMeta.buffer.length > 10000) devMeta.buffer = devMeta.buffer.slice(-10000)
    emit('dev_output', { chunk })
  })

  await developer.start()
  emit('dev_started', { task, resumed: !!resumeSessionId })

  // If resuming without a task, just reconnect — don't send a new message
  if (!task) { devMeta.status = 'idle'; return }

  ;(async () => {
    try {
      const result = await developer.send(task, { waitForComplete: true })
      devMeta.turns++
      devMeta.status = 'idle'
      emit('dev_done', { turn: devMeta.turns })
      // Notify architect
      notifyArchitect()
    } catch (e) {
      devMeta.status = 'error'
      emit('dev_error', { error: e.message })
    }
  })()
}

export async function sendToDeveloper(message) {
  if (!developer) throw new Error('Developer not started')
  devMeta.status = 'running'
  emit('dev_output', { chunk: '\n[User]: ' + message + '\n' })

  ;(async () => {
    try {
      await developer.send(message, { waitForComplete: true })
      devMeta.turns++
      devMeta.status = 'idle'
      emit('dev_done', { turn: devMeta.turns })
      notifyArchitect()
    } catch (e) {
      devMeta.status = 'error'
      emit('dev_error', { error: e.message })
    }
  })()
}

async function notifyArchitect() {
  if (!architect || !devMeta.buffer) return
  try {
    const review = await architect.send(
      '[DEV PROGRESS - Turn ' + devMeta.turns + ']\n' + devMeta.buffer.slice(-3000),
      { waitForComplete: true }
    )
    const text = typeof review === 'string' ? review : (review?.text || '')
    emit('architect_review', { text })

    if (text.includes('[INTERVENE: YES]')) {
      const correction = text.split('[INTERVENE: YES]')[1]?.trim() || 'Please correct your approach.'
      devMeta.corrections.push(correction)
      emit('architect_intervened', { correction })
      await sendToDeveloper('[ARCHITECT]: ' + correction)
    }
  } catch {}
}

export async function stopAll() {
  if (architect) { try { await architect.stop() } catch {} architect = null }
  if (developer) { try { await developer.stop() } catch {} developer = null }
}

export function getStatus() {
  return { architectReady: !!architect, devStatus: devMeta.status, devTurns: devMeta.turns }
}
