import { rooms } from './state.js'
import { broadcast } from './state.js'
import { feishuState, startFeishu as _feishuStart, stopFeishu as _feishuStop, feishuSend as _feishuSend } from './comm-feishu.js'
import { getPendingKnowledge, approveKnowledge, rejectKnowledge } from './distiller.js'
import type { AdapterStatus } from './types.js'

export function getAdapterStatus(adapter: string | null | undefined): AdapterStatus {
  if (adapter === 'feishu') {
    const configOk = !!(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET)
    return {
      connected: feishuState.started,
      error:     feishuState.error,
      configOk,
      hint: configOk ? null : '请设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET 环境变量后重启服务',
    }
  }
  return { connected: false, error: null, configOk: false, hint: null }
}

// inboxSend is imported lazily to avoid circular deps (inbox → pty-manager → comm)
let _inboxSend: ((to: string, from: string, text: string, priority?: string) => void) | null = null
export function setInboxSend(fn: (to: string, from: string, text: string, priority?: string) => void): void {
  _inboxSend = fn
}

export async function startComm(adapter: string | null | undefined): Promise<void> {
  if (!adapter || adapter === 'feishu') {
    return _feishuStart({
      onMessage: async ({ parentId, msgId, text }) => {
        let targetRoomId: string | undefined = parentId ? feishuState.msgMap.get(parentId) : undefined
        if (!targetRoomId) {
          targetRoomId = Object.values(rooms)
            .filter(r => r.commEnabled && r.commAdapter === 'feishu')
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0]?.id
        }
        if (!targetRoomId) { console.log('[comm] no target room for incoming message'); return }
        console.log(`[comm:${adapter}] incoming → room ${targetRoomId}: ${text.slice(0, 80)}`)

        // Check if this is a knowledge distillation approval/rejection
        const normalised = text.trim().toLowerCase()
        if (getPendingKnowledge(targetRoomId)) {
          if (normalised === 'ok' || normalised === '确认' || normalised === 'approve' || normalised === 'yes') {
            const ok = approveKnowledge(targetRoomId)
            broadcast({ type: 'comm_message_received', roomId: targetRoomId, adapter, text, msgId })
            broadcast({ type: 'knowledge_approved', roomId: targetRoomId, ok })
            return
          } else if (normalised === '取消' || normalised === 'cancel' || normalised === 'reject' || normalised === 'no') {
            rejectKnowledge(targetRoomId)
            broadcast({ type: 'comm_message_received', roomId: targetRoomId, adapter, text, msgId })
            broadcast({ type: 'knowledge_rejected', roomId: targetRoomId })
            return
          }
        }

        _inboxSend?.(`${targetRoomId}-arch`, 'user', text)
        broadcast({ type: 'comm_message_received', roomId: targetRoomId, adapter, text, msgId })
      },
      broadcastFn: broadcast,
    })
  }
}

export async function stopComm(adapter: string | null | undefined): Promise<void> {
  if (!adapter || adapter === 'feishu') return _feishuStop(broadcast)
}

export async function commSend(roomId: string, text: string): Promise<{ ok: boolean; msgId?: string }> {
  const room = rooms[roomId]
  if (!room?.commEnabled) throw new Error('通信未启用')
  if (room.commAdapter === 'feishu') return _feishuSend(room, text)
  throw new Error(`未知通信适配器: ${room.commAdapter}`)
}

export function maybeAutoStartComm(): void {
  const adapters = new Set(
    Object.values(rooms).filter(r => r.commEnabled && r.commAdapter).map(r => r.commAdapter!)
  )
  for (const adapter of adapters) startComm(adapter)
}
