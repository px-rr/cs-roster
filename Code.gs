// ============================================================
// CS ROSTER MANAGER - Google Apps Script Backend
// ============================================================

// --- CONFIGURATION ---
var CONFIG = {
  ADMIN_ID: '1101',
  ADMIN_PASS: '1101',
  SESSION_TTL_MINUTES: 480,
  MAX_CL: 12,
  MAX_SL: 6,
  MAX_EL: 6,
  PERMANENT_MONTHS: 6,
  SHIFT_HOURS: 8,
  MIN_OT_HOURS: 1
};

var SHEETS = {
  USERS: 'Users',
  LEAVE_LOG: 'LeaveLog',
  OT_LOG: 'OTLog',
  ROSTER: 'Roster',
  NOTICES: 'Notices',
  SESSIONS: 'Sessions',
  AUDIT: 'AuditLog'
};

// ============================================================
// ENTRY POINTS
// ============================================================

function doGet() {
  return HtmlService.createHtmlOutput('<h2>CS Roster API</h2><p>Running.</p>');
}

function doPost(e) {
  var output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);

  try {
    var params = JSON.parse(e.postData.contents);
    var action = params.action || '';
    var result = routeAction(action, params);
    output.setContent(JSON.stringify(result));
  } catch (err) {
    output.setContent(JSON.stringify({ success: false, error: err.toString() }));
  }

  return output;
}

// ============================================================
// ROUTING
// ============================================================

function routeAction(action, params) {
  switch (action) {

    // Auth
    case 'login': return handleLogin(params);
    case 'changePassword': return handleChangePassword(params);
    case 'logout': return handleLogout(params);
    case 'validateSession': return handleValidateSession(params);

    // Employees
    case 'getAllEmployees': return requireAdmin(params, handleGetAllEmployees);
    case 'getEmployee': return handleGetEmployee(params);
    case 'createEmployee': return requireAdmin(params, handleCreateEmployee);
    case 'updateEmployee': return requireAdmin(params, handleUpdateEmployee);
    case 'deleteEmployee': return requireSuperAdmin(params, handleDeleteEmployee);
    case 'setStatus': return requireSuperAdmin(params, handleSetStatus);

    // Roster
    case 'getRoster': return handleGetRoster(params);
    case 'uploadRoster': return requireAdmin(params, handleUploadRoster);

    // Leave
    case 'getLeaveBalance': return handleGetLeaveBalance(params);
    case 'applyLeave': return handleApplyLeave(params);
    case 'approveLeave': return requireAdmin(params, handleApproveLeave);
    case 'getLeaveRequests': return handleGetLeaveRequests(params);

    // OT
    case 'logOT': return requireAdmin(params, handleLogOT);
    case 'getOTLogs': return handleGetOTLogs(params);

    // Notices
    case 'getNotices': return handleGetNotices(params);
    case 'addNotice': return requireAdmin(params, handleAddNotice);

    // Setup
    case 'setup': return handleSetup();

    default: return { success: false, error: 'Unknown action: ' + action };
  }
}

// ============================================================
// AUTH MIDDLEWARE
// ============================================================

function authenticate(params) {
  if (!params || !params.token) return null;
  var session = validateSession(params.token);
  if (!session) return null;
  return findEmployeeById(session.employeeId);
}

function requireAdmin(params, handler) {
  var user = authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };
  if (!isAdminRole(user.role)) return { success: false, error: 'Unauthorized' };
  return handler(params, user);
}

function requireSuperAdmin(params, handler) {
  var user = authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };
  if (user.employeeId !== CONFIG.ADMIN_ID) return { success: false, error: 'Only super admin can perform this action' };
  return handler(params, user);
}

// ============================================================
// AUTH HANDLERS
// ============================================================

function handleLogin(params) {
  var username = String(params.username || '').trim();
  var password = String(params.password || '').trim();

  var sheet = getSheet(SHEETS.USERS);
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var userRow = null;

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === username || String(data[i][1]) === username) {
      userRow = data[i];
      break;
    }
  }

  if (!userRow) return { success: false, error: 'User not found' };

  var storedHash = String(userRow[2]);
  var inputHash = hashPassword(password);

  if (storedHash !== inputHash) return { success: false, error: 'Invalid password' };

  var status = String(userRow[4]);
  if (status === 'Terminated' || status === 'Resigned') {
    return { success: false, error: 'Account is ' + status.toLowerCase() };
  }

  var token = generateToken();
  storeSession(token, String(userRow[0]));

  var isDefaultPw = (hashPassword(String(userRow[0])) === storedHash);

  return {
    success: true,
    data: {
      token: token,
      mustChangePassword: isDefaultPw,
      user: buildUserObject(headers, userRow)
    }
  };
}

