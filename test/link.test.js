import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../bridge/server.js';
import { fakeUmHandler, makeUmData, FAKE_USER_PREFIX, FAKE_PASS_PREFIX } from './um-fake.js';
import { isLocalPage, detectBridge, validateRouterForm, testRouterConnection, syncRouterCards, syncRouterSales, LINK_VERSION } from '../www/link.js';
import { MemTransport, fakeRouterHandler, trap, done, re } from './helpers.js';
import { RosError, RouterOSClient } from '../core/routeros-api.js';
import { readCards } from '../core/cardsreader.js';
import { mergeReadings } from '../core/cards.js';

const okFetch = (body, init = {}) => async () => ({ ok: init.ok !== false, status: init.status || 200, json: async () => body });

test('link: الاستيراد في Node بلا أثر جانبي ولا يحتاج window', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(LINK_VERSION, 4);
});

test('link: isLocalPage يقبل localhost و127.0.0.1 على http فقط', () => {
  assert.equal(isLocalPage({ protocol: 'http:', hostname: '127.0.0.1' }), true);
  assert.equal(isLocalPage({ protocol: 'http:', hostname: 'localhost' }), true);
  assert.equal(isLocalPage({ protocol: 'https:', hostname: 'localhost' }), false);
  assert.equal(isLocalPage({ protocol: 'http:', hostname: '192.168.1.5' }), false);
  assert.equal(isLocalPage({ protocol: 'file:', hostname: '' }), false);
  assert.equal(isLocalPage(null), false);
});

test('link: detectBridge يميّز النجاح والردود الخاطئة دون أن يرمي استثناءً', async () => {
  assert.deepEqual(await detectBridge({ fetchImpl: okFetch({ ok: true }) }), { available: true });
  assert.deepEqual(await detectBridge({ fetchImpl: okFetch({ ok: false }) }), { available: false, reason: 'BAD_REPLY' });
  assert.deepEqual(await detectBridge({ fetchImpl: okFetch(null) }), { available: false, reason: 'BAD_REPLY' });
  assert.deepEqual(await detectBridge({ fetchImpl: okFetch({}, { ok: false, status: 404 }) }), { available: false, reason: 'HTTP_404' });
  assert.deepEqual(await detectBridge({ fetchImpl: async () => { throw new TypeError('failed'); } }), { available: false, reason: 'UNREACHABLE' });
  assert.deepEqual(await detectBridge({}), { available: false, reason: 'NO_FETCH' });
});

test('link: detectBridge ينهي الانتظار بمهلة ويرجع TIMEOUT', async () => {
  const hang = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const t0 = Date.now();
  assert.deepEqual(await detectBridge({ fetchImpl: hang, timeoutMs: 60 }), { available: false, reason: 'TIMEOUT' });
  assert.ok(Date.now() - t0 < 1500);
});

test('link: على الجسر الحقيقي يعمل الكشف، وبعد إيقافه يرجع UNREACHABLE', async () => {
  const bridge = createBridge({ port: 0, allowedPorts: null });
  const port = await bridge.start();
  const base = `http://127.0.0.1:${port}`;
  assert.deepEqual(await detectBridge({ fetchImpl: fetch, base }), { available: true });
  await bridge.stop();
  assert.deepEqual(await detectBridge({ fetchImpl: fetch, base }), { available: false, reason: 'UNREACHABLE' });
});

// ---------------------------------------------------------------- المرحلة 2: اختبار الاتصال (راوتر وهمي، لا RouterOS حقيقي)

const READ_ONLY_CMDS = new Set(['/login', '/system/resource/print', '/system/identity/print', '/system/clock/print', '/ip/service/print']);
const mk = (handlerOpts = {}, wrap) => {
  const base = fakeRouterHandler({ user: 'reader', pass: 'secret', ...handlerOpts });
  const t = new MemTransport(wrap ? (w, ctx) => wrap(w, ctx, base) : base);
  return { t, factory: () => t };
};
const args = (over = {}) => ({ host: '192.168.88.1', port: '8728', user: 'reader', password: 'secret', ...over });

test('link: validateRouterForm يتحقق من العنوان والمنفذ والمستخدم ويقبل الأرقام العربية', () => {
  assert.deepEqual(validateRouterForm({ host: ' 192.168.088.001 ', port: '', user: ' admin ' }), { ok: true, host: '192.168.88.1', port: 8728, user: 'admin' });
  assert.deepEqual(validateRouterForm({ host: '١٩٢.١٦٨.١٠٨.١', port: '٨٧٢٨', user: 'a' }), { ok: true, host: '192.168.108.1', port: 8728, user: 'a' });
  for (const host of ['', 'abc', '999.1.1.1', '1.2.3', '1.2.3.4.5', 'router.local', '192.168.1.1/24']) assert.equal(validateRouterForm({ host, port: '8728', user: 'a' }).ok, false, host);
  for (const port of ['0', '70000', 'x', '87.28', '-1']) assert.equal(validateRouterForm({ host: '10.0.0.1', port, user: 'a' }).ok, false, port);
  assert.equal(validateRouterForm({ host: '10.0.0.1', port: '8728', user: '  ' }).ok, false);
});

