const pool = require('./db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Target activity/request type for workflow matching (null = all)
    await client.query(`
      ALTER TABLE workflow_definitions ADD COLUMN IF NOT EXISTS target_activity_type VARCHAR(100);
    `);

    // Priority for matching order (higher = checked first)
    await client.query(`
      ALTER TABLE workflow_definitions ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0;
    `);

    // Seed the Extra Days OnSite multi-step workflow if not already present
    const existing = await client.query(
      `SELECT 1 FROM workflow_definitions WHERE target_activity_type = 'Extra Days OnSite' LIMIT 1`
    );
    if (existing.rows.length === 0) {
      await client.query(
        `INSERT INTO workflow_definitions
           (name, entity_type, target_dept, target_staff_type, target_activity_type, priority, is_active, steps, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7, NOW(), NOW())`,
        [
          'Extra Days OnSite (3+ days)',
          'leave',
          null,
          'field',
          'Extra Days OnSite',
          10,
          JSON.stringify([
            { id: 'step-edo-1', order: 1, label: 'Manager Approval', approver_type: 'direct_manager', approver_value: null, conditions: [] },
            { id: 'step-edo-2a', order: 2, label: 'Operations Manager Approval', approver_type: 'specific_role', approver_value: 'operations_manager', conditions: [{ field: 'days_count', operator: '==', value: 3 }] },
            { id: 'step-edo-2b', order: 2, label: 'Country Manager Approval', approver_type: 'specific_role', approver_value: 'country_manager', conditions: [{ field: 'days_count', operator: '>', value: 3 }] },
          ])
        ]
      );
      console.log('Seeded Extra Days OnSite workflow');
    }

    await client.query('COMMIT');
    console.log('Workflow designer migration completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Workflow designer migration failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
