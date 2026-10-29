import { EventEmitter } from 'node:events';
import { and, eq } from 'drizzle-orm';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Db } from './db/index.ts';
import { itemToggles, serverOAuth, servers, type ItemKind } from './db/schema.ts';
import type { Vault } from './crypto.ts';
import { serverIdForState, UpstreamOAuthProvider } from './upstream/oauth.ts';
import { Upstream, type ServerConfig, type ServerRow } from './upstream/upstream.ts';

type NewServer = typeof servers.$inferInsert;

export interface ServerInput {
  slug: string;
  name: string;
  transport: ServerRow['transport'];
  url?: string | null;
  command?: string | null;
  args?: string[];
  /** Omitted = keep existing. */
  env?: Record<string, string>;
  authType: ServerRow['authType'];
  /** Omitted = keep existing. */
  headers?: Record<string, string>;
  enabled?: boolean;
  newItemsEnabled?: boolean;
}

/**
 * The set of registered MCP servers: their config, live connections,
 * upstream OAuth, and the per-item on/off switches.
 *
 * Emits `change` whenever what MCP clients should see may have changed.
 */
export class Registry extends EventEmitter<{ change: [] }> {
  private readonly db: Db;
  private readonly vault: Vault;
  private readonly callbackUrl: string;
  private readonly upstreams = new Map<string, Upstream>();
  private toggles = new Map<string, Map<string, boolean>>();
  private changeTimer?: NodeJS.Timeout;

  constructor(db: Db, vault: Vault, publicUrl: URL) {
    super();
    this.db = db;
    this.vault = vault;
    this.callbackUrl = new URL('/oauth/upstream/callback', publicUrl).href;
  }

  async init(): Promise<void> {
    for (const row of await this.db.select().from(servers)) this.upsertUpstream(row);
    for (const t of await this.db.select().from(itemToggles)) this.cacheToggle(t.serverId, t.kind, t.name, t.enabled);
    // Warm connections in the background so the first tools/list is fast.
    for (const up of this.upstreams.values()) if (up.config.enabled) void up.currentLists();
  }

  all(): Upstream[] {
    return [...this.upstreams.values()].sort((a, b) => a.config.slug.localeCompare(b.config.slug));
  }

  get(id: string): Upstream | undefined {
    return this.upstreams.get(id);
  }

  bySlug(slug: string): Upstream | undefined {
    return this.all().find((u) => u.config.slug === slug);
  }

  // ---- config ---------------------------------------------------------------

  async create(ownerId: string, input: ServerInput): Promise<Upstream> {
    const [row] = await this.db
      .insert(servers)
      .values({ ...(this.columns(input) as Omit<NewServer, 'ownerId'>), ownerId, args: input.args ?? [] })
      .returning();
    const up = this.upsertUpstream(row);
    this.changed();
    if (up.config.enabled) void up.currentLists();
    return up;
  }

  async update(id: string, input: Partial<ServerInput>): Promise<Upstream | undefined> {
    const [row] = await this.db.update(servers).set(this.columns(input)).where(eq(servers.id, id)).returning();
    if (!row) return undefined;
    const up = this.upsertUpstream(row);
    this.changed();
    if (up.config.enabled) void up.currentLists();
    return up;
  }

  async remove(id: string): Promise<boolean> {
    const deleted = await this.db.delete(servers).where(eq(servers.id, id)).returning({ id: servers.id });
    await this.upstreams.get(id)?.close();
    this.upstreams.delete(id);
    this.toggles.delete(id);
    this.changed();
    return deleted.length > 0;
  }

  private columns(input: Partial<ServerInput>) {
    const { env, headers, ...rest } = input;
    return {
      ...rest,
      ...(env !== undefined ? { envSealed: Object.keys(env).length ? this.vault.seal(env) : null } : {}),
      ...(headers !== undefined ? { headersSealed: Object.keys(headers).length ? this.vault.seal(headers) : null } : {}),
    };
  }

  private upsertUpstream(row: ServerRow): Upstream {
    const { envSealed, headersSealed, ...rest } = row;
    const config: ServerConfig = {
      ...rest,
      env: this.vault.open<Record<string, string>>(envSealed) ?? {},
      headers: this.vault.open<Record<string, string>>(headersSealed) ?? {},
    };
    void this.upstreams.get(row.id)?.close();
    const up = new Upstream(config, {
      oauth: () => this.oauthProvider(row.id, false),
      onChange: () => this.changed(),
    });
    this.upstreams.set(row.id, up);
    return up;
  }

