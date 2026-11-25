// اختبارات أداة فحص اليوزر مانجر. الراوتر هنا وهمي (test/um-fake.js)، فهذه اختبارات منطق وبروتوكول
// تثبت الإخفاء والقراءة فقط والتعامل مع الأخطاء، ولا تثبت أن RouterOS الحقيقي يعرض هذه القوائم.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { RouterOSClient, SentenceParser, encodeSentence } from '../core/routeros-api.js';
import {
  probeUserManager, scrubSecrets, isHiddenKey, isShowableKey, UM_TABLES, SAMPLE_SIZE,
} from '../core/usermanager.js';
import { NetTransport } from '../tools/net-transport.mjs';
import { MemTransport } from './helpers.js';
import { fakeUmHandler, makeUmData, FAKE_PASS_PREFIX } from './um-fake.js';

const USER_PATH = UM_TABLES.user.path;
const SESSION_PATH = UM_TABLES.session.path;

async function connected(handlerOpts, clientOpts) {
  const t = new MemTransport(fakeUmHandler(handlerOpts));
  const c = new RouterOSClient(t, { timeoutMs: 600, ...clientOpts });
  await c.connect({ host: '192.168.88.1' });
  await c.login('reader', 'secret');
  return { t, c };
}

const noLeaks = (text, extra = []) => {
  assert.ok(!text.includes(FAKE_PASS_PREFIX), 'كلمة مرور ظهرت');
  assert.ok(!/u00\d{5}/.test(text), 'اسم مستخدم ظهر');
  assert.ok(!text.includes('AA:BB:CC'), 'عنوان MAC ظهر');
  assert.ok(!/\b10\.9\.\d+\.\d+/.test(text), 'عنوان IP لمستخدم ظهر');
  for (const s of extra) assert.ok(!text.includes(s), `ظهر: ${s}`);
};

// ج11: يثبّت المسارات كما في أوامر console المنشورة لـ v6. كان مساران خاطئين (القيود تحت /limitation،
// وربط الباقة بالقيد تحت /profile/limitation) لأن الراوتر الوهمي كُتب من التقدير نفسه فلم يكشف الخطأ.
// هذا الاختبار لا يثبت أن الراوتر الحقيقي يقبلها؛ يمنع فقط رجوع الخطأ المعروف.
test('مسارات القوائم تطابق قائمة /tool user-manager في v6', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(UM_TABLES).map(([k, v]) => [k, v.path])), {
    profile: '/tool/user-manager/profile/print',
    limitation: '/tool/user-manager/profile/limitation/print',
    profileLimitation: '/tool/user-manager/profile/profile-limitation/print',
    user: '/tool/user-manager/user/print',
    session: '/tool/user-manager/session/print',
  });
});

test('الجلسات: أمثلة التوقيت (from-time وtill-time) تظهر دون هوية المستخدم', async () => {
  const { c } = await connected();
  const { report, text } = await probeUserManager(c);
  const ex = report.tables.session.examples;
  assert.equal(ex['from-time'], 'nov/22/2026 18:00:00');
  assert.equal(ex['till-time'], 'nov/22/2026 19:00:00');
  assert.ok(!('user' in ex) && !('calling-station-id' in ex) && !('user-ip' in ex) && !('host-ip' in ex));
  assert.match(text, /user-ip\*/, 'ج11: user-ip كان يظهر بلا نجمة في التقرير الحقيقي'); // الراوتر الحقيقي يعرض user-ip وhost-ip في الجلسات
  assert.match(text, /host-ip\*/);
  assert.match(text, /from-time=nov\/22\/2026 18:00:00/);
  noLeaks(text);
});

