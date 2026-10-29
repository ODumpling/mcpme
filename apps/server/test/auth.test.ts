import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createApp } from '../src/app.ts';
import { OWNER, startHarness, type Harness } from './harness.ts';

/** What an MCP client like Claude Code keeps in memory during the OAuth dance. */
class TestClientProvider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = '';
  authorizationUrl?: URL;
  redirectUrl = 'http://127.0.0.1:9/callback';
  clientMetadata = { client_name: 'Test Client', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  clientInformation() { return this.info; }
  saveClientInformation(i: OAuthClientInformationMixed) { this.info = i; }
  tokens() { return this.saved; }
  saveTokens(t: OAuthTokens) { this.saved = t; }
  redirectToAuthorization(url: URL) { this.authorizationUrl = url; }
  saveCodeVerifier(v: string) { this.verifier = v; }
  codeVerifier() { return this.verifier; }
}

/** Plays the user in the browser: follows /authorize to the consent page and submits it. */
async function consent(h: Harness, authorizationUrl: URL, form: Record<string, string>) {
  const toConsent = await fetch(authorizationUrl, { redirect: 'manual' });
  expect(toConsent.status).toBe(302);
  const consentUrl = new URL(toConsent.headers.get('location')!, h.base);
  expect(consentUrl.pathname).toBe('/oauth/consent');
  const pageRes = await fetch(consentUrl);
  const html = await pageRes.text();
  const request = consentUrl.searchParams.get('request')!;
  const res = await fetch(new URL('/oauth/consent', h.base), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request, ...form }),
  });
  return { html, res };
}

describe('MCPME login for MCP clients', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => h?.close());

  it('turns away requests without a valid token, pointing at the auth metadata', async () => {
    const res = await fetch(`${h.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${h.base}/.well-known/oauth-protected-resource/mcp"`);

    const bad = await fetch(`${h.base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{}' });
    expect(bad.status).toBe(401);

    const prm = await (await fetch(`${h.base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm).toMatchObject({ resource: `${h.base}/mcp`, authorization_servers: [`${h.base}/`] });
    const asm = await (await fetch(`${h.base}/.well-known/oauth-authorization-server`)).json();
    expect(asm).toMatchObject({ registration_endpoint: `${h.base}/register`, code_challenge_methods_supported: ['S256'] });
  });

  it('runs the browser sign-in flow and lets the client in', async () => {
    const provider = new TestClientProvider();
    const mcpUrl = new URL('/mcp', h.base);
    const transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
    await expect(new Client({ name: 't', version: '1' }).connect(transport)).rejects.toThrow(UnauthorizedError);
    expect(provider.authorizationUrl).toBeDefined();

    // Wrong password re-renders the page with an error.
    const wrong = await consent(h, provider.authorizationUrl!, { email: OWNER.email, password: 'nope', action: 'allow' });
    expect(wrong.html).toContain('Test Client');
    expect(wrong.html).toContain('Sign in to MCPME');
    expect(wrong.res.status).toBe(400);

    const ok = await consent(h, provider.authorizationUrl!, { email: OWNER.email, password: OWNER.password, action: 'allow' });
    expect(ok.res.status).toBe(302);
    const back = new URL(ok.res.headers.get('location')!);
    expect(back.origin + back.pathname).toBe(provider.redirectUrl);
    const code = back.searchParams.get('code')!;
    expect(back.searchParams.get('state')).toBe(provider.authorizationUrl!.searchParams.get('state'));

    await transport.finishAuth(code);
    expect(provider.saved?.access_token).toMatch(/^mcpme_at_/);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }));
    expect(await client.listTools()).toEqual({ tools: [] });
    await client.close();

    // The code is single-use.
    const replay = await fetch(`${h.base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: provider.verifier, client_id: (provider.info as any).client_id, redirect_uri: provider.redirectUrl }),
    });
    expect(replay.status).toBe(400);

    // Refresh tokens rotate.
    const refresh = async (token: string) =>
      fetch(`${h.base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: (provider.info as any).client_id }),
      });
    const first = await refresh(provider.saved!.refresh_token!);
    expect(first.status).toBe(200);
    expect((await refresh(provider.saved!.refresh_token!)).status).toBe(400);
  });

  it('sends the client back with access_denied when the user denies', async () => {
    const provider = new TestClientProvider();
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', h.base), { authProvider: provider });
    await expect(new Client({ name: 't', version: '1' }).connect(transport)).rejects.toThrow(UnauthorizedError);
    const { res } = await consent(h, provider.authorizationUrl!, { action: 'deny' });
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
  });

  it('accepts personal access tokens, and stops accepting them once deleted', async () => {
    const created = await h.api('/api/tokens', { body: { name: 'cursor' } });
    const client = await h.mcpClient(created.body.token);
    expect(await client.listTools()).toEqual({ tools: [] });
    await h.api(`/api/tokens/${created.body.record.id}`, { method: 'DELETE' });
    await expect(h.mcpClient(created.body.token)).rejects.toThrow();
  });

  it('requires a session for the admin API and JSON for mutations', async () => {
    expect((await fetch(`${h.base}/api/servers`)).status).toBe(401);
    const form = await fetch(`${h.base}/api/servers`, { method: 'POST', headers: { cookie: h.cookie, 'content-type': 'text/plain' }, body: '{}' });
    expect(form.status).toBe(415);
  });
});

describe('first-run setup', () => {
  it('needs the setup code from the logs and only works once', async () => {
    const app = await createApp(
      { publicUrl: new URL('http://localhost:1'), port: 0, dataDir: mkdtempSync(join(tmpdir(), 'mcpme-')), secretKey: randomBytes(32) },
      { inMemoryDb: true },
    );
    try {
      await expect(app.owners.setup('a@b.co', 'longenough', 'wrong')).rejects.toThrow('Wrong setup code');
      await app.owners.setup('a@b.co', 'longenough', app.owners.setupCode);
      await expect(app.owners.setup('c@d.co', 'longenough', app.owners.setupCode)).rejects.toThrow('already set up');
    } finally {
      await app.close();
    }
  });
});
