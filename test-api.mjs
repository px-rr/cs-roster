// End-to-end API test for the standalone CS Roster server
const API = 'http://localhost:3000/api';
let TOKEN = null;
let passed = 0, failed = 0;

async function api(action, extra = {}) {
  const body = { action, ...extra };
  if (TOKEN) body.token = TOKEN;
  const resp = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(body)
  });
  return resp.json();
}

function check(name, cond, detail = '') {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? ' -> ' + detail : '')); }
}

// 1. Static frontend
const home = await fetch('http://localhost:3000/');
check('GET / serves frontend', home.status === 200 && (await home.text()).includes('Employee Portal'));

// 2. Login (bad then good)
const bad = await api('login', { username: '1101', password: 'wrong' });
check('login rejects wrong password', bad.success === false);
const login = await api('login', { username: '1101', password: '1111' });
check('login works', login.success === true && !!login.data.token);
TOKEN = login.data.token;
check('login returns user object', login.data.user.fullName === 'Muntasir Mehdi' && login.data.user.role === 'Super Admin');

// 3. Session
const vs = await api('validateSession');
check('validateSession', vs.success === true && vs.data.user.employeeId === '1101');

// 4. Employees
const emps = await api('getAllEmployees');
check('getAllEmployees (4 seeded)', emps.success && emps.data.length === 4);
const emp = await api('getEmployee', { employeeId: '1452' });
check('getEmployee', emp.success && emp.data.fullName === 'Fariha Rahman Tanha');

// 5. Roster (empty now), then upload, then read
const roster0 = await api('getRoster');
check('getRoster (empty)', roster0.success === true);
const csv = 'date,day,morning,evening,night\n2026-08-02,Sunday,"1452,1371","2026",OFF\n2026-08-03,Monday,"1452","1371","2026"';
const up = await api('uploadRoster', { csvText: csv });
check('uploadRoster', up.success && up.data.rows === 2, JSON.stringify(up));
const roster1 = await api('getRoster');
check('getRoster after upload', roster1.success && roster1.data.length === 2);

// 6. Leave
const bal = await api('getLeaveBalance', { employeeId: '1101' });
check('getLeaveBalance', bal.success && typeof bal.data.cl === 'number');
const apply = await api('applyLeave', { leaveType: 'CL', startDate: '2026-08-10', endDate: '2026-08-11', reason: 'test leave' });
check('applyLeave', apply.success && !!apply.data.requestId, JSON.stringify(apply));
const leaves = await api('getLeaveRequests');
check('getLeaveRequests', leaves.success && leaves.data.length >= 3);
if (apply.success) {
  const ap = await api('approveLeave', { requestId: apply.data.requestId, decision: 'approve' });
  check('approveLeave', ap.success === true);
}

// 7. OT log
const ot = await api('logOT', { employeeId: '1452', date: '2026-08-01', actualIn: '07:00', actualOut: '18:00', rosterStart: '07:00' });
check('logOT (11h -> 3h OT)', ot.success && ot.data.totalHours === 11 && ot.data.otHours === 3, JSON.stringify(ot));
const otlogs = await api('getOTLogs', { employeeId: '1452' });
check('getOTLogs', otlogs.success && otlogs.data.length === 1);

// 8. Notices
const notice = await api('addNotice', { text: 'standalone test notice', icon: 'info' });
check('addNotice', notice.success === true);
const notices = await api('getNotices');
check('getNotices', notices.success && notices.data.length === 6);

// 9. Flash
const flash = await api('addFlashMessage', { text: 'test flash' });
check('addFlashMessage', flash.success === true);
const flashes = await api('getFlashMessages');
check('getFlashMessages', flashes.success && flashes.data.length === 4);
const flashUpd = await api('updateFlashMessage', { id: flashes.data[3].id, active: 'false' });
check('updateFlashMessage', flashUpd.success === true);
const flashDel = await api('deleteFlashMessage', { id: flashes.data[3].id });
check('deleteFlashMessage', flashDel.success === true);

