import type { IPty } from 'node-pty'
import type { WebSocket } from 'ws'

export interface Room {
  id: string
  name: string
  archDir: string
  devDir: string
  qaDir: string | null
  archSilent: boolean
  devSilent: boolean
  qaSilent: boolean
  archModel: string
  devModel: string
  qaModel: string
  archCli: string
  devCli: string
  qaCli: string
  archSessionId?: string
  devSessionId?: string
  qaSessionId?: string
  commEnabled?: boolean
  commAdapter?: string | null
  commReceiveId?: string
  commReceiveIdType?: string
  createdAt: number
  updatedAt: number
  [key: string]: unknown
}

export interface PTYEntry {
  proc: IPty
  clients: Set<WebSocket>
  alive: boolean
  textBuf: string
  rawBuf: string
  resumeInterrupt: boolean
  cli: string
  projectDir: string
  _kimiExitMarker?: string
  _kimiExited?: boolean
  _kimiLastRestartAt?: number
  _kimiQuickExitCount?: number
  _quotaExceeded?: boolean
  _quotaRetryTimer?: ReturnType<typeof setTimeout> | null
  _quotaRetryAt?: number | null
  _interceptWatermark?: number
  _notifyLineBuf?: string
  _kimiArchWriteBlocking?: boolean
}

export interface InboxMessage {
  from: string
  text: string
  priority: string
}

export interface InboxState {
  queue: InboxMessage[]
  idleTimer: ReturnType<typeof setTimeout> | null
}

export interface RotationRoleState {
  ready: boolean
  pendingAt: number
  ledger: string
  spawnedAt: number
}

export interface RoomState {
  autoReviewEnabled: boolean
  lastReviewAt: number
  devReviewWatermark: number
  watchdogEnabled: boolean
  watchdogTimer: ReturnType<typeof setInterval> | null
  lastActivityTs: { arch: number; dev: number; qa: number }
  rotation: { arch: RotationRoleState; dev: RotationRoleState; qa: RotationRoleState }
  distillLastAt: number
}

export interface Session {
  sessionId: string
  firstPrompt: string
  lastPrompt: string
  lastTs: number | null
}

export interface AdapterStatus {
  connected: boolean
  error: string | null
  configOk: boolean
  hint: string | null
}

export interface MemoryContext {
  archCtx: string
  devCtx: string
  qaCtx: string
}

export interface CliProfile {
  buildCmd: (model: string, promptFile: string, sessionId: string | null, silent: boolean, role: string) => string
  getEnv: (promptFile: string, roomId: string, role: string) => Record<string, string>
  writeConfig?: ((promptFile: string, roomId: string, role: string, projectDir?: string) => void) | null
  cleanProjectDir?: (dir: string) => void
  getEffectiveCwd?: (projectDir: string, roomId: string, role: string) => string
  supportsResume: boolean
  trustTexts: string[]
  trustKey: string
  models: string[]
  defaultModel: string
}
