// pg pool - scaffold only. Phase 2 wires DATABASE_URL.
import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
