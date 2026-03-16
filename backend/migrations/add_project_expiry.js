// Migration: add expiry_date column to projects table
// Idempotent — safe to re-run.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'db',
  port:     Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'mazarine',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'ChangeMeStrong123!',
});

async function run() {
  await pool.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS expiry_date DATE;');
  console.log('✓ projects.expiry_date column');
  await pool.end();
}

run().catch(e => { console.error('Project expiry migration failed:', e.message); process.exit(1); });
