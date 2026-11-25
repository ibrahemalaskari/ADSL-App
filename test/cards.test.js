// اختبارات منطق الكروت (core/cards.js): الأيام حسب أول جلسة، ربط الباقات، وقاعدة التثبيت.
// بيانات مختلقة بالكامل. لا علاقة لها براوتر حقيقي.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseRosDate, parseRosTime, aggregateCards, applyDayReading, mergeReadings, isTemporary, bytesToGB,
  dayAge, isTooOldForFirstSight, FIRST_SIGHT_MAX_AGE_DAYS,
} from '../core/cards.js';

test('parseRosDate وparseRosTime: صيغة الراوتر وحالات الرفض', () => {
  assert.equal(parseRosDate('nov/15/2024'), '2024-11-15');
  assert.equal(parseRosDate('NOV/05/2024'), '2024-11-05');
  for (const bad of ['feb/30/2024', 'xxx/01/2024', 'nov/32/2024', '', undefined, null, '2024-11-15']) assert.equal(parseRosDate(bad), null, String(bad));
  assert.deepEqual(parseRosTime('nov/15/2024 21:24:04'), { day: '2024-11-15', time: '21:24:04' });
  assert.deepEqual(parseRosTime('nov/15/2024 9:05:07'), { day: '2024-11-15', time: '09:05:07' });
  for (const bad of ['nov/15/2024 24:00:00', 'nov/15/2024 10:60:00', 'nov/15/2024', 'garbage', '']) assert.equal(parseRosTime(bad), null, bad);
});

test('bytesToGB: 300 م.ب = 314572800 بايت ويطابق ثوابت R (ميجا ÷ 1024)', () => {
  assert.equal(bytesToGB(1073741824), 1);
  assert.equal(bytesToGB(314572800), 0.293);
  assert.equal(bytesToGB(0), 0);
});

const U = (name, profile, usedBytes) => ({ name, profile, usedBytes });
const S = (user, from) => ({ user, from });

function scenario() {
  const users = [
    U('secretname-a', '100RY', 100), U('secretname-b', '100جيب', 50), U('secretname-c', '500RY', 1000),
    U('secretname-d', '1000ريال', 7), U('secretname-e', '3000RY', 999), U('secretname-f', '', 5),
    U('secretname-g', 'Weird', 11), U('secretname-h', '100RY', 0), U('secretname-i', '200RY', 20),
    U('secretname-j', '250جيب', 3),
  ];
  const sessions = [
    S('secretname-a', 'nov/20/2026 10:00:00'), S('secretname-a', 'garbage'),
    S('secretname-b', 'nov/20/2026 23:59:59'),
    S('secretname-c', 'nov/21/2026 01:00:00'), S('secretname-d', 'nov/21/2026 02:00:00'),
    S('secretname-e', 'nov/21/2026 03:00:00'), S('secretname-f', 'nov/20/2026 04:00:00'),
    S('secretname-g', 'nov/21/2026 05:00:00'),
    S('secretname-i', 'nov/22/2026 08:00:00'), S('secretname-i', 'nov/21/2026 12:00:00'), // الأحدث أولاً عمداً
    S('secretname-j', 'nov/22/2026 00:00:01'),
    S('zzz-deleted-user', 'nov/20/2026 10:00:00'),
  ];
  return { users, sessions };
}

