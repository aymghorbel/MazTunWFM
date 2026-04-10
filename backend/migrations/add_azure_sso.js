const pool = require('./db');

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
