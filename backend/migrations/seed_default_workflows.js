/**
 * seed_default_workflows.js
 *
 * Ensures a fallback "direct manager" workflow definition exists for each
 * entity type (timesheet, leave, temp_auth).  Only inserts for entity types
 * that have NO active workflow at all, so it is safe to re-run on every
 * container start without overwriting custom definitions.
 */

const pool = require('./db');

// Default definitions — one per entity type.
// Each replicates the legacy single-step "direct manager must approve" flow.
const DEFAULTS = [
  {
    name:              'Default Timesheet Approval',
    entity_type:       'timesheet',
    target_dept:       null,
    target_staff_type: null,
    steps: [
      {
        id:             'step-ts-default-1',
        order:          1,
        label:          'Manager Approval',
        approver_type:  'direct_manager',
        approver_value: null,
        conditions:     [],
      },
    ],
  },
  {
    name:              'Default Leave Approval',
    entity_type:       'leave',
    target_dept:       null,
    target_staff_type: null,
    steps: [
      {
        id:             'step-lv-default-1',
        order:          1,
        label:          'Manager Approval',
        approver_type:  'direct_manager',
        approver_value: null,
        conditions:     [],
      },
    ],
  },
  {
    name:              'Default Temp Authorization Approval',
    entity_type:       'temp_auth',
    target_dept:       null,
    target_staff_type: null,
    steps: [
      {
        id:             'step-ta-default-1',
        order:          1,
        label:          'Manager Approval',
        approver_type:  'direct_manager',
        approver_value: null,
        conditions:     [],
      },
    ],
  },
];

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let seeded = 0;
    for (const wf of DEFAULTS) {
      // Check whether at least one workflow definition exists for this entity type
      const existing = await client.query(
        'SELECT 1 FROM workflow_definitions WHERE entity_type = $1 LIMIT 1',
        [wf.entity_type],
      );

      if (existing.rows.length > 0) {
        console.log(`ℹ  "${wf.entity_type}" already has a workflow definition — skipping.`);
        continue;
      }

      await client.query(
        `INSERT INTO workflow_definitions
           (name, entity_type, target_dept, target_staff_type, is_active, steps, created_at, updated_at)
         VALUES ($1, $2, $3, $4, true, $5, NOW(), NOW())`,
        [wf.name, wf.entity_type, wf.target_dept, wf.target_staff_type, JSON.stringify(wf.steps)],
      );
      console.log(`✓ Seeded: "${wf.name}" (${wf.entity_type})`);
      seeded++;
    }

    await client.query('COMMIT');
    if (seeded === 0) {
      console.log('Default workflow seed: nothing to insert.');
    } else {
      console.log(`Default workflow seed complete — ${seeded} definition(s) added.`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Default workflow seed failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
