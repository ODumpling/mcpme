import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Db } from '../db/index.ts';
import { serverOAuth } from '../db/schema.ts';
import type { Vault } from '../crypto.ts';

type Row = typeof serverOAuth.$inferSelect;

/**
 * Stores one upstream server's OAuth client registration and tokens (sealed).
 *
 * `interactive` providers are used when the user starts a Connect flow: they
 * record the PKCE verifier and `state` and capture the authorization URL.
 * Background connections use non-interactive providers so a failed refresh
 * can't clobber a sign-in the user has in progress.
 */
export class UpstreamOAuthProvider implements OAuthClientProvider {
  private readonly db: Db;
  private readonly vault: Vault;
  private readonly serverId: string;
  private readonly callbackUrl: string;
  private readonly interactive: boolean;
  /** Set when the SDK wants the user sent to the upstream's login page. */
  authorizationUrl?: URL;

  constructor(opts: { db: Db; vault: Vault; serverId: string; callbackUrl: string; interactive: boolean }) {
    this.db = opts.db;
    this.vault = opts.vault;
    this.serverId = opts.serverId;
    this.callbackUrl = opts.callbackUrl;
    this.interactive = opts.interactive;
  }

  get redirectUrl(): string {
    return this.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'MCPME',
      redirect_uris: [this.callbackUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  private async row(): Promise<Row | undefined> {
    const [row] = await this.db.select().from(serverOAuth).where(eq(serverOAuth.serverId, this.serverId));
    return row;
  }

  private async write(values: Partial<Omit<Row, 'serverId'>>): Promise<void> {
    await this.db
      .insert(serverOAuth)
      .values({ serverId: this.serverId, ...values })
      .onConflictDoUpdate({ target: serverOAuth.serverId, set: values });
  }

  async state(): Promise<string> {
    const state = randomBytes(24).toString('base64url');
    if (this.interactive) await this.write({ pendingState: state });
    return state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return this.vault.open<OAuthClientInformationMixed>((await this.row())?.clientInfoSealed);
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.write({ clientInfoSealed: this.vault.seal(info) });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.vault.open<OAuthTokens>((await this.row())?.tokensSealed);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.write({ tokensSealed: this.vault.seal(tokens), connectedAt: new Date() });
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    if (this.interactive) await this.write({ codeVerifierSealed: this.vault.seal(verifier) });
  }

  async codeVerifier(): Promise<string> {
    const verifier = this.vault.open<string>((await this.row())?.codeVerifierSealed);
    if (!verifier) throw new Error('No sign-in in progress for this server');
    return verifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.write({ discoveryState: state });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return ((await this.row())?.discoveryState as OAuthDiscoveryState | null) ?? undefined;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    const all = scope === 'all';
    await this.write({
      ...(all || scope === 'client' ? { clientInfoSealed: null } : {}),
      ...(all || scope === 'tokens' ? { tokensSealed: null, connectedAt: null } : {}),
      ...(all || scope === 'verifier' ? { codeVerifierSealed: null } : {}),
      ...(all || scope === 'discovery' ? { discoveryState: null } : {}),
    });
  }

  /** Called after a successful callback. */
  async finishSignIn(): Promise<void> {
    await this.write({ pendingState: null, codeVerifierSealed: null });
  }
}

export async function serverIdForState(db: Db, state: string): Promise<string | undefined> {
  const [row] = await db.select({ serverId: serverOAuth.serverId }).from(serverOAuth).where(eq(serverOAuth.pendingState, state));
  return row?.serverId;
}
