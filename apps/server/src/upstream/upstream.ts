import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  type Prompt,
  type Resource,
  type ResourceTemplate,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { servers } from '../db/schema.ts';
import type { UpstreamOAuthProvider } from './oauth.ts';

export type ServerRow = typeof servers.$inferSelect;

/** A server row with its sealed fields opened. */
export interface ServerConfig extends Omit<ServerRow, 'envSealed' | 'headersSealed'> {
  env: Record<string, string>;
  headers: Record<string, string>;
}

export interface UpstreamLists {
  tools: Tool[];
  prompts: Prompt[];
  resources: Resource[];
  resourceTemplates: ResourceTemplate[];
}

export type UpstreamStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'needs_auth' | 'disabled';

const EMPTY: UpstreamLists = { tools: [], prompts: [], resources: [], resourceTemplates: [] };
const MAX_BACKOFF_MS = 60_000;
const STDERR_LINES = 50;

/**
 * One live connection to a registered MCP server. Connects lazily, caches
 * the server's lists, refreshes them on list_changed, and backs off after
 * failures so a dead server doesn't slow down every request.
 */
export class Upstream {
  readonly config: ServerConfig;
  status: UpstreamStatus = 'idle';
  lastError?: string;
  lists: UpstreamLists = EMPTY;
  /** Recent stderr lines from stdio servers, for the admin UI. */
  readonly stderr: string[] = [];

  private client?: Client;
  private connecting?: Promise<Client>;
  private failures = 0;
  private retryAt = 0;
  private closed = false;
  private readonly oauth?: () => UpstreamOAuthProvider;
  private readonly onChange: () => void;

  constructor(config: ServerConfig, opts: { oauth?: () => UpstreamOAuthProvider; onChange: () => void }) {
    this.config = config;
    this.oauth = opts.oauth;
    this.onChange = opts.onChange;
    if (!config.enabled) this.status = 'disabled';
  }

  /** Returns a connected client, connecting if needed. */
  async connect(): Promise<Client> {
    if (this.closed || !this.config.enabled) throw new Error(`${this.config.name} is turned off`);
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    if (Date.now() < this.retryAt) throw new Error(`${this.config.name} is unavailable: ${this.lastError ?? 'connection failed'}`);
    this.connecting = this.open().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async open(): Promise<Client> {
    const prev = this.status;
    this.status = 'connecting';
    const client = new Client({ name: 'mcpme', version: '0.1.0' }, { capabilities: {} });
    try {
      if (this.config.authType === 'oauth' && !(await this.oauth?.().tokens())) {
        throw new UnauthorizedError('Not connected yet');
      }
      const transport = this.transport();
      client.onclose = () => {
        if (this.client === client) {
          this.client = undefined;
          if (this.status === 'connected') this.status = 'idle';
        }
      };
      await client.connect(transport);
      this.lists = await fetchLists(client);
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => this.refresh(client));
      client.setNotificationHandler(PromptListChangedNotificationSchema, () => this.refresh(client));
      client.setNotificationHandler(ResourceListChangedNotificationSchema, () => this.refresh(client));
      if (this.closed) {
        await client.close();
        throw new Error('closed');
      }
      this.client = client;
      this.status = 'connected';
      this.lastError = undefined;
      this.failures = 0;
      this.retryAt = 0;
      this.onChange();
      return client;
    } catch (err) {
      await client.close().catch(() => {});
      const needsAuth = err instanceof UnauthorizedError || /\b401\b|unauthori[sz]ed/i.test(String((err as Error)?.message));
      this.status = needsAuth ? 'needs_auth' : 'error';
      this.lastError = needsAuth ? 'Needs authorization' : errorMessage(err);
      if (!needsAuth) {
        this.failures++;
        this.retryAt = Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.failures - 1));
      }
      this.lists = EMPTY;
      if (prev !== this.status) this.onChange();
      throw needsAuth ? new UnauthorizedError(this.lastError) : err;
    }
  }

  private transport(): Transport {
    const { transport, url, command, args, env, headers } = this.config;
    const requestInit = { headers };
    const authProvider = this.config.authType === 'oauth' ? this.oauth?.() : undefined;
    if (transport === 'http') return new StreamableHTTPClientTransport(new URL(url!), { authProvider, requestInit });
    if (transport === 'sse') return new SSEClientTransport(new URL(url!), { authProvider, requestInit });
    const stdio = new StdioClientTransport({ command: command!, args, env: { ...getDefaultEnvironment(), ...env }, stderr: 'pipe' });
    stdio.stderr?.on('data', (chunk: Buffer) => {
      this.stderr.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      this.stderr.splice(0, Math.max(0, this.stderr.length - STDERR_LINES));
    });
    return stdio;
  }

  private async refresh(client: Client): Promise<void> {
    try {
      this.lists = await fetchLists(client);
      this.onChange();
    } catch (err) {
      this.lastError = errorMessage(err);
    }
  }

  /** Re-fetches lists now (admin "refresh"), clearing any backoff. */
  async reload(): Promise<void> {
    this.retryAt = 0;
    const client = await this.connect();
    await this.refresh(client);
  }

  /** Lists, connecting first if needed. Never throws: a broken server just contributes nothing. */
  async currentLists(): Promise<UpstreamLists> {
    try {
      await this.connect();
    } catch {
      // status/lastError already record why
    }
    return this.lists;
  }

  /** Credentials stopped working mid-session: drop the connection and wait for a new sign-in. */
  markNeedsAuth(): void {
    const client = this.client;
    this.client = undefined;
    void client?.close().catch(() => {});
    this.status = 'needs_auth';
    this.lastError = 'Needs authorization';
    this.lists = EMPTY;
    this.onChange();
  }

  async close(): Promise<void> {
    this.closed = true;
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => {});
  }
}

async function fetchLists(client: Client): Promise<UpstreamLists> {
  const caps = client.getServerCapabilities() ?? {};
  const all = async <T>(page: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>) => {
    const out: T[] = [];
    let cursor: string | undefined;
    do {
      const res = await page(cursor);
      out.push(...res.items);
      cursor = res.nextCursor;
    } while (cursor);
    return out;
  };
  const [tools, prompts, resources, resourceTemplates] = await Promise.all([
    caps.tools ? all(async (cursor) => { const r = await client.listTools({ cursor }); return { items: r.tools, nextCursor: r.nextCursor }; }) : [],
    caps.prompts ? all(async (cursor) => { const r = await client.listPrompts({ cursor }); return { items: r.prompts, nextCursor: r.nextCursor }; }) : [],
    caps.resources ? all(async (cursor) => { const r = await client.listResources({ cursor }); return { items: r.resources, nextCursor: r.nextCursor }; }) : [],
    caps.resources
      ? all(async (cursor) => { const r = await client.listResourceTemplates({ cursor }); return { items: r.resourceTemplates, nextCursor: r.nextCursor }; }).catch(() => [])
      : [],
  ]);
  return { tools, prompts, resources, resourceTemplates };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