  /** Reconnects a server, e.g. after new credentials. */
  async reconnect(id: string): Promise<Upstream | undefined> {
    const [row] = await this.db.select().from(servers).where(eq(servers.id, id));
    if (!row) return undefined;
    const up = this.upsertUpstream(row);
    this.changed();
    if (up.config.enabled) await up.currentLists();
    return up;
  }

  // ---- upstream OAuth -------------------------------------------------------

  private oauthProvider(serverId: string, interactive: boolean): UpstreamOAuthProvider {
    return new UpstreamOAuthProvider({ db: this.db, vault: this.vault, serverId, callbackUrl: this.callbackUrl, interactive });
  }

  /**
   * Starts signing MCPME in to an OAuth-protected server. Returns the URL to
   * send the user's browser to, or undefined if stored credentials already work.
   */
  async startAuth(id: string): Promise<URL | undefined> {
    const up = this.upstreams.get(id);
    if (!up?.config.url) throw new Error('Only HTTP/SSE servers use OAuth');
    const provider = this.oauthProvider(id, true);
    const result = await auth(provider, { serverUrl: up.config.url });
    if (result === 'AUTHORIZED') {
      await this.reconnect(id);
      return undefined;
    }
    if (!provider.authorizationUrl) throw new Error('The server did not return a sign-in URL');
    return provider.authorizationUrl;
  }

  /** Handles the OAuth callback. Returns the server id it completed. */
  async finishAuth(state: string, code: string): Promise<string> {
    const id = await serverIdForState(this.db, state);
    const up = id ? this.upstreams.get(id) : undefined;
    if (!id || !up?.config.url) throw new Error('Unknown or expired sign-in. Start again from MCPME.');
    const provider = this.oauthProvider(id, true);
    const result = await auth(provider, { serverUrl: up.config.url, authorizationCode: code });
    if (result !== 'AUTHORIZED') throw new Error('Sign-in did not complete');
    await provider.finishSignIn();
    await this.reconnect(id);
    return id;
  }

  /** Forgets stored OAuth credentials for a server. */
  async disconnect(id: string): Promise<void> {
    await this.db.delete(serverOAuth).where(eq(serverOAuth.serverId, id));
    await this.reconnect(id);
  }

  async oauthStatus(id: string): Promise<{ connected: boolean; connectedAt: Date | null }> {
    const [row] = await this.db
      .select({ tokens: serverOAuth.tokensSealed, connectedAt: serverOAuth.connectedAt })
      .from(serverOAuth)
      .where(eq(serverOAuth.serverId, id));
    return { connected: Boolean(row?.tokens), connectedAt: row?.connectedAt ?? null };
  }

  // ---- toggles --------------------------------------------------------------

  isEnabled(up: Upstream, kind: ItemKind, name: string): boolean {
    return this.toggles.get(up.config.id)?.get(`${kind}:${name}`) ?? up.config.newItemsEnabled;
  }

  /** True when an explicit switch exists (vs. the server default applying). */
  hasToggle(up: Upstream, kind: ItemKind, name: string): boolean {
    return this.toggles.get(up.config.id)?.has(`${kind}:${name}`) ?? false;
  }

  async setToggles(serverId: string, items: { kind: ItemKind; name: string; enabled: boolean }[]): Promise<void> {
    for (const { kind, name, enabled } of items) {
      await this.db
        .insert(itemToggles)
        .values({ serverId, kind, name, enabled })
        .onConflictDoUpdate({ target: [itemToggles.serverId, itemToggles.kind, itemToggles.name], set: { enabled } });
      this.cacheToggle(serverId, kind, name, enabled);
    }
    this.changed();
  }

  async clearToggle(serverId: string, kind: ItemKind, name: string): Promise<void> {
    await this.db.delete(itemToggles).where(and(eq(itemToggles.serverId, serverId), eq(itemToggles.kind, kind), eq(itemToggles.name, name)));
    this.toggles.get(serverId)?.delete(`${kind}:${name}`);
    this.changed();
  }

  private cacheToggle(serverId: string, kind: ItemKind, name: string, enabled: boolean) {
    let map = this.toggles.get(serverId);
    if (!map) this.toggles.set(serverId, (map = new Map()));
    map.set(`${kind}:${name}`, enabled);
  }

  /** Coalesces bursts of changes into one notification. */
  private changed() {
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.emit('change'), 50);
  }

  async close(): Promise<void> {
    clearTimeout(this.changeTimer);
    await Promise.all(this.all().map((u) => u.close()));
  }
}