test('link: مدخلات غير صالحة لا تفتح أي اتصال', async () => {
  let opened = 0;
  const r = await testRouterConnection({ ...args({ host: 'abc' }), transportFactory: () => { opened++; return new MemTransport(() => []); } });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BAD_INPUT');
  assert.equal(r.error.cause, 'input');
  assert.equal(opened, 0);
});

test('link: نجاح الاختبار يعيد بيانات الراوتر ولا يُرسل إلا /login وأوامر print', async () => {
  const { t, factory } = mk();
  const r = await testRouterConnection({ ...args(), transportFactory: factory });
  assert.equal(r.ok, true);
  assert.equal(r.host, '192.168.88.1');
  assert.equal(r.port, 8728);
  assert.equal(r.v6, true);
  assert.equal(r.system.identity, 'MikroTik-Test');
  assert.equal(r.system.board, 'RB750Gr3');
  assert.match(r.system.version, /^6\./);
  assert.deepEqual(r.api, { disabled: false, port: '8728', address: '192.168.88.0/24' });
  assert.equal(r.apiNote, null);
  const cmds = t.written.map((w) => w[0]);
  assert.ok(cmds.length >= 4);
  for (const c of cmds) assert.ok(READ_ONLY_CMDS.has(c), 'أمر غير متوقع: ' + c);
  for (const c of cmds) assert.ok(c === '/login' || c.endsWith('/print'), c);
  assert.equal(t.closed, true);
});

test('link: كلمة مرور فارغة صالحة، ومستخدم/كلمة مرور خاطئان يعطيان LOGIN_FAILED دون تسريب كلمة المرور', async () => {
  const empty = mk({ pass: '' });
  assert.equal((await testRouterConnection({ ...args({ password: '' }), transportFactory: empty.factory })).ok, true);

  const bad = mk();
  const r = await testRouterConnection({ ...args({ password: 'hunter2' }), transportFactory: bad.factory });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'LOGIN_FAILED');
  assert.equal(r.error.cause, 'credentials');
  assert.equal(bad.t.closed, true);
  assert.ok(!JSON.stringify(r).includes('hunter2'));

  const wrongUser = mk();
  assert.equal((await testRouterConnection({ ...args({ user: 'nobody' }), transportFactory: wrongUser.factory })).error.code, 'LOGIN_FAILED');
});

test('link: نص الخطأ القادم من الراوتر يُحجب منه كلمة المرور إن ظهرت فيه', async () => {
  const leaky = mk({}, (w, ctx, base) => (w[0] === '/login' ? [trap('failed for hunter2 password'), done()] : base(w, ctx)));
  const r = await testRouterConnection({ ...args({ password: 'hunter2' }), transportFactory: leaky.factory });
  assert.equal(r.error.code, 'LOGIN_FAILED');
  assert.ok(r.error.technical.includes('***'));
  assert.ok(!JSON.stringify(r).includes('hunter2'));
});

test('link: أخطاء الشبكة تُترجم إلى أسبابها (API معطلة، شبكة، جسر غير شغال)', async () => {
  const failing = (code) => ({ transportFactory: () => ({ open: async () => { throw new RosError(code, 'x', 'ECODE'); }, write: async () => {}, read: async () => null, close: async () => {} }) });
  const refused = await testRouterConnection({ ...args(), ...failing('PORT_REFUSED') });
  assert.deepEqual([refused.ok, refused.error.cause, refused.error.code], [false, 'api_disabled', 'PORT_REFUSED']);
  const net = await testRouterConnection({ ...args(), ...failing('HOST_UNREACHABLE') });
  assert.equal(net.error.cause, 'network');
  const bridge = await testRouterConnection({ ...args(), ...failing('BRIDGE_DOWN') });
  assert.equal(bridge.error.cause, 'bridge');
  assert.equal(typeof bridge.error.technical, 'string');
});

test('link: نقص صلاحية قراءة النظام فشل PERMISSION_DENIED، ونقص قراءة خدمات API لا يُفشل الاتصال', async () => {
  const noRes = mk({}, (w, ctx, base) => (w[0] === '/system/resource/print' ? [trap('not enough permissions (9)'), done()] : base(w, ctx)));
  const r1 = await testRouterConnection({ ...args(), transportFactory: noRes.factory });
  assert.deepEqual([r1.ok, r1.error.code, r1.error.cause], [false, 'PERMISSION_DENIED', 'permissions']);
  assert.equal(noRes.t.closed, true);

  const noSvc = mk({}, (w, ctx, base) => (w[0] === '/ip/service/print' ? [trap('not enough permissions (9)'), done()] : base(w, ctx)));
  const r2 = await testRouterConnection({ ...args(), transportFactory: noSvc.factory });
  assert.equal(r2.ok, true);
  assert.equal(r2.api, null);
  assert.match(r2.apiNote, /تعذرت قراءة إعدادات خدمة API/);
});

