import test from 'node:test';
import assert from 'node:assert/strict';
import { makeReading, computePeriod, appendReading, sumPeriod, formatBytes, detectReboot, STATUS, CounterError } from '../core/counters.js';

const T0 = 1_700_000_000_000;
const rd = (ts, uptimeSec, ifaces) => makeReading({ ts, uptimeSec, ifaces });
const MB = 1024 ** 2;

test('makeReading: يرفض القراءة الفارغة والوقت الباطل ولا يملأ أصفاراً', () => {
  assert.throws(() => makeReading({ ts: T0, ifaces: [] }), (e) => e.code === 'EMPTY_READING');
  assert.throws(() => makeReading({ ts: NaN, ifaces: [{ name: 'a', rx: 1, tx: 1 }] }), (e) => e.code === 'BAD_TIMESTAMP');
  assert.throws(() => makeReading({ ts: T0, ifaces: [{ name: 'a', rx: null, tx: 1 }, { name: 'b', rx: -1, tx: 1 }] }), (e) => e.code === 'NO_VALID_COUNTERS');
  const r = makeReading({ ts: T0, ifaces: [{ name: 'a', rx: 5, tx: 6 }, { name: 'b', rx: null, tx: 1 }, { name: 'a', rx: 9, tx: 9 }, { name: 'z', rx: 0, tx: 0 }] });
  assert.deepEqual([r.ifaces.a.rx, r.ifaces.a.tx, r.ifaces.z.rx, r.ifaces.z.tx], [5, 6, 0, 0], 'a لا تتكرر، والصفر الحقيقي يبقى');
  assert.deepEqual(r.invalid, ['b']);
});

test('أول قراءة: نقطة مرجعية بلا استهلاك', () => {
  const p = computePeriod(null, rd(T0, 100, [{ name: 'a', rx: 10, tx: 10 }]));
  assert.equal(p.results.a.status, STATUS.FIRST);
  assert.equal(p.results.a.total, null);
});

test('فرق طبيعي: الحالية - السابقة', () => {
  const prev = rd(T0, 1000, [{ name: 'a', rx: 100 * MB, tx: 50 * MB }]);
  const curr = rd(T0 + 3600_000, 4600, [{ name: 'a', rx: 160 * MB, tx: 70 * MB }]);
  const r = computePeriod(prev, curr).results.a;
  assert.deepEqual([r.status, r.rx, r.tx, r.total], [STATUS.OK, 60 * MB, 20 * MB, 80 * MB]);
});

test('بلا تغيير = صفر حقيقي (حالة OK) وليس مجهولاً', () => {
  const prev = rd(T0, 1000, [{ name: 'a', rx: 7, tx: 7 }]);
  const curr = rd(T0 + 60_000, 1060, [{ name: 'a', rx: 7, tx: 7 }]);
  const r = computePeriod(prev, curr).results.a;
  assert.deepEqual([r.status, r.total], [STATUS.OK, 0]);
});

test('تصفير العدادات (انخفاض بلا إعادة تشغيل): لا فرق سالب ونقطة مرجعية جديدة', () => {
  const prev = rd(T0, 1000, [{ name: 'a', rx: 500, tx: 500 }]);
  const curr = rd(T0 + 60_000, 1060, [{ name: 'a', rx: 20, tx: 30 }]);
  const p = computePeriod(prev, curr);
  assert.equal(p.reboot.rebooted, false);
  assert.deepEqual([p.results.a.status, p.results.a.reason, p.results.a.total], [STATUS.RESET, 'counter-decreased', null]);
});

test('انخفاض RX فقط أو TX فقط يكفي لاعتباره تصفيراً', () => {
  const prev = rd(T0, 1000, [{ name: 'a', rx: 500, tx: 500 }]);
  assert.equal(computePeriod(prev, rd(T0 + 1000, 1001, [{ name: 'a', rx: 600, tx: 10 }])).results.a.status, STATUS.RESET);
  assert.equal(computePeriod(prev, rd(T0 + 1000, 1001, [{ name: 'a', rx: 10, tx: 600 }])).results.a.status, STATUS.RESET);
});

test('إعادة تشغيل الراوتر: uptime أقل => كل الواجهات نقطة مرجعية', () => {
  const prev = rd(T0, 86400, [{ name: 'a', rx: 500, tx: 500 }, { name: 'b', rx: 9, tx: 9 }]);
  const curr = rd(T0 + 3600_000, 120, [{ name: 'a', rx: 40, tx: 40 }, { name: 'b', rx: 1, tx: 1 }]);
  const p = computePeriod(prev, curr);
  assert.equal(p.reboot.rebooted, true);
  assert.deepEqual(Object.values(p.results).map((r) => r.status), [STATUS.RESET, STATUS.RESET]);
});

test('إعادة تشغيل مع عدادات أكبر من السابقة (فترة طويلة): يُكتشف عبر uptime ولا يُحسب فرق مضلل', () => {
  const prev = rd(T0, 2 * 3600, [{ name: 'a', rx: 1000, tx: 1000 }]);                 // الراوتر يعمل منذ ساعتين
  const curr = rd(T0 + 3 * 86400_000, 2 * 86400, [{ name: 'a', rx: 9_000_000, tx: 9_000_000 }]); // بعد 3 أيام: uptime يومان فقط
  const p = computePeriod(prev, curr);
  assert.equal(p.reboot.rebooted, true);
  assert.equal(p.reboot.reason, 'uptime-below-expected');
  assert.equal(p.results.a.status, STATUS.RESET);
});

