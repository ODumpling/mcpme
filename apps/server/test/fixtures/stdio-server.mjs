// Minimal stdio MCP server used by the tests.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'stdio-fixture', version: '1.0.0' });
server.registerTool('whoami', { description: 'Returns FIXTURE_NAME from env' }, async () => ({
  content: [{ type: 'text', text: process.env.FIXTURE_NAME ?? 'unset' }],
}));
server.registerTool('add_tool', { description: 'Registers a new tool at runtime', inputSchema: { name: z.string() } }, async ({ name }) => {
  server.registerTool(name, { description: 'Added at runtime' }, async () => ({ content: [{ type: 'text', text: `hi from ${name}` }] }));
  return { content: [{ type: 'text', text: 'added' }] };
});
await server.connect(new StdioServerTransport());
