const pool = require('./db');

async function migrate() {
  const client = await pool.connect();
  try {
    // Skip if the type column has already been dropped (post-removal)
    const colCheck = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='type'`
    );
    if (colCheck.rowCount === 0) {
      console.log('CAPEX removal migration skipped — projects.type column already dropped.');
      return;
    }

    await client.query('BEGIN');

    // Migrate any existing CAPEX projects to OPEX
    const updated = await client.query(
      "UPDATE projects SET type = 'OPEX' WHERE type = 'CAPEX'"
    );
    if (updated.rowCount > 0) {
      console.log(`Migrated ${updated.rowCount} CAPEX project(s) to OPEX`);
    }

    // Drop the old CHECK constraint and add the new one without CAPEX
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
