<img src="assets/icon.svg" width="64" height="64" alt="">

# MCPME

One MCP server that gives you all of yours.

Register your MCP servers with MCPME once, then add MCPME as the only server in Claude Code, Cursor, VS Code or any other MCP client. You get:

- **Every tool in one place.** Tools and prompts appear as `<server>__<name>` (e.g. `github__create_issue`). Resources appear as `mcpme://<server>/<uri>`.
- **Sign in to each server once.** For OAuth servers, MCPME does the browser sign-in, stores the token encrypted and refreshes it. API keys and env vars are also stored encrypted. Every connected client uses the same credential.
- **Only you get in.** MCP clients must sign in to MCPME, using the standard MCP OAuth flow (a browser login page opens, like Azure DevOps or GitHub MCP) or a personal access token.
- **Switches for every tool.** Turn off any tool, prompt or resource, or a whole server. It disappears from your clients and calls to it are blocked at MCPME; the server itself never knows.
- **Activity log** of every call: who, what, result, duration. Arguments aren't stored.

v1 has a single user account.

## Run it

```bash
docker build -t mcpme .
docker run -p 3000:3000 -v mcpme-data:/data \
  -e MCPME_PUBLIC_URL=https://mcpme.example.com \
  -e MCPME_SECRET_KEY=$(openssl rand -hex 32) \
  mcpme
```

On first start the logs print a **setup code**. Open the public URL, enter it and create your account. The code stops a stranger from claiming a fresh instance.

| Variable | Default | |
|---|---|---|
| `MCPME_PUBLIC_URL` | `http://localhost:$PORT` | Where clients reach MCPME. Must be `https` unless it's localhost. Used for OAuth redirects. |
| `MCPME_SECRET_KEY` | generated into `$MCPME_DATA_DIR/secret.key` | 32 bytes (64 hex chars or base64). Encrypts stored credentials. Back it up; without it stored credentials are lost. |
| `DATABASE_URL` | unset | Postgres connection string. If unset, an embedded database (PGlite) in the data dir is used. |
| `MCPME_DATA_DIR` | `./data` (`/data` in Docker) | Embedded database and generated key. |
| `PORT` | `3000` | |

stdio servers run inside the MCPME container. The image includes `node`/`npx`, `python3` and `uv`/`uvx`.

### Coolify

Create an application from this repo with the Dockerfile build pack, expose port 3000, attach a persistent volume at `/data`, and set `MCPME_PUBLIC_URL` to the app's domain and `MCPME_SECRET_KEY`. Optionally add a Postgres database and set `DATABASE_URL`.

### Tailnet only

`compose.tailscale.yaml` runs MCPME with a Tailscale sidecar that serves it at `https://mcpme.<tailnet>.ts.net`. No port is published, so only devices on your tailnet can reach it. Turn on MagicDNS and HTTPS certificates for the tailnet, then:

```bash
MCPME_PUBLIC_URL=https://mcpme.<tailnet>.ts.net TS_AUTHKEY=tskey-auth-... \
  docker compose -f compose.tailscale.yaml up -d
```

The sidecar's login is kept in the `tailscale-state` volume, so `TS_AUTHKEY` is only needed the first time. In Coolify, use the Docker Compose build pack with `compose.tailscale.yaml` and set no domain. Cloud-hosted clients such as claude.ai connectors can't reach a tailnet-only instance.

## Connect a client

Use `https://<your-host>/mcp`. For Claude Code:

```bash
claude mcp add --transport http mcpme https://<your-host>/mcp
```

The client opens MCPME's sign-in page in your browser the first time. Clients without OAuth support can send `Authorization: Bearer <token>` with a token from the **Tokens** page.

If a server needs its own sign-in, it shows up as a single `<server>__authorize` tool until you connect it. Calling it returns a link (clients that support URL elicitation open it directly). You can also sign in from the server's page in the dashboard.

## Develop

```bash
pnpm install
pnpm dev          # server on :3000 (watch), UI on :5173 with a proxy to the server
pnpm test         # integration tests with mock HTTP, OAuth and stdio MCP servers
pnpm typecheck
pnpm build
```

`apps/server` is the gateway (Express, MCP TypeScript SDK, Drizzle). `apps/web` is the dashboard (React, Vite). After changing `apps/server/src/db/schema.ts`, run `pnpm --filter @mcpme/server db:generate` to add a migration; migrations run on startup.
