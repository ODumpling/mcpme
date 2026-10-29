export type Transport = 'http' | 'sse' | 'stdio';
export type AuthType = 'none' | 'headers' | 'oauth';
export type Status = 'idle' | 'connecting' | 'connected' | 'error' | 'needs_auth' | 'disabled';
export type ItemKind = 'tool' | 'prompt' | 'resource' | 'resource_template';

export interface ServerSummary {
  id: string;
  slug: string;
  name: string;
  transport: Transport;
  url: string | null;
  command: string | null;
  args: string[];
  authType: AuthType;
  enabled: boolean;
  newItemsEnabled: boolean;
  envKeys: string[];
  headerKeys: string[];
  status: Status;
  lastError: string | null;
  oauth: { connected: boolean; connectedAt: string | null } | null;
  counts: { tools: number; prompts: number; resources: number };
  createdAt: string;
}

export interface Item {
  kind: ItemKind;
  name: string;
  title: string | null;
  description: string | null;
  enabled: boolean;
  explicit: boolean;
}

export interface Token {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AuditEntry {
  id: number;
  serverSlug: string;
  method: string;
  target: string;
  status: 'ok' | 'error' | 'blocked';
  error: string | null;
  durationMs: number;
  createdAt: string;
}

export interface AppState {
  setupRequired: boolean;
  user: { id: string; email: string } | null;
  mcpUrl: string;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? (init.body !== undefined ? 'POST' : 'GET');
  const res = await fetch(`/api${path}`, {
    method,
    headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  return data as T;
}
