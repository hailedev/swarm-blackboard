import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// The dev server proxies /api to the API server, so the browser talks to one origin and
// the server needs no CORS (ADR-0011). The target is TEAM_API_URL, or the PORT of the
// repository's .env. Only those two prefixes are read from that file: nothing else in it
// (the API key least of all) is loaded here, and none of it reaches the client bundle.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', ['TEAM_', 'PORT']);
  const api = env['TEAM_API_URL'] ?? `http://localhost:${env['PORT'] ?? '3001'}`;
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: api,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  };
});