test('تصنيف الحقول: السرّي والهوية محجوبة، والمسموح قائمة بيضاء', () => {
  for (const k of ['password', 'username', 'caller-id', 'ip-address', 'wireless-psk', 'shared-secret', 'comment', 'customer', 'calling-station-id', 'user', 'user-ip', 'host-ip']) {
    assert.equal(isHiddenKey(k), true, k);
    assert.equal(isShowableKey(k), false, k);
  }
  for (const k of ['actual-profile', 'download-used', 'upload-used', 'uptime-used', 'last-seen', 'active-sessions', 'disabled', 'incomplete', 'started', 'status', 'from-time', 'till-time']) {
    assert.equal(isShowableKey(k), true, k);
  }
  for (const k of ['name', 'transfer-limit', 'validity', 'price']) assert.equal(isHiddenKey(k), false, k);
  assert.equal(isShowableKey('some-unknown-field'), false, 'المجهول لا تُعرض قيمه');
});

test('فحص كامل: القوائم والأعداد والحقول والتوزيع حسب الباقة وملخص الباقات', async () => {
  const { c } = await connected();
  const { report, text } = await probeUserManager(c, { now: () => new Date('2026-11-23T00:00:00Z') });
  for (const k of Object.keys(UM_TABLES)) assert.equal(report.tables[k].status, 'ok', k);
  assert.equal(report.package.found, true);
  assert.equal(report.package.version, '6.47.6');
  assert.equal(report.tables.user.count, 120);
  assert.equal(report.tables.session.count, 40);
  assert.equal(report.tables.user.sampleSize, SAMPLE_SIZE);
  assert.ok(report.tables.user.keys.includes('password'), 'اسم الحقل يظهر، وقيمته لا');
  assert.ok(report.tables.user.keys.includes('actual-profile'));
  const agg = report.tables.user.aggregate;
  assert.equal(agg.profileKey, 'actual-profile');
  assert.equal(agg.byProfile.length, 4);
  assert.equal(agg.byProfile.reduce((s, x) => s + x.count, 0), 120);
  assert.ok(agg.byProfile.every((x) => x.count === 30));
  assert.equal(agg.stats['download-used'].sum, 1000 * (119 * 120 / 2));
  assert.equal(agg.stats['download-used'].max, 119000);
  assert.deepEqual(agg.stats['active-sessions'].values, [{ value: '0', count: 108 }, { value: '1', count: 12 }]);
  const s = Object.fromEntries(report.profileSummary.map((x) => [x.name, x]));
  assert.equal(s['250جيب'].users, 30);
  assert.equal(s['250جيب'].limitations[0].name, '250RY');
  assert.equal(s['250جيب'].limitations[0].fields['transfer-limit'], '838860800');
  assert.match(text, /250جيب/);
  assert.match(text, /transfer-limit=838860800/);
  assert.match(text, /نجحت قراءتها: 5 من 5/);
  assert.ok(!/owner=|customer=|username=|password=/.test(text), 'حقول الهوية والسرّ لا تُعرض كقيم');
  assert.match(text, /owner\*/, 'اسم الحقل المحجوب يظهر بنجمة');
  noLeaks(text);
});

test('قراءة فقط: لا أمر غير print، ولا يُطلب أي حقل حساس، والعيّنة لا تتجاوز الحد', async () => {
  const { t, c } = await connected();
  const before = t.written.length;
  await probeUserManager(c);
  const sent = t.written.slice(before);
  for (const w of sent) assert.match(w[0], /\/print$/, `أمر غير قراءة: ${w[0]}`);
  // لا قراءة كاملة غير مفلترة لقائمتي المستخدمين والجلسات في الوضع العادي
  for (const p of [USER_PATH, SESSION_PATH]) {
    for (const w of sent.filter((x) => x[0] === p)) {
      const filtered = w.some((x) => x.startsWith('=.proplist=')) || w.some((x) => x.startsWith('?.id='));
      assert.ok(filtered, `قراءة غير مفلترة لـ ${p}`);
    }
  }
  // كل مجموعة حقول مطلوبة صراحةً من قائمة المستخدمين خالية من الحساسة
  for (const w of sent.filter((x) => x[0] === USER_PATH)) {
    const pl = w.find((x) => x.startsWith('=.proplist='));
    if (!pl) continue;
    for (const k of pl.slice('=.proplist='.length).split(',').filter((k) => k !== '.id')) {
      assert.equal(isHiddenKey(k), false, `طُلب حقل حساس: ${k}`);
    }
  }
  const sampleQueries = sent.filter((x) => x[0] === USER_PATH && x.some((y) => y.startsWith('?.id=')));
  assert.ok(sampleQueries.length > 0 && sampleQueries.length <= SAMPLE_SIZE);
});