function handleChangePassword(params) {
  var user = authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };

  var oldPwd = (params.oldPassword || '').toString();
  var newPwd = (params.newPassword || '').toString();

  if (newPwd.length < 4) return { success: false, error: 'Password must be at least 4 characters' };

  var sheet = getSheet(SHEETS.USERS);
  var rowIndex = findUserRow(user.employeeId);
  if (!rowIndex) return { success: false, error: 'User not found' };

  var currentHash = sheet.getRange(rowIndex, 3).getValue();
  if (currentHash !== hashPassword(oldPwd)) return { success: false, error: 'Current password is incorrect' };

  sheet.getRange(rowIndex, 3).setValue(hashPassword(newPwd));
  return { success: true };
}

function handleLogout(params) {
  if (params.token) removeSession(params.token);
  return { success: true };
}

function handleValidateSession(params) {
  var user = authenticate(params);
  if (!user) return { success: false };
  return {
    success: true,
    data: { user: user }
  };
}

// ============================================================
// EMPLOYEE HANDLERS
// ============================================================

function handleGetAllEmployees(params, authUser) {
  var sheet = getSheet(SHEETS.USERS);
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var employees = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][4] !== 'Deleted') {
      employees.push(buildUserObject(headers, data[i]));
    }
  }
  return { success: true, data: employees };
}

function handleGetEmployee(params) {
  var user = authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };

  var targetId = params.employeeId || user.employeeId;

  // Regular employees can only view themselves
  if (user.employeeId !== targetId && !isAdminRole(user.role)) {
    return { success: false, error: 'Unauthorized' };
  }

  var employee = findEmployeeById(targetId);
  if (!employee) return { success: false, error: 'Employee not found' };

  return { success: true, data: employee };
}

function handleCreateEmployee(params, authUser) {
  var data = params.employeeData || {};
  var photoBase64 = params.photoBase64 || '';

  var sheet = getSheet(SHEETS.USERS);
  var headers = sheet.getDataRange().getValues()[0];

  var employeeId = data.employeeId || getNextId().toString();
  var username = data.username || employeeId;
  var password = hashPassword(employeeId);
  var role = data.role || 'Employee';
  var status = data.status || 'Active';

  // Check for duplicate
  var existing = findEmployeeById(employeeId);
  if (existing) return { success: false, error: 'Employee ID already exists' };

  var photoUrl = '';
  if (photoBase64) {
    photoUrl = uploadPhotoToDrive(photoBase64, 'emp_' + employeeId + '.jpg');
  }

  var row = [];
  for (var c = 0; c < headers.length; c++) {
    var h = headers[c];
    switch (h) {
      case 'employeeId': row.push(employeeId); break;
      case 'username': row.push(username); break;
      case 'password': row.push(password); break;
      case 'role': row.push(role); break;
      case 'status': row.push(status); break;
      case 'photoUrl': row.push(photoUrl); break;
      case 'createdAt': row.push(new Date().toISOString()); break;
      case 'updatedAt': row.push(new Date().toISOString()); break;
      default:
        row.push(data[h] !== undefined ? data[h] : '');
    }
  }

  sheet.appendRow(row);
  logAudit(authUser.employeeId, 'createEmployee', 'Created employee ' + employeeId);

  return { success: true, data: { employeeId: employeeId } };
}

function handleUpdateEmployee(params, authUser) {
  var targetId = (params.employeeId || '').toString();
  var data = params.employeeData || {};
  var photoBase64 = params.photoBase64 || '';

  var sheet = getSheet(SHEETS.USERS);
  var rowIndex = findUserRow(targetId);
  if (!rowIndex) return { success: false, error: 'Employee not found' };

  var headers = sheet.getDataRange().getValues()[0];

  if (photoBase64) {
    var photoUrl = uploadPhotoToDrive(photoBase64, 'emp_' + targetId + '.jpg');
    data.photoUrl = photoUrl;
  }

  for (var h in data) {
    if (h === 'employeeId' || h === 'password' || h === 'createdAt') continue;
    var colIndex = headers.indexOf(h);
    if (colIndex >= 0) {
      sheet.getRange(rowIndex, colIndex + 1).setValue(data[h]);
    }
  }

  var updatedAtCol = headers.indexOf('updatedAt');
  if (updatedAtCol >= 0) {
    sheet.getRange(rowIndex, updatedAtCol + 1).setValue(new Date().toISOString());
  }

  logAudit(authUser.employeeId, 'updateEmployee', 'Updated employee ' + targetId);
  return { success: true };
}

