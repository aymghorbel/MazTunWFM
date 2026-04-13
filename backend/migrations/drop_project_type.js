// Migration: drop projects.type column (all projects are OPEX now)
// Idempotent — safe to re-run.
const pool = require('./db');

async function run() {
  // Drop any check constraints on the type column first
  await pool.query(`
    DO $$
    DECLARE
      r RECORD;
    BEGIN
      FOR r IN (SELECT conname FROM pg_constraint WHERE conrelid='projects'::regclass AND pg_get_constraintdef(oid) LIKE '%type%')
      LOOP
        EXECUTE format('ALTER TABLE projects DROP CONSTRAINT %I', r.conname);
      END LOOP;
    END$$;
  `).catch(() => {});
  await pool.query('ALTER TABLE projects DROP COLUMN IF EXISTS type;');
  console.log('✓ projects.type column dropped');
  await pool.end();
}

run().catch(e => { console.error('Drop type migration failed:', e.message); process.exit(1); });
