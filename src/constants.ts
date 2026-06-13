// PTY buffer sizes
export const TEXT_BUF_MAX = 12_288
export const RAW_BUF_MAX  = 262_144

// Inbox delivery timing
export const INBOX_IDLE_MS        = 2_000
export const INBOX_IDLE_MS_RESUME = 8_000

// Notify dedup window
export const NOTIFY_DEDUP_TTL = 20_000

// Codex quota
export const CODEX_QUOTA_PATTERNS = [
  'insufficient_quota', 'exceeded your current quota', 'quota has been exceeded',
  'rate_limit_exceeded', 'billing hard limit', 'you exceeded your', 'usage limit',
]
export const CODEX_QUOTA_RETRY_MS = 60 * 60 * 1000

// Trust prompt dismiss debounce
export const TRUST_DISMISS_DEBOUNCE_MS = 5_000

// Auto-review
export const REVIEW_COOLDOWN_MS     = 60_000
export const REVIEW_MIN_CONTENT_LEN = 500

// Watchdog
export const WATCHDOG_INTERVAL_MS       = 5 * 60 * 1000
export const WATCHDOG_IDLE_THRESHOLD_MS = 5 * 60 * 1000

// WebSocket ping interval
export const WS_PING_INTERVAL_MS = 30_000

// Session capture polling
export const SESSION_POLL_MAX_ATTEMPTS = 15
export const SESSION_POLL_INTERVAL_MS  = 2_000
export const SESSION_POLL_INITIAL_MS   = 3_000
export const KIMI_QUICK_EXIT_WINDOW_MS = 15_000
