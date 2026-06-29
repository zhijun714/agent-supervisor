import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { rooms } from './state.js'
import { CLI_PROFILES } from './cli-profiles.js'
import { ROOT_DIR, ROOM_MEMORIES_DIR, PORT } from './config.js'
import type { MemoryContext } from './types.js'

function extractSummary(content: string): string {
  const lines = content.split('\n')
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < Math.min(lines.length, 30); i++) {
      if (lines[i]?.trim() === '---') break
      const m = lines[i].match(/^description:\s*(.+)/)
      if (m) return m[1].trim()
    }
  }
  for (const line of lines.slice(0, 30)) {
    const m = line.match(/^#{1,3}\s+(.+)/)
    if (m) return m[1].trim()
  }
  for (const line of lines) {
    const t = line.trim()
    if (t && t !== '---') return t.length > 80 ? t.slice(0, 77) + '...' : t
  }
  return ''
}

function aiDocsManifest(dir: string | null): string {
  if (!dir) return ''
  try {
    const docsDir = join(dir, 'ai-docs')
    const files = readdirSync(docsDir).filter(f => f.endsWith('.md'))
    if (!files.length) return ''
    const lines = files.map(f => {
      const absPath = join(docsDir, f)
      const summary = extractSummary(readFileSync(absPath, 'utf8'))
      return summary ? `${absPath} — ${summary}` : absPath
    })
    return lines.join('\n') + '\n\n（需要细节时用 Read 读对应文件路径，以实际内容为准；本清单为 spawn 时快照，若 ai-docs/ 中途有新增或删改，可用 Glob/ls 重新列目录再 Read。）'
  } catch { return '' }
}

export function buildMemoryContext(roomId: string, archDir: string | null, devDir: string | null): MemoryContext {
  let roomMem = ''
  try { roomMem = readFileSync(join(ROOM_MEMORIES_DIR, `${roomId}.md`), 'utf8') } catch {}
  const archDocs = aiDocsManifest(archDir)
  const devDocs  = archDir === devDir ? archDocs : aiDocsManifest(devDir)
  const block = (title: string, body: string) => body ? `## ${title}\n\n${body}` : ''
  const sharedDocs = archDir === devDir
    ? [block('项目文档索引', archDocs)]
    : [block('项目文档索引（架构师目录）', archDocs), block('项目文档索引（开发目录）', devDocs)]
  const shared = [block('Room 记忆', roomMem), ...sharedDocs].filter(Boolean).join('\n\n')
  const ctxReminder = devDir && !existsSync(join(devDir, 'CONTEXT.md'))
    ? block('📝 提醒', '本项目根目录无 CONTEXT.md（领域术语表）。涉及设计/命名时，请先用 domain-modeling 技能起一份种子 CONTEXT.md 再继续，避免术语漂移。')
    : ''
  return {
    archCtx: [shared, ctxReminder].filter(Boolean).join('\n\n'),
    devCtx:  [shared, ctxReminder].filter(Boolean).join('\n\n'),
    qaCtx:   [block('Room 记忆', roomMem), block('项目文档索引（开发目录）', devDocs)].filter(Boolean).join('\n\n'),
  }
}

