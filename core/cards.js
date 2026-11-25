// منطق كروت اليوزر مانجر: تجميع الكروت حسب «يوم فتح الكرت»، وحساب العمود L، وقاعدة التثبيت.
// وحدة نقية: بلا اتصال بالراوتر ولا تخزين ولا واجهة. أسماء المستخدمين تدخل هنا في الذاكرة فقط
// لربط الجلسات بالمستخدمين، ولا تخرج في أي ناتج (قرار المستخدم ج12: القراءة مسموحة، بلا عرض ولا حفظ).
//
// القرارات المعتمدة من المستخدم (ج12):
//  - يوم فتح الكرت = يوم أول جلسة للمستخدم (أصغر from-time)؛ والعمود L = إجمالي استهلاك كروت ذلك اليوم.
//  - ربط الباقات بالفئات: 100RY و100جيب ← 100، 200RY و200جيب ← 200، 250RY و250جيب ← 250،
//    500RY ← 500، 1000RY و1000ريال ← 1000. باقة 3000RY تُتجاهل (لا تُعدّ ولا يدخل استهلاكها في L).
//  - الكروت بلا actual-profile (370 وقت الفحص) كروت منتهية الصلاحية: لا تُنسب لفئة، وتُعدّ وتُعلَّم.
//  - قاعدة التثبيت: تُقرأ قيمة اليوم في كل مزامنة؛ فإذا طابقت القراءة السابقة تماماً (لا تغيّر ولا زيادة)
//    يُثبَّت اليوم ولا يُقرأ بعدها.
//
// قرارات المستخدم (ج13):
//  - إن نقص رقم اليوم (اختفى كرت بعد انتهائه) يُثبَّت اليوم على أكبر قيمة رُصدت، ولا يبقى «مؤقتاً».
//  - الأيام القديمة (التي بدأت ناقصة: فيها كروت منتهية الصلاحية وقت أول قراءة لها) تُخفى: لا تُخزَّن ولا تُعرض.
//
// قرار المستخدم (ج15): لا يُقبل يوم جديد (غير مخزَّن) عمره أكبر من يوم واحد قبل يوم القراءة (اليوم والأمس فقط)،
//  لأن أقصر صلاحية يومان (100RY و100جيب)؛ فيُخفى ما عداه كالأيام القديمة (hidden-old، السبب 'age'). الأيام المخزّنة لا تتأثر.
//  (أظهرت أول قراءة حقيقية أياماً قديمة بكرت واحد لكل يوم لا يكشفها معيار الكروت المنتهية وحده.)
//
// افتراضات تقنية لم تُتحقق على راوتر حقيقي (تُفحص بأداة tools/cards-read.mjs):
//  - الاستهلاك = download-used + upload-used، بالبايت. (transfer-limit يبدو حداً للمجموع.)
//  - تاريخ from-time هو بتوقيت الراوتر المحلي، ويُستعمل يومه كما هو.

export const FACES = [100, 200, 250, 500, 1000];
export const BYTES_PER_GB = 1073741824; // 1024^3: يطابق ثوابت R (ميجا ÷ 1024 = جيجا)

export const DEFAULT_CARD_CONFIG = Object.freeze({
  packageFace: Object.freeze({
    '100RY': 100, '100جيب': 100,
    '200RY': 200, '200جيب': 200,
    '250RY': 250, '250جيب': 250,
    '500RY': 500,
    '1000RY': 1000, '1000ريال': 1000,
  }),
  ignoredPackages: Object.freeze(['3000RY']),
});

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const r4 = (n) => Math.round(n * 1e4) / 1e4;
const norm = (s) => String(s == null ? '' : s).normalize('NFC').trim();
const zeros = () => FACES.map(() => 0);

export const bytesToGB = (b) => r4(b / BYTES_PER_GB);

