import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Express } from 'express';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { apiRouter } from './api.ts';
import { Audit } from './audit.ts';
import { McpmeOAuthServer } from './auth/oauthServer.ts';
import { Owners } from './auth/owner.ts';
import { consentRouter } from './auth/pages.ts';
import { browserRouter } from './browserRoutes.ts';
import type { Config } from './config.ts';
import { Vault } from './crypto.ts';
import { openDatabase, type Database } from './db/index.ts';
import { Gateway } from './gateway.ts';
import { Registry } from './registry.ts';

export interface App {
  express: Express;
  owners: Owners;
  registry: Registry;
  gateway: Gateway;
  audit: Audit;
  database: Database;
  mcpUrl: URL;
  close(): Promise<void>;
}

export async function createApp(config: Config, opts: { inMemoryDb?: boolean } = {}): Promise<App> {
  const database = await openDatabase({ databaseUrl: config.databaseUrl, dataDir: config.dataDir, inMemory: opts.inMemoryDb });
  const { db } = database;
  const vault = new Vault(config.secretKey);
  const owners = new Owners(db, config.publicUrl.protocol === 'https:');
  const mcpUrl = new URL('/mcp', config.publicUrl);
  const oauth = new McpmeOAuthServer(db, mcpUrl);
  const registry = new Registry(db, vault, config.publicUrl);
  await registry.init();
  const audit = new Audit(db);
  void audit.prune().catch(() => {});
  const gateway = new Gateway(registry, audit, config.publicUrl);

  const app = express();
  app.disable('x-powered-by');
  // Behind a reverse proxy on a private network (Coolify/Traefik, Docker).
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // OAuth authorization server for MCP clients: metadata, /authorize, /token, /register, /revoke.
  app.use(
    mcpAuthRouter({
      provider: oauth,
      issuerUrl: config.publicUrl,
      resourceServerUrl: mcpUrl,
      resourceName: 'MCPME',
      scopesSupported: ['mcp'],
    }),
  );
  app.use(consentRouter(oauth, owners));
  app.use(browserRouter(owners, registry));

  app.all(
    '/mcp',
    requireBearerAuth({ verifier: oauth, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl), expectedResource: mcpUrl }),
    express.json({ limit: '4mb' }),
    gateway.handle,
  );

  app.use('/api', apiRouter({ db, owners, registry, audit, mcpUrl, sessionCount: () => gateway.sessionCount }));

  // Admin UI (single-page app).
  if (config.webDir && existsSync(join(config.webDir, 'index.html'))) {
    app.use(express.static(config.webDir, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/|mcp$|oauth\/|\.well-known\/).*/, (_req, res) => {
      res.set('Cache-Control', 'no-cache').sendFile('index.html', { root: config.webDir });
    });
  }

  return {
    express: app,
    owners,
    registry,
    gateway,
    audit,
    database,
    mcpUrl,
    async close() {
      await gateway.close();
      await registry.close();
      await audit.flush();
      await database.close();
    },
  };
}
