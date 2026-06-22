// Terminal color schemes (Tabby / iTerm2-Color-Schemes format) + helpers to
// turn one into an xterm.js ITheme and a set of app-chrome CSS variables.
//
// A theme only needs to carry terminal colors (background/foreground/cursor +
// 16 ANSI). The app chrome (sidebar/header/panels) variables are DERIVED from
// those colors by deriveUI(), so adding a new scheme = paste its 16 colors.
// Copy more from https://github.com/mbadolato/iTerm2-Color-Schemes verbatim.

export interface TermScheme {
  name: string
  background: string
  foreground: string
  cursor: string
  selection?: string
  // [black, red, green, yellow, blue, magenta, cyan, white,
  //  brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite]
  ansi: string[]
  ui?: Partial<UIVars> // optional explicit chrome override (else derived)
}

export interface UIVars {
  bg: string; bg2: string; bg3: string; border: string
  text: string; textDim: string
  blue: string; green: string; amber: string; red: string; purple: string
  termBg: string
}

export const THEMES: Record<string, TermScheme> = {
  'github-dark': {
    name: 'GitHub Dark',
    background: '#0a0e14', foreground: '#c9d1d9', cursor: '#58a6ff', selection: 'rgba(88,166,255,0.2)',
    ansi: ['#0d1117','#f85149','#3fb950','#e3b341','#58a6ff','#bc8cff','#39c5cf','#c9d1d9',
           '#484f58','#ff7b72','#56d364','#e3b341','#79c0ff','#d2a8ff','#56d4dd','#f0f6fc'],
    // Keep the original app chrome exactly as before for the default theme.
    ui: { bg:'#0f1117', bg2:'#161b22', bg3:'#21262d', border:'#30363d', text:'#c9d1d9', textDim:'#8b949e',
          blue:'#58a6ff', green:'#3fb950', amber:'#e3b341', red:'#f85149', purple:'#bc8cff', termBg:'#0a0e14' },
  },
  'dracula': {
    name: 'Dracula',
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selection: 'rgba(68,71,90,0.55)',
    ansi: ['#21222c','#ff5555','#50fa7b','#f1fa8c','#bd93f9','#ff79c6','#8be9fd','#f8f8f2',
           '#6272a4','#ff6e6e','#69ff94','#ffffa5','#d6acff','#ff92df','#a4ffff','#ffffff'],
  },
  'one-dark': {
    name: 'One Dark',
    background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', selection: 'rgba(62,68,81,0.7)',
    ansi: ['#282c34','#e06c75','#98c379','#e5c07b','#61afef','#c678dd','#56b6c2','#abb2bf',
           '#5c6370','#e06c75','#98c379','#e5c07b','#61afef','#c678dd','#56b6c2','#ffffff'],
  },
  'tokyo-night': {
    name: 'Tokyo Night',
    background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', selection: 'rgba(51,70,124,0.6)',
    ansi: ['#15161e','#f7768e','#9ece6a','#e0af68','#7aa2f7','#bb9af7','#7dcfff','#a9b1d6',
           '#414868','#f7768e','#9ece6a','#e0af68','#7aa2f7','#bb9af7','#7dcfff','#c0caf5'],
  },
  'nord': {
    name: 'Nord',
    background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', selection: 'rgba(67,76,94,0.6)',
    ansi: ['#3b4252','#bf616a','#a3be8c','#ebcb8b','#81a1c1','#b48ead','#88c0d0','#e5e9f0',
           '#4c566a','#bf616a','#a3be8c','#ebcb8b','#81a1c1','#b48ead','#8fbcbb','#eceff4'],
  },
  'gruvbox-dark': {
    name: 'Gruvbox Dark',
    background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', selection: 'rgba(80,73,69,0.6)',
    ansi: ['#282828','#cc241d','#98971a','#d79921','#458588','#b16286','#689d6a','#a89984',
           '#928374','#fb4934','#b8bb26','#fabd2f','#83a598','#d3869b','#8ec07c','#ebdbb2'],
  },
  'catppuccin-mocha': {
    name: 'Catppuccin Mocha',
    background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selection: 'rgba(88,91,112,0.6)',
    ansi: ['#45475a','#f38ba8','#a6e3a1','#f9e2af','#89b4fa','#f5c2e7','#94e2d5','#bac2de',
           '#585b70','#f38ba8','#a6e3a1','#f9e2af','#89b4fa','#f5c2e7','#94e2d5','#a6adc8'],
  },
  'monokai': {
    name: 'Monokai',
    background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', selection: 'rgba(73,72,62,0.7)',
    ansi: ['#272822','#f92672','#a6e22e','#f4bf75','#66d9ef','#ae81ff','#a1efe4','#f8f8f2',
           '#75715e','#f92672','#a6e22e','#f4bf75','#66d9ef','#ae81ff','#a1efe4','#f9f8f5'],
  },
  'tomorrow-night': {
    name: 'Tomorrow Night',
    background: '#1d1f21', foreground: '#c5c8c6', cursor: '#c5c8c6', selection: 'rgba(55,59,65,0.7)',
    ansi: ['#1d1f21','#cc6666','#b5bd68','#f0c674','#81a2be','#b294bb','#8abeb7','#c5c8c6',
           '#969896','#cc6666','#b5bd68','#f0c674','#81a2be','#b294bb','#8abeb7','#ffffff'],
  },
  'solarized-light': {
    name: 'Solarized Light',
    background: '#fdf6e3', foreground: '#657b83', cursor: '#586e75', selection: 'rgba(238,232,213,0.9)',
    ansi: ['#073642','#dc322f','#859900','#b58900','#268bd2','#d33682','#2aa198','#eee8d5',
           '#002b36','#cb4b16','#586e75','#657b83','#839496','#6c71c4','#93a1a1','#fdf6e3'],
  },
  'github-light': {
    name: 'GitHub Light',
    background: '#ffffff', foreground: '#24292e', cursor: '#24292e', selection: 'rgba(3,102,214,0.15)',
    ansi: ['#24292e','#d73a49','#28a745','#dbab09','#0366d6','#5a32a3','#0598bc','#6a737d',
           '#959da5','#cb2431','#22863a','#b08800','#005cc5','#5a32a3','#3192aa','#d1d5da'],
  },
  'one-light': {
    name: 'One Light',
    background: '#fafafa', foreground: '#383a42', cursor: '#526fff', selection: 'rgba(82,111,255,0.15)',
    ansi: ['#383a42','#e45649','#50a14f','#c18401','#4078f2','#a626a4','#0184bc','#a0a1a7',
           '#696c77','#e45649','#50a14f','#c18401','#4078f2','#a626a4','#0184bc','#fafafa'],
  },
  'catppuccin-latte': {
    name: 'Catppuccin Latte',
    background: '#eff1f5', foreground: '#4c4f69', cursor: '#dc8a78', selection: 'rgba(172,176,190,0.5)',
    ansi: ['#5c5f77','#d20f39','#40a02b','#df8e1d','#1e66f5','#ea76cb','#179299','#acb0be',
           '#6c6f85','#d20f39','#40a02b','#df8e1d','#1e66f5','#ea76cb','#179299','#bcc0cc'],
  },
  'gruvbox-light': {
    name: 'Gruvbox Light',
    background: '#fbf1c7', foreground: '#3c3836', cursor: '#3c3836', selection: 'rgba(146,131,116,0.4)',
    ansi: ['#fbf1c7','#cc241d','#98971a','#d79921','#458588','#b16286','#689d6a','#7c6f64',
           '#928374','#9d0006','#79740e','#b57614','#076678','#8f3f71','#427b58','#3c3836'],
  },
  'ayu-light': {
    name: 'Ayu Light',
    background: '#fafafa', foreground: '#5c6166', cursor: '#ffaa33', selection: 'rgba(53,158,230,0.18)',
    ansi: ['#000000','#ff3333','#86b300','#f29718','#399ee6','#a37acc','#4cbf99','#c7c7c7',
           '#323232','#ff6565','#b8e532','#ffd173','#68d5ff','#d4bfff','#95e6cb','#ffffff'],
  },
  'paper-light': {
    name: 'Paper Light',
    background: '#eeeeee', foreground: '#4d4d4c', cursor: '#4d4d4c', selection: 'rgba(208,208,208,0.7)',
    ansi: ['#eeeeee','#af0000','#008700','#5f8700','#0087af','#878787','#005f87','#444444',
           '#bcbcbc','#d70000','#d70087','#8700af','#d75f00','#d75f00','#005faf','#005f87'],
  },
}

