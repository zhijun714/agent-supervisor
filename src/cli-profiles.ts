import { readFileSync, mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { CliProfile } from './types.js'

export const CLI_PROFILES: Record<string, CliProfile> = {
  claude: {
    buildCmd: (model, promptFile, sessionId, silent, role) => {
      const parts = ['claude', '--model', model]
      if (role === 'arch') parts.push('--disallowedTools', 'Write,Edit,MultiEdit,NotebookEdit,Task')
      parts.push('--append-system-prompt-file', promptFile)
      if (silent) parts.push('--dangerously-skip-permissions')
      if (sessionId) parts.push('--resume', sessionId)
      return parts.join(' ')
    },
    getEnv: (_promptFile, _roomId, _role) => ({}),
    writeConfig: null,
    supportsResume: true,
    trustTexts: ['Do you trust the files', 'MCP server'],
    trustKey: '\r',
    models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5-20251001'],
    defaultModel: 'claude-sonnet-4-6',
  },
  gemini: {
    buildCmd: (model, _promptFile, sessionId, _silent, _role) => {
      const parts = ['gemini']
      if (model) parts.push('-m', model)
      if (sessionId) parts.push('-r', sessionId)
      return parts.join(' ')
    },
    getEnv: (promptFile, _roomId, _role) => ({ GEMINI_SYSTEM_MD: promptFile }),
    writeConfig: null,
    supportsResume: true,
    trustTexts: ['Open documentation', 'Would you like to enable'],
    trustKey: 'D\r',
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-3-pro-preview', 'gemini-3.1-pro-preview'],
    defaultModel: 'gemini-2.5-flash',
  },
  codex: {
    buildCmd: (_model, _promptFile, sessionId, _silent, _role) => {
      const parts = sessionId === 'last'  ? ['codex', 'resume', '--last']
                  : sessionId             ? ['codex', 'resume', sessionId]
                  :                         ['codex']
      if (_model) parts.push('-m', _model)
      return parts.join(' ')
    },
    getEnv: (_promptFile, roomId, role) => ({
      XDG_CONFIG_HOME: `/tmp/codex-cfg-${roomId}-${role}`,
    }),
    writeConfig: (promptFile, roomId, role) => {
      const cfgDir = `/tmp/codex-cfg-${roomId}-${role}/codex`
      mkdirSync(cfgDir, { recursive: true })
      writeFileSync(`${cfgDir}/config.toml`, `model_instructions_file = "${promptFile}"\n`)
    },
    supportsResume: true,
    trustTexts: ['Allow', 'trust this directory'],
    trustKey: '\r',
    models: ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.4-mini', 'o4-mini', 'o3'],
    defaultModel: 'gpt-5.5',
  },
  kimi: {
    buildCmd: (model, promptFile, sessionId, silent, role) => {
      const roomId = promptFile.match(/\/tmp\/\w+-prompt-(.+)\.md$/)?.[1] ?? 'unknown'
      const skillsDir = `/tmp/kimi-skills-${roomId}-${role}`
      const parts = ['kimi', '--skills-dir', skillsDir]
      if (model) parts.push('-m', model)
      if (sessionId === 'last' || sessionId === 'latest') {
        parts.push('-C')
      } else if (sessionId) {
        parts.push('-S', sessionId)
      } else if (silent) {
        parts.push('--yolo')
      }
      return parts.join(' ')
    },
    getEnv: () => ({}),
    writeConfig: (promptFile, roomId, role, projectDir) => {
      const skillsDir = `/tmp/kimi-skills-${roomId}-${role}`
      mkdirSync(skillsDir, { recursive: true })
      const content = readFileSync(promptFile, 'utf8')
      writeFileSync(join(skillsDir, 'SKILL.md'),
        `---\nname: supervisor-${role}-${roomId}\ndescription: Your role definition and workflow for this Supervisor session\nwhenToUse: "at the start of every session and before every response"\n---\n\n${content}`)
      // Write AGENTS.md to a role-isolated home dir to avoid cross-role contamination
      // when multiple roles share the same projectDir
      const kimiHome = `/tmp/kimi-home-${roomId}-${role}`
      const agentsDir = join(kimiHome, '.kimi-code')
      mkdirSync(agentsDir, { recursive: true })
      // For dev/qa, prepend the project dir so Kimi knows where to work
      const projectNote = (role !== 'arch' && projectDir)
        ? `> **Working Directory**: \`${projectDir}\` — run \`cd ${projectDir}\` at session start before any file operations.\n\n`
        : ''
      writeFileSync(join(agentsDir, 'AGENTS.md'), projectNote + content)
    },
    cleanProjectDir: (projectDir) => {
      // Remove any stale AGENTS.md left in the project dir by older versions
      try { unlinkSync(join(projectDir, '.kimi-code', 'AGENTS.md')) } catch {}
    },
    // Arch uses isolated home dir (no project file access needed).
    // Dev/QA use projectDir but their AGENTS.md includes a cd instruction.
    getEffectiveCwd: (projectDir, roomId, role) =>
      role === 'arch' ? `/tmp/kimi-home-${roomId}-arch` : projectDir,
    supportsResume: true,
    trustTexts: [],
    trustKey: '',
    models: ['kimi-for-coding', 'kimi-k2.6', 'kimi-k2.5', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    defaultModel: 'kimi-for-coding',
  },
}
