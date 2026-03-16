const { Pool } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'mazarine',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'password',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Azure Entra ID Object ID — stored on first SSO login for security binding
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS azure_oid VARCHAR(64);
    `);

    // SSO provider tag: 'azure' for Entra ID users, NULL for local-auth users
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_provider VARCHAR(20) DEFAULT NULL;
    `);

    await client.query('COMMIT');
    console.log('Azure SSO migration completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Azure SSO migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