function handleDeleteEmployee(params, authUser) {
  var targetId = (params.employeeId || '').toString();
  if (targetId === CONFIG.ADMIN_ID) return { success: false, error: 'Cannot delete super admin' };

  var sheet = getSheet(SHEETS.USERS);
  var rowIndex = findUserRow(targetId);
  if (!rowIndex) return { success: false, error: 'Employee not found' };

  var headers = sheet.getDataRange().getValues()[0];
  var statusCol = headers.indexOf('status');
  if (statusCol >= 0) {
    sheet.getRange(rowIndex, statusCol + 1).setValue('Deleted');
  }

  logAudit(authUser.employeeId, 'deleteEmployee', 'Deleted employee ' + targetId);
  return { success: true };
}

function handleSetStatus(params, authUser) {
  var targetId = (params.employeeId || '').toString();
  var newStatus = (params.status || 'Active').toString();

  var sheet = getSheet(SHEETS.USERS);
  var rowIndex = findUserRow(targetId);
  if (!rowIndex) return { success: false, error: 'Employee not found' };

  var headers = sheet.getDataRange().getValues()[0];
  var statusCol = headers.indexOf('status');
  if (statusCol >= 0) {
    sheet.getRange(rowIndex, statusCol + 1).setValue(newStatus);
  }

  logAudit(authUser.employeeId, 'setStatus', 'Set employee ' + targetId + ' status to ' + newStatus);
  return { success: true };
}

// ============================================================
// ROSTER HANDLERS
// ============================================================

function handleGetRoster(params) {
  var user = authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };

  var sheet = getSheet(SHEETS.ROSTER);
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return { success: true, data: [] };

  var headers = data[0];
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var row = {};
    for (var j = 0; j < headers.length; j++) {
      row[headers[j]] = data[i][j];
    }
    rows.push(row);
  }
  return { success: true, data: rows };
}

function handleUploadRoster(params, authUser) {
  var csvText = params.csvText || '';
  if (!csvText) return { success: false, error: 'No CSV data provided' };

  var parsed = parseCSV(csvText);
  if (parsed.length < 2) return { success: false, error: 'CSV must have at least a header row and one data row' };

  var sheet = getSheet(SHEETS.ROSTER);
  sheet.clearContents();

  // Write headers
  var headers = parsed[0];
  for (var j = 0; j < headers.length; j++) {
    sheet.getRange(1, j + 1).setValue(headers[j]);
  }

  // Write data rows
  for (var i = 1; i < parsed.length; i++) {
    for (var j = 0; j < parsed[i].length; j++) {
      sheet.getRange(i + 1, j + 1).setValue(parsed[i][j]);
    }
  }

  logAudit(authUser.employeeId, 'uploadRoster', 'Uploaded roster with ' + (parsed.length - 1) + ' rows');
  return { success: true, data: { rows: parsed.length - 1 } };
}

// ============================================================
// LEAVE HANDLERS
// ============================================================

function handleGetLeaveBalance(params) {
  var user = authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };

  var targetId = params.employeeId || user.employeeId;
  var employee = findEmployeeById(targetId);
  if (!employee) return { success: false, error: 'Employee not found' };

  var usedLeaves = getUsedLeaves(targetId);
  var balance = calculateLeaveBalance(employee.dateOfJoining, usedLeaves.cl, usedLeaves.sl, usedLeaves.el);

  return { success: true, data: balance };
}

