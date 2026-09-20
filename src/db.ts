// pg pool + file-based migration runner (P2-T1 scaffold wiring).
// Runtime reads DATABASE_URL (see .env.example). Repos own the SQL;
// every repo query filters tenant_id — see src/repos/*. Pooling only here.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Pool, type QueryResult, type QueryResultRow } from 'pg';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/metering';

export const pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });

export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

function migrationDir(): string {
  const candidates = [
    path.resolve(process.cwd(), 'db', 'migrations'),
    path.join(__dirname, '..', '..', 'db', 'migrations'), // dist/src/db.js -> repo root
    path.join(__dirname, '..', 'db', 'migrations'), // tsx src/db.ts -> repo root
  ];
  const found = candidates.find((d) => fs.existsSync(d));
  if (!found) throw new Error(`migrations directory not found (tried ${candidates.join(', ')})`);
  return found;
}

// Applies db/migrations/*.sql in filename order. Safe to re-run: every
// migration is IF NOT EXISTS + ON CONFLICT DO NOTHING. Used by server boot
// and scripts/seed.ts.
export async function runMigrations(): Promise<string[]> {
  const dir = migrationDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await pool.query(sql);
  }
  return files;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
