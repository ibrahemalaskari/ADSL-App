import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  encodeLength, encodeSentence, SentenceParser, parseSentence, toCount, parseUptime,
  RouterOSClient, RosError, readSystem, readApiService, discoverInterfaces, diagnose, mapNetError,
} from '../core/routeros-api.js';
import { takeReading } from '../core/reader.js';
import { MemTransport, fakeRouterHandler } from './helpers.js';

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

test('ترميز الطول يطابق جدول توثيق RouterOS', () => {
  const cases = [[0, '00'], [0x7f, '7f'], [0x80, '8080'], [0x3fff, 'bfff'], [0x4000, 'c04000'],
    [0x1fffff, 'dfffff'], [0x200000, 'e0200000'], [0x0fffffff, 'efffffff'], [0x10000000, 'f010000000']];
  for (const [n, h] of cases) assert.equal(hex(encodeLength(n)), h, `len ${n}`);
});

test('ذهاب وإياب لكلمات بأطوال مختلفة وبدفعات مجزأة بايتاً بايتاً', () => {
  const words = ['/interface/print', '=comment=' + 'ب'.repeat(100), '=x=' + 'a'.repeat(200), '=y=' + 'z'.repeat(20000), '=empty='];
  const bytes = encodeSentence(words);
  const p = new SentenceParser();
  let got = [];
  for (let i = 0; i < bytes.length; i++) got = got.concat(p.push(bytes.subarray(i, i + 1)));
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], words);
  // جملتان في دفعة واحدة
  const two = new Uint8Array([...encodeSentence(['!re', '=a=1']), ...encodeSentence(['!done'])]);
  assert.equal(new SentenceParser().push(two).length, 2);
});

test('parseSentence: السمات والوسم والرسالة', () => {
  assert.deepEqual(parseSentence(['!re', '=.id=*1', '=name=ether1', '=comment=', '.tag=7']),
    { type: '!re', attrs: { '.id': '*1', name: 'ether1', comment: '' }, tag: '7' });
  assert.equal(parseSentence(['!trap', '=message=cannot log in']).attrs.message, 'cannot log in');
  assert.equal(parseSentence(['!fatal', 'timeout']).attrs.message, 'timeout');
});

test('toCount: غير الصالح = null وليس صفراً', () => {
  assert.equal(toCount('12345'), 12345);
  assert.equal(toCount('0'), 0);
  for (const bad of [undefined, null, '', 'oops', '-5', '1.5', '99999999999999999999']) assert.equal(toCount(bad), null, String(bad));
});

test('parseUptime بصيغ v6 وما بعدها', () => {
  assert.equal(parseUptime('1w2d03:04:05'), 604800 + 2 * 86400 + 3 * 3600 + 4 * 60 + 5);
  assert.equal(parseUptime('3d04:05:06'), 3 * 86400 + 4 * 3600 + 5 * 60 + 6);
  assert.equal(parseUptime('04:05:06'), 4 * 3600 + 5 * 60 + 6);
  assert.equal(parseUptime('1d2h3m4s'), 86400 + 7200 + 180 + 4);
  assert.equal(parseUptime('10s'), 10);
  for (const bad of ['', undefined, 'abc', '5x']) assert.equal(parseUptime(bad), null);
});

async function connected(opts, clientOpts) {
  const t = new MemTransport(fakeRouterHandler(opts));
  const c = new RouterOSClient(t, { timeoutMs: 400, ...clientOpts });
  await c.connect({ host: '192.168.88.1' });
  return { t, c };
}

test('تسجيل دخول بالطريقة الحديثة ينجح', async () => {
  const { c } = await connected();
  await c.login('reader', 'secret');
  assert.equal(c.loggedIn, true);
});

test('كلمة مرور خاطئة => LOGIN_FAILED', async () => {
  const { c } = await connected();
  await assert.rejects(() => c.login('reader', 'wrong'), (e) => e instanceof RosError && e.code === 'LOGIN_FAILED');
  assert.equal(c.loggedIn, false);
});

test('تسجيل دخول بطريقة التحدي القديمة (قبل 6.43)', async () => {
  const t = new MemTransport(fakeRouterHandler({ legacy: true }));
  t.ctx.expectResponse = (challenge, pass) => '00' + createHash('md5')
    .update(Buffer.concat([Buffer.from([0]), Buffer.from(pass), Buffer.from(challenge, 'hex')])).digest('hex');
  const c = new RouterOSClient(t, { timeoutMs: 400 });
  await c.connect({ host: 'x' });
  await c.login('reader', 'secret');
  assert.equal(c.loggedIn, true);
  const bad = new MemTransport(fakeRouterHandler({ legacy: true }));
  bad.ctx.expectResponse = t.ctx.expectResponse;
  const c2 = new RouterOSClient(bad, { timeoutMs: 400 });
  await c2.connect({ host: 'x' });
  await assert.rejects(() => c2.login('reader', 'nope'), (e) => e.code === 'LOGIN_FAILED');
});

test('وضع القراءة فقط يمنع أي أمر غير print ولا يرسل شيئاً للراوتر', async () => {
  const { t, c } = await connected();
  await c.login('reader', 'secret');
  const before = t.written.length;
  for (const cmd of ['/ip/service/set', '/system/scheduler/add', '/interface/disable', '/system/reboot']) {
    await assert.rejects(() => c.talk(cmd, { x: 1 }), (e) => e.code === 'READ_ONLY', cmd);
  }
  assert.equal(t.written.length, before, 'لم يُكتب أي شيء');
});

