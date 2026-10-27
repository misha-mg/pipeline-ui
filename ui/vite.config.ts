import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// `npm run dev` serves the UI from Vite and proxies the API to the service on 8787.
export default defineConfig({
  root: __dirname,
  plugins: [vue()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
})
