import { defineConfig } from 'vite';
import { robotProxyPlugin } from './src/proxy-plugin';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
  },
  plugins: [robotProxyPlugin()],
});
