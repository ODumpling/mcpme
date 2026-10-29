import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { startHarness, waitFor, type Harness } from './harness.ts';
import { startMockUpstream, type MockUpstream } from './mocks.ts';

const stdioFixture = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url));

describe('gateway', () => {
  let h: Harness;
  let alpha: MockUpstream;
  let keyed: MockUpstream;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    h = await startHarness();
    alpha = await startMockUpstream();
    keyed = await startMockUpstream({ requireHeader: ['x-api-key', 'sk-very-secret'] });
    for (const body of [
      { slug: 'alpha', name: 'Alpha', transport: 'http', url: alpha.url, authType: 'none' },
      { slug: 'keyed', name: 'Keyed', transport: 'http', url: keyed.url, authType: 'headers', headers: { 'x-api-key': 'sk-very-secret' } },
      { slug: 'local', name: 'Local', transport: 'stdio', command: process.execPath, args: [stdioFixture], env: { FIXTURE_NAME: 'from-env' }, authType: 'none' },
    ]) {
      const res = await h.api('/api/servers', { body });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      ids[body.slug] = res.body.server.id;
    }
  });

  afterAll(async () => {
    await h?.close();
    await alpha?.close();
    await keyed?.close();
  });

  it('combines tools from every server under namespaced names', async () => {
    const client = await h.mcpClient();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['alpha__delete_everything', 'alpha__echo', 'alpha__link', 'keyed__delete_everything', 'keyed__echo', 'keyed__link', 'local__add_tool', 'local__whoami']);
  });

  it('forwards tool calls to the right server, with stored headers and env', async () => {
    const client = await h.mcpClient();
    expect(await client.callTool({ name: 'alpha__echo', arguments: { text: 'hi' } })).toMatchObject({ content: [{ text: 'echo: hi' }] });
    expect(await client.callTool({ name: 'keyed__echo', arguments: { text: 'k' } })).toMatchObject({ content: [{ text: 'echo: k' }] });
    expect(keyed.calls.at(-1)?.headers['x-api-key']).toBe('sk-very-secret');
    expect(await client.callTool({ name: 'local__whoami', arguments: {} })).toMatchObject({ content: [{ text: 'from-env' }] });
  });

  it('never returns stored secrets from the admin API', async () => {
    const res = await h.api(`/api/servers/${ids.keyed}`);
    expect(res.body.server.headerKeys).toEqual(['x-api-key']);
    expect(JSON.stringify(res.body)).not.toContain('sk-very-secret');
    const local = await h.api(`/api/servers/${ids.local}`);
    expect(JSON.stringify(local.body)).not.toContain('from-env');
  });

  it('proxies prompts and resources with rewritten URIs', async () => {
    const client = await h.mcpClient();
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toContain('alpha__greet');
    expect(await client.getPrompt({ name: 'alpha__greet', arguments: { who: 'Ada' } })).toMatchObject({
      messages: [{ content: { text: 'Hello Ada' } }],
    });
    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri)).toContain('mcpme://alpha/memo://one');
    expect(await client.readResource({ uri: 'mcpme://alpha/memo://one' })).toMatchObject({ contents: [{ uri: 'mcpme://alpha/memo://one', text: 'memo one' }] });
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((t) => t.uriTemplate)).toContain('mcpme://alpha/memo://items/{id}');
    expect(await client.readResource({ uri: 'mcpme://alpha/memo://items/7' })).toMatchObject({ contents: [{ text: 'item 7' }] });
  });

  it('rewrites resource links in tool results so they can be read back', async () => {
    const client = await h.mcpClient();
    const result = await client.callTool({ name: 'alpha__link', arguments: {} });
    expect(result.content).toEqual([{ type: 'resource_link', uri: 'mcpme://alpha/memo://one', name: 'memo' }]);
    expect(await client.readResource({ uri: 'mcpme://alpha/memo://one' })).toMatchObject({ contents: [{ text: 'memo one' }] });
  });

  it('honours a saved resource switch even for URIs the server no longer lists', async () => {
    const client = await h.mcpClient();
    expect(await client.readResource({ uri: 'mcpme://alpha/memo://items/9' })).toMatchObject({ contents: [{ text: 'item 9' }] });
    await h.api(`/api/servers/${ids.alpha}/items`, { method: 'PUT', body: { items: [{ kind: 'resource', name: 'memo://items/9', enabled: false }] } });
    await expect(client.readResource({ uri: 'mcpme://alpha/memo://items/9' })).rejects.toThrow(/Unknown resource/);
  });

  it('hides switched-off tools and blocks calls before they reach the server', async () => {
    const client = await h.mcpClient();
    let notified = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => void notified++);
    // Open the standalone SSE stream notifications arrive on.
    await client.listTools();

    const res = await h.api(`/api/servers/${ids.alpha}/items`, { method: 'PUT', body: { items: [{ kind: 'tool', name: 'delete_everything', enabled: false }] } });
    expect(res.status).toBe(200);
    expect(res.body.items.find((i: any) => i.name === 'delete_everything')).toMatchObject({ enabled: false, explicit: true });

    await waitFor(() => notified > 0);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('alpha__delete_everything');
    expect(names).toContain('keyed__delete_everything');

    const before = alpha.calls.length;
    await expect(client.callTool({ name: 'alpha__delete_everything', arguments: {} })).rejects.toThrow(/Unknown tool/);
    expect(alpha.calls.length).toBe(before);

    await h.app.audit.flush();
    const audit = await h.api('/api/audit');
    expect(audit.body.entries[0]).toMatchObject({ serverSlug: 'alpha', target: 'alpha__delete_everything', status: 'blocked' });
  });

  it('can switch a whole server off and back on', async () => {
    const client = await h.mcpClient();
    await h.api(`/api/servers/${ids.alpha}`, { method: 'PATCH', body: { enabled: false } });
    const before = alpha.calls.length;
    expect((await client.listTools()).tools.some((t) => t.name.startsWith('alpha__'))).toBe(false);
    await expect(client.callTool({ name: 'alpha__echo', arguments: { text: 'x' } })).rejects.toThrow(/Unknown tool/);
    expect(alpha.calls.length).toBe(before);

    await h.api(`/api/servers/${ids.alpha}`, { method: 'PATCH', body: { enabled: true } });
    await waitFor(async () => (await client.listTools()).tools.some((t) => t.name === 'alpha__echo'));
  });

  it('follows upstream list changes, applying the default for new tools', async () => {
    const client = await h.mcpClient();
    await client.callTool({ name: 'local__add_tool', arguments: { name: 'fresh' } });
    await waitFor(async () => (await client.listTools()).tools.some((t) => t.name === 'local__fresh'));

    // New tools hidden by default, but keep add_tool on explicitly.
    await h.api(`/api/servers/${ids.local}/items`, { method: 'PUT', body: { items: [{ kind: 'tool', name: 'add_tool', enabled: true }] } });
    await h.api(`/api/servers/${ids.local}`, { method: 'PATCH', body: { newItemsEnabled: false } });
    await waitFor(async () => (await client.listTools()).tools.some((t) => t.name === 'local__add_tool'));
    await client.callTool({ name: 'local__add_tool', arguments: { name: 'hidden' } });
    await waitFor(async () => (await h.api(`/api/servers/${ids.local}`)).body.items.some((i: any) => i.name === 'hidden'));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('local__add_tool');
    expect(names).not.toContain('local__hidden');
    expect(names).not.toContain('local__whoami');
  });

  it('rejects bad server definitions', async () => {
    expect((await h.api('/api/servers', { body: { slug: 'Bad_Slug', name: 'x', transport: 'http', url: 'http://x', authType: 'none' } })).status).toBe(400);
    expect((await h.api('/api/servers', { body: { slug: 'nourl', name: 'x', transport: 'http', authType: 'none' } })).status).toBe(400);
    expect((await h.api('/api/servers', { body: { slug: 'alpha', name: 'x', transport: 'http', url: 'http://x', authType: 'none' } })).status).toBe(409);
  });
});
