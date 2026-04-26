import { defineConfig } from 'vite';
import { robotProxyPlugin } from './src/proxy-plugin';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
  },
  plugins: [robotProxyPlugin()],
  server: {
    // Single unified WebSocket upgrade proxy for the BLE backend
    // (HTTP paths still go through robotProxyPlugin)
    proxy: {
      '/ble-api/ws': {
        target: 'ws://127.0.0.1:5051',
        ws: true,
        rewrite: (path) => path.replace(/^\/ble-api/, ''),
      },
    },
    // Keep Vite's file watcher out of the decompiled APK trees —
    // they contain tens of thousands of smali files and blow past
    // Linux's default inotify watcher limit (ENOSPC).
    watch: {
      ignored: [
        '**/reverse_engineer/**',
        '**/_frontend_*/**',
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
      ],
    },
  },
});
