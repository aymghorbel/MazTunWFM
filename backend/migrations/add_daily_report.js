// Migration: add daily_report TEXT column to timesheet_entries
// Optional free-form note where employees can log everything they did that day.
// Idempotent — safe to re-run.
const pool = require('./db');

async function run() {
  await pool.query(`ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS daily_report TEXT`);
  console.log('✓ timesheet_entries.daily_report column');
  await pool.end();
}

run().catch(e => { console.error('add_daily_report failed:', e.message); process.exit(1); });
