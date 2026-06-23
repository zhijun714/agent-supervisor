import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { rooms, groups } from './state.js'
import { ROOMS_FILE, GROUPS_FILE } from './config.js'
import type { Room, Group } from './types.js'
import { UNGROUPED_ID } from './types.js'

export function loadRooms(): void {
  try {
    const data = JSON.parse(readFileSync(ROOMS_FILE, 'utf8')) as Record<string, Room>
    Object.assign(rooms, data)
  } catch {}

  // Legacy migration 1: old pinned (= "tab is open") → opened; new pinned starts false.
  const needsMigration = Object.values(rooms).some(r => r.opened === undefined)
  if (needsMigration) {
    const wasOpen = Object.values(rooms)
      .filter(r => !!(r as any).pinned)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    wasOpen.forEach((r, i) => { r.order = i })
    for (const r of Object.values(rooms)) {
      if (r.opened === undefined) {
        r.opened = !!(r as any).pinned
        r.pinned = false
        if (r.order === undefined) r.order = 9999
      }
    }
    try { writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2)) } catch {}
  }
}

export function saveRooms(): void {
  try { writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2)) } catch {}
}

export function loadGroups(): void {
  // groups.json already exists → migration already done, just load it
  if (existsSync(GROUPS_FILE)) {
    try {
      const data = JSON.parse(readFileSync(GROUPS_FILE, 'utf8')) as Group[]
      groups.length = 0
      groups.push(...data)
    } catch {}
    // Safety net: ensure the ungrouped bucket always exists
    if (!groups.find(g => g.id === UNGROUPED_ID)) {
      groups.push({ id: UNGROUPED_ID, name: '未分组', color: '#8b949e', order: 9999, collapsed: false })
      saveGroups()
    }
    return
  }

  // First run: back up rooms.json before any writes
  try {
    if (existsSync(ROOMS_FILE)) copyFileSync(ROOMS_FILE, ROOMS_FILE + '.bak')
  } catch {}

  // Migrate: pinned rooms → "关注" group; everything else → "未分组"
  const hasPinned = Object.values(rooms).some(r => r.pinned)
  let pinnedGroupId: string | null = null

  if (hasPinned) {
    pinnedGroupId = randomUUID().slice(0, 8)
    groups.push({ id: pinnedGroupId, name: '关注', color: '#58a6ff', order: 0, collapsed: false })
  }
  groups.push({ id: UNGROUPED_ID, name: '未分组', color: '#8b949e', order: 9999, collapsed: false })

  for (const r of Object.values(rooms)) {
    r.groupId = (r.pinned && pinnedGroupId) ? pinnedGroupId : UNGROUPED_ID
  }

  saveGroups()
  // Persist rooms with their new groupId field
  try { writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2)) } catch {}
}

export function saveGroups(): void {
  try { writeFileSync(GROUPS_FILE, JSON.stringify(groups, null, 2)) } catch {}
}
