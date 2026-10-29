import { and, eq, gt, lt, or } from 'drizzle-orm';
import type { Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Db } from '../db/index.ts';
import { oauthClients, oauthCodes, oauthPendingAuthorizations, oauthTokens, personalAccessTokens } from '../db/schema.ts';
import { hashToken, randomToken } from '../crypto.ts';

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 60 * 60 * 24 * 30;
const CODE_TTL_S = 5 * 60;
const PENDING_TTL_S = 15 * 60;
/** PATs don't expire; the SDK bearer middleware still wants an expiry, so report one far out. */
const PAT_REPORTED_TTL_S = 60 * 60 * 24 * 365;
export const PAT_PREFIX = 'mcpme_pat_';

/** Who a verified bearer token belongs to. */
export interface McpmeAuthExtra extends Record<string, unknown> {
  userId: string;
}

/**
 * MCPME's own OAuth 2.1 authorization server, plugged into the SDK's
 * `mcpAuthRouter`. `authorize` sends the browser to MCPME's login/consent page.
 */
export class McpmeOAuthServer implements OAuthServerProvider {
  private readonly db: Db;
  private readonly resourceUrl: URL;

  constructor(db: Db, resourceUrl: URL) {
    this.db = db;
    this.resourceUrl = resourceUrl;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId) => {
        const [row] = await this.db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId));
        return row?.info as OAuthClientInformationFull | undefined;
      },
      registerClient: async (client) => {
        const info = client as OAuthClientInformationFull;
        await this.db.insert(oauthClients).values({ clientId: info.client_id, info });
        return info;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && !sameResource(params.resource, this.resourceUrl)) {
      throw new InvalidTargetError(`This server only issues tokens for ${this.resourceUrl.href}`);
    }
    const id = randomToken();
    await this.db.delete(oauthPendingAuthorizations).where(lt(oauthPendingAuthorizations.expiresAt, new Date()));
    await this.db.insert(oauthPendingAuthorizations).values({
      id,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state ?? null,
      scopes: params.scopes ?? [],
      resource: this.resourceUrl.href,
      expiresAt: in_(PENDING_TTL_S),
    });
    res.redirect(302, `/oauth/consent?request=${encodeURIComponent(id)}`);
  }

  async pendingAuthorization(id: string) {
    const [row] = await this.db
      .select({ pending: oauthPendingAuthorizations, client: oauthClients.info })
      .from(oauthPendingAuthorizations)
      .innerJoin(oauthClients, eq(oauthClients.clientId, oauthPendingAuthorizations.clientId))
      .where(and(eq(oauthPendingAuthorizations.id, id), gt(oauthPendingAuthorizations.expiresAt, new Date())));
    return row ? { ...row.pending, client: row.client as OAuthClientInformationFull } : undefined;
  }

  /** Completes a pending authorization. Returns the URL to send the browser back to. */
  async decide(id: string, userId: string | undefined): Promise<string> {
    const pending = await this.pendingAuthorization(id);
    if (!pending) throw new Error('This sign-in request expired. Start again from your MCP client.');
    await this.db.delete(oauthPendingAuthorizations).where(eq(oauthPendingAuthorizations.id, id));
    const target = new URL(pending.redirectUri);
    if (pending.state !== null) target.searchParams.set('state', pending.state);
    if (!userId) {
      target.searchParams.set('error', 'access_denied');
      target.searchParams.set('error_description', 'The user denied access');
      return target.href;
    }
    const code = randomToken();
    await this.db.insert(oauthCodes).values({
      codeHash: hashToken(code),
      clientId: pending.clientId,
      userId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scopes: pending.scopes,
      resource: pending.resource,
      expiresAt: in_(CODE_TTL_S),
    });
    target.searchParams.set('code', code);
    return target.href;
  }

  private async findCode(client: OAuthClientInformationFull, code: string) {
    const [row] = await this.db.select().from(oauthCodes).where(eq(oauthCodes.codeHash, hashToken(code)));
    if (!row || row.clientId !== client.client_id || row.expiresAt < new Date()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return row;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return (await this.findCode(client, code)).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = await this.findCode(client, code);
    // Single use: delete before issuing so a replayed code fails.
    const deleted = await this.db.delete(oauthCodes).where(eq(oauthCodes.codeHash, row.codeHash)).returning();
    if (deleted.length === 0) throw new InvalidGrantError('Authorization code already used');
    if (redirectUri !== undefined && redirectUri !== row.redirectUri) throw new InvalidGrantError('redirect_uri mismatch');
    if (resource && !sameResource(resource, this.resourceUrl)) throw new InvalidTargetError('Unknown resource');
    return this.issueTokens(client.client_id, row.userId, row.scopes, row.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    // Rotate: the old pair is deleted, a new pair is issued.
    const [row] = await this.db
      .delete(oauthTokens)
      .where(and(eq(oauthTokens.refreshTokenHash, hashToken(refreshToken)), eq(oauthTokens.clientId, client.client_id)))
      .returning();
    if (!row || row.refreshExpiresAt < new Date()) throw new InvalidGrantError('Invalid or expired refresh token');
    if (resource && !sameResource(resource, this.resourceUrl)) throw new InvalidTargetError('Unknown resource');
    const granted = scopes?.length ? scopes.filter((s) => row.scopes.includes(s)) : row.scopes;
    return this.issueTokens(client.client_id, row.userId, granted, row.resource);
  }

  private async issueTokens(clientId: string, userId: string, scopes: string[], resource: string | null): Promise<OAuthTokens> {
    const accessToken = randomToken('mcpme_at_');
    const refreshToken = randomToken('mcpme_rt_');
    await this.db.insert(oauthTokens).values({
      accessTokenHash: hashToken(accessToken),
      refreshTokenHash: hashToken(refreshToken),
      clientId,
      userId,
      scopes,
      resource,
      accessExpiresAt: in_(ACCESS_TTL_S),
      refreshExpiresAt: in_(REFRESH_TTL_S),
    });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_S,
      refresh_token: refreshToken,
      ...(scopes.length ? { scope: scopes.join(' ') } : {}),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const hash = hashToken(token);
    if (token.startsWith(PAT_PREFIX)) {
      const [pat] = await this.db
        .update(personalAccessTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(personalAccessTokens.tokenHash, hash))
        .returning();
      if (!pat) throw new InvalidTokenError('Invalid token');
      return {
        token,
        clientId: `pat:${pat.id}`,
        scopes: [],
        expiresAt: Math.floor(Date.now() / 1000) + PAT_REPORTED_TTL_S,
        resource: this.resourceUrl,
        extra: { userId: pat.userId } satisfies McpmeAuthExtra,
      };
    }
    const [row] = await this.db.select().from(oauthTokens).where(eq(oauthTokens.accessTokenHash, hash));
    if (!row) throw new InvalidTokenError('Invalid token');
    return {
      token,
      clientId: row.clientId,
      scopes: row.scopes,
      expiresAt: Math.floor(row.accessExpiresAt.getTime() / 1000),
      resource: row.resource ? new URL(row.resource) : undefined,
      extra: { userId: row.userId } satisfies McpmeAuthExtra,
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hash = hashToken(request.token);
    await this.db
      .delete(oauthTokens)
      .where(and(eq(oauthTokens.clientId, client.client_id), or(eq(oauthTokens.accessTokenHash, hash), eq(oauthTokens.refreshTokenHash, hash))));
  }
}

function in_(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

function sameResource(a: URL | string, b: URL | string): boolean {
  const norm = (u: URL | string) => String(u).replace(/#.*$/, '').replace(/\/$/, '');
  return norm(a) === norm(b);
}
