import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { schema } from '../src/db/index.ts';
import { startHarness, waitFor, type Harness } from './harness.ts';
import { startMockUpstream, type MockUpstream } from './mocks.ts';

describe('upstream OAuth: sign in once, every client gets access', () => {
  let h: Harness;
  let secure: MockUpstream;
  let serverId: string;

  beforeAll(async () => {
    h = await startHarness();
    secure = await startMockUpstream({ oauth: true });
    const res = await h.api('/api/servers', { body: { slug: 'secure', name: 'Secure', transport: 'http', url: secure.url, authType: 'oauth' } });
    serverId = res.body.server.id;
  });
  afterAll(async () => {
    await h?.close();
    await secure?.close();
  });

  it('offers a sign-in link until the server is connected', async () => {
    const client = await h.mcpClient();
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['secure__authorize']);
    const result = await client.callTool({ name: 'secure__authorize', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain(`${h.base}/connect/secure`);
    expect((await h.api(`/api/servers/${serverId}`)).body.server).toMatchObject({ status: 'needs_auth', oauth: { connected: false } });
  });

  it('asks for MCPME sign-in before starting an upstream sign-in', async () => {
    const res = await fetch(`${h.base}/connect/secure`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/signin?next=%2Fconnect%2Fsecure');
  });

  it('connects through the browser flow and shares the credential with every client', async () => {
    const watcher = await h.mcpClient();
    let notified = 0;
    watcher.setNotificationHandler(ToolListChangedNotificationSchema, () => void notified++);
    await watcher.listTools();

    // User opens the link: MCPME sends them to the upstream's login...
    const start = await fetch(`${h.base}/connect/secure`, { redirect: 'manual', headers: { cookie: h.cookie } });
    expect(start.status).toBe(302);
    const upstreamAuthorize = new URL(start.headers.get('location')!);
    expect(upstreamAuthorize.origin).toBe(new URL(secure.url).origin);
    // Discovery followed the 401 challenge to the custom metadata URL and asked for its scope.
    expect(secure.oauth.metadataHits).toBeGreaterThan(0);
    expect(upstreamAuthorize.searchParams.get('scope')).toBe('notes:read');
    // ...which (auto-approving) sends them back to MCPME's callback.
    const approved = await fetch(upstreamAuthorize, { redirect: 'manual' });
    const callback = new URL(approved.headers.get('location')!);
    expect(callback.href.startsWith(`${h.base}/oauth/upstream/callback`)).toBe(true);
    const done = await fetch(callback, { redirect: 'manual', headers: { cookie: h.cookie } });
    expect(done.headers.get('location')).toBe(`/servers/${serverId}?connected=1`);

    await waitFor(() => notified > 0);
    expect((await watcher.listTools()).tools.map((t) => t.name)).toContain('secure__echo');

    // A second client, never involved in sign-in, can use it straight away.
    const other = await h.mcpClient((await h.api('/api/tokens', { body: { name: 'other' } })).body.token);
    expect(await other.callTool({ name: 'secure__echo', arguments: { text: 'shared' } })).toMatchObject({ content: [{ text: 'echo: shared' }] });
    expect(secure.oauth.issued).toBe(1);

    // Tokens are sealed at rest.
    const [row] = await h.app.database.db.select().from(schema.serverOAuth);
    expect(row.tokensSealed).toMatch(/^v1\./);
    expect(row.tokensSealed).not.toContain(secure.calls.at(-1)!.headers.authorization!.toString().slice(7));
  });

  it('refreshes expired upstream tokens without bothering the user', async () => {
    secure.oauth.expireAll();
    const client = await h.mcpClient();
    expect(await client.callTool({ name: 'secure__echo', arguments: { text: 'after expiry' } })).toMatchObject({ content: [{ text: 'echo: after expiry' }] });
    expect(secure.oauth.refreshed).toBe(1);
    expect(secure.oauth.issued).toBe(1);
  });

  it('asks for sign-in again when the stored credential stops working', async () => {
    const client = await h.mcpClient();
    let notified = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => void notified++);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('secure__echo');
    secure.oauth.revokeAll();
    const result = await client.callTool({ name: 'secure__echo', arguments: { text: 'x' } });
    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain(`${h.base}/connect/secure`);
    await waitFor(() => notified > 0);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['secure__authorize']);
    expect((await h.api(`/api/servers/${serverId}`)).body.server.status).toBe('needs_auth');
  });

  it('can forget the credential', async () => {
    await h.api(`/api/servers/${serverId}/disconnect`, { body: {} });
    const client = await h.mcpClient();
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['secure__authorize']);
  });
});
