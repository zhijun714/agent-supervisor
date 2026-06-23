import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { THEMES, applyTheme, getSavedTheme, loadServerTheme, saveTheme, toXtermTheme, THEME_KEY } from './themes'

function escHtml(s: unknown): string {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches ||
    !!(navigator as Navigator & { standalone?: boolean }).standalone
}

// U+200B zero-width space: invisible, not stripped by document.title getter (unlike ASCII space),
// prevents Chrome from falling back to the manifest name when title would otherwise be empty.
const INVIS = '​'

function setTitle(title: string): void {
  document.title = isStandalone() ? INVIS : title
}

// Set early to suppress first-frame manifest-name flash in standalone windows
if (isStandalone()) document.title = INVIS

// ── Route: room list vs room detail ──────────────────────────────────────────
const roomId = new URLSearchParams(location.search).get('room')
if (roomId) {
  document.getElementById('roomDetailView')!.style.display = 'flex'
  initRoomDetail(roomId)
} else {
  document.getElementById('roomShellView')!.style.display = 'flex'
  initShell()
}

// ══════════════════════════════════════════════════════════════════════════════
// ROOM LIST
// ══════════════════════════════════════════════════════════════════════════════
function initShell() {
  const roomCards    = document.getElementById('roomCards')!
  const newRoomBtn   = document.getElementById('newRoomBtn')!
  const modal        = document.getElementById('newRoomModal')!
  const nrName       = document.getElementById('nrName') as HTMLInputElement
  const nrArchDir    = document.getElementById('nrArchDir') as HTMLInputElement
  const nrDevDir     = document.getElementById('nrDevDir') as HTMLInputElement
  const nrQaDir      = document.getElementById('nrQaDir') as HTMLInputElement
  const nrArchSilent = document.getElementById('nrArchSilent') as HTMLInputElement
  const nrDevSilent  = document.getElementById('nrDevSilent') as HTMLInputElement
  const nrQaSilent   = document.getElementById('nrQaSilent') as HTMLInputElement
  const nrCancel     = document.getElementById('nrCancel')!
  const nrCreate     = document.getElementById('nrCreate') as HTMLButtonElement

  // ── Tab shell state ──────────────────────────────────────────────────────
  const shellMain   = document.getElementById('shellMain')!
  const shellHome   = document.getElementById('shellHome')!
  const openTabsEl  = document.getElementById('openTabs')!
  const homeTabBtn  = document.getElementById('homeTabBtn')!
  // roomId → { iframe, tab } for each opened room (kept alive in the background)
  const openTabs = new Map<string, { iframe: HTMLIFrameElement; tab: HTMLElement }>()
  const tabOrder: string[] = []
  let activeRoomId: string | null = null
  let latestRooms: any[] = []

  function statusDots(r: any): string {
    const dot = (on: boolean, cls: string) => `<div class="room-status-dot ${cls} ${on ? 'on' : ''}"></div>`
    return [
      r.archDir ? dot(r.archAlive, 'arch') : '',
      r.devDir  ? dot(r.devAlive, '')      : '',
      r.qaDir   ? dot(r.qaAlive, 'qa')     : '',
    ].join('')
  }

  const ACTIVE_KEY = 'sup-active-room'

  function setActive(id: string | null) {
    activeRoomId = id
    shellHome.style.display = id === null ? 'flex' : 'none'
    for (const [rid, { iframe }] of openTabs) iframe.style.display = rid === id ? 'block' : 'none'
    homeTabBtn.classList.toggle('active', id === null)
    openTabs.forEach(({ tab }, rid) => tab.classList.toggle('active', rid === id))
    setTitle(id ? ('Supervisor — ' + (latestRooms.find(r => r.id === id)?.name || 'Room')) : 'Supervisor')
    try { id ? localStorage.setItem(ACTIVE_KEY, id) : localStorage.removeItem(ACTIVE_KEY) } catch {}
  }

  // opts.activate: switch to the tab (default true). opts.persist: mark pinned
  // server-side so it survives refresh/restart (default true; false during restore).
  function openRoomTab(id: string, opts: { activate?: boolean; persist?: boolean } = {}) {
    const activate = opts.activate !== false
    const persist  = opts.persist  !== false
    if (!openTabs.has(id)) {
      const iframe = document.createElement('iframe')
      iframe.src = '/?room=' + id
      iframe.style.display = 'none'
      shellMain.appendChild(iframe)
      const tab = document.createElement('div')
      tab.className = 'room-tab'
      openTabsEl.appendChild(tab)
      openTabs.set(id, { iframe, tab })
      tabOrder.push(id)
      tab.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('room-tab-close')) return
        setActive(id)
      })
      renderTabs()
      if (persist) {
        fetch('/rooms/' + id, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pinned: true }),
        }).catch(() => {})
      }
    }
    if (activate) setActive(id)
  }

  function closeRoomTab(id: string) {
    const entry = openTabs.get(id)
    if (!entry) return
    entry.iframe.remove()
    entry.tab.remove()
    openTabs.delete(id)
    tabOrder.splice(tabOrder.indexOf(id), 1)
    if (activeRoomId === id) setActive(tabOrder.length ? tabOrder[tabOrder.length - 1] : null)
    // Unpin server-side AND kill the room's backend terminals.
    fetch('/rooms/' + id + '/close', { method: 'POST' }).catch(() => {})
  }

  function renderTabs() {
    for (const id of tabOrder) {
      const entry = openTabs.get(id); if (!entry) continue
      const r = latestRooms.find(x => x.id === id) || { name: id, id }
      entry.tab.innerHTML =
        `<div class="room-tab-dots">${statusDots(r)}</div>` +
        `<div class="room-tab-name">${escHtml(r.name)}</div>` +
        `<div class="room-tab-close" title="关闭标签">✕</div>`
      entry.tab.querySelector('.room-tab-close')!.addEventListener('click', (e) => { e.stopPropagation(); closeRoomTab(id) })
    }
  }

  let pollTimer: ReturnType<typeof setInterval> | null = null
  let restored = false

  async function loadRooms() {
    try {
      latestRooms = await fetch('/rooms').then(r => r.json())
      // First successful load: re-open tabs for rooms pinned server-side, so the
      // sidebar survives page refresh and server restart.
      if (!restored) {
        restored = true
        const pinned = latestRooms.filter(r => r.pinned)
        for (const r of pinned) openRoomTab(r.id, { activate: false, persist: false })
        let active: string | null = null
        try { active = localStorage.getItem(ACTIVE_KEY) } catch {}
        if (active && openTabs.has(active)) setActive(active)
        else setActive(null)
      }
      renderRooms(latestRooms)
      renderTabs()
    } catch {}
  }

  function renderRooms(list: any[]) {
    roomCards.innerHTML = ''
    if (!list.length) {
      roomCards.innerHTML = `<div class="room-empty"><p>还没有任何 Room</p><button class="rl-btn" onclick="document.getElementById('newRoomBtn').click()">+ 创建第一个 Room</button></div>`
      return
    }
    for (const r of list) {
      const card = document.createElement('div')
      card.className = 'room-card'
      const archDot = r.archDir
        ? `<div class="room-status-dot arch ${r.archAlive ? 'on' : ''}" title="PA ${r.archAlive ? 'running' : 'stopped'}"></div>`
        : ''
      const devDot = r.devDir
        ? `<div class="room-status-dot ${r.devAlive ? 'on' : ''}" title="Dev ${r.devAlive ? 'running' : 'stopped'}"></div>`
        : ''
      const qaDot = r.qaDir
        ? `<div class="room-status-dot qa ${r.qaAlive ? 'on' : ''}" title="QA ${r.qaAlive ? 'running' : 'stopped'}"></div>`
        : ''
      const archDir = r.archDir
        ? `<div class="room-card-dir"><span class="room-card-dir-label arch">PA</span><span class="room-card-dir-path">${escHtml(r.archDir)}</span></div>`
        : ''
      const devDir = r.devDir
        ? `<div class="room-card-dir"><span class="room-card-dir-label dev">Dev</span><span class="room-card-dir-path">${escHtml(r.devDir)}</span></div>`
        : ''
      const qaDir = r.qaDir
        ? `<div class="room-card-dir"><span class="room-card-dir-label qa">QA</span><span class="room-card-dir-path">${escHtml(r.qaDir)}</span></div>`
        : ''
      card.innerHTML = `
        <div class="room-card-top">
          <div class="room-card-name">${escHtml(r.name)}</div>
          <div class="room-card-status">
            ${archDot}
            ${devDot}
            ${qaDot}
          </div>
        </div>
        <div class="room-card-dirs">
          ${archDir}
          ${devDir}
          ${qaDir}
        </div>
        <div class="room-card-actions">
          <button class="room-open-btn">Open →</button>
          <button class="room-delete-btn" title="Delete room">✕</button>
        </div>`
      card.querySelector('.room-open-btn')!.addEventListener('click', (e) => {
        e.stopPropagation()
        openRoomTab(r.id)
      })
      card.querySelector('.room-delete-btn')!.addEventListener('click', async (e) => {
        e.stopPropagation()
        if (!confirm(`Delete room "${r.name}"? Running terminals will be killed.`)) return
        closeRoomTab(r.id)
        await fetch('/rooms/' + r.id, { method: 'DELETE' })
        loadRooms()
      })
      card.addEventListener('click', () => { openRoomTab(r.id) })
      roomCards.appendChild(card)
    }
  }

  homeTabBtn.addEventListener('click', () => setActive(null))

  // Theme the shell chrome (sidebar/home). Selector lives in the room header
  // (inside iframes); here we just apply + live-sync via the 'storage' event.
  applyTheme(getSavedTheme())
  loadServerTheme().then(t => applyTheme(t))
  window.addEventListener('storage', e => { if (e.key === THEME_KEY) applyTheme(getSavedTheme()) })

  loadRooms()
  pollTimer = setInterval(loadRooms, 3000)
  window.addEventListener('beforeunload', () => clearInterval(pollTimer!))

  newRoomBtn.addEventListener('click', () => {
    nrName.value = ''; nrArchDir.value = ''; nrDevDir.value = ''; nrQaDir.value = ''
    nrArchSilent.checked = false; nrDevSilent.checked = false; nrQaSilent.checked = false
    modal.style.display = 'flex'
    setTimeout(() => nrName.focus(), 50)
  })
  nrCancel.addEventListener('click', () => { modal.style.display = 'none' })
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none' })

  nrCreate.addEventListener('click', async () => {
    const archDir = nrArchDir.value.trim()
    const devDir  = nrDevDir.value.trim()
    const qaDir   = nrQaDir.value.trim() || null
    if (!archDir && !devDir && !qaDir) { alert('请至少填写一个角色的目录'); return }
    nrCreate.disabled = true; nrCreate.textContent = '创建中…'
    try {
      const r = await fetch('/rooms', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nrName.value.trim() || 'New Room', archDir, devDir, qaDir, archSilent: nrArchSilent.checked, devSilent: nrDevSilent.checked, qaSilent: nrQaSilent.checked }),
      })
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.statusText) }
      const { room } = await r.json()
      modal.style.display = 'none'
      nrCreate.disabled = false; nrCreate.textContent = 'Create Room'
      await loadRooms()
      openRoomTab(room.id)
    } catch (e: any) {
      alert('创建失败: ' + e.message)
      nrCreate.disabled = false; nrCreate.textContent = 'Create Room'
    }
  })

  ;[nrName, nrArchDir, nrDevDir, nrQaDir].forEach(el => el.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') nrCreate.click() }))
}

