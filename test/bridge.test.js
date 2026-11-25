// اختبارات الجسر عبر HTTP حقيقي وTCP حقيقي على 127.0.0.1 ضد "راوتر وهمي" يتكلم بروتوكول API.
// هذا اختبار للجسر والنقل فقط، وليس اختباراً على RouterOS v6 حقيقي.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createBridge, isPrivateIPv4 } from '../bridge/server.js';
import { BridgeTransport } from '../core/bridge-transport.js';
import { RouterOSClient, SentenceParser, encodeSentence, RosError, diagnose } from '../core/routeros-api.js';
import { takeReading } from '../core/reader.js';
import { fakeRouterHandler } from './helpers.js';

let fake, fakePort, bridge, base, fakeConnections = 0;

before(async () => {
  const handler = fakeRouterHandler();
  fake = net.createServer((sock) => {
    fakeConnections++;
    const parser = new SentenceParser(); const ctx = {};
    sock.on('data', (d) => { for (const w of parser.push(new Uint8Array(d))) for (const s of handler(w, ctx) || []) sock.write(encodeSentence(s)); });
    sock.on('error', () => {});
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakePort = fake.address().port;
  bridge = createBridge({ port: 0, allowedPorts: null });
  base = `http://127.0.0.1:${await bridge.start()}`;
});
after(async () => { await bridge.stop(); fake.close(); });

test('isPrivateIPv4', () => {
  for (const ok of ['192.168.88.1', '10.0.0.5', '172.16.0.1', '172.31.255.1', '127.0.0.1']) assert.equal(isPrivateIPv4(ok), true, ok);
  for (const bad of ['8.8.8.8', '172.32.0.1', '1.1.1.1', 'example.com', '', null, '192.168.1', '::1']) assert.equal(isPrivateIPv4(bad), false, String(bad));
});

test('قراءة كاملة عبر الجسر: login ثم اكتشاف ثم قراءة', async () => {
  const c = new RouterOSClient(new BridgeTransport(base), { timeoutMs: 3000 });
  await c.connect({ host: '127.0.0.1', port: fakePort });
  await c.login('reader', 'secret');
  const { reading, interfaces } = await takeReading(c, 1_700_000_000_000);
  assert.equal(interfaces.length, 5);
  assert.deepEqual(reading.ifaces.ether1, { rx: 1000, tx: 2000, kind: 'ethernet', vlanId: null, parent: null, bridge: null, running: true, disabled: false, comment: '' });
  await c.close();
});

test('كلمة مرور خاطئة عبر الجسر => LOGIN_FAILED', async () => {
  const c = new RouterOSClient(new BridgeTransport(base), { timeoutMs: 3000 });
  await c.connect({ host: '127.0.0.1', port: fakePort });
  await assert.rejects(() => c.login('reader', 'x'), (e) => e.code === 'LOGIN_FAILED');
  await c.close();
});

test('منفذ مغلق => PORT_REFUSED (تشخيص: API معطل على الأرجح)', async () => {
  const probe = net.createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const closedPort = probe.address().port; await new Promise((r) => probe.close(r));
  const c = new RouterOSClient(new BridgeTransport(base), { timeoutMs: 2000 });
  await assert.rejects(() => c.connect({ host: '127.0.0.1', port: closedPort }), (e) => {
    assert.equal(e.code, 'PORT_REFUSED');
    assert.equal(diagnose(e).cause, 'api_disabled');
    return true;
  });
});

// ملاحظة: شبكة بيئة التطوير ترفض العناوين غير المتاحة فوراً (ECONNREFUSED) بدل أن تنتهي بمهلة،
// لذلك مسار "مهلة الاتصال" الفعلي في الجسر غير مُختبَر هنا. المُختبَر: أن الفشل يظهر كخطأ شبكة وليس نجاحاً.
// وتحويل ETIMEDOUT إلى NETWORK_TIMEOUT مُختبَر في اختبار mapNetError.
test('عنوان غير متاح => يفشل بخطأ شبكة وليس نجاحاً', async () => {
  const c = new RouterOSClient(new BridgeTransport(base), { timeoutMs: 500 });
  await assert.rejects(() => c.connect({ host: '10.255.255.1', port: 8728 }),
    (e) => e instanceof RosError && ['NETWORK_TIMEOUT', 'HOST_UNREACHABLE', 'PORT_REFUSED', 'CONNECT_FAILED'].includes(e.code));
});

test('الجسر غير شغال => BRIDGE_DOWN', async () => {
  const c = new RouterOSClient(new BridgeTransport('http://127.0.0.1:1'), { timeoutMs: 500 });
  await assert.rejects(() => c.connect({ host: '192.168.88.1', port: 8728 }), (e) => e.code === 'BRIDGE_DOWN' && diagnose(e).cause === 'bridge');
});

test('الأمان: بدون X-Bridge مرفوض، وعنوان عام مرفوض ولا اتصال يُفتح، وHost غريب مرفوض', async () => {
  const before = fakeConnections;
  let r = await fetch(`${base}/tcp/open`, { method: 'POST', body: JSON.stringify({ host: '127.0.0.1', port: fakePort }) });
  assert.equal(r.status, 403);
  r = await fetch(`${base}/tcp/open`, { method: 'POST', headers: { 'x-bridge': '1' }, body: JSON.stringify({ host: '8.8.8.8', port: 8728 }) });
  assert.equal(r.status, 400);
  r = await fetch(`${base}/tcp/open`, { method: 'POST', headers: { 'x-bridge': '1' }, body: JSON.stringify({ host: 'localhost', port: 8728 }) });
  assert.equal(r.status, 400, 'أسماء النطاقات غير مسموحة');
  assert.equal(fakeConnections, before, 'لم يُفتح أي اتصال');
  const strict = createBridge({ port: 0 }); const sp = await strict.start();
  r = await fetch(`http://127.0.0.1:${sp}/tcp/open`, { method: 'POST', headers: { 'x-bridge': '1' }, body: JSON.stringify({ host: '127.0.0.1', port: fakePort }) });
  assert.equal(r.status, 400, 'المنفذ خارج 8728/8729 مرفوض افتراضياً');
  await strict.stop();
  const http = await import('node:http');
  const status = await new Promise((resolve) => {
    const rq = http.request({ host: '127.0.0.1', port: Number(new URL(base).port), path: '/health', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    rq.end();
  });
  assert.equal(status, 403);
});

test('الملفات الثابتة: www وcore فقط ومنع الخروج من الجذر', async () => {
  assert.equal((await fetch(`${base}/core/counters.js`)).status, 200);
  assert.equal((await fetch(`${base}/core/../package.json`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/bridge/server.js`)).status, 404, 'كود الجسر لا يُقدَّم');
  assert.equal((await fetch(`${base}/test/helpers.js`)).status, 404);
});