export const THEME_KEY = 'sup-theme'
export const DEFAULT_THEME = 'github-dark'

// Synchronous best-guess (localStorage cache) — used so terminals can be created
// immediately without waiting on the network. loadServerTheme() corrects it after.
export function getSavedTheme(): string {
  try {
    const t = localStorage.getItem(THEME_KEY)
    if (t && THEMES[t]) return t
  } catch {}
  return DEFAULT_THEME
}

// Durable source of truth lives server-side (ui-prefs.json). Falls back to the
// localStorage cache / default if the server has nothing or is unreachable.
export async function loadServerTheme(): Promise<string> {
  try {
    const d = await fetch('/prefs').then(r => r.json())
    if (d && typeof d.theme === 'string' && THEMES[d.theme]) {
      try { localStorage.setItem(THEME_KEY, d.theme) } catch {}
      return d.theme
    }
  } catch {}
  return getSavedTheme()
}

// Persist choice to BOTH the localStorage cache (drives instant cross-tab sync
// via the 'storage' event) and the server (survives a browser data wipe).
export function saveTheme(name: string): void {
  try { localStorage.setItem(THEME_KEY, name) } catch {}
  fetch('/prefs', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: name }),
  }).catch(() => {})
}

export function toXtermTheme(s: TermScheme): Record<string, string> {
  const a = s.ansi
  return {
    background: s.background, foreground: s.foreground, cursor: s.cursor, cursorAccent: s.background,
    selectionBackground: s.selection || 'rgba(128,128,128,0.3)',
    black: a[0], red: a[1], green: a[2], yellow: a[3], blue: a[4], magenta: a[5], cyan: a[6], white: a[7],
    brightBlack: a[8], brightRed: a[9], brightGreen: a[10], brightYellow: a[11],
    brightBlue: a[12], brightMagenta: a[13], brightCyan: a[14], brightWhite: a[15],
  }
}