// ══════════════════════════════════════════════════════════════════════════════
// ROOM DETAIL
// ══════════════════════════════════════════════════════════════════════════════
function initRoomDetail(roomId: string) {
  const ARCH_TERM_ID = roomId + '-arch'
  const DEV_TERM_ID  = roomId + '-dev'
  const QA_TERM_ID   = roomId + '-qa'

  // Which roles this room has enabled (derived from its dirs). Defaults assume
  // all-on; loadRoom() corrects this from the actual room config.
  const roleEnabled: Record<string, boolean> = { arch: true, dev: true, qa: false }

  function createTerminal(containerId: string) {
    const container = document.getElementById(containerId)!
    const term = new Terminal({
      theme: toXtermTheme(THEMES[getSavedTheme()]) as any, fontFamily: '"SF Mono","Fira Code","Cascadia Code",Menlo,monospace',
      fontSize: 13, lineHeight: 1.25, cursorBlink: true, scrollback: 10000, allowTransparency: false,
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)
    requestAnimationFrame(() => { try { fitAddon.fit() } catch(e){} })
    const ro = new ResizeObserver(() => { try { fitAddon.fit() } catch(e){} })
    ro.observe(container)
    const obj = { term, fitAddon, ws: null as WebSocket | null }
    container.addEventListener('mousedown', () => { term.focus(); container.classList.add('focused') })
    container.addEventListener('click', () => term.focus())
    requestAnimationFrame(() => {
      const ta = container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
      if (ta) {
        ta.addEventListener('focus', () => container.classList.add('focused'))
        ta.addEventListener('blur',  () => container.classList.remove('focused'))
      }
    })
    term.onData(data => { if (obj.ws && obj.ws.readyState === 1) obj.ws.send(data) })
    term.onResize(({ cols, rows }) => { if (obj.ws && obj.ws.readyState === 1) obj.ws.send(JSON.stringify({ type: 'resize', cols, rows })) })
    container.addEventListener('paste', (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (text === '') {
        if (obj.ws?.readyState === 1) obj.ws.send('\x1b[200~\x1b[201~')
        e.stopImmediatePropagation()
        e.preventDefault()
      }
    }, true)
    return obj
  }

  const archObj = createTerminal('archTermEl')
  const devObj  = createTerminal('devTermEl')
  let qaObj: ReturnType<typeof createTerminal> | null = null
  function ensureQaTerminal() {
    if (!qaObj) {
      qaObj = createTerminal('qaTermEl')
      applyTheme(getSavedTheme(), liveTerms())
    }
  }

  // ── Theme ──────────────────────────────────────────────────────────────────
  function liveTerms(): { options: Record<string, unknown> }[] {
    return [archObj.term, devObj.term, qaObj?.term].filter(Boolean) as any
  }
  function applyCurrentTheme() { applyTheme(getSavedTheme(), liveTerms()) }
  applyCurrentTheme()                                   // chrome + terminals, from cache
  loadServerTheme().then(t => applyTheme(t, liveTerms())) // correct from server prefs
  // Live-sync when another open tab / the shell changes the theme.
  window.addEventListener('storage', e => { if (e.key === THEME_KEY) applyCurrentTheme() })

  const themeSelect = document.getElementById('themeSelect') as HTMLSelectElement | null
  if (themeSelect) {
    for (const [key, s] of Object.entries(THEMES)) {
      const o = document.createElement('option')
      o.value = key; o.textContent = s.name
      themeSelect.appendChild(o)
    }
    themeSelect.value = getSavedTheme()
    loadServerTheme().then(t => { themeSelect.value = t })
    themeSelect.addEventListener('change', () => {
      saveTheme(themeSelect.value)
      applyTheme(themeSelect.value, liveTerms())
    })
  }

  // ── Mobile tab switching ──────────────────────────────────────────────────
  const mobileQuery = window.matchMedia('(max-width: 768px)')

  function fitRole(role: string) {
    requestAnimationFrame(() => {
      try {
        if (role === 'arch') archObj.fitAddon.fit()
        else if (role === 'dev') devObj.fitAddon.fit()
        else if (role === 'qa' && qaObj) qaObj.fitAddon.fit()
      } catch(e) {}
    })
  }

  function showMobilePanel(role: string) {
    for (const r of ['arch', 'dev', 'qa']) {
      const panel = document.getElementById(r + 'Panel')
      if (!panel) continue
      panel.style.display = r === role ? 'flex' : 'none'
    }
    fitRole(role)
  }

  function applyMobileLayout() {
    const mobile = mobileQuery.matches
    const tabsEl = document.getElementById('mobileTabs')
    if (!tabsEl) return
    if (mobile) {
      tabsEl.style.display = 'flex'
      const active = tabsEl.querySelector('.mobile-tab.active') as HTMLElement | null
      showMobilePanel(active?.dataset.panel || 'arch')
    } else {
      tabsEl.style.display = 'none'
      // Restore desktop: show only enabled roles' panels
      document.getElementById('archPanel')!.style.display = roleEnabled.arch ? 'flex' : 'none'
      document.getElementById('devPanel')!.style.display  = roleEnabled.dev  ? 'flex' : 'none'
      document.getElementById('qaPanel')!.style.display   = roleEnabled.qa   ? 'flex' : 'none'
      requestAnimationFrame(() => {
        try { if (roleEnabled.arch) archObj.fitAddon.fit(); if (roleEnabled.dev) devObj.fitAddon.fit() } catch(e) {}
        if (qaObj && roleEnabled.qa) try { qaObj.fitAddon.fit() } catch(e) {}
      })
    }
  }

  function activateMobileTab(role: string) {
    const tabsEl = document.getElementById('mobileTabs')
    if (!tabsEl) return
    tabsEl.querySelectorAll('.mobile-tab').forEach(t => t.classList.remove('active'))
    const tab = tabsEl.querySelector(`.mobile-tab[data-panel="${role}"]`) as HTMLElement | null
    tab?.classList.add('active')
    if (mobileQuery.matches) showMobilePanel(role)
  }

  function showQaMobileTab() {
    const qaTab = document.getElementById('mobileQaTab')
    if (qaTab) qaTab.style.display = ''
  }

  // Tab click handlers
  document.getElementById('mobileTabs')?.querySelectorAll('.mobile-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const role = (tab as HTMLElement).dataset.panel!
      if (!roleEnabled[role]) return
      if (role === 'qa' && !qaObj) return
      activateMobileTab(role)
    })
  })

  mobileQuery.addEventListener('change', applyMobileLayout)
  applyMobileLayout()

  const archStatus = document.getElementById('archStatus')!
  const devStatus  = document.getElementById('devStatus')!
  const qaStatus   = document.getElementById('qaStatus')!
  const archInboxBadge = document.getElementById('archInboxBadge')!
  const devInboxBadge  = document.getElementById('devInboxBadge')!
  const qaInboxBadge   = document.getElementById('qaInboxBadge')!
  const inboxQueueCounts: Record<string, number> = { arch: 0, dev: 0, qa: 0 }

  function getInboxBadgeEl(role: string): HTMLElement | null {
    return role === 'arch' ? archInboxBadge : role === 'qa' ? qaInboxBadge : devInboxBadge
  }

  function updateInboxBadge(role: string, count: number, hasUrgent: boolean) {
    inboxQueueCounts[role] = count
    const el = getInboxBadgeEl(role)
    if (!el) return
    if (count > 0) {
      el.textContent = `📨 ${count}`
      el.style.display = 'inline-block'
      el.classList.toggle('has-urgent', !!hasUrgent)
    } else {
      el.style.display = 'none'
      el.classList.remove('has-urgent')
    }
  }

  async function clearInbox(role: string) {
    try {
      await fetch(`/rooms/${roomId}/inbox/clear`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role })
      })
    } catch (e) { console.error('clear inbox failed', e) }
  }

  async function showInboxQueue(role: string) {
    document.getElementById('_inboxOverlay')?.remove()
    let queue: any[] = []
    try {
      const r = await fetch(`/rooms/${roomId}/inbox?role=${role}`)
      const d = await r.json()
      queue = d.queue || []
    } catch(e) { return }

    if (!queue.length) return

    const roleLabel = role === 'arch' ? '产品架构师' : role === 'qa' ? 'QA 工程师' : '开发工程师'
    const fromLabel = (f: string) => f === 'arch' ? 'PA' : f === 'qa' ? 'QA' : f === 'dev' ? 'Dev' : f === 'system' ? 'System' : f

    const overlay = document.createElement('div')
    overlay.id = '_inboxOverlay'
    overlay.className = 'inbox-overlay'

    const panel = document.createElement('div')
    panel.className = 'inbox-panel'

    const head = document.createElement('div')
    head.className = 'inbox-panel-head'
    head.innerHTML = `<h3>📨 ${roleLabel} 积压消息（${queue.length} 条）</h3>`
    panel.appendChild(head)

    const body = document.createElement('div')
    body.className = 'inbox-panel-body'
    queue.forEach((msg: any, i: number) => {
      const card = document.createElement('div')
      card.className = 'inbox-msg'
      const urgentTag = msg.priority === 'urgent' ? `<span class="inbox-msg-urgent">🚨 紧急</span>` : ''
      const preview = (msg.text || '').trim()
      card.innerHTML = `
        <div class="inbox-msg-head">
          <span class="inbox-msg-from">${fromLabel(msg.from)}</span>
          ${urgentTag}
          <span class="inbox-msg-idx">${i + 1} / ${queue.length}</span>
        </div>
        <div class="inbox-msg-body"></div>`
      ;(card.querySelector('.inbox-msg-body') as HTMLElement).textContent = preview
      body.appendChild(card)
    })
    panel.appendChild(body)

    const foot = document.createElement('div')
    foot.className = 'inbox-panel-foot'
    const btnClose = document.createElement('button')
    btnClose.textContent = '关闭'
    btnClose.onclick = () => overlay.remove()
    const btnClear = document.createElement('button')
    btnClear.className = 'btn-clear'
    btnClear.textContent = `清空全部 ${queue.length} 条`
    btnClear.onclick = async () => { overlay.remove(); await clearInbox(role) }
    foot.appendChild(btnClose)
    foot.appendChild(btnClear)
    panel.appendChild(foot)

    overlay.appendChild(panel)
    document.body.appendChild(overlay)
    overlay.addEventListener('click', (e: MouseEvent) => { if (e.target === overlay) overlay.remove() })
  }

  archInboxBadge.addEventListener('click', () => showInboxQueue('arch'))
  devInboxBadge.addEventListener('click',  () => showInboxQueue('dev'))
  qaInboxBadge.addEventListener('click',   () => showInboxQueue('qa'))
  const archReconn    = document.getElementById('archReconnect')!
  const devReconn     = document.getElementById('devReconnect')!
  const qaReconn      = document.getElementById('qaReconnect')!
  const archRestartBtn = document.getElementById('archRestart') as HTMLButtonElement
  const devRestartBtn  = document.getElementById('devRestart') as HTMLButtonElement
  const qaRestartBtn   = document.getElementById('qaRestart') as HTMLButtonElement

  document.getElementById('archClear')!.addEventListener('click', () => archObj.term.clear())
  document.getElementById('devClear')!.addEventListener('click',  () => devObj.term.clear())
  document.getElementById('qaClear')!.addEventListener('click',   () => { ensureQaTerminal(); qaObj?.term.clear() })

  function showQuotaAdjust(role: string, anchorEl: HTMLElement) {
    document.getElementById('quotaAdjustPop')?.remove()
    const pop = document.createElement('div')
    pop.id = 'quotaAdjustPop'
    pop.style.cssText = 'position:fixed;z-index:9999;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:10px 12px;box-shadow:0 4px 16px rgba(0,0,0,.5);min-width:200px;font-size:12px;'
    const rect = anchorEl.getBoundingClientRect()
    pop.style.top = (rect.bottom + 4) + 'px'
    pop.style.left = rect.left + 'px'
    pop.innerHTML = `
      <div style="color:var(--text-dim);margin-bottom:8px;font-size:11px">Codex 重试时间</div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">
        <button class="qa-preset" data-ms="0">立即重试</button>
        <button class="qa-preset" data-ms="1800000">30 分钟</button>
        <button class="qa-preset" data-ms="3600000">1 小时</button>
        <button class="qa-preset" data-ms="7200000">2 小时</button>
        <button class="qa-preset" data-ms="14400000">4 小时</button>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <input id="qaCustomMin" type="number" min="0" placeholder="自定义分钟" style="width:100px;padding:3px 6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px">
        <button id="qaCustomOk" style="padding:3px 8px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px">确定</button>
      </div>`
    document.body.appendChild(pop)
    pop.querySelectorAll('.qa-preset').forEach((btn: Element) => {
      const b = btn as HTMLButtonElement
      b.style.cssText = 'padding:3px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;cursor:pointer;color:var(--text);font-size:12px'
      b.onmouseover = () => b.style.background = 'var(--bg3)'
      b.onmouseout  = () => b.style.background = 'var(--bg)'
      b.onclick = () => { applyQuotaRetry(role, parseInt((b as HTMLElement).dataset.ms || '0')); pop.remove() }
    })
    ;(pop.querySelector('#qaCustomOk') as HTMLElement).onclick = () => {
      const mins = parseFloat((pop.querySelector('#qaCustomMin') as HTMLInputElement).value)
      if (!isNaN(mins) && mins >= 0) { applyQuotaRetry(role, Math.round(mins * 60000)); pop.remove() }
    }
    setTimeout(() => document.addEventListener('click', function close(e: MouseEvent) {
      if (!pop.contains(e.target as Node) && e.target !== anchorEl) { pop.remove(); document.removeEventListener('click', close) }
    }), 50)
  }

  async function applyQuotaRetry(role: string, delayMs: number) {
    try {
      const r = await fetch(`/rooms/${roomId}/adjust-quota-retry`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, delayMs })
      })
      const d = await r.json()
      if (d.ok && delayMs > 0) {
        ;(window as any)[`_quotaRetryAt_${role}`] = d.retryAt
      }
    } catch(e) { console.error('quota retry adjust failed', e) }
  }

  async function restartRole(role: string, statusEl: HTMLElement | null) {
    if (statusEl) { statusEl.textContent = '⟳ 重启中…'; statusEl.style.color = 'var(--amber)' }
    try {
      const r = await fetch(`/rooms/${roomId}/restart-role`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role })
      })
      const d = await r.json()
      if (!d.ok && statusEl) { statusEl.textContent = '✗ 失败'; statusEl.style.color = 'var(--red)' }
    } catch(e) {
      if (statusEl) { statusEl.textContent = '✗ 出错'; statusEl.style.color = 'var(--red)' }
    }
  }

  function showModelPop(role: string, anchorEl: HTMLElement) {
    document.getElementById('_modelPop')?.remove()
    const room = currentRoom
    if (!room) return
    const curCli   = room[`${role}Cli`]   || 'claude'
    const curModel = room[`${role}Model`] || ''

    const pop = document.createElement('div')
    pop.id = '_modelPop'
    pop.className = 'model-pop'
    const rect = anchorEl.getBoundingClientRect()
    pop.style.top  = (rect.bottom + 4) + 'px'
    pop.style.left = rect.left + 'px'

    const cliLabel = document.createElement('div')
    cliLabel.style.cssText = 'color:var(--text-dim);font-size:10px;margin-bottom:3px'
    cliLabel.textContent = 'CLI'
    const cliSel = document.createElement('select')
    cliSel.style.cssText = 'width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 6px;font-size:11px;margin-bottom:6px;'
    ;[['claude','Claude Code'],['gemini','Gemini'],['codex','Codex'],['kimi','Kimi']].forEach(([v,l]) => {
      const o = document.createElement('option')
      o.value = v; o.textContent = l
      if (v === curCli) o.selected = true
      cliSel.appendChild(o)
    })

    const modelLabel_ = document.createElement('div')
    modelLabel_.style.cssText = 'color:var(--text-dim);font-size:10px;margin-bottom:3px'
    modelLabel_.textContent = '模型'
    const modelSel = document.createElement('select')
    modelSel.style.cssText = 'width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 6px;font-size:11px;margin-bottom:8px;'

    function repopulateModels(cli: string) {
      modelSel.innerHTML = ''
      ;(CLI_MODELS[cli] || []).forEach((m: any) => {
        const opt = document.createElement('option')
        opt.value = m.value; opt.textContent = m.label
        if (cli === curCli && m.value === curModel) opt.selected = true
        modelSel.appendChild(opt)
      })
    }
    repopulateModels(curCli)
    cliSel.addEventListener('change', () => repopulateModels(cliSel.value))

    const statusEl = role === 'arch' ? archStatus : role === 'qa' ? qaStatus : devStatus
    const btn = document.createElement('button')
    btn.textContent = '切换'
    btn.onclick = async () => {
      pop.remove()
      const newCli   = cliSel.value
      const newModel = modelSel.value
      if (statusEl) { statusEl.textContent = '⟳ 切换中…'; statusEl.style.color = 'var(--amber)' }
      try {
        await fetch(`/rooms/${roomId}/switch-model`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role, cli: newCli, model: newModel })
        })
      } catch(e) {
        if (statusEl) { statusEl.textContent = '✗ 出错'; statusEl.style.color = 'var(--red)' }
      }
    }

    pop.appendChild(cliLabel)
    pop.appendChild(cliSel)
    pop.appendChild(modelLabel_)
    pop.appendChild(modelSel)
    pop.appendChild(btn)
    document.body.appendChild(pop)
    const dismiss = (e: MouseEvent) => { if (!pop.contains(e.target as Node) && e.target !== anchorEl) { pop.remove(); document.removeEventListener('click', dismiss, true) } }
    setTimeout(() => document.addEventListener('click', dismiss, true), 10)
  }

  function connectPtyWs(obj: ReturnType<typeof createTerminal>, termId: string, statusEl: HTMLElement | null) {
    if (obj.ws) { try { obj.ws.close() } catch(e){} obj.ws = null }
    if (statusEl) statusEl.textContent = '⟳ 连接中…'
    const ws = new WebSocket(`ws://${location.host}/pty/` + termId)
    ws.binaryType = 'arraybuffer'
    obj.ws = ws
    ws.onopen = () => {
      try { obj.fitAddon.fit() } catch(e) {}
      ws.send(JSON.stringify({ type: 'resize', cols: obj.term.cols, rows: obj.term.rows }))
      if (statusEl) statusEl.textContent = '● connected'
      let firstMsg = true
      ws.onmessage = (evt: MessageEvent) => {
        obj.term.write(evt.data instanceof ArrayBuffer ? new Uint8Array(evt.data) : evt.data)
        if (obj.term.buffer.active.type === 'alternate') obj.term.scrollToBottom()
        if (firstMsg) {
          firstMsg = false
          setTimeout(() => {
            obj.term.write('\x1b[?2004h')
            obj.term.focus()
          }, 150)
        }
      }
      ws.onclose = (evt: CloseEvent) => { obj.ws = null; if (statusEl) statusEl.textContent = evt.code === 4001 ? '○ 未启动' : '○ disconnected' }
    }
    ws.onclose = (evt: CloseEvent) => {
      obj.ws = null
      if (statusEl) statusEl.textContent = evt.code === 4001 ? '○ 未启动' : '○ disconnected'
    }
  }

  archReconn.addEventListener('click', () => connectPtyWs(archObj, ARCH_TERM_ID, archStatus))
  devReconn.addEventListener('click',  () => connectPtyWs(devObj,  DEV_TERM_ID,  devStatus))
  qaReconn.addEventListener('click',   () => { ensureQaTerminal(); connectPtyWs(qaObj!, QA_TERM_ID, qaStatus) })
  archRestartBtn.addEventListener('click', () => restartRole('arch', archStatus))
  devRestartBtn.addEventListener('click',  () => restartRole('dev',  devStatus))
  qaRestartBtn.addEventListener('click',   () => restartRole('qa',   qaStatus))
  document.getElementById('archModelBadge')!.addEventListener('click', (e) => showModelPop('arch', e.currentTarget as HTMLElement))
  document.getElementById('devModelBadge')!.addEventListener('click',  (e) => showModelPop('dev',  e.currentTarget as HTMLElement))
  document.getElementById('qaModelBadge')!.addEventListener('click',   (e) => showModelPop('qa',   e.currentTarget as HTMLElement))

  // ── Event WS ──────────────────────────────────────────────────────────────
  const statusDot   = document.getElementById('statusDot')!
  const statusLabel = document.getElementById('statusLabel')!
  let eventWs: WebSocket | null = null
  function connectEventWs() {
    if (eventWs) { try { eventWs.close() } catch(e){} }
    eventWs = new WebSocket(`ws://${location.host}`)
    eventWs.onopen  = () => { statusDot.classList.add('on'); statusLabel.textContent = 'Connected' }
    eventWs.onclose = () => { statusDot.classList.remove('on'); statusLabel.textContent = 'Disconnected'; setTimeout(connectEventWs, 3000) }
    eventWs.onmessage = (evt: MessageEvent) => {
      try {
        const d = JSON.parse(evt.data)
        if (d.type === 'inbox_queued' && d.roomId === roomId) {
          const role = d.to.endsWith('-arch') ? 'arch' : d.to.endsWith('-qa') ? 'qa' : 'dev'
          updateInboxBadge(role, d.queueLen, d.priority === 'urgent')
          showInboxBadge(d.from, d.to, d.queueLen, d.priority)
        }
        if (d.type === 'inbox_delivered' && d.roomId === roomId) {
          const role = d.to.endsWith('-arch') ? 'arch' : d.to.endsWith('-qa') ? 'qa' : 'dev'
          updateInboxBadge(role, 0, false)
          showInboxBadge(d.from, d.to, 0, 'normal')
        }
        if (d.type === 'inbox_cleared' && d.roomId === roomId) {
          const roles: string[] = d.role === 'all' ? ['arch', 'dev', 'qa'] : [d.role]
          roles.forEach(r => updateInboxBadge(r, 0, false))
        }
        if (d.type === 'pty_exited') {
          if (d.termId === ARCH_TERM_ID) archStatus.textContent = '○ exited'
          if (d.termId === DEV_TERM_ID)  devStatus.textContent  = '○ exited'
          if (d.termId === QA_TERM_ID)   qaStatus.textContent   = '○ exited'
        }
        if (d.type === 'agent_exited' && d.roomId === roomId) {
          const statusEl = d.role === 'arch' ? archStatus : d.role === 'qa' ? qaStatus : devStatus
          statusEl.textContent = d.restarting ? '⟳ 重启中…' : '⚠ 已退出'; statusEl.style.color = 'var(--amber)'
        }
        if (d.type === 'agent_restarted' && d.roomId === roomId) {
          const statusEl = d.role === 'arch' ? archStatus : d.role === 'qa' ? qaStatus : devStatus
          statusEl.textContent = '● connected'; statusEl.style.color = ''; statusEl.style.cursor = ''; (statusEl as any).onclick = null; statusEl.title = ''
          const timerKey = `_quotaTimer_${d.role}`
          if ((window as any)[timerKey]) { clearInterval((window as any)[timerKey]); (window as any)[timerKey] = null }
          ;(window as any)[`_quotaRetryAt_${d.role}`] = null
        }
        if (d.type === 'agent_quota_exceeded' && d.roomId === roomId) {
          const statusEl = d.role === 'arch' ? archStatus : d.role === 'qa' ? qaStatus : devStatus
          const timerKey = `_quotaTimer_${d.role}`
          const retryAtKey = `_quotaRetryAt_${d.role}`
          if ((window as any)[timerKey]) clearInterval((window as any)[timerKey])
          ;(window as any)[retryAtKey] = d.retryAt
          const updateCountdown = () => {
            const retryAt = (window as any)[retryAtKey] || 0
            const ms = Math.max(0, retryAt - Date.now())
            const h  = Math.floor(ms / 3600000)
            const m  = Math.floor((ms % 3600000) / 60000)
            const s  = Math.floor((ms % 60000) / 1000)
            const ts = h > 0 ? `${h}h${m.toString().padStart(2,'0')}m` : `${m}:${s.toString().padStart(2,'0')}`
            statusEl.textContent = `⏰ 额度用尽 (${ts}) ✎`; statusEl.style.color = 'var(--amber)'; statusEl.style.cursor = 'pointer'; statusEl.title = '点击调整重试时间'
            if (ms === 0 && (window as any)[timerKey]) { clearInterval((window as any)[timerKey]); (window as any)[timerKey] = null }
          }
          updateCountdown()
          ;(window as any)[timerKey] = setInterval(updateCountdown, 1000)
          ;(statusEl as any).onclick = () => showQuotaAdjust(d.role, statusEl)
        }
        if (d.type === 'watchdog_status' && d.roomId === roomId) {
          setWatchdogUI(d.enabled)
        }
        if (d.type === 'watchdog_triggered' && d.roomId === roomId) {
          const parts = (d.issues as any[]).map(i => {
            const who = i.role === 'arch' ? '产品架构师' : i.role === 'qa' ? 'QA' : '开发者'
            if (i.issue === 'exited') return `${who} 进程已退出`
            if (i.issue === 'idle')   return `${who} 停滞 ${i.idleMin}min`
            return `${who} ${i.issue}`
          })
          showWatchdogBadge('⏱ ' + parts.join(' / '), false)
        }
        if (d.type === 'watchdog_done' && d.roomId === roomId) {
          setWatchdogUI(false)
          showWatchdogBadge('✓ 任务已完成，Watchdog 已停止', true)
        }
        if (d.type === 'comm_status' || d.type === 'comm_message_received' || d.type === 'comm_sent') {
          if (typeof onCommEvent === 'function') onCommEvent(d)
        }
        if (d.type === 'session_captured' && d.roomId === roomId) {
          if (currentRoom) currentRoom[`${d.role}SessionId`] = d.sessionId
        }
        if (d.type === 'model_switched' && d.roomId === roomId) {
          const badge = d.role === 'arch' ? archModelBadge : d.role === 'qa' ? qaModelBadge : devModelBadge
          setModelBadge(badge, d.model, d.cli || 'claude')
          const restartBtn = d.role === 'arch' ? archRestartBtn : d.role === 'qa' ? qaRestartBtn : devRestartBtn
          if (restartBtn) restartBtn.style.display = ['kimi','codex'].includes(d.cli || 'claude') ? '' : 'none'
          if (d.role === 'qa') ensureQaTerminal()
          const termId_  = roomId + '-' + d.role
          const obj_     = d.role === 'arch' ? archObj : d.role === 'qa' ? qaObj! : devObj
          const statusEl = d.role === 'arch' ? archStatus : d.role === 'qa' ? qaStatus : devStatus
          setTimeout(() => connectPtyWs(obj_, termId_, statusEl), 1500)
          const roleLabel = d.role === 'arch' ? 'PA' : d.role === 'qa' ? 'QA' : 'Dev'
          const shortModel = modelLabel(d.model) || 'Sonnet'
          showInboxBadge('system', roomId + '-' + d.role, 0, 'normal')
          inboxBadge.textContent = `${roleLabel} → ${shortModel} ↺`
          inboxBadge.style.display = 'inline-block'
          clearTimeout(inboxBadgeTimer!)
          inboxBadgeTimer = setTimeout(() => { inboxBadge.style.display = 'none' }, 5000)
        }
      } catch {}
    }
  }

  // ── Room name editing ──────────────────────────────────────────────────────
  const roomNameDisplay = document.getElementById('roomNameDisplay')!
  const roomNameInput   = document.getElementById('roomNameInput') as HTMLInputElement
  const archDirDisplay  = document.getElementById('archDirDisplay')!
  const devDirDisplay   = document.getElementById('devDirDisplay')!
  const qaDirDisplay    = document.getElementById('qaDirDisplay')!
  const archDirHdr      = document.getElementById('archDirHdr')!
  const devDirHdr       = document.getElementById('devDirHdr')!
  const qaDirHdr        = document.getElementById('qaDirHdr')!

  // Show/hide a role's terminal panel, header dir chip, and mobile tab.
  function applyRoleVisibility(role: string, enabled: boolean) {
    roleEnabled[role] = enabled
    const panel = document.getElementById(role + 'Panel')
    if (panel) panel.style.display = enabled ? (mobileQuery.matches ? 'none' : 'flex') : 'none'
    const hdr = role === 'arch' ? archDirHdr : role === 'dev' ? devDirHdr : qaDirHdr
    if (hdr) hdr.style.display = enabled ? 'flex' : 'none'
    const mtab = document.querySelector(`#mobileTabs .mobile-tab[data-panel="${role}"]`) as HTMLElement | null
    if (mtab) mtab.style.display = enabled ? '' : 'none'
  }

  let currentRoom: any = null
  async function loadRoom() {
    try {
      const rooms = await fetch('/rooms').then(r => r.json())
      currentRoom = rooms.find((r: any) => r.id === roomId)
      if (!currentRoom) { alert('Room not found'); location.href = '/'; return null }
      roomNameDisplay.textContent = currentRoom.name
      setTitle('Supervisor — ' + currentRoom.name)
      const loadedArchCli = currentRoom.archCli || 'claude'
      const loadedDevCli  = currentRoom.devCli  || 'claude'
      archCliSelect.value = loadedArchCli
      devCliSelect.value  = loadedDevCli
      populateModelSelect(archModelSelect, loadedArchCli, currentRoom.archModel)
      populateModelSelect(devModelSelect,  loadedDevCli,  currentRoom.devModel)
      setModelBadge(archModelBadge, currentRoom.archModel, loadedArchCli)
      setModelBadge(devModelBadge,  currentRoom.devModel,  loadedDevCli)
      setWatchdogUI(currentRoom.watchdogEnabled || false)

      if (currentRoom.archDir) {
        archDirDisplay.textContent = currentRoom.archDir
        archDirInput.value    = currentRoom.archDir
        archSilentChk.checked = currentRoom.archSilent
        archRestartBtn.style.display = ''
        applyRoleVisibility('arch', true)
      } else {
        archDirInput.value = ''
        applyRoleVisibility('arch', false)
      }

      if (currentRoom.devDir) {
        devDirDisplay.textContent = currentRoom.devDir
        devDirInput.value    = currentRoom.devDir
        devSilentChk.checked = currentRoom.devSilent
        devRestartBtn.style.display = ''
        applyRoleVisibility('dev', true)
      } else {
        devDirInput.value = ''
        applyRoleVisibility('dev', false)
      }

      if (currentRoom.qaDir) {
        qaDirDisplay.textContent = currentRoom.qaDir
        showQaMobileTab()
        qaDirInput.value    = currentRoom.qaDir
        qaSilentChk.checked = currentRoom.qaSilent || false
        const loadedQaCli = currentRoom.qaCli || 'claude'
        qaCliSelect.value = loadedQaCli
        populateModelSelect(qaModelSelect, loadedQaCli, currentRoom.qaModel)
        setModelBadge(qaModelBadge, currentRoom.qaModel, loadedQaCli)
        qaRestartBtn.style.display = ''
        applyRoleVisibility('qa', true)
      } else {
        qaDirInput.value = ''
        applyRoleVisibility('qa', false)
      }

      // Relay buttons only make sense when both endpoints are enabled.
      document.getElementById('devToArchBtn')!.style.display =
        (currentRoom.archDir && currentRoom.devDir) ? '' : 'none'
      document.getElementById('devToQaBtn')!.style.display =
        (currentRoom.devDir && currentRoom.qaDir) ? '' : 'none'

      if (currentRoom.archSessionId) selectedArch = currentRoom.archSessionId
      if (currentRoom.devSessionId)  selectedDev  = currentRoom.devSessionId
      if (currentRoom.qaSessionId)   selectedQa   = currentRoom.qaSessionId

      return currentRoom
    } catch { return null }
  }

  roomNameDisplay.addEventListener('click', () => {
    roomNameInput.value = roomNameDisplay.textContent || ''
    roomNameDisplay.style.display = 'none'
    roomNameInput.style.display = 'block'
    roomNameInput.focus(); roomNameInput.select()
  })
  async function saveRoomName() {
    const name = roomNameInput.value.trim() || currentRoom?.name || 'Room'
    roomNameDisplay.textContent = name
    roomNameInput.style.display = 'none'
    roomNameDisplay.style.display = ''
    if (name !== currentRoom?.name) {
      await fetch('/rooms/' + roomId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).catch(() => {})
      if (currentRoom) currentRoom.name = name
      setTitle('Supervisor — ' + name)
    }
  }
  roomNameInput.addEventListener('blur', saveRoomName)
  roomNameInput.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') roomNameInput.blur(); if (e.key === 'Escape') { roomNameInput.style.display = 'none'; roomNameDisplay.style.display = '' } })

  // When embedded in the shell iframe, the left tab bar is the navigation —
  // hide the in-page back button (it would otherwise nest the shell inside the iframe).
  const backBtn = document.getElementById('backBtn')!
  if (window.parent !== window.self) backBtn.style.display = 'none'
  else backBtn.addEventListener('click', () => { location.href = '/' })

  // ── Session picker ─────────────────────────────────────────────────────────
  const connectBtn      = document.getElementById('connectBtn')!
  const sessionPicker   = document.getElementById('sessionPicker')!
  const archSessionList = document.getElementById('archSessionList')!
  const devSessionListEl= document.getElementById('devSessionList')!
  const qaSessionListEl = document.getElementById('qaSessionList')!
  const archDirInput    = document.getElementById('archDirInput') as HTMLInputElement
  const devDirInput     = document.getElementById('devDirInput') as HTMLInputElement
  const qaDirInput      = document.getElementById('qaDirInput') as HTMLInputElement
  const archSilentChk   = document.getElementById('archSilentChk') as HTMLInputElement
  const devSilentChk    = document.getElementById('devSilentChk') as HTMLInputElement
  const qaSilentChk     = document.getElementById('qaSilentChk') as HTMLInputElement
  const archModelSelect = document.getElementById('archModelSelect') as HTMLSelectElement
  const devModelSelect  = document.getElementById('devModelSelect') as HTMLSelectElement
  const qaModelSelect   = document.getElementById('qaModelSelect') as HTMLSelectElement
  const archCliSelect   = document.getElementById('archCliSelect') as HTMLSelectElement
  const devCliSelect    = document.getElementById('devCliSelect') as HTMLSelectElement
  const qaCliSelect     = document.getElementById('qaCliSelect') as HTMLSelectElement
  const archModelBadge  = document.getElementById('archModelBadge')!
  const devModelBadge   = document.getElementById('devModelBadge')!
  const qaModelBadge    = document.getElementById('qaModelBadge')!
  const newArchBtn      = document.getElementById('newArchBtn')!
  const newDevBtn       = document.getElementById('newDevBtn')!
  const newQaBtn        = document.getElementById('newQaBtn')!
  const startBtn        = document.getElementById('startBtn') as HTMLButtonElement

  const CLI_MODELS: Record<string, { value: string; label: string }[]> = {
    claude: [
      { value: 'claude-sonnet-4-6',        label: 'Sonnet 4.6' },
      { value: 'claude-opus-4-8',           label: 'Opus 4.8'   },
      { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5'  },
    ],
    gemini: [
      { value: 'gemini-2.5-flash',        label: '2.5 Flash'        },
      { value: 'gemini-2.5-flash-lite',   label: '2.5 Flash Lite'   },
      { value: 'gemini-2.5-pro',          label: '2.5 Pro'          },
      { value: 'gemini-3-flash-preview',  label: '3 Flash Preview'  },
      { value: 'gemini-3-pro-preview',    label: '3 Pro Preview'    },
      { value: 'gemini-3.1-pro-preview',  label: '3.1 Pro Preview'  },
    ],
    codex: [
      { value: 'gpt-5.5',     label: 'GPT-5.5'      },
      { value: 'gpt-5.5-pro', label: 'GPT-5.5 Pro'  },
      { value: 'gpt-5.4',     label: 'GPT-5.4'      },
      { value: 'gpt-5.4-mini',label: 'GPT-5.4 Mini' },
      { value: 'o4-mini',     label: 'o4-mini'       },
      { value: 'o3',          label: 'o3'            },
    ],
    kimi: [
      { value: 'kimi-for-coding',   label: 'Kimi for Coding' },
      { value: 'kimi-k2.6',         label: 'k2.6'            },
      { value: 'kimi-k2.5',         label: 'k2.5'            },
      { value: 'moonshot-v1-8k',    label: 'v1-8k'           },
      { value: 'moonshot-v1-32k',   label: 'v1-32k'          },
      { value: 'moonshot-v1-128k',  label: 'v1-128k'         },
    ],
  }

  function populateModelSelect(modelSelectEl: HTMLSelectElement, cliName: string, currentModel: string | null) {
    const models = CLI_MODELS[cliName] || CLI_MODELS.claude
    modelSelectEl.innerHTML = ''
    for (const m of models) {
      const opt = document.createElement('option')
      opt.value = m.value; opt.textContent = m.label
      modelSelectEl.appendChild(opt)
    }
    if (currentModel && models.some(m => m.value === currentModel)) modelSelectEl.value = currentModel
    else modelSelectEl.value = models[0].value
  }

  function modelLabel(model: string | null | undefined, cli?: string): string {
    if (!model) return (cli && cli !== 'claude') ? cli.charAt(0).toUpperCase() + cli.slice(1) : ''
    if (cli === 'gemini') {
      const m = (CLI_MODELS.gemini || []).find(x => x.value === model)
      return m ? m.label : 'Gemini'
    }
    if (cli === 'codex') {
      const m = (CLI_MODELS.codex || []).find(x => x.value === model)
      return m ? m.label : 'Codex'
    }
    if (cli === 'kimi') {
      const m = (CLI_MODELS.kimi || []).find(x => x.value === model)
      return m ? m.label : 'Kimi'
    }
    if (model === 'claude-sonnet-4-6') return 'Sonnet'
    if (model.includes('opus'))  return 'Opus'
    if (model.includes('haiku')) return 'Haiku'
    return model.split('-').pop() || model
  }

  function setModelBadge(badge: HTMLElement, model: string | null | undefined, cli: string) {
    const label = modelLabel(model, cli)
    badge.textContent = label ? `[${label}]` : ''
    badge.title = '点击切换模型'
    const isOpus      = model && model.includes('opus')
    const isNonClaude = cli && cli !== 'claude'
    badge.style.color = isNonClaude ? 'var(--purple)' : isOpus ? 'var(--amber)' : 'var(--text-dim)'
  }

  let selectedArch: string | null = null
  let selectedDev:  string | null = null
  let selectedQa:   string | null = null

  let _archDirTimer: ReturnType<typeof setTimeout> | null = null
  let _devDirTimer:  ReturnType<typeof setTimeout> | null = null
  let _qaDirTimer:   ReturnType<typeof setTimeout> | null = null
  archDirInput.addEventListener('input', () => {
    selectedArch = null; updateStartBtn()
    clearTimeout(_archDirTimer!)
    _archDirTimer = setTimeout(() => loadSessionsFor('arch', archDirInput.value.trim()), 400)
  })
  devDirInput.addEventListener('input', () => {
    selectedDev = null; updateStartBtn()
    clearTimeout(_devDirTimer!)
    _devDirTimer = setTimeout(() => loadSessionsFor('dev', devDirInput.value.trim()), 400)
  })
  qaDirInput.addEventListener('input', () => {
    selectedQa = null; updateStartBtn()
    clearTimeout(_qaDirTimer!)
    _qaDirTimer = setTimeout(() => loadSessionsFor('qa', qaDirInput.value.trim()), 400)
  })

  function updateStartBtn() {
    const parts: string[] = []
    if (archDirInput.value.trim()) parts.push(`PA: ${selectedArch ? selectedArch.slice(0, 8) + '…' : '新建'}`)
    if (devDirInput.value.trim())  parts.push(`Dev: ${selectedDev ? selectedDev.slice(0, 8) + '…' : '新建'}`)
    if (qaDirInput.value.trim())   parts.push(`QA: ${selectedQa ? selectedQa.slice(0, 8) + '…' : '新建'}`)
    startBtn.disabled = parts.length === 0
    startBtn.textContent = parts.length ? `开始  (${parts.join('  /  ')})` : '开始  (请至少填写一个目录)'
  }
  archCliSelect.addEventListener('change', () => { populateModelSelect(archModelSelect, archCliSelect.value, null); updateStartBtn(); if (sessionPicker.style.display !== 'none') loadSessionsFor('arch', archDirInput.value.trim()) })
  devCliSelect.addEventListener('change',  () => { populateModelSelect(devModelSelect,  devCliSelect.value,  null); updateStartBtn(); if (sessionPicker.style.display !== 'none') loadSessionsFor('dev',  devDirInput.value.trim()) })
  qaCliSelect.addEventListener('change',   () => { populateModelSelect(qaModelSelect,   qaCliSelect.value,   null); updateStartBtn(); if (sessionPicker.style.display !== 'none') loadSessionsFor('qa',   qaDirInput.value.trim()) })
  archSilentChk.addEventListener('change', updateStartBtn)
  devSilentChk.addEventListener('change',  updateStartBtn)
  qaSilentChk.addEventListener('change',   updateStartBtn)

  function buildSessionItem(s: any, role: string) {
    const item = document.createElement('div')
    item.className = 'session-item'
    const dateStr = s.lastTs ? new Date(s.lastTs).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : ''
    item.innerHTML = `<div class="session-item-text"><div class="session-item-first">${escHtml(s.firstPrompt || '(无标题)')}</div><div class="session-item-last">${dateStr ? escHtml(dateStr) + ' · ' : ''}${escHtml(s.lastPrompt || '-')}</div></div>`
    item.addEventListener('click', () => {
      const col = role === 'arch' ? archSessionList : role === 'qa' ? qaSessionListEl : devSessionListEl
      col.querySelectorAll('.session-item').forEach((el: Element) => el.classList.remove('selected-arch', 'selected-dev', 'selected-qa'))
      item.classList.add(role === 'arch' ? 'selected-arch' : role === 'qa' ? 'selected-qa' : 'selected-dev')
      if (role === 'arch') selectedArch = s.sessionId
      else if (role === 'qa') selectedQa = s.sessionId
      else selectedDev = s.sessionId
      updateStartBtn()
    })
    return item
  }

  async function loadSessionsFor(role: string, dir: string) {
    const listEl = role === 'arch' ? archSessionList : role === 'qa' ? qaSessionListEl : devSessionListEl
    if (!dir) { listEl.innerHTML = '<div style="color:var(--text-dim);font-size:11px;padding:4px 0">请输入目录</div>'; return }
    const cliSel = role === 'arch' ? archCliSelect : role === 'qa' ? qaCliSelect : devCliSelect
    const cli = cliSel.value || 'claude'
    if (cli !== 'claude' && cli !== 'kimi' && cli !== 'codex') {
      listEl.innerHTML = '<div style="color:var(--text-dim);font-size:11px;padding:4px 0">当前 CLI 不支持历史会话（将新建）</div>'
      if (role === 'arch') selectedArch = null
      else if (role === 'qa') selectedQa = null
      else selectedDev = null
      updateStartBtn()
      return
    }
    listEl.innerHTML = '<div style="color:var(--text-dim);font-size:11px;padding:4px">加载中…</div>'
    updateStartBtn()
    try {
      const list = await fetch('/sessions?projectDir=' + encodeURIComponent(dir) + '&cli=' + cli).then(r => r.json())
      listEl.innerHTML = ''
      const savedId = role === 'arch' ? currentRoom?.archSessionId : role === 'qa' ? currentRoom?.qaSessionId : currentRoom?.devSessionId
      if (!list.length) {
        listEl.innerHTML = '<div style="color:var(--text-dim);font-size:11px;padding:4px 0">暂无历史会话</div>'
      } else {
        list.forEach((s: any) => {
          const item = buildSessionItem(s, role)
          if (savedId && s.sessionId === savedId) {
            item.classList.add(role === 'arch' ? 'selected-arch' : role === 'qa' ? 'selected-qa' : 'selected-dev')
            const lastEl = item.querySelector('.session-item-last') as HTMLElement
            lastEl.textContent = '(上次使用) · ' + (lastEl.textContent || '')
            if (role === 'arch') selectedArch = s.sessionId
            else if (role === 'qa') selectedQa = s.sessionId
            else selectedDev = s.sessionId
          }
          listEl.appendChild(item)
        })
        if (savedId && !list.some((s: any) => s.sessionId === savedId)) {
          const warn = document.createElement('div')
          warn.style.cssText = 'color:var(--amber);font-size:10px;padding:3px 0'
          warn.textContent = '⚠ 上次会话不存在，将新建'
          listEl.prepend(warn)
        }
      }
      updateStartBtn()
    } catch { listEl.innerHTML = '<div style="color:#f85149;font-size:11px">加载失败</div>' }
  }

  connectBtn.addEventListener('click', () => {
    selectedArch = currentRoom?.archSessionId || null
    selectedDev  = currentRoom?.devSessionId  || null
    selectedQa   = currentRoom?.qaSessionId   || null
    updateStartBtn()
    if (archDirInput.value.trim()) loadSessionsFor('arch', archDirInput.value.trim())
    if (devDirInput.value.trim())  loadSessionsFor('dev',  devDirInput.value.trim())
    if (qaDirInput.value.trim())   loadSessionsFor('qa',   qaDirInput.value.trim())
    sessionPicker.style.display = 'flex'
  })
  sessionPicker.addEventListener('click', (e: MouseEvent) => { if (e.target === sessionPicker) sessionPicker.style.display = 'none' })
  newArchBtn.addEventListener('click', () => { archSessionList.querySelectorAll('.session-item').forEach((el: Element) => el.classList.remove('selected-arch')); selectedArch = null; updateStartBtn() })
  newDevBtn.addEventListener('click',  () => { devSessionListEl.querySelectorAll('.session-item').forEach((el: Element) => el.classList.remove('selected-dev')); selectedDev  = null; updateStartBtn() })
  newQaBtn.addEventListener('click',   () => { qaSessionListEl.querySelectorAll('.session-item').forEach((el: Element) => el.classList.remove('selected-qa'));  selectedQa   = null; updateStartBtn() })

  startBtn.addEventListener('click', async () => {
    const archDir = archDirInput.value.trim()
    const devDir  = devDirInput.value.trim()
    const qaDir   = qaDirInput.value.trim() || null
    if (!archDir && !devDir && !qaDir) { alert('请至少填写一个角色的目录'); return }

    // Apply per-role visibility from the chosen dirs.
    applyRoleVisibility('arch', !!archDir)
    applyRoleVisibility('dev',  !!devDir)
    if (archDir) archDirDisplay.textContent = archDir
    if (devDir)  devDirDisplay.textContent  = devDir
    if (qaDir) {
      ensureQaTerminal()
      qaDirDisplay.textContent = qaDir
      showQaMobileTab()
      applyRoleVisibility('qa', true)
    } else {
      applyRoleVisibility('qa', false)
    }
    document.getElementById('devToArchBtn')!.style.display = (archDir && devDir) ? '' : 'none'
    document.getElementById('devToQaBtn')!.style.display = (devDir && qaDir) ? '' : 'none'

    sessionPicker.style.display = 'none'
    applyMobileLayout()
    if (archDir) { archObj.term.focus(); try { archObj.fitAddon.fit() } catch(e) {} }
    else if (devDir) { devObj.term.focus() }
    if (devDir) { try { devObj.fitAddon.fit()  } catch(e) {} }
    if (qaDir) { try { qaObj!.fitAddon.fit() } catch(e) {} }

    const dirChanged = currentRoom && (
      archDir !== (currentRoom.archDir || '') || devDir !== (currentRoom.devDir || '') ||
      archSilentChk.checked !== currentRoom.archSilent || devSilentChk.checked !== currentRoom.devSilent ||
      qaDir !== (currentRoom.qaDir || null) || qaSilentChk.checked !== (currentRoom.qaSilent || false) ||
      archCliSelect.value !== (currentRoom.archCli || 'claude') ||
      devCliSelect.value  !== (currentRoom.devCli  || 'claude') ||
      qaCliSelect.value   !== (currentRoom.qaCli   || 'claude')
    )
    if (dirChanged) {
      await fetch('/rooms/' + roomId, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          archDir, devDir, qaDir,
          archSilent: archSilentChk.checked, devSilent: devSilentChk.checked, qaSilent: qaSilentChk.checked,
          archCli: archCliSelect.value, devCli: devCliSelect.value, qaCli: qaCliSelect.value,
        }),
      }).catch(() => {})
      if (currentRoom) { currentRoom.archDir = archDir || null; currentRoom.devDir = devDir || null; currentRoom.qaDir = qaDir; currentRoom.archCli = archCliSelect.value; currentRoom.devCli = devCliSelect.value; currentRoom.qaCli = qaCliSelect.value }
    }
    const enabledObjs = [archDir && archObj, devDir && devObj, qaDir && qaObj].filter(Boolean) as ReturnType<typeof createTerminal>[]
    const cols = enabledObjs.length ? Math.min(...enabledObjs.map(o => o.term.cols)) : 80
    const rows = enabledObjs.length ? Math.min(...enabledObjs.map(o => o.term.rows)) : 24

    try {
      const r = await fetch('/rooms/' + roomId + '/spawn', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archSessionId: selectedArch || null, devSessionId: selectedDev || null, qaSessionId: selectedQa || null, archModel: archModelSelect.value, devModel: devModelSelect.value, qaModel: qaModelSelect.value, archCli: archCliSelect.value, devCli: devCliSelect.value, qaCli: qaCliSelect.value, cols, rows }),
      })
      if (!r.ok) { const err = await r.json().catch(() => ({})); throw new Error(err.error || r.statusText) }
    } catch (e: any) {
      sessionPicker.style.display = 'flex'
      alert('启动失败: ' + e.message); return
    }
    // Sync currentRoom session IDs so Session Picker pre-selects correctly next time.
    // For "新建" (null), session_captured WS event will update it once the new session is detected.
    if (currentRoom) {
      currentRoom.archSessionId = selectedArch
      currentRoom.devSessionId  = selectedDev
      currentRoom.qaSessionId   = selectedQa
    }
    if (archDir) connectPtyWs(archObj, ARCH_TERM_ID, archStatus)
    if (devDir)  connectPtyWs(devObj,  DEV_TERM_ID,  devStatus)
    if (qaDir)   connectPtyWs(qaObj!,  QA_TERM_ID,   qaStatus)
  })

  // ── Relay bar ──────────────────────────────────────────────────────────────
  const inboxBadge    = document.getElementById('inboxBadge')!
  const devToArchBtn  = document.getElementById('devToArchBtn')!
  const devToQaBtn    = document.getElementById('devToQaBtn')!
  const watchdogBtn   = document.getElementById('watchdogBtn')!
  const watchdogBadge = document.getElementById('watchdogBadge')!
  let inboxBadgeTimer:    ReturnType<typeof setTimeout> | null = null
  let watchdogBadgeTimer: ReturnType<typeof setTimeout> | null = null
  let watchdogActive = false

  function showInboxBadge(from: string, to: string, queueLen: number, priority: string) {
    clearTimeout(inboxBadgeTimer!)
    const fromRole = from === 'arch' ? 'PA' : from === 'qa' ? 'QA' : from === 'dev' ? 'Dev' : from
    const toRole   = to.endsWith('-arch') ? 'PA' : to.endsWith('-qa') ? 'QA' : 'Dev'
    const urgentTag = priority === 'urgent' ? ' 🚨' : ''
    const arrow    = `${fromRole} → ${toRole}${urgentTag}`
    inboxBadge.textContent = queueLen ? `${arrow} (queued: ${queueLen})` : `${arrow} ✓`
    inboxBadge.style.display = 'inline-block'
    inboxBadgeTimer = setTimeout(() => { inboxBadge.style.display = 'none' }, priority === 'urgent' ? 8000 : 4000)
  }

  function flashBtn(btn: HTMLElement, ok: boolean) {
    btn.classList.add(ok ? 'ok' : 'err')
    setTimeout(() => btn.classList.remove('ok', 'err'), 1400)
  }

  function setWatchdogUI(enabled: boolean) {
    watchdogActive = enabled
    watchdogBtn.textContent = enabled ? '⏱ 监控中 ⏹' : '⏱ Watchdog'
    watchdogBtn.classList.toggle('active', enabled)
  }

  watchdogBtn.addEventListener('click', async () => {
    const next = !watchdogActive
    try {
      const r = await fetch('/rooms/' + roomId + '/watchdog', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      if (r.ok) setWatchdogUI(next)
    } catch {}
  })

  function showWatchdogBadge(msg: string, isDone: boolean) {
    clearTimeout(watchdogBadgeTimer!)
    watchdogBadge.textContent = msg
    watchdogBadge.className = isDone ? 'done' : ''
    watchdogBadge.style.display = 'inline-block'
    watchdogBadgeTimer = setTimeout(() => { watchdogBadge.style.display = 'none' }, 8000)
  }

  devToArchBtn.addEventListener('click', async () => {
    try {
      const { text } = await fetch('/pty/buffer?termId=' + DEV_TERM_ID).then(r => r.json())
      if (!text.trim()) { flashBtn(devToArchBtn, false); return }
      const res = await fetch('/notify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: 'arch', from: 'dev', roomId, message: '[MANUAL REVIEW] Developer latest activity:\n' + text.trim().slice(-2000) }),
      })
      flashBtn(devToArchBtn, res.ok)
    } catch { flashBtn(devToArchBtn, false) }
  })

  devToQaBtn.addEventListener('click', async () => {
    try {
      const { text } = await fetch('/pty/buffer?termId=' + DEV_TERM_ID).then(r => r.json())
      if (!text.trim()) { flashBtn(devToQaBtn, false); return }
      const res = await fetch('/notify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: 'qa', from: 'arch', roomId, message: '[MANUAL QA REQUEST] Please test the Developer\'s recent work:\n' + text.trim().slice(-2000) }),
      })
      flashBtn(devToQaBtn, res.ok)
    } catch { flashBtn(devToQaBtn, false) }
  })

  // ── Memory panel ───────────────────────────────────────────────────────────
  const memoryBtn      = document.getElementById('memoryBtn')!
  const memoryPanel    = document.getElementById('memoryPanel')!
  const memoryTextarea = document.getElementById('memoryTextarea') as HTMLTextAreaElement
  const memorySaveBtn  = document.getElementById('memorySaveBtn') as HTMLButtonElement
  const memoryCloseBtn = document.getElementById('memoryCloseBtn')!
  const memoryDocsList = document.getElementById('memoryDocsList')!
  const memoryDot      = document.getElementById('memoryDot')!

  async function openMemoryPanel() {
    memoryPanel.style.display = 'flex'
    memoryTextarea.value = '加载中…'
    memoryDocsList.innerHTML = '<div class="mem-docs-empty">加载中…</div>'
    try {
      const [memRes, infoRes] = await Promise.all([
        fetch(`/rooms/${roomId}/memory`).then(r => r.json()),
        fetch(`/rooms/${roomId}/memory?info=1`).then(r => r.json()),
      ])
      memoryTextarea.value = memRes.content || ''
      memoryDot.style.display = memRes.content?.trim() ? 'block' : 'none'
      memoryDocsList.innerHTML = ''
      const { archFiles = [], devFiles = [] } = infoRes
      if (!archFiles.length && !devFiles.length) {
        memoryDocsList.innerHTML = '<div class="mem-docs-empty">未检测到 ai-docs 目录</div>'
      } else {
        if (archFiles.length) {
          const g = document.createElement('div'); g.className = 'mem-docs-group'
          g.innerHTML = `<div class="mem-docs-group-label">📁 archDir/ai-docs/</div>` +
            (archFiles as string[]).map(f => `<span class="mem-docs-file">${escHtml(f)}</span>`).join('')
          memoryDocsList.appendChild(g)
        }
        if (devFiles.length) {
          const g = document.createElement('div'); g.className = 'mem-docs-group'
          g.innerHTML = `<div class="mem-docs-group-label">📁 devDir/ai-docs/</div>` +
            (devFiles as string[]).map(f => `<span class="mem-docs-file">${escHtml(f)}</span>`).join('')
          memoryDocsList.appendChild(g)
        }
      }
    } catch { memoryTextarea.value = '加载失败' }
  }

  let _memoryAutoSaveTimer: ReturnType<typeof setTimeout> | null = null
  let _memoryLastEditAt    = 0
  let _memoryPollTimer: ReturnType<typeof setInterval> | null = null

  async function saveMemory(content: string) {
    await fetch(`/rooms/${roomId}/memory`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    memoryDot.style.display = content.trim() ? 'block' : 'none'
  }

  function startMemoryPoll() {
    if (_memoryPollTimer) return
    _memoryPollTimer = setInterval(async () => {
      if (Date.now() - _memoryLastEditAt < 3000) return
      try {
        const res = await fetch(`/rooms/${roomId}/memory`).then(r => r.json())
        if (res.content !== memoryTextarea.value) {
          memoryTextarea.value = res.content || ''
          memoryDot.style.display = res.content?.trim() ? 'block' : 'none'
        }
      } catch {}
    }, 3000)
  }

  function stopMemoryPoll() {
    if (_memoryPollTimer) { clearInterval(_memoryPollTimer); _memoryPollTimer = null }
  }

  memoryTextarea.addEventListener('input', () => {
    _memoryLastEditAt = Date.now()
    if (_memoryAutoSaveTimer) clearTimeout(_memoryAutoSaveTimer)
    memorySaveBtn.textContent = '保存'
    _memoryAutoSaveTimer = setTimeout(async () => {
      try {
        await saveMemory(memoryTextarea.value)
        memorySaveBtn.textContent = '✓ 已自动保存'
        setTimeout(() => { memorySaveBtn.textContent = '保存' }, 1500)
      } catch { memorySaveBtn.textContent = '保存' }
    }, 1000)
  })

  memoryBtn.addEventListener('click', () => { openMemoryPanel(); startMemoryPoll() })
  memoryCloseBtn.addEventListener('click', () => { memoryPanel.style.display = 'none'; stopMemoryPoll() })
  memoryPanel.addEventListener('click', (e: MouseEvent) => { if (e.target === memoryPanel) { memoryPanel.style.display = 'none'; stopMemoryPoll() } })

  memorySaveBtn.addEventListener('click', async () => {
    if (_memoryAutoSaveTimer) { clearTimeout(_memoryAutoSaveTimer); _memoryAutoSaveTimer = null }
    memorySaveBtn.textContent = '保存中…'; memorySaveBtn.disabled = true
    try {
      await saveMemory(memoryTextarea.value)
      memorySaveBtn.textContent = '✓ 已保存'
      setTimeout(() => { memorySaveBtn.textContent = '保存'; memorySaveBtn.disabled = false }, 1500)
    } catch {
      memorySaveBtn.textContent = '保存失败'
      setTimeout(() => { memorySaveBtn.textContent = '保存'; memorySaveBtn.disabled = false }, 1500)
    }
  })

  fetch(`/rooms/${roomId}/memory`).then(r => r.json()).then((d: any) => {
    if (d.content?.trim()) memoryDot.style.display = 'block'
  }).catch(() => {})

  // ── Comm panel ─────────────────────────────────────────────────────────────
  const commBtn            = document.getElementById('commBtn')!
  const commDot            = document.getElementById('commDot')!
  const commPanel          = document.getElementById('commPanel')!
  const commAdapterSelect  = document.getElementById('commAdapterSelect') as HTMLSelectElement
  const commAdapterSection = document.getElementById('commAdapterSection')!
  const commFeishuFields   = document.getElementById('commFeishuFields')!
  const commFeishuTypeField= document.getElementById('commFeishuTypeField')!
  const commEnvTip         = document.getElementById('commEnvTip')!
  const commReceiveIdInput = document.getElementById('commReceiveId') as HTMLInputElement
  const commReceiveIdType  = document.getElementById('commReceiveIdType') as HTMLSelectElement
  const commEnable         = document.getElementById('commEnable') as HTMLInputElement
  const commSaveBtn        = document.getElementById('commSaveBtn') as HTMLButtonElement
  const commCloseBtn       = document.getElementById('commCloseBtn')!
  const commStatusDot      = document.getElementById('commStatusDot')!
  const commStatusText     = document.getElementById('commStatusText')!
  const commReconnectBtn   = document.getElementById('commReconnectBtn') as HTMLButtonElement
  const commErrorMsg       = document.getElementById('commErrorMsg')!

  function setCommStatus(connected: boolean, busy: boolean, error: string | null) {
    commStatusDot.className = 'comm-dot ' + (busy ? 'comm-dot-busy' : connected ? 'comm-dot-on' : 'comm-dot-off')
    commStatusText.textContent = busy ? '连接中…' : connected ? '已连接' : '未连接'
    if (error) {
      commErrorMsg.textContent = error
      commErrorMsg.style.display = 'block'
    } else {
      commErrorMsg.style.display = 'none'
    }
    commDot.style.display = connected ? 'block' : 'none'
  }

  function applyAdapterFields(adapter: string) {
    const hasAdapter = !!adapter
    commAdapterSection.style.display = hasAdapter ? 'block' : 'none'
    const isFeishu = adapter === 'feishu'
    commFeishuFields.style.display    = isFeishu ? 'block' : 'none'
    commFeishuTypeField.style.display = isFeishu ? 'block' : 'none'
  }

  commAdapterSelect.addEventListener('change', () => applyAdapterFields(commAdapterSelect.value))

  async function openCommPanel() {
    commAdapterSection.style.display = 'none'
    setCommStatus(false, true, null)
    commEnvTip.style.display = 'none'
    commPanel.style.display = 'flex'
    try {
      const d = await fetch(`/rooms/${roomId}/comm`).then(r => r.json())
      commAdapterSelect.value  = d.commAdapter || ''
      commReceiveIdInput.value = d.commReceiveId || ''
      commReceiveIdType.value  = d.commReceiveIdType || 'chat_id'
      commEnable.checked       = !!d.commEnabled
      applyAdapterFields(d.commAdapter)
      const st = d.adapterStatus || {}
      setCommStatus(st.connected, false, st.error)
      if (st.hint) {
        commEnvTip.textContent = '⚠ ' + st.hint
        commEnvTip.style.display = 'block'
      } else {
        commEnvTip.style.display = 'none'
      }
    } catch { setCommStatus(false, false, '加载失败，请重试') }
  }

  commBtn.addEventListener('click', openCommPanel)
  commCloseBtn.addEventListener('click', () => { commPanel.style.display = 'none' })
  commPanel.addEventListener('click', (e: MouseEvent) => { if (e.target === commPanel) commPanel.style.display = 'none' })

  commSaveBtn.addEventListener('click', async () => {
    commSaveBtn.textContent = '保存中…'; commSaveBtn.disabled = true
    try {
      await fetch(`/rooms/${roomId}/comm`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commEnabled:       commEnable.checked,
          commAdapter:       commAdapterSelect.value || null,
          commReceiveId:     commReceiveIdInput.value.trim(),
          commReceiveIdType: commReceiveIdType.value,
        }),
      })
      commSaveBtn.textContent = '✓ 已保存'
      if (commEnable.checked) commDot.style.display = 'block'
      else commDot.style.display = 'none'
      setTimeout(() => { commSaveBtn.textContent = '保存'; commSaveBtn.disabled = false }, 1500)
    } catch {
      commSaveBtn.textContent = '保存失败'
      setTimeout(() => { commSaveBtn.textContent = '保存'; commSaveBtn.disabled = false }, 1500)
    }
  })

  commReconnectBtn.addEventListener('click', async () => {
    commReconnectBtn.disabled = true
    setCommStatus(false, true, null)
    try {
      await fetch(`/rooms/${roomId}/comm/connect`, { method: 'POST' })
      // keep showing "连接中…" — comm_status WebSocket event will update
    } catch (e: any) {
      setCommStatus(false, false, e.message)
      commReconnectBtn.disabled = false
    }
  })

  function onCommEvent(d: any) {
    if (d.type === 'comm_status') {
      if (commPanel.style.display !== 'none') {
        setCommStatus(d.connected, false, d.error || null)
      }
      commDot.style.display = d.connected ? 'block' : 'none'
      commReconnectBtn.disabled = false
    }
    if (d.type === 'comm_message_received' && d.roomId === roomId) {
      commBtn.classList.add('ok')
      setTimeout(() => commBtn.classList.remove('ok'), 2000)
    }
  }

  fetch(`/rooms/${roomId}/comm`).then(r => r.json()).then((d: any) => {
    if (d.commEnabled && d.adapterStatus?.connected) commDot.style.display = 'block'
  }).catch(() => {})

  // ── Init ───────────────────────────────────────────────────────────────────
  async function restoreInboxBadges() {
    const roles = ['arch', 'dev', 'qa']
    await Promise.all(roles.map(async (role: string) => {
      try {
        const d = await fetch(`/rooms/${roomId}/inbox?role=${role}`).then(r => r.json())
        const q = d.queue || []
        if (q.length) updateInboxBadge(role, q.length, q.some((m: any) => m.priority === 'urgent'))
      } catch {}
    }))
  }

  async function init() {
    const room = await loadRoom()
    restoreInboxBadges()
    connectEventWs()

    if (room?.archDir) {
      if (room?.archAlive) connectPtyWs(archObj, ARCH_TERM_ID, archStatus)
      else archStatus.textContent = '○ 未启动'
    }
    if (room?.devDir) {
      if (room?.devAlive) connectPtyWs(devObj, DEV_TERM_ID, devStatus)
      else devStatus.textContent = '○ 未启动'
    }
    if (room?.qaDir) {
      ensureQaTerminal()
      if (room?.qaAlive) connectPtyWs(qaObj!, QA_TERM_ID, qaStatus)
      else qaStatus.textContent = '○ 未启动'
    }

    const archLive = room?.archDir && room?.archAlive
    const devLive  = room?.devDir  && room?.devAlive
    const qaLive   = room?.qaDir   && room?.qaAlive
    if (archLive || devLive || qaLive) {
      setTimeout(() => {
        try { if (archLive) archObj.fitAddon.fit(); if (devLive) devObj.fitAddon.fit() } catch(e) {}
        if (qaLive) try { qaObj!.fitAddon.fit() } catch(e) {}
        ;(archLive ? archObj : devLive ? devObj : qaObj!)?.term.focus()
      }, 300)
    } else {
      // No enabled role is running → open the session picker to start.
      selectedArch = currentRoom?.archSessionId || null
      selectedDev  = currentRoom?.devSessionId  || null
      selectedQa   = currentRoom?.qaSessionId   || null
      updateStartBtn()
      if (archDirInput.value.trim()) loadSessionsFor('arch', archDirInput.value.trim())
      if (devDirInput.value.trim())  loadSessionsFor('dev',  devDirInput.value.trim())
      if (qaDirInput.value.trim())   loadSessionsFor('qa',   qaDirInput.value.trim())
      sessionPicker.style.display = 'flex'
    }
  }

  init()
}
