import { and, desc, eq, sql } from 'drizzle-orm';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { Audit } from './audit.ts';
import { PAT_PREFIX } from './auth/oauthServer.ts';
import { AuthError, type Owners, type User } from './auth/owner.ts';
import { hashToken, randomToken } from './crypto.ts';
import type { Db } from './db/index.ts';
import { personalAccessTokens } from './db/schema.ts';
import type { Registry, ServerInput } from './registry.ts';
import { checkTransport, createServer, updateServer } from './serverSchema.ts';
import type { Upstream } from './upstream/upstream.ts';

const toggles = z.object({
  items: z.array(z.object({ kind: z.enum(['tool', 'prompt', 'resource', 'resource_template']), name: z.string().min(1), enabled: z.boolean() })).max(1000),
});

type Authed = Request & { user: User };

export function apiRouter(deps: { db: Db; owners: Owners; registry: Registry; audit: Audit; mcpUrl: URL; sessionCount: () => number }): Router {
  const { db, owners, registry, audit } = deps;
  const api = express.Router();
  api.use(express.json({ limit: '1mb' }));

  // POST/PUT/PATCH must be JSON: browsers can't send that cross-site without a CORS preflight, which we never allow.
  // (DELETE can't be sent cross-site by a form at all.)
  api.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: 'Send JSON' });
    }
    next();
  });

  const wrap = (fn: (req: Authed, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req as Authed, res).catch(next);

  // No sign-in needed, for container health checks and uptime monitors. Reveals nothing about the servers behind MCPME.
  api.get('/health', wrap(async (_req, res) => {
    const database = await db.execute(sql`select 1`).then(
      () => 'ok' as const,
      () => 'error' as const,
    );
    res.set('Cache-Control', 'no-store').status(database === 'ok' ? 200 : 503).json({ status: database, database, uptimeSeconds: Math.round(process.uptime()) });
  }));

  api.get('/state', wrap(async (req, res) => {
    const user = await owners.sessionUser(req);
    res.json({ setupRequired: !(await owners.hasOwner()), user: user ? { id: user.id, name: user.name, email: user.email } : null, mcpUrl: deps.mcpUrl.href });
  }));

  api.post('/setup', wrap(async (req, res) => {
    const body = z.object({ name: z.string(), email: z.string().email(), password: z.string() }).parse(req.body);
    const user = await owners.setup(body.name, body.email, body.password);
    await owners.startSession(res, user);
    res.json({ user });
  }));

  api.post('/login', wrap(async (req, res) => {
    const body = z.object({ email: z.string(), password: z.string() }).parse(req.body);
    const user = await owners.verifyCredentials(body.email, body.password);
    await owners.startSession(res, user);
    res.json({ user });
  }));

  api.post('/logout', wrap(async (req, res) => {
    await owners.endSession(req, res);
    res.json({ ok: true });
  }));

  // Everything below needs a signed-in session.
  api.use((req, res, next) => {
    owners
      .sessionUser(req)
      .then((user) => {
        if (!user) return res.status(401).json({ error: 'Sign in first' });
        (req as Authed).user = user;
        next();
      })
      .catch(next);
  });

  api.get('/servers', wrap(async (_req, res) => {
    res.json({ servers: await Promise.all(registry.all().map((u) => summary(registry, u))), sessions: deps.sessionCount() });
  }));

  api.post('/servers', wrap(async (req, res) => {
    const input = createServer.parse(req.body) as ServerInput;
    if (registry.bySlug(input.slug)) return res.status(409).json({ error: `A server with slug "${input.slug}" already exists` });
    const up = await registry.create(req.user.id, input);
    res.status(201).json({ server: await summary(registry, up) });
  }));

  const find = (req: Request, res: Response): Upstream | undefined => {
    const up = registry.get(String(req.params.id));
    if (!up) res.status(404).json({ error: 'Server not found' });
    return up;
  };

  api.get('/servers/:id', wrap(async (req, res) => {
    const up = find(req, res);
    if (!up) return;
    res.json({ server: await summary(registry, up), items: items(registry, up), stderr: up.stderr });
  }));

  api.patch('/servers/:id', wrap(async (req, res) => {
    const current = find(req, res);
    if (!current) return;
    const patch = updateServer.parse(req.body) as Partial<ServerInput>;
    const merged = { ...current.config, ...patch };
    const issues: string[] = [];
    checkTransport(merged, { addIssue: (i: { message?: string }) => issues.push(i.message ?? 'Invalid') } as unknown as z.RefinementCtx);
    if (issues.length) return res.status(400).json({ error: issues.join('. ') });
    if (patch.slug && patch.slug !== current.config.slug && registry.bySlug(patch.slug)) {
      return res.status(409).json({ error: `A server with slug "${patch.slug}" already exists` });
    }
    const up = await registry.update(current.config.id, patch);
    res.json({ server: await summary(registry, up!) });
  }));

  api.delete('/servers/:id', wrap(async (req, res) => {
    const up = find(req, res);
    if (!up) return;
    await registry.remove(up.config.id);
    res.json({ ok: true });
  }));

  api.post('/servers/:id/refresh', wrap(async (req, res) => {
    const up = find(req, res);
    if (!up) return;
    const fresh = (await registry.reconnect(up.config.id))!;
    res.json({ server: await summary(registry, fresh), items: items(registry, fresh) });
  }));

  api.post('/servers/:id/connect', wrap(async (req, res) => {
    const up = find(req, res);
    if (!up) return;
    const url = await registry.startAuth(up.config.id);
    res.json({ authorizationUrl: url?.href ?? null });
  }));

  api.post('/servers/:id/disconnect', wrap(async (req, res) => {
    const up = find(req, res);
    if (!up) return;
    await registry.disconnect(up.config.id);
    res.json({ ok: true });
  }));

  api.put('/servers/:id/items', wrap(async (req, res) => {
    const up = find(req, res);
    if (!up) return;
    await registry.setToggles(up.config.id, toggles.parse(req.body).items);
    res.json({ items: items(registry, up) });
  }));

  api.get('/tokens', wrap(async (req, res) => {
    const rows = await db
      .select({ id: personalAccessTokens.id, name: personalAccessTokens.name, prefix: personalAccessTokens.prefix, createdAt: personalAccessTokens.createdAt, lastUsedAt: personalAccessTokens.lastUsedAt })
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.userId, req.user.id))
      .orderBy(desc(personalAccessTokens.createdAt));
    res.json({ tokens: rows });
  }));

  api.post('/tokens', wrap(async (req, res) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const token = randomToken(PAT_PREFIX);
    const [row] = await db
      .insert(personalAccessTokens)
      .values({ userId: req.user.id, name, tokenHash: hashToken(token), prefix: token.slice(0, PAT_PREFIX.length + 6) })
      .returning({ id: personalAccessTokens.id, name: personalAccessTokens.name, prefix: personalAccessTokens.prefix, createdAt: personalAccessTokens.createdAt });
    res.status(201).json({ token, record: row });
  }));

  api.delete('/tokens/:id', wrap(async (req, res) => {
    const deleted = await db
      .delete(personalAccessTokens)
      .where(and(eq(personalAccessTokens.id, String(req.params.id)), eq(personalAccessTokens.userId, req.user.id)))
      .returning({ id: personalAccessTokens.id });
    res.status(deleted.length ? 200 : 404).json({ ok: deleted.length > 0 });
  }));

  api.get('/audit', wrap(async (_req, res) => {
    res.json({ entries: await audit.recent() });
  }));

  api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('. ') });
    if (err instanceof AuthError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Something went wrong' });
  });

  return api;
}