test('aggregateCards: يوم فتح الكرت = أصغر from-time، وربط الباقات، وتجاهل 3000RY، والمنتهية تُعدّ وتُعلَّم', () => {
  const agg = aggregateCards(scenario());
  assert.deepEqual(agg.days['2026-11-20'], { counts: [2, 0, 0, 0, 0], usedBytes: 150, expired: 1 }); // a + b (جيب في فئة 100)، وf منتهية
  assert.deepEqual(agg.days['2026-11-21'], { counts: [0, 1, 0, 1, 1], usedBytes: 1027, expired: 0 }); // i فُتح 21 رغم جلسة لاحقة، و1000ريال في فئة 1000
  assert.deepEqual(agg.days['2026-11-22'], { counts: [0, 0, 1, 0, 0], usedBytes: 3, expired: 0 });   // 250جيب في فئة 250
  assert.deepEqual(agg.totals, {
    users: 10, opened: 7, neverOpened: 1, usedWithoutSession: 0, ignored: 1, expired: 1, unmappedCards: 1, badTimes: 1, orphanSessions: 1,
  });
  assert.equal(agg.totals.users, agg.totals.opened + agg.totals.ignored + agg.totals.unmappedCards + agg.totals.neverOpened, 'لا كرت يضيع من الحساب');
  assert.deepEqual(agg.unmapped, { Weird: 1 });
});

test('aggregateCards: الناتج لا يحتوي أسماء مستخدمين', () => {
  const out = JSON.stringify(aggregateCards(scenario()));
  assert.ok(!out.includes('secretname') && !out.includes('zzz-deleted'));
});

test('aggregateCards: استهلاك بلا جلسات يُحصى ولا يُنسب ليوم', () => {
  const agg = aggregateCards({ users: [U('x', '100RY', 500)], sessions: [] });
  assert.deepEqual(agg.days, {});
  assert.equal(agg.totals.usedWithoutSession, 1);
  assert.equal(agg.totals.neverOpened, 1);
});

const D = '2026-11-20';
const rd = (c0, usedBytes, expired = 0) => ({ counts: [c0, 0, 0, 0, 0], usedBytes, expired });

test('قاعدة التثبيت: قراءة أولى ثم زيادة ثم تطابق في يوم لاحق = تثبيت، وبعده لا قراءة', () => {
  const a = applyDayReading(undefined, D, rd(2, 1000), '2026-11-21');
  assert.equal(a.action, 'new');
  assert.deepEqual([a.entry.lb, a.entry.lp, a.entry.lr, a.entry.c], [1000, false, '2026-11-21', [2, 0, 0, 0, 0]]);
  assert.equal(isTemporary(a.entry), true);

  const same = applyDayReading(a.entry, D, rd(2, 1000), '2026-11-21');
  assert.equal(same.action, 'unchanged', 'مزامنتان في اليوم نفسه لا تثبّتان');
  assert.equal(same.entry.lp, false);

  const grew = applyDayReading(same.entry, D, rd(2, 5000), '2026-11-22');
  assert.equal(grew.action, 'updated');
  assert.deepEqual([grew.entry.lb, grew.entry.lp, grew.entry.lr], [5000, false, '2026-11-22']);

  const pin = applyDayReading(grew.entry, D, rd(2, 5000), '2026-11-23');
  assert.equal(pin.action, 'pinned');
  assert.equal(pin.entry.lp, true);
  assert.equal(pin.entry.p, bytesToGB(5000));
  assert.equal(isTemporary(pin.entry), false);

  const after = applyDayReading(pin.entry, D, rd(9, 99999), '2026-11-24');
  assert.equal(after.action, 'skipped-pinned');
  assert.equal(after.entry, pin.entry, 'المثبّت لا يتغيّر مهما كانت القراءة الجديدة');
});

test('قاعدة التثبيت: لا تثبيت بقراءات في يوم الكروت نفسه، ويُثبَّت بعد قراءتين متطابقتين بعد انتهاء اليوم', () => {
  const a = applyDayReading(undefined, D, rd(2, 1000), D);        // قراءة أثناء اليوم نفسه
  const b = applyDayReading(a.entry, D, rd(2, 1000), '2026-11-21'); // أول قراءة لاحقة: تطابق لكن القراءة السابقة كانت في اليوم نفسه
  assert.equal(b.action, 'unchanged');
  assert.equal(b.entry.lp, false);
  assert.equal(b.entry.lr, '2026-11-21', 'lr يتقدم، وإلا لن يُثبَّت اليوم أبداً');
  const c = applyDayReading(b.entry, D, rd(2, 1000), '2026-11-22');
  assert.equal(c.action, 'pinned');
});

