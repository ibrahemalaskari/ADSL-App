import test from 'node:test';
import assert from 'node:assert/strict';
import { createLog, maskSecrets, sanitizeMeta, formatLog, LogError } from '../core/oplog.js';

const T0 = Date.UTC(2026, 10, 23, 2, 0, 0);
const clockLog = (opts = {}) => { let t = T0; const log = createLog({ ...opts, now: () => (t += 1000) }); return log; };

test('add: يسجّل المدخل بالوقت والمستوى والرمز، ويرفض مستوى ورمزاً باطلين', () => {
  const log = clockLog();
  const e = log.info('SYNC_OK', 'تمت المزامنة', { days: 2 });
  assert.equal(e.level, 'info');
  assert.equal(e.code, 'SYNC_OK');
  assert.equal(e.ts, new Date(T0 + 1000).toISOString());
  assert.deepEqual(e.meta, { days: 2 });
  assert.throws(() => log.add('fatal', 'X', 'm'), (x) => x instanceof LogError && x.code === 'BAD_LEVEL');
  assert.throws(() => log.add('info', '', 'm'), (x) => x.code === 'BAD_CODE');
  assert.throws(() => createLog({ max: 0 }), (x) => x.code === 'BAD_MAX');
});

test('أسرار: مفاتيح كلمة المرور وأسماء المستخدمين تُحجب ولا تدخل السجل', () => {
  const log = clockLog();
  const e = log.warn('AUTH', 'فشل الدخول', { password: 'hunter2', Pass: 'x', token: 't', username: 'u12345', user: 'admin', host: '192.168.88.1', ok: false });
  assert.equal(e.meta.password, '***');
  assert.equal(e.meta.Pass, '***');
  assert.equal(e.meta.token, '***');
  assert.equal(e.meta.username, '***');
  assert.equal(e.meta.user, '***');
  assert.equal(e.meta.host, '192.168.88.1', 'العنوان ليس سرّاً');
  assert.equal(e.meta.ok, false);
  assert.ok(!JSON.stringify(log.snapshot()).includes('hunter2'));
});

test('addSecret: القيمة السرّية تُحجب من الرسالة والرمز والـmeta وعند الاستعادة، ولا تظهر في اللقطة', () => {
  const log = clockLog();
  log.addSecret('s3cr3t-pw');
  log.addSecret('ab'); // أقصر من الحد: يُتجاهل
  const e = log.error('LOGIN', 'رفض الراوتر كلمة s3cr3t-pw للمستخدم', { detail: 'كلمة: s3cr3t-pw' });
  assert.ok(!e.msg.includes('s3cr3t-pw'));
  assert.ok(e.msg.includes('***'));
  assert.ok(!e.meta.detail.includes('s3cr3t-pw'));
  assert.equal(log.info('X', 'ab cd ab').msg, 'ab cd ab', 'القيمة الأقصر من 3 أحرف لا تُحجب');
  // استعادة لقطة قديمة فيها السر: يُحجب عند الدمج
  const log2 = clockLog();
  log2.addSecret('old-secret');
  const r = log2.restore({ entries: [{ ts: new Date(T0).toISOString(), level: 'error', code: 'E', msg: 'فشل old-secret', meta: null }] });
  assert.equal(r.added, 1);
  assert.ok(!JSON.stringify(log2.snapshot()).includes('old-secret'));
  assert.ok(!JSON.stringify(log.snapshot()).includes('s3cr3t-pw'), 'السر نفسه لا يخرج في اللقطة');
});

test('maskSecrets وsanitizeMeta: قيم معقّدة تُختصر وعدد المفاتيح محدود', () => {
  assert.equal(maskSecrets('a pw1 b pw1', ['pw1']), 'a *** b ***');
  const m = sanitizeMeta({ list: [1, 2, 3], obj: { a: 1 }, n: NaN, nul: null, long: 'x'.repeat(500) });
  assert.equal(m.list, '[قائمة: 3]');
  assert.equal(m.obj, '[كائن]');
  assert.equal(m.n, 'NaN');
  assert.equal(m.nul, null);
  assert.ok(m.long.length <= 200);
  const many = sanitizeMeta(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i])));
  assert.equal(Object.keys(many).length, 13, '12 مفتاحاً + سطر التنبيه');
  assert.equal(sanitizeMeta(null), null);
  assert.deepEqual(sanitizeMeta('نص'), { value: 'نص' });
});