function handleApplyLeave(params) {
  var user = authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };

  var targetId = params.employeeId || user.employeeId;
  var leaveType = (params.leaveType || '').toString();
  var startDate = (params.startDate || '').toString();
  var endDate = (params.endDate || '').toString();
  var reason = (params.reason || '').toString();

  if (!leaveType || !startDate || !endDate) {
    return { success: false, error: 'Leave type, start date, and end date are required' };
  }

  if (['CL', 'SL', 'EL'].indexOf(leaveType) < 0) {
    return { success: false, error: 'Invalid leave type. Must be CL, SL, or EL' };
  }

  var start = new Date(startDate);
  var end = new Date(endDate);
  if (end < start) return { success: false, error: 'End date must be after start date' };

  var totalDays = Math.floor((end - start) / (1000 * 60 * 60 * 24)) + 1;

  // Check balance
  var employee = findEmployeeById(targetId);
  var used = getUsedLeaves(targetId);
  var balance = calculateLeaveBalance(employee.dateOfJoining, used.cl, used.sl, used.el);
  var availKey = leaveType.toLowerCase();
  if (balance[availKey] < totalDays) {
    return { success: false, error: 'Insufficient ' + leaveType + ' balance. Available: ' + balance[availKey] + ', Requested: ' + totalDays };
  }

  var sheet = getSheet(SHEETS.LEAVE_LOG);
  var requestId = 'LR-' + new Date().getTime();

  sheet.appendRow([
    requestId, targetId, leaveType, startDate, endDate,
    totalDays, reason, 'Pending', (user.employeeId === targetId ? '' : user.employeeId),
    new Date().toISOString(), ''
  ]);

  return { success: true, data: { requestId: requestId } };
}

function handleApproveLeave(params, authUser) {
  var requestId = (params.requestId || '').toString();
  var action = (params.action || 'approve').toString(); // approve or reject
  var approvalNote = params.note || '';

  var sheet = getSheet(SHEETS.LEAVE_LOG);
  var data = sheet.getDataRange().getValues();
  var rowIndex = -1;

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === requestId) {
      rowIndex = i + 1;
      break;
    }
  }

  if (rowIndex < 0) return { success: false, error: 'Leave request not found' };

  var newStatus = (action === 'approve') ? 'Approved' : 'Rejected';
  sheet.getRange(rowIndex, 8).setValue(newStatus);
  sheet.getRange(rowIndex, 9).setValue(authUser.employeeId);
  sheet.getRange(rowIndex, 11).setValue(new Date().toISOString());

  logAudit(authUser.employeeId, action + 'Leave', requestId + ' ' + approvalNote);
  return { success: true };
}

function handleGetLeaveRequests(params) {
  var user = authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };

  var sheet = getSheet(SHEETS.LEAVE_LOG);
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return { success: true, data: [] };

  var headers = data[0];
  var rows = [];

  for (var i = 1; i < data.length; i++) {
    // Employees see only their own; admin/1101 see all
    if (user.role === 'Employee' && String(data[i][1]) !== String(user.employeeId)) continue;
    var row = {};
    for (var j = 0; j < headers.length; j++) {
      row[headers[j]] = data[i][j];
    }
    rows.push(row);
  }

  // Sort newest first
  rows.sort(function(a, b) { return b.appliedOn > a.appliedOn ? 1 : -1; });

  return { success: true, data: rows };
}

// ============================================================
// OT HANDLERS
// ============================================================

function handleLogOT(params, authUser) {
  var targetId = (params.employeeId || '').toString();
  var logDate = (params.date || '').toString();
  var actualIn = (params.actualIn || '').toString();
  var actualOut = (params.actualOut || '').toString();
  var rosterStart = (params.rosterStart || '').toString();

  if (!targetId || !logDate || !actualIn || !actualOut) {
    return { success: false, error: 'Employee ID, date, actual in/out are required' };
  }

  var employee = findEmployeeById(targetId);
  if (!employee) return { success: false, error: 'Employee not found' };

  var calc = calculateOT(actualIn, actualOut);

  var sheet = getSheet(SHEETS.OT_LOG);
  sheet.appendRow([
    logDate, targetId, rosterStart, actualIn, actualOut,
    calc.totalHours, calc.otHours, calc.lateMinutes || 0, calc.isLate || false,
    authUser.employeeId, new Date().toISOString()
  ]);

  return { success: true, data: calc };
}

