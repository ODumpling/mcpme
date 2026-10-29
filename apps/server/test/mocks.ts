import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

export interface MockUpstream {
  url: string;
  calls: { tool: string; args: unknown; headers: Record<string, unknown> }[];
  /** OAuth stats when started with `oauth: true`. */
  oauth: { issued: number; refreshed: number; expireAll(): void };
  close(): Promise<void>;
}

function buildMcp(calls: MockUpstream['calls'], headers: () => Record<string, unknown>) {
  const mcp = new McpServer({ name: 'mock', version: '1.0.0' });
  mcp.registerTool('echo', { description: 'Echoes text', inputSchema: { text: z.string() } }, async ({ text }) => {
    calls.push({ tool: 'echo', args: { text }, headers: headers() });
    return { content: [{ type: 'text', text: `echo: ${text}` }] };
  });
  mcp.registerTool('delete_everything', { description: 'Dangerous' }, async () => {
    calls.push({ tool: 'delete_everything', args: {}, headers: headers() });
    return { content: [{ type: 'text', text: 'deleted' }] };
  });
  mcp.registerPrompt('greet', { description: 'Greets', argsSchema: { who: z.string() } }, ({ who }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `Hello ${who}` } }],
  }));
  mcp.registerResource('memo', 'memo://one', { description: 'A memo' }, async (uri) => ({ contents: [{ uri: uri.href, text: 'memo one' }] }));
  mcp.registerResource('item', new ResourceTemplate('memo://items/{id}', { list: undefined }), {}, async (uri, { id }) => ({
    contents: [{ uri: uri.href, text: `item ${id}` }],
  }));
  return mcp;
}

async function listen(app: express.Express): Promise<{ server: HttpServer; url: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

/**
 * An HTTP MCP server. With `oauth`, it's protected by its own toy OAuth
 * server that approves every authorization request immediately.
 */
export async function startMockUpstream(opts: { oauth?: boolean; requireHeader?: [string, string] } = {}): Promise<MockUpstream> {
  const calls: MockUpstream['calls'] = [];
  const app = express();
  const stats = { issued: 0, refreshed: 0 };
  const tokens = new Map<string, number>(); // access token -> expiresAt (s)
  const refreshTokens = new Set<string>();
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const clients = new Map<string, OAuthClientInformationFull>();
  let base = '';
  let currentHeaders: Record<string, unknown> = {};

  const provider: OAuthServerProvider = {
    clientsStore: {
      getClient: (id) => clients.get(id),
      registerClient: (c) => {
        const full = c as OAuthClientInformationFull;
        clients.set(full.client_id, full);
        return full;
      },
    },
    async authorize(_client, params, res) {
      const code = randomUUID();
      codes.set(code, { challenge: params.codeChallenge, redirectUri: params.redirectUri });
      const target = new URL(params.redirectUri);
      target.searchParams.set('code', code);
      if (params.state) target.searchParams.set('state', params.state);
      res.redirect(302, target.href);
    },
    async challengeForAuthorizationCode(_c, code) {
      const entry = codes.get(code);
      if (!entry) throw new InvalidGrantError('bad code');
      return entry.challenge;
    },
    async exchangeAuthorizationCode(_c, code) {
      if (!codes.delete(code)) throw new InvalidGrantError('bad code');
      stats.issued++;
      return issue();
    },
    async exchangeRefreshToken(_c, refresh) {
      if (!refreshTokens.delete(refresh)) throw new InvalidGrantError('bad refresh');
      stats.refreshed++;
      return issue();
    },
    async verifyAccessToken(token) {
      const exp = tokens.get(token);
      if (exp === undefined) throw new InvalidTokenError('unknown token');
      return { token, clientId: 'x', scopes: [], expiresAt: exp };
    },
  };
  function issue() {
    const access = randomUUID();
    const refresh = randomUUID();
    tokens.set(access, Math.floor(Date.now() / 1000) + 3600);
    refreshTokens.add(refresh);
    return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh };
  }

  const mcpHandler = async (req: express.Request, res: express.Response) => {
    if (opts.requireHeader && req.headers[opts.requireHeader[0].toLowerCase()] !== opts.requireHeader[1]) {
      res.status(403).json({ error: 'bad key' });
      return;
    }
    currentHeaders = { ...req.headers };
    // Stateless: a fresh server per request.
    const mcp = buildMcp(calls, () => currentHeaders);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => void mcp.close());
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  const { server, url } = await listen(app);
  base = url;
  if (opts.oauth) {
    app.use(mcpAuthRouter({ provider, issuerUrl: new URL(base), resourceServerUrl: new URL(`${base}/mcp`) }));
    app.post('/mcp', express.json(), requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(`${base}/mcp`)) }), mcpHandler);
  } else {
    app.post('/mcp', express.json(), mcpHandler);
  }
  app.get('/mcp', (_req, res) => res.status(405).end());
  app.delete('/mcp', (_req, res) => res.status(405).end());

  return {
    url: `${base}/mcp`,
    calls,
    oauth: {
      get issued() { return stats.issued; },
      get refreshed() { return stats.refreshed; },
      expireAll() {
        for (const k of tokens.keys()) tokens.set(k, 0);
      },
    },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
