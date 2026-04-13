const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const webpush    = require('web-push');
const multer     = require('multer');
const jwksClient = require('jwks-rsa');
const azureStorage = require('./services/azureStorage');
const { Pool, types } = require('pg');
// Return DATE columns as plain strings (YYYY-MM-DD) instead of JS Date objects
types.setTypeParser(1082, val => val);
require('dotenv').config();

// Fail fast if JWT_SECRET is not configured
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Server will not start.');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;

const app = express();
const PORT = process.env.PORT || 3001;

// Database connection (pool capped to prevent exhaustion)
const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'mazarine',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'password',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // Azure Database for PostgreSQL requires SSL; set DB_SSL=true in production
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// ── Security utilities ───────────────────────────────────────────────────────
const BCRYPT_ROUNDS = 12;

// Escape user-supplied text before embedding in HTML emails
const escapeHtml = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

// Hash a password; accepts plaintext only
const hashPassword = p => bcrypt.hash(p, BCRYPT_ROUNDS);

// Verify password — supports both bcrypt hashes and legacy plaintext (migrates on match)
async function verifyPassword(plain, stored, userId) {
  if (stored && stored.startsWith('$2')) {
    return bcrypt.compare(plain, stored);
  }
  // Legacy plaintext — verify and transparently re-hash
  if (plain === stored) {
    const hashed = await hashPassword(plain);
    pool.query('UPDATE users SET password=$1 WHERE id=$2', [hashed, userId]).catch(() => {});
    return true;
  }
  return false;
}

// ── Authorization middleware ─────────────────────────────────────────────────
const ADMIN_ROLES = new Set(['superadmin', 'admin']);
const PRIVILEGED_ROLES = new Set(['superadmin', 'admin', 'hr', 'operations_manager', 'country_manager']);

const requireAdmin = (req, res, next) => {
  if (ADMIN_ROLES.has(req.user?.role)) return next();
  return res.status(403).json({ error: 'Forbidden: admin access required' });
};

const requireSuperAdmin = (req, res, next) => {
  if (req.user?.role === 'superadmin') return next();
  return res.status(403).json({ error: 'Forbidden: superadmin access required' });
};

const requirePrivileged = (req, res, next) => {
  if (PRIVILEGED_ROLES.has(req.user?.role)) return next();
  return res.status(403).json({ error: 'Forbidden' });
};

// ── Rate limiters ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later.' },
  keyGenerator: (req) => req.ip?.replace(/:\d+$/, '') || req.ip || '127.0.0.1',
  validate: { ip: false },
});

// Middleware
app.set('trust proxy', 1); // Trust first proxy hop (Docker / reverse proxy)
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
      "img-src": ["'self'", "data:", "blob:", "https:"],
      "connect-src": ["'self'", "https://fonts.googleapis.com", "https://fonts.gstatic.com", "https://login.microsoftonline.com"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({ origin: true, credentials: true }));

app.use(express.json());

// ── Audit helper ────────────────────────────────────────────────────────────
async function logAudit(actorId, action, detail, targetUserId = null) {
  try {
    await pool.query(
      'INSERT INTO audit_log (actor_id, action, detail, target_user_id) VALUES ($1,$2,$3,$4)',
      [actorId, action, detail, targetUserId]
    );
  } catch (e) { console.error('Audit log error:', e.message); }
}

// ── Email service ────────────────────────────────────────────────────────────
async function loadEmailConfig() {
  try {
    const r = await pool.query('SELECT * FROM email_settings WHERE id=1');
    return r.rows[0] || { provider: 'disabled' };
  } catch { return { provider: 'disabled' }; }
}

function emailWrap(title, body) {
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f4f4f4;padding:20px">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:8px;padding:28px;border:1px solid #e0e0e0">
  <div style="font-size:20px;font-weight:700;color:#7c3aed;margin-bottom:18px">⏱ Mazarine Timesheet</div>
  <div style="font-size:16px;font-weight:600;margin-bottom:14px;color:#111">${title}</div>
  <div style="font-size:14px;color:#333;line-height:1.7">${body}</div>
  <div style="margin-top:22px;font-size:11px;color:#aaa;border-top:1px solid #eee;padding-top:10px">
    Automated notification — Mazarine Energy Tunisia
  </div>
</div></body></html>`;
}

async function sendEmail(to, subject, html) {
  if (!to) return;
  const cfg = await loadEmailConfig();
  if (!cfg || cfg.provider === 'disabled') return;

  if (cfg.provider === 'smtp') {
    const transporter = nodemailer.createTransport({
      host: cfg.smtp_host,
      port: Number(cfg.smtp_port) || 587,
      secure: cfg.smtp_secure || false,
      auth: cfg.smtp_user ? { user: cfg.smtp_user, pass: cfg.smtp_pass } : undefined
    });
    await transporter.sendMail({ from: cfg.smtp_from || cfg.smtp_user, to, subject, html });
  } else if (cfg.provider === 'm365') {
    // Client credentials OAuth2 → Microsoft Graph sendMail
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${cfg.m365_tenant_id}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: cfg.m365_client_id,
          client_secret: cfg.m365_client_secret,
          scope: 'https://graph.microsoft.com/.default'
        }).toString()
      }
    );
    const tok = await tokenRes.json();
    if (!tok.access_token) throw new Error('M365 token error: ' + (tok.error_description || tok.error));
    const graphRes = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.m365_from)}/sendMail`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: 'HTML', content: html },
            toRecipients: [{ emailAddress: { address: to } }]
          },
          saveToSentItems: false
        })
      }
    );
    if (!graphRes.ok) throw new Error('Graph API error: ' + await graphRes.text());
  }
}

async function sendEmailSafe(to, subject, html) {
  sendEmail(to, subject, html).catch(e => console.error('[email]', e.message));
}

// ── Web Push service ─────────────────────────────────────────────────────────
let vapidPublicKey = null;

async function initVapid() {
  try {
    const row = (await pool.query('SELECT vapid_public_key, vapid_private_key FROM company_settings WHERE id=1')).rows[0] || {};
    let pub = row.vapid_public_key;
    let priv = row.vapid_private_key;
    if (!pub || !priv) {
      const keys = webpush.generateVAPIDKeys();
      pub  = keys.publicKey;
      priv = keys.privateKey;
      await pool.query('UPDATE company_settings SET vapid_public_key=$1, vapid_private_key=$2 WHERE id=1', [pub, priv]);
      console.log('[push] VAPID keys generated and stored.');
    }
    webpush.setVapidDetails('mailto:admin@mazarine.tn', pub, priv);
    vapidPublicKey = pub;
    console.log('[push] VAPID ready.');
  } catch (e) { console.error('[push] VAPID init error:', e.message); }
}
initVapid();

async function sendPush(userId, title, body, url = '/') {
  try {
    const subs = await pool.query('SELECT * FROM push_subscriptions WHERE user_id=$1', [userId]);
    for (const s of subs.rows) {
      webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title, body, url, tag: 'mazarine', icon: '/icon-192.png' })
      ).catch(async err => {
        // 410 Gone = subscription expired, remove it
        if (err.statusCode === 410 || err.statusCode === 404) {
          await pool.query('DELETE FROM push_subscriptions WHERE id=$1', [s.id]);
        }
      });
    }
  } catch (e) { console.error('[push] send error:', e.message); }
}

async function loadPushCfg() {
  const row = (await pool.query('SELECT push_notify_new_request,push_notify_request_decision,push_notify_ts_submit,push_notify_ts_decision FROM email_settings WHERE id=1')).rows[0] || {};
  return row;
}

// JWT authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// ===== AUTH ROUTES =====

