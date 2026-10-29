import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  GetPromptRequestSchema,
  isInitializeRequest,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  UrlElicitationRequiredError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { Audit } from './audit.ts';
import type { McpmeAuthExtra } from './auth/oauthServer.ts';
import type { Registry } from './registry.ts';
import { errorMessage, type Upstream } from './upstream/upstream.ts';

/** `<slug>__<name>`. Slugs can't contain `_`, so the first `__` is always the separator. */
const SEP = '__';
const RESOURCE_SCHEME = 'mcpme://';
const AUTHORIZE_TOOL = 'authorize';
const CALL_TIMEOUT_MS = 5 * 60_000;
const SESSION_IDLE_MS = 24 * 60 * 60_000;

export function namespaced(slug: string, name: string): string {
  return `${slug}${SEP}${name}`;
}

export function splitName(full: string): { slug: string; name: string } | undefined {
  const i = full.indexOf(SEP);
  return i > 0 ? { slug: full.slice(0, i), name: full.slice(i + SEP.length) } : undefined;
}

export function wrapUri(slug: string, uri: string): string {
  return `${RESOURCE_SCHEME}${slug}/${uri}`;
}

export function unwrapUri(uri: string): { slug: string; uri: string } | undefined {
  if (!uri.startsWith(RESOURCE_SCHEME)) return undefined;
  const rest = uri.slice(RESOURCE_SCHEME.length);
  const i = rest.indexOf('/');
  return i > 0 ? { slug: rest.slice(0, i), uri: rest.slice(i + 1) } : undefined;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: Server;
  userId: string;
  lastSeen: number;
}

/**
 * The single MCP endpoint clients connect to. Each client session gets its
 * own MCP `Server` that merges every enabled upstream, hides switched-off
 * items, and forwards calls.
 */
export class Gateway {
  private readonly registry: Registry;
  private readonly audit: Audit;
  private readonly publicUrl: URL;
  private readonly sessions = new Map<string, Session>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(registry: Registry, audit: Audit, publicUrl: URL) {
    this.registry = registry;
    this.audit = audit;
    this.publicUrl = publicUrl;
    registry.on('change', () => this.notifyAll());
    this.sweeper = setInterval(() => this.sweep(), 10 * 60_000).unref();
  }