async function summary(registry: Registry, up: Upstream) {
  const c = up.config;
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    transport: c.transport,
    url: c.url,
    command: c.command,
    args: c.args,
    authType: c.authType,
    enabled: c.enabled,
    newItemsEnabled: c.newItemsEnabled,
    // Secret values never leave the server; only their names.
    envKeys: Object.keys(c.env),
    headerKeys: Object.keys(c.headers),
    status: up.status,
    lastError: up.lastError ?? null,
    oauth: c.authType === 'oauth' ? await registry.oauthStatus(c.id) : null,
    counts: {
      tools: up.lists.tools.length,
      prompts: up.lists.prompts.length,
      resources: up.lists.resources.length + up.lists.resourceTemplates.length,
    },
    createdAt: c.createdAt,
  };
}

function items(registry: Registry, up: Upstream) {
  const row = (kind: 'tool' | 'prompt' | 'resource' | 'resource_template', name: string, title: string | undefined, description: string | undefined, extra: Record<string, unknown> = {}) => ({
    kind,
    name,
    title: title ?? null,
    description: description ?? null,
    enabled: registry.isEnabled(up, kind, name),
    explicit: registry.hasToggle(up, kind, name),
    ...extra,
  });
  return [
    ...up.lists.tools.map((t) => row('tool', t.name, t.title ?? t.annotations?.title, t.description, { inputSchema: t.inputSchema })),
    ...up.lists.prompts.map((p) => row('prompt', p.name, p.title, p.description)),
    ...up.lists.resources.map((r) => row('resource', r.uri, r.title ?? r.name, r.description)),
    ...up.lists.resourceTemplates.map((t) => row('resource_template', t.uriTemplate, t.title ?? t.name, t.description)),
  ];
}
