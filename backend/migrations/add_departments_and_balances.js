// Migration: departments dropdown, balance types, per-user per-type balances
// Idempotent — safe to re-run.
const pool = require('./db');

async function run() {
  // ── 1. Departments table ────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS departments (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) UNIQUE NOT NULL,
      active BOOLEAN DEFAULT true,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✓ departments table');

  // Seed from existing distinct user.dept values
  await pool.query(`
    INSERT INTO departments (name)
    SELECT DISTINCT dept FROM users WHERE dept IS NOT NULL AND dept != ''
    ON CONFLICT (name) DO NOTHING
  `);
  console.log('✓ departments seeded from users');

  // ── 2. Balance types table ──────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS balance_types (
      id SERIAL PRIMARY KEY,
      name VARCHAR(60) UNIQUE NOT NULL,
      code VARCHAR(30) UNIQUE NOT NULL,
      default_balance NUMERIC(6,1) DEFAULT 0,
      color VARCHAR(7) DEFAULT '#10b981',
      active BOOLEAN DEFAULT true,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✓ balance_types table');

  // Seed core types
  await pool.query(`
    INSERT INTO balance_types (name, code, default_balance, color, sort_order) VALUES
      ('Annual Leave','annual',20,'#10b981',1),
      ('Recovery','recovery',0,'#7c3aed',2)
    ON CONFLICT (code) DO NOTHING
  `);
  console.log('✓ balance_types seeded');

  // ── 3. User balances table ──────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_balances (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      balance_type_id INTEGER NOT NULL REFERENCES balance_types(id) ON DELETE CASCADE,
      balance NUMERIC(6,1) DEFAULT 0,
      used NUMERIC(6,1) DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (user_id, balance_type_id)
    )
  `);
  console.log('✓ user_balances table');

  // Migrate existing users.leave_balance / used_leave → user_balances (annual)
  await pool.query(`
    INSERT INTO user_balances (user_id, balance_type_id, balance, used)
    SELECT u.id, bt.id, u.leave_balance, u.used_leave
    FROM users u
    CROSS JOIN balance_types bt
    WHERE bt.code='annual'
    ON CONFLICT (user_id, balance_type_id) DO NOTHING
  `);
  console.log('✓ annual balances migrated');

  await pool.query(`
    INSERT INTO user_balances (user_id, balance_type_id, balance, used)
    SELECT u.id, bt.id, u.recovery_balance, 0
    FROM users u
    CROSS JOIN balance_types bt
    WHERE bt.code='recovery'
    ON CONFLICT (user_id, balance_type_id) DO NOTHING
  `);
  console.log('✓ recovery balances migrated');

  // ── 4. Link activities to balance types ─────────────────────────
  await pool.query(`ALTER TABLE activities ADD COLUMN IF NOT EXISTS balance_type_id INTEGER REFERENCES balance_types(id) ON DELETE SET NULL`);
  console.log('✓ activities.balance_type_id column');

  // Auto-link any leave activity named exactly "Annual Leave" or "Recovery" to their type
  await pool.query(`
    UPDATE activities a SET balance_type_id = bt.id
    FROM balance_types bt
    WHERE a.balance_type_id IS NULL
      AND ((a.name='Annual Leave' AND bt.code='annual') OR (a.name='Recovery Leave' AND bt.code='recovery'))
  `);
  console.log('✓ default activity→balance links applied');

  await pool.end();
}

run().catch(e => { console.error('Departments/balances migration failed:', e.message); process.exit(1); });
