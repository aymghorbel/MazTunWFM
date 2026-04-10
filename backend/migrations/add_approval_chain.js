const pool = require('./db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Current approval step (1 = first approver, 2 = second approver)
    await client.query(`
      ALTER TABLE requests ADD COLUMN IF NOT EXISTS approval_step INTEGER DEFAULT 1;
    `);

    // Total steps required (1 = single approval, 2 = sequential chain)
    await client.query(`
      ALTER TABLE requests ADD COLUMN IF NOT EXISTS total_steps INTEGER DEFAULT 1;
    `);

    // Step-1 approval record (manager approval before escalation)
    await client.query(`
      ALTER TABLE requests ADD COLUMN IF NOT EXISTS step1_reviewed_by INTEGER REFERENCES users(id);
    `);
    await client.query(`
      ALTER TABLE requests ADD COLUMN IF NOT EXISTS step1_reviewed_at TIMESTAMP;
    `);
    await client.query(`
      ALTER TABLE requests ADD COLUMN IF NOT EXISTS step1_comment TEXT;
    `);

    // Drop and recreate status check constraint to allow 'Pending L2' status
    await client.query(`
      ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_status_check;
    `);
    await client.query(`
      ALTER TABLE requests ADD CONSTRAINT requests_status_check
        CHECK (status IN ('Pending', 'Pending L2', 'Approved', 'Rejected'));
    `);

    await client.query('COMMIT');
    console.log('Approval chain migration completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Approval chain migration failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
