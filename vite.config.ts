import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      include: ['buffer', 'crypto', 'events', 'fs', 'net', 'os', 'path', 'stream', 'util'],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
  ],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
    proxy: {
      '/apiws': {
        target: 'wss://vesta.web.telegram.org',
        changeOrigin: true,
        ws: true,
      },
      '/api/itunes': {
        target: 'https://itunes.apple.com',
        changeOrigin: true,
        rewrite: (path: string) => {
          const url = new URL(path, 'http://localhost');
          const query = url.searchParams.get('query') || '';
          return `/search?term=${encodeURIComponent(query)}&entity=song&limit=1`;
        },
      },
    },
  },
})
