import http from 'http';

function post(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname: 'localhost', port: 3000, path: '/api', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } }); });
    req.on('error', reject); req.write(data); req.end();
  });
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// Login
let SA_TOKEN, EMP_TOKEN;
test('login super admin', async () => {
  const r = await post({ action: 'login', username: '1101', password: '1111' });
  SA_TOKEN = r.data.token;
  return r.success === true;
});

test('login employee', async () => {
  const r = await post({ action: 'login', username: '1452', password: '1452' });
  EMP_TOKEN = r.data.token;
  return r.success === true;
});

// Password reset
test('requestPasswordReset', async () => {
  const r = await post({ action: 'requestPasswordReset', username: '1452' });
  return r.success === true && r.data.tempPassword.length === 8;
});

test('requestPasswordReset unknown user', async () => {
  const r = await post({ action: 'requestPasswordReset', username: '9999' });
  return r.success === false && r.error.includes('No account found');
});

// Employee dashboard
test('getMyDashboard (admin)', async () => {
  const r = await post({ action: 'getMyDashboard', token: SA_TOKEN });
  return r.success === true && r.data.employmentStatus === 'Permanent' && r.data.designation === 'Super Admin';
});

test('getMyDashboard (employee)', async () => {
  const r = await post({ action: 'getMyDashboard', token: EMP_TOKEN });
  return r.success === true && r.data.leaveBalance !== undefined && r.data.schedule.length === 7;
});

// Roster creator
test('createRosterEntry', async () => {
  const r = await post({ action: 'createRosterEntry', token: SA_TOKEN, date: '2026-08-03', day: 'Monday', morning: '1101 1452', evening: '1371', night: '' });
  return r.success === true;
});

test('getRoster (verify)', async () => {
  const r = await post({ action: 'getRoster', token: SA_TOKEN });
  return r.success === true && r.data.some(d => d.date === '2026-08-03');
});

test('updateRosterEntry', async () => {
  const r = await post({ action: 'updateRosterEntry', token: SA_TOKEN, date: '2026-08-03', morning: '1101 1452 1371' });
  return r.success === true;
});

test('deleteRosterEntry (employee should fail)', async () => {
  const r = await post({ action: 'deleteRosterEntry', token: EMP_TOKEN, date: '2026-08-03' });
  return r.success === false && r.error.includes('super admin');
});

test('deleteRosterEntry (admin)', async () => {
  const r = await post({ action: 'deleteRosterEntry', token: SA_TOKEN, date: '2026-08-03' });
  return r.success === true;
});

// Enhanced pending items
test('addPendingItem specific', async () => {
  const r = await post({ action: 'addPendingItem', token: SA_TOKEN, text: 'Test task', assignedTo: 'specific', assignedEmployeeIds: '1452,1371' });
  return r.success === true;
});

test('getPendingItems (filtered for employee)', async () => {
  const r = await post({ action: 'getPendingItems', token: EMP_TOKEN });
  // Employee 1452 should see the specific item
  return r.success === true && r.data.some(d => d.text === 'Test task');
});

test('resolvePendingItem', async () => {
  const items = await post({ action: 'getPendingItems', token: SA_TOKEN });
  const id = items.data[items.data.length - 1].id;
  const r = await post({ action: 'resolvePendingItem', token: EMP_TOKEN, id: id, completed: 'true' });
  if (!r.success) return false;
  const verify = await post({ action: 'getPendingItems', token: SA_TOKEN });
  const item = verify.data.find(d => d.id === id);
  return item.completed === 'true' && item.resolverId === '1452' && item.resolvedAt !== '';
});

// Leave balance with probation note
test('getLeaveBalance employee', async () => {
  const r = await post({ action: 'getLeaveBalance', token: SA_TOKEN, employeeId: '1452' });
  return r.success === true && r.data.isPermanent !== undefined;
});

// Run all tests
let passed = 0, failed = 0;
for (const t of tests) {
  try {
    const result = await t.fn();
    if (result) { passed++; console.log(`  PASS  ${t.name}`); }
    else { failed++; console.log(`  FAIL  ${t.name}`); }
  } catch (e) { failed++; console.log(`  ERROR ${t.name}: ${e.message}`); }
}
console.log(`\n${passed} passed, ${failed} failed out of ${tests.length} tests`);