test('trap بصلاحيات غير كافية => PERMISSION_DENIED', async () => {
  const t = new MemTransport((w) => (w[0] === '/login' ? [['!done']] : [['!trap', '=message=not enough permissions (9)'], ['!done']]));
  const c = new RouterOSClient(t, { timeoutMs: 400 });
  await c.connect({ host: 'x' }); await c.login('u', 'p');
  await assert.rejects(() => c.talk('/ip/service/print'), (e) => e.code === 'PERMISSION_DENIED');
});

test('لا رد => TIMEOUT، وإغلاق الاتصال => CONNECTION_CLOSED', async () => {
  const silent = new MemTransport((w) => (w[0] === '/login' ? [['!done']] : []));
  const c = new RouterOSClient(silent, { timeoutMs: 150 });
  await c.connect({ host: 'x' }); await c.login('u', 'p');
  await assert.rejects(() => c.talk('/interface/print'), (e) => e.code === 'TIMEOUT');

  const dropper = new MemTransport((w) => (w[0] === '/login' ? [['!done']] : 'close'));
  const c2 = new RouterOSClient(dropper, { timeoutMs: 300 });
  await c2.connect({ host: 'x' }); await c2.login('u', 'p');
  await assert.rejects(() => c2.talk('/interface/print'), (e) => e.code === 'CONNECTION_CLOSED');
});

test('اكتشاف الواجهات: الأنواع، VLAN، Bridge، منع التكرار، وغير الصالح = null', async () => {
  const { c } = await connected();
  await c.login('reader', 'secret');
  const { interfaces } = await discoverInterfaces(c);
  const names = interfaces.map((i) => i.name);
  assert.deepEqual(names, ['ether1', 'ether2', 'bridge1', 'vlan10', 'vlan20'], 'vlan10 لا يتكرر');
  const by = Object.fromEntries(interfaces.map((i) => [i.name, i]));
  assert.equal(by.ether1.kind, 'ethernet');
  assert.equal(by.bridge1.kind, 'bridge');
  assert.deepEqual([by.vlan10.kind, by.vlan10.vlanId, by.vlan10.parent], ['vlan', 10, 'bridge1']);
  assert.equal(by.ether2.bridge, 'bridge1');
  assert.equal(by.ether2.running, false);
  assert.equal(by.ether2.rx, 0, 'الصفر الحقيقي يبقى صفراً');
  assert.equal(by.vlan20.rx, null, 'القيمة غير الصالحة null');
  assert.equal(by.vlan20.tx, null, 'القيمة الغائبة null');
});

test('قراءة النظام وخدمة API', async () => {
  const { c } = await connected();
  await c.login('reader', 'secret');
  const s = await readSystem(c);
  assert.equal(s.identity, 'MikroTik-Test');
  assert.equal(s.uptimeSec, 3 * 86400 + 4 * 3600 + 5 * 60 + 6);
  assert.match(s.version, /^6\./);
  const svc = await readApiService(c);
  assert.deepEqual(svc.api, { disabled: false, port: '8728', address: '192.168.88.0/24' });
  assert.equal(svc.apiSsl.disabled, true);
});

test('takeReading: قراءة كاملة، والواجهات غير الصالحة تُستبعد ولا تصبح أصفاراً', async () => {
  const { c } = await connected();
  await c.login('reader', 'secret');
  const { reading } = await takeReading(c, 1700000000000);
  assert.deepEqual(Object.keys(reading.ifaces).sort(), ['bridge1', 'ether1', 'ether2', 'vlan10']);
  assert.deepEqual(reading.invalid, ['vlan20']);
});

test('انقطاع الاتصال أثناء القراءة => استثناء ولا تُنشأ قراءة', async () => {
  let n = 0;
  const h = fakeRouterHandler();
  const t = new MemTransport((w, ctx) => (w[0] === '/interface/print' && ++n ? 'close' : h(w, ctx)));
  const c = new RouterOSClient(t, { timeoutMs: 300 });
  await c.connect({ host: 'x' }); await c.login('reader', 'secret');
  let reading = null;
  await assert.rejects(async () => { reading = (await takeReading(c)).reading; }, (e) => e.code === 'CONNECTION_CLOSED');
  assert.equal(reading, null);
});

test('تشخيص الأخطاء: رسائل مفهومة وأسباب مميّزة', () => {
  assert.equal(mapNetError('ECONNREFUSED'), 'PORT_REFUSED');
  assert.equal(mapNetError('ETIMEDOUT'), 'NETWORK_TIMEOUT');
  assert.equal(mapNetError('EHOSTUNREACH'), 'HOST_UNREACHABLE');
  assert.equal(diagnose(new RosError('PORT_REFUSED')).cause, 'api_disabled');
  assert.equal(diagnose(new RosError('NETWORK_TIMEOUT')).cause, 'network');
  assert.equal(diagnose(new RosError('LOGIN_FAILED')).cause, 'credentials');
  assert.equal(diagnose(new RosError('PERMISSION_DENIED')).cause, 'permissions');
  assert.equal(diagnose(new Error('boom')).cause, 'unknown');
});
