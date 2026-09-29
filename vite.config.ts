import { defineConfig } from 'vite';
import { apiPlugin } from './server/vite-plugin-api.ts';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5235,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 5235,
    strictPort: true,
  },
  plugins: [apiPlugin()],
});