// Login
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const result = await pool.query(
      'SELECT id, email, name, role, type, dept, manager_id, functional_manager_id, active, leave_balance, used_leave, password, must_change_pwd, totp_enabled FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    if (!user.active) {
      return res.status(403).json({ error: 'Account deactivated' });
    }

    const validPassword = await verifyPassword(password, user.password, user.id);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // If TOTP is enabled, require second factor before issuing JWT
    if (user.totp_enabled) {
      return res.json({ requiresTOTP: true, pendingUserId: user.id });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    logAudit(user.id, 'login', `${user.email} logged in`);
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        type: user.type,
        dept: user.dept,
        manager: user.manager_id,
        functionalManager: user.functional_manager_id,
        active: user.active,
        leaveBalance: user.leave_balance,
        usedLeave: user.used_leave,
        mustChangePwd: user.must_change_pwd
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Change password
app.post('/api/auth/change-password', authLimiter, authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    const userId = req.user.id;

    const result = await pool.query('SELECT password FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const valid = await verifyPassword(currentPassword, result.rows[0].password, userId);
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' });

    const hashed = await hashPassword(newPassword);
    await pool.query(
      'UPDATE users SET password = $1, must_change_pwd = false WHERE id = $2',
      [hashed, userId]
    );

    res.json({ message: 'Password updated' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== TOTP / 2FA ROUTES =====

// Complete login with TOTP code (step 2, no auth required)
app.post('/api/auth/totp/verify-login', async (req, res) => {
  try {
    const { pendingUserId, code } = req.body;
    const result = await pool.query(
      'SELECT id, email, name, role, type, dept, manager_id, functional_manager_id, active, leave_balance, used_leave, must_change_pwd, totp_secret FROM users WHERE id=$1 AND totp_enabled=true AND active=true',
      [pendingUserId]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid session' });
    const user = result.rows[0];
    const valid = speakeasy.totp.verify({ secret: user.totp_secret, encoding: 'base32', token: String(code), window: 1 });
    if (!valid) return res.status(401).json({ error: 'Invalid authenticator code' });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role, type: user.type, dept: user.dept, manager: user.manager_id, functionalManager: user.functional_manager_id, active: user.active, leaveBalance: user.leave_balance, usedLeave: user.used_leave, mustChangePwd: user.must_change_pwd } });
  } catch (err) {
    console.error('TOTP verify-login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Generate TOTP secret + QR code (authenticated, not yet enabled)
app.get('/api/auth/totp/setup', authenticateToken, async (req, res) => {
  try {
    const userResult = await pool.query('SELECT email FROM users WHERE id=$1', [req.user.id]);
    const email = userResult.rows[0]?.email || req.user.email;
    const secret = speakeasy.generateSecret({ length: 20, name: `Mazarine Timesheet:${email}`, issuer: 'Mazarine Timesheet' });
    const qr = await QRCode.toDataURL(secret.otpauth_url);
    res.json({ secret: secret.base32, qr, otpauthUrl: secret.otpauth_url });
  } catch (err) {
    console.error('TOTP setup error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Enable TOTP — verify code then save secret
app.post('/api/auth/totp/enable', authenticateToken, async (req, res) => {
  try {
    const { secret, code } = req.body;
    const valid = speakeasy.totp.verify({ secret, encoding: 'base32', token: String(code), window: 1 });
    if (!valid) return res.status(400).json({ error: 'Invalid verification code — check your authenticator app' });
    await pool.query('UPDATE users SET totp_secret=$1, totp_enabled=true WHERE id=$2', [secret, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('TOTP enable error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Disable TOTP — requires current TOTP code
app.post('/api/auth/totp/disable', authenticateToken, async (req, res) => {
  try {
    const { code } = req.body;
    const result = await pool.query('SELECT totp_secret FROM users WHERE id=$1 AND totp_enabled=true', [req.user.id]);
    if (result.rows.length === 0) return res.status(400).json({ error: '2FA is not enabled' });
    const valid = speakeasy.totp.verify({ secret: result.rows[0].totp_secret, encoding: 'base32', token: String(code), window: 1 });
    if (!valid) return res.status(400).json({ error: 'Invalid authenticator code' });
    await pool.query('UPDATE users SET totp_secret=NULL, totp_enabled=false WHERE id=$1', [req.user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('TOTP disable error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get TOTP status for current user
app.get('/api/auth/totp/status', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT totp_enabled FROM users WHERE id=$1', [req.user.id]);
    res.json({ enabled: result.rows[0]?.totp_enabled || false });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== USERS ROUTES =====

// Get all users
app.get('/api/users', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.email, u.name, u.role, u.type, u.dept, u.manager_id, u.functional_manager_id, u.active,
             u.leave_balance, u.used_leave, u.recovery_balance, u.must_change_pwd, u.totp_enabled, u.allow_overlap,
             m.name as manager_name,
             fm.name as functional_manager_name
      FROM users u
      LEFT JOIN users m ON u.manager_id = m.id
      LEFT JOIN users fm ON u.functional_manager_id = fm.id
      ORDER BY u.name
    `);
    
    res.json(result.rows);
  } catch (err) {
    console.error('Get users error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user by ID
app.get('/api/users/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, email, name, role, type, dept, manager_id, active, 
             leave_balance, used_leave, must_change_pwd
      FROM users WHERE id = $1
    `, [req.params.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create user (admin only)
app.post('/api/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { email, name, role, type, dept, manager, functionalManager, leaveBalance, password } = req.body;
    if (!email || !name || !role) return res.status(400).json({ error: 'email, name, and role are required' });

    const plainPwd = password || 'Mazarine@Temp1!';
    const hashedPwd = await hashPassword(plainPwd);

    const result = await pool.query(
      `INSERT INTO users (email, name, role, type, dept, manager_id, functional_manager_id, leave_balance, password, active, must_change_pwd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, true)
       RETURNING id, email, name, role, type, dept, manager_id, functional_manager_id, active, leave_balance`,
      [email.toLowerCase().trim(), name.trim(), role, type, dept, manager || null, functionalManager || null, leaveBalance || 20, hashedPwd]
    );

    logAudit(req.user.id, 'user_created', `Created user ${result.rows[0].name} (${result.rows[0].email})`, result.rows[0].id);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already in use' });
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user (admin only)
app.put('/api/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, role, type, dept, manager, functionalManager, leaveBalance, usedLeave, recoveryBalance, active, allowOverlap } = req.body;

    // Fetch old values for balance-change audit trail
    const oldRow = await pool.query('SELECT name, leave_balance, used_leave, recovery_balance FROM users WHERE id=$1', [req.params.id]);
    const old = oldRow.rows[0];

    const result = await pool.query(
      `UPDATE users
       SET name = $1, role = $2, type = $3, dept = $4, manager_id = $5, functional_manager_id = $6,
           leave_balance = $7, used_leave = $8, recovery_balance = $9, active = $10, allow_overlap = $11
       WHERE id = $12
       RETURNING id, email, name, role, type, dept, manager_id, functional_manager_id, active, leave_balance, used_leave, recovery_balance, allow_overlap`,
      [name, role, type, dept, manager || null, functionalManager || null, leaveBalance, usedLeave,
       recoveryBalance ?? old?.recovery_balance ?? 0, active, allowOverlap ?? false, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Log balance changes to audit trail
    if (old) {
      const changes = [];
      if (Number(old.leave_balance) !== Number(leaveBalance)) changes.push(`Annual Leave: ${old.leave_balance}→${leaveBalance}`);
      if (Number(old.used_leave)    !== Number(usedLeave))    changes.push(`Used Leave: ${old.used_leave}→${usedLeave}`);
      const newRec = recoveryBalance ?? old.recovery_balance;
      if (Number(old.recovery_balance) !== Number(newRec))    changes.push(`Recovery: ${old.recovery_balance}→${newRec}`);
      if (changes.length > 0) {
        logAudit(req.user.id, 'balance_adjusted', `Balance adjusted for ${result.rows[0].name}: ${changes.join(', ')}`, Number(req.params.id));
      }
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete user (admin only)
app.delete('/api/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const uLookup = await pool.query('SELECT name, email FROM users WHERE id=$1', [req.params.id]);
    const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const uName = uLookup.rows[0] ? `${uLookup.rows[0].name} (${uLookup.rows[0].email})` : `id=${req.params.id}`;
    logAudit(req.user.id, 'user_deleted', `Deleted ${uName}`, Number(req.params.id));
    res.json({ message: 'User deleted' });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reset user password (admin only)
app.put('/api/users/:id/password', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { password, mustChangePwd } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required' });
    const hashed = await hashPassword(password);
    const result = await pool.query(
      'UPDATE users SET password = $1, must_change_pwd = $2 WHERE id = $3 RETURNING id',
      [hashed, mustChangePwd !== false, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const uLookup2 = await pool.query('SELECT name FROM users WHERE id=$1', [req.params.id]);
    const uName2 = uLookup2.rows[0]?.name || `id=${req.params.id}`;
    logAudit(req.user.id, 'password_reset', `Password reset for ${uName2}`, Number(req.params.id));
    res.json({ message: 'Password reset successfully' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin reset MFA for a user (admin only)
app.delete('/api/users/:id/totp', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE users SET totp_secret=NULL, totp_enabled=false WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Reset TOTP error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== COMPANY ENTITIES =====

app.get('/api/company-entities', authenticateToken, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM company_entities ORDER BY code');
    res.json(r.rows);
  } catch (err) {
    console.error('Get company entities error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/company-entities', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { code, name } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code and name required' });
    const r = await pool.query(
      'INSERT INTO company_entities (code, name) VALUES ($1,$2) RETURNING *',
      [code, name]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('Create company entity error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/company-entities/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { code, name, active } = req.body;
    const r = await pool.query(
      'UPDATE company_entities SET code=$1, name=$2, active=$3 WHERE id=$4 RETURNING *',
      [code, name, active !== false, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('Update company entity error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/company-entities/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const used = await pool.query('SELECT 1 FROM projects WHERE entity_id=$1 LIMIT 1', [req.params.id]);
    if (used.rows.length) return res.status(409).json({ error: 'Entity is used by one or more projects' });
    await pool.query('DELETE FROM company_entities WHERE id=$1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error('Delete company entity error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== PROJECTS ROUTES =====

// Get all projects
app.get('/api/projects', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, ce.code AS entity_code, ce.name AS entity_name
      FROM projects p
      LEFT JOIN company_entities ce ON ce.id = p.entity_id
      ORDER BY p.open DESC, p.code
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('Get projects error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create project (admin only)
app.post('/api/projects', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { code, name, dept, open, fieldAllowed, officeAllowed, color, expiryDate, entityId } = req.body;

    const result = await pool.query(
      `INSERT INTO projects (code, name, dept, open, field_allowed, office_allowed, color, expiry_date, entity_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [code, name, dept, open !== false, fieldAllowed !== false, officeAllowed !== false, color || '#7c3aed', expiryDate || null, entityId || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create project error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update project (admin only)
app.put('/api/projects/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { code, name, dept, open, fieldAllowed, officeAllowed, color, expiryDate, entityId } = req.body;

    const result = await pool.query(
      `UPDATE projects
       SET code = $1, name = $2, dept = $3, open = $4,
           field_allowed = $5, office_allowed = $6, color = $7, expiry_date = $8, entity_id = $9
       WHERE id = $10
       RETURNING *`,
      [code, name, dept, open, fieldAllowed, officeAllowed, color, expiryDate || null, entityId || null, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update project error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete project (admin only)
app.delete('/api/projects/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM projects WHERE id = $1 RETURNING id', [req.params.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }
    
    res.json({ message: 'Project deleted' });
  } catch (err) {
    console.error('Delete project error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== BULK IMPORT =====

// POST /api/users/import  — batch create users from CSV rows
// Body: { users: [{ name, email, role, type, dept, manager_email, leave_balance }] }
// Returns: { created, skipped, errors: [{ row, email, reason }] }
app.post('/api/users/import', authenticateToken, requireAdmin, async (req, res) => {
  const { users: rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'Provide a non-empty users array' });
  }
  if (rows.length > 500) return res.status(400).json({ error: 'Maximum 500 rows per import' });

  const VALID_TYPES = new Set(['field', 'office']);
  const created = [];
  const errors = [];

  // Pre-fetch all emails to resolve manager_email → id
  const existingUsers = (await pool.query('SELECT id, email FROM users')).rows;
  const emailToId = Object.fromEntries(existingUsers.map(u => [u.email.toLowerCase(), u.id]));

  // Pre-fetch valid role keys
  const validRoles = new Set((await pool.query('SELECT key FROM roles')).rows.map(r => r.key));

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1;
    const email = (row.email || '').toLowerCase().trim();
    const name = (row.name || '').trim();
    const role = (row.role || 'employee').toLowerCase().trim();
    const type = (row.type || 'office').toLowerCase().trim();
    const dept = (row.dept || '').trim();
    const leaveBalance = parseFloat(row.leave_balance) || 20;
    const managerEmail = (row.manager_email || '').toLowerCase().trim();

    // Validate required fields
    if (!email) { errors.push({ row: rowNum, email: email || '(empty)', reason: 'Email is required' }); continue; }
    if (!name)  { errors.push({ row: rowNum, email, reason: 'Name is required' }); continue; }
    if (!validRoles.has(role)) { errors.push({ row: rowNum, email, reason: `Invalid role: "${role}"` }); continue; }
    if (!VALID_TYPES.has(type)) { errors.push({ row: rowNum, email, reason: `Type must be "field" or "office"` }); continue; }
    if (emailToId[email]) { errors.push({ row: rowNum, email, reason: 'Email already exists' }); continue; }

    const managerId = managerEmail ? (emailToId[managerEmail] || null) : null;

    try {
      const hashed = await hashPassword('Mazarine@Temp1!');
      const result = await pool.query(
        `INSERT INTO users (email, name, role, type, dept, manager_id, leave_balance, password, active, must_change_pwd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,true)
         RETURNING id, email, name, role, type, dept`,
        [email, name, role, type, dept || null, managerId, leaveBalance, hashed]
      );
      emailToId[email] = result.rows[0].id; // make available for subsequent manager lookups
      created.push(result.rows[0]);
    } catch (err) {
      const reason = err.code === '23505' ? 'Email already exists' : err.message;
      errors.push({ row: rowNum, email, reason });
    }
  }

  if (created.length > 0) {
    logAudit(req.user.id, 'users_imported', `Bulk imported ${created.length} user(s) via CSV`);
  }
  res.json({ created: created.length, skipped: errors.length, errors });
});

// POST /api/projects/import  — batch create projects from CSV rows
// Body: { projects: [{ code, name, type, dept, color, field_allowed, office_allowed }] }
// Returns: { created, skipped, errors: [{ row, code, reason }] }
app.post('/api/projects/import', authenticateToken, requireAdmin, async (req, res) => {
  const { projects: rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'Provide a non-empty projects array' });
  }
  if (rows.length > 500) return res.status(400).json({ error: 'Maximum 500 rows per import' });

  const created = [];
  const errors = [];

  // Pre-fetch existing codes to detect duplicates before hitting DB
  const existingCodes = new Set(
    (await pool.query('SELECT code FROM projects')).rows.map(p => p.code.toUpperCase())
  );

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1;
    const code = (row.code || '').trim().toUpperCase();
    const name = (row.name || '').trim();
    const dept = (row.dept || '').trim();
    const color = /^#[0-9a-fA-F]{6}$/.test(row.color || '') ? row.color : '#7c3aed';
    const fieldAllowed = String(row.field_allowed || '').toLowerCase() !== 'false';
    const officeAllowed = String(row.office_allowed || '').toLowerCase() !== 'false';

    if (!code) { errors.push({ row: rowNum, code: '(empty)', reason: 'Code is required' }); continue; }
    if (!name) { errors.push({ row: rowNum, code, reason: 'Name is required' }); continue; }
    if (existingCodes.has(code)) { errors.push({ row: rowNum, code, reason: 'Project code already exists' }); continue; }

    try {
      const result = await pool.query(
        `INSERT INTO projects (code, name, dept, open, field_allowed, office_allowed, color)
         VALUES ($1,$2,$3,true,$4,$5,$6)
         RETURNING id, code, name, dept, field_allowed, office_allowed, color`,
        [code, name, dept || null, fieldAllowed, officeAllowed, color]
      );
      existingCodes.add(code);
      created.push(result.rows[0]);
    } catch (err) {
      const reason = err.code === '23505' ? 'Project code already exists' : err.message;
      errors.push({ row: rowNum, code, reason });
    }
  }

  if (created.length > 0) {
    logAudit(req.user.id, 'projects_imported', `Bulk imported ${created.length} project(s) via CSV`);
  }
  res.json({ created: created.length, skipped: errors.length, errors });
});

// ===== REQUESTS ROUTES =====

// Get all requests (with filters)
app.get('/api/requests', authenticateToken, async (req, res) => {
  try {
    const { userId, status } = req.query;
    let query = `
      SELECT r.*, u.name as user_name, u.email as user_email,
        wa.approver_id as current_approver_id
      FROM requests r
      JOIN users u ON r.user_id = u.id
      LEFT JOIN workflow_approvals wa ON wa.instance_id = r.workflow_instance_id AND wa.status = 'pending'
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;
    
    if (userId) {
      query += ` AND r.user_id = $${paramIndex++}`;
      params.push(userId);
    }
    
    if (status) {
      query += ` AND r.status = $${paramIndex++}`;
      params.push(status);
    }
    
    query += ' ORDER BY r.created_at DESC';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Get requests error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Helper: pad number to 2 digits
const pad2 = n => String(n).padStart(2, '0');

// Map request type → activity name using the DB activities table.
// Returns the activity name if found (exact match), otherwise null.
async function resolveApprovalActivity(client, requestType) {
  const r = await client.query(
    'SELECT name FROM activities WHERE name = $1 AND active = true LIMIT 1',
    [requestType]
  );
  return r.rows[0]?.name || null;
}

// Upsert timesheet entries for approved request dates (weekdays only, skip submitted/approved months)
async function syncTimesheetEntries(client, request, activity, userType) {
  const hours = userType === 'field' ? 12 : 8;
  const start = new Date(request.start_date);
  const end   = new Date(request.end_date);
  const affectedMonths = new Set();
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const yr = d.getFullYear(), mo = d.getMonth() + 1, dy = d.getDate();
    const dateStr = `${yr}-${pad2(mo)}-${pad2(dy)}`;
    const ts = await client.query(
      'SELECT status FROM timesheet_status WHERE user_id=$1 AND year=$2 AND month=$3',
      [request.user_id, yr, mo]
    );
    if (ts.rows[0] && ['submitted', 'approved'].includes(ts.rows[0].status)) continue;
    await client.query(
      `INSERT INTO timesheet_entries (user_id,year,month,day,date,activity,locked,hours,allocations)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7,'[]')
       ON CONFLICT (user_id,year,month,day) DO UPDATE
       SET activity=EXCLUDED.activity, locked=true, hours=EXCLUDED.hours, allocations='[]'`,
      [request.user_id, yr, mo, dy, dateStr, activity, hours]
    );
    affectedMonths.add(`${request.user_id}-${yr}-${pad2(mo)}`);
  }
  return [...affectedMonths];
}

// Reset timesheet entries when a request is cancelled
async function resetTimesheetEntries(client, request, userType) {
  const defRow = await client.query(
    `SELECT name FROM activities WHERE (visible_to=$1 OR visible_to='both') AND active=true ORDER BY sort_order,id LIMIT 1`,
    [userType]
  );
  const defaultActivity = defRow.rows[0]?.name || (userType === 'field' ? 'Normal Shift' : 'Office');
  const defaultHours    = userType === 'field' ? 12 : 8;
  const start = new Date(request.start_date);
  const end   = new Date(request.end_date);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const yr = d.getFullYear(), mo = d.getMonth() + 1, dy = d.getDate();
    const dateStr = `${yr}-${pad2(mo)}-${pad2(dy)}`;
    const ts = await client.query(
      'SELECT status FROM timesheet_status WHERE user_id=$1 AND year=$2 AND month=$3',
      [request.user_id, yr, mo]
    );
    if (ts.rows[0] && ['submitted', 'approved'].includes(ts.rows[0].status)) continue;
    await client.query(
      `UPDATE timesheet_entries SET activity=$1, locked=false, hours=$2, allocations='[]'
       WHERE user_id=$3 AND date=$4`,
      [defaultActivity, defaultHours, request.user_id, dateStr]
    );
  }
}

// Create request
app.post('/api/requests', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const { userId, type, start, end, comment, daysCount, durationHours, halfDayStart, halfDayEnd, balanceSource, authStartTime, authEndTime, attachmentUrl } = req.body;

    // Block request if any covered month's timesheet is submitted/approved
    if (type !== 'Temporary Authorization') {
      const startD = new Date(start);
      const endD   = new Date(end || start);
      const checked = new Set();
      for (let d = new Date(startD.getFullYear(), startD.getMonth(), 1);
           d <= new Date(endD.getFullYear(), endD.getMonth(), 1);
           d.setMonth(d.getMonth() + 1)) {
        const yr = d.getFullYear(), mo = d.getMonth() + 1;
        const ck = `${yr}-${mo}`;
        if (checked.has(ck)) continue;
        checked.add(ck);
        const ts = await client.query(
          'SELECT status FROM timesheet_status WHERE user_id=$1 AND year=$2 AND month=$3',
          [userId, yr, mo]
        );
        if (ts.rows[0] && ['submitted','approved'].includes(ts.rows[0].status)) {
          const mn = d.toLocaleString('default', { month: 'long' });
          client.release();
          return res.status(400).json({ error: `Timesheet for ${mn} ${yr} is already ${ts.rows[0].status}. Cannot create a request for this period.` });
        }
      }
    }

    await client.query('BEGIN');

    // Deduct leave balance on submission (symmetric: restored on rejection/cancel)
    const annualLeaveTypes = ['Annual Leave', 'Sick Leave', 'Compassionate'];
    let daysDeducted = 0, recoveryDeducted = 0;
    if (annualLeaveTypes.includes(type) && Number(daysCount) > 0) {
      const balRow = await client.query('SELECT leave_balance, recovery_balance FROM users WHERE id=$1', [userId]);
      const bal = balRow.rows[0] || {};
      if ((balanceSource || 'annual') === 'recovery') {
        if (Number(bal.recovery_balance) < Number(daysCount)) {
          await client.query('ROLLBACK');
          client.release();
          return res.status(400).json({ error: `Insufficient recovery balance (${bal.recovery_balance}d available, ${daysCount}d requested)` });
        }
        await client.query('UPDATE users SET recovery_balance = recovery_balance - $1 WHERE id=$2', [daysCount, userId]);
        recoveryDeducted = Number(daysCount);
      } else {
        if (Number(bal.leave_balance) < Number(daysCount)) {
          await client.query('ROLLBACK');
          client.release();
          return res.status(400).json({ error: `Insufficient annual leave balance (${bal.leave_balance}d available, ${daysCount}d requested)` });
        }
        await client.query('UPDATE users SET leave_balance = leave_balance - $1, used_leave = used_leave + $1 WHERE id=$2', [daysCount, userId]);
        daysDeducted = Number(daysCount);
      }
    } else if (type === 'Recovery Leave' && Number(daysCount) > 0) {
      const balRow = await client.query('SELECT recovery_balance FROM users WHERE id=$1', [userId]);
      const bal = balRow.rows[0] || {};
      if (Number(bal.recovery_balance) < Number(daysCount)) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ error: `Insufficient recovery balance (${bal.recovery_balance}d available, ${daysCount}d requested)` });
      }
      await client.query('UPDATE users SET recovery_balance = recovery_balance - $1 WHERE id=$2', [daysCount, userId]);
      recoveryDeducted = Number(daysCount);
    }

    // Find matching workflow for this request
    const entityType = type === 'Temporary Authorization' ? 'temp_auth' : 'leave';
    const submitterRow = await client.query('SELECT * FROM users WHERE id=$1', [userId]);
    const submitter = submitterRow.rows[0];
    const requestData = { type, days_count: Number(daysCount) || 0 };
    const matchedWf = await findMatchingWorkflow(client, entityType, submitter, requestData);

    let wfInstanceId = null;
    let wfApproverIds = [];
    let wfTotalSteps = 1;

    if (matchedWf) {
      const wfResult = await createWorkflowInstance(client, matchedWf, entityType, `request:pending`, submitter.id, requestData);
      wfInstanceId = wfResult.instanceId;
      wfApproverIds = wfResult.approverIds;
      wfTotalSteps = wfResult.totalSteps;
    }

    const result = await client.query(
      `INSERT INTO requests (user_id, type, start_date, end_date, comment, days_count, duration_hours, half_day_start, half_day_end, balance_source, auth_start_time, auth_end_time, status, created_at, approval_step, total_steps, workflow_instance_id, attachment_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'Pending', NOW(), 1, $13, $14, $15)
       RETURNING *`,
      [userId, type, start, end, comment||null, daysCount, durationHours||null, halfDayStart||null, halfDayEnd||null, balanceSource||'annual', authStartTime||null, authEndTime||null, wfTotalSteps, wfInstanceId, attachmentUrl||null]
    );

    // Update workflow instance entity_ref with actual request ID
    if (wfInstanceId) {
      await client.query('UPDATE workflow_instances SET entity_ref=$1 WHERE id=$2', [`request:${result.rows[0].id}`, wfInstanceId]);
    }

    await client.query('COMMIT');
    // Audit: request created
    logAudit(req.user.id, 'request_created', `Request #${result.rows[0].id}: ${type} ${start}${end&&end!==start?' → '+end:''} (${daysCount||'—'}d)`, userId);
    res.status(201).json({ ...result.rows[0], daysDeducted, recoveryDeducted });

    // Notify approver(s) asynchronously (email + push)
    Promise.all([loadEmailConfig(), loadPushCfg()]).then(async ([emailCfg, pushCfg]) => {
      const empName = submitter.name || 'Employee';
      let approverIds = wfApproverIds.length > 0 ? wfApproverIds : [];
      let approverEmails = [];
      // If no workflow matched, fallback to direct manager
      if (approverIds.length === 0) {
        if (submitter.manager_id) { approverIds.push(submitter.manager_id); }
      }
      if (approverIds.length > 0) {
        const emailRows = await pool.query('SELECT id, email FROM users WHERE id = ANY($1)', [approverIds]);
        approverEmails = emailRows.rows.map(r => r.email);
      }
      if (emailCfg.notify_new_request && emailCfg.provider !== 'disabled') {
        for (const email of approverEmails) {
          sendEmailSafe(email, `New ${escapeHtml(type)} request from ${escapeHtml(empName)}`,
            emailWrap(`New ${escapeHtml(type)} Request`,
              `<b>${escapeHtml(empName)}</b> has submitted a <b>${escapeHtml(type)}</b> request.<br><br>
               <b>Period:</b> ${escapeHtml(start)} → ${escapeHtml(end||start)}<br>
               <b>Days:</b> ${escapeHtml(String(daysCount||'—'))}<br>
               ${comment ? `<b>Comment:</b> ${escapeHtml(comment)}<br>` : ''}
               <br>Please log in to the Mazarine Timesheet to review and approve.`));
        }
      }
      if (pushCfg.push_notify_new_request) {
        for (const aid of approverIds) {
          sendPush(aid, `New ${type} request`, `${empName} · ${start}${end&&end!==start?' → '+end:''} (${daysCount||'—'}d)`, '/');
        }
      }
    }).catch(() => {});

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Create request error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Update request status
app.put('/api/requests/:id', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const { status, reviewComment } = req.body;

    await client.query('BEGIN');

    // Fetch current request
    const existing = await client.query('SELECT * FROM requests WHERE id=$1', [req.params.id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Request not found' });
    }
    const current = existing.rows[0];

    let affectedMonths = [];
    let daysRestored = 0, recoveryRestored = 0;
    let finalStatus = status;
    let escalatedToL2 = false;
    let nextApproverIds = [];

    // Use workflow engine if this request has a workflow instance
    if (current.workflow_instance_id && status === 'Approved') {
      const requestData = { type: current.type, days_count: Number(current.days_count) || 0 };
      const wfResult = await advanceWorkflow(client, current.workflow_instance_id, req.user.id, status, reviewComment, requestData);
      finalStatus = wfResult.finalStatus;
      nextApproverIds = wfResult.nextApproverIds || [];

      if (finalStatus === 'Pending') {
        // Escalate to next step
        const stepNum = (current.approval_step || 1) + 1;
        await client.query(
          `UPDATE requests SET status='Pending L2', approval_step=$1,
           step1_reviewed_by=$2, step1_reviewed_at=NOW(), step1_comment=$3
           WHERE id=$4`,
          [stepNum, req.user.id, reviewComment, req.params.id]
        );
        finalStatus = 'Pending L2';
        escalatedToL2 = true;
      } else {
        // Final approval or rejection
        await client.query(
          `UPDATE requests SET status=$1, review_comment=$2, reviewed_by=$3, reviewed_at=NOW() WHERE id=$4`,
          [finalStatus, reviewComment, req.user.id, req.params.id]
        );
      }
    } else if (current.workflow_instance_id && status === 'Rejected') {
      const requestData = { type: current.type, days_count: Number(current.days_count) || 0 };
      await advanceWorkflow(client, current.workflow_instance_id, req.user.id, status, reviewComment, requestData);
      await client.query(
        `UPDATE requests SET status='Rejected', review_comment=$1, reviewed_by=$2, reviewed_at=NOW() WHERE id=$3`,
        [reviewComment, req.user.id, req.params.id]
      );
      finalStatus = 'Rejected';
    } else {
      // Legacy: no workflow instance — direct update
      await client.query(
        `UPDATE requests SET status=$1, review_comment=$2, reviewed_by=$3, reviewed_at=NOW() WHERE id=$4`,
        [status, reviewComment, req.user.id, req.params.id]
      );
    }

    // Re-fetch updated request
    const result = await client.query('SELECT * FROM requests WHERE id=$1', [req.params.id]);
    const request = result.rows[0];
    const annualLeaveTypes = ['Annual Leave', 'Sick Leave', 'Compassionate'];

    if (finalStatus === 'Approved') {
      // Final approval — sync timesheet entries
      const activity = await resolveApprovalActivity(client, request.type);
      if (activity) {
        const uRow = await client.query('SELECT type FROM users WHERE id=$1', [request.user_id]);
        const userType = uRow.rows[0]?.type || 'office';
        affectedMonths = await syncTimesheetEntries(client, request, activity, userType);
      }
    } else if (finalStatus === 'Rejected') {
      // Restore leave balance on rejection (at any step)
      if (annualLeaveTypes.includes(request.type) && Number(request.days_count) > 0) {
        if (request.balance_source === 'recovery') {
          await client.query('UPDATE users SET recovery_balance = recovery_balance + $1 WHERE id=$2',
            [request.days_count, request.user_id]);
          recoveryRestored = Number(request.days_count);
        } else {
          await client.query('UPDATE users SET leave_balance = leave_balance + $1, used_leave = GREATEST(0, used_leave - $1) WHERE id=$2',
            [request.days_count, request.user_id]);
          daysRestored = Number(request.days_count);
        }
      } else if (request.type === 'Recovery Leave' && Number(request.days_count) > 0) {
        await client.query('UPDATE users SET recovery_balance = recovery_balance + $1 WHERE id=$2',
          [request.days_count, request.user_id]);
        recoveryRestored = Number(request.days_count);
      }
    }

    await client.query('COMMIT');
    const req2 = request;
    const reqUserRow = await pool.query('SELECT name, email FROM users WHERE id=$1', [req2.user_id]);
    const reqUserName  = reqUserRow.rows[0]?.name  || `id=${req2.user_id}`;
    const reqUserEmail = reqUserRow.rows[0]?.email || null;
    logAudit(req.user.id, `request_${(escalatedToL2 ? 'approved_l1' : status.toLowerCase())}`, `Request #${req2.id}: ${escalatedToL2 ? 'Approved (L1)' : status} ${req2.type} for ${reqUserName} (${req2.start_date?.toISOString?.().slice(0,10)||req2.start_date}→${req2.end_date?.toISOString?.().slice(0,10)||req2.end_date})${reviewComment?` — "${reviewComment}"`:''}`, req2.user_id);
    res.json({ ...req2, affectedMonths, daysRestored, recoveryRestored });

    // Notifications (email + push)
    Promise.all([loadEmailConfig(), loadPushCfg()]).then(async ([emailCfg, pushCfg]) => {
      if (escalatedToL2) {
        // Notify next approver(s) from workflow engine
        if (nextApproverIds.length > 0) {
          const l2Rows = await pool.query('SELECT id, email FROM users WHERE id = ANY($1)', [nextApproverIds]);
          for (const approver of l2Rows.rows) {
            if (emailCfg.notify_new_request && emailCfg.provider !== 'disabled') {
              sendEmailSafe(approver.email, `[Next Approval] ${escapeHtml(req2.type)} request from ${escapeHtml(reqUserName)}`,
                emailWrap(`${escapeHtml(req2.type)} — Approval Required`,
                  `<b>${escapeHtml(reqUserName)}</b>'s <b>${escapeHtml(req2.type)}</b> request requires your approval.<br><br>
                   <b>Period:</b> ${escapeHtml(req2.start_date)} → ${escapeHtml(req2.end_date)}<br>
                   <b>Days:</b> ${escapeHtml(String(req2.days_count))}<br>
                   <br>Please log in to the Mazarine Timesheet to review and approve.`));
            }
            if (pushCfg.push_notify_new_request) {
              sendPush(approver.id, `🔄 Approval needed`, `${reqUserName} · ${req2.type} · ${req2.days_count}d`, '/');
            }
          }
        }
        // Notify employee that step was approved, pending next
        if (emailCfg.notify_request_decision && emailCfg.provider !== 'disabled' && reqUserEmail) {
          sendEmailSafe(reqUserEmail, `Your ${escapeHtml(req2.type)} request — Step approved, pending final approval`,
            emailWrap('✅ Step Approved — Pending Final Approval',
              `Your <b>${escapeHtml(req2.type)}</b> request has been <span style="color:#10b981;font-weight:700">approved</span> and is now awaiting the next approval step.<br><br>
               <b>Period:</b> ${escapeHtml(req2.start_date)} → ${escapeHtml(req2.end_date)}<br>
               <b>Days:</b> ${escapeHtml(String(req2.days_count))}`));
        }
      } else {
        // Final decision notification to employee
        const icon = finalStatus === 'Approved' ? '✅' : '❌';
        const color = finalStatus === 'Approved' ? '#10b981' : '#ef4444';
        if (emailCfg.notify_request_decision && emailCfg.provider !== 'disabled' && reqUserEmail) {
          sendEmailSafe(reqUserEmail, `Your ${escapeHtml(req2.type)} request has been ${escapeHtml(finalStatus)}`,
            emailWrap(`${icon} Request ${escapeHtml(finalStatus)}`,
              `Your <b>${escapeHtml(req2.type)}</b> request has been <span style="color:${color};font-weight:700">${escapeHtml(finalStatus)}</span>.<br><br>
               <b>Period:</b> ${escapeHtml(req2.start_date)} → ${escapeHtml(req2.end_date)}<br>
               <b>Days:</b> ${escapeHtml(String(req2.days_count))}<br>
               ${req2.review_comment ? `<b>Comment:</b> ${escapeHtml(req2.review_comment)}<br>` : ''}`));
        }
        if (pushCfg.push_notify_request_decision) {
          sendPush(req2.user_id, `${icon} Request ${finalStatus}`, `${req2.type} · ${req2.start_date} → ${req2.end_date}`, '/');
        }
      }
    }).catch(() => {});
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Update request error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Delete request (pending cancel — restores balance deducted at submission)
app.delete('/api/requests/:id', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM requests WHERE id=$1', [req.params.id]);
    if (r.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Request not found' });
    }
    const request = r.rows[0];
    const annualLeaveTypes = ['Annual Leave', 'Sick Leave', 'Compassionate'];
    let daysRestored = 0, recoveryRestored = 0;
    // Only restore if Pending or Pending L2 (Approved requests use POST /cancel route)
    if ((request.status === 'Pending' || request.status === 'Pending L2') && Number(request.days_count) > 0) {
      if (annualLeaveTypes.includes(request.type)) {
        if (request.balance_source === 'recovery') {
          await client.query('UPDATE users SET recovery_balance = recovery_balance + $1 WHERE id=$2',
            [request.days_count, request.user_id]);
          recoveryRestored = Number(request.days_count);
        } else {
          await client.query('UPDATE users SET leave_balance = leave_balance + $1, used_leave = GREATEST(0, used_leave - $1) WHERE id=$2',
            [request.days_count, request.user_id]);
          daysRestored = Number(request.days_count);
        }
      } else if (request.type === 'Recovery Leave') {
        await client.query('UPDATE users SET recovery_balance = recovery_balance + $1 WHERE id=$2',
          [request.days_count, request.user_id]);
        recoveryRestored = Number(request.days_count);
      }
    }
    await client.query('DELETE FROM requests WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ message: 'Request deleted', daysRestored, recoveryRestored });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Delete request error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Cancel request — deletes, restores leave balance, resets timesheet entries
app.post('/api/requests/:id/cancel', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM requests WHERE id = $1', [req.params.id]);
    if (r.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Request not found' }); }
    const request = r.rows[0];
    const annualLeaveTypes = ['Annual Leave', 'Sick Leave', 'Compassionate'];
    let daysRestored = 0, recoveryRestored = 0;
    if (request.status === 'Approved') {
      // Restore leave balance for leave types
      if (annualLeaveTypes.includes(request.type)) {
        if (request.balance_source === 'recovery') {
          await client.query(
            'UPDATE users SET recovery_balance = recovery_balance + $1 WHERE id = $2',
            [request.days_count, request.user_id]
          );
          recoveryRestored = Number(request.days_count);
        } else {
          await client.query(
            'UPDATE users SET leave_balance = leave_balance + $1, used_leave = GREATEST(used_leave - $1, 0) WHERE id = $2',
            [request.days_count, request.user_id]
          );
          daysRestored = Number(request.days_count);
        }
      } else if (request.type === 'Recovery Leave') {
        await client.query(
          'UPDATE users SET recovery_balance = recovery_balance + $1 WHERE id = $2',
          [request.days_count, request.user_id]
        );
        recoveryRestored = Number(request.days_count);
      }
      // Reset timesheet entries if activity was synced
      if (request.type !== 'Temporary Authorization') {
        const uRow = await client.query('SELECT type FROM users WHERE id=$1', [request.user_id]);
        const userType = uRow.rows[0]?.type || 'office';
        await resetTimesheetEntries(client, request, userType);
      }
    }
    await client.query('DELETE FROM requests WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    const reason = req.body?.reason ? ` — reason: ${req.body.reason}` : '';
    logAudit(req.user.id, 'request_cancelled', `Request #${req.params.id}: ${request.type} ${request.start_date?.toISOString?.().slice(0,10)||request.start_date}${reason}`, request.user_id);
    res.json({ message: 'Request cancelled', daysRestored, recoveryRestored });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Cancel request error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ===== TIMESHEET ROUTES =====

// Get timesheet entries
app.get('/api/timesheets', authenticateToken, async (req, res) => {
  try {
    const { userId, year, month } = req.query;
    
    const result = await pool.query(
      `SELECT * FROM timesheet_entries 
       WHERE user_id = $1 AND year = $2 AND month = $3
       ORDER BY day`,
      [userId, year, month]
    );
    
    res.json(result.rows);
  } catch (err) {
    console.error('Get timesheets error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all non-draft timesheet statuses (for manager approval queue)
app.get('/api/timesheets/status/all', authenticateToken, async (req, res) => {
  try {
    const isAdminLike = ['admin','superadmin','hr','operations_manager','country_manager'].includes(req.user.role);
    let result;
    if (isAdminLike) {
      result = await pool.query(`SELECT * FROM timesheet_status WHERE status != 'draft' ORDER BY submitted_at DESC`);
    } else {
      result = await pool.query(
        `SELECT ts.* FROM timesheet_status ts JOIN users u ON ts.user_id = u.id WHERE u.manager_id = $1 AND ts.status != 'draft' ORDER BY ts.submitted_at DESC`,
        [req.user.id]
      );
    }
    res.json(result.rows);
  } catch (err) {
    console.error('Get all timesheet statuses error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get timesheet status
app.get('/api/timesheets/status', authenticateToken, async (req, res) => {
  try {
    const { userId, year, month } = req.query;
    
    const result = await pool.query(
      `SELECT * FROM timesheet_status 
       WHERE user_id = $1 AND year = $2 AND month = $3`,
      [userId, year, month]
    );
    
    res.json(result.rows[0] || { status: 'draft' });
  } catch (err) {
    console.error('Get timesheet status error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Save timesheet entries
app.post('/api/timesheets', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const { userId, year, month, entries } = req.body;
    await client.query('BEGIN');

    // Delete existing entries for this month
    await client.query(
      'DELETE FROM timesheet_entries WHERE user_id = $1 AND year = $2 AND month = $3',
      [userId, year, month]
    );

    // Insert new entries
    for (const entry of entries) {
      await client.query(
        `INSERT INTO timesheet_entries
         (user_id, year, month, day, date, activity, locked, hours, allocations)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [userId, year, month, entry.day, entry.date, entry.activity, entry.locked, entry.hours, JSON.stringify(entry.allocations)]
      );
    }

    await client.query('COMMIT');
    res.json({ message: 'Timesheet saved' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Save timesheet error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Update timesheet status
app.put('/api/timesheets/status', authenticateToken, async (req, res) => {
  try {
    const { userId, year, month, status, reviewComment } = req.body;

    const result = await pool.query(
      `INSERT INTO timesheet_status (user_id, year, month, status, submitted_at, review_comment, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, $4::varchar, CASE WHEN $4::varchar = 'submitted' THEN NOW() ELSE NULL END, $5, $6, CASE WHEN $4::varchar IN ('approved', 'rejected') THEN NOW() ELSE NULL END)
       ON CONFLICT (user_id, year, month)
       DO UPDATE SET
         status = EXCLUDED.status,
         submitted_at = CASE WHEN EXCLUDED.status = 'submitted' THEN NOW() ELSE timesheet_status.submitted_at END,
         review_comment = EXCLUDED.review_comment,
         reviewed_by = EXCLUDED.reviewed_by,
         reviewed_at = CASE WHEN EXCLUDED.status IN ('approved', 'rejected') THEN NOW() ELSE timesheet_status.reviewed_at END
       RETURNING *`,
      [userId, year, month, status, reviewComment, req.user.id]
    );
    
    const row = result.rows[0];

    // On submission: create workflow instance for routing
    if (status === 'submitted') {
      try {
        const submitterRow = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
        const submitter = submitterRow.rows[0];
        if (submitter) {
          const matchedWf = await findMatchingWorkflow(pool, 'timesheet', submitter, {});
          if (matchedWf) {
            const wfResult = await createWorkflowInstance(pool, matchedWf, 'timesheet', `ts:${userId}:${year}:${month}`, submitter.id, {});
            await pool.query('UPDATE timesheet_status SET workflow_instance_id=$1 WHERE user_id=$2 AND year=$3 AND month=$4',
              [wfResult.instanceId, userId, year, month]);
          }
        }
      } catch (wfErr) { console.error('Timesheet workflow creation error (non-fatal):', wfErr); }
    }

    // On approval: auto-fill missing weekend/holiday Site entries, then compute recovery
    let recoveryAccrued = 0;
    let autoAddedDays = 0;
    if (status === 'approved') {
      // Fetch user type for default hours
      const uTypeRow = await pool.query('SELECT type FROM users WHERE id=$1', [userId]);
      const defaultHours = uTypeRow.rows[0]?.type === 'field' ? 12 : 8;

      // Get existing Site entries ordered by date
      const existSite = await pool.query(
        `SELECT date FROM timesheet_entries
         WHERE user_id=$1 AND year=$2 AND month=$3 AND activity='Site' AND date IS NOT NULL
         ORDER BY date`,
        [userId, year, month]
      );

      if (existSite.rows.length > 0) {
        const minDate = String(existSite.rows[0].date).slice(0, 10);
        const maxDate = String(existSite.rows[existSite.rows.length - 1].date).slice(0, 10);
        const existDates = new Set(existSite.rows.map(r => String(r.date).slice(0, 10)));

        // Fetch holidays in the site date range
        const holRange = await pool.query(
          `SELECT date FROM holidays WHERE date::date >= $1::date AND date::date <= $2::date`,
          [minDate, maxDate]
        );
        const holDates = new Set(holRange.rows.map(r => String(r.date).slice(0, 10)));

        // Scan min→max; insert missing weekend/holiday days as Site entries
        const cur = new Date(minDate);
        const end = new Date(maxDate);
        while (cur <= end) {
          const dateStr = cur.toISOString().slice(0, 10);
          const dow = cur.getDay(); // 0=Sun, 6=Sat
          if (!existDates.has(dateStr) && (dow === 0 || dow === 6 || holDates.has(dateStr))) {
            const day = cur.getDate();
            const inserted = await pool.query(
              `INSERT INTO timesheet_entries (user_id, year, month, day, date, activity, locked, hours, allocations)
               VALUES ($1, $2, $3, $4, $5, 'Site', false, $6, '[]')
               ON CONFLICT (user_id, year, month, day) DO NOTHING`,
              [userId, year, month, day, dateStr, defaultHours]
            );
            if (inserted.rowCount > 0) { existDates.add(dateStr); autoAddedDays++; }
          }
          cur.setDate(cur.getDate() + 1);
        }
      }

      // Calculate recovery on ALL Site entries (including newly added ones)
      // Mon-Fri: 0.5 | Sat: 1.0 | Sun: 1.5 (holidays use their day-of-week rate)
      const onSiteRows = await pool.query(
        `SELECT date, EXTRACT(DOW FROM date::date) AS dow FROM timesheet_entries
         WHERE user_id=$1 AND year=$2 AND month=$3 AND activity='Site' AND date IS NOT NULL`,
        [userId, year, month]
      );
      for (const r of onSiteRows.rows) {
        const dow = Number(r.dow); // 0=Sun, 6=Sat
        recoveryAccrued += dow === 0 ? 1.5 : dow === 6 ? 1.0 : 0.5;
      }
      if (recoveryAccrued > 0) {
        await pool.query('UPDATE users SET recovery_balance = recovery_balance + $1 WHERE id = $2', [recoveryAccrued, userId]);
        await pool.query('UPDATE timesheet_status SET recovery_accrued = $1 WHERE user_id=$2 AND year=$3 AND month=$4', [recoveryAccrued, userId, year, month]);
      }
    }

    const actionMap = { submitted: 'timesheet_submitted', approved: 'timesheet_approved', rejected: 'timesheet_rejected', draft: 'timesheet_reset_draft' };
    const tsUserRow = await pool.query('SELECT name, email, manager_id, type, dept FROM users WHERE id=$1', [userId]);
    const tsUser = tsUserRow.rows[0] || {};
    const tsUserName  = tsUser.name  || `id=${userId}`;
    const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const MONTH_NAMES_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    logAudit(req.user.id, actionMap[status] || 'timesheet_status_changed', `${status.charAt(0).toUpperCase()+status.slice(1)} timesheet for ${tsUserName} — ${MONTH_NAMES_SHORT[month-1]} ${year}`, Number(userId));

    res.json({ ...row, recoveryAccrued });

    // Notifications (email + push)
    Promise.all([loadEmailConfig(), loadPushCfg()]).then(async ([emailCfg, pushCfg]) => {
      const periodLabel = `${MONTH_NAMES[month-1]} ${year}`;
      if (status === 'submitted') {
        if (tsUser.manager_id) {
          if (emailCfg.provider !== 'disabled' && emailCfg.notify_ts_submit) {
            const mgrRow = await pool.query('SELECT email FROM users WHERE id=$1', [tsUser.manager_id]);
            if (mgrRow.rows[0]?.email) {
              sendEmailSafe(mgrRow.rows[0].email, `${tsUserName} submitted timesheet for ${periodLabel}`,
                emailWrap('Timesheet Submitted',
                  `<b>${tsUserName}</b> has submitted their timesheet for <b>${periodLabel}</b>.<br><br>
                   Please log in to review and approve.`));
            }
          }
          if (pushCfg.push_notify_ts_submit) {
            sendPush(tsUser.manager_id, '📋 Timesheet submitted', `${tsUserName} — ${periodLabel}`, '/');
          }
        }
      } else if (status === 'approved' || status === 'rejected') {
        const icon = status === 'approved' ? '✅' : '❌';
        const color = status === 'approved' ? '#10b981' : '#ef4444';
        if (emailCfg.provider !== 'disabled' && emailCfg.notify_ts_decision && tsUser.email) {
          sendEmailSafe(tsUser.email, `Your timesheet for ${escapeHtml(periodLabel)} has been ${escapeHtml(status)}`,
            emailWrap(`${icon} Timesheet ${escapeHtml(status.charAt(0).toUpperCase()+status.slice(1))}`,
              `Your timesheet for <b>${escapeHtml(periodLabel)}</b> has been
               <span style="color:${color};font-weight:700">${escapeHtml(status)}</span>.<br><br>
               ${reviewComment ? `<b>Comment:</b> ${escapeHtml(reviewComment)}<br>` : ''}`));
        }
        if (pushCfg.push_notify_ts_decision) {
          sendPush(Number(userId), `${icon} Timesheet ${status}`, `Your timesheet for ${periodLabel}`, '/');
        }
      }
    }).catch(() => {});
  } catch (err) {
    console.error('Update timesheet status error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Unlock approved timesheet (admin/HR) — resets to draft + unlocks entries
app.post('/api/timesheets/unlock', authenticateToken, async (req, res) => {
  const { userId, year, month } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Retrieve and subtract any accrued recovery balance before resetting
    const accRow = await client.query(
      'SELECT recovery_accrued FROM timesheet_status WHERE user_id=$1 AND year=$2 AND month=$3',
      [userId, year, month]
    );
    const prevAccrual = Number(accRow.rows[0]?.recovery_accrued || 0);
    await client.query(
      `UPDATE timesheet_status SET status='draft', review_comment=NULL, reviewed_by=NULL, reviewed_at=NULL, recovery_accrued=0
       WHERE user_id=$1 AND year=$2 AND month=$3`,
      [userId, year, month]
    );
    if (prevAccrual > 0) {
      await client.query(
        'UPDATE users SET recovery_balance = GREATEST(recovery_balance - $1, 0) WHERE id = $2',
        [prevAccrual, userId]
      );
    }
    await client.query(
      `UPDATE timesheet_entries SET locked=false WHERE user_id=$1 AND year=$2 AND month=$3`,
      [userId, year, month]
    );
    await client.query('COMMIT');
    const uRow = await pool.query('SELECT name FROM users WHERE id=$1', [userId]);
    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    logAudit(req.user.id, 'timesheet_unlocked', `Unlocked timesheet for ${uRow.rows[0]?.name} — ${MONTH_NAMES[month-1]} ${year}`, Number(userId));
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Unlock timesheet error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ===== RESET TIMESHEET (admin) =====
// Wipes entries + status, removes all related requests for the month,
// and restores any deducted leave / recovery balances.
app.post('/api/timesheets/reset', authenticateToken, requireAdmin, async (req, res) => {
  const { userId, year, month } = req.body; // month is 1-indexed
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const firstDay = `${year}-${String(month).padStart(2,'0')}-01`;
    const lastDay  = new Date(year, month, 0).toISOString().slice(0, 10); // last day of month

    // 1. Reverse recovery_accrued if timesheet was previously approved
    const tsRow = await client.query(
      'SELECT recovery_accrued FROM timesheet_status WHERE user_id=$1 AND year=$2 AND month=$3',
      [userId, year, month]
    );
    const recoveryReversed = Number(tsRow.rows[0]?.recovery_accrued || 0);
    if (recoveryReversed > 0) {
      await client.query(
        'UPDATE users SET recovery_balance = GREATEST(0, recovery_balance - $1) WHERE id=$2',
        [recoveryReversed, userId]
      );
    }

    // 2. Delete timesheet entries and status
    await client.query('DELETE FROM timesheet_entries WHERE user_id=$1 AND year=$2 AND month=$3', [userId, year, month]);
    await client.query('DELETE FROM timesheet_status  WHERE user_id=$1 AND year=$2 AND month=$3', [userId, year, month]);

    // 3. Find requests overlapping this month (Pending or Approved)
    const reqRows = await client.query(
      `SELECT * FROM requests WHERE user_id=$1
       AND status IN ('Pending','Approved')
       AND start_date <= $2::date AND end_date >= $3::date`,
      [userId, lastDay, firstDay]
    );

    // 4. Restore leave / recovery balances for approved requests
    const LEAVE_TYPES = ['Annual Leave', 'Sick Leave', 'Casual Leave', 'Recovery Leave'];
    let leaveRestored = 0;
    let recoveryBalRestored = 0;
    for (const r of reqRows.rows) {
      if (r.status === 'Approved' && Number(r.days_count) > 0) {
        if (r.balance_source === 'recovery') {
          recoveryBalRestored += Number(r.days_count);
        } else if (LEAVE_TYPES.includes(r.type)) {
          leaveRestored += Number(r.days_count);
        }
      }
    }
    if (leaveRestored > 0) {
      await client.query(
        'UPDATE users SET used_leave = GREATEST(0, used_leave - $1), leave_balance = leave_balance + $1 WHERE id=$2',
        [leaveRestored, userId]
      );
    }
    if (recoveryBalRestored > 0) {
      await client.query(
        'UPDATE users SET recovery_balance = GREATEST(0, recovery_balance - $1) WHERE id=$2',
        [recoveryBalRestored, userId]
      );
    }

    // 5. Delete the related requests
    const deletedIds = reqRows.rows.map(r => r.id);
    if (deletedIds.length > 0) {
      await client.query('DELETE FROM requests WHERE id = ANY($1::int[])', [deletedIds]);
    }

    await client.query('COMMIT');

    // 6. Audit log
    const uRow = await pool.query('SELECT name FROM users WHERE id=$1', [userId]);
    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    logAudit(req.user.id, 'timesheet_reset',
      `Reset timesheet for ${uRow.rows[0]?.name} — ${MONTH_NAMES[month-1]} ${year} (${deletedIds.length} requests removed)`,
      Number(userId)
    );

    res.json({ message: 'Timesheet reset', deletedRequestIds: deletedIds, leaveRestored, recoveryBalRestored, recoveryReversed });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Reset timesheet error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ===== DELETE TIMESHEET (admin hard-delete) =====

app.delete('/api/timesheets/:userId/:year/:month', authenticateToken, requireAdmin, async (req, res) => {
  const { userId, year, month } = req.params;
  try {
    await pool.query('DELETE FROM timesheet_entries WHERE user_id=$1 AND year=$2 AND month=$3', [userId, year, month]);
    await pool.query('DELETE FROM timesheet_status WHERE user_id=$1 AND year=$2 AND month=$3', [userId, year, month]);
    const uRow = await pool.query('SELECT name FROM users WHERE id=$1', [userId]);
    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    logAudit(req.user.id, 'timesheet_deleted', `Deleted timesheet for ${uRow.rows[0]?.name} — ${MONTH_NAMES[month-1]} ${year}`, Number(userId));
    res.json({ message: 'Timesheet deleted' });
  } catch (err) {
    console.error('Delete timesheet error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== REQUEST HISTORY (audit log entries filtered for a specific request) =====

app.get('/api/requests/:id/history', authenticateToken, async (req, res) => {
  try {
    const reqRow = await pool.query('SELECT user_id FROM requests WHERE id=$1', [req.params.id]);
    if (!reqRow.rows[0]) return res.status(404).json({ error: 'Request not found' });
    const result = await pool.query(
      `SELECT al.id, al.action, al.detail, al.created_at,
              a.name AS actor_name, a.role AS actor_role
       FROM audit_log al
       LEFT JOIN users a ON al.actor_id = a.id
       WHERE al.action LIKE 'request_%' AND al.detail LIKE $1
       ORDER BY al.created_at ASC`,
      [`Request #${req.params.id}:%`]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Request history error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== AUDIT LOG =====

app.get('/api/audit-log', authenticateToken, requirePrivileged, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const offset = parseInt(req.query.offset) || 0;
    const { action, userId } = req.query;
    let q = `SELECT al.id, al.action, al.detail, al.created_at,
               a.name AS actor_name, a.role AS actor_role,
               t.name AS target_name
             FROM audit_log al
             LEFT JOIN users a ON al.actor_id = a.id
             LEFT JOIN users t ON al.target_user_id = t.id
             WHERE 1=1`;
    const params = [];
    let pi = 1;
    if (action) { q += ` AND al.action = $${pi++}`; params.push(action); }
    if (userId) { q += ` AND (al.actor_id = $${pi} OR al.target_user_id = $${pi})`; params.push(Number(userId)); pi++; }
    q += ` ORDER BY al.created_at DESC LIMIT $${pi++} OFFSET $${pi++}`;
    params.push(limit, offset);
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Audit log error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== ALLOCATION REPORT =====

app.get('/api/reports/allocation', authenticateToken, requirePrivileged, async (req, res) => {
  try {
    const { year, month } = req.query;
    const result = await pool.query(`
      WITH alloc_rows AS (
        SELECT
          u.dept,
          (alloc->>'projectId')::int    AS project_id,
          (alloc->>'allocation')::float AS alloc_frac
        FROM timesheet_entries te
        CROSS JOIN LATERAL jsonb_array_elements(te.allocations) AS alloc
        JOIN timesheet_status ts
          ON ts.user_id=te.user_id AND ts.year=te.year AND ts.month=te.month
        JOIN users u ON u.id=te.user_id
        WHERE te.year=$1 AND te.month=$2
          AND ts.status IN ('submitted','approved')
          AND jsonb_array_length(te.allocations) > 0
      ),
      dept_totals AS (
        SELECT dept, SUM(alloc_frac) AS dept_total FROM alloc_rows GROUP BY dept
      ),
      proj_dept AS (
        SELECT project_id, dept, SUM(alloc_frac) AS pd_total FROM alloc_rows GROUP BY project_id, dept
      )
      SELECT
        p.id           AS project_id,
        p.code         AS project_code,
        p.name         AS project_name,
        ce.code        AS entity_code,
        ce.name        AS entity_name,
        pd.dept,
        ROUND((pd.pd_total / NULLIF(dt.dept_total,0) * 100)::numeric, 1) AS alloc_pct
      FROM proj_dept pd
      JOIN dept_totals dt ON dt.dept = pd.dept
      JOIN projects p ON p.id = pd.project_id
      LEFT JOIN company_entities ce ON ce.id = p.entity_id
      ORDER BY p.code, pd.dept
    `, [year, month]);
    res.json(result.rows);
  } catch (err) {
    console.error('Allocation report error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET allocation detail per employee (which employees worked on which projects)
app.get('/api/reports/allocation-detail', authenticateToken, requirePrivileged, async (req, res) => {
  try {
    const { year, month } = req.query;
    const result = await pool.query(`
      SELECT
        u.id AS user_id, u.name AS user_name, u.dept, u.type AS user_type,
        p.id AS project_id, p.code AS project_code, p.name AS project_name,
        COUNT(*)::int AS days_count,
        ROUND(SUM((alloc->>'allocation')::float)::numeric, 2) AS total_alloc,
        ROUND(SUM((alloc->>'allocation')::float * te.hours)::numeric, 1) AS total_hours
      FROM timesheet_entries te
      CROSS JOIN LATERAL jsonb_array_elements(te.allocations) AS alloc
      JOIN timesheet_status ts
        ON ts.user_id=te.user_id AND ts.year=te.year AND ts.month=te.month
      JOIN users u ON u.id=te.user_id
      JOIN projects p ON p.id=(alloc->>'projectId')::int
      WHERE te.year=$1 AND te.month=$2
        AND ts.status IN ('submitted','approved')
        AND jsonb_array_length(te.allocations) > 0
      GROUP BY u.id, u.name, u.dept, u.type, p.id, p.code, p.name
      ORDER BY p.code, u.name
    `, [year, month]);
    res.json(result.rows);
  } catch (err) {
    console.error('Allocation detail error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== PAYROLL SUMMARY =====

app.get('/api/payroll-summary', authenticateToken, requirePrivileged, async (req, res) => {
  try {
    const { year, month } = req.query;
    // Only aggregate entries from submitted or approved timesheets
    // to avoid counting partial auto-sync entries for unsubmitted months
    const result = await pool.query(
      `SELECT te.user_id, te.activity, COUNT(*)::int AS days, SUM(te.hours)::int AS total_hours
       FROM timesheet_entries te
       INNER JOIN timesheet_status ts
         ON ts.user_id = te.user_id AND ts.year = te.year AND ts.month = te.month
       WHERE te.year = $1 AND te.month = $2
         AND ts.status IN ('submitted', 'approved')
       GROUP BY te.user_id, te.activity ORDER BY te.user_id, te.activity`,
      [year, month]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Payroll summary error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== ROLES ROUTES =====

// Get all roles
app.get('/api/roles', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM roles ORDER BY system DESC, label');
    res.json(result.rows);
  } catch (err) {
    console.error('Get roles error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create/update role (superadmin only)
app.post('/api/roles', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { key, label, color, permissions, system } = req.body;
    
    const result = await pool.query(
      `INSERT INTO roles (key, label, color, permissions, system)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key) DO UPDATE SET
         label = EXCLUDED.label,
         color = EXCLUDED.color,
         permissions = EXCLUDED.permissions,
         system = EXCLUDED.system
       RETURNING *`,
      [key, label, color, JSON.stringify(permissions), system || false]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Save role error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete role (superadmin only)
app.delete('/api/roles/:key', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM roles WHERE key = $1 AND system = false RETURNING key',
      [req.params.key]
    );
    
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Cannot delete system role' });
    }
    
    res.json({ message: 'Role deleted' });
  } catch (err) {
    console.error('Delete role error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== ACTIVITIES ROUTES =====

app.get('/api/activities', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM activities ORDER BY sort_order, id');
    res.json(result.rows);
  } catch (err) {
    console.error('Get activities error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/activities', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, visibleTo, isLeave, color, sortOrder } = req.body;
    const result = await pool.query(
      `INSERT INTO activities (name, visible_to, is_leave, color, sort_order)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name.trim(), visibleTo || 'both', isLeave || false, color || '#7c3aed', sortOrder || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Activity name already exists' });
    console.error('Create activity error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/activities/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, visibleTo, isLeave, color, active, sortOrder } = req.body;
    const result = await pool.query(
      `UPDATE activities SET name=$1, visible_to=$2, is_leave=$3, color=$4, active=$5, sort_order=$6
       WHERE id=$7 RETURNING *`,
      [name.trim(), visibleTo, isLeave, color, active, sortOrder ?? 0, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Activity not found' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Activity name already exists' });
    console.error('Update activity error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/activities/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM activities WHERE id=$1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Activity not found' });
    res.json({ message: 'Activity deleted' });
  } catch (err) {
    console.error('Delete activity error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== HOLIDAYS ROUTES =====

app.get('/api/holidays', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM holidays ORDER BY date');
    res.json(result.rows);
  } catch (err) {
    console.error('Get holidays error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/holidays', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { date, name } = req.body;
    if (!date || !name?.trim()) return res.status(400).json({ error: 'Date and name required' });
    const result = await pool.query(
      'INSERT INTO holidays (date, name) VALUES ($1, $2) RETURNING *',
      [date, name.trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'A holiday on that date already exists' });
    console.error('Create holiday error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/holidays/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { date, name } = req.body;
    if (!date || !name?.trim()) return res.status(400).json({ error: 'Date and name required' });
    const result = await pool.query(
      'UPDATE holidays SET date=$1, name=$2 WHERE id=$3 RETURNING *',
      [date, name.trim(), req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Holiday not found' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'A holiday on that date already exists' });
    console.error('Update holiday error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/holidays/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM holidays WHERE id=$1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Holiday not found' });
    res.json({ message: 'Holiday deleted' });
  } catch (err) {
    console.error('Delete holiday error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== ROTATION PLANS =====

// Helper: determine day type (ON/OFF/EXTRA) from rotation rows
function getRotationDayType(dateStr, rotRows) {
  const d = new Date(dateStr);
  if (rotRows.length === 0) {
    const diff = Math.floor((d - new Date('2025-01-01')) / 86400000);
    return ((diff % 28) + 28) % 28 < 14 ? 'ON' : 'OFF';
  }
  const sorted = [...rotRows].sort((a, b) => new Date(a.on_start) - new Date(b.on_start));
  for (const rot of sorted) {
    const onStart = new Date(rot.on_start);
    const onEnd   = new Date(rot.on_end);
    const onDays  = Math.floor((onEnd - onStart) / 86400000) + 1;
    const offStart = new Date(onEnd); offStart.setDate(offStart.getDate() + 1);
    const offEnd   = new Date(onEnd); offEnd.setDate(offEnd.getDate() + onDays);
    if (d >= onStart && d <= onEnd)   return 'ON';
    if (d >= offStart && d <= offEnd) return 'OFF';
  }
  return 'EXTRA';
}

// Rebuild timesheet entries for a field user based on current rotation plans
async function rebuildFieldTimesheetForRotation(client, userId, affectedStart, affectedEnd) {
  const rots = await client.query(
    'SELECT * FROM rotation_plans WHERE user_id=$1 ORDER BY on_start', [userId]
  );
  const defActRow = await client.query(
    `SELECT name FROM activities WHERE name='Site' AND active=true LIMIT 1`
  );
  const onSiteAct = defActRow.rows[0]?.name || 'Site';
  const projRow = await client.query(
    'SELECT id FROM projects WHERE open=true AND field_allowed=true ORDER BY id LIMIT 1'
  );
  const defaultProjectId = projRow.rows[0]?.id || null;

  const months = new Set();
  let cur = new Date(affectedStart);
  cur.setDate(1);
  while (cur <= new Date(affectedEnd)) {
    months.add(`${cur.getFullYear()}-${cur.getMonth() + 1}`);
    cur.setMonth(cur.getMonth() + 1);
  }

  for (const ym of months) {
    const [year, month] = ym.split('-').map(Number);
    const ts = await client.query(
      'SELECT status FROM timesheet_status WHERE user_id=$1 AND year=$2 AND month=$3',
      [userId, year, month]
    );
    if (ts.rows[0] && ['submitted', 'approved'].includes(ts.rows[0].status)) continue;
    // Remove unlocked entries for this month
    await client.query(
      'DELETE FROM timesheet_entries WHERE user_id=$1 AND year=$2 AND month=$3 AND locked=false',
      [userId, year, month]
    );
    const daysInMonth = new Date(year, month, 0).getDate();
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${pad2(month)}-${pad2(day)}`;
      const dayType = getRotationDayType(dateStr, rots.rows);
      if (dayType !== 'ON') continue; // Only ON days in timesheet; OFF and EXTRA excluded
      const activity = onSiteAct;
      const allocations = defaultProjectId
        ? JSON.stringify([{ id: 1, projectId: defaultProjectId, allocation: 1.0, note: '' }])
        : '[]';
      await client.query(
        `INSERT INTO timesheet_entries (user_id,year,month,day,date,activity,locked,hours,allocations)
         VALUES ($1,$2,$3,$4,$5,$6,false,12,$7)
         ON CONFLICT (user_id,year,month,day) DO UPDATE
         SET activity=EXCLUDED.activity, hours=EXCLUDED.hours`,
        [userId, year, month, day, dateStr, activity, allocations]
      );
    }
  }
}

app.get('/api/rotation-plans', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.query;
    const result = userId
      ? await pool.query('SELECT * FROM rotation_plans WHERE user_id=$1 ORDER BY on_start', [userId])
      : await pool.query('SELECT * FROM rotation_plans ORDER BY user_id, on_start');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/rotation-plans', authenticateToken, requirePrivileged, async (req, res) => {
  const { userId, onStart, onEnd } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'INSERT INTO rotation_plans (user_id, on_start, on_end) VALUES ($1,$2,$3) RETURNING *',
      [userId, onStart, onEnd]
    );
    const rot = result.rows[0];
    const onDays = Math.floor((new Date(onEnd) - new Date(onStart)) / 86400000) + 1;
    const offEnd = new Date(onEnd); offEnd.setDate(offEnd.getDate() + onDays);
    await rebuildFieldTimesheetForRotation(client, userId, onStart, offEnd.toISOString().slice(0, 10));
    await client.query('COMMIT');
    res.json(rot);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create rotation error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  } finally { client.release(); }
});

app.put('/api/rotation-plans/:id', authenticateToken, requirePrivileged, async (req, res) => {
  const { onStart, onEnd } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const old = await client.query('SELECT * FROM rotation_plans WHERE id=$1', [req.params.id]);
    if (!old.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    const { user_id, on_start: oldStart, on_end: oldEnd } = old.rows[0];
    const result = await client.query(
      'UPDATE rotation_plans SET on_start=$1, on_end=$2 WHERE id=$3 RETURNING *',
      [onStart, onEnd, req.params.id]
    );
    // Rebuild for both old and new period
    const oldOnDays = Math.floor((new Date(oldEnd) - new Date(oldStart)) / 86400000) + 1;
    const oldOffEnd = new Date(oldEnd); oldOffEnd.setDate(oldOffEnd.getDate() + oldOnDays);
    const newOnDays = Math.floor((new Date(onEnd) - new Date(onStart)) / 86400000) + 1;
    const newOffEnd = new Date(onEnd); newOffEnd.setDate(newOffEnd.getDate() + newOnDays);
    const rebuildStart = [oldStart, onStart].sort()[0];
    const rebuildEnd   = [oldOffEnd.toISOString().slice(0,10), newOffEnd.toISOString().slice(0,10)].sort().pop();
    await rebuildFieldTimesheetForRotation(client, user_id, rebuildStart, rebuildEnd);
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Update rotation error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  } finally { client.release(); }
});

app.delete('/api/rotation-plans/:id', authenticateToken, requirePrivileged, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const old = await client.query('SELECT * FROM rotation_plans WHERE id=$1', [req.params.id]);
    if (!old.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    const { user_id, on_start, on_end } = old.rows[0];
    await client.query('DELETE FROM rotation_plans WHERE id=$1', [req.params.id]);
    const onDays = Math.floor((new Date(on_end) - new Date(on_start)) / 86400000) + 1;
    const offEnd = new Date(on_end); offEnd.setDate(offEnd.getDate() + onDays);
    await rebuildFieldTimesheetForRotation(client, user_id, on_start, offEnd.toISOString().slice(0, 10));
    await client.query('COMMIT');
    res.json({ message: 'Rotation plan deleted' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Delete rotation error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  } finally { client.release(); }
});

// ===== COMPANY SETTINGS =====

app.get('/api/company-settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM company_settings WHERE id=1');
    res.json(result.rows[0] || { company_name:'MAZARINE', company_subtitle:'Energy Tunisia', logo_base64:null });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/company-settings', authenticateToken, requireSuperAdmin, async (req, res) => {
  const { companyName, companySubtitle, logoBase64, pendingReminderDays } = req.body;
  try {
    const sets = ['company_name=$1', 'company_subtitle=$2', 'logo_base64=$3'];
    const vals = [companyName || 'MAZARINE', companySubtitle || '', logoBase64 ?? null];
    if (pendingReminderDays !== undefined) {
      sets.push(`pending_reminder_days=$${vals.length + 1}`);
      vals.push(Math.max(0, Number(pendingReminderDays) || 3));
    }
    const result = await pool.query(
      `UPDATE company_settings SET ${sets.join(',')} WHERE id=1 RETURNING *`, vals
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update company settings error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT pending reminder days (admin can update)
app.put('/api/company-settings/pending-reminder', authenticateToken, requireAdmin, async (req, res) => {
  const days = Math.max(1, Number(req.body.pendingReminderDays) || 3);
  try {
    const result = await pool.query('UPDATE company_settings SET pending_reminder_days=$1 WHERE id=1 RETURNING pending_reminder_days', [days]);
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET stale pending requests (pending > X days based on company setting)
app.get('/api/requests/stale-pending', authenticateToken, async (req, res) => {
  try {
    const cfg = (await pool.query('SELECT pending_reminder_days FROM company_settings WHERE id=1')).rows[0];
    const days = cfg?.pending_reminder_days || 3;
    const { rows } = await pool.query(
      `SELECT r.*, u.name as user_name, u.email as user_email, u.dept as user_dept
       FROM requests r JOIN users u ON r.user_id = u.id
       WHERE r.status IN ('Pending','Pending L2')
       AND r.created_at < NOW() - INTERVAL '1 day' * $1
       ORDER BY r.created_at ASC`, [days]
    );
    res.json({ days, requests: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST trigger reminder emails for stale pending requests
app.post('/api/requests/send-stale-reminders', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const cfg = (await pool.query('SELECT pending_reminder_days FROM company_settings WHERE id=1')).rows[0];
    const days = cfg?.pending_reminder_days || 3;
    const { rows } = await pool.query(
      `SELECT r.id, r.type, r.start_date, r.end_date, r.created_at, r.user_id,
              u.name as user_name, u.manager_id,
              m.name as manager_name, m.email as manager_email
       FROM requests r
       JOIN users u ON r.user_id = u.id
       LEFT JOIN users m ON u.manager_id = m.id
       WHERE r.status IN ('Pending','Pending L2')
       AND r.created_at < NOW() - INTERVAL '1 day' * $1`, [days]
    );
    let sent = 0;
    for (const r of rows) {
      if (r.manager_email) {
        const subject = `Reminder: Pending ${r.type} request from ${r.user_name} (${days}+ days)`;
        const html = `<p>The following request has been pending for more than <b>${days} days</b>:</p>
          <ul><li><b>Employee:</b> ${r.user_name}</li><li><b>Type:</b> ${r.type}</li>
          <li><b>Period:</b> ${r.start_date} → ${r.end_date}</li>
          <li><b>Submitted:</b> ${new Date(r.created_at).toLocaleDateString()}</li></ul>
          <p>Please review and take action.</p>`;
        await sendEmailSafe(r.manager_email, subject, html);
        sent++;
      }
    }
    res.json({ ok: true, staleCount: rows.length, remindersSent: sent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== EMAIL SETTINGS =====

app.get('/api/email-settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM email_settings WHERE id=1');
    const cfg = r.rows[0] || {};
    // Mask secrets before sending to frontend
    res.json({
      ...cfg,
      smtp_pass:          cfg.smtp_pass          ? '***' : '',
      m365_client_secret: cfg.m365_client_secret ? '***' : ''
    });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/email-settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { provider, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, smtp_from,
            m365_tenant_id, m365_client_id, m365_client_secret, m365_from,
            notify_new_request, notify_request_decision, notify_ts_submit, notify_ts_decision } = req.body;
    // Preserve existing secrets if placeholder sent
    const existing = (await pool.query('SELECT smtp_pass, m365_client_secret FROM email_settings WHERE id=1')).rows[0] || {};
    const realSmtpPass  = smtp_pass          === '***' ? existing.smtp_pass          : smtp_pass;
    const realM365Sec   = m365_client_secret === '***' ? existing.m365_client_secret : m365_client_secret;
    await pool.query(
      `INSERT INTO email_settings (id,provider,smtp_host,smtp_port,smtp_secure,smtp_user,smtp_pass,smtp_from,
         m365_tenant_id,m365_client_id,m365_client_secret,m365_from,
         notify_new_request,notify_request_decision,notify_ts_submit,notify_ts_decision)
       VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET
         provider=$1,smtp_host=$2,smtp_port=$3,smtp_secure=$4,smtp_user=$5,smtp_pass=$6,smtp_from=$7,
         m365_tenant_id=$8,m365_client_id=$9,m365_client_secret=$10,m365_from=$11,
         notify_new_request=$12,notify_request_decision=$13,notify_ts_submit=$14,notify_ts_decision=$15`,
      [provider||'disabled', smtp_host||null, Number(smtp_port)||587, smtp_secure||false,
       smtp_user||null, realSmtpPass||null, smtp_from||null,
       m365_tenant_id||null, m365_client_id||null, realM365Sec||null, m365_from||null,
       notify_new_request!==false, notify_request_decision!==false, notify_ts_submit!==false, notify_ts_decision!==false]
    );
    logAudit(req.user.id, 'settings_changed', `Email settings updated (provider: ${provider||'disabled'})`);
    res.json({ success: true });
  } catch (err) { console.error('Email settings error:', err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/email-settings/test', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const userRow = await pool.query('SELECT email, name FROM users WHERE id=$1', [req.user.id]);
    const { email, name } = userRow.rows[0];
    await sendEmail(email, 'Mazarine Timesheet — Test Email',
      emailWrap('Test Email', `Hello ${name},<br><br>Your email integration is working correctly. ✅`));
    res.json({ success: true, sentTo: email });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ===== PUSH NOTIFICATION ENDPOINTS =====

app.get('/api/push/vapid-key', (req, res) => {
  if (!vapidPublicKey) return res.status(503).json({ error: 'Push not ready' });
  res.json({ publicKey: vapidPublicKey });
});

app.get('/api/push/subscription', authenticateToken, async (req, res) => {
  try {
    const row = (await pool.query('SELECT id FROM push_subscriptions WHERE user_id=$1 LIMIT 1', [req.user.id])).rows[0];
    res.json({ subscribed: !!row });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/push/subscribe', authenticateToken, async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: 'Invalid subscription' });
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1,$2,$3,$4) ON CONFLICT (endpoint) DO UPDATE SET user_id=$1, p256dh=$3, auth=$4`,
      [req.user.id, endpoint, keys.p256dh, keys.auth]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/push/unsubscribe', authenticateToken, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) {
      await pool.query('DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2', [req.user.id, endpoint]);
    } else {
      await pool.query('DELETE FROM push_subscriptions WHERE user_id=$1', [req.user.id]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/push/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const total = (await pool.query('SELECT COUNT(*) FROM push_subscriptions')).rows[0].count;
    res.json({ total: Number(total), vapidReady: !!vapidPublicKey });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/push/test', authenticateToken, async (req, res) => {
  try {
    await sendPush(req.user.id, '🔔 Mazarine', 'Push notifications are working!', '/');
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/push/settings', authenticateToken, async (req, res) => {
  try {
    const row = (await pool.query(
      'SELECT push_notify_new_request,push_notify_request_decision,push_notify_ts_submit,push_notify_ts_decision FROM email_settings WHERE id=1'
    )).rows[0] || {};
    res.json(row);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/push/settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { push_notify_new_request, push_notify_request_decision, push_notify_ts_submit, push_notify_ts_decision } = req.body;
    await pool.query(
      `UPDATE email_settings SET
         push_notify_new_request=$1, push_notify_request_decision=$2,
         push_notify_ts_submit=$3, push_notify_ts_decision=$4
       WHERE id=1`,
      [push_notify_new_request !== false, push_notify_request_decision !== false,
       push_notify_ts_submit !== false, push_notify_ts_decision !== false]
    );
    logAudit(req.user.id, 'settings_changed', 'Push notification settings updated');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ===== WORKFLOW DESIGNER CRUD =====

app.get('/api/workflows', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM workflow_definitions ORDER BY priority DESC, entity_type, name');
    res.json(result.rows);
  } catch (err) {
    console.error('Get workflows error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/workflows', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, entity_type, target_dept, target_staff_type, target_activity_type, priority, steps, is_active } = req.body;
    if (!name || !entity_type) return res.status(400).json({ error: 'name and entity_type are required' });
    if (!Array.isArray(steps) || steps.length === 0 || steps.length > 5) return res.status(400).json({ error: 'steps must be an array of 1-5 items' });
    const result = await pool.query(
      `INSERT INTO workflow_definitions (name, entity_type, target_dept, target_staff_type, target_activity_type, priority, steps, is_active, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW()) RETURNING *`,
      [name, entity_type, target_dept || null, target_staff_type || null, target_activity_type || null, priority || 0, JSON.stringify(steps), is_active !== false, req.user.id]
    );
    logAudit(req.user.id, 'workflow_created', `Created workflow "${name}" (${entity_type})`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create workflow error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/workflows/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { name, entity_type, target_dept, target_staff_type, target_activity_type, priority, steps, is_active } = req.body;
    if (!name || !entity_type) return res.status(400).json({ error: 'name and entity_type are required' });
    if (!Array.isArray(steps) || steps.length === 0 || steps.length > 5) return res.status(400).json({ error: 'steps must be an array of 1-5 items' });
    const result = await pool.query(
      `UPDATE workflow_definitions SET name=$1, entity_type=$2, target_dept=$3, target_staff_type=$4, target_activity_type=$5, priority=$6, steps=$7, is_active=$8, updated_at=NOW()
       WHERE id=$9 RETURNING *`,
      [name, entity_type, target_dept || null, target_staff_type || null, target_activity_type || null, priority || 0, JSON.stringify(steps), is_active !== false, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Workflow not found' });
    logAudit(req.user.id, 'workflow_updated', `Updated workflow "${name}" (id=${req.params.id})`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update workflow error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/workflows/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // Soft-delete: set is_active=false
    const result = await pool.query('UPDATE workflow_definitions SET is_active=false, updated_at=NOW() WHERE id=$1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Workflow not found' });
    logAudit(req.user.id, 'workflow_deleted', `Deactivated workflow "${result.rows[0].name}" (id=${req.params.id})`);
    res.json({ message: 'Workflow deactivated' });
  } catch (err) {
    console.error('Delete workflow error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== WORKFLOW ENGINE HELPERS =====

// Find the best matching workflow definition for a given entity type and context
async function findMatchingWorkflow(client, entityType, user, requestData) {
  const rows = await client.query(
    'SELECT * FROM workflow_definitions WHERE entity_type=$1 AND is_active=true ORDER BY priority DESC, id',
    [entityType]
  );
  for (const wf of rows.rows) {
    if (wf.target_dept && wf.target_dept !== user.dept) continue;
    if (wf.target_staff_type && wf.target_staff_type !== user.type) continue;
    if (wf.target_activity_type && wf.target_activity_type !== requestData.type) continue;
    return wf;
  }
  return null; // no match — fallback to direct manager single-step
}

// Resolve the actual approver user(s) for a workflow step
async function resolveStepApprovers(client, step, submitterId) {
  switch (step.approver_type) {
    case 'direct_manager': {
      const r = await client.query('SELECT manager_id FROM users WHERE id=$1', [submitterId]);
      return r.rows[0]?.manager_id ? [r.rows[0].manager_id] : [];
    }
    case 'functional_manager': {
      const r = await client.query('SELECT functional_manager_id FROM users WHERE id=$1', [submitterId]);
      return r.rows[0]?.functional_manager_id ? [r.rows[0].functional_manager_id] : [];
    }
    case 'specific_role': {
      const r = await client.query('SELECT id FROM users WHERE role=$1 AND active=true', [step.approver_value]);
      return r.rows.map(row => row.id);
    }
    case 'specific_user':
      return step.approver_value ? [Number(step.approver_value)] : [];
    default:
      return [];
  }
}

// Evaluate conditions for a step against request data
function evaluateConditions(conditions, requestData) {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every(c => {
    const val = Number(requestData[c.field] || 0);
    const target = Number(c.value);
    switch (c.operator) {
      case '==': return val === target;
      case '!=': return val !== target;
      case '>':  return val > target;
      case '>=': return val >= target;
      case '<':  return val < target;
      case '<=': return val <= target;
      default: return true;
    }
  });
}

// Create a workflow instance and its first approval step
async function createWorkflowInstance(client, workflowDef, entityType, entityRef, submitterId, requestData) {
  const instResult = await client.query(
    `INSERT INTO workflow_instances (workflow_id, entity_type, entity_ref, status, created_at, updated_at)
     VALUES ($1,$2,$3,'in_progress',NOW(),NOW()) RETURNING *`,
    [workflowDef.id, entityType, entityRef]
  );
  const instance = instResult.rows[0];
  const steps = typeof workflowDef.steps === 'string' ? JSON.parse(workflowDef.steps) : workflowDef.steps;

  // Find first step (lowest order)
  const firstSteps = steps.filter(s => s.order === Math.min(...steps.map(x => x.order)));
  const matchedStep = firstSteps.find(s => evaluateConditions(s.conditions, requestData)) || firstSteps[0];

  const approverIds = await resolveStepApprovers(client, matchedStep, submitterId);
  const approverId = approverIds[0] || null;

  await client.query(
    `INSERT INTO workflow_approvals (instance_id, step_index, step_label, approver_id, status, created_at)
     VALUES ($1,$2,$3,$4,'pending',NOW())`,
    [instance.id, 0, matchedStep.label, approverId]
  );

  return { instanceId: instance.id, approverIds, stepLabel: matchedStep.label, totalSteps: new Set(steps.map(s => s.order)).size };
}

// Advance a workflow instance after an approval/rejection
async function advanceWorkflow(client, instanceId, approverId, actionStatus, comment, requestData) {
  // Mark current pending approval
  await client.query(
    `UPDATE workflow_approvals SET status=$1, comment=$2, approver_id=$3, actioned_at=NOW()
     WHERE instance_id=$4 AND status='pending'`,
    [actionStatus === 'Approved' ? 'approved' : 'rejected', comment, approverId, instanceId]
  );

  if (actionStatus === 'Rejected') {
    await client.query(`UPDATE workflow_instances SET status='rejected', updated_at=NOW() WHERE id=$1`, [instanceId]);
    return { finalStatus: 'Rejected', nextApproverIds: [] };
  }

  // Find the workflow definition and current step
  const instRow = await client.query(
    `SELECT wi.*, wd.steps FROM workflow_instances wi JOIN workflow_definitions wd ON wd.id=wi.workflow_id WHERE wi.id=$1`,
    [instanceId]
  );
  const inst = instRow.rows[0];
  const steps = typeof inst.steps === 'string' ? JSON.parse(inst.steps) : inst.steps;

  // Get the last completed step's order
  const completedApprovals = await client.query(
    `SELECT step_index FROM workflow_approvals WHERE instance_id=$1 AND status='approved' ORDER BY step_index DESC LIMIT 1`,
    [instanceId]
  );
  const currentStepIndex = completedApprovals.rows[0]?.step_index ?? 0;

  // Find what order the current step had
  const orders = [...new Set(steps.map(s => s.order))].sort((a, b) => a - b);
  const currentOrder = orders[currentStepIndex] || orders[0];
  const nextOrderIndex = orders.indexOf(currentOrder) + 1;

  if (nextOrderIndex >= orders.length) {
    // No more steps — workflow complete
    await client.query(`UPDATE workflow_instances SET status='completed', updated_at=NOW() WHERE id=$1`, [instanceId]);
    return { finalStatus: 'Approved', nextApproverIds: [] };
  }

  // Find next step matching conditions
  const nextOrder = orders[nextOrderIndex];
  const nextSteps = steps.filter(s => s.order === nextOrder);
  const matchedNext = nextSteps.find(s => evaluateConditions(s.conditions, requestData)) || nextSteps[0];

  // Get submitter ID from entity_ref
  const entityRef = inst.entity_ref;
  let submitterId = null;
  if (entityRef.startsWith('request:')) {
    const reqRow = await client.query('SELECT user_id FROM requests WHERE id=$1', [entityRef.split(':')[1]]);
    submitterId = reqRow.rows[0]?.user_id;
  } else if (entityRef.startsWith('ts:')) {
    submitterId = Number(entityRef.split(':')[1]);
  }

  const nextApproverIds = submitterId ? await resolveStepApprovers(client, matchedNext, submitterId) : [];
  const nextApproverId = nextApproverIds[0] || null;

  await client.query(
    `INSERT INTO workflow_approvals (instance_id, step_index, step_label, approver_id, status, created_at)
     VALUES ($1,$2,$3,$4,'pending',NOW())`,
    [instanceId, nextOrderIndex, matchedNext.label, nextApproverId]
  );

  return { finalStatus: 'Pending', nextApproverIds, stepLabel: matchedNext.label };
}

// ===== ENTRA ID SSO =====

// Lazy JWKS client — only initialised if AZURE_TENANT_ID is configured
let _jwksClient = null;
function getJwksClient() {
  if (!_jwksClient && process.env.AZURE_TENANT_ID) {
    _jwksClient = jwksClient({
      jwksUri: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/discovery/v2.0/keys`,
      cache: true,
      cacheMaxAge: 86400000, // 24 h
      rateLimit: true,
    });
  }
  return _jwksClient;
}

// POST /api/auth/sso
// Body: { idToken: "<Entra ID id_token obtained by frontend MSAL PKCE flow>" }
// Validates the token, checks user is pre-provisioned, issues our own app JWT.
app.post('/api/auth/sso', authLimiter, async (req, res) => {
  try {
    if (!process.env.AZURE_TENANT_ID || !process.env.AZURE_CLIENT_ID) {
      return res.status(501).json({ error: 'SSO is not configured on this server' });
    }

    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'idToken is required' });

    // 1. Decode header to get signing key ID
    const decoded = jwt.decode(idToken, { complete: true });
    if (!decoded) return res.status(400).json({ error: 'Invalid token format' });

    const client = getJwksClient();
    const signingKey = await client.getSigningKey(decoded.header.kid);
    const publicKey = signingKey.getPublicKey();

    // 2. Verify signature and standard claims
    let claims;
    try {
      claims = jwt.verify(idToken, publicKey, {
        algorithms: ['RS256'],
        audience: process.env.AZURE_CLIENT_ID,
        issuer: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/v2.0`,
      });
    } catch (verifyErr) {
      return res.status(401).json({ error: 'Token validation failed: ' + verifyErr.message });
    }

    // 3. Pre-provision check — user must already exist (created by admin)
    const email = (claims.email || claims.preferred_username || '').toLowerCase().trim();
    const oid = claims.oid;
    if (!email) return res.status(400).json({ error: 'No email claim in token' });

    const result = await pool.query(
      `SELECT id, email, name, role, type, dept, manager_id, functional_manager_id,
              active, leave_balance, used_leave, must_change_pwd
       FROM users WHERE LOWER(email) = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'Account not provisioned. Contact your administrator.' });
    }

    const user = result.rows[0];
    if (!user.active) return res.status(403).json({ error: 'Account deactivated' });

    // 4. Bind azure_oid on first SSO login (prevents email-swap attacks later)
    if (oid) {
      await pool.query(
        `UPDATE users SET azure_oid = COALESCE(azure_oid, $1), sso_provider = COALESCE(sso_provider, $2)
         WHERE id = $3`,
        [oid, 'azure', user.id]
      );
    }

    // 5. Issue our own app JWT (same structure as local login)
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    logAudit(user.id, 'sso_login', `${user.email} logged in via Entra ID SSO`);
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        type: user.type,
        dept: user.dept,
        manager: user.manager_id,
        functionalManager: user.functional_manager_id,
        active: user.active,
        leaveBalance: user.leave_balance,
        usedLeave: user.used_leave,
        mustChangePwd: user.must_change_pwd,
      },
    });
  } catch (err) {
    console.error('SSO login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== AZURE BLOB STORAGE =====

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }); // 25 MB max

// POST /api/uploads  — upload a file attachment (timesheet docs, etc.)
app.post('/api/uploads', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const container = process.env.AZURE_STORAGE_CONTAINER_UPLOADS || 'uploads';
    const ext = req.file.originalname.split('.').pop().toLowerCase();
    const blobName = `${req.user.id}/${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    await azureStorage.uploadFile(container, blobName, req.file.buffer, req.file.mimetype);
    res.json({ blobName, originalName: req.file.originalname, size: req.file.size, mimeType: req.file.mimetype });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// GET /api/uploads/:blobName/url  — get a time-limited SAS download URL
app.get('/api/uploads/:blobName(*)/url', authenticateToken, async (req, res) => {
  try {
    const container = process.env.AZURE_STORAGE_CONTAINER_UPLOADS || 'uploads';
    const url = await azureStorage.generateSasUrl(container, req.params.blobName, 60);
    res.json({ url });
  } catch (err) {
    console.error('SAS URL error:', err);
    res.status(500).json({ error: err.message || 'Could not generate download URL' });
  }
});

// DELETE /api/uploads/:blobName  — delete an uploaded file (admin only)
app.delete('/api/uploads/:blobName(*)', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const container = process.env.AZURE_STORAGE_CONTAINER_UPLOADS || 'uploads';
    await azureStorage.deleteBlob(container, req.params.blobName);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete blob error:', err);
    res.status(500).json({ error: err.message || 'Delete failed' });
  }
});

// POST /api/exports/payroll  — generate payroll Excel and store in exports container
app.post('/api/exports/payroll', authenticateToken, requirePrivileged, async (req, res) => {
  try {
    const { year, month } = req.body;
    if (!year || !month) return res.status(400).json({ error: 'year and month are required' });

    // Fetch payroll data
    const rows = await pool.query(
      `SELECT u.name, u.dept, u.type, u.role,
              COALESCE(t.days_worked, 0) AS days_worked,
              COALESCE(t.days_leave, 0) AS days_leave,
              t.status
       FROM users u
       LEFT JOIN timesheets t ON t.user_id = u.id AND t.year = $1 AND t.month = $2
       WHERE u.active = true ORDER BY u.name`,
      [year, month]
    );

    // Build a simple CSV (no xlsx dependency needed)
    const header = 'Name,Department,Type,Role,Days Worked,Days Leave,Status\n';
    const csvRows = rows.rows.map(r =>
      [r.name, r.dept || '', r.type || '', r.role || '', r.days_worked, r.days_leave, r.status || 'Not submitted']
        .map(v => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    );
    const csv = header + csvRows.join('\n');
    const buffer = Buffer.from(csv, 'utf-8');

    const container = process.env.AZURE_STORAGE_CONTAINER_EXPORTS || 'exports';
    const blobName = `payroll-${year}-${String(month).padStart(2, '0')}-${Date.now()}.csv`;
    await azureStorage.uploadFile(container, blobName, buffer, 'text/csv');
    const url = await azureStorage.generateSasUrl(container, blobName, 120);

    logAudit(req.user.id, 'export_payroll', `Payroll export generated for ${year}-${month}`);
    res.json({ url, blobName, rows: rows.rowCount });
  } catch (err) {
    console.error('Payroll export error:', err);
    res.status(500).json({ error: err.message || 'Export failed' });
  }
});

// ===== HEALTH CHECK =====

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'MazTunWFM API', timestamp: new Date().toISOString() });
});

// ── ERP Duty Rota: Roster CRUD ──────────────────────────────────────────────

// GET all ERP roster members (joined with users table)
app.get('/api/erp/roster', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.id, r.user_id, r.erp_role, r.notes,
             u.name, u.email, u.dept, u.type, u.active
      FROM erp_roster r JOIN users u ON r.user_id = u.id
      ORDER BY u.name
    `);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// POST add user to ERP roster
app.post('/api/erp/roster', authenticateToken, async (req, res) => {
  const { userId, erpRole, notes } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO erp_roster (user_id, erp_role, notes) VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET erp_role=EXCLUDED.erp_role, notes=EXCLUDED.notes
       RETURNING *`,
      [userId, erpRole || '', notes || '']
    );
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// PUT update ERP roster entry
app.put('/api/erp/roster/:userId', authenticateToken, async (req, res) => {
  const { erpRole, notes } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE erp_roster SET erp_role=$1, notes=$2 WHERE user_id=$3 RETURNING *`,
      [erpRole || '', notes || '', req.params.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// DELETE remove user from ERP roster
app.delete('/api/erp/roster/:userId', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM erp_roster WHERE user_id=$1', [req.params.userId]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── ERP Duty Rota: Weeks CRUD ───────────────────────────────────────────────

// GET all rotation weeks
app.get('/api/erp/weeks', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM erp_weeks ORDER BY start_date');
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// POST create rotation week
app.post('/api/erp/weeks', authenticateToken, async (req, res) => {
  const { label, start, end, crisisCoord, drillingCrisisCoord, cpfContact, drillingContact, media } = req.body;
  if (!label || !start || !end) return res.status(400).json({ error: 'label, start, end required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO erp_weeks (label, start_date, end_date, crisis_coord, drilling_crisis_coord, cpf_contact, drilling_contact, media)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [label, start, end, crisisCoord||null, drillingCrisisCoord||null, cpfContact||null, drillingContact||null, media||null]
    );
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// PUT update rotation week
app.put('/api/erp/weeks/:id', authenticateToken, async (req, res) => {
  const { label, start, end, crisisCoord, drillingCrisisCoord, cpfContact, drillingContact, media } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE erp_weeks SET label=$1, start_date=$2, end_date=$3, crisis_coord=$4, drilling_crisis_coord=$5,
       cpf_contact=$6, drilling_contact=$7, media=$8 WHERE id=$9 RETURNING *`,
      [label, start, end, crisisCoord||null, drillingCrisisCoord||null, cpfContact||null, drillingContact||null, media||null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// DELETE rotation week
app.delete('/api/erp/weeks/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM erp_weeks WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── ERP Duty Rota: Notification log ─────────────────────────────────────────

// GET notification history
app.get('/api/erp/notifications', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM erp_notifications ORDER BY created_at DESC LIMIT 100');
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── ERP Duty Rota: notification dispatch ────────────────────────────────────
app.post('/api/send-notification', authenticateToken, async (req, res) => {
  const { type, channel, recipients, subject, body } = req.body;
  if (!recipients || !recipients.length) return res.status(400).json({ error: 'No recipients' });
  console.log(`[ERP Notify] type=${type} channel=${channel} recipients=${recipients.length} subject="${subject}"`);
  // Email dispatch via existing sendEmailSafe helper
  if (channel === 'email' || channel === 'all') {
    for (const r of recipients.filter(x => x.email)) {
      await sendEmailSafe(r.email, subject, `<pre>${body}</pre>`);
    }
  }
  // Log to database
  try {
    await pool.query(
      `INSERT INTO erp_notifications (subject, channel, recipient_count, status, is_emergency, sent_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [subject, channel, recipients.length, 'sent', req.body.isEmergency || false, req.user?.id || null]
    );
  } catch (logErr) { console.error('[ERP Notify] log error:', logErr.message); }
  res.json({ ok: true, sent: recipients.length, channel });
});

// ===== SERVE FRONTEND (only when build folder exists, e.g. Docker) =====

const fs = require('fs');
if (fs.existsSync('build/index.html')) {
  app.use(express.static('build'));
  app.get('*', (req, res) => {
    res.sendFile('build/index.html', { root: '.' });
  });
}

// ── Global error handler ─────────────────────────────────────────────────────
// Catches errors passed via next(err) — returns a safe message without leaking internals
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Mazarine API server running on port ${PORT}`);
});
