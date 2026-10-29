import { wantsSignIn, type Registry, type ServerInput } from './registry.ts';
import { createServer } from './serverSchema.ts';

/** One server found in a client's MCP config. `input` is missing when it can't be imported. */
export interface FoundServer {
  key: string;
  input?: ServerInput;
  reason?: string;
  /** Values that reference the client's environment (`${VAR}`), which MCPME can't resolve. */
  placeholders: string[];
}

/** What happened to one server, without its secret values. */
export interface ImportedServer {
  key: string;
  outcome: 'new' | 'created' | 'exists' | 'invalid' | 'skipped';
  reason?: string;
  placeholders: string[];
  id?: string;
  slug?: string;
  name?: string;
  transport?: ServerInput['transport'];
  url?: string | null;
  command?: string | null;
  args?: string[];
  authType?: ServerInput['authType'];
  enabled?: boolean;
  envKeys?: string[];
  headerKeys?: string[];
}

/**
 * Adds every server in an MCP client's config to the registry, skipping ones
 * whose slug is taken. With `dryRun`, only reports what would happen.
 */
export async function importServers(
  registry: Registry,
  opts: { ownerId: string; mcpUrl: URL; config: unknown; dryRun?: boolean },
): Promise<ImportedServer[]> {
  let config = opts.config;
  if (typeof config === 'string') {
    try {
      config = JSON.parse(config);
    } catch (err) {
      throw new Error(`That isn't valid JSON: ${(err as Error).message}`);
    }
  }
  // Check every server first (in parallel, as it may mean a network round trip), then create them in order.
  const checked = await Promise.all(
    findServers(config).map(async ({ key, input, reason, placeholders }): Promise<ImportedServer & { input?: ServerInput }> => {
      if (!input) return { key, placeholders, outcome: 'invalid', reason };
      if (input.url && sameEndpoint(input.url, opts.mcpUrl)) return { key, placeholders, outcome: 'skipped', reason: 'This is MCPME itself' };
      const parsed = createServer.safeParse(input);
      if (!parsed.success) return { key, placeholders, outcome: 'invalid', reason: parsed.error.issues.map((i) => i.message).join('. ') };
      // Client configs don't record OAuth, so ask the server whether it wants a sign-in.
      if (input.transport !== 'stdio' && input.authType === 'none' && (await wantsSignIn(input.transport, input.url!, {}))) input.authType = 'oauth';
      return { key, placeholders, outcome: 'new', input };
    }),
  );
  const taken = new Set(registry.all().map((u) => u.config.slug));
  const results: ImportedServer[] = [];
  for (const { input, ...result } of checked) {
    if (!input) {
      results.push(result);
      continue;
    }
    const row = { ...result, ...preview(input) };
    if (taken.has(input.slug)) {
      results.push({ ...row, outcome: 'exists', reason: `A server with slug "${input.slug}" already exists` });
    } else if (opts.dryRun) {
      taken.add(input.slug);
      results.push(row);
    } else {
      taken.add(input.slug);
      const up = await registry.create(opts.ownerId, input);
      results.push({ ...row, outcome: 'created', id: up.config.id });
    }
  }
  return results;
}

function preview(input: ServerInput) {
  return {
    slug: input.slug,
    name: input.name,
    transport: input.transport,
    url: input.url ?? null,
    command: input.command ?? null,
    args: input.args ?? [],
    authType: input.authType,
    enabled: input.enabled ?? true,
    envKeys: Object.keys(input.env ?? {}),
    headerKeys: Object.keys(input.headers ?? {}),
  };
}

function sameEndpoint(a: string, b: URL): boolean {
  try {
    const u = new URL(a);
    return u.host === b.host && u.pathname.replace(/\/+$/, '') === b.pathname;
  } catch {
    return false;
  }
}

type Entry = Record<string, unknown>;

const isObject = (v: unknown): v is Entry => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Collects server entries from the MCP config formats clients use:
 * `mcpServers` (Claude Code, Claude Desktop, Cursor, Windsurf, Gemini CLI),
 * `servers` (VS Code `mcp.json`), `mcp.servers` (VS Code settings) and
 * `projects.<path>.mcpServers` (Claude Code's `~/.claude.json`).
 */
export function findServers(config: unknown): FoundServer[] {
  if (!isObject(config)) throw new Error('Pass the config as a JSON object');
  const entries = new Map<string, unknown>();
  const add = (map: unknown) => {
    if (!isObject(map)) return;
    for (const [key, value] of Object.entries(map)) if (!entries.has(key)) entries.set(key, value);
  };
  add(config.mcpServers);
  add(config.servers);
  if (isObject(config.mcp)) add(config.mcp.servers);
  if (isObject(config.projects)) for (const p of Object.values(config.projects)) if (isObject(p)) add(p.mcpServers);
  if (!entries.size) throw new Error('No MCP servers found. Expected an "mcpServers" or "servers" object.');
  return [...entries].map(([key, value]) => toServer(key, value));
}

function toServer(key: string, raw: unknown): FoundServer {
  const found: FoundServer = { key, placeholders: [] };
  if (!isObject(raw)) return { ...found, reason: 'Not a server definition' };

  const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : undefined;
  const url = str(raw.url) ?? str(raw.httpUrl) ?? str(raw.serverUrl);
  const command = str(raw.command);
  let transport: ServerInput['transport'];
  if (type === 'stdio' || (!type && command)) transport = 'stdio';
  // Without a type, clients guess from the URL; `/sse` endpoints are almost always the legacy transport.
  else if (type === 'sse' || (!type && !raw.httpUrl && /\/sse\/?$/.test(url ?? ''))) transport = 'sse';
  else if (!type || ['http', 'streamable-http', 'streamablehttp'].includes(type)) transport = 'http';
  else return { ...found, reason: `Unsupported type "${raw.type}"` };

  const env = strings(raw.env);
  const headers = strings(raw.headers);
  const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
  for (const [k, v] of Object.entries(transport === 'stdio' ? env : headers)) if (/\$\{[^}]+\}/.test(v)) found.placeholders.push(k);
  if (transport === 'stdio') {
    if (!command) return { ...found, reason: 'No command' };
    for (const a of [command, ...args]) if (/\$\{[^}]+\}/.test(a)) found.placeholders.push('args');
  } else if (!url) {
    return { ...found, reason: 'No URL' };
  } else if (/\$\{[^}]+\}/.test(url)) {
    found.placeholders.push('url');
  }

  const slug = slugify(key);
  if (!slug) return { ...found, reason: 'Name has no letters or numbers to make a slug from' };
  found.input = {
    slug,
    name: key.trim().slice(0, 80) || slug,
    transport,
    ...(transport === 'stdio' ? { command, args, env, url: null } : { url, headers, command: null, args: [] }),
    authType: transport !== 'stdio' && Object.keys(headers).length ? 'headers' : 'none',
    enabled: raw.disabled !== true && raw.enabled !== false,
  };
  found.placeholders = [...new Set(found.placeholders)];
  return found;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function strings(v: unknown): Record<string, string> {
  if (!isObject(v)) return {};
  return Object.fromEntries(Object.entries(v).filter(([k]) => k).map(([k, val]) => [k, String(val)]));
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 32)
    .replace(/^-+|-+$/g, '');
}