// 10. Pending items
const pend = await api('addPendingItem', { text: 'test pending', assignedTo: '' });
check('addPendingItem', pend.success === true);
const pendList = await api('getPendingItems');
check('getPendingItems', pendList.success && pendList.data.length === 1);
const pendUpd = await api('updatePendingItem', { id: pendList.data[0].id, completed: 'true' });
check('updatePendingItem', pendUpd.success === true);
const pendDel = await api('deletePendingItem', { id: pendList.data[0].id });
check('deletePendingItem', pendDel.success === true);

// 11. Shift flow: today shift (login was auto-recorded), idle, sign out
const shift1 = await api('getTodayShift');
check('getTodayShift has auto login', shift1.success && !!shift1.data.loginTime, JSON.stringify(shift1));
const idle1 = await api('reportIdle', { seconds: 45 });
check('reportIdle 45s', idle1.success && idle1.data.idleSeconds === 45, JSON.stringify(idle1));
const idle2 = await api('reportIdle', { seconds: 30 });
check('reportIdle accumulates (75)', idle2.success && idle2.data.idleSeconds === 75);
const signout = await api('shiftSignOut');
check('shiftSignOut', signout.success && !!signout.data.logoutTime, JSON.stringify(signout));
const shift2 = await api('getTodayShift');
check('getTodayShift after signout (hours calc)', shift2.success && shift2.data.totalHours > 0 && shift2.data.idleSeconds === 75);

// 12. Attendance
const att = await api('getAttendance', { employeeId: '1101' });
check('getAttendance', att.success && att.data.length > 0);
const rep = await api('getAttendanceReport', { employeeId: '1452', month: 8, year: 2026 });
check('getAttendanceReport (31 days + idle field)', rep.success && rep.data.length === 31 && rep.data[0].idleSeconds !== undefined);
const repAll = await api('getAttendanceReport', { month: 8, year: 2026 });
check('getAttendanceReport all employees', repAll.success && Object.keys(repAll.data).length === 3);
const otRep = await api('getOTReport', { month: 8, year: 2026 });
check('getOTReport', otRep.success === true);
const manLog = await api('recordAttendance', { employeeId: '1371', date: '2026-08-01', loginTime: '07:05', logoutTime: '16:10' });
check('recordAttendance (manual)', manLog.success === true);
const updAtt = await api('updateAttendance', { rowIndex: 1, field: 'note', value: 'test-edit' });
check('updateAttendance', updAtt.success === true);

// 13. Employee create/update/status/delete
const newEmp = await api('createEmployee', { employeeData: { fullName: 'Test Person', dateOfJoining: '2026-08-01', mobile: '01700000000' } });
check('createEmployee (auto id)', newEmp.success && !!newEmp.data.employeeId, JSON.stringify(newEmp));
if (newEmp.success) {
  const nid = newEmp.data.employeeId;
  const upd = await api('updateEmployee', { employeeId: nid, employeeData: { department: 'CS', jobTitle: 'Agent' } });
  check('updateEmployee', upd.success === true);
  const st = await api('setStatus', { employeeId: nid, status: 'Probation' });
  check('setStatus', st.success === true);
  const loginNew = await api('login', { username: nid, password: nid });
  check('new employee default login + mustChangePassword', loginNew.success && loginNew.data.mustChangePassword === true);
  const del = await api('deleteEmployee', { employeeId: nid });
  check('deleteEmployee (soft)', del.success === true);
}

// 14. changePassword flow on admin (change then revert)
const cp = await api('changePassword', { oldPassword: '1111', newPassword: 'newpass123' });
check('changePassword', cp.success === true, JSON.stringify(cp));
const relog = await api('login', { username: '1101', password: 'newpass123' });
check('login with new password', relog.success === true);
TOKEN = relog.data.token || TOKEN;
const cpBack = await api('changePassword', { oldPassword: 'newpass123', newPassword: '1111abcd' });
check('change password again', cpBack.success === true);
const relog2 = await api('login', { username: '1101', password: '1111abcd' });
check('login with reverted password', relog2.success === true);
TOKEN = relog2.data.token || TOKEN;

// 15. Logout records attendance
const lo = await api('logout');
check('logout', lo.success === true);

console.log('\n===== RESULT: ' + passed + ' passed, ' + failed + ' failed =====');
process.exit(failed > 0 ? 1 : 0);
