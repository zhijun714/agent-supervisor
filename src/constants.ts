import { cfg } from './config.js'

// PTY buffer sizes
export const TEXT_BUF_MAX = 12_288
export const RAW_BUF_MAX  = 262_144

// Inbox delivery timing (configurable via supervisor.config.json → inbox)
export const INBOX_IDLE_MS        = cfg.inbox.idleMs
export const INBOX_IDLE_MS_RESUME = cfg.inbox.idleMsResume

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

// Auto-review (configurable via supervisor.config.json → review)
export const REVIEW_COOLDOWN_MS     = cfg.review.cooldownMs
export const REVIEW_MIN_CONTENT_LEN = cfg.review.minContentLen

// Watchdog (configurable via supervisor.config.json → watchdog)
export const WATCHDOG_INTERVAL_MS       = cfg.watchdog.intervalMs
export const WATCHDOG_IDLE_THRESHOLD_MS = cfg.watchdog.idleThresholdMs

// WebSocket ping interval
export const WS_PING_INTERVAL_MS = 30_000

// Session capture polling
export const SESSION_POLL_MAX_ATTEMPTS = 15
export const SESSION_POLL_INTERVAL_MS  = 2_000
export const SESSION_POLL_INITIAL_MS   = 3_000
export const KIMI_QUICK_EXIT_WINDOW_MS = 15_000
