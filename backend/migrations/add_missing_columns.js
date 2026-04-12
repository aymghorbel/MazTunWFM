// Migration: add attachment_url to requests, pending_reminder_days to company_settings
// Idempotent — safe to re-run.
const pool = require('./db');

async function run() {
  await pool.query('ALTER TABLE requests ADD COLUMN IF NOT EXISTS attachment_url TEXT;');
  console.log('✓ requests.attachment_url column');

  await pool.query('ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS pending_reminder_days INTEGER DEFAULT 3;');
  console.log('✓ company_settings.pending_reminder_days column');

  await pool.end();
}

run().catch(e => { console.error('Missing columns migration failed:', e.message); process.exit(1); });
