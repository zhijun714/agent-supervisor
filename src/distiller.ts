import { spawnSync } from 'child_process'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { cfg } from './config.js'
import { rooms, ptys, getRoomState } from './state.js'
import { parseTermId } from './utils.js'

const DISTILLER_SYSTEM = `你是一个知识蒸馏引擎。从 AI 编程助手的工作日志中提取有价值的架构决策、编码规范、API 约定和技术约束，整理成结构化的项目文档。

规则：
- 只提取真正有价值的、会影响未来开发决策的内容
- 忽略调试过程、临时命令、错误信息、无意义的重复内容
- 输出为 Markdown 格式，适合放入 ai-docs/ 目录
- 如果没有值得记录的内容，只输出空字符串，不要任何其他文字
- 控制在 800 字以内

输出：直接输出 Markdown 或空字符串，不要前言不要解释。`

type CommSendFn = (roomId: string, text: string) => Promise<{ ok: boolean; msgId?: string }>
let _commSend: CommSendFn | null = null
export function registerCommSend(fn: CommSendFn): void { _commSend = fn }

const pendingKnowledge = new Map<string, { content: string; targetDir: string; filename: string }>()

export function getPendingKnowledge(roomId: string) {
  return pendingKnowledge.get(roomId)
}

export function approveKnowledge(roomId: string): boolean {
  const pending = pendingKnowledge.get(roomId)
  if (!pending) return false
  pendingKnowledge.delete(roomId)
  try {
    const aiDocsDir = join(pending.targetDir, 'ai-docs')
    mkdirSync(aiDocsDir, { recursive: true })
    writeFileSync(join(aiDocsDir, pending.filename), pending.content)
    const git = (args: string[]) => spawnSync('git', args, { cwd: pending.targetDir, encoding: 'utf8' })
    git(['add', join('ai-docs', pending.filename)])
    git(['commit', '-m', `docs: auto-distilled knowledge from AI session`])
    console.log(`[distiller] committed ${pending.filename} to ${pending.targetDir}`)
    return true
  } catch(e) {
    console.error('[distiller] approve error:', e)
    return false
  }
}

export function rejectKnowledge(roomId: string): void {
  pendingKnowledge.delete(roomId)
  console.log(`[distiller] knowledge rejected for room ${roomId}`)
}

export async function triggerDistiller(termId: string): Promise<void> {
  if (!cfg.distiller.enabled) return
  const { roomId, role } = parseTermId(termId)
  if (role === 'arch') return
  const room = rooms[roomId]
  if (!room) return

  const rs = getRoomState(roomId)
  const now = Date.now()
  if (now - rs.distillLastAt < cfg.distiller.debounceMs) return
  rs.distillLastAt = now

  const entry = ptys[termId]
  if (!entry?.alive) return

  const transcript = entry.textBuf.slice(-cfg.distiller.maxTransLen)
  if (transcript.length < 500) return

  let gitContext = ''
  try {
    const r = spawnSync('git', ['diff', '--stat', 'HEAD'], { cwd: room.devDir, encoding: 'utf8', timeout: 5000 })
    if (r.stdout?.trim()) gitContext = `\n\n## Git 变更统计\n\`\`\`\n${r.stdout.slice(0, 1000)}\n\`\`\``
  } catch {}

  const input = `## 工作日志\n\n${transcript}${gitContext}`
  console.log(`[distiller] running claude -p for ${termId}, len=${transcript.length}`)

  try {
    const result = spawnSync(
      'claude',
      ['-p', '--system', DISTILLER_SYSTEM, '--output-format', 'text'],
      { input, encoding: 'utf8', timeout: 90_000, env: { ...process.env } }
    )

    const output = (result.stdout || '').trim()
    if (result.status !== 0 || !output || output.length < 50) {
      console.log(`[distiller] no useful output for ${termId} (status=${result.status}, len=${output.length})`)
      return
    }

    const datePart = new Date().toISOString().slice(0, 10)
    const randPart = Math.random().toString(36).slice(2, 6)
    const filename = `distilled-${datePart}-${randPart}.md`
    const content = `# 知识蒸馏 — ${datePart}\n\n${output}\n`

    pendingKnowledge.set(roomId, { content, targetDir: room.devDir, filename })

    if (_commSend && room.commEnabled && room.commAdapter) {
      try {
        await _commSend(roomId,
          `[知识蒸馏] 以下内容准备写入 \`ai-docs/${filename}\`，回复 "ok" 确认提交，其他内容取消：\n\n${output.slice(0, 800)}`)
        console.log(`[distiller] sent knowledge gate for room ${roomId}`)
        return
      } catch(e) {
        console.error('[distiller] comm gate error:', e)
      }
    }

    // No comm gate — auto-approve
    approveKnowledge(roomId)
  } catch(e) {
    console.error('[distiller] error:', e)
  }
}
