import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
config.webDir ??= fileURLToPath(new URL('../../web/dist', import.meta.url));
const app = await createApp(config);

const server = app.express.listen(config.port, async () => {
  console.log(`MCPME listening on :${config.port}`);
  console.log(`MCP endpoint: ${app.mcpUrl.href}`);
  if (!(await app.owners.hasOwner())) {
    console.log(`First run: open ${config.publicUrl.href} and enter setup code ${app.owners.setupCode}`);
  }
});

const shutdown = async () => {
  server.close();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
