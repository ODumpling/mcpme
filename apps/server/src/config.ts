import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Config {
  /** Public origin MCPME is reachable at, e.g. https://mcpme.example.com */
  publicUrl: URL;
  port: number;
  dataDir: string;
  /** Postgres connection string. When unset, an embedded PGlite database in dataDir is used. */
  databaseUrl?: string;
  /** 32-byte key used to encrypt upstream secrets at rest. */
  secretKey: Buffer;
  /** Directory with the built admin UI, served at / when present. */
  webDir?: string;
}

function loadSecretKey(dataDir: string): Buffer {
  const fromEnv = process.env.MCPME_SECRET_KEY;
  if (fromEnv) {
    const key = Buffer.from(fromEnv, fromEnv.length === 64 ? 'hex' : 'base64');
    if (key.length !== 32) throw new Error('MCPME_SECRET_KEY must be 32 bytes (64 hex chars or base64)');
    return key;
  }
  const file = join(dataDir, 'secret.key');
  if (existsSync(file)) return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  const key = randomBytes(32);
  writeFileSync(file, key.toString('base64'), { mode: 0o600 });
  console.warn(`MCPME_SECRET_KEY not set; generated one at ${file}. Back it up: losing it loses stored credentials.`);
  return key;
}

export function loadConfig(env = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  const dataDir = env.MCPME_DATA_DIR ?? join(process.cwd(), 'data');
  mkdirSync(dataDir, { recursive: true });
  const publicUrl = new URL(env.MCPME_PUBLIC_URL ?? `http://localhost:${port}`);
  return {
    publicUrl,
    port,
    dataDir,
    databaseUrl: env.DATABASE_URL || undefined,
    secretKey: loadSecretKey(dataDir),
    webDir: env.MCPME_WEB_DIR,
  };
}