export function writeRoomScripts(
  roomId: string,
  archDir: string | null,
  devDir: string | null,
  archCli = 'claude',
  devCli = 'claude',
  qaCli = 'claude',
  archSessionId: string | null = null,
  devSessionId: string | null = null,
  qaSessionId: string | null = null,
): void {
  const arch_p = CLI_PROFILES[archCli] ?? CLI_PROFILES.claude
  const dev_p  = CLI_PROFILES[devCli]  ?? CLI_PROFILES.claude
  const qa_p   = CLI_PROFILES[qaCli]   ?? CLI_PROFILES.claude

  const makeScript = (toId: string, fromId: string, label: string, priority = 'normal') => `#!/bin/bash
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

  const makeSwitchScript = (roleId: string, defaultModel: string) => `#!/bin/bash
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
    const archScript          = `/tmp/notify-${roomId}-arch.sh`
    const archFromQaScript    = `/tmp/notify-${roomId}-arch-from-qa.sh`
    const devScript           = `/tmp/notify-${roomId}-dev.sh`
    const devUrgentScript     = `/tmp/notify-${roomId}-dev-urgent.sh`
    const qaScript            = `/tmp/notify-${roomId}-qa.sh`
    const qaUrgentScript      = `/tmp/notify-${roomId}-qa-urgent.sh`
    const switchArchScript    = `/tmp/switch-model-${roomId}-arch.sh`
    const switchDevScript     = `/tmp/switch-model-${roomId}-dev.sh`
    const switchQaScript      = `/tmp/switch-model-${roomId}-qa.sh`
    const memoryScript        = `/tmp/update-room-memory-${roomId}.sh`
    const notifyUserScript    = `/tmp/notify-user-${roomId}.sh`

    writeFileSync(archScript,       makeScript('arch', 'dev',  'Product Architect'),        { mode: 0o755 })
    writeFileSync(archFromQaScript, makeScript('arch', 'qa',   'Product Architect'),        { mode: 0o755 })
    writeFileSync(devScript,        makeScript('dev',  'arch', 'Developer'),                { mode: 0o755 })
    writeFileSync(devUrgentScript,  makeScript('dev',  'arch', 'Developer',  'urgent'),     { mode: 0o755 })
    writeFileSync(qaScript,         makeScript('qa',   'arch', 'QA Engineer'),              { mode: 0o755 })
    writeFileSync(qaUrgentScript,   makeScript('qa',   'arch', 'QA Engineer', 'urgent'),    { mode: 0o755 })
    writeFileSync(switchArchScript, makeSwitchScript('arch', arch_p.defaultModel), { mode: 0o755 })
    writeFileSync(switchDevScript,  makeSwitchScript('dev',  dev_p.defaultModel),  { mode: 0o755 })
    writeFileSync(switchQaScript,   makeSwitchScript('qa',   qa_p.defaultModel),   { mode: 0o755 })
    writeFileSync(memoryScript, `#!/bin/bash
timestamp=$(date '+%Y-%m-%d %H:%M:%S')
message=$(cat)
[ -z "$message" ] && exit 1
printf '[%s] %s\\n' "$timestamp" "$message" >> "${ROOM_MEMORIES_DIR}/${roomId}.md"
echo "ok - memory updated"`, { mode: 0o755 })
    writeFileSync(notifyUserScript, `#!/bin/bash
message=$(cat)
[ -z "$message" ] && { echo "No message provided" >&2; exit 1; }
python3 -c '
import json, http.client, sys
msg = sys.argv[1]
conn = http.client.HTTPConnection("localhost", ${PORT})
body = json.dumps({"message": msg})
conn.request("POST", "/rooms/${roomId}/comm/send", body, {"Content-Type": "application/json"})
r = conn.getresponse(); text = r.read().decode()
print("ok - user notified" if r.status == 200 else ("fail - " + text))
' "$message"`, { mode: 0o755 })

    const { archCtx, devCtx, qaCtx } = buildMemoryContext(roomId, archDir, devDir)
    const memBlock = (ctx: string) => ctx ? `\n\n---\n\n## 上下文记忆（Spawn 时注入）\n\n${ctx}\n\n---\n` : ''

    const archModelHints = arch_p.models.join(', ')
    const devModelHints  = dev_p.models.join(', ')
    const qaModelHints   = qa_p.models.join(', ')
    const archScriptInfo = `\n\n---\n_Supervisor scripts — 必须用 Bash 工具执行，不能写成文字 (room: ${roomId}):_\n` +
      `消息通知 **[每条都必须用 Bash 工具执行]**：\n` +
      `- 普通消息给开发者: \`echo "..." | ${devScript}\`\n` +
      `- 紧急纠正给开发者（跳过队列）: \`echo "..." | ${devUrgentScript}\`\n` +
      `- 普通消息给QA工程师: \`echo "..." | ${qaScript}\`\n` +
      `- 紧急消息给QA工程师: \`echo "..." | ${qaUrgentScript}\`\n` +
      `模型切换：\n` +
      `- 切换自己的模型: \`${switchArchScript} <model>\`\n` +
      `- 切换开发者的模型: \`${switchDevScript} <model>\`\n` +
      `- 切换QA的模型: \`${switchQaScript} <model>\`\n` +
      `可用模型: ${archModelHints}\n` +
      `- 记录关键决策: \`echo "..." | ${memoryScript}\`\n` +
      `- 通知用户（通过已配置的通信渠道）: \`echo "..." | ${notifyUserScript}\`\n` +
      `- 或在终端输出以 [通知] 开头的行，Supervisor 会自动转发（如：[通知] 任务完成，请查看）\n`
    const devScriptInfo = `\n\n---\n_Supervisor scripts — 必须用 Bash 工具执行，不能写成文字 (room: ${roomId}):_\n` +
      `- 发消息给产品架构师 **[用 Bash 工具执行]**: \`echo "..." | ${archScript}\`\n` +
      `- 升级/切换自己的模型: \`${switchDevScript} <model>\`\n` +
      `可用模型: ${devModelHints}\n` +
      `- 记录关键决策: \`echo "..." | ${memoryScript}\`\n`
    const qaScriptInfo = `\n\n---\n_Supervisor scripts — 必须用 Bash 工具执行，不能写成文字 (room: ${roomId}):_\n` +
      `- 发报告给产品架构师 **[用 Bash 工具执行]**: \`echo "..." | ${archFromQaScript}\`\n` +
      `- 升级/切换自己的模型: \`${switchQaScript} <model>\`\n` +
      `可用模型: ${qaModelHints}\n` +
      `- 记录关键决策: \`echo "..." | ${memoryScript}\`\n`

    const room = rooms[roomId]
    const archBase = readFileSync(join(ROOT_DIR, 'prompts', 'arch.md'), 'utf8')
    const devBase  = readFileSync(join(ROOT_DIR, 'prompts', 'dev.md'),  'utf8')
    const qaBase   = readFileSync(join(ROOT_DIR, 'prompts', 'qa.md'),   'utf8')

    const archContent = archBase
      .replace(/\/tmp\/notify-dev\.sh/g,          devScript)
      .replace(/\/tmp\/notify-dev-urgent\.sh/g,   devUrgentScript)
      .replace(/\/tmp\/notify-qa\.sh/g,           qaScript)
      .replace(/\/tmp\/notify-qa-urgent\.sh/g,    qaUrgentScript)
      .replace(/<switch-model-arch-script>/g,     switchArchScript)
      .replace(/<switch-model-dev-script>/g,      switchDevScript)
      .replace(/<switch-model-qa-script>/g,       switchQaScript)
      .replace(/<update-room-memory-script>/g,    memoryScript)
      .replace(/<notify-user-script>/g,           notifyUserScript)
      .replace(/<archDir>/g,                      archDir || '')
      .replace(/<devDir>/g,                       devDir || '')
      .replace(/<roomId>/g,                       roomId)
    const devContent = devBase
      .replace(/\/tmp\/notify-arch\.sh/g,         archScript)
      .replace(/<switch-model-dev-script>/g,      switchDevScript)
      .replace(/<update-room-memory-script>/g,    memoryScript)
      .replace(/<archDir>/g,                      archDir || '')
      .replace(/<devDir>/g,                       devDir || '')
      .replace(/<roomId>/g,                       roomId)
    const qaContent = qaBase
      .replace(/\/tmp\/notify-arch-from-qa\.sh/g, archFromQaScript)
      .replace(/<switch-model-qa-script>/g,       switchQaScript)
      .replace(/<update-room-memory-script>/g,    memoryScript)
      .replace(/<devDir>/g,                       devDir || '')
      .replace(/<roomId>/g,                       roomId)

    // Inject room memory context only for new sessions (not resumes)
    const archResume = archSessionId ?? room?.archSessionId
    const devResume  = devSessionId  ?? room?.devSessionId
    const qaResume   = qaSessionId   ?? room?.qaSessionId
    writeFileSync(`/tmp/arch-prompt-${roomId}.md`, archContent + (archResume ? '' : memBlock(archCtx)) + archScriptInfo)
    writeFileSync(`/tmp/dev-prompt-${roomId}.md`,  devContent  + (devResume  ? '' : memBlock(devCtx))  + devScriptInfo)
    writeFileSync(`/tmp/qa-prompt-${roomId}.md`,   qaContent   + (qaResume   ? '' : memBlock(qaCtx))   + qaScriptInfo)
  } catch(e) { console.error('[writeRoomScripts]', e) }
}
