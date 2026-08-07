import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { apiMiddleware } from './src/parser/api.js';

// The sessions API runs in the same process as the dev server,
// so a single command is enough: npm run dev
function claudeSessionsApi() {
  return {
    name: 'claude-sessions-api',
    configureServer(server) {
      server.middlewares.use(apiMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(apiMiddleware());
    },
  };
}

export default defineConfig({
  plugins: [react(), claudeSessionsApi()],
  server: { port: 5173, host: '127.0.0.1', open: true },
});