test('--full-sample: قراءة كاملة صريحة لكن النص يبقى بلا أسرار', async () => {
  const { t, c } = await connected();
  const before = t.written.length;
  const { text } = await probeUserManager(c, { fullSample: true });
  const sent = t.written.slice(before);
  assert.ok(sent.some((w) => w[0] === USER_PATH && !w.some((x) => x.startsWith('=.proplist=') || x.startsWith('?'))), 'حدثت قراءة كاملة صريحة');
  assert.match(text, /عيّنة كاملة/);
  noLeaks(text);
});

test('الحزمة أو المسارات غير معروفة: كل قائمة تفشل بسبب مفهوم ولا يُرمى استثناء', async () => {
  const { c } = await connected({ missing: true, noPackage: true });
  const { report, text } = await probeUserManager(c);
  assert.equal(report.package.found, false);
  for (const t of Object.values(report.tables)) {
    assert.equal(t.status, 'error');
    assert.equal(t.code, 'TRAP');
    assert.match(t.hint, /غير مثبّتة|لا يعرض/);
  }
  assert.match(text, /نجحت قراءتها: 0 من 5/);
  assert.match(text, /no such command/);
});

test('صلاحيات غير كافية على قائمة واحدة: تفشل هي فقط والباقي يكمل', async () => {
  const { c } = await connected({ deny: [USER_PATH] });
  const { report, text } = await probeUserManager(c);
  assert.equal(report.tables.user.status, 'error');
  assert.equal(report.tables.user.code, 'PERMISSION_DENIED');
  assert.match(report.tables.user.hint, /صلاحيات/);
  for (const k of ['profile', 'limitation', 'profileLimitation', 'session']) assert.equal(report.tables[k].status, 'ok', k);
  assert.equal(report.profileSummary.length, 4);
  assert.equal(report.profileSummary[0].users, null, 'عدد المستخدمين غير معروف، وليس صفراً');
  assert.match(text, /نجحت قراءتها: 4 من 5/);
});

test('انقطاع الاتصال أثناء الفحص => استثناء ولا تقرير جزئي', async () => {
  const { c } = await connected({ dropOn: SESSION_PATH });
  await assert.rejects(() => probeUserManager(c), (e) => e.code === 'CONNECTION_CLOSED');
});

test('قوائم فارغة: تُعرض فارغة صراحةً، بلا صفوف مختلقة', async () => {
  const data = makeUmData({ users: 0, sessions: 0 });
  data.profiles = []; data.limitations = []; data.profileLimitations = [];
  const { c } = await connected({ data });
  const { report, text } = await probeUserManager(c);
  for (const t of Object.values(report.tables)) { assert.equal(t.status, 'ok'); assert.equal(t.count, 0); }
  assert.equal(report.profileSummary, null);
  assert.equal((text.match(/القائمة فارغة/g) || []).length, 5);
});

