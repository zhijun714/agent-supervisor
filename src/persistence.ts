import { readFileSync, writeFileSync } from 'fs'
import { rooms } from './state.js'
import { ROOMS_FILE } from './config.js'
import type { Room } from './types.js'

export function loadRooms(): void {
  try {
    const data = JSON.parse(readFileSync(ROOMS_FILE, 'utf8')) as Record<string, Room>
    Object.assign(rooms, data)
  } catch {}

  // One-time migration: old pinned (= "tab is open") → opened; new pinned starts false.
  // Sort by updatedAt desc to match the order users saw in the sidebar before migration.
  const needsMigration = Object.values(rooms).some(r => r.opened === undefined)
  if (needsMigration) {
    const wasOpen = Object.values(rooms)
      .filter(r => !!(r as any).pinned)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    wasOpen.forEach((r, i) => { r.order = i })
    for (const r of Object.values(rooms)) {
      if (r.opened === undefined) {
        r.opened = !!(r as any).pinned
        r.pinned = false  // new pinned = "关注" group, starts false for everyone
        if (r.order === undefined) r.order = 9999
      }
    }
    // persist migrated state immediately
    try { writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2)) } catch {}
  }
}

export function saveRooms(): void {
  try { writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2)) } catch {}
}
