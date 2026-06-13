import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync } from 'fs'

export const PORT = parseInt(process.env.PORT || '3458', 10)
export const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
export const ROOMS_FILE = process.env.ROOMS_FILE || join(ROOT_DIR, 'rooms.json')
export const ROOM_MEMORIES_DIR = join(ROOT_DIR, 'room-memories')

mkdirSync(ROOM_MEMORIES_DIR, { recursive: true })
