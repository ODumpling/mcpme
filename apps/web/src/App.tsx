import { useCallback, useEffect, useState } from 'react';
import { api, type AppState } from './api.ts';
import { Link, navigate, useLocation } from './router.tsx';
import { AuthPage } from './pages/AuthPage.tsx';
import { ServersPage } from './pages/ServersPage.tsx';
import { ServerPage } from './pages/ServerPage.tsx';
import { ServerForm } from './pages/ServerForm.tsx';
import { TokensPage } from './pages/TokensPage.tsx';
import { ActivityPage } from './pages/ActivityPage.tsx';

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const load = useCallback(() => api<AppState>('/state').then(setState), []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!state) return null;
  if (!state.user) return <AuthPage setup={state.setupRequired} onDone={load} />;
  return <Shell state={state} onSignOut={load} />;
}

const nav = [
  { href: '/', label: 'Servers' },
  { href: '/tokens', label: 'Tokens' },
  { href: '/activity', label: 'Activity' },
];

function Shell({ state, onSignOut }: { state: AppState; onSignOut: () => void }) {
  const url = useLocation();
  const path = url.pathname;
  const serverMatch = path.match(/^\/servers\/([^/]+)(\/edit)?$/);

  let page;
  if (path === '/servers/new') page = <ServerForm />;
  else if (serverMatch?.[2]) page = <ServerForm id={serverMatch[1]} />;
  else if (serverMatch) page = <ServerPage id={serverMatch[1]} justConnected={url.searchParams.has('connected')} />;
  else if (path === '/tokens') page = <TokensPage />;
  else if (path === '/activity') page = <ActivityPage />;
  else page = <ServersPage mcpUrl={state.mcpUrl} />;

  const active = (href: string) => (href === '/' ? path === '/' || path.startsWith('/servers') : path.startsWith(href));

  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/" className="brand">
          <img src="/icon.svg" alt="" width={24} height={24} />
          MCPME
        </Link>
        <nav aria-label="Main">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} aria-current={active(n.href) ? 'page' : undefined}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="topbar-end">
          <span className="muted">{state.user!.email}</span>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            onClick={async () => {
              await api('/logout', { body: {} });
              navigate('/', true);
              onSignOut();
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="content">{page}</main>
    </div>
  );
}
