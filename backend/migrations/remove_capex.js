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

    // Migrate any existing CAPEX projects to OPEX
    const updated = await client.query(
      "UPDATE projects SET type = 'OPEX' WHERE type = 'CAPEX'"
    );
    if (updated.rowCount > 0) {
      console.log(`Migrated ${updated.rowCount} CAPEX project(s) to OPEX`);
    }

    // Drop the old CHECK constraint and add the new one without CAPEX
    // PostgreSQL constraint names follow the pattern: <table>_<column>_check
    await client.query(`
      ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_type_check;
    `);
    await client.query(`
      ALTER TABLE projects ADD CONSTRAINT projects_type_check
        CHECK (type IN ('OPEX', 'OVERHEAD', 'INTERNAL'));
    `);

    await client.query('COMMIT');
    console.log('CAPEX removal migration completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('CAPEX removal migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
