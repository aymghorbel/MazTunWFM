const { Pool } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'mazarine',
  user: process.env.DB_USER || 'mazadmin',
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS workflow_definitions (
        id                SERIAL PRIMARY KEY,
        name              VARCHAR(100) NOT NULL,
        entity_type       VARCHAR(20) NOT NULL CHECK (entity_type IN ('timesheet','leave','temp_auth')),
        target_dept       VARCHAR(100),
        target_staff_type VARCHAR(20),
        is_active         BOOLEAN DEFAULT true,
        steps             JSONB NOT NULL DEFAULT '[]',
        created_by        INTEGER REFERENCES users(id),
        created_at        TIMESTAMP DEFAULT NOW(),
        updated_at        TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✓ workflow_definitions table');

    await client.query(`
      CREATE TABLE IF NOT EXISTS workflow_instances (
        id          SERIAL PRIMARY KEY,
        workflow_id INTEGER REFERENCES workflow_definitions(id),
        entity_type VARCHAR(20) NOT NULL,
        entity_ref  VARCHAR(100) NOT NULL,
        status      VARCHAR(20) DEFAULT 'in_progress',
        created_at  TIMESTAMP DEFAULT NOW(),
        updated_at  TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✓ workflow_instances table');

    await client.query(`
      CREATE TABLE IF NOT EXISTS workflow_approvals (
        id          SERIAL PRIMARY KEY,
        instance_id INTEGER REFERENCES workflow_instances(id),
        step_index  INTEGER NOT NULL,
        step_label  VARCHAR(100),
        approver_id INTEGER REFERENCES users(id),
        status      VARCHAR(20) DEFAULT 'pending',
        comment     TEXT,
        actioned_at TIMESTAMP,
        created_at  TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✓ workflow_approvals table');

    await client.query(`ALTER TABLE requests ADD COLUMN IF NOT EXISTS workflow_instance_id INTEGER REFERENCES workflow_instances(id);`);
    console.log('✓ requests.workflow_instance_id column');

    await client.query(`ALTER TABLE timesheet_status ADD COLUMN IF NOT EXISTS workflow_instance_id INTEGER REFERENCES workflow_instances(id);`);
    console.log('✓ timesheet_status.workflow_instance_id column');

    await client.query('COMMIT');
    console.log('Workflow migration complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Workflow migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