test('link: إصدار غير v6 ينجح لكن v6=false، وخدمة API الغائبة تُعلن في apiNote', async () => {
  const v7 = mk({}, (w, ctx, base) => (w[0] === '/system/resource/print' ? [['!re', '=version=7.12 (stable)', '=board-name=CCR2004', '=uptime=1d'], done()] : base(w, ctx)));
  const r = await testRouterConnection({ ...args(), transportFactory: v7.factory });
  assert.equal(r.ok, true);
  assert.equal(r.v6, false);
  const noApi = mk({}, (w, ctx, base) => (w[0] === '/ip/service/print' ? [['!re', '=name=ssh', '=disabled=false', '=port=22'], done()] : base(w, ctx)));
  const r2 = await testRouterConnection({ ...args(), transportFactory: noApi.factory });
  assert.equal(r2.ok, true);
  assert.equal(r2.api, null);
  assert.match(r2.apiNote, /غير ظاهرة/);
});


// ---------------------------------------------------------------- المرحلة 3: مزامنة الكروت ودمجها (راوتر وهمي)

const ROS_DAYS = { '2026-11-22': 'nov/22/2026', '2026-11-23': 'nov/23/2026', '2026-11-24': 'nov/24/2026' };
const rosArgs = (over = {}) => ({ host: '192.168.88.1', port: '8728', user: 'reader', password: 'secret', state: { d: {} }, ...over });

function cardSyncFixture() {
  const data = makeUmData({ users: 2, sessions: 2 });
  data.users[0].username = `${FAKE_USER_PREFIX}card-100`;
  data.users[0]['actual-profile'] = '100RY';
  data.users[0]['download-used'] = '1000';
  data.users[0]['upload-used'] = '100';
  data.users[1].username = `${FAKE_USER_PREFIX}card-200`;
  data.users[1]['actual-profile'] = '200RY';
  data.users[1]['download-used'] = '2000';
  data.users[1]['upload-used'] = '200';
  data.sessions[0].user = data.users[0].username;
  data.sessions[0]['from-time'] = 'nov/21/2026 10:00:00';
  data.sessions[1].user = data.users[1].username;
  data.sessions[1]['from-time'] = 'nov/20/2026 10:00:00'; // أقدم من المسموح بأول قراءة
  let currentDay = '2026-11-22';
  const base = fakeUmHandler({ data });
  const handler = (w, ctx) => {
    if (w[0] === '/system/clock/print') return [re({ time: '00:05:00', date: ROS_DAYS[currentDay], 'time-zone-name': 'Asia/Aden' }), done()];
    return base(w, ctx);
  };
  const transports = [];
  const transportFactory = () => { const t = new MemTransport(handler); transports.push(t); return t; };
  return { data, handler, transports, transportFactory, setDay: (day) => { currentDay = day; } };
}

