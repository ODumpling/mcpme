import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, type AuthType, type ServerSummary, type Transport } from '../api.ts';
import { Link, navigate } from '../router.tsx';
import { Banner, Field } from '../ui.tsx';

interface Pair {
  key: string;
  value: string;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

function PairsEditor({ pairs, onChange, keyPlaceholder, valuePlaceholder }: { pairs: Pair[]; onChange: (p: Pair[]) => void; keyPlaceholder: string; valuePlaceholder: string }) {
  return (
    <div className="pairs">
      {pairs.map((p, i) => (
        <div key={i} className="pair">
          <input aria-label="Name" placeholder={keyPlaceholder} value={p.key} spellCheck={false} onChange={(e) => onChange(pairs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
          <input aria-label="Value" placeholder={valuePlaceholder} type="password" autoComplete="off" value={p.value} onChange={(e) => onChange(pairs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
          <button type="button" className="btn btn-ghost btn-small" aria-label="Remove" onClick={() => onChange(pairs.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-small" onClick={() => onChange([...pairs, { key: '', value: '' }])}>
        Add
      </button>
    </div>
  );
}

const toRecord = (pairs: Pair[]) => Object.fromEntries(pairs.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value]));

export function ServerForm({ id }: { id?: string }) {
  const [existing, setExisting] = useState<ServerSummary | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [transport, setTransport] = useState<Transport>('http');
  const [url, setUrl] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [authType, setAuthType] = useState<AuthType>('none');
  const [headers, setHeaders] = useState<Pair[]>([]);
  const [env, setEnv] = useState<Pair[]>([]);
  const [replaceSecrets, setReplaceSecrets] = useState(!id);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    api<{ server: ServerSummary }>(`/servers/${id}`).then(({ server: s }) => {
      setExisting(s);
      setName(s.name);
      setSlug(s.slug);
      setSlugTouched(true);
      setTransport(s.transport);
      setUrl(s.url ?? '');
      setCommand(s.command ?? '');
      setArgs(s.args.join('\n'));
      setAuthType(s.authType);
    });
  }, [id]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const stdio = transport === 'stdio';
    const body: Record<string, unknown> = {
      name,
      slug,
      transport,
      url: stdio ? null : url,
      command: stdio ? command : null,
      args: stdio ? args.split('\n').map((a) => a.trim()).filter(Boolean) : [],
      authType: stdio && authType === 'oauth' ? 'none' : authType,
    };
    if (replaceSecrets) {
      body.headers = !stdio && authType === 'headers' ? toRecord(headers) : {};
      body.env = stdio ? toRecord(env) : {};
    }
    try {
      const res = await api<{ server: ServerSummary }>(id ? `/servers/${id}` : '/servers', { method: id ? 'PATCH' : 'POST', body });
      navigate(`/servers/${res.server.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (id && !existing) return null;
  const savedKeys = transport === 'stdio' ? existing?.envKeys : existing?.headerKeys;

  return (
    <>
      <p className="crumbs">
        <Link href="/">Servers</Link> / {id ? `Edit ${existing?.name}` : 'Add server'}
      </p>
      <h1>{id ? `Edit ${existing?.name}` : 'Add a server'}</h1>
      <form className="card stack form" onSubmit={submit}>
        <Field label="Name" htmlFor="name">
          <input
            id="name"
            required
            value={name}
            placeholder="GitHub"
            onChange={(e) => {
              setName(e.target.value);
              if (!slugTouched) setSlug(slugify(e.target.value));
            }}
          />
        </Field>
        <Field label="Slug" htmlFor="slug" hint={<>Prefix for this server's tools, e.g. <code>{slug || 'github'}__create_issue</code>.</>}>
          <input id="slug" required value={slug} pattern="[a-z0-9]([a-z0-9\-]{0,30}[a-z0-9])?" spellCheck={false} onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }} />
        </Field>

        <fieldset>
          <legend>How MCPME reaches it</legend>
          <div className="segmented">
            {([
              ['http', 'HTTP'],
              ['sse', 'SSE (legacy)'],
              ['stdio', 'Local command'],
            ] as const).map(([value, label]) => (
              <label key={value}>
                <input type="radio" name="transport" value={value} checked={transport === value} onChange={() => setTransport(value)} />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        {transport === 'stdio' ? (
          <>
            <Field label="Command" htmlFor="command" hint="Runs inside the MCPME container.">
              <input id="command" required value={command} placeholder="npx" spellCheck={false} onChange={(e) => setCommand(e.target.value)} />
            </Field>
            <Field label="Arguments" htmlFor="args" hint="One per line.">
              <textarea id="args" rows={3} value={args} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/data'} spellCheck={false} onChange={(e) => setArgs(e.target.value)} />
            </Field>
          </>
        ) : (
          <>
            <Field label="URL" htmlFor="url">
              <input id="url" type="url" required value={url} placeholder="https://example.com/mcp" spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
            </Field>
            <fieldset>
              <legend>Sign-in</legend>
              <div className="segmented">
                {([
                  ['none', 'None'],
                  ['headers', 'API key / headers'],
                  ['oauth', 'OAuth (browser sign-in)'],
                ] as const).map(([value, label]) => (
                  <label key={value}>
                    <input type="radio" name="authType" value={value} checked={authType === value} onChange={() => setAuthType(value)} />
                    {label}
                  </label>
                ))}
              </div>
              {authType === 'oauth' && <p className="hint">After saving, sign in once from the server page. MCPME keeps the token and refreshes it.</p>}
            </fieldset>
          </>
        )}

        {(transport === 'stdio' || authType === 'headers') && (
          <fieldset>
            <legend>{transport === 'stdio' ? 'Environment variables' : 'Headers'}</legend>
            {savedKeys && savedKeys.length > 0 && !replaceSecrets && (
              <p className="hint">
                Saved: {savedKeys.map((k) => <code key={k}>{k}</code>).reduce<ReactNode[]>((acc, el, i) => (i ? [...acc, ', ', el] : [el]), [])}. Values are encrypted and never shown.
              </p>
            )}
            {replaceSecrets ? (
              <PairsEditor
                pairs={transport === 'stdio' ? env : headers}
                onChange={transport === 'stdio' ? setEnv : setHeaders}
                keyPlaceholder={transport === 'stdio' ? 'API_KEY' : 'Authorization'}
                valuePlaceholder={transport === 'stdio' ? 'value' : 'Bearer …'}
              />
            ) : (
              <button type="button" className="btn btn-small" onClick={() => setReplaceSecrets(true)}>
                Replace {transport === 'stdio' ? 'variables' : 'headers'}
              </button>
            )}
          </fieldset>
        )}

        {error && <Banner tone="error">{error}</Banner>}
        <div className="actions">
          <button className="btn btn-primary" disabled={busy}>
            {id ? 'Save changes' : 'Add server'}
          </button>
          <Link href={id ? `/servers/${id}` : '/'} className="btn btn-ghost">
            Cancel
          </Link>
        </div>
      </form>
    </>
  );
}