test('الاستعلام بالمعرّف غير متاح: تنبيه واضح، وبلا قراءة كاملة تلقائية وبلا أسرار', async () => {
  const { t, c } = await connected({ noIdQuery: true });
  const before = t.written.length;
  const { report, text } = await probeUserManager(c);
  assert.equal(report.tables.user.sampleSize, 0);
  assert.deepEqual(report.tables.user.keys, []);
  assert.match(report.tables.user.warning, /--full-sample/);
  assert.equal(report.tables.user.aggregate, undefined);
  const sent = t.written.slice(before);
  assert.ok(!sent.some((w) => w[0] === USER_PATH && !w.some((x) => x.startsWith('=.proplist=') || x.startsWith('?'))), 'لا قراءة كاملة تلقائية');
  noLeaks(text);
});

test('شبكة الأمان: القيم السرّية التي رآها الفحص (وكلمة مرور الراوتر) تُحجب إن ظهرت في النص', async () => {
  // خلل مفترض: حقل مسموح (last-seen) يحمل كلمة المرور، وقيد اسمه يطابق كلمة مرور الراوتر المُدخلة
  const data = makeUmData();
  data.limitations[0].name = 'router-login-pw-77';
  const { c } = await connected({ data, userMutate: (u) => ({ ...u, 'last-seen': u.password }) });
  const { report, text } = await probeUserManager(c, { secrets: ['router-login-pw-77'] });
  assert.ok(!text.includes(FAKE_PASS_PREFIX));
  assert.ok(!text.includes('router-login-pw-77'));
  assert.ok(report.scrubbed >= 2);
  assert.match(text, /\*\*\*/);
  assert.match(text, /حُجبت \d+ قيمة/);
});

test('scrubSecrets: الطويل أينما ورد، والقصير كوحدة كاملة، وما دون 4 أحرف يُترك', () => {
  const r = scrubSecrets('pw=ABCDEFG; word abcd, xabcdx, ab', new Set(['ABCDEFG', 'abcd', 'ab']));
  assert.equal(r.text, 'pw=***; word ***, xabcdx, ab');
  assert.equal(r.count, 2);
  assert.equal(scrubSecrets('a.b*c(1)x', new Set(['a.b*c(1)'])).text, '***x', 'محارف regex تُعامل نصاً');
});

// ------------------------------------------------ Transport حقيقي فوق TCP (الراوتر وهمي)

function startFakeServer(handler) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      const parser = new SentenceParser(); const ctx = {};
      sock.on('data', (d) => {
        for (const words of parser.push(new Uint8Array(d))) {
          const out = handler(words, ctx);
          if (out === 'close') { sock.destroy(); continue; }
          for (const s of out || []) sock.write(encodeSentence(s));
        }
      });
      sock.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('NetTransport فوق TCP حقيقي: تسجيل دخول وفحص كامل بلا أسرار', async () => {
  const server = await startFakeServer(fakeUmHandler());
  const port = server.address().port;
  const c = new RouterOSClient(new NetTransport({ allowedPorts: [port] }), { timeoutMs: 5000 });
  try {
    await c.connect({ host: '127.0.0.1', port });
    await c.login('reader', 'secret');
    const { report, text } = await probeUserManager(c, { secrets: ['secret'] });
    assert.equal(report.tables.user.count, 120);
    assert.equal(report.tables.session.status, 'ok');
    noLeaks(text);
  } finally { await c.close(); server.close(); }
});

test('NetTransport: يرفض العناوين العامة والمنافذ غير المسموحة وSSL، ويميّز رفض الاتصال', async () => {
  await assert.rejects(() => new NetTransport().open({ host: '8.8.8.8', port: 8728 }), (e) => e.code === 'BAD_ADDRESS');
  await assert.rejects(() => new NetTransport().open({ host: '192.168.1.1', port: 22 }), (e) => e.code === 'CONNECT_FAILED');
  await assert.rejects(() => new NetTransport().open({ host: '192.168.1.1', port: 8729, tls: true }), (e) => e.code === 'CONNECT_FAILED');
  const s = await startFakeServer(() => []);
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  await assert.rejects(() => new NetTransport({ allowedPorts: [port] }).open({ host: '127.0.0.1', port }), (e) => e.code === 'PORT_REFUSED');
});
