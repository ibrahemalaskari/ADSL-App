import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateSales, parseRouterBytes, parseRouterLocalDate, parseRouterUptime, readRouterSales } from '../core/sales.js';

const routerKey = '192.168.88.1|Falcon';

test('مبيعات User Manager: تحليل تاريخ RouterOS المحلي دون تحويل المنطقة الزمنية', () => {
  assert.deepEqual(parseRouterLocalDate('nov/22/2026 18:30:00'), { day: '2026-11-22', startedAt: '2026-11-22 18:30:00' });
  assert.deepEqual(parseRouterLocalDate('2026-11-22'), { day: '2026-11-22', startedAt: '2026-11-22 00:00:00' });
  for (const value of ['nov/31/2026 18:30:00', '2026-13-01', '2026-02-29', 'bad', null]) assert.equal(parseRouterLocalDate(value), null);
});

test('مبيعات User Manager: تحليل البايتات ومدة الجلسة مع رفض القيم غير المفهومة', () => {
  assert.equal(parseRouterBytes('1048576'), 1048576);
  assert.equal(parseRouterBytes('0'), 0);
  for (const value of ['-1', 'NaN', '1.5', '9007199254740992', '']) assert.equal(parseRouterBytes(value), null);
  assert.equal(parseRouterUptime('1w2d3h4m5s'), 788645);
  assert.equal(parseRouterUptime('01:02:03'), 3723);
  assert.equal(parseRouterUptime('1d2h'), 93600);
  assert.equal(parseRouterUptime('3d04:05:06'), 273906);
  assert.equal(parseRouterUptime('01:99:99'), null);
  assert.equal(parseRouterUptime('bad'), null);
});

test('تجميع المبيعات: جلسات المستخدم الواحد تُجمع، والمعرّفات المكررة لا تضاعف الحركة', () => {
  const sessions = [
    { '.id': '*2', user: 'voucher-A', 'from-time': 'nov/22/2026 11:00:00', 'nas-port-id': 'ether2', download: '200', upload: '30', uptime: '1h' },
    { '.id': '*1', user: 'voucher-A', 'from-time': 'nov/22/2026 10:00:00', 'nas-port-id': 'ether2', download: '100', upload: '20', uptime: '30m' },
    { '.id': '*1', user: 'voucher-A', 'from-time': 'nov/22/2026 10:00:00', download: '100', upload: '20', uptime: '30m' },
    { '.id': '*3', user: 'voucher-B', 'from-time': 'nov/22/2026 12:00:00', download: '10', uptime: '10m' },
  ];
  const users = [
    { username: 'voucher-A', profile: '100RY' },
    { username: 'voucher-B', profile: 'unknown' },
  ];
  const out = aggregateSales({ sessions, users, routerKey });
  assert.equal(out.records.length, 2);
  const a = out.records.find(x => x.username === 'voucher-A');
  const b = out.records.find(x => x.username === 'voucher-B');
  assert.equal(a.profile, '100RY');
  assert.equal(a.saleDay, '2026-11-22');
  assert.equal(a.startedAt, '2026-11-22 10:00:00');
  assert.equal(a.sessionCount, 2);
  assert.equal(a.downloadBytes, 300);
  assert.equal(a.uploadBytes, 50);
  assert.equal(a.uptimeSeconds, 5400);
  assert.equal(b.uploadBytes, 0, 'القيمة الناقصة لا تُحسب واحداً كما في السلوك القديم');
  assert.equal(b.trafficComplete, false, 'الصفر البديل لا يُعرض كقراءة مكتملة');
  assert.equal(b.durationComplete, true);
  assert.equal(out.summary.vouchers, 2);
  assert.equal(out.summary.sessions, 3);
  assert.equal(out.summary.unpriced, 2);
  assert.ok(out.warnings.some(x => x.includes('مكررة')));
  assert.ok(out.warnings.some(x => x.includes('ناقصة')));
});

test('تجميع المبيعات: السعر محلي حسب الباقة، والباقة المجهولة تبقى غير مسعّرة', () => {
  const out = aggregateSales({
    routerKey,
    sessions: [
      { '.id': '*1', user: 'u1', 'from-time': 'nov/22/2026 10:00:00', download: '10', upload: '2', uptime: '1m' },
      { '.id': '*2', user: 'u2', 'from-time': 'nov/22/2026 11:00:00', download: '10', upload: '2', uptime: '1m' },
    ],
    users: [{ username: 'u1', 'actual-profile': '100RY' }, { username: 'u2', 'actual-profile': 'not-mapped' }],
    profilePrices: { '100RY': '100' },
  });
  assert.equal(out.records.find(x => x.username === 'u1').price, 100);
  assert.equal(out.records.find(x => x.username === 'u2').price, null);
  assert.deepEqual(out.profiles, ['100RY', 'not-mapped']);
});

test('قارئ مبيعات User Manager يطلب قائمة الحقول الضرورية فقط ويترك كلمة المرور وبيانات الاتصال الحساسة', async () => {
  const calls = [];
  const c = { async talk(path, args) {
    calls.push({ path, args });
    if (path.endsWith('/session/print')) return { rows: [{ '.id': '*1', user: 'safe-user', 'from-time': 'nov/22/2026 10:00:00', 'nas-port-id': 'ether2', download: '10', upload: '2', uptime: '1m' }] };
    return { rows: [{ '.id': '*2', username: 'safe-user', 'actual-profile': '100RY', password: 'SHOULD_NOT_BE_READ', 'caller-id': 'AA:BB' }] };
  } };
  const out = await readRouterSales(c, { routerKey });
  assert.equal(out.records.length, 1);
  assert.deepEqual(calls.map(x => x.path), ['/tool/user-manager/session/print', '/tool/user-manager/user/print']);
  assert.equal(calls[0].args['.proplist'], '.id,user,from-time,nas-port-id,download,upload,uptime');
  assert.equal(calls[1].args['.proplist'], '.id,username,actual-profile');
  assert.equal(JSON.stringify(out).includes('SHOULD_NOT_BE_READ'), false);
  assert.equal(JSON.stringify(out).includes('AA:BB'), false);
});
