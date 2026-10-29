import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type Token } from '../api.ts';
import { Banner, CopyField, timeAgo } from '../ui.tsx';

export function TokensPage() {
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<{ tokens: Token[] }>('/tokens').then((r) => setTokens(r.tokens)), []);
  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const name = String(new FormData(form).get('name'));
    try {
      const res = await api<{ token: string }>('/tokens', { body: { name } });
      setCreated(res.token);
      form.reset();
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <h1>Access tokens</h1>
      <p className="muted">For MCP clients that can't sign in through the browser. Send it as <code>Authorization: Bearer &lt;token&gt;</code>.</p>

      <form className="card inline-form" onSubmit={create}>
        <label htmlFor="token-name">Name</label>
        <input id="token-name" name="name" required placeholder="Cursor on laptop" />
        <button className="btn btn-primary">Create token</button>
      </form>

      {created && (
        <Banner tone="success">
          <p>Copy this token now. You won't see it again.</p>
          <CopyField label="New token" value={created} />
        </Banner>
      )}
      {error && <Banner tone="error">{error}</Banner>}

      {tokens && tokens.length > 0 && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Token</th>
                <th>Created</th>
                <th>Last used</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>
                    <code>{t.prefix}…</code>
                  </td>
                  <td>{timeAgo(t.createdAt)}</td>
                  <td>{timeAgo(t.lastUsedAt)}</td>
                  <td className="cell-end">
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      onClick={async () => {
                        if (!confirm(`Delete "${t.name}"? Clients using it lose access.`)) return;
                        await api(`/tokens/${t.id}`, { method: 'DELETE' });
                        await load();
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
