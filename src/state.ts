import type { WebSocket } from 'ws'
import type { Room, PTYEntry, InboxState, RoomState } from './types.js'

export const rooms: Record<string, Room> = {}
export const ptys: Record<string, PTYEntry> = {}
export const inboxes: Record<string, InboxState> = {}
export const roomStates: Record<string, RoomState> = {}
export const clients = new Set<WebSocket>()

export function broadcast(event: object): void {
  const msg = JSON.stringify(event)
  for (const ws of clients) if (ws.readyState === 1) ws.send(msg)
}

function freshRotationRole() {
  return { ready: false, pendingAt: 0, ledger: '', spawnedAt: 0 }
}

export function getRoomState(roomId: string): RoomState {
  if (!roomStates[roomId]) {
    roomStates[roomId] = {
      autoReviewEnabled: false, lastReviewAt: 0, devReviewWatermark: 0,
      watchdogEnabled: false, watchdogTimer: null,
      lastActivityTs: { arch: 0, dev: 0, qa: 0 },
      rotation: { arch: freshRotationRole(), dev: freshRotationRole(), qa: freshRotationRole() },
      distillLastAt: 0,
    }
  }
  return roomStates[roomId]
}
