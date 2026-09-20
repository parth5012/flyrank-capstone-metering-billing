// Process entrypoint (P2-T1 wiring): apply migrations, then listen.
// A migration failure does not crash the process — /health still serves while
// the DB is starting (compose depends_on); repo calls fail loudly per call.
import 'dotenv/config';
import { createApp } from './app';
import { runMigrations } from './db';

const PORT = Number(process.env.PORT ?? 3000);
const app = createApp();

async function start(): Promise<void> {
  try {
    const applied = await runMigrations();
    // eslint-disable-next-line no-console
    console.log(`migrations: ${applied.length ? applied.join(', ') : 'up to date'}`);
  } catch (err: unknown) {
    // eslint-disable-next-line no-console
    console.warn(`migrations skipped: ${(err as Error).message}`);
  }
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`metering api listening on ${PORT}`);
  });
}

if (require.main === module) {
  void start();
}

export default app;
