import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts'), runtime: resolve('src/runtime/worker.ts'), inspection: resolve('src/runtime/inspection-worker.ts'), 'export-check-worker': resolve('src/runtime/export-check-worker.ts'), 'export-generation-worker': resolve('src/runtime/export-generation-worker.ts'), 'monty-worker': resolve('src/runtime/monty/worker.ts') } } }
  },
  preload: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } } } },
  renderer: { plugins: [react()] }
})
