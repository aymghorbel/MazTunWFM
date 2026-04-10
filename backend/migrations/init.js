const pool = require('./db');

const initDatabase = async () => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Create tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS roles (
        key VARCHAR(50) PRIMARY KEY,
        label VARCHAR(100) NOT NULL,
        color VARCHAR(7) NOT NULL,
        permissions JSONB NOT NULL DEFAULT '[]',
        system BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        role VARCHAR(50) REFERENCES roles(key),
        type VARCHAR(20) CHECK (type IN ('field', 'office')),
        dept VARCHAR(100),
        manager_id INTEGER REFERENCES users(id),
        functional_manager_id INTEGER REFERENCES users(id),
        active BOOLEAN DEFAULT true,
        leave_balance NUMERIC(6,1) DEFAULT 20,
        used_leave NUMERIC(6,1) DEFAULT 0,
        recovery_balance NUMERIC(6,1) DEFAULT 0,
        password VARCHAR(255) NOT NULL,
        must_change_pwd BOOLEAN DEFAULT false,
        azure_oid VARCHAR(64),
        sso_provider VARCHAR(20) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Add functional_manager_id if upgrading an existing deployment
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS functional_manager_id INTEGER REFERENCES users(id);
    `);

    // Add recovery_balance for existing deployments
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_balance NUMERIC(6,1) DEFAULT 0`);

    // Add TOTP columns for 2FA
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret VARCHAR(64)`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN DEFAULT FALSE`);

    // Per-user overlap permission
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS allow_overlap BOOLEAN DEFAULT false`);

    // Azure Entra ID SSO columns
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS azure_oid VARCHAR(64)`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_provider VARCHAR(20) DEFAULT NULL`);

    // Migrate leave_balance / used_leave to NUMERIC for half-day support
    await client.query(`ALTER TABLE users ALTER COLUMN leave_balance TYPE NUMERIC(6,1)`);
    await client.query(`ALTER TABLE users ALTER COLUMN used_leave TYPE NUMERIC(6,1)`);
    
    // Company entities table (must be before projects for FK)
    await client.query(`
      CREATE TABLE IF NOT EXISTS company_entities (
        id         SERIAL PRIMARY KEY,
        code       VARCHAR(10) UNIQUE NOT NULL,
        name       VARCHAR(100) NOT NULL,
        active     BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`
      INSERT INTO company_entities (code, name)
      VALUES ('23','Entity 23'),('24','Entity 24'),('25','Entity 25')
      ON CONFLICT (code) DO NOTHING;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        type VARCHAR(20) CHECK (type IN ('CAPEX','OPEX','EXPLORATION')),
        dept VARCHAR(100),
        open BOOLEAN DEFAULT true,
        field_allowed BOOLEAN DEFAULT true,
        office_allowed BOOLEAN DEFAULT true,
        color VARCHAR(7) DEFAULT '#7c3aed',
        entity_id INTEGER REFERENCES company_entities(id),
        expiry_date DATE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS requests (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        comment TEXT,
        days_count NUMERIC(4,1) NOT NULL,
        duration_hours NUMERIC(3,1),
        half_day_start VARCHAR(2),
        half_day_end VARCHAR(2),
        balance_source VARCHAR(10) DEFAULT 'annual',
        status VARCHAR(20) DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected')),
        review_comment TEXT,
        reviewed_by INTEGER REFERENCES users(id),
        reviewed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Migrate requests table for half-day and temp-auth support
    await client.query(`ALTER TABLE requests ALTER COLUMN days_count TYPE NUMERIC(4,1)`);
    await client.query(`ALTER TABLE requests ADD COLUMN IF NOT EXISTS duration_hours NUMERIC(3,1)`);
    await client.query(`ALTER TABLE requests ADD COLUMN IF NOT EXISTS half_day_start VARCHAR(2)`);
    await client.query(`ALTER TABLE requests ADD COLUMN IF NOT EXISTS half_day_end VARCHAR(2)`);
    await client.query(`ALTER TABLE requests ADD COLUMN IF NOT EXISTS balance_source VARCHAR(10) DEFAULT 'annual'`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS timesheet_entries (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        year INTEGER NOT NULL,
        month INTEGER NOT NULL,
        day INTEGER NOT NULL,
        date DATE NOT NULL,
        activity VARCHAR(50),
        locked BOOLEAN DEFAULT false,
        hours INTEGER DEFAULT 8,
        allocations JSONB DEFAULT '[]',
        UNIQUE(user_id, year, month, day)
      );
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS timesheet_status (
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        year INTEGER NOT NULL,
        month INTEGER NOT NULL,
        status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
        submitted_at TIMESTAMP,
        review_comment TEXT,
        reviewed_by INTEGER REFERENCES users(id),
        reviewed_at TIMESTAMP,
        recovery_accrued NUMERIC(6,1) DEFAULT 0,
        PRIMARY KEY (user_id, year, month)
      );
    `);
    
    // Activities table
    await client.query(`
      CREATE TABLE IF NOT EXISTS activities (
        id         SERIAL PRIMARY KEY,
        name       VARCHAR(100) UNIQUE NOT NULL,
        visible_to VARCHAR(10)  NOT NULL DEFAULT 'both'
                   CHECK (visible_to IN ('field', 'office', 'both')),
        is_leave   BOOLEAN NOT NULL DEFAULT false,
        color      VARCHAR(7)   NOT NULL DEFAULT '#7c3aed',
        active     BOOLEAN NOT NULL DEFAULT true,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      INSERT INTO activities (name, visible_to, is_leave, color, sort_order) VALUES
      ('Site',              'both',   false, '#0ea5e9', 1),
      ('Night Shift',       'field',  false, '#6d28d9', 2),
      ('Extra Days OnSite', 'field',  false, '#7c3aed', 3),
      ('Mission Office',    'field',  false, '#7c3aed', 4),
      ('Other Mission',     'field',  false, '#7c3aed', 5),
      ('Overtime',          'both',   false, '#ef4444', 6),
      ('Office',            'office', false, '#7c3aed', 7),
      ('Remote Work',       'office', false, '#06b6d4', 8),
      ('Mission',           'office', false, '#7c3aed', 10),
      ('Annual Leave',      'both',   true,  '#10b981', 11),
      ('Sick Leave',        'both',   true,  '#ef4444', 12),
      ('Training',          'office', false, '#f59e0b', 13),
      ('Compassionate',     'both',   true,  '#ec4899', 14),
      ('Recovery Leave',    'both',   true,  '#8b5cf6', 15)
      ON CONFLICT (name) DO NOTHING;
    `);

    // Holidays table
    await client.query(`
      CREATE TABLE IF NOT EXISTS holidays (
        id         SERIAL PRIMARY KEY,
        date       DATE UNIQUE NOT NULL,
        name       VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`
      INSERT INTO holidays (date, name) VALUES
      ('2025-01-01', 'New Year''s Day'),
      ('2025-03-20', 'Independence Day'),
      ('2025-04-09', 'Martyrs'' Day'),
      ('2025-05-01', 'Labour Day'),
      ('2025-07-25', 'Republic Day'),
      ('2025-08-13', 'Women''s Day'),
      ('2025-10-15', 'Evacuation Day')
      ON CONFLICT (date) DO NOTHING;
    `);

    // Add recovery_accrued to timesheet_status for existing deployments
    await client.query(`ALTER TABLE timesheet_status ADD COLUMN IF NOT EXISTS recovery_accrued NUMERIC(6,1) DEFAULT 0`);

    // Add auth time columns to requests for Temporary Authorization time-range
    await client.query(`ALTER TABLE requests ADD COLUMN IF NOT EXISTS auth_start_time VARCHAR(5)`);
    await client.query(`ALTER TABLE requests ADD COLUMN IF NOT EXISTS auth_end_time VARCHAR(5)`);

    // Consolidate: merge 'On Site', 'Days Onsite', 'Normal Shift' → 'Site'
    // Migrate timesheet entries first, then remove old activity rows
    await client.query(`UPDATE timesheet_entries SET activity='Site' WHERE activity IN ('On Site','Normal Shift','Days Onsite')`);
    await client.query(`DELETE FROM activities WHERE name IN ('On Site','Normal Shift','Days Onsite')`);

    // Insert initial roles
    await client.query(`
      INSERT INTO roles (key, label, color, permissions, system) VALUES
      ('superadmin', 'Super Admin', '#dc2626', '["all"]', true),
      ('admin', 'Admin', '#7c3aed', '["all"]', true),
      ('manager', 'Manager', '#0ea5e9', '["approve","view_team","analytics","reports"]', true),
      ('employee', 'Employee', '#10b981', '["timesheet","requests","schedule"]', true),
      ('hr', 'HR', '#f59e0b', '["hr_report","view_all","leave_balance"]', true),
      ('operations_manager', 'Operations Manager', '#0891b2', '["approve","view_team","analytics","reports"]', true),
      ('country_manager', 'Country Manager', '#7c2d12', '["approve","view_team","analytics","reports"]', true)
      ON CONFLICT (key) DO NOTHING;
    `);
    
    // Rotation plans table
    await client.query(`
      CREATE TABLE IF NOT EXISTS rotation_plans (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        on_start   DATE NOT NULL,
        on_end     DATE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, on_start)
      );
    `);

    // Audit log table
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id             SERIAL PRIMARY KEY,
        actor_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action         VARCHAR(80) NOT NULL,
        target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        detail         TEXT,
        created_at     TIMESTAMP DEFAULT NOW()
      );
    `);

    // Company settings table (single-row singleton)
    await client.query(`
      CREATE TABLE IF NOT EXISTS company_settings (
        id               INTEGER PRIMARY KEY DEFAULT 1,
        company_name     VARCHAR(100) NOT NULL DEFAULT 'MAZARINE',
        company_subtitle VARCHAR(200) NOT NULL DEFAULT 'Energy Tunisia',
        logo_base64      TEXT,
        CHECK (id = 1)
      );
    `);
    await client.query(`INSERT INTO company_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

    // Email / notification settings (singleton row)
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_settings (
        id                      INTEGER PRIMARY KEY DEFAULT 1,
        provider                VARCHAR(10)  NOT NULL DEFAULT 'disabled',
        smtp_host               VARCHAR(255),
        smtp_port               INTEGER      DEFAULT 587,
        smtp_secure             BOOLEAN      DEFAULT false,
        smtp_user               VARCHAR(255),
        smtp_pass               TEXT,
        smtp_from               VARCHAR(255),
        m365_tenant_id          VARCHAR(255),
        m365_client_id          VARCHAR(255),
        m365_client_secret      TEXT,
        m365_from               VARCHAR(255),
        notify_new_request      BOOLEAN DEFAULT true,
        notify_request_decision BOOLEAN DEFAULT true,
        notify_ts_submit        BOOLEAN DEFAULT true,
        notify_ts_decision      BOOLEAN DEFAULT true,
        CHECK (id = 1)
      );
    `);
    await client.query(`INSERT INTO email_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

    // Push notification settings (add push_notify_* columns for existing deployments)
    await client.query(`ALTER TABLE email_settings ADD COLUMN IF NOT EXISTS push_notify_new_request      BOOLEAN DEFAULT true`);
    await client.query(`ALTER TABLE email_settings ADD COLUMN IF NOT EXISTS push_notify_request_decision BOOLEAN DEFAULT true`);
    await client.query(`ALTER TABLE email_settings ADD COLUMN IF NOT EXISTS push_notify_ts_submit        BOOLEAN DEFAULT true`);
    await client.query(`ALTER TABLE email_settings ADD COLUMN IF NOT EXISTS push_notify_ts_decision      BOOLEAN DEFAULT true`);

    // VAPID keys stored in company_settings
    await client.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS vapid_public_key  TEXT`);
    await client.query(`ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS vapid_private_key TEXT`);

    // Push subscriptions (one row per user per browser)
    await client.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        endpoint   TEXT NOT NULL UNIQUE,
        p256dh     TEXT NOT NULL,
        auth       TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ── Workflow engine tables ──────────────────────────────────────────────
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
    await client.query(`ALTER TABLE requests ADD COLUMN IF NOT EXISTS workflow_instance_id INTEGER REFERENCES workflow_instances(id);`);
    await client.query(`ALTER TABLE timesheet_status ADD COLUMN IF NOT EXISTS workflow_instance_id INTEGER REFERENCES workflow_instances(id);`);

    // Insert superadmin bootstrap account only
    await client.query(`
      INSERT INTO users (id, email, name, role, type, dept, manager_id, active, leave_balance, used_leave, password, must_change_pwd) VALUES
      (0, 'superadmin@mazarine.tn', 'Super Admin', 'superadmin', 'office', 'IT', null, true, 0, 0, 'Maz@Admin2025!', false)
      ON CONFLICT (id) DO NOTHING;
    `);
    
    await client.query('COMMIT');
    console.log('Database initialized successfully');
    
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Database initialization error:', err);
    throw err;
  } finally {
    client.release();
    pool.end();
  }
};

initDatabase().catch(console.error);