test('قاعدة التثبيت: زيادة عدد الكروت وحدها (والبايتات ثابتة) تغيير، فلا تثبيت', () => {
  const a = applyDayReading(undefined, D, rd(2, 1000), '2026-11-21');
  const b = applyDayReading(a.entry, D, rd(3, 1000), '2026-11-22');
  assert.equal(b.action, 'updated');
  assert.equal(b.entry.lp, false);
  assert.deepEqual(b.entry.c, [3, 0, 0, 0, 0]);
});

// قرار المستخدم ج13: إن نقص الرقم (اختفى كرت بعد انتهائه) يُثبَّت اليوم على أكبر قيمة رُصدت.
test('قاعدة التثبيت: نقصان بعد انتهاء اليوم يُثبّت على أكبر قيمة رُصدت، وبعده لا قراءة', () => {
  const a = applyDayReading(undefined, D, rd(2, 5000), '2026-11-21');
  const b = applyDayReading(a.entry, D, rd(1, 3000, 1), '2026-11-22');
  assert.equal(b.action, 'pinned-max');
  assert.deepEqual([b.entry.lb, b.entry.p, b.entry.c, b.entry.lp, b.entry.lx], [5000, bytesToGB(5000), [2, 0, 0, 0, 0], true, 1]);
  assert.equal(isTemporary(b.entry), false);
  const after = applyDayReading(b.entry, D, rd(9, 99999), '2026-11-23');
  assert.equal(after.action, 'skipped-pinned');
  assert.equal(after.entry, b.entry);
});

test('قاعدة التثبيت: نقصان البايتات وحدها (الأعداد ثابتة) يُثبّت أيضاً على الأكبر', () => {
  const a = applyDayReading(undefined, D, rd(2, 5000), '2026-11-21');
  const b = applyDayReading(a.entry, D, rd(2, 4000), '2026-11-22');
  assert.equal(b.action, 'pinned-max');
  assert.deepEqual([b.entry.lb, b.entry.lp], [5000, true]);
});

test('قاعدة التثبيت: نقصان في أول قراءة بعد انتهاء اليوم يُثبَّت ولو كانت القراءة السابقة في يوم الكروت نفسه', () => {
  const a = applyDayReading(undefined, D, rd(2, 5000), D);          // قراءة أثناء يوم الكروت
  const b = applyDayReading(a.entry, D, rd(2, 4000), '2026-11-21'); // أول قراءة بعد انتهائه: نقص
  assert.equal(b.action, 'pinned-max');
  assert.deepEqual([b.entry.lb, b.entry.lp], [5000, true]);
});

test('قاعدة التثبيت: نقصان في يوم الكروت نفسه لا يُثبَّت (اليوم لم ينتهِ)، ويُحتفظ بالأكبر', () => {
  const a = applyDayReading(undefined, D, rd(2, 5000), D);
  const b = applyDayReading(a.entry, D, rd(1, 3000), D);
  assert.equal(b.action, 'decreased');
  assert.deepEqual([b.entry.lb, b.entry.c[0], b.entry.lp], [5000, 2, false]);
});

test('قاعدة التثبيت: زيادة مع نقصان في الوقت نفسه = ما زال يتغيّر، فلا تثبيت؛ ثم نقصان خالص يثبّت على الأكبر الجديد', () => {
  const a = applyDayReading(undefined, D, rd(2, 5000), '2026-11-21');
  const b = applyDayReading(a.entry, D, rd(1, 6000, 1), '2026-11-22'); // البايتات زادت وعدد كرت نقص
  assert.equal(b.action, 'updated');
  assert.deepEqual([b.entry.lb, b.entry.c[0], b.entry.lp], [6000, 2, false]);
  const c = applyDayReading(b.entry, D, rd(1, 6000, 1), '2026-11-23');
  assert.equal(c.action, 'pinned-max');
  assert.deepEqual([c.entry.lb, c.entry.c[0], c.entry.lp], [6000, 2, true]);
});

