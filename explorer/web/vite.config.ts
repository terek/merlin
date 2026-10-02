import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const api = process.env.EXPLORER_API ?? 'http://127.0.0.1:7433'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    outDir: '../internal/webui/dist',
    emptyOutDir: true,
    sourcemap: false,
    rolldownOptions: {
      // react libraries carry "use client" directives that mean nothing in a client-only build
      onwarn(warning, defaultHandler) {
        if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') defaultHandler(warning)
      },
    },
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      // changeOrigin rewrites Host to the daemon's, so its Host guard passes. The event
      // stream must not be buffered or compressed on the way.
      '/api': {
        target: api,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyRes', (res) => {
            if (String(res.headers['content-type'] ?? '').startsWith('text/event-stream')) {
              res.headers['cache-control'] = 'no-cache'
              res.headers['x-accel-buffering'] = 'no'
            }
          })
        },
      },
    },
  },
})
