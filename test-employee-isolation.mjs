// Verify Employee-role data isolation
const API = 'http://localhost:3000/api';

async function api(action, extra = {}, token) {
  const body = { action, ...extra };
  if (token) body.token = token;
  const resp = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(body)
  });
  return resp.json();
}

// Login as employee 1371 (default password = employee ID)
const login = await api('login', { username: '1371', password: '1371' });
if (!login.success) { console.log('LOGIN FAILED', login); process.exit(1); }
const T = login.data.token;
console.log('Logged in as:', login.data.user.fullName, '| role:', login.data.user.role, '| mustChangePassword:', login.data.mustChangePassword);
console.log('');

const tests = [
  // [name, action, params, expectSuccess, note]
  ['own profile',          'getEmployee',          { employeeId: '1371' }, true],
  ['OTHER profile (1101)', 'getEmployee',          { employeeId: '1101' }, false],
  ['employee directory',   'getAllEmployees',      {},                   false],
  ['own leave balance',    'getLeaveBalance',      { employeeId: '1371' }, true],
  ['OTHER leave balance',  'getLeaveBalance',      { employeeId: '1452' }, false],
  ['own leave requests',   'getLeaveRequests',     {},                   true],
  ['own attendance',       'getAttendance',        { employeeId: '1371' }, true],
  ['OTHER attendance',     'getAttendance',        { employeeId: '1452' }, false],
  ['attendance REPORT',    'getAttendanceReport',  { month: 8, year: 2026 }, false],
  ['OT report',            'getOTReport',          { month: 8, year: 2026 }, false],
  ['own OT logs',          'getOTLogs',            { employeeId: '1371' }, true],
  ['OTHER OT logs',        'getOTLogs',            { employeeId: '1452' }, false],
  ['own today shift',      'getTodayShift',        {},                   true],
  ['OTHER today shift',    'getTodayShift',        { employeeId: '1452' }, false],
  ['apply leave for OTHER','applyLeave',           { employeeId: '1452', leaveType: 'CL', startDate: '2026-08-10', endDate: '2026-08-10' }, false],
  ['approve leave (admin)','approveLeave',         { requestId: 'x', decision: 'approve' }, false],
  ['create employee',      'createEmployee',       { employeeData: { fullName: 'hack' } }, false],
  ['upload roster',        'uploadRoster',         { csvText: 'a,b\n1,2' }, false],
  ['add notice',           'addNotice',            { text: 'hack' },     false],
  ['delete flash',         'deleteFlashMessage',   { id: '1' },          false],
  ['set status',           'setStatus',            { employeeId: '1452', status: 'Terminated' }, false],
  ['roster view (shared)', 'getRoster',            {},                   true],
  ['notices view (shared)','getNotices',           {},                   true],
  ['pending items (filtered)','getPendingItems',   {},                   true],
];

let ok = 0, bad = 0;
for (const [name, action, params, expectOk] of tests) {
  const r = await api(action, params, T);
  const pass = r.success === expectOk;
  pass ? ok++ : bad++;
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name.padEnd(26) + ' -> success:' + r.success + (r.error ? ' ("' + r.error + '")' : ''));
  // extra check: own leave requests must only contain 1371
  if (name === 'own leave requests' && r.success) {
    const onlyOwn = r.data.every(x => String(x.employeeId) === '1371');
    console.log(onlyOwn ? '      ✓ contains ONLY own requests' : '      ✗ LEAK: contains other employees!');
    onlyOwn ? ok++ : bad++;
  }
}
console.log('\n===== ' + ok + ' correct, ' + bad + ' wrong =====');
process.exit(bad ? 1 : 0);
