import express, { type Request, type Response, type Router } from 'express';
import { AuthError, type Owners } from './auth/owner.ts';
import { esc, page } from './auth/pages.ts';
import type { Registry } from './registry.ts';
import { errorMessage } from './upstream/upstream.ts';

/** Only same-origin paths, so `next` can't bounce the user to another site. */
function safeNext(value: unknown): string {
  const s = typeof value === 'string' ? value : '';
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : '/';
}

function html(res: Response, status: number, body: string) {
  res.status(status).set('X-Frame-Options', 'DENY').set('Cache-Control', 'no-store').type('html').send(body);
}

/**
 * Server-rendered pages for the upstream sign-in flow:
 * - /connect/:slug — link handed to MCP clients when a server needs sign-in
 * - /oauth/upstream/callback — where upstream authorization servers send the user back
 * - /signin — minimal login for the above when there's no session yet
 */
export function browserRouter(owners: Owners, registry: Registry): Router {
  const router = express.Router();

  const requireSession = async (req: Request, res: Response) => {
    const user = await owners.sessionUser(req);
    if (!user) res.redirect(302, `/signin?next=${encodeURIComponent(req.originalUrl)}`);
    return user;
  };

  const signinPage = (next: string, error?: string) =>
    page(
      'Sign in',
      `<h1>Sign in to MCPME</h1><p>Sign in to continue.</p>
       <form method="post" action="/signin">
         <input type="hidden" name="next" value="${esc(next)}">
         <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required autofocus>
         <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
         ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
         <div class="actions"><button type="submit" class="primary">Sign in</button></div>
       </form>`,
    );

  router.get('/signin', (req, res) => html(res, 200, signinPage(safeNext(req.query.next))));

  router.post('/signin', express.urlencoded({ extended: false }), async (req, res, next) => {
    const target = safeNext(req.body?.next);
    try {
      const user = await owners.verifyCredentials(String(req.body?.email ?? ''), String(req.body?.password ?? ''));
      await owners.startSession(res, user);
      res.redirect(302, target);
    } catch (e) {
      if (e instanceof AuthError) return html(res, 400, signinPage(target, e.message));
      next(e);
    }
  });

  router.get('/connect/:slug', async (req, res) => {
    try {
      if (!(await requireSession(req, res))) return;
      const up = registry.bySlug(req.params.slug);
      if (!up) return html(res, 404, page('Not found', `<h1>No server called “${esc(req.params.slug)}”</h1>`));
      const url = await registry.startAuth(up.config.id);
      res.redirect(302, url ? url.href : `/servers/${up.config.id}?connected=1`);
    } catch (e) {
      html(res, 502, page('Sign-in failed', `<h1>Couldn't start sign-in</h1><p>${esc(errorMessage(e))}</p><p><a href="/">Back to MCPME</a></p>`));
    }
  });

  router.get('/oauth/upstream/callback', async (req, res) => {
    try {
      if (!(await requireSession(req, res))) return;
      if (req.query.error) {
        throw new Error(`${req.query.error}${req.query.error_description ? `: ${req.query.error_description}` : ''}`);
      }
      const id = await registry.finishAuth(String(req.query.state ?? ''), String(req.query.code ?? ''));
      res.redirect(302, `/servers/${id}?connected=1`);
    } catch (e) {
      html(res, 400, page('Sign-in failed', `<h1>Sign-in didn't finish</h1><p>${esc(errorMessage(e))}</p><p><a href="/">Back to MCPME</a></p>`));
    }
  });

  return router;
}