function handleGetOTLogs(params) {
  var user = authenticate(params);
  if (!user) return { success: false, error: 'Authentication required' };

  var targetId = params.employeeId || user.employeeId;
  var filterDate = params.date || '';

  // Employees see only their own
  if (user.role === 'Employee' && targetId !== user.employeeId) {
    return { success: false, error: 'Unauthorized' };
  }

  var sheet = getSheet(SHEETS.OT_LOG);
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return { success: true, data: [] };

  var headers = data[0];
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][1]) !== String(targetId)) continue;
    if (filterDate && String(data[i][0]) !== String(filterDate)) continue;

    var row = {};
    for (var j = 0; j < headers.length; j++) {
      row[headers[j]] = data[i][j];
    }
    rows.push(row);
  }

  rows.sort(function(a, b) { return b.date > a.date ? 1 : -1; });
  return { success: true, data: rows };
}

// ============================================================
// NOTICES HANDLERS
// ============================================================

function handleGetNotices(params) {
  var sheet = getSheet(SHEETS.NOTICES);
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return { success: true, data: [] };

  var headers = data[0];
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var row = {};
    for (var j = 0; j < headers.length; j++) {
      row[headers[j]] = data[i][j];
    }
    rows.push(row);
  }
  return { success: true, data: rows };
}

function handleAddNotice(params, authUser) {
  var text = (params.text || '').toString();
  var icon = (params.icon || 'info').toString();
  if (!text) return { success: false, error: 'Notice text is required' };

  var sheet = getSheet(SHEETS.NOTICES);
  sheet.appendRow([new Date().getTime().toString(), icon, text, new Date().toISOString()]);
  return { success: true };
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

var SESSION_CACHE = null;

function getSessionCache() {
  if (!SESSION_CACHE) SESSION_CACHE = CacheService.getScriptCache();
  return SESSION_CACHE;
}

function generateToken() {
  return Utilities.getUuid();
}

function storeSession(token, employeeId) {
  var cache = getSessionCache();
  var data = JSON.stringify({
    employeeId: String(employeeId),
    createdAt: new Date().toISOString()
  });
  cache.put(token, data, CONFIG.SESSION_TTL_MINUTES * 60);
}

function validateSession(token) {
  var cache = getSessionCache();
  var data = cache.get(token);
  if (!data) return null;
  return JSON.parse(data);
}

function removeSession(token) {
  var cache = getSessionCache();
  cache.remove(token);
}

// ============================================================
// HELPER: SHEETS
// ============================================================

function getSheet(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  return sheet;
}

function findUserRow(employeeId) {
  var sheet = getSheet(SHEETS.USERS);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0].toString() === employeeId.toString()) {
      return i + 1;
    }
  }
  return null;
}

function findEmployeeById(id) {
  var sheet = getSheet(SHEETS.USERS);
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0].toString() === id.toString() && data[i][4] !== 'Deleted') {
      return buildUserObject(headers, data[i]);
    }
  }
  return null;
}

function buildUserObject(headers, row) {
  var obj = {};
  for (var j = 0; j < headers.length; j++) {
    obj[headers[j]] = (j < row.length) ? row[j] : '';
  }
  delete obj.password;
  return obj;
}

function getNextId() {
  var sheet = getSheet(SHEETS.USERS);
  var data = sheet.getDataRange().getValues();
  var maxId = 1000;
  for (var i = 1; i < data.length; i++) {
    var id = parseInt(data[i][0], 10);
    if (!isNaN(id) && id > maxId) maxId = id;
  }
  return maxId + 1;
}

function isAdminRole(role) {
  return role === 'Admin' || role === 'HR' || role === 'Accounts' || role === 'Super Admin';
}

// ============================================================
// HELPER: PASSWORD HASHING
// ============================================================

function hashPassword(pwd) {
  pwd = String(pwd);
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    pwd,
    Utilities.Charset.UTF_8
  );
  var hex = '';
  for (var i = 0; i < digest.length; i++) {
    var byte = digest[i];
    if (byte < 0) byte += 256;
    hex += ('0' + byte.toString(16)).slice(-2);
  }
  return hex;
}

// ============================================================
// HELPER: LEAVE CALCULATION
// ============================================================

