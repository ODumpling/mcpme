import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Item, type ItemKind, type ServerSummary } from '../api.ts';
import { Link, navigate } from '../router.tsx';
import { Banner, StatusBadge, Switch, timeAgo } from '../ui.tsx';

interface Detail {
  server: ServerSummary;
  items: Item[];
  stderr: string[];
}

const kindLabels: Record<ItemKind, string> = {
  tool: 'Tools',
  prompt: 'Prompts',
  resource: 'Resources',
  resource_template: 'Resource templates',
};

export function ServerPage({ id, justConnected }: { id: string; justConnected: boolean }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');

  const load = useCallback(() => api<Detail>(`/servers/${id}`).then(setDetail).catch((e) => setError(e.message)), [id]);
  useEffect(() => {
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setItems = (items: { kind: ItemKind; name: string; enabled: boolean }[]) =>
    run(async () => {
      // Optimistic: flip locally first so switches feel instant.
      setDetail((d) => d && { ...d, items: d.items.map((i) => ({ ...i, ...(items.find((x) => x.kind === i.kind && x.name === i.name) ?? {}) })) });
      await api(`/servers/${id}/items`, { method: 'PUT', body: { items } });
    });

  const patch = (body: Partial<ServerSummary>) => run(() => api(`/servers/${id}`, { method: 'PATCH', body }));

  const connect = () =>
    run(async () => {
      const { authorizationUrl } = await api<{ authorizationUrl: string | null }>(`/servers/${id}/connect`, { body: {} });
      if (authorizationUrl) window.location.href = authorizationUrl;
    });

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const items = (detail?.items ?? []).filter((i) => !q || `${i.name} ${i.title ?? ''} ${i.description ?? ''}`.toLowerCase().includes(q));
    return (Object.keys(kindLabels) as ItemKind[]).map((kind) => ({ kind, items: items.filter((i) => i.kind === kind) })).filter((g) => g.items.length);
  }, [detail, filter]);

  if (!detail) return error ? <Banner tone="error">{error}</Banner> : null;
  const s = detail.server;

  return (
    <>
      <p className="crumbs">
        <Link href="/">Servers</Link> / {s.name}
      </p>
      <div className="page-head">
        <div>
          <h1>
            {s.name} <span className="slug">{s.slug}</span>
          </h1>
          <p className="muted truncate">{s.transport === 'stdio' ? [s.command, ...s.args].join(' ') : s.url}</p>
        </div>
        <div className="actions">
          <Link href={`/servers/${id}/edit`} className="btn">
            Edit
          </Link>
          <button type="button" className="btn" disabled={busy || !s.enabled} onClick={() => run(() => api(`/servers/${id}/refresh`, { body: {} }))}>
            Reconnect
          </button>
        </div>
      </div>

      {justConnected && s.status === 'connected' && <Banner tone="success">Signed in to {s.name}. Every client connected to MCPME can use it now.</Banner>}
      {error && <Banner tone="error">{error}</Banner>}

      <section className="card stack">
        <div className="row">
          <div>
            <div className="label">Status</div>
            <StatusBadge status={s.status} />
            {s.lastError && s.status !== 'needs_auth' && <p className="error-text">{s.lastError}</p>}
          </div>
          <div className="row-end">
            <span className="muted">{s.enabled ? 'On' : 'Off'}</span>
            <Switch label="Server on" checked={s.enabled} disabled={busy} onChange={(enabled) => patch({ enabled })} />
          </div>
        </div>

        {s.authType === 'oauth' && (
          <div className="row">
            <div>
              <div className="label">Sign-in</div>
              {s.oauth?.connected ? (
                <span>Signed in {timeAgo(s.oauth.connectedAt)}. Shared by all your MCP clients.</span>
              ) : (
                <span className="muted">Not signed in yet. Sign in once and every client gets access.</span>
              )}
            </div>
            <div className="row-end">
              {s.oauth?.connected && (
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => run(() => api(`/servers/${id}/disconnect`, { body: {} }))}>
                  Sign out
                </button>
              )}
              <button type="button" className={s.oauth?.connected ? 'btn' : 'btn btn-primary'} disabled={busy} onClick={connect}>
                {s.oauth?.connected ? 'Sign in again' : `Sign in to ${s.name}`}
              </button>
            </div>
          </div>
        )}

        <div className="row">
          <div>
            <div className="label">New tools</div>
            <span className="muted">Whether tools this server adds later are on or off until you choose.</span>
          </div>
          <div className="row-end">
            <span className="muted">{s.newItemsEnabled ? 'On' : 'Off'}</span>
            <Switch label="New tools on by default" checked={s.newItemsEnabled} disabled={busy} onChange={(newItemsEnabled) => patch({ newItemsEnabled })} />
          </div>
        </div>
      </section>

      <div className="page-head">
        <h2>What clients can use</h2>
        {detail.items.length > 0 && (
          <input className="search" type="search" placeholder="Filter…" aria-label="Filter tools" value={filter} onChange={(e) => setFilter(e.target.value)} />
        )}
      </div>
      <p className="muted">
        Switched-off items are hidden from your MCP clients and calls to them are blocked by MCPME. {s.name} isn't told.
      </p>

      {detail.items.length === 0 && (
        <div className="card empty">
          <p className="muted">
            {s.status === 'connected' ? `${s.name} doesn't offer any tools.` : s.status === 'needs_auth' ? `Sign in to ${s.name} to see its tools.` : `Connect ${s.name} to see its tools.`}
          </p>
        </div>
      )}

      {groups.map((g) => {
        const allOn = g.items.every((i) => i.enabled);
        return (
          <section key={g.kind} className="card items">
            <div className="items-head">
              <h3>
                {kindLabels[g.kind]} <span className="muted tabular">{g.items.filter((i) => i.enabled).length}/{g.items.length}</span>
              </h3>
              <button type="button" className="btn btn-ghost btn-small" disabled={busy} onClick={() => setItems(g.items.map((i) => ({ kind: i.kind, name: i.name, enabled: !allOn })))}>
                {allOn ? 'Turn all off' : 'Turn all on'}
              </button>
            </div>
            <ul>
              {g.items.map((i) => (
                <li key={i.name} className={i.enabled ? 'item' : 'item item-off'}>
                  <div className="item-text">
                    <code>{i.name}</code>
                    {i.title && i.title !== i.name && <span className="item-title">{i.title}</span>}
                    {i.description && <p className="muted clamp">{i.description}</p>}
                  </div>
                  <Switch label={`${i.name} on`} checked={i.enabled} onChange={(enabled) => setItems([{ kind: i.kind, name: i.name, enabled }])} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {s.transport === 'stdio' && detail.stderr.length > 0 && (
        <details className="card">
          <summary>Server output (stderr)</summary>
          <pre className="log">{detail.stderr.join('\n')}</pre>
        </details>
      )}

      <section className="danger-zone">
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy}
          onClick={async () => {
            if (!confirm(`Remove ${s.name}? Its stored credentials are deleted too.`)) return;
            setBusy(true);
            try {
              await api(`/servers/${id}`, { method: 'DELETE' });
              navigate('/');
            } catch (e) {
              setError((e as Error).message);
              setBusy(false);
            }
          }}
        >
          Remove server
        </button>
      </section>
    </>
  );
}