test('لا يُكتب فوق إدخال يدوي (p أو c بلا lb)، ويُحفظ باقي حقول اليوم عند القراءة الأولى', () => {
  const manual = { p: 1.5, c: [1, 0, 0, 0, 0] };
  const m = applyDayReading(manual, D, rd(2, 1000), '2026-11-21');
  assert.equal(m.action, 'skipped-manual');
  assert.equal(m.entry, manual);
  const other = { b: [1, 2, 3], s: 100 };
  const n = applyDayReading(other, D, rd(2, 1000), '2026-11-21');
  assert.equal(n.action, 'new');
  assert.deepEqual([n.entry.b, n.entry.s], [[1, 2, 3], 100]);
});

test('mergeReadings: لا يعدّل الحالة الأصلية، ويثبّت الأيام تدريجياً، ويخفي الأيام القديمة (بدأت ناقصة) فلا تُخزَّن', () => {
  const agg = aggregateCards(scenario());
  agg.days['2026-11-01'] = { counts: [0, 0, 0, 0, 0], usedBytes: 0, expired: 3 };
  const s0 = { op: { '2026-11': [1, 2, 3] }, d: {} };
  const snap = JSON.stringify(s0);

  const m1 = mergeReadings(s0, agg, '2026-11-22');
  assert.equal(JSON.stringify(s0), snap, 'الأصل لم يُعدَّل');
  assert.deepEqual(m1.results.map((r) => `${r.day}:${r.action}`), [
    '2026-11-01:hidden-old', '2026-11-20:hidden-old', '2026-11-21:new', '2026-11-22:new', // 11-20 فيه كرت منتهٍ (f) منذ أول قراءة
  ]);
  assert.deepEqual(Object.keys(m1.state.d), ['2026-11-21', '2026-11-22'], 'الأيام القديمة لا تُخزَّن');
  assert.deepEqual(m1.state.op, s0.op);

  const m2 = mergeReadings(m1.state, agg, '2026-11-23');
  const act2 = Object.fromEntries(m2.results.map((r) => [r.day, r.action]));
  assert.deepEqual([act2['2026-11-20'], act2['2026-11-21'], act2['2026-11-22']], ['hidden-old', 'pinned', 'unchanged']); // 11-22: قراءته السابقة كانت في يومه نفسه

  const m3 = mergeReadings(m2.state, agg, '2026-11-24');
  const act3 = Object.fromEntries(m3.results.map((r) => [r.day, r.action]));
  assert.deepEqual([act3['2026-11-20'], act3['2026-11-21'], act3['2026-11-22']], ['hidden-old', 'skipped-pinned', 'pinned']);
  assert.equal(m3.state.d['2026-11-20'], undefined);
});

test('mergeReadings: يوم خُزِّن مكتملاً ثم انتهى بعض كروته لا يُخفى؛ ينقص الرقم فيُثبَّت على الأكبر وتبقى أعداده', () => {
  const full = { days: { [D]: { counts: [2, 0, 0, 0, 0], usedBytes: 5000, expired: 0 } } };
  const m1 = mergeReadings({ d: {} }, full, '2026-11-21');
  assert.equal(m1.results[0].action, 'new');
  const later = { days: { [D]: { counts: [1, 0, 0, 0, 0], usedBytes: 3000, expired: 1 } } }; // كرت انتهى واختفى من التصنيف
  const m2 = mergeReadings(m1.state, later, '2026-11-22');
  assert.equal(m2.results[0].action, 'pinned-max');
  const e = m2.state.d[D];
  assert.deepEqual([e.lb, e.c, e.lp, e.lx], [5000, [2, 0, 0, 0, 0], true, 1]);
});