test('link sync: ثلاث مزامنات متتالية (قراءة أولى، تغيّر، ثم تثبيت) مع إخفاء اليوم القديم', async () => {
  const f = cardSyncFixture();
  let state = { d: {} };

  f.setDay('2026-11-22');
  const first = await syncRouterCards({ ...rosArgs({ state }), transportFactory: f.transportFactory });
  assert.equal(first.ok, true);
  assert.equal(first.readOn, '2026-11-22');
  assert.equal(first.summary.new, 1);
  assert.equal(first.summary.hidden, 1);
  assert.equal(first.results.find((x) => x.day === '2026-11-21').action, 'new');
  assert.equal(first.results.find((x) => x.day === '2026-11-20').action, 'hidden-old');
  assert.equal(Object.hasOwn(first.state.d, '2026-11-20'), false);

  // مطابقة مستقلة لمسار القارئ الذي تستخدمه أداة cards-read قبل تطبيق الدمج.
  const parityClient = new RouterOSClient(new MemTransport(f.handler), { readOnly: true });
  await parityClient.connect({ host: '192.168.88.1', port: 8728, tls: false });
  await parityClient.login('reader', 'secret');
  const parityRead = await readCards(parityClient, { withSanity: true });
  await parityClient.close();
  const parityMerged = mergeReadings({ d: {} }, parityRead.agg, '2026-11-22');
  assert.deepEqual(first.state, parityMerged.state);
  state = first.state;

  f.data.users[0]['download-used'] = '2500'; // ارتفع الاستهلاك في يوم 21
  f.setDay('2026-11-23');
  const second = await syncRouterCards({ ...rosArgs({ state }), transportFactory: f.transportFactory });
  assert.equal(second.ok, true);
  assert.equal(second.summary.updated, 1);
  assert.equal(second.results.find((x) => x.day === '2026-11-21').action, 'updated');
  state = second.state;

  f.setDay('2026-11-24'); // القراءة التالية مطابقة تماماً وفي يوم لاحق
  const third = await syncRouterCards({ ...rosArgs({ state }), transportFactory: f.transportFactory });
  assert.equal(third.ok, true);
  assert.equal(third.summary.pinned, 1);
  assert.equal(third.results.find((x) => x.day === '2026-11-21').action, 'pinned');
  assert.equal(third.state.d['2026-11-21'].lp, true);
  assert.equal(third.state.d['2026-11-21'].c[0], 1);

  const saved = JSON.stringify(third.state);
  const completeReply = JSON.stringify(third);
  assert.ok(!saved.includes('reader'));
  assert.ok(!saved.includes(FAKE_USER_PREFIX));
  assert.ok(!saved.includes(FAKE_PASS_PREFIX));
  assert.ok(!saved.includes('password'));
  assert.ok(!completeReply.includes('reader'));
  assert.ok(!completeReply.includes(FAKE_USER_PREFIX));
  assert.ok(!completeReply.includes(FAKE_PASS_PREFIX));
  assert.ok(!completeReply.includes('secret'));
  for (const t of f.transports) {
    assert.equal(t.closed, true);
    for (const w of t.written) {
      if (w[0] === '/login') continue;
      assert.ok(w[0].endsWith('/print'), 'أمر غير قراءة: ' + w[0]);
      const props = w.filter((x) => x.startsWith('=.proplist=')).join(' ');
      assert.ok(!/password|caller|ip-address|user-ip|host-ip/i.test(props), props);
    }
  }
});

test('link sync: كلمة مرور خاطئة أو إصدار غير v6 لا ينتج حالة قابلة للحفظ', async () => {
  const f = cardSyncFixture();
  const bad = await syncRouterCards({ ...rosArgs({ password: 'wrong', state: { d: {} } }), transportFactory: f.transportFactory });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'LOGIN_FAILED');
  assert.ok(!JSON.stringify(bad).includes('wrong'));

  const base = fakeUmHandler({ data: makeUmData({ users: 1, sessions: 1 }) });
  const v7Handler = (w, ctx) => w[0] === '/system/resource/print'
    ? [re({ uptime: '1d00:00:00', version: '7.12', 'board-name': 'RB5009' }), done()]
    : base(w, ctx);
  const t = new MemTransport(v7Handler);
  const unsupported = await syncRouterCards({ ...rosArgs(), transportFactory: () => t });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error.code, 'UNSUPPORTED_ROUTEROS');
  assert.ok(!t.written.some((w) => w[0] === '/tool/user-manager/user/print'), 'يجب إيقاف القراءة قبل اليوزر مانجر');
  assert.equal(t.closed, true);
});

test('link: مزامنة مبيعات User Manager v6 تقرأ الجلسات والباقات فقط وتغلق الاتصال', async () => {
  const data=makeUmData({users:3,sessions:3});
  data.sessions[0]['from-time']='nov/22/2026 10:00:00';
  const t=new MemTransport(fakeUmHandler({data}));
  const r=await syncRouterSales({...args(),transportFactory:()=>t});
  assert.equal(r.ok,true);
  assert.equal(r.records.length,3);
  assert.ok(r.records.every(x=>x.profile));
  assert.equal(r.profiles.length,3);
  assert.match(r.system.version,/^6\./);
  assert.equal(t.closed,true);
  const cmds=t.written.map(x=>x[0]);
  assert.ok(cmds.includes('/tool/user-manager/session/print'));
  assert.ok(cmds.includes('/tool/user-manager/user/print'));
  for(const cmd of cmds)assert.ok(cmd==='/login'||cmd.endsWith('/print'),cmd);
  const requested=JSON.stringify(t.written.filter(x=>x[0].includes('user-manager')));
  assert.equal(requested.includes('password'),false);
  assert.equal(requested.includes('caller-id'),false);
});

test('link: رفض RouterOS v7 لقراءة المبيعات دون حفظ', async () => {
  const base=fakeRouterHandler({user:'reader',pass:'secret'});
  const t=new MemTransport((w,ctx)=>w[0]==='/system/resource/print'?[['!re','=version=7.12','=board-name=CCR2004'],done()]:base(w,ctx));
  const r=await syncRouterSales({...args(),transportFactory:()=>t});
  assert.equal(r.ok,false);assert.equal(r.error.code,'UNSUPPORTED_ROUTEROS');assert.equal(t.closed,true);
  assert.equal(t.written.some(x=>x[0]==='/tool/user-manager/session/print'),false);
});
