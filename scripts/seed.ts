// Seed Free/Pro plans + demo-tenant (P2-T1). Idempotent: re-runs are no-ops
// via ON CONFLICT DO NOTHING. Requires Postgres — start it first with
// `docker compose up -d db`, or full stack with `docker compose up --build`.
// Run: npm run seed
import 'dotenv/config';
import { pool, runMigrations } from '../src/db';
import { listPlans, upsertPlan, upsertTenant } from '../src/repos/tenant';

async function main(): Promise<void> {
  const applied = await runMigrations();
  console.log(`seed: migrations: ${applied.length ? applied.join(', ') : 'up to date'}`);

  await upsertPlan({ id: 'free', name: 'free', apiLimit: 1000, tokenLimit: 100000, priceCents: 0 });
  await upsertPlan({ id: 'pro', name: 'pro', apiLimit: 100000, tokenLimit: 10000000, priceCents: 2000 });
  await upsertTenant({ id: 'demo-tenant', name: 'Demo Tenant', plan: 'free' });

  const plans = await listPlans();
  console.log(`seed: ok — plans=[${plans.map((p) => p.id).join(', ')}] tenant=demo-tenant`);
  await pool.end();
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('seed: failed — is Postgres up? (docker compose up -d db)', err);
    void pool.end().finally(() => {
      process.exitCode = 1;
    });
  });
}