test('mergeReadings: يوم مخزّن غير مثبّت اختفت كل كروته من القراءة يُثبَّت على أكبر قيمة، ولا يُعاد النظر فيه', () => {
  const m1 = mergeReadings({ d: {} }, { days: { [D]: { counts: [2, 0, 0, 0, 0], usedBytes: 5000, expired: 0 } } }, '2026-11-21');
  const same = mergeReadings(m1.state, { days: {} }, D); // يوم الكروت نفسه: لا شيء يُفعل
  assert.deepEqual(same.results, []);
  const m2 = mergeReadings(m1.state, { days: {} }, '2026-11-22');
  assert.deepEqual(m2.results, [{ day: D, action: 'pinned-max' }]);
  assert.deepEqual([m2.state.d[D].lb, m2.state.d[D].lp], [5000, true]);
  const m3 = mergeReadings(m2.state, { days: {} }, '2026-11-23');
  assert.deepEqual(m3.results, [], 'المثبّت لا يُقرأ بعدها');
});

test('mergeReadings: يوم قديم فيه حقول أخرى (أرصدة ومبيعات) يُخفى بلا مساس بما فيه، ولا تُكتب له قيم L', () => {
  const st = { d: { [D]: { b: [1, 2, 3], s: 100 } } };
  const m = mergeReadings(st, { days: { [D]: { counts: [1, 0, 0, 0, 0], usedBytes: 10, expired: 2 } } }, '2026-11-25');
  assert.equal(m.results[0].action, 'hidden-old');
  assert.deepEqual(m.state.d[D], { b: [1, 2, 3], s: 100 });
});

// قرار المستخدم ج15: لا يُقبل يوم جديد عمره أكبر من يوم واحد قبل يوم القراءة (اليوم والأمس فقط).
test('dayAge وisTooOldForFirstSight: حدود الشهر والسنة الكبيسة والتواريخ غير الصالحة', () => {
  assert.equal(FIRST_SIGHT_MAX_AGE_DAYS, 1);
  assert.equal(dayAge('2026-11-22', '2026-11-23'), 1);
  assert.equal(dayAge('2026-11-23', '2026-11-23'), 0);
  assert.equal(dayAge('2026-10-31', '2026-11-01'), 1);   // حدّ الشهر
  assert.equal(dayAge('2027-02-28', '2027-03-01'), 1);   // سنة غير كبيسة
  assert.equal(dayAge('2028-02-28', '2028-03-01'), 2);   // 29 فبراير موجود
  assert.equal(dayAge('2026-11-24', '2026-11-23'), -1);  // يوم «في المستقبل»
  for (const bad of ['x', '', null, undefined, '2026-02-30', '2026-13-01', 20261123]) assert.equal(dayAge(bad, '2026-11-23'), null, String(bad));
  assert.equal(isTooOldForFirstSight('2026-11-22', '2026-11-23'), false); // الأمس مقبول
  assert.equal(isTooOldForFirstSight('2026-11-21', '2026-11-23'), true);  // قبل أمس مرفوض
  assert.equal(isTooOldForFirstSight('2026-11-24', '2026-11-23'), false); // المستقبل لا يُعدّ قديماً
  assert.equal(isTooOldForFirstSight('garbage', '2026-11-23'), false);    // غير صالح: لا يُحكم عليه هنا
  assert.equal(isTooOldForFirstSight('2026-11-20', '2026-11-23', 3), false);
  assert.equal(isTooOldForFirstSight('2026-11-19', '2026-11-23', 3), true);
});