test('بدون إعادة تشغيل: انحراف ساعة صغير ضمن التسامح لا يُعد إعادة تشغيل', () => {
  const prev = rd(T0, 1000, [{ name: 'a', rx: 1, tx: 1 }]);
  const curr = rd(T0 + 3600_000, 1000 + 3600 - 20, [{ name: 'a', rx: 2, tx: 2 }]);
  assert.equal(detectReboot(prev, curr).rebooted, false);
});

test('uptime غير معروف: لا يُفترض إعادة تشغيل، ويبقى الاعتماد على انخفاض العداد', () => {
  const prev = rd(T0, null, [{ name: 'a', rx: 100, tx: 100 }]);
  const curr = rd(T0 + 1000, null, [{ name: 'a', rx: 150, tx: 150 }]);
  const p = computePeriod(prev, curr);
  assert.equal(p.reboot.known, false);
  assert.equal(p.results.a.total, 100);
});

test('واجهة جديدة => NEW بلا استهلاك، وواجهة اختفت => missing وليست صفراً', () => {
  const prev = rd(T0, 1000, [{ name: 'a', rx: 1, tx: 1 }, { name: 'gone', rx: 5, tx: 5 }]);
  const curr = rd(T0 + 1000, 1001, [{ name: 'a', rx: 2, tx: 2 }, { name: 'vlan99', rx: 8, tx: 8 }]);
  const p = computePeriod(prev, curr);
  assert.equal(p.results.vlan99.status, STATUS.NEW);
  assert.deepEqual(p.missing, ['gone']);
  assert.equal(p.results.gone, undefined, 'لا نتيجة مختلقة للواجهة المفقودة');
});

test('ترتيب زمني خاطئ => خطأ', () => {
  const a = rd(T0 + 5000, 10, [{ name: 'a', rx: 1, tx: 1 }]);
  const b = rd(T0, 5, [{ name: 'a', rx: 1, tx: 1 }]);
  assert.throws(() => computePeriod(a, b), (e) => e instanceof CounterError && e.code === 'TIME_ORDER');
});

test('appendReading: لا تكرار عند إعادة المزامنة، ولا تعديل للتاريخ الأصلي، ولا قراءة أقدم', () => {
  const r1 = rd(T0, 100, [{ name: 'a', rx: 10, tx: 10 }]);
  const r2 = rd(T0 + 1000, 101, [{ name: 'a', rx: 20, tx: 25 }]);
  let h = [];
  h = appendReading(h, r1).history;
  const s2 = appendReading(h, r2);
  const h2 = s2.history;
  assert.equal(h.length, 1, 'الأصل لم يتغير');
  assert.equal(h2.length, 2);
  assert.equal(s2.period.results.a.total, 25);
  const again = appendReading(h2, r2);
  assert.equal(again.duplicate, true);
  assert.equal(again.history.length, 2, 'إعادة نفس القراءة لا تضيف سجلاً');
  assert.throws(() => appendReading(h2, rd(T0 - 1, 1, [{ name: 'a', rx: 1, tx: 1 }])), (e) => e.code === 'OUT_OF_ORDER');
});

test('تسلسل كامل: عادي ثم تصفير ثم عادي، والنقطة المرجعية الجديدة هي الأساس', () => {
  const seq = [
    rd(T0, 1000, [{ name: 'a', rx: 100, tx: 0 }]),
    rd(T0 + 3600_000, 4600, [{ name: 'a', rx: 400, tx: 0 }]),   // +300
    rd(T0 + 7200_000, 100, [{ name: 'a', rx: 50, tx: 0 }]),     // إعادة تشغيل
    rd(T0 + 10800_000, 3700, [{ name: 'a', rx: 90, tx: 0 }]),   // +40 من النقطة المرجعية الجديدة
  ];
  let h = [];
  for (const r of seq) h = appendReading(h, r).history;
  assert.deepEqual(h.map((x) => x.period.results.a.status), [STATUS.FIRST, STATUS.OK, STATUS.RESET, STATUS.OK]);
  assert.deepEqual(h.map((x) => x.period.results.a.total), [null, 300, null, 40]);
  const sum = h.reduce((s, x) => s + (x.period.results.a.total || 0), 0);
  assert.equal(sum, 340, 'المجموع لا يتضمن أي فرق سالب أو مُختلق');
});

test('sumPeriod: لا يجمع إلا حالات OK ويذكر المستبعد، ولا يعد الاسم مرتين', () => {
  const prev = rd(T0, 1000, [{ name: 'a', rx: 10, tx: 10 }, { name: 'b', rx: 500, tx: 500 }]);
  const curr = rd(T0 + 1000, 1001, [{ name: 'a', rx: 30, tx: 20 }, { name: 'b', rx: 1, tx: 1 }]);
  const p = computePeriod(prev, curr);
  assert.deepEqual(sumPeriod(p, ['a', 'a', 'b', 'nope']), { rx: 20, tx: 10, total: 30, counted: 1, skipped: 2 });
});

test('formatBytes: MB وGB بأساس 1024', () => {
  assert.equal(formatBytes(0), '0.00 MB');
  assert.equal(formatBytes(5 * MB), '5.00 MB');
  assert.equal(formatBytes(1024 ** 3), '1.00 GB');
  assert.equal(formatBytes(1.5 * 1024 ** 3), '1.50 GB');
  assert.equal(formatBytes(null), '—');
  assert.equal(formatBytes(-1), '—');
});
