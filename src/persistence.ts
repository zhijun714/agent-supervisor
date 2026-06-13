import { readFileSync, writeFileSync } from 'fs'
import { rooms } from './state.js'
import { ROOMS_FILE } from './config.js'
import type { Room } from './types.js'

export function loadRooms(): void {
  try {
    const data = JSON.parse(readFileSync(ROOMS_FILE, 'utf8')) as Record<string, Room>
    Object.assign(rooms, data)
  } catch {}
}

export function saveRooms(): void {
  try { writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2)) } catch {}
}
