import { z } from 'zod';

/** Prefix of MCPME's own tools (`mcpme__import_servers`), so no registered server can use it. */
export const RESERVED_SLUG = 'mcpme';

const slug = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/, 'Use 1–32 lowercase letters, numbers and dashes')
  .refine((s) => !s.includes('--'), 'Use single dashes')
  .refine((s) => s !== RESERVED_SLUG, `"${RESERVED_SLUG}" is reserved for MCPME's own tools`);
const httpUrl = z.string().url().refine((u) => /^https?:$/.test(new URL(u).protocol), 'Use an http(s) URL');
const record = z.record(z.string().min(1), z.string());

const serverBase = z.object({
  slug,
  name: z.string().trim().min(1).max(80),
  transport: z.enum(['http', 'sse', 'stdio']),
  url: httpUrl.nullish(),
  command: z.string().trim().min(1).nullish(),
  args: z.array(z.string()).optional(),
  env: record.optional(),
  authType: z.enum(['none', 'headers', 'oauth']),
  headers: record.optional(),
  enabled: z.boolean().optional(),
  newItemsEnabled: z.boolean().optional(),
});

export function checkTransport(s: Partial<z.infer<typeof serverBase>>, ctx: z.RefinementCtx) {
  if (s.transport === 'stdio') {
    if (!s.command) ctx.addIssue({ code: 'custom', path: ['command'], message: 'Command is required for stdio servers' });
    if (s.authType === 'oauth') ctx.addIssue({ code: 'custom', path: ['authType'], message: 'stdio servers use env vars, not OAuth' });
  } else if (s.transport && !s.url) {
    ctx.addIssue({ code: 'custom', path: ['url'], message: 'URL is required for HTTP and SSE servers' });
  }
}

export const createServer = serverBase.superRefine(checkTransport);
export const updateServer = serverBase.partial();
