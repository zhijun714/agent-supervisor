export const feishuState = {
  client:   null as unknown,
  wsClient: null as unknown,
  started:  false,
  starting: false,
  error:    null as string | null,
  msgMap:   new Map<string, string>(),
}

async function _importLark(): Promise<Record<string, unknown> | null> {
  try { return await import('@larksuiteoapi/node-sdk') as Record<string, unknown> } catch { return null }
}

export async function startFeishu({ onMessage, broadcastFn }: {
  onMessage: (args: { parentId: string | undefined; msgId: string | undefined; text: string }) => Promise<void>
  broadcastFn: (event: object) => void
}): Promise<void> {
  if (feishuState.started || feishuState.starting) return
  const appId     = process.env.FEISHU_APP_ID
  const appSecret = process.env.FEISHU_APP_SECRET
  if (!appId || !appSecret) {
    feishuState.error = '未配置 FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量'
    broadcastFn({ type: 'comm_status', adapter: 'feishu', connected: false, error: feishuState.error })
    return
  }
  const lark = await _importLark()
  if (!lark) {
    feishuState.error = '未安装 @larksuiteoapi/node-sdk，请运行: npm install @larksuiteoapi/node-sdk'
    broadcastFn({ type: 'comm_status', adapter: 'feishu', connected: false, error: feishuState.error })
    return
  }
  feishuState.starting = true
  feishuState.error    = null
  try {
    const LarkClient = (lark.Client ?? (lark.default as Record<string, unknown>)?.Client) as new (opts: object) => unknown
    feishuState.client = new LarkClient({ appId, appSecret })

    const handleMsg = async (data: Record<string, unknown>) => {
      try {
        const msg      = (data?.message ?? (data?.event as Record<string, unknown>)?.message ?? data) as Record<string, unknown>
        const msgId    = msg?.message_id as string | undefined
        const parentId = msg?.parent_id  as string | undefined
        const text     = (() => { try { return (JSON.parse(msg?.content as string || '{}') as { text?: string }).text || '' } catch { return '' } })()
        if (!text.trim()) return
        await onMessage({ parentId, msgId, text: text.trim() })
      } catch (e) { console.error('[feishu] onMessage error:', e) }
    }

    const EventDispatcher = (lark.EventDispatcher ?? (lark.default as Record<string, unknown>)?.EventDispatcher) as new (opts: object) => { register: (handlers: Record<string, unknown>) => unknown }
    const WSClient        = (lark.WSClient        ?? (lark.default as Record<string, unknown>)?.WSClient)        as new (opts: object) => { start: (opts: object) => Promise<void> }
    if (!EventDispatcher || !WSClient) throw new Error('@larksuiteoapi/node-sdk 版本不支持 WSClient，请升级到 v1.x')

    const dispatcher = new EventDispatcher({}).register({ 'im.message.receive_v1': handleMsg })
    feishuState.wsClient = new WSClient({ appId, appSecret })
    await (feishuState.wsClient as { start: (opts: object) => Promise<void> }).start({ eventDispatcher: dispatcher })

    feishuState.started  = true
    feishuState.starting = false
    feishuState.error    = null
    console.log('[feishu] long-connection started')
    broadcastFn({ type: 'comm_status', adapter: 'feishu', connected: true })
  } catch (e) {
    const err = e as Error
    feishuState.starting = false
    feishuState.started  = false
    feishuState.error    = err.message
    console.error('[feishu] start error:', err.message)
    broadcastFn({ type: 'comm_status', adapter: 'feishu', connected: false, error: err.message })
  }
}

export async function stopFeishu(broadcastFn?: (event: object) => void): Promise<void> {
  try { (feishuState.wsClient as { stop?: () => void })?.stop?.() } catch {}
  feishuState.wsClient = null
  feishuState.client   = null
  feishuState.started  = false
  feishuState.starting = false
  feishuState.error    = null
  broadcastFn?.({ type: 'comm_status', adapter: 'feishu', connected: false })
  console.log('[feishu] stopped')
}

function inferReceiveIdType(id: string | undefined, configured: string | undefined): string {
  if (id?.startsWith('oc_')) return 'chat_id'
  if (id?.startsWith('ou_')) return 'open_id'
  if (id?.startsWith('on_')) return 'union_id'
  return configured ?? 'chat_id'
}

export async function feishuSend(room: { id: string; commReceiveId?: string; commReceiveIdType?: string }, text: string): Promise<{ ok: boolean; msgId: string | undefined }> {
  if (!feishuState.started || !feishuState.client) throw new Error('飞书未连接，请检查环境变量并重试')
  const { commReceiveId: receiveId, commReceiveIdType: configuredType } = room
  if (!receiveId) throw new Error('未配置 commReceiveId')
  const receiveIdType = inferReceiveIdType(receiveId, configuredType)
  const client = feishuState.client as { im: { message: { create: (opts: object) => Promise<{ data?: { message_id?: string } }> } } }
  const resp  = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data:   { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text }) },
  })
  const msgId = resp?.data?.message_id
  if (msgId) {
    feishuState.msgMap.set(msgId, room.id)
    if (feishuState.msgMap.size > 500) feishuState.msgMap.delete(feishuState.msgMap.keys().next().value!)
  }
  return { ok: true, msgId }
}