// 'nov/15/2024' -> '2024-11-15' أو null إن لم يكن تاريخاً صالحاً.
export function parseRosDate(s) {
  const m = /^([a-z]{3})\/(\d{1,2})\/(\d{4})$/i.exec(norm(s));
  if (!m) return null;
  const mon = MONTHS.indexOf(m[1].toLowerCase());
  const d = Number(m[2]), y = Number(m[3]);
  if (mon < 0 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, mon, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mon || t.getUTCDate() !== d) return null; // مثل feb/30
  return `${String(y).padStart(4, '0')}-${String(mon + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// 'nov/15/2024 21:24:04' -> { day: '2024-11-15', time: '21:24:04' } أو null.
export function parseRosTime(s) {
  const m = /^(\S+)\s+(\d{1,2}):(\d{2}):(\d{2})$/.exec(norm(s));
  if (!m) return null;
  const day = parseRosDate(m[1]);
  const hh = Number(m[2]), mm = Number(m[3]), ss = Number(m[4]);
  if (!day || hh > 23 || mm > 59 || ss > 59) return null;
  return { day, time: `${String(hh).padStart(2, '0')}:${m[3]}:${m[4]}` };
}

// ---------------------------------------------------------------- التجميع حسب يوم فتح الكرت

// users: [{ name, profile, usedBytes }]  usedBytes رقم أو null (لا حقول استهلاك = لم يستهلك).
// sessions: [{ user, from }]  from نص بصيغة الراوتر.
// الناتج لا يحتوي أي اسم مستخدم.
export function aggregateCards({ users, sessions }, config = DEFAULT_CARD_CONFIG) {
  const faceOf = new Map(Object.entries(config.packageFace).map(([k, v]) => [norm(k), v]));
  const ignored = new Set(config.ignoredPackages.map(norm));

  const known = new Set(users.map((u) => u.name));
  const firstDay = new Map();
  let badTimes = 0, orphanSessions = 0;
  for (const s of sessions) {
    if (!known.has(s.user)) { orphanSessions++; continue; }
    const t = parseRosTime(s.from);
    if (!t) { badTimes++; continue; }
    const cur = firstDay.get(s.user);
    if (cur === undefined || t.day < cur) firstDay.set(s.user, t.day);
  }

  const days = {};
  const unmapped = {};
  const totals = { users: users.length, opened: 0, neverOpened: 0, usedWithoutSession: 0, ignored: 0, expired: 0, unmappedCards: 0, badTimes, orphanSessions };
  const dayOf = (k) => (days[k] || (days[k] = { counts: zeros(), usedBytes: 0, expired: 0 }));

  for (const u of users) {
    const day = firstDay.get(u.name);
    if (!day) {
      totals.neverOpened++;
      if (u.usedBytes) totals.usedWithoutSession++; // استهلاك بلا جلسات: ربما حُذفت الجلسات القديمة
      continue;
    }
    const profile = norm(u.profile);
    if (profile === '') { dayOf(day).expired++; totals.expired++; totals.opened++; continue; }
    if (ignored.has(profile)) { totals.ignored++; continue; }
    const face = faceOf.get(profile);
    if (face === undefined) { unmapped[profile] = (unmapped[profile] || 0) + 1; totals.unmappedCards++; continue; }
    const d = dayOf(day);
    d.counts[FACES.indexOf(face)]++;
    d.usedBytes += u.usedBytes || 0;
    totals.opened++;
  }
  return { days, totals, unmapped };
}

// ---------------------------------------------------------------- قاعدة التثبيت

// حقول اليوم المخزّنة (متوافقة مع بنية S.d في الواجهة: p رصيد البرنامج بالجيجا، c عدد الكروت):
//   p  = L بالجيجا (مقرّب إلى 4 منازل)         lb = L بالبايت (للمقارنة الدقيقة)
//   c  = [100,200,250,500,1000]                 lp = true عندما يُثبَّت اليوم
//   lr = يوم آخر قراءة 'YYYY-MM-DD'             lx = عدد الكروت المنتهية (بلا باقة) وقت آخر قراءة (للعلم فقط)
//
// يُثبَّت اليوم في حالتين:
//   1) تطابق: هذه القراءة تطابق السابقة تماماً (البايتات وكل أعداد الفئات)، بشرط:
//      (أ) أن تُؤخذ القراءتان بعد انتهاء يوم الكروت (readOn > day و lr > day)،
//      (ب) أن تكونا في يومين مختلفين (readOn > lr). فمزامنتان في اليوم نفسه لا تُثبّتان شيئاً.
//   2) نقصان (قرار المستخدم ج13): نقص الرقم أو عدد فئة دون زيادة في أي شيء (اختفى كرت بعد انتهائه)
//      وكانت القراءة بعد انتهاء يوم الكروت (readOn > day): يُثبَّت اليوم على أكبر قيمة رُصدت (pinned-max).
//      نقصان في يوم الكروت نفسه لا يُثبَّت (decreased): اليوم لم ينتهِ بعد.
// إن زاد شيء (ولو مع نقصان شيء آخر) فاليوم ما زال يتغيّر: يُحتفظ بالأكبر ولا يُثبَّت (updated).
export function applyDayReading(prev, day, read, readOn) {
  if (prev && prev.lp) return { action: 'skipped-pinned', entry: prev };
  const hasManual = prev && prev.lb == null && (prev.p != null || (prev.c || []).some((x) => x != null));
  if (hasManual) return { action: 'skipped-manual', entry: prev }; // لا نكتب فوق إدخال يدوي

  const mk = (lb, c, lp, lr) => ({ ...(prev || {}), lb, p: bytesToGB(lb), c, lp, lr, lx: read.expired });
  if (!prev || prev.lb == null) return { action: 'new', entry: mk(read.usedBytes, read.counts.slice(), false, readOn) };

  const pc = prev.c || zeros();
  const grew = read.usedBytes > prev.lb || read.counts.some((v, i) => v > pc[i]);
  const dropped = read.usedBytes < prev.lb || read.counts.some((v, i) => v < pc[i]);
  const lb = Math.max(prev.lb, read.usedBytes);
  const c = read.counts.map((v, i) => Math.max(v, pc[i]));

  if (!grew && !dropped) {
    const canPin = readOn > day && prev.lr > day && readOn > prev.lr;
    return canPin
      ? { action: 'pinned', entry: mk(lb, c, true, readOn) }
      : { action: 'unchanged', entry: mk(lb, c, false, readOn > prev.lr ? readOn : prev.lr) }; // لا تثبيت بعد؛ lr يتقدم فقط إن كانت القراءة في يوم أحدث
  }
  if (grew) return { action: 'updated', entry: mk(lb, c, false, readOn) };
  return readOn > day
    ? { action: 'pinned-max', entry: mk(lb, c, true, readOn) }
    : { action: 'decreased', entry: mk(lb, c, false, readOn) };
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const isTracked = (e) => !!e && e.lb != null;

// عمر اليوم بالأيام قياساً إلى يوم القراءة (بتقويم التواريخ لا بالساعات): readOn - day. null إن لم يكن أحدهما تاريخاً صالحاً.
export const FIRST_SIGHT_MAX_AGE_DAYS = 1;
const dayNumber = (k) => {
  if (typeof k !== 'string' || !DAY_KEY.test(k)) return null;
  const y = Number(k.slice(0, 4)), m = Number(k.slice(5, 7)), d = Number(k.slice(8, 10));
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return Math.round(t.getTime() / 86400000);
};
export function dayAge(day, readOn) {
  const a = dayNumber(day), b = dayNumber(readOn);
  return a == null || b == null ? null : b - a;
}
// هل اليوم أقدم من أن يُقبل عند أول رؤية له؟ (تاريخ غير صالح: لا يُحكم عليه هنا، فلا يُعدّ قديماً.)
export function isTooOldForFirstSight(day, readOn, maxAgeDays = FIRST_SIGHT_MAX_AGE_DAYS) {
  const age = dayAge(day, readOn);
  return age != null && age > maxAgeDays;
}

// يطبّق ناتج aggregateCards على الحالة S (لا يعدّل المُدخل). يمسّ فقط أيام الكروت.
//  - يوم قديم (hidden-old): لم يُخزَّن بعد، ويُخفى ولا يُكتب في الحالة في حالتين: (age) عمره أكبر من maxAgeDays قبل يوم القراءة (ج15)،
//    أو (expired) وفيه وقت أول قراءة له كروت منتهية الصلاحية فبدأ ناقصاً.
//    (يوم خُزِّن مكتملاً ثم انتهت كروته لاحقاً لا يُخفى: أعداده محفوظة بالأكبر.)
//  - يوم مخزّن غير مثبّت اختفت كل كروته من القراءة (انتهت وحُذفت جلساتها أو حُذفت): يُعامل كقراءة صفرية،
//    أي نقصان، فيُثبَّت على أكبر قيمة رُصدت.
export function mergeReadings(state, agg, readOn, { maxAgeDays = FIRST_SIGHT_MAX_AGE_DAYS } = {}) {
  const next = { ...state, d: { ...(state.d || {}) } };
  const results = [];
  const days = new Set(Object.keys(agg.days));
  for (const k of Object.keys(next.d)) {
    if (DAY_KEY.test(k) && isTracked(next.d[k]) && !next.d[k].lp && k < readOn) days.add(k);
  }
  for (const day of [...days].sort()) {
    const prev = next.d[day];
    const r = agg.days[day] || { counts: zeros(), usedBytes: 0, expired: (prev && prev.lx) || 0 };
    if (!isTracked(prev) && isTooOldForFirstSight(day, readOn, maxAgeDays)) { results.push({ day, action: 'hidden-old', reason: 'age', expired: r.expired }); continue; }
    if (!isTracked(prev) && r.expired > 0) { results.push({ day, action: 'hidden-old', reason: 'expired', expired: r.expired }); continue; }
    if (!isTracked(prev) && r.counts.every((n) => n === 0)) { results.push({ day, action: 'skipped-no-classified-cards', expired: r.expired }); continue; }
    const out = applyDayReading(prev, day, r, readOn);
    if (out.entry !== next.d[day]) next.d[day] = out.entry;
    results.push({ day, action: out.action });
  }
  return { state: next, results };
}

// اليوم الذي L فيه غير مثبّت: يُعرض فاقد الرصيد S «مؤقتاً» له.
export const isTemporary = (entry) => !!entry && entry.lb != null && !entry.lp;
