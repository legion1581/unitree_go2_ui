import { defineConfig } from 'vite';
import { robotProxyPlugin } from './src/proxy-plugin';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
  },
  plugins: [robotProxyPlugin()],
  server: {
    watch: {
      ignored: [
        '**/reverse_engineer/**',
        '**/_frontend_*/**',
        '**/dist/**',
        '**/node_modules/**',
      ],
    },
  },
});
