// Migration: add expiry_date column to projects table
// Idempotent — safe to re-run.
const pool = require('./db');

async function run() {
  await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS expiry_date DATE;');
  console.log('✓ projects.expiry_date column');
  await pool.end();
}

run().catch(e => { console.error('Project expiry migration failed:', e.message); process.exit(1); });
