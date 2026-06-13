import { build } from 'esbuild'
import { mkdirSync } from 'fs'

mkdirSync('public', { recursive: true })

await build({
  entryPoints: ['frontend/app.ts'],
  bundle: true,
  outfile: 'public/app.js',
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  minify: false,
  sourcemap: false,
})
console.log('[build] frontend/app.ts → public/app.js')