function calculateLeaveBalance(doj, usedCL, usedSL, usedEL) {
  if (!doj) {
    return { cl: 0, sl: 0, el: 0, total: 0, isPermanent: false, permDate: null };
  }

  var today = new Date();
  var joiningDate = new Date(doj);

  var permDate = new Date(joiningDate);
  permDate.setMonth(permDate.getMonth() + CONFIG.PERMANENT_MONTHS);

  if (today < permDate) {
    return {
      cl: 0, sl: 0, el: 0, total: 0,
      isPermanent: false,
      permDate: permDate.toISOString().split('T')[0]
    };
  }

  var monthsSincePerm = (today.getFullYear() - permDate.getFullYear()) * 12 +
    (today.getMonth() - permDate.getMonth());
  if (today.getDate() < permDate.getDate()) monthsSincePerm--;

  monthsSincePerm = monthsSincePerm + 1; // Month 1 = first month
  if (monthsSincePerm < 1) monthsSincePerm = 1;

  var clEarned = Math.min(monthsSincePerm, CONFIG.MAX_CL);
  var slEarned = Math.min(Math.floor(monthsSincePerm / 2), CONFIG.MAX_SL);
  var elEarned = Math.min(Math.floor(monthsSincePerm / 2), CONFIG.MAX_EL);

  usedCL = usedCL || 0;
  usedSL = usedSL || 0;
  usedEL = usedEL || 0;

  return {
    cl: Math.max(0, clEarned - usedCL),
    sl: Math.max(0, slEarned - usedSL),
    el: Math.max(0, elEarned - usedEL),
    totalEarned: clEarned + slEarned + elEarned,
    usedCL: usedCL,
    usedSL: usedSL,
    usedEL: usedEL,
    total: Math.max(0, (clEarned - usedCL) + (slEarned - usedSL) + (elEarned - usedEL)),
    isPermanent: true,
    permDate: permDate.toISOString().split('T')[0],
    monthsSincePermanent: monthsSincePerm,
    clMax: CONFIG.MAX_CL,
    slMax: CONFIG.MAX_SL,
    elMax: CONFIG.MAX_EL
  };
}

function getUsedLeaves(employeeId) {
  var sheet = getSheet(SHEETS.LEAVE_LOG);
  var data = sheet.getDataRange().getValues();
  var used = { cl: 0, sl: 0, el: 0 };

  for (var i = 1; i < data.length; i++) {
    if (data[i][1].toString() === employeeId.toString() && data[i][7] === 'Approved') {
      var type = data[i][2];
      var days = parseInt(data[i][5], 10) || 1;
      if (type === 'CL') used.cl += days;
      else if (type === 'SL') used.sl += days;
      else if (type === 'EL') used.el += days;
    }
  }
  return used;
}

// ============================================================
// HELPER: OT CALCULATION
// ============================================================

function calculateOT(actualIn, actualOut) {
  var partsIn = actualIn.split(':');
  var partsOut = actualOut.split(':');

  var baseDate = '2000-01-01';
  var inTime = new Date(baseDate + 'T' + actualIn + ':00');
  var outTime = new Date(baseDate + 'T' + actualOut + ':00');

  if (outTime <= inTime) {
    outTime.setDate(outTime.getDate() + 1);
  }

  var totalMs = outTime.getTime() - inTime.getTime();
  var totalHours = totalMs / (1000 * 60 * 60);

  var otHours = Math.max(0, totalHours - CONFIG.SHIFT_HOURS);
  var lateMinutes = 0;

  if (otHours < CONFIG.MIN_OT_HOURS) {
    otHours = 0;
  } else {
    otHours = Math.floor(otHours);
  }

  return {
    totalHours: Math.round(totalHours * 100) / 100,
    otHours: otHours
  };
}

// ============================================================
// HELPER: PHOTO UPLOAD
// ============================================================

function uploadPhotoToDrive(base64, filename) {
  try {
    var folderId = PropertiesService.getScriptProperties().getProperty('PHOTO_FOLDER_ID');
    var folder;

    if (folderId) {
      try { folder = DriveApp.getFolderById(folderId); } catch (e) { folder = null; }
    }

    if (!folder) {
      folder = DriveApp.createFolder('CS_Roster_Photos');
      PropertiesService.getScriptProperties().setProperty('PHOTO_FOLDER_ID', folder.getId());
    }

    var bytes = Utilities.base64Decode(base64);
    var blob = Utilities.newBlob(bytes, 'image/jpeg', filename);
    var file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return file.getUrl();
  } catch (e) {
    return '';
  }
}

// ============================================================
// HELPER: CSV PARSING
// ============================================================

