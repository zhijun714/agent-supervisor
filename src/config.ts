import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, readFileSync } from 'fs'

export const PORT = parseInt(process.env.PORT || '3458', 10)
export const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
export const ROOMS_FILE = process.env.ROOMS_FILE || join(ROOT_DIR, 'rooms.json')
export const ROOM_MEMORIES_DIR = join(ROOT_DIR, 'room-memories')

mkdirSync(ROOM_MEMORIES_DIR, { recursive: true })

export interface AppConfig {
  rotation: {
    enabled: boolean
    rawBufThreshold: number
    sessionMinMs: number
    checkpointWaitMs: number
    boundaryPatterns: string[]
  }
  distiller: {
    enabled: boolean
    debounceMs: number
    maxTransLen: number
    model: string
  }
  inbox: {
    idleMs: number
    idleMsResume: number
  }
  review: {
    cooldownMs: number
    minContentLen: number
  }
  watchdog: {
    intervalMs: number
    idleThresholdMs: number
  }
}

const DEFAULTS: AppConfig = {
  rotation: {
    enabled: false,
    rawBufThreshold: 180_000,
    sessionMinMs: 30 * 60 * 1000,
    checkpointWaitMs: 60_000,
    boundaryPatterns: ['[TASK_COMPLETE]', '验收通过', 'ok -'],
  },
  distiller: {
    enabled: false,
    debounceMs: 5 * 60 * 1000,
    maxTransLen: 40_000,
    model: 'claude-haiku-4-5-20251001',
  },
  inbox: { idleMs: 2_000, idleMsResume: 8_000 },
  review: { cooldownMs: 60_000, minContentLen: 500 },
  watchdog: { intervalMs: 5 * 60 * 1000, idleThresholdMs: 5 * 60 * 1000 },
}

function deepMerge<T>(base: T, override: Partial<T>): T {
  const result = { ...base }
  for (const key of Object.keys(override) as (keyof T)[]) {
    const ov = override[key]
    if (ov !== null && typeof ov === 'object' && !Array.isArray(ov) && typeof base[key] === 'object') {
      result[key] = deepMerge(base[key] as object, ov as object) as T[keyof T]
    } else if (ov !== undefined) {
      result[key] = ov as T[keyof T]
    }
  }
  return result
}

function loadConfig(): AppConfig {
  const cfgFile = join(ROOT_DIR, 'supervisor.config.json')
  try {
    const raw = JSON.parse(readFileSync(cfgFile, 'utf8'))
    return deepMerge(DEFAULTS, raw)
  } catch {
    return DEFAULTS
  }
}

export const cfg = loadConfig()
