// Migration: add payroll_id to users for HR/CSV identification
// Idempotent — safe to re-run.
const pool = require('./db');

async function run() {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS payroll_id VARCHAR(40) UNIQUE`);
  console.log('✓ users.payroll_id column');
  await pool.end();
}

run().catch(e => { console.error('add_payroll_id failed:', e.message); process.exit(1); });