function parseCSV(csvText) {
  var lines = csvText.split('\n');
  var result = [];

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;

    // Simple CSV parsing (handles quoted values)
    var values = [];
    var current = '';
    var inQuotes = false;

    for (var j = 0; j < line.length; j++) {
      var ch = line[j];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    values.push(current.trim());
    result.push(values);
  }

  return result;
}

// ============================================================
// HELPER: AUDIT LOG
// ============================================================

function logAudit(employeeId, action, details) {
  try {
    var sheet = getSheet(SHEETS.AUDIT);
    sheet.appendRow([new Date().getTime().toString(), employeeId, action, details, new Date().toISOString()]);
  } catch (e) {
    // Silent fail for audit
  }
}

// ============================================================
// SETUP FUNCTION - Run once to initialize sheets
// ============================================================

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Create admin user sheet
  var usersSheet = getSheet(SHEETS.USERS);
  var userHeaders = [
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

  // Clear and set headers
  usersSheet.clear();
  for (var j = 0; j < userHeaders.length; j++) {
    usersSheet.getRange(1, j + 1).setValue(userHeaders[j]);
  }
  // Force text format on ID/username columns to prevent auto-conversion to numbers
  usersSheet.getRange('A:B').setNumberFormat('@');

  // Create admin user
  var adminRow = [];
  for (var j = 0; j < userHeaders.length; j++) {
    var h = userHeaders[j];
    switch (h) {
      case 'employeeId': adminRow.push(CONFIG.ADMIN_ID); break;
      case 'username': adminRow.push(CONFIG.ADMIN_ID); break;
      case 'password': adminRow.push(hashPassword(CONFIG.ADMIN_PASS)); break;
      case 'role': adminRow.push('Super Admin'); break;
      case 'status': adminRow.push('Active'); break;
      case 'fullName': adminRow.push('System Administrator'); break;
      case 'jobTitle': adminRow.push('Super Admin'); break;
      case 'dateOfJoining': adminRow.push('2024-01-01'); break;
      case 'createdAt': adminRow.push(new Date().toISOString()); break;
      case 'updatedAt': adminRow.push(new Date().toISOString()); break;
      default: adminRow.push('');
    }
  }
  usersSheet.appendRow(adminRow);

  // Create other sheets
  var leaveSheet = getSheet(SHEETS.LEAVE_LOG);
  leaveSheet.clear();
  leaveSheet.getRange(1, 1, 1, 11).setValues([[
    'requestId', 'employeeId', 'leaveType', 'startDate', 'endDate',
    'totalDays', 'reason', 'status', 'approvedBy', 'appliedOn', 'updatedAt'
  ]]);

  var otSheet = getSheet(SHEETS.OT_LOG);
  otSheet.clear();
  otSheet.getRange(1, 1, 1, 11).setValues([[
    'date', 'employeeId', 'rosterStart', 'actualIn', 'actualOut',
    'totalHours', 'otHours', 'lateMinutes', 'isLate', 'enteredBy', 'createdAt'
  ]]);

  var rosterSheet = getSheet(SHEETS.ROSTER);
  rosterSheet.clear();
  rosterSheet.getRange(1, 1, 1, 5).setValues([[
    'date', 'day', 'morning', 'evening', 'night'
  ]]);

  var noticesSheet = getSheet(SHEETS.NOTICES);
  noticesSheet.clear();
  noticesSheet.getRange(1, 1, 1, 4).setValues([[
    'id', 'icon', 'text', 'createdAt'
  ]]);

  var sessionsSheet = getSheet(SHEETS.SESSIONS);
  sessionsSheet.clear();
  sessionsSheet.getRange(1, 1, 1, 4).setValues([[
    'token', 'employeeId', 'createdAt', 'expiresAt'
  ]]);

  var auditSheet = getSheet(SHEETS.AUDIT);
  auditSheet.clear();
  auditSheet.getRange(1, 1, 1, 5).setValues([[
    'logId', 'employeeId', 'action', 'details', 'timestamp'
  ]]);

  // Create photo folder
  var folder = DriveApp.createFolder('CS_Roster_Photos');
  PropertiesService.getScriptProperties().setProperty('PHOTO_FOLDER_ID', folder.getId());

  return {
    success: true,
    message: 'Setup complete. Admin account created (ID: ' + CONFIG.ADMIN_ID + '). Sheets and photo folder initialized.'
  };
}

function handleSetup() {
  return setup();
}
