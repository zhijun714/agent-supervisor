import { realpathSync } from 'fs'

export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[=>MHJ78]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

export function encodePath(absPath: string): string {
  try { absPath = realpathSync(absPath) } catch {}
  return absPath.replace(/\//g, '-')
}

export function parseTermId(termId: string): { roomId: string; role: string } {
  const i = termId.lastIndexOf('-')
  return { roomId: termId.slice(0, i), role: termId.slice(i + 1) }
}
