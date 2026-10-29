import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const server = 'http://localhost:3000';
const proxied = ['/api', '/mcp', '/oauth', '/connect', '/signin', '/.well-known', '/authorize', '/token', '/register', '/revoke'];

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: Object.fromEntries(proxied.map((p) => [p, server])) },
});