test('logError: يأخذ code وmessage ولا يسجّل stack', () => {
  const log = clockLog();
  const err = Object.assign(new Error('تعذر الاتصال'), { code: 'ECONNREFUSED' });
  const e = log.logError(err, { phase: 'connect' });
  assert.equal(e.level, 'error');
  assert.equal(e.code, 'ECONNREFUSED');
  assert.equal(e.msg, 'تعذر الاتصال');
  assert.ok(!JSON.stringify(e).includes('at '), 'بلا stack');
  assert.equal(log.logError(new TypeError('x')).code, 'TypeError');
  assert.equal(log.logError('نص فقط').code, 'ERROR');
});

test('السقف: الأقدم يُحذف ويُحسب في dropped (لا إخفاء صامت)', () => {
  const log = clockLog({ max: 3 });
  for (let i = 1; i <= 5; i++) log.info('N', `m${i}`);
  assert.deepEqual(log.entries().map((e) => e.msg), ['m3', 'm4', 'm5']);
  assert.deepEqual(log.counts(), { info: 3, warn: 0, error: 0, total: 3, dropped: 2 });
});

test('entries: مرشّحات المستوى والرمز والوقت، وترجع نسخاً لا تؤثر في السجل', () => {
  const log = clockLog();
  log.info('A', 'a'); log.warn('B', 'b'); log.error('A', 'c');
  assert.deepEqual(log.entries({ level: 'error' }).map((e) => e.msg), ['c']);
  assert.deepEqual(log.entries({ code: 'A' }).map((e) => e.msg), ['a', 'c']);
  assert.deepEqual(log.entries({ since: new Date(T0 + 2000).toISOString() }).map((e) => e.msg), ['b', 'c']);
  const got = log.entries();
  got[0].msg = 'غُيِّر';
  assert.equal(log.entries()[0].msg, 'a');
});

test('snapshot/restore: دمج بلا تكرار وترتيب بالوقت، وتجاهل المدخلات الباطلة وعدّها', () => {
  const a = clockLog();
  a.info('S1', 'أولى'); a.warn('S2', 'ثانية');
  const snap = a.snapshot();
  const b = createLog({ max: 10, now: () => T0 + 50_000 });
  b.info('LOCAL', 'محلي');
  const bad = { ...snap, entries: [...snap.entries, { ts: 'ليس وقتاً', level: 'info', code: 'X', msg: 'm' }, { ts: new Date(T0).toISOString(), level: 'zzz', code: 'X', msg: 'm' }, null] };
  const r1 = b.restore(bad);
  assert.deepEqual(r1, { added: 2, duplicates: 0, rejected: 3, trimmed: 0 });
  assert.deepEqual(b.entries().map((e) => e.code), ['S1', 'S2', 'LOCAL'], 'مرتّبة بالوقت');
  assert.deepEqual(b.entries().map((e) => e.id), [1, 2, 3]);
  const r2 = b.restore(snap); // مرة ثانية: كلها مكررة
  assert.deepEqual(r2, { added: 0, duplicates: 2, rejected: 0, trimmed: 0 });
  assert.equal(b.counts().total, 3);
  assert.throws(() => b.restore({}), (x) => x.code === 'BAD_SNAPSHOT');
  assert.throws(() => b.restore(null), (x) => x.code === 'BAD_SNAPSHOT');
});

test('restore: السقف يطبَّق بعد الدمج ويُحسب المحذوف، وdropped المحفوظ يُضاف', () => {
  const a = clockLog();
  for (let i = 0; i < 4; i++) a.info('A', `a${i}`);
  const snap = { ...a.snapshot(), dropped: 7 };
  const b = createLog({ max: 3, now: () => T0 + 99_000 });
  const r = b.restore(snap);
  assert.equal(r.added, 4);
  assert.equal(r.trimmed, 1);
  assert.equal(b.counts().dropped, 7 + 1);
  assert.equal(b.counts().total, 3);
});

test('formatLog: سطر لكل مدخل بالعربية', () => {
  const log = clockLog();
  log.warn('W', 'تنبيه', { n: 2 });
  log.error('E', 'خطأ');
  const t = formatLog(log.entries());
  const lines = t.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\[تنبيه\] W: تنبيه n=2$/);
  assert.match(lines[1], /\[خطأ\] E: خطأ$/);
});