test('mergeReadings (ج15): يوم جديد عمره أكبر من يوم يُخفى ولو لم تكن فيه كروت منتهية؛ اليوم والأمس يُقبلان', () => {
  const day = (c0, bytes, expired = 0) => ({ counts: [c0, 0, 0, 0, 0], usedBytes: bytes, expired });
  const agg = { days: {
    '2024-11-15': day(1, 60),   // كرت قديم ما زال بباقته (حالة التقرير الحقيقي الأول)
    '2026-10-25': { counts: [0, 0, 0, 0, 1], usedBytes: 5000, expired: 0 },
    '2026-11-21': day(3, 300),  // قبل أمس: مرفوض
    '2026-11-22': day(41, 4100), // الأمس
    '2026-11-23': day(5, 500),  // اليوم
  } };
  const m = mergeReadings({ d: {} }, agg, '2026-11-23');
  const by = Object.fromEntries(m.results.map((r) => [r.day, r]));
  for (const k of ['2024-11-15', '2026-10-25', '2026-11-21']) {
    assert.equal(by[k].action, 'hidden-old', k);
    assert.equal(by[k].reason, 'age', k);
    assert.equal(m.state.d[k], undefined, 'لا يُكتب في الحالة: ' + k);
  }
  assert.equal(by['2026-11-22'].action, 'new');
  assert.equal(by['2026-11-23'].action, 'new');
  assert.deepEqual(Object.keys(m.state.d).sort(), ['2026-11-22', '2026-11-23']);
  assert.equal(m.state.d['2026-11-22'].lb, 4100);
});

test('mergeReadings (ج15): سبب الإخفاء age أو expired؛ واليوم القريب الذي فيه كروت منتهية يبقى مخفياً بسبب expired', () => {
  const agg = { days: {
    '2026-11-20': { counts: [1, 0, 0, 0, 0], usedBytes: 10, expired: 2 }, // قديم ومنتهٍ: age أولاً
    '2026-11-22': { counts: [1, 0, 0, 0, 0], usedBytes: 10, expired: 1 }, // أمس لكن بدأ ناقصاً
  } };
  const m = mergeReadings({ d: {} }, agg, '2026-11-23');
  assert.deepEqual(m.results.map((r) => [r.day, r.action, r.reason, r.expired]), [
    ['2026-11-20', 'hidden-old', 'age', 2], ['2026-11-22', 'hidden-old', 'expired', 1],
  ]);
  assert.deepEqual(m.state.d, {});
});

test('mergeReadings (ج15): اليوم المخزّن يبقى يُحدَّث ويُثبَّت مهما كبر عمره؛ والعتبة maxAgeDays قابلة للتغيير', () => {
  const K = '2026-11-21';
  const rd = (n) => ({ days: { [K]: { counts: [2, 0, 0, 0, 0], usedBytes: n, expired: 0 } } });
  const a = mergeReadings({ d: {} }, rd(5000), '2026-11-21');
  assert.equal(a.results[0].action, 'new');
  const b = mergeReadings(a.state, rd(5000), '2026-11-22');
  assert.equal(b.results[0].action, 'unchanged');
  const c = mergeReadings(b.state, rd(5000), '2026-11-25'); // عمره 4 أيام، لكنه مخزّن
  assert.equal(c.results[0].action, 'pinned');
  assert.equal(c.state.d[K].lp, true);

  const old = { days: { '2026-11-20': { counts: [1, 0, 0, 0, 0], usedBytes: 9, expired: 0 }, '2026-11-19': { counts: [1, 0, 0, 0, 0], usedBytes: 9, expired: 0 } } };
  const wide = mergeReadings({ d: {} }, old, '2026-11-23', { maxAgeDays: 3 });
  assert.deepEqual(wide.results.map((r) => [r.day, r.action]), [['2026-11-19', 'hidden-old'], ['2026-11-20', 'new']]);
});

// قرار المستخدم ج12: ثابت الفئة 500 في صيغة R صار 2000 م.ب (كان 1500)، وبقية الثوابت كما هي.
test('الواجهة: ثوابت صيغة R = [300,650,800,2000,5000]', () => {
  const html = fs.readFileSync(new URL('../www/adsl-app.html', import.meta.url), 'utf8');
  const m = /const CARD=\[([^\]]+)\]/.exec(html);
  assert.ok(m, 'لم يُعثر على CARD');
  assert.deepEqual(m[1].split(',').map(Number), [300, 650, 800, 2000, 5000]);
});
