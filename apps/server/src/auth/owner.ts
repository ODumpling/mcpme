import { randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { Request, Response } from 'express';
import type { Db } from '../db/index.ts';
import { sessions, users } from '../db/schema.ts';
import { hashPassword, hashToken, randomToken, verifyPassword } from '../crypto.ts';

export const SESSION_COOKIE = 'mcpme_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface User {
  id: string;
  email: string;
}

/**
 * The single MCPME account (v1 is single-user). Handles first-run setup,
 * password login and admin UI sessions.
 */
export class Owners {
  private readonly db: Db;
  private readonly secureCookies: boolean;
  /** One-time code printed to the logs that must be entered to claim a fresh instance. */
  readonly setupCode = randomBytes(6).toString('hex');

  constructor(db: Db, secureCookies: boolean) {
    this.db = db;
    this.secureCookies = secureCookies;
  }

  async hasOwner(): Promise<boolean> {
    const [row] = await this.db.select({ id: users.id }).from(users).limit(1);
    return Boolean(row);
  }

  async setup(email: string, password: string, setupCode: string): Promise<User> {
    if (await this.hasOwner()) throw new AuthError('MCPME is already set up');
    if (!safeEqual(setupCode.trim(), this.setupCode)) throw new AuthError('Wrong setup code');
    if (password.length < 8) throw new AuthError('Password must be at least 8 characters');
    const [user] = await this.db
      .insert(users)
      .values({ email: email.trim().toLowerCase(), passwordHash: await hashPassword(password) })
      .returning({ id: users.id, email: users.email });
    return user;
  }

  async verifyCredentials(email: string, password: string): Promise<User> {
    const [user] = await this.db.select().from(users).where(eq(users.email, email.trim().toLowerCase()));
    if (!user || !(await verifyPassword(password, user.passwordHash))) throw new AuthError('Wrong email or password');
    return { id: user.id, email: user.email };
  }

  async startSession(res: Response, user: User): Promise<string> {
    const token = randomToken();
    await this.db.insert(sessions).values({
      tokenHash: hashToken(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.secureCookies,
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
    return token;
  }

  async endSession(req: Request, res: Response): Promise<void> {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await this.db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  async sessionUser(req: Request): Promise<(User & { sessionHash: string }) | undefined> {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return undefined;
    const tokenHash = hashToken(token);
    const [row] = await this.db
      .select({ id: users.id, email: users.email })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())));
    return row ? { ...row, sessionHash: tokenHash } : undefined;
  }
}

export class AuthError extends Error {}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