// ── Color math (for deriving chrome variables) ───────────────────────────────
function toRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)]
}
function toHex(rgb: [number, number, number]): string {
  return '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
}
// mix t of b into a (t=0 → a, t=1 → b)
function mix(a: string, b: string, t: number): string {
  const ra = toRgb(a), rb = toRgb(b)
  return toHex([ra[0] + (rb[0] - ra[0]) * t, ra[1] + (rb[1] - ra[1]) * t, ra[2] + (rb[2] - ra[2]) * t])
}

export function deriveUI(s: TermScheme): UIVars {
  if (s.ui) {
    const d = deriveAuto(s)
    return { ...d, ...s.ui } as UIVars
  }
  return deriveAuto(s)
}

function deriveAuto(s: TermScheme): UIVars {
  const bg = s.background, fg = s.foreground
  const a = s.ansi
  // Mixing bg toward fg lightens dark themes and darkens light themes — works both ways.
  return {
    bg,
    bg2: mix(bg, fg, 0.05),
    bg3: mix(bg, fg, 0.11),
    border: mix(bg, fg, 0.20),
    text: fg,
    textDim: mix(fg, bg, 0.42),
    blue: a[12] || a[4],
    green: a[2],
    amber: a[3],
    red: a[1],
    purple: a[5],
    termBg: bg,
  }
}

// Apply a theme: set chrome CSS variables on :root, and (if given) update the
// theme of any live terminals in this document.
export function applyTheme(name: string, terms?: { options: Record<string, unknown> }[]): void {
  const scheme = THEMES[name] || THEMES[DEFAULT_THEME]
  const ui = deriveUI(scheme)
  const root = document.documentElement.style
  root.setProperty('--bg', ui.bg)
  root.setProperty('--bg2', ui.bg2)
  root.setProperty('--bg3', ui.bg3)
  root.setProperty('--border', ui.border)
  root.setProperty('--text', ui.text)
  root.setProperty('--text-dim', ui.textDim)
  root.setProperty('--blue', ui.blue)
  root.setProperty('--green', ui.green)
  root.setProperty('--amber', ui.amber)
  root.setProperty('--red', ui.red)
  root.setProperty('--purple', ui.purple)
  root.setProperty('--term-bg', ui.termBg)
  if (terms) {
    const xt = toXtermTheme(scheme)
    for (const t of terms) { try { t.options.theme = xt } catch {} }
  }
}
