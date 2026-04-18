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
  },
});
