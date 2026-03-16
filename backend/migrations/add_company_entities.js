// Migration: company_entities table + entity_id on projects + type constraint update
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
  // 1. Create company_entities table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS company_entities (
      id         SERIAL PRIMARY KEY,
      code       VARCHAR(10) UNIQUE NOT NULL,
      name       VARCHAR(100) NOT NULL,
      active     BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✓ company_entities table');

  // 2. Seed defaults (23, 24, 25)
  await pool.query(`
    INSERT INTO company_entities (code, name)
    VALUES ('23','Entity 23'),('24','Entity 24'),('25','Entity 25')
    ON CONFLICT (code) DO NOTHING
  `);
  console.log('✓ company_entities seed rows');

  // 3. Add entity_id FK to projects (nullable)
  await pool.query(`
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS entity_id INTEGER REFERENCES company_entities(id)
  `);
  console.log('✓ projects.entity_id column');

  // 4. Migrate stale type values to OPEX before changing constraint
  await pool.query(`
    UPDATE projects SET type = 'OPEX' WHERE type NOT IN ('CAPEX','OPEX','EXPLORATION')
  `);
  console.log('✓ projects.type values migrated');

  // 5. Drop old type constraint and add new one
  await pool.query(`ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_type_check`);
  await pool.query(`
    ALTER TABLE projects ADD CONSTRAINT projects_type_check
      CHECK (type IN ('CAPEX','OPEX','EXPLORATION'))
  `);
  console.log('✓ projects.type constraint updated to CAPEX/OPEX/EXPLORATION');

  await pool.end();
}

run().catch(e => { console.error('Company entities migration failed:', e.message); process.exit(1); });
