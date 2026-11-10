import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// `npm run dev` serves the UI from Vite and proxies the API to the service on 8787. The proxy
// leaves the Host header as the browser sent it (Vite's short form, a bare target, rewrites it to
// the target's): the console's guard takes an action only when its Origin is the Host it was
// asked on, so with a rewritten Host every action from the dev server's pages was refused (403).
export default defineConfig({
  root: __dirname,
  plugins: [vue()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } } },
})
