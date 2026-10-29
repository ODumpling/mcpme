import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp, type App } from '../src/app.ts';

export const OWNER = { name: 'Owner', email: 'owner@example.com', password: 'correct horse battery' };

export interface Harness {
  app: App;
  base: string;
  /** Cookie header for a signed-in admin session. */
  cookie: string;
  api(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: any }>;
  /** A PAT for MCP calls. */
  pat: string;
  mcpClient(token?: string): Promise<Client>;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  // Listen first so the public URL (with its port) is known before the app is built.
  let handler: (req: any, res: any) => void = (_q, s) => s.end();
  const http: HttpServer = createServer((req, res) => handler(req, res));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const app = await createApp(
    { publicUrl: new URL(base), port: 0, dataDir: mkdtempSync(join(tmpdir(), 'mcpme-')), secretKey: randomBytes(32) },
    { inMemoryDb: true },
  );
  handler = app.express;

  let cookie = '';
  const api: Harness['api'] = async (path, init = {}) => {
    const res = await fetch(base + path, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: { cookie, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  await api('/api/setup', { body: OWNER });
  const { body } = await api('/api/tokens', { body: { name: 'tests' } });

  const clients: Client[] = [];
  return {
    app,
    base,
    get cookie() {
      return cookie;
    },
    api,
    pat: body.token,
    async mcpClient(token = body.token) {
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      clients.push(client);
      return client;
    },
    async close() {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
      await app.close();
    },
  };
}

export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw last ?? new Error('waitFor timed out');
}
