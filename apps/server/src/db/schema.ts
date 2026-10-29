import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().default(''),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: createdAt(),
});

/** Admin UI browser sessions. */
export const sessions = pgTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

/** OAuth clients (Claude Code, Cursor, ...) registered with MCPME via dynamic client registration. */
export const oauthClients = pgTable('oauth_clients', {
  clientId: text('client_id').primaryKey(),
  /** Full RFC 7591 client information, as returned at registration. */
  info: jsonb('info').notNull(),
  createdAt: createdAt(),
});

/** Authorization requests waiting for the user to log in and approve. */
export const oauthPendingAuthorizations = pgTable('oauth_pending_authorizations', {
  id: text('id').primaryKey(),
  clientId: text('client_id').notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  state: text('state'),
  scopes: jsonb('scopes').$type<string[]>().notNull(),
  resource: text('resource'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const oauthCodes = pgTable('oauth_codes', {
  codeHash: text('code_hash').primaryKey(),
  clientId: text('client_id').notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  scopes: jsonb('scopes').$type<string[]>().notNull(),
  resource: text('resource'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** Access + refresh token pairs issued to MCP clients. */
export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accessTokenHash: text('access_token_hash').notNull().unique(),
    refreshTokenHash: text('refresh_token_hash').notNull().unique(),
    clientId: text('client_id').notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    resource: text('resource'),
    accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }).notNull(),
    refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('oauth_tokens_user_idx').on(t.userId)],
);

/** Long-lived tokens for MCP clients that can't do OAuth. */
export const personalAccessTokens = pgTable('personal_access_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  /** First characters of the token, shown in the UI to tell tokens apart. */
  prefix: text('prefix').notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export type Transport = 'http' | 'sse' | 'stdio';
export type UpstreamAuthType = 'none' | 'headers' | 'oauth';

/** An external MCP server registered with MCPME. */
export const servers = pgTable('servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  transport: text('transport').$type<Transport>().notNull(),
  url: text('url'),
  command: text('command'),
  args: jsonb('args').$type<string[]>().notNull().default([]),
  /** Sealed Record<string,string> of env vars for stdio servers. */
  envSealed: text('env_sealed'),
  authType: text('auth_type').$type<UpstreamAuthType>().notNull().default('none'),
  /** Sealed Record<string,string> of HTTP headers (API keys etc.). */
  headersSealed: text('headers_sealed'),
  enabled: boolean('enabled').notNull().default(true),
  /** Whether tools/prompts/resources not seen before are exposed by default. */
  newItemsEnabled: boolean('new_items_enabled').notNull().default(true),
  createdAt: createdAt(),
});

/** OAuth state for upstream servers that use OAuth. Everything sensitive is sealed. */
export const serverOAuth = pgTable('server_oauth', {
  serverId: uuid('server_id').primaryKey().references(() => servers.id, { onDelete: 'cascade' }),
  clientInfoSealed: text('client_info_sealed'),
  tokensSealed: text('tokens_sealed'),
  codeVerifierSealed: text('code_verifier_sealed'),
  discoveryState: jsonb('discovery_state'),
  /** Random value sent as OAuth `state`, used to find the server on callback. */
  pendingState: text('pending_state').unique(),
  connectedAt: timestamp('connected_at', { withTimezone: true }),
});

export type ItemKind = 'tool' | 'prompt' | 'resource' | 'resource_template';

/** Per-item on/off switches. A missing row means the server's newItemsEnabled default applies. */
export const itemToggles = pgTable(
  'item_toggles',
  {
    serverId: uuid('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<ItemKind>().notNull(),
    /** Upstream name (tools/prompts) or URI / URI template (resources). */
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.kind, t.name] })],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    serverSlug: text('server_slug').notNull(),
    method: text('method').notNull(),
    target: text('target').notNull(),
    status: text('status').$type<'ok' | 'error' | 'blocked'>().notNull(),
    error: text('error'),
    durationMs: integer('duration_ms').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('audit_log_created_idx').on(t.createdAt)],
);
