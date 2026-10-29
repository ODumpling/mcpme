import { useEffect, useState } from 'react';
import { api, type ServerSummary } from '../api.ts';
import { Link } from '../router.tsx';
import { Banner, CopyField, StatusBadge } from '../ui.tsx';

export function ServersPage({ mcpUrl }: { mcpUrl: string }) {
  const [servers, setServers] = useState<ServerSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ servers: ServerSummary[] }>('/servers')
        .then((r) => alive && setServers(r.servers))
        .catch((e) => alive && setError(e.message));
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <>
      <section className="card connect-card">
        <h2>Connect your MCP client</h2>
        <p className="muted">Add this one URL to Claude Code, Cursor, VS Code or any MCP client. It will open a browser to sign in to MCPME the first time.</p>
        <CopyField label="MCP URL" value={mcpUrl} />
        <details>
          <summary>Claude Code command</summary>
          <CopyField label="Claude Code command" value={`claude mcp add --scope user --transport http mcpme ${mcpUrl}`} />
        </details>
      </section>

      <div className="page-head">
        <h1>Servers</h1>
        <Link href="/servers/new" className="btn btn-primary">
          Add server
        </Link>
      </div>

      {error && <Banner tone="error">{error}</Banner>}
      {servers?.length === 0 && (
        <div className="card empty">
          <h2>No servers yet</h2>
          <p className="muted">Add an MCP server and its tools show up in every client connected to MCPME.</p>
          <Link href="/servers/new" className="btn btn-primary">
            Add your first server
          </Link>
        </div>
      )}
      {servers && servers.length > 0 && (
        <ul className="server-list">
          {servers.map((s) => (
            <li key={s.id}>
              <Link href={`/servers/${s.id}`} className="card server-row">
                <div className="server-main">
                  <div className="server-name">
                    {s.name} <span className="slug">{s.slug}</span>
                  </div>
                  <div className="muted truncate">{s.transport === 'stdio' ? [s.command, ...s.args].join(' ') : s.url}</div>
                </div>
                <div className="server-meta">
                  <span className="muted tabular">
                    {s.counts.tools} {s.counts.tools === 1 ? 'tool' : 'tools'}
                  </span>
                  <StatusBadge status={s.status} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