  /** Express handler for /mcp. Runs after bearer auth has set `req.auth`. */
  handle = async (req: Request, res: Response): Promise<void> => {
    const userId = (req.auth?.extra as McpmeAuthExtra | undefined)?.userId;
    if (!userId) {
      res.status(401).end();
      return;
    }
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const session = this.sessions.get(sessionId);
      if (!session || session.userId !== userId) {
        res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
        return;
      }
      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res, req.body);
      return;
    }
    if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Missing mcp-session-id header' }, id: null });
      return;
    }
    const server = this.buildServer(userId);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, { transport, server, userId, lastSeen: Date.now() });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  get sessionCount(): number {
    return this.sessions.size;
  }

  private notifyAll() {
    for (const { server } of this.sessions.values()) {
      void server.sendToolListChanged().catch(() => {});
      void server.sendPromptListChanged().catch(() => {});
      void server.sendResourceListChanged().catch(() => {});
    }
  }

  private sweep() {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, s] of this.sessions) {
      if (s.lastSeen < cutoff) {
        this.sessions.delete(id);
        void s.transport.close().catch(() => {});
      }
    }
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all([...this.sessions.values()].map((s) => s.transport.close().catch(() => {})));
    this.sessions.clear();
  }

  private connectUrl(up: Upstream): string {
    return new URL(`/connect/${up.config.slug}`, this.publicUrl).href;
  }

  private enabledUpstreams(): Upstream[] {
    return this.registry.all().filter((u) => u.config.enabled);
  }

  /** Finds the upstream for a namespaced name. Disabled servers look like they don't exist. */
  private resolve(full: string): { up: Upstream; name: string } | undefined {
    const parts = splitName(full);
    const up = parts && this.registry.bySlug(parts.slug);
    return up?.config.enabled ? { up, name: parts!.name } : undefined;
  }

  private async timed<T>(userId: string, up: Upstream | undefined, method: string, target: string, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const out = await run();
      const isError = (out as CallToolResult | undefined)?.isError === true;
      this.audit.record({ userId, serverSlug: up?.config.slug ?? '-', method, target, status: isError ? 'error' : 'ok', durationMs: Date.now() - started });
      return out;
    } catch (err) {
      const blocked = err instanceof NotExposedError;
      this.audit.record({
        userId,
        serverSlug: up?.config.slug ?? '-',
        method,
        target,
        status: blocked ? 'blocked' : 'error',
        error: errorMessage(err),
        durationMs: Date.now() - started,
      });
      throw blocked ? new McpError(ErrorCode.InvalidParams, err.message) : err;
    }
  }

  private buildServer(userId: string): Server {
    const server = new Server(
      { name: 'mcpme', version: '0.1.0' },
      {
        capabilities: { tools: { listChanged: true }, prompts: { listChanged: true }, resources: { listChanged: true } },
        instructions: 'MCPME combines several MCP servers. Every tool and prompt name is prefixed with its server, as <server>__<name>.',
      },
    );

    const authorizeTool = (up: Upstream): Tool => ({
      name: namespaced(up.config.slug, AUTHORIZE_TOOL),
      title: `Connect ${up.config.name}`,
      description: `${up.config.name} needs you to sign in before its tools are available. Call this to get the sign-in link, then open it in a browser.`,
      inputSchema: { type: 'object', properties: {} },
    });

    const needsAuthResult = (up: Upstream): CallToolResult => {
      const url = this.connectUrl(up);
      if (server.getClientCapabilities()?.elicitation?.url) {
        throw new UrlElicitationRequiredError([
          { mode: 'url', message: `Sign in to ${up.config.name} so MCPME can use it.`, url, elicitationId: randomUUID() },
        ]);
      }
      return {
        isError: true,
        content: [{ type: 'text', text: `${up.config.name} needs authorization. Open this link to sign in, then try again: ${url}` }],
      };
    };

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const lists = await Promise.all(this.enabledUpstreams().map(async (up) => ({ up, lists: await up.currentLists() })));
      const tools: Tool[] = [];
      for (const { up, lists: l } of lists) {
        if (up.status === 'needs_auth') {
          tools.push(authorizeTool(up));
          continue;
        }
        for (const t of l.tools) {
          if (this.registry.isEnabled(up, 'tool', t.name)) tools.push({ ...t, name: namespaced(up.config.slug, t.name) });
        }
      }
      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const target = this.resolve(req.params.name);
      return this.timed(userId, target?.up, 'tools/call', req.params.name, async () => {
        if (!target) throw new NotExposedError(`Unknown tool: ${req.params.name}`);
        const { up, name } = target;
        if (up.status === 'needs_auth') return needsAuthResult(up);
        if (!this.registry.isEnabled(up, 'tool', name)) throw new NotExposedError(`Unknown tool: ${req.params.name}`);
        let client;
        try {
          client = await up.connect();
        } catch (err) {
          if (err instanceof UnauthorizedError) return needsAuthResult(up);
          return { isError: true, content: [{ type: 'text', text: errorMessage(err) }] };
        }
        let result: CallToolResult;
        try {
          result = (await client.callTool({ name, arguments: req.params.arguments }, CallToolResultSchema, {
            timeout: CALL_TIMEOUT_MS,
          })) as CallToolResult;
        } catch (err) {
          // Stored credentials stopped working (revoked, refresh failed): ask for sign-in again.
          if (err instanceof UnauthorizedError) {
            up.markNeedsAuth();
            return needsAuthResult(up);
          }
          throw err;
        }
        return { ...result, content: result.content.map((c) => wrapContentUris(up.config.slug, c)) };
      });
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => {
      const lists = await Promise.all(this.enabledUpstreams().map(async (up) => ({ up, lists: await up.currentLists() })));
      return {
        prompts: lists.flatMap(({ up, lists: l }) =>
          l.prompts.filter((p) => this.registry.isEnabled(up, 'prompt', p.name)).map((p) => ({ ...p, name: namespaced(up.config.slug, p.name) })),
        ),
      };
    });

    server.setRequestHandler(GetPromptRequestSchema, async (req) => {
      const target = this.resolve(req.params.name);
      return this.timed(userId, target?.up, 'prompts/get', req.params.name, async () => {
        if (!target || !this.registry.isEnabled(target.up, 'prompt', target.name)) throw new NotExposedError(`Unknown prompt: ${req.params.name}`);
        const client = await target.up.connect();
        const result = await client.getPrompt({ name: target.name, arguments: req.params.arguments });
        return { ...result, messages: result.messages.map((m) => ({ ...m, content: wrapContentUris(target.up.config.slug, m.content) })) };
      });
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const lists = await Promise.all(this.enabledUpstreams().map(async (up) => ({ up, lists: await up.currentLists() })));
      return {
        resources: lists.flatMap(({ up, lists: l }) =>
          l.resources.filter((r) => this.registry.isEnabled(up, 'resource', r.uri)).map((r) => ({ ...r, uri: wrapUri(up.config.slug, r.uri) })),
        ),
      };
    });

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      const lists = await Promise.all(this.enabledUpstreams().map(async (up) => ({ up, lists: await up.currentLists() })));
      return {
        resourceTemplates: lists.flatMap(({ up, lists: l }) =>
          l.resourceTemplates
            .filter((t) => this.registry.isEnabled(up, 'resource_template', t.uriTemplate))
            .map((t) => ({ ...t, uriTemplate: wrapUri(up.config.slug, t.uriTemplate) })),
        ),
      };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      const parts = unwrapUri(req.params.uri);
      const up = parts && this.registry.bySlug(parts.slug);
      return this.timed(userId, up, 'resources/read', req.params.uri, async () => {
        if (!parts || !up?.config.enabled || !this.resourceReadable(up, parts.uri)) throw new NotExposedError(`Unknown resource: ${req.params.uri}`);
        const client = await up.connect();
        const result = await client.readResource({ uri: parts.uri });
        return { ...result, contents: result.contents.map((c) => ({ ...c, uri: wrapUri(up.config.slug, c.uri) })) };
      });
    });

    return server;
  }

  /** A saved or listed resource uses its own switch; otherwise the first matching template's; otherwise the server default. */
  private resourceReadable(up: Upstream, uri: string): boolean {
    if (this.registry.hasToggle(up, 'resource', uri) || up.lists.resources.some((r) => r.uri === uri)) {
      return this.registry.isEnabled(up, 'resource', uri);
    }
    const template = up.lists.resourceTemplates.find((t) => {
      try {
        return new UriTemplate(t.uriTemplate).match(uri) !== null;
      } catch {
        return false;
      }
    });
    if (template) return this.registry.isEnabled(up, 'resource_template', template.uriTemplate);
    return up.config.newItemsEnabled;
  }
}

/** Rewrites resource URIs inside tool/prompt content so clients can read them back through MCPME. */
function wrapContentUris<T extends { type: string }>(slug: string, content: T): T {
  const c = content as T & { uri?: string; resource?: { uri: string } };
  if (c.type === 'resource_link' && c.uri) return { ...c, uri: wrapUri(slug, c.uri) };
  if (c.type === 'resource' && c.resource?.uri) return { ...c, resource: { ...c.resource, uri: wrapUri(slug, c.resource.uri) } };
  return content;
}

/** A request for something that is switched off or doesn't exist. Never reaches the upstream. */
class NotExposedError extends Error {}
