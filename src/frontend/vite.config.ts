import { defineConfig, searchForWorkspaceRoot } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'

// Dev mode (tools/前端开发模式.bat) links node_modules to the offline toolkit cache; allow serving from it.
const allow = [searchForWorkspaceRoot(fileURLToPath(new URL('.', import.meta.url)))]
try { allow.push(realpathSync(new URL('./node_modules', import.meta.url))) } catch { /* no node_modules next to the config */ }

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5175,
    strictPort: true,
    fs: { allow },
    proxy: Object.fromEntries(['/api', '/files', '/models', '/textures', '/data'].map(prefix => [prefix, { target: 'http://127.0.0.1:8030', changeOrigin: false }])),
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: { main: fileURLToPath(new URL('./index.html', import.meta.url)), rearPlacement: fileURLToPath(new URL('./tools/rear-placement.html', import.meta.url)) },
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'zustand'],
          three: ['three'],
          osd: ['openseadragon'],
        },
      },
    },
  },
})
