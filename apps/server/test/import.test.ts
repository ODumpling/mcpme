import { fileURLToPath } from 'node:url';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, waitFor, type Harness } from './harness.ts';
import { startMockUpstream, type MockUpstream } from './mocks.ts';

const stdioFixture = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url));

describe('import_servers tool', () => {
  let h: Harness;
  let client: Client;
  let plain: MockUpstream;
  let guarded: MockUpstream;

  beforeAll(async () => {
    h = await startHarness();
    client = await h.mcpClient();
    plain = await startMockUpstream();
    guarded = await startMockUpstream({ oauth: true });
  });

  afterAll(async () => {
    await h?.close();
    await plain?.close();
    await guarded?.close();
  });

  const claudeConfig = () => ({
    mcpServers: {
      Plain: { type: 'http', url: plain.url },
      'Needs Login': { type: 'http', url: guarded.url },
      local: { command: process.execPath, args: [stdioFixture], env: { FIXTURE_NAME: 'imported', TOKEN: '${GH_TOKEN}' } },
      mcpme: { type: 'http', url: `${h.base}/mcp` },
      broken: { type: 'http' },
    },
    projects: { '/some/repo': { mcpServers: { keyed: { url: plain.url, headers: { 'x-api-key': 'sk-imported' } } } } },
  });

  const importServers = async (config: unknown, dryRun?: boolean) => {
    const res = await client.callTool({ name: 'mcpme__import_servers', arguments: { config, dryRun } });
    const servers: any[] = (res.structuredContent as any)?.servers ?? [];
    return { res, text: (res.content as any[])[0].text as string, by: Object.fromEntries(servers.map((s) => [s.key, s])) as Record<string, any> };
  };

  it('previews a Claude Code config without creating anything', async () => {
    const { res, text, by } = await importServers(claudeConfig(), true);
    expect(res.isError).toBeFalsy();
    expect(text).toMatch(/^Would add 4 of 6 servers/);
    expect(by.Plain).toMatchObject({ outcome: 'new', slug: 'plain', transport: 'http', authType: 'none' });
    expect(by['Needs Login']).toMatchObject({ outcome: 'new', slug: 'needs-login', authType: 'oauth' });
    expect(text).toContain(`${h.base}/connect/needs-login`);
    expect(by.local).toMatchObject({ outcome: 'new', transport: 'stdio', envKeys: ['FIXTURE_NAME', 'TOKEN'], placeholders: ['TOKEN'] });
    expect(by.keyed).toMatchObject({ outcome: 'new', authType: 'headers', headerKeys: ['x-api-key'] });
    expect(by.mcpme).toMatchObject({ outcome: 'skipped' });
    expect(by.broken).toMatchObject({ outcome: 'invalid', reason: 'No URL' });
    expect(JSON.stringify(res)).not.toContain('sk-imported');
    expect((await h.api('/api/servers')).body.servers).toEqual([]);
  });

  it('imports the servers, and skips them the second time', async () => {
    const { by } = await importServers(JSON.stringify(claudeConfig()));
    expect(Object.values(by).filter((s) => s.outcome === 'created').map((s) => s.slug).sort()).toEqual(['keyed', 'local', 'needs-login', 'plain']);

    await waitFor(async () => (await client.listTools()).tools.some((t) => t.name === 'local__whoami'));
    expect(await client.callTool({ name: 'local__whoami', arguments: {} })).toMatchObject({ content: [{ text: 'imported' }] });
    expect(await client.callTool({ name: 'keyed__echo', arguments: { text: 'x' } })).toMatchObject({ content: [{ text: 'echo: x' }] });
    expect(plain.calls.at(-1)?.headers['x-api-key']).toBe('sk-imported');

    const again = await importServers(claudeConfig());
    expect(Object.values(again.by).filter((s) => s.outcome === 'exists')).toHaveLength(4);
    expect((await h.api('/api/audit')).body.entries.some((e: any) => e.serverSlug === 'mcpme' && e.target === 'mcpme__import_servers')).toBe(true);
  });

  it('reads VS Code configs and flags URL placeholders', async () => {
    const { by } = await importServers({ servers: { 'vs-sse': { type: 'sse', url: `${plain.url}/sse` } } }, true);
    expect(by['vs-sse']).toMatchObject({ slug: 'vs-sse', transport: 'sse', placeholders: [] });
    const templated = await importServers({ mcpServers: { tpl: { url: `${plain.url}/\${SERVER_ID}` } } }, true);
    expect(templated.by.tpl).toMatchObject({ placeholders: ['url'] });
  });

  it('reports configs it can not read', async () => {
    expect(await importServers('{nope')).toMatchObject({ res: { isError: true }, text: expect.stringMatching(/valid JSON/) });
    expect(await importServers({ other: {} })).toMatchObject({ res: { isError: true }, text: expect.stringMatching(/No MCP servers/) });
  });
});
