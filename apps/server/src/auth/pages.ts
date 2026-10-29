import { createHash } from 'node:crypto';
import express, { type Request, type Response, type Router } from 'express';
import type { McpmeOAuthServer } from './oauthServer.ts';
import { AuthError, type Owners, safeEqual } from './owner.ts';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Ties the approve button to both the request and the browser session, so it can't be forged cross-site. */
function csrfFor(sessionHash: string, requestId: string): string {
  return createHash('sha256').update(`${sessionHash}:${requestId}`).digest('hex');
}

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · MCPME</title>
<style>
  :root { color-scheme: light dark; --bg: oklch(98.5% 0.004 293); --fg: oklch(22% 0.02 260); --muted: oklch(50% 0.02 260); --card: oklch(100% 0 0); --line: oklch(90% 0.01 260); --accent: oklch(55% 0.24 293); --danger: oklch(55% 0.2 25); }
  @media (prefers-color-scheme: dark) { :root { --bg: oklch(18% 0.01 260); --fg: oklch(95% 0.005 260); --muted: oklch(70% 0.02 260); --card: oklch(23% 0.015 260); --line: oklch(32% 0.015 260); --accent: oklch(68% 0.19 293); } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, sans-serif; padding: 24px; }
  main { width: 100%; max-width: 400px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 4px; text-wrap: balance; }
  p { margin: 0 0 16px; color: var(--muted); }
  label { display: block; font-weight: 500; margin: 12px 0 4px; }
  input { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: inherit; font: inherit; font-size: 16px; }
  input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .actions { display: flex; gap: 8px; margin-top: 20px; }
  button { flex: 1; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: inherit; font: inherit; font-weight: 500; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: white; }
  .error { color: var(--danger); margin: 12px 0 0; }
  .client { font-weight: 600; color: var(--fg); }
  .brand { font-weight: 700; letter-spacing: -0.01em; margin-bottom: 16px; }
</style>
</head>
<body><main><div class="brand">MCPME</div>${body}</main></body>
</html>`;
}

function send(res: Response, status: number, html: string) {
  res
    .status(status)
    .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
    .set('X-Frame-Options', 'DENY')
    .set('Cache-Control', 'no-store')
    .type('html')
    .send(html);
}

/** Browser pages for the OAuth flow: GET/POST /oauth/consent. */
export function consentRouter(oauth: McpmeOAuthServer, owners: Owners): Router {
  const router = express.Router();
  router.use('/oauth/consent', express.urlencoded({ extended: false }));

  const render = async (req: Request, res: Response, requestId: string, error?: string) => {
    const pending = await oauth.pendingAuthorization(requestId);
    if (!pending) {
      return send(res, 400, page('Sign-in expired', `<h1>This sign-in request expired</h1><p>Start again from your MCP client.</p>`));
    }
    if (!(await owners.hasOwner())) {
      return send(res, 409, page('Set up MCPME', `<h1>MCPME isn't set up yet</h1><p>Open <a href="/">the MCPME dashboard</a> to create your account, then try connecting again.</p>`));
    }
    const user = await owners.sessionUser(req);
    const clientName = pending.client.client_name || 'An MCP client';
    const redirectHost = new URL(pending.redirectUri).host || pending.redirectUri;
    const loginFields = user
      ? `<p>Signed in as <strong>${esc(user.email)}</strong>.</p><input type="hidden" name="csrf" value="${csrfFor(user.sessionHash, requestId)}">`
      : `<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required autofocus>
         <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>`;
    send(
      res,
      error ? 400 : 200,
      page(
        'Connect to MCPME',
        `<h1>${user ? 'Allow access?' : 'Sign in to MCPME'}</h1>
         <p><span class="client">${esc(clientName)}</span> wants to use your MCP servers through MCPME. It will be sent back to ${esc(redirectHost)}.</p>
         <form method="post" action="/oauth/consent">
           <input type="hidden" name="request" value="${esc(requestId)}">
           ${loginFields}
           ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
           <div class="actions">
             <button type="submit" name="action" value="deny" formnovalidate>Deny</button>
             <button type="submit" name="action" value="allow" class="primary">${user ? 'Allow' : 'Sign in and allow'}</button>
           </div>
         </form>`,
      ),
    );
  };

  router.get('/oauth/consent', async (req, res, next) => {
    try {
      await render(req, res, String(req.query.request ?? ''));
    } catch (e) {
      next(e);
    }
  });

  router.post('/oauth/consent', async (req, res, next) => {
    const requestId = String(req.body?.request ?? '');
    try {
      if (req.body?.action !== 'allow') return res.redirect(302, await oauth.decide(requestId, undefined));
      let user = await owners.sessionUser(req);
      if (user) {
        if (!safeEqual(String(req.body?.csrf ?? ''), csrfFor(user.sessionHash, requestId))) {
          return render(req, res, requestId, 'Something went wrong. Try again.');
        }
      } else {
        try {
          const verified = await owners.verifyCredentials(String(req.body?.email ?? ''), String(req.body?.password ?? ''));
          await owners.startSession(res, verified);
          user = { ...verified, sessionHash: '' };
        } catch (e) {
          if (e instanceof AuthError) return render(req, res, requestId, e.message);
          throw e;
        }
      }
      res.redirect(302, await oauth.decide(requestId, user.id));
    } catch (e) {
      next(e);
    }
  });

  return router;
}

export { esc };
