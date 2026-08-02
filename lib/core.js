// ============================================================
// CS ROSTER CORE — shared business logic (async, libsql-backed)
// Used by both the local server (server.js) and Vercel serverless
// functions (api/index.js). Zero Google/AWS dependencies.
// ============================================================
'use strict';

const seedData = require('./seed-data');

const USER_COLUMNS = [
  'employeeId', 'username', 'password', 'role', 'status',
  'fullName', 'photoUrl', 'dateOfBirth', 'gender', 'nationalId',
  'mobile', 'personalEmail', 'officialEmail', 'address',
  'emergencyContact', 'emergencyRelationship', 'emergencyPhone',
  'department', 'jobTitle', 'employmentType', 'dateOfJoining',
  'reportingManager', 'workLocation', 'shiftAssignment',
  'primaryResponsibilities', 'assignedTeam', 'skills', 'toolsAccess',
  'supervisor', 'workSchedule', 'attendanceId', 'shiftTiming',
  'salaryGrade', 'bankDetails', 'taxInfo', 'benefits', 'kpiScore',
  'ndaSigned', 'assetAssignment', 'accessPermissions',
  'dateOfPermanent', 'createdAt', 'updatedAt'
];

const CONFIG = {
  ADMIN_ID: '1101',
  SESSION_TTL_MINUTES: 480,
  MAX_CL: 12, MAX_SL: 6, MAX_EL: 6,
  PERMANENT_MONTHS: 6,
  SHIFT_HOURS: 8, MIN_OT_HOURS: 1,
  MIN_PASSWORD_LENGTH: 8,
  LOGIN_MAX_ATTEMPTS: 5, LOGIN_LOCKOUT_MINUTES: 15
};

let db = null;
let connected = false;

// ------------------------------------------------------------------
// Initialize core with a libsql client.
// Photos are persisted in the shared DB (not memory) so they survive
// across isolated serverless function instances.
// ------------------------------------------------------------------
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

function init(client) {
  db = client;
}

function getDbUrl() {
  if (process.env.TURSO_DATABASE_URL) return process.env.TURSO_DATABASE_URL;
  const dir = (process.env.VERCEL === '1') ? '/tmp' : path.join(process.cwd(), 'data');
  if (process.env.VERCEL === '1') fs.mkdirSync('/tmp', { recursive: true });
  else fs.mkdirSync(dir, { recursive: true });
  return 'file:' + path.join(dir, 'roster.db');
}

async function connect() {
  if (connected) return db;
  const client = createClient({
    url: getDbUrl(),
    authToken: process.env.TURSO_AUTH_TOKEN || undefined
  });
  init(client);
  await initSchema();
  await seedIfEmpty();
  connected = true;
  return db;
}

// libsql execute wrapper: returns rows array
async function exec(sql, args) {
  if (!db) await connect();
  const r = await db.execute({ sql, args });
  return r.rows || [];
}

