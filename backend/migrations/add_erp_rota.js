// Migration: create ERP Duty Rota tables
// Idempotent — safe to re-run.
const pool = require('./db');

async function run() {
  // ERP roster: links platform users to ERP roles
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_roster (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      erp_role    VARCHAR(120),
      notes       TEXT DEFAULT '',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id)
    );
  `);
  console.log('✓ erp_roster table');

  // ERP rotation weeks
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_weeks (
      id              SERIAL PRIMARY KEY,
      label           VARCHAR(100) NOT NULL,
      start_date      DATE NOT NULL,
      end_date        DATE NOT NULL,
      crisis_coord        INTEGER REFERENCES users(id),
      drilling_crisis_coord INTEGER REFERENCES users(id),
      cpf_contact         INTEGER REFERENCES users(id),
      drilling_contact    INTEGER REFERENCES users(id),
      media               INTEGER REFERENCES users(id),
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ erp_weeks table');

  // ERP notification log
  await pool.query(`
    CREATE TABLE IF NOT EXISTS erp_notifications (
      id          SERIAL PRIMARY KEY,
      subject     VARCHAR(255),
      channel     VARCHAR(30),
      recipient_count INTEGER DEFAULT 0,
      status      VARCHAR(20) DEFAULT 'simulated',
      is_emergency BOOLEAN DEFAULT FALSE,
      sent_by     INTEGER REFERENCES users(id),
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ erp_notifications table');

  await pool.end();
}

run().catch(e => { console.error('ERP rota migration failed:', e.message); process.exit(1); });
