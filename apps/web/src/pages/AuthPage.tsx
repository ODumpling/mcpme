import { useState, type FormEvent } from 'react';
import { api } from '../api.ts';
import { Banner, Field } from '../ui.tsx';

export function AuthPage({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    setError(null);
    try {
      await api(setup ? '/setup' : '/login', { body: form });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand">
          <img src="/icon.svg" alt="" width={28} height={28} />
          MCPME
        </div>
        <h1>{setup ? 'Create your account' : 'Sign in'}</h1>
        <p className="muted">
          {setup ? 'This account is the only one that can use your MCP servers through MCPME.' : 'Sign in to manage your MCP servers.'}
        </p>
        {setup && (
          <Field label="Name" htmlFor="name">
            <input id="name" name="name" required autoComplete="name" autoFocus />
          </Field>
        )}
        <Field label="Email" htmlFor="email">
          <input id="email" name="email" type="email" required autoComplete="username" autoFocus={!setup} />
        </Field>
        <Field label="Password" htmlFor="password" hint={setup ? 'At least 8 characters.' : undefined}>
          <input id="password" name="password" type="password" required minLength={setup ? 8 : undefined} autoComplete={setup ? 'new-password' : 'current-password'} />
        </Field>
        {error && <Banner tone="error">{error}</Banner>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {setup ? 'Create account' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