// ------------------------------------------------------------------
// SCHEMA
// ------------------------------------------------------------------
const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS users (
    ${USER_COLUMNS.join(', ')}
  )`,
  `CREATE TABLE IF NOT EXISTS leave_log (
    requestId TEXT PRIMARY KEY, employeeId TEXT, leaveType TEXT,
    startDate TEXT, endDate TEXT, totalDays INTEGER, reason TEXT,
    status TEXT, approvedBy TEXT, appliedOn TEXT, updatedAt TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ot_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT, employeeId TEXT, rosterStart TEXT, actualIn TEXT, actualOut TEXT,
    totalHours REAL, otHours REAL, lateMinutes INTEGER, isLate TEXT,
    enteredBy TEXT, createdAt TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS roster (
    date TEXT PRIMARY KEY, day TEXT, morning TEXT, evening TEXT, night TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS notices (
    id TEXT PRIMARY KEY, icon TEXT, text TEXT, createdAt TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS flash (
    id TEXT PRIMARY KEY, text TEXT, active TEXT, createdBy TEXT, createdAt TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS pending (
    id TEXT PRIMARY KEY, text TEXT, assignedTo TEXT, assignedEmployeeIds TEXT, completed TEXT,
    resolverId TEXT, resolvedAt TEXT, createdBy TEXT, createdAt TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employeeId TEXT, date TEXT, type TEXT, time TEXT, timestamp TEXT, note TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, employeeId TEXT, createdAt TEXT, expiresAt INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS audit (
    logId TEXT PRIMARY KEY, employeeId TEXT, action TEXT, details TEXT, timestamp TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
    username TEXT PRIMARY KEY, count INTEGER, lockedUntil INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS idle (
    employeeId TEXT, date TEXT, seconds INTEGER DEFAULT 0, updatedAt TEXT,
    PRIMARY KEY (employeeId, date)
  )`,
  `CREATE TABLE IF NOT EXISTS photos (
    employeeId TEXT PRIMARY KEY, mime TEXT, data TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS password_resets (
    id TEXT PRIMARY KEY, employeeId TEXT, token TEXT, expiresAt INTEGER, used TEXT DEFAULT 'false', createdAt TEXT
  )`
];

async function initSchema() {
  for (const sql of SCHEMA_SQL) await db.execute(sql);
}

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------
function pad2(n) { return String(n).padStart(2, '0'); }
function formatDateObj(d) {
  d = new Date(d);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function nowTimeStr(d = new Date()) {
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function timeToMinutes(t) {
  if (!t) return 0;
  const parts = String(t).split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1] || 0, 10);
}
function isAdminRole(role) {
  return role === 'Admin' || role === 'HR' || role === 'Accounts' || role === 'Super Admin';
}

function hashPassword(pwd) {
  return crypto.createHash('sha256').update(String(pwd), 'utf8').digest('hex');
}
function generateToken() { return crypto.randomUUID(); }

function buildUserObject(row) {
  if (!row) return null;
  const obj = {};
  for (const col of USER_COLUMNS) {
    if (col === 'password') continue;
    let v = row[col];
    if (v === undefined || v === null) v = '';
    obj[col] = String(v);
  }
  obj.employeeId = String(obj.employeeId);
  obj.username = String(obj.username);
  return obj;
}

function rowToObj(headers, row) {
  const obj = {};
  for (const h of headers) obj[h] = row[h] !== undefined && row[h] !== null ? row[h] : '';
  return obj;
}

function logAudit(employeeId, action, details) {
  try {
    db.execute('INSERT INTO audit (logId, employeeId, action, details, timestamp) VALUES (?,?,?,?,?)',
      [String(Date.now()), String(employeeId || ''), action, String(details || ''), new Date().toISOString()]);
  } catch (e) { /* best-effort audit */ }
}

// ------------------------------------------------------------------
// Sessions (DB-backed — works across serverless cold starts)
// ------------------------------------------------------------------
function storeSession(token, employeeId) {
  const expiresAt = Date.now() + CONFIG.SESSION_TTL_MINUTES * 60 * 1000;
  db.execute('INSERT INTO sessions (token, employeeId, createdAt, expiresAt) VALUES (?,?,?,?)',
    [token, String(employeeId), new Date().toISOString(), expiresAt]);
}

async function validateSessionToken(token) {
  if (!token) return null;
  const rows = await exec('SELECT * FROM sessions WHERE token = ?', [token]);
  if (!rows.length) return null;
  const s = rows[0];
  if (Date.now() > s.expiresAt) {
    await exec('DELETE FROM sessions WHERE token = ?', [token]);
    return null;
  }
  return { employeeId: s.employeeId, createdAt: s.createdAt };
}

async function removeSession(token) {
  await exec('DELETE FROM sessions WHERE token = ?', [token]);
}

// ------------------------------------------------------------------
// Login rate limiting
// ------------------------------------------------------------------
async function checkLoginAttempts(username) {
  const rows = await exec('SELECT * FROM login_attempts WHERE username = ?', [username]);
  if (!rows.length) return { count: 0, lockedUntil: 0 };
  const r = rows[0];
  return { count: r.count, lockedUntil: r.lockedUntil };
}
async function recordFailedLogin(username) {
  const data = await checkLoginAttempts(username);
  data.count += 1;
  if (data.count >= CONFIG.LOGIN_MAX_ATTEMPTS) {
    data.lockedUntil = Date.now() + CONFIG.LOGIN_LOCKOUT_MINUTES * 60 * 1000;
  }
  await db.execute(`INSERT INTO login_attempts (username, count, lockedUntil) VALUES (?,?,?)
      ON CONFLICT(username) DO UPDATE SET count=excluded.count, lockedUntil=excluded.lockedUntil`,
    [username, data.count, data.lockedUntil]);
}
async function clearLoginAttempts(username) {
  await exec('DELETE FROM login_attempts WHERE username = ?', [username]);
}

// ------------------------------------------------------------------
// Auth / auth middleware
// ------------------------------------------------------------------
async function authenticate(params) {
  if (!params || !params.token) return null;
  const session = await validateSessionToken(params.token);
  if (!session) return null;
  return findEmployeeById(session.employeeId);
}
async function requireAdmin(params, handler) {
  const user = await authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };
  if (!isAdminRole(user.role)) return { success: false, error: 'Unauthorized' };
  return handler(params, user);
}
async function requireSuperAdmin(params, handler) {
  const user = await authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };
  if (user.employeeId !== CONFIG.ADMIN_ID) return { success: false, error: 'Only super admin can perform this action' };
  return handler(params, user);
}

// ------------------------------------------------------------------
// AUTH HANDLERS
// ------------------------------------------------------------------
async function handleLogin(params) {
  const username = String(params.username || '').trim();
  const password = String(params.password || '').trim();

  const attempts = await checkLoginAttempts(username);
  if (attempts.lockedUntil && Date.now() < attempts.lockedUntil) {
    const rem = Math.ceil((attempts.lockedUntil - Date.now()) / 60000);
    return { success: false, error: 'Too many failed attempts. Try again in ' + rem + ' minutes.' };
  }

  const rows = await exec('SELECT * FROM users WHERE employeeId = ? OR username = ?', [username, username]);
  const row = rows[0];
  if (!row) {
    await recordFailedLogin(username);
    return { success: false, error: 'User not found' };
  }

  if (String(row.password) !== hashPassword(password)) {
    await recordFailedLogin(username);
    return { success: false, error: 'Invalid password' };
  }

  if (row.status === 'Terminated' || row.status === 'Resigned') {
    return { success: false, error: 'Account is ' + row.status.toLowerCase() };
  }

  await clearLoginAttempts(username);

  const token = generateToken();
  storeSession(token, String(row.employeeId));
  const empId = String(row.employeeId);

  // Auto sign-in timestamp (records today's login)
  try {
    const now = new Date();
    await db.execute('INSERT INTO attendance (employeeId, date, type, time, timestamp, note) VALUES (?,?,?,?,?,?)',
      [empId, formatDateObj(now), 'login', nowTimeStr(now), now.toISOString(), '']);
  } catch (e) { /* silent */ }

  const isDefaultPw = hashPassword(String(row.employeeId)) === String(row.password);
  return { success: true, data: { token, mustChangePassword: isDefaultPw, user: buildUserObject(row) } };
}

async function handleChangePassword(params) {
  const user = await authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };

  const oldPwd = String(params.oldPassword || '');
  const newPwd = String(params.newPassword || '');
  if (newPwd.length < CONFIG.MIN_PASSWORD_LENGTH) {
    return { success: false, error: 'Password must be at least ' + CONFIG.MIN_PASSWORD_LENGTH + ' characters' };
  }

  const rows = await exec('SELECT password FROM users WHERE employeeId = ?', [user.employeeId]);
  if (!rows.length) return { success: false, error: 'User not found' };
  if (rows[0].password !== hashPassword(oldPwd)) return { success: false, error: 'Current password is incorrect' };

  await db.execute('UPDATE users SET password = ? WHERE employeeId = ?', [hashPassword(newPwd), user.employeeId]);
  return { success: true };
}

async function handleLogout(params) {
  if (params.token) {
    try {
      const session = await validateSessionToken(params.token);
      if (session) {
        const now = new Date();
        await db.execute('INSERT INTO attendance (employeeId, date, type, time, timestamp, note) VALUES (?,?,?,?,?,?)',
          [String(session.employeeId), formatDateObj(now), 'logout', nowTimeStr(now), now.toISOString(), '']);
      }
    } catch (e) { /* silent */ }
    await removeSession(params.token);
  }
  return { success: true };
}

async function handleValidateSession(params) {
  const user = await authenticate(params);
  if (!user) return { success: false };
  return { success: true, data: { user } };
}

// ------------------------------------------------------------------
// EMPLOYEE HANDLERS
// ------------------------------------------------------------------
async function handleGetAllEmployees() {
  const rows = await exec("SELECT * FROM users WHERE status != 'Deleted'", []);
  return { success: true, data: rows.map(buildUserObject) };
}

async function handleGetEmployee(params) {
  const user = await authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };
  const targetId = String(params.employeeId || user.employeeId);
  if (user.employeeId !== targetId && !isAdminRole(user.role)) {
    return { success: false, error: 'Unauthorized' };
  }
  const employee = await findEmployeeById(targetId);
  if (!employee) return { success: false, error: 'Employee not found' };
  return { success: true, data: employee };
}

async function savePhoto(photoBase64, employeeId, mime = 'image/jpeg') {
  try {
    const bytes = Buffer.from(photoBase64, 'base64');
    const data = bytes.toString('base64');
    await db.execute('INSERT OR REPLACE INTO photos (employeeId, mime, data) VALUES (?,?,?)',
      [String(employeeId), mime, data]);
    return '/photos/emp_' + employeeId + '.jpg';
  } catch (e) { return ''; }
}

async function readPhoto(employeeId) {
  const rows = await exec('SELECT mime, data FROM photos WHERE employeeId = ?', [String(employeeId)]);
  if (!rows.length) return null;
  return { mime: rows[0].mime || 'image/jpeg', data: rows[0].data };
}

async function handleCreateEmployee(params, authUser) {
  const data = params.employeeData || {};
  const photoBase64 = params.photoBase64 || '';

  const employeeId = String(data.employeeId || await getNextId());
  const username = data.username || employeeId;
  const password = hashPassword(employeeId);
  const role = data.role || 'Employee';
  const status = data.status || 'Active';

  if (await findEmployeeById(employeeId)) return { success: false, error: 'Employee ID already exists' };

  let photoUrl = '';
  if (photoBase64) photoUrl = await savePhoto(photoBase64, employeeId);

  const record = USER_COLUMNS.map(col => {
    let v;
    switch (col) {
      case 'employeeId': v = employeeId; break;
      case 'username': v = username; break;
      case 'password': v = password; break;
      case 'role': v = role; break;
      case 'status': v = status; break;
      case 'photoUrl': v = photoUrl; break;
      case 'createdAt': v = new Date().toISOString(); break;
      case 'updatedAt': v = new Date().toISOString(); break;
      default: v = data[col] !== undefined ? String(data[col]) : '';
    }
    return v;
  });

  await db.execute(`INSERT INTO users (${USER_COLUMNS.join(',')}) VALUES (${USER_COLUMNS.map(() => '?').join(',')})`, record);
  logAudit(authUser.employeeId, 'createEmployee', 'Created employee ' + employeeId);
  return { success: true, data: { employeeId } };
}

async function handleUpdateEmployee(params, authUser) {
  const targetId = String(params.employeeId || '');
  const data = params.employeeData || {};
  const photoBase64 = params.photoBase64 || '';

  const rows = await exec('SELECT 1 FROM users WHERE employeeId = ?', [targetId]);
  if (!rows.length) return { success: false, error: 'Employee not found' };

  if (photoBase64) data.photoUrl = await savePhoto(photoBase64, targetId);

  const sets = [];
  const vals = [];
  for (const key of Object.keys(data)) {
    if (key === 'employeeId' || key === 'password' || key === 'createdAt') continue;
    if (!USER_COLUMNS.includes(key)) continue;
    sets.push(key + ' = ?');
    vals.push(String(data[key]));
  }
  vals.push(new Date().toISOString(), targetId);
  await db.execute(`UPDATE users SET ${sets.join(', ')}, updatedAt = ? WHERE employeeId = ?`, vals);

  logAudit(authUser.employeeId, 'updateEmployee', 'Updated employee ' + targetId);
  return { success: true };
}

async function handleDeleteEmployee(params, authUser) {
  const targetId = String(params.employeeId || '');
  if (targetId === CONFIG.ADMIN_ID) return { success: false, error: 'Cannot delete super admin' };

  const res = await db.execute("UPDATE users SET status = 'Deleted' WHERE employeeId = ?", [targetId]);
  if (res.rowsAffected === 0) return { success: false, error: 'Employee not found' };

  logAudit(authUser.employeeId, 'deleteEmployee', 'Deleted employee ' + targetId);
  return { success: true };
}

async function handleSetStatus(params, authUser) {
  const targetId = String(params.employeeId || '');
  const newStatus = String(params.status || 'Active');
  const res = await db.execute('UPDATE users SET status = ? WHERE employeeId = ?', [newStatus, targetId]);
  if (res.rowsAffected === 0) return { success: false, error: 'Employee not found' };
  logAudit(authUser.employeeId, 'setStatus', 'Set employee ' + targetId + ' status to ' + newStatus);
  return { success: true };
}

async function getNextId() {
  const rows = await exec('SELECT MAX(CAST(employeeId AS INTEGER)) AS maxId FROM users', []);
  const maxId = rows[0] && rows[0].maxId ? parseInt(rows[0].maxId, 10) : 1000;
  return maxId + 1;
}

async function findEmployeeById(id) {
  const rows = await exec('SELECT * FROM users WHERE employeeId = ? AND status != ?', [String(id), 'Deleted']);
  return buildUserObject(rows[0] || null);
}

// ------------------------------------------------------------------
// ROSTER HANDLERS
// ------------------------------------------------------------------
async function handleGetRoster(params) {
  const user = await authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };
  const rows = await exec('SELECT date, day, morning, evening, night FROM roster ORDER BY date', []);
  return { success: true, data: rows };
}

function parseCSV(csvText) {
  const lines = String(csvText).split('\n');
  const result = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const values = [];
    let current = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === ',' && !inQuotes) { values.push(current.trim()); current = ''; }
      else current += ch;
    }
    values.push(current.trim());
    result.push(values);
  }
  return result;
}

async function handleUploadRoster(params, authUser) {
  const csvText = params.csvText || '';
  if (!csvText) return { success: false, error: 'No CSV data provided' };
  const parsed = parseCSV(csvText);
  if (parsed.length < 2) return { success: false, error: 'CSV must have at least a header row and one data row' };

  const headers = parsed[0].map(h => String(h).toLowerCase());
  const idx = (name) => headers.indexOf(name);
  await db.execute('DELETE FROM roster', []);
  const insert = db.batch ? null : null;
  for (let i = 1; i < parsed.length; i++) {
    const r = parsed[i];
    await db.execute('INSERT OR REPLACE INTO roster (date, day, morning, evening, night) VALUES (?,?,?,?,?)', [
      r[idx('date')] || r[0] || '',
      r[idx('day')] || r[1] || '',
      r[idx('morning')] || r[2] || '',
      r[idx('evening')] || r[3] || '',
      r[idx('night')] || r[4] || ''
    ]);
  }
  logAudit(authUser.employeeId, 'uploadRoster', 'Uploaded roster with ' + (parsed.length - 1) + ' rows');
  return { success: true, data: { rows: parsed.length - 1 } };
}

// ------------------------------------------------------------------
// LEAVE HANDLERS
// ------------------------------------------------------------------
function calculateLeaveBalance(doj, usedCL, usedSL, usedEL) {
  if (!doj) return { cl: 0, sl: 0, el: 0, total: 0, isPermanent: false, permDate: null };
  const today = new Date();
  const joiningDate = new Date(doj);
  const permDate = new Date(joiningDate);
  permDate.setMonth(permDate.getMonth() + CONFIG.PERMANENT_MONTHS);
  if (today < permDate) {
    return { cl: 0, sl: 0, el: 0, total: 0, isPermanent: false,
      permDate: permDate.toISOString().split('T')[0] };
  }
  let months = (today.getFullYear() - permDate.getFullYear()) * 12 + (today.getMonth() - permDate.getMonth());
  if (today.getDate() < permDate.getDate()) months--;
  months = months + 1; if (months < 1) months = 1;

  const clE = Math.min(months, CONFIG.MAX_CL);
  const slE = Math.min(Math.floor(months / 2), CONFIG.MAX_SL);
  const elE = Math.min(Math.floor(months / 2), CONFIG.MAX_EL);
  usedCL = usedCL || 0; usedSL = usedSL || 0; usedEL = usedEL || 0;
  return {
    cl: Math.max(0, clE - usedCL), sl: Math.max(0, slE - usedSL), el: Math.max(0, elE - usedEL),
    totalEarned: clE + slE + elE, usedCL, usedSL, usedEL,
    total: Math.max(0, (clE - usedCL) + (slE - usedSL) + (elE - usedEL)),
    isPermanent: true, permDate: permDate.toISOString().split('T')[0],
    monthsSincePermanent: months, clMax: CONFIG.MAX_CL, slMax: CONFIG.MAX_SL, elMax: CONFIG.MAX_EL
  };
}

async function getUsedLeaves(employeeId) {
  const rows = await exec("SELECT leaveType, totalDays FROM leave_log WHERE employeeId = ? AND status = 'Approved'", [String(employeeId)]);
  const used = { cl: 0, sl: 0, el: 0 };
  for (const r of rows) {
    const days = parseInt(r.totalDays, 10) || 1;
    if (r.leaveType === 'CL') used.cl += days;
    else if (r.leaveType === 'SL') used.sl += days;
    else if (r.leaveType === 'EL') used.el += days;
  }
  return used;
}

async function handleGetLeaveBalance(params) {
  const user = await authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };
  const targetId = params.employeeId || user.employeeId;
  if (user.role === 'Employee' && String(targetId) !== String(user.employeeId)) {
    return { success: false, error: 'Unauthorized: can only view your own leave balance' };
  }
  const employee = await findEmployeeById(targetId);
  if (!employee) return { success: false, error: 'Employee not found' };
  const used = await getUsedLeaves(targetId);
  return { success: true, data: calculateLeaveBalance(employee.dateOfJoining, used.cl, used.sl, used.el) };
}

async function handleApplyLeave(params) {
  const user = await authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };
  const targetId = params.employeeId || user.employeeId;
  if (user.role === 'Employee' && String(targetId) !== String(user.employeeId)) {
    return { success: false, error: 'Unauthorized: can only apply leave for yourself' };
  }
  const leaveType = String(params.leaveType || '');
  const startDate = String(params.startDate || '');
  const endDate = String(params.endDate || '');
  const reason = String(params.reason || '');
  if (!leaveType || !startDate || !endDate) return { success: false, error: 'Leave type, start date, and end date are required' };
  if (!['CL', 'SL', 'EL'].includes(leaveType)) return { success: false, error: 'Invalid leave type. Must be CL, SL, or EL' };

  const start = new Date(startDate);
  const end = new Date(endDate);
  if (end < start) return { success: false, error: 'End date must be after start date' };
  const totalDays = Math.floor((end - start) / 86400000) + 1;

  const employee = await findEmployeeById(targetId);
  const used = await getUsedLeaves(targetId);
  const balance = calculateLeaveBalance(employee.dateOfJoining, used.cl, used.sl, used.el);
  const availKey = leaveType.toLowerCase();
  if (balance[availKey] < totalDays) {
    return { success: false, error: 'Insufficient ' + leaveType + ' balance. Available: ' + balance[availKey] + ', Requested: ' + totalDays };
  }

  const requestId = 'LR-' + Date.now();
  await db.execute(`INSERT INTO leave_log (requestId, employeeId, leaveType, startDate, endDate, totalDays, reason, status, approvedBy, appliedOn, updatedAt)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [requestId, String(targetId), leaveType, startDate, endDate, totalDays, reason, 'Pending',
     user.employeeId === String(targetId) ? '' : user.employeeId, new Date().toISOString(), '']);
  return { success: true, data: { requestId } };
}

async function handleApproveLeave(params, authUser) {
  const requestId = String(params.requestId || '');
  const act = String(params.decision || params.subAction || 'approve');
  const note = params.note || '';
  const rows = await exec('SELECT * FROM leave_log WHERE requestId = ?', [requestId]);
  if (!rows.length) return { success: false, error: 'Leave request not found' };
  const newStatus = act === 'approve' ? 'Approved' : 'Rejected';
  await db.execute('UPDATE leave_log SET status = ?, approvedBy = ?, updatedAt = ? WHERE requestId = ?',
    [newStatus, authUser.employeeId, new Date().toISOString(), requestId]);
  logAudit(authUser.employeeId, act + 'Leave', requestId + ' ' + note);
  return { success: true };
}

async function handleGetLeaveRequests(params) {
  const user = await authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };
  let rows;
  if (user.role === 'Employee') {
    rows = await exec('SELECT * FROM leave_log WHERE employeeId = ? ORDER BY appliedOn DESC', [user.employeeId]);
  } else {
    rows = await exec('SELECT * FROM leave_log ORDER BY appliedOn DESC', []);
  }
  return { success: true, data: rows };
}

// ------------------------------------------------------------------
// OT HANDLERS
// ------------------------------------------------------------------
function calculateOT(actualIn, actualOut) {
  const base = '2000-01-01T';
  const inTime = new Date(base + actualIn + ':00');
  let outTime = new Date(base + actualOut + ':00');
  if (outTime <= inTime) outTime = new Date(outTime.getTime() + 86400000);
  const totalHours = (outTime - inTime) / 3600000;
  let otHours = Math.max(0, totalHours - CONFIG.SHIFT_HOURS);
  if (otHours < CONFIG.MIN_OT_HOURS) otHours = 0;
  else otHours = Math.floor(otHours);
  return { totalHours: Math.round(totalHours * 100) / 100, otHours };
}

async function handleLogOT(params, authUser) {
  const targetId = String(params.employeeId || '');
  const logDate = String(params.date || '');
  const actualIn = String(params.actualIn || '');
  const actualOut = String(params.actualOut || '');
  const rosterStart = String(params.rosterStart || '');
  if (!targetId || !logDate || !actualIn || !actualOut) return { success: false, error: 'Employee ID, date, actual in/out are required' };
  if (!await findEmployeeById(targetId)) return { success: false, error: 'Employee not found' };

  const calc = calculateOT(actualIn, actualOut);
  await db.execute(`INSERT INTO ot_log (date, employeeId, rosterStart, actualIn, actualOut, totalHours, otHours, lateMinutes, isLate, enteredBy, createdAt)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [logDate, targetId, rosterStart, actualIn, actualOut, calc.totalHours, calc.otHours, 0, 'false', authUser.employeeId, new Date().toISOString()]);
  return { success: true, data: calc };
}

async function handleGetOTLogs(params) {
  const user = await authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };
  const targetId = String(params.employeeId || user.employeeId);
  const filterDate = params.date || '';
  if (user.role === 'Employee' && targetId !== String(user.employeeId)) {
    return { success: false, error: 'Unauthorized' };
  }
  let rows;
  if (filterDate) {
    rows = await exec('SELECT * FROM ot_log WHERE employeeId = ? AND date = ? ORDER BY date DESC', [targetId, filterDate]);
  } else {
    rows = await exec('SELECT * FROM ot_log WHERE employeeId = ? ORDER BY date DESC', [targetId]);
  }
  return { success: true, data: rows };
}

// ------------------------------------------------------------------
// NOTICES HANDLERS
// ------------------------------------------------------------------
async function handleGetNotices() {
  const rows = await exec('SELECT id, icon, text, createdAt FROM notices ORDER BY id DESC', []);
  return { success: true, data: rows };
}
async function handleAddNotice(params, authUser) {
  if (!authUser) return { success: false, error: 'Authentication required' };
  const text = String(params.text || '');
  const icon = String(params.icon || 'info');
  if (!text) return { success: false, error: 'Notice text is required' };
  await db.execute('INSERT INTO notices (id, icon, text, createdAt) VALUES (?,?,?,?)',
    [String(Date.now()), icon, text, new Date().toISOString()]);
  return { success: true };
}

// ------------------------------------------------------------------
// FLASH MESSAGES
// ------------------------------------------------------------------
async function handleGetFlashMessages() {
  const rows = await exec('SELECT id, text, active, createdBy, createdAt FROM flash ORDER BY CAST(id AS INTEGER)', []);
  return { success: true, data: rows };
}
async function handleAddFlashMessage(params, authUser) {
  const text = String(params.text || '').trim();
  if (!text) return { success: false, error: 'Message text is required' };
  await db.execute('INSERT INTO flash (id, text, active, createdBy, createdAt) VALUES (?,?,?,?,?)',
    [String(Date.now()), text, 'true', authUser.employeeId, new Date().toISOString()]);
  return { success: true };
}
async function handleUpdateFlashMessage(params) {
  const msgId = String(params.id || '');
  const text = String(params.text || '');
  const active = params.active !== undefined ? String(params.active) : null;
  const existing = await exec('SELECT id FROM flash WHERE id = ?', [msgId]);
  if (!existing.length) return { success: false, error: 'Message not found' };
  if (text) await db.execute('UPDATE flash SET text = ? WHERE id = ?', [text, msgId]);
  if (active !== null) await db.execute('UPDATE flash SET active = ? WHERE id = ?', [active, msgId]);
  return { success: true };
}
async function handleDeleteFlashMessage(params) {
  const msgId = String(params.id || '');
  const res = await db.execute('DELETE FROM flash WHERE id = ?', [msgId]);
  if (res.rowsAffected === 0) return { success: false, error: 'Message not found' };
  return { success: true };
}

// ------------------------------------------------------------------
// PENDING ITEMS — SHARED: everyone's input visible to all
// ------------------------------------------------------------------
async function handleGetPendingItems(params) {
  const user = await authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };
  const rows = await exec('SELECT * FROM pending ORDER BY createdAt ASC', []);
  // Filter based on assignment
  const filtered = rows.filter(row => {
    const assignedTo = String(row.assignedTo || 'everyone');
    if (assignedTo === 'everyone' || assignedTo === '') return true;
    if (assignedTo === 'admins' && isAdminRole(user.role)) return true;
    // Check specific employee IDs
    const specificIds = String(row.assignedEmployeeIds || '');
    if (specificIds && specificIds.split(',').includes(String(user.employeeId))) return true;
    // Super admin sees everything
    if (user.employeeId === CONFIG.ADMIN_ID) return true;
    return false;
  });
  // Sort: unresolved first, resolved last
  filtered.sort((a, b) => (a.completed === 'true' ? 1 : 0) - (b.completed === 'true' ? 1 : 0));
  return { success: true, data: filtered };
}

async function handleAddPendingItem(params) {
  const user = await authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };
  const text = String(params.text || '').trim();
  if (!text) return { success: false, error: 'Item text is required' };
  const assignedTo = String(params.assignedTo || 'everyone');
  const assignedEmployeeIds = String(params.assignedEmployeeIds || '');
  await db.execute('INSERT INTO pending (id, text, assignedTo, assignedEmployeeIds, completed, resolverId, resolvedAt, createdBy, createdAt) VALUES (?,?,?,?,?,?,?,?,?)',
    [String(Date.now()), text, assignedTo, assignedEmployeeIds, 'false', '', '', user.employeeId, new Date().toISOString()]);
  return { success: true };
}

async function handleUpdatePendingItem(params) {
  const user = await authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };
  const itemId = String(params.id || '');
  const text = String(params.text || '');
  const assignedTo = params.assignedTo !== undefined ? String(params.assignedTo) : null;
  const assignedEmployeeIds = params.assignedEmployeeIds !== undefined ? String(params.assignedEmployeeIds) : null;
  const rows = await exec('SELECT * FROM pending WHERE id = ?', [itemId]);
  if (!rows.length) return { success: false, error: 'Item not found' };
  if (text) await db.execute('UPDATE pending SET text = ? WHERE id = ?', [text, itemId]);
  if (assignedTo !== null) await db.execute('UPDATE pending SET assignedTo = ? WHERE id = ?', [assignedTo, itemId]);
  if (assignedEmployeeIds !== null) await db.execute('UPDATE pending SET assignedEmployeeIds = ? WHERE id = ?', [assignedEmployeeIds, itemId]);
  return { success: true };
}

async function handleResolvePendingItem(params) {
  const user = await authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };
  const itemId = String(params.id || '');
  const completed = String(params.completed !== undefined ? params.completed : 'true');
  const rows = await exec('SELECT * FROM pending WHERE id = ?', [itemId]);
  if (!rows.length) return { success: false, error: 'Item not found' };
  if (completed === 'true') {
    await db.execute('UPDATE pending SET completed = ?, resolverId = ?, resolvedAt = ? WHERE id = ?',
      ['true', String(user.employeeId), new Date().toISOString(), itemId]);
  } else {
    await db.execute('UPDATE pending SET completed = ?, resolverId = ?, resolvedAt = ? WHERE id = ?',
      ['false', '', '', itemId]);
  }
  return { success: true };
}

async function handleDeletePendingItem(params, authUser) {
  const itemId = String(params.id || '');
  if (authUser.employeeId !== CONFIG.ADMIN_ID) return { success: false, error: 'Unauthorized: only super admin can delete items' };
  const res = await db.execute('DELETE FROM pending WHERE id = ?', [itemId]);
  if (res.rowsAffected === 0) return { success: false, error: 'Item not found' };
  return { success: true };
}

// ------------------------------------------------------------------
// ATTENDANCE & REPORTING
// ------------------------------------------------------------------
async function handleGetAttendance(params) {
  const user = await authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };
  const targetId = String(params.employeeId || user.employeeId);
  const filterDate = params.date || '';
  if (user.role === 'Employee' && targetId !== String(user.employeeId)) {
    return { success: false, error: 'Unauthorized' };
  }
  let rows;
  if (filterDate) {
    rows = await exec('SELECT employeeId, date, type, time, timestamp, note FROM attendance WHERE employeeId = ? AND date = ? ORDER BY id', [targetId, filterDate]);
  } else {
    rows = await exec('SELECT employeeId, date, type, time, timestamp, note FROM attendance WHERE employeeId = ? ORDER BY id', [targetId]);
  }
  return { success: true, data: rows };
}

async function handleUpdateAttendance(params) {
  const rowIndex = parseInt(params.rowIndex, 10);
  const field = String(params.field || '');
  const value = String(params.value || '');
  if (isNaN(rowIndex) || rowIndex < 1) return { success: false, error: 'Invalid row' };
  if (!['employeeId', 'date', 'type', 'time', 'timestamp', 'note'].includes(field)) return { success: false, error: 'Field not found' };
  const res = await db.execute(`UPDATE attendance SET ${field} = ? WHERE id = ?`, [value, rowIndex]);
  if (res.rowsAffected === 0) return { success: false, error: 'Row not found' };
  return { success: true };
}

async function parseAttendanceForReport(employeeId, month, year) {
  month = parseInt(month, 10); year = parseInt(year, 10);

  const rosterRows = await exec('SELECT date, morning, evening, night FROM roster', []);
  const rosterMap = {};
  for (const r of rosterRows) {
    rosterMap[String(r.date)] = { morning: r.morning || '', evening: r.evening || '', night: r.night || '' };
  }

  const attRows = await exec('SELECT date, type, time FROM attendance WHERE employeeId = ?', [String(employeeId)]);
  const attMap = {};
  for (const r of attRows) {
    const d = String(r.date);
    attMap[d] = attMap[d] || {};
    if (r.type === 'login') attMap[d].login = String(r.time || '');
    if (r.type === 'logout') attMap[d].logout = attMap[d].logout || String(r.time || '');
  }
  // ensure the earliest login + latest logout of the day
  // (single entries are common; keep first login, last logout)

  const idleRows = await exec('SELECT date, seconds FROM idle WHERE employeeId = ?', [String(employeeId)]);
  const idleMap = {};
  for (const r of idleRows) idleMap[String(r.date)] = (r.seconds || 0);

  const daysInMonth = new Date(year, month, 0).getDate();
  const results = [];

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = year + '-' + pad2(month) + '-' + pad2(d);
    const roster = rosterMap[dateStr];
    const att = attMap[dateStr];

    let assigned = '';
    let rosterTime = '';
    const loginTime = att ? (att.login || '') : '';
    const logoutTime = att ? (att.logout || '') : '';
    let status = 'n/a';
    let totalHours = 0;
    let otHours = 0;

    if (roster) {
      if (roster.morning && roster.morning !== 'OFF' && roster.morning !== 'HOLIDAY') { assigned = roster.morning; rosterTime = '7:00'; }
      else if (roster.evening && roster.evening !== 'OFF' && roster.evening !== 'HOLIDAY') { assigned = roster.evening; rosterTime = '15:00'; }
      else if (roster.night && roster.night !== 'OFF' && roster.night !== 'HOLIDAY') { assigned = roster.night; rosterTime = '23:00'; }
    }

    if (assigned && assigned.indexOf(String(employeeId)) >= 0) {
      if (loginTime) {
        const late = timeToMinutes(loginTime) - timeToMinutes(rosterTime);
        status = late > 15 ? 'Late (' + late + ' min)' : 'On Time';
        if (logoutTime) {
          let totalMin = timeToMinutes(logoutTime) - timeToMinutes(loginTime);
          if (totalMin < 0) totalMin += 1440;
          totalHours = Math.round(totalMin / 60 * 100) / 100;
          otHours = Math.max(0, totalHours - CONFIG.SHIFT_HOURS);
          if (otHours < CONFIG.MIN_OT_HOURS) otHours = 0;
          else otHours = Math.floor(otHours);
        }
      } else {
        status = 'Absent';
      }
    }

    results.push({
      date: dateStr, rosterTime, loginTime, logoutTime, status,
      totalHours, otHours, idleSeconds: idleMap[dateStr] || 0
    });
  }
  return results;
}

async function handleRecordAttendance(params) {
  const empId = String(params.employeeId || '');
  const logDate = String(params.date || '');
  const loginTime = String(params.loginTime || '');
  const logoutTime = String(params.logoutTime || '');
  if (!empId || !logDate || !loginTime || !logoutTime) return { success: false, error: 'Employee ID, date, login and logout times required' };
  const ts = new Date().toISOString();
  await db.execute('INSERT INTO attendance (employeeId, date, type, time, timestamp, note) VALUES (?,?,?,?,?,?)',
    [empId, logDate, 'login', loginTime, ts, 'manual']);
  await db.execute('INSERT INTO attendance (employeeId, date, type, time, timestamp, note) VALUES (?,?,?,?,?,?)',
    [empId, logDate, 'logout', logoutTime, ts, 'manual']);
  return { success: true };
}

async function handleGetAttendanceReport(params) {
  const employeeId = String(params.employeeId || '');
  const month = parseInt(params.month, 10) || (new Date().getMonth() + 1);
  const year = parseInt(params.year, 10) || new Date().getFullYear();

  if (employeeId) return { success: true, data: await parseAttendanceForReport(employeeId, month, year) };

  const rows = await exec("SELECT employeeId FROM users WHERE status != 'Deleted'", []);
  const allReports = {};
  for (const u of rows) {
    const id = String(u.employeeId);
    if (id === CONFIG.ADMIN_ID) continue;
    allReports[id] = await parseAttendanceForReport(id, month, year);
  }
  return { success: true, data: allReports };
}

async function handleGetOTReport(params) {
  return await handleGetAttendanceReport(params);
}

// ------------------------------------------------------------------
// NEW: shift sign-out + idle
// ------------------------------------------------------------------
async function handleGetTodayShift(params) {
  const user = await authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };
  const targetId = String(params.employeeId || user.employeeId);
  if (user.role === 'Employee' && targetId !== String(user.employeeId)) {
    return { success: false, error: 'Unauthorized' };
  }
  const today = formatDateObj(new Date());
  const rows = await exec('SELECT type, time FROM attendance WHERE employeeId = ? AND date = ? ORDER BY id', [targetId, today]);
  let loginTime = ''; let logoutTime = '';
  for (const r of rows) {
    if (r.type === 'login' && !loginTime) loginTime = r.time;
    if (r.type === 'logout') logoutTime = r.time;
  }
  const idleRows = await exec('SELECT seconds FROM idle WHERE employeeId = ? AND date = ?', [targetId, today]);
  const idleSeconds = idleRows.length ? (idleRows[0].seconds || 0) : 0;
  let totalHours = 0; let otHours = 0;
  if (loginTime && logoutTime) {
    const calc = calculateOT(loginTime, logoutTime);
    totalHours = calc.totalHours; otHours = calc.otHours;
  }
  return { success: true, data: { date: today, loginTime, logoutTime, idleSeconds, totalHours, otHours } };
}

async function handleShiftSignOut(params) {
  const user = await authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };
  const now = new Date();
  const today = formatDateObj(now);

  const loginRows = await exec("SELECT time FROM attendance WHERE employeeId = ? AND date = ? AND type = 'login' ORDER BY id LIMIT 1", [user.employeeId, today]);
  if (!loginRows.length) return { success: false, error: 'No sign-in found for today' };
  const loginTime = loginRows[0].time;

  await db.execute('INSERT INTO attendance (employeeId, date, type, time, timestamp, note) VALUES (?,?,?,?,?,?)',
    [user.employeeId, today, 'logout', nowTimeStr(now), now.toISOString(), 'self-signout']);

  const calc = calculateOT(loginTime, nowTimeStr(now));
  return { success: true, data: { loginTime, logoutTime: nowTimeStr(now), totalHours: calc.totalHours, otHours: calc.otHours } };
}

async function handleReportIdle(params) {
  const user = await authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };
  const seconds = parseInt(params.seconds, 10);
  if (isNaN(seconds) || seconds <= 0 || seconds > 3600) return { success: false, error: 'Invalid idle seconds' };
  const today = formatDateObj(new Date());
  await db.execute(`INSERT INTO idle (employeeId, date, seconds, updatedAt) VALUES (?,?,?,?)
                    ON CONFLICT(employeeId, date) DO UPDATE SET seconds = seconds + excluded.seconds, updatedAt = excluded.updatedAt`,
    [user.employeeId, today, seconds, new Date().toISOString()]);
  const row = (await exec('SELECT seconds FROM idle WHERE employeeId = ? AND date = ?', [user.employeeId, today]))[0];
  return { success: true, data: { idleSeconds: row ? row.seconds : 0 } };
}

// ------------------------------------------------------------------
// PASSWORD RESET
// ------------------------------------------------------------------
async function handleRequestPasswordReset(params) {
  const username = String(params.username || '').trim();
  if (!username) return { success: false, error: 'Username/Employee ID is required' };
  const rows = await exec('SELECT employeeId, fullName, personalEmail, mobile FROM users WHERE employeeId = ? OR username = ?', [username, username]);
  if (!rows.length) return { success: false, error: 'No account found with that username/ID' };
  const user = rows[0];
  const tempPassword = crypto.randomBytes(4).toString('hex').toUpperCase();
  await db.execute('UPDATE users SET password = ? WHERE employeeId = ?', [hashPassword(tempPassword), String(user.employeeId)]);
  const resetId = String(Date.now());
  await db.execute('INSERT INTO password_resets (id, employeeId, token, expiresAt, used, createdAt) VALUES (?,?,?,?,?,?)',
    [resetId, String(user.employeeId), tempPassword, Date.now() + 3600000, 'false', new Date().toISOString()]);
  logAudit(String(user.employeeId), 'passwordReset', 'Temp password generated');
  return { success: true, data: { tempPassword, employeeId: String(user.employeeId), fullName: user.fullName || '' } };
}

// ------------------------------------------------------------------
// EMPLOYEE DASHBOARD
// ------------------------------------------------------------------
function getEmploymentStatus(doj) {
  if (!doj) return false;
  const today = new Date();
  const joining = new Date(doj);
  const months = (today.getFullYear() - joining.getFullYear()) * 12 + (today.getMonth() - joining.getMonth());
  return months >= CONFIG.PERMANENT_MONTHS;
}

async function getEmployeeSchedule(employeeId, days) {
  const today = new Date();
  const results = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const dateStr = formatDateObj(d);
    const rows = await exec('SELECT morning, evening, night FROM roster WHERE date = ?', [dateStr]);
    let assigned = '', shiftTime = '', shiftName = '';
    if (rows.length) {
      const r = rows[0];
      if (r.morning && String(r.morning).includes(String(employeeId))) { assigned = r.morning; shiftName = 'Morning'; shiftTime = '07:00'; }
      else if (r.evening && String(r.evening).includes(String(employeeId))) { assigned = r.evening; shiftName = 'Evening'; shiftTime = '15:00'; }
      else if (r.night && String(r.night).includes(String(employeeId))) { assigned = r.night; shiftName = 'Night'; shiftTime = '23:00'; }
    }
    const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
    results.push({ date: dateStr, day: dayName, shift: shiftName, shiftTime, assigned });
  }
  return results;
}

async function handleGetMyDashboard(params) {
  const user = await authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };
  const emp = await findEmployeeById(user.employeeId);
  if (!emp) return { success: false, error: 'Employee not found' };

  // Employment status
  const isPermanent = getEmploymentStatus(emp.dateOfJoining);

  // Leave balance
  const used = await getUsedLeaves(user.employeeId);
  const leaveBal = calculateLeaveBalance(emp.dateOfJoining, used.cl, used.sl, used.el);

  // OT summary
  const otRows = await exec('SELECT date, totalHours, otHours FROM ot_log WHERE employeeId = ? ORDER BY date DESC', [user.employeeId]);
  const totalOtHours = otRows.reduce((sum, r) => sum + (r.otHours || 0), 0);

  // Today's shift
  const today = formatDateObj(new Date());
  const todayAtt = await exec("SELECT type, time FROM attendance WHERE employeeId = ? AND date = ? ORDER BY id", [user.employeeId, today]);
  let loginTime = '', logoutTime = '';
  for (const r of todayAtt) {
    if (r.type === 'login' && !loginTime) loginTime = r.time;
    if (r.type === 'logout') logoutTime = r.time;
  }

  // Idle today
  const idleRows = await exec('SELECT seconds FROM idle WHERE employeeId = ? AND date = ?', [user.employeeId, today]);
  const idleSeconds = idleRows.length ? (idleRows[0].seconds || 0) : 0;

  // Duty hours calculation
  let totalHours = 0, otHours = 0;
  if (loginTime && logoutTime) {
    const calc = calculateOT(loginTime, logoutTime);
    totalHours = calc.totalHours;
    otHours = calc.otHours;
  }

  // Schedule for this week
  const schedule = await getEmployeeSchedule(user.employeeId, 7);

  return {
    success: true,
    data: {
      employee: emp,
      employmentStatus: isPermanent ? 'Permanent' : 'Probation',
      designation: emp.jobTitle || emp.role || 'Employee',
      leaveBalance: leaveBal,
      otSummary: { totalOtHours, recentLogs: otRows.slice(0, 10) },
      todayShift: { date: today, loginTime, logoutTime, totalHours, otHours, idleSeconds },
      schedule
    }
  };
}

// ------------------------------------------------------------------
// ROSTER CREATOR HANDLERS
// ------------------------------------------------------------------
async function handleCreateRosterEntry(params, authUser) {
  const date = String(params.date || '');
  const day = String(params.day || '');
  const morning = String(params.morning || '');
  const evening = String(params.evening || '');
  const night = String(params.night || '');
  if (!date) return { success: false, error: 'Date is required' };
  await db.execute('INSERT OR REPLACE INTO roster (date, day, morning, evening, night) VALUES (?,?,?,?,?)',
    [date, day, morning, evening, night]);
  logAudit(authUser.employeeId, 'createRoster', 'Created roster for ' + date);
  return { success: true };
}

async function handleUpdateRosterEntry(params, authUser) {
  const date = String(params.date || '');
  if (!date) return { success: false, error: 'Date is required' };
  const sets = []; const vals = [];
  for (const f of ['day', 'morning', 'evening', 'night']) {
    if (params[f] !== undefined) { sets.push(f + ' = ?'); vals.push(String(params[f])); }
  }
  if (!sets.length) return { success: false, error: 'No fields to update' };
  vals.push(date);
  await db.execute(`UPDATE roster SET ${sets.join(', ')} WHERE date = ?`, vals);
  logAudit(authUser.employeeId, 'updateRoster', 'Updated roster for ' + date);
  return { success: true };
}

async function handleDeleteRosterEntry(params, authUser) {
  const date = String(params.date || '');
  if (!date) return { success: false, error: 'Date is required' };
  await db.execute('DELETE FROM roster WHERE date = ?', [date]);
  logAudit(authUser.employeeId, 'deleteRoster', 'Deleted roster for ' + date);
  return { success: true };
}

// ------------------------------------------------------------------
// Routing
// ------------------------------------------------------------------
async function routeAction(action, params) {
  switch (action) {
    // Auth
    case 'login': return await handleLogin(params);
    case 'changePassword': return await handleChangePassword(params);
    case 'requestPasswordReset': return await handleRequestPasswordReset(params);
    case 'logout': return await handleLogout(params);
    case 'validateSession': return await handleValidateSession(params);

    // Employees
    case 'getAllEmployees': return await requireAdmin(params, handleGetAllEmployees);
    case 'getEmployee': return await handleGetEmployee(params);
    case 'createEmployee': return await requireAdmin(params, handleCreateEmployee);
    case 'updateEmployee': return await requireAdmin(params, handleUpdateEmployee);
    case 'deleteEmployee': return await requireSuperAdmin(params, handleDeleteEmployee);
    case 'setStatus': return await requireSuperAdmin(params, handleSetStatus);

    // Roster
    case 'getRoster': return await handleGetRoster(params);
    case 'uploadRoster': return await requireAdmin(params, handleUploadRoster);
    case 'createRosterEntry': return await requireSuperAdmin(params, handleCreateRosterEntry);
    case 'updateRosterEntry': return await requireSuperAdmin(params, handleUpdateRosterEntry);
    case 'deleteRosterEntry': return await requireSuperAdmin(params, handleDeleteRosterEntry);

    // Leave
    case 'getLeaveBalance': return await handleGetLeaveBalance(params);
    case 'applyLeave': return await handleApplyLeave(params);
    case 'approveLeave': return await requireAdmin(params, handleApproveLeave);
    case 'getLeaveRequests': return await handleGetLeaveRequests(params);

    // OT
    case 'logOT': return await requireAdmin(params, handleLogOT);
    case 'getOTLogs': return await handleGetOTLogs(params);

    // Notices
    case 'getNotices': return await handleGetNotices(params);
    case 'addNotice': return await requireAdmin(params, handleAddNotice);

    // Flash
    case 'getFlashMessages': return await handleGetFlashMessages(params);
    case 'addFlashMessage': return await requireAdmin(params, handleAddFlashMessage);
    case 'updateFlashMessage': return await requireAdmin(params, handleUpdateFlashMessage);
    case 'deleteFlashMessage': return await requireSuperAdmin(params, handleDeleteFlashMessage);

    // Pending
    case 'getPendingItems': return await handleGetPendingItems(params);
    case 'addPendingItem': return await handleAddPendingItem(params);
    case 'updatePendingItem': return await handleUpdatePendingItem(params);
    case 'resolvePendingItem': return await handleResolvePendingItem(params);
    case 'deletePendingItem': return await requireSuperAdmin(params, handleDeletePendingItem);

    // Attendance
    case 'getAttendance': return await handleGetAttendance(params);
    case 'updateAttendance': return await requireAdmin(params, handleUpdateAttendance);
    case 'recordAttendance': return await requireAdmin(params, handleRecordAttendance);
    case 'getAttendanceReport': return await requireAdmin(params, handleGetAttendanceReport);
    case 'getOTReport': return await requireAdmin(params, handleGetOTReport);

    // Shift & idle (new)
    case 'getTodayShift': return await handleGetTodayShift(params);
    case 'getMyDashboard': return await handleGetMyDashboard(params);
    case 'getMySchedule': return await handleGetMyDashboard(params);
    case 'shiftSignOut': return await handleShiftSignOut(params);
    case 'reportIdle': return await handleReportIdle(params);

    default: return { success: false, error: 'Unknown action: ' + action };
  }
}

// ------------------------------------------------------------------
// Seed from exported live data (only if DB is empty)
// ------------------------------------------------------------------
async function seedIfEmpty() {
  const count = (await exec('SELECT COUNT(*) AS c FROM users', []))[0].c;
  if (count > 0) return;

  console.log('[seed] Empty database — importing seed data...');

  // Password: 1101 keeps '1111'; everyone else defaults to employeeId (must-change on first login)
  const insertUser = db.prepare
    ? null
    : null;
  for (const emp of seedData.employees.data || []) {
    const rec = USER_COLUMNS.map(col => {
      if (col === 'password') return String(emp.employeeId) === CONFIG.ADMIN_ID ? hashPassword('1111') : hashPassword(String(emp.employeeId));
      const v = emp[col];
      return v === undefined || v === null ? '' : String(v);
    });
    await db.execute(`INSERT INTO users (${USER_COLUMNS.join(',')}) VALUES (${USER_COLUMNS.map(() => '?').join(',')})`, rec);
  }
  console.log('[seed] employees: ' + (seedData.employees.data || []).length);

  // Flash, notices, leave — preserve IDs
  for (const f of seedData.flash.data || []) {
    await db.execute('INSERT OR REPLACE INTO flash (id, text, active, createdBy, createdAt) VALUES (?,?,?,?,?)',
      [String(f.id), String(f.text), String(f.active), String(f.createdBy), String(f.createdAt)]);
  }
  console.log('[seed] flash: ' + (seedData.flash.data || []).length);

  for (const n of seedData.notices.data || []) {
    await db.execute('INSERT OR REPLACE INTO notices (id, icon, text, createdAt) VALUES (?,?,?,?)',
      [String(n.id), String(n.icon), String(n.text), String(n.createdAt)]);
  }
  console.log('[seed] notices: ' + (seedData.notices.data || []).length);

  for (const l of seedData.leave.data || []) {
    await db.execute(`INSERT OR REPLACE INTO leave_log (requestId, employeeId, leaveType, startDate, endDate, totalDays, reason, status, approvedBy, appliedOn, updatedAt)
                      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [String(l.requestId), String(l.employeeId), String(l.leaveType), String(l.startDate), String(l.endDate),
       parseInt(l.totalDays, 10) || 0, String(l.reason || ''), String(l.status), String(l.approvedBy || ''), String(l.appliedOn || ''), String(l.updatedAt || '')]);
  }
  console.log('[seed] leave: ' + (seedData.leave.data || []).length);

  // Attendance (map of employeeId -> rows[])
  let attTotal = 0;
  const att = seedData.attendance || {};
  for (const empId of Object.keys(att)) {
    for (const r of att[empId] || []) {
      await db.execute('INSERT INTO attendance (employeeId, date, type, time, timestamp, note) VALUES (?,?,?,?,?,?)',
        [String(r.employeeId || empId), String(r.date || ''), String(r.type || ''), String(r.time || ''), String(r.timestamp || ''), String(r.note || '')]);
      attTotal++;
    }
  }
  console.log('[seed] attendance: ' + attTotal);

  // Roster/pending/otlogs may be empty — that's fine
  for (const r of seedData.roster.data || []) {
    await db.execute('INSERT OR REPLACE INTO roster (date, day, morning, evening, night) VALUES (?,?,?,?,?)',
      [String(r.date), String(r.day || ''), String(r.morning || ''), String(r.evening || ''), String(r.night || '')]);
  }
  console.log('[seed] roster: ' + (seedData.roster.data || []).length);
  for (const p of seedData.pending.data || []) {
    await db.execute('INSERT OR REPLACE INTO pending (id, text, assignedTo, assignedEmployeeIds, completed, resolverId, resolvedAt, createdBy, createdAt) VALUES (?,?,?,?,?,?,?,?,?)',
      [String(p.id), String(p.text), String(p.assignedTo || 'everyone'), '', String(p.completed || 'false'), '', '', String(p.createdBy || ''), String(p.createdAt || '')]);
  }
  console.log('[seed] pending: ' + (seedData.pending.data || []).length);
  for (const o of seedData.otlogs.data || []) {
    await db.execute('INSERT INTO ot_log (date, employeeId, rosterStart, actualIn, actualOut, totalHours, otHours, lateMinutes, isLate, enteredBy, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [String(o.date), String(o.employeeId), String(o.rosterStart || ''), String(o.actualIn || ''), String(o.actualOut || ''),
       o.totalHours || 0, o.otHours || 0, o.lateMinutes || 0, String(o.isLate || 'false'), String(o.enteredBy || ''), String(o.createdAt || '')]);
  }
  console.log('[seed] otlogs: ' + (seedData.otlogs.data || []).length);

  console.log('[seed] Done.');
}

// Exposed to platform wrappers
module.exports = {
  init, connect, initSchema, seedIfEmpty, routeAction,
  exec, savePhoto, readPhoto, hashPassword, formatDateObj, nowTimeStr
};
