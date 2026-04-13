// Migration: company_entities table + entity_id on projects + type constraint update
// Idempotent — safe to re-run.
const pool = require('./db');

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

  // 4-5. Type column handling — only if it still exists (was dropped in drop_project_type migration)
  const typeCol = await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='type'`
  );
  if (typeCol.rowCount > 0) {
    await pool.query(`UPDATE projects SET type = 'OPEX' WHERE type NOT IN ('CAPEX','OPEX','EXPLORATION')`);
    console.log('✓ projects.type values migrated');
    await pool.query(`ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_type_check`);
    await pool.query(`ALTER TABLE projects ADD CONSTRAINT projects_type_check CHECK (type IN ('CAPEX','OPEX','EXPLORATION'))`);
    console.log('✓ projects.type constraint updated to CAPEX/OPEX/EXPLORATION');
  } else {
    console.log('ℹ projects.type column already dropped — skipping type updates');
  }

  await pool.end();
}

run().catch(e => { console.error('Company entities migration failed:', e.message); process.exit(1); });
