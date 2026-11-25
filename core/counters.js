// منطق عدادات الواجهات (RX/TX). دوال نقية بلا شبكة وبلا تخزين، لتُختبر بسهولة.
//
// القواعد (من CLAUDE.md §5 و§7):
//  - الاستهلاك = القراءة الحالية - السابقة.
//  - انخفاض العداد أو إعادة تشغيل الراوتر: لا فرق سالب ولا استهلاك مُدّعى، وتصبح القراءة الحالية نقطة مرجعية جديدة.
//  - فشل الاتصال أو غياب القيمة ليس صفراً: لا تُنشأ قراءة أصلاً، وأي قيمة غير صالحة تُستبعد بحالتها.
//  - لا تكرار للسجلات عند إعادة المزامنة، ولا حذف للتاريخ.

export const STATUS = Object.freeze({
  OK: 'ok',           // فرق طبيعي
  FIRST: 'first',     // أول قراءة: نقطة مرجعية بلا استهلاك
  NEW: 'new',         // واجهة ظهرت لأول مرة: نقطة مرجعية بلا استهلاك
  RESET: 'reset',     // تصفير/إعادة تشغيل: نقطة مرجعية جديدة بلا استهلاك
  INVALID: 'invalid', // قيمة غير صالحة: لا استهلاك
});

export class CounterError extends Error {
  constructor(code, message) { super(message || code); this.name = 'CounterError'; this.code = code; }
}

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

// ينشئ قراءة موثوقة. يرمي عند غياب الأساسيات حتى لا تُسجَّل قراءة ناقصة.
// ifaces: [{name, rx, tx, ...}] — الواجهات ذات rx/tx غير الصالحة تُحفظ في invalid ولا تدخل الحساب.
export function makeReading({ ts, uptimeSec = null, ifaces }) {
  if (!Number.isFinite(ts)) throw new CounterError('BAD_TIMESTAMP', 'وقت القراءة غير صالح');
  if (uptimeSec !== null && !(Number.isFinite(uptimeSec) && uptimeSec >= 0)) {
    throw new CounterError('BAD_UPTIME', 'قيمة uptime غير صالحة');
  }
  if (!Array.isArray(ifaces) || ifaces.length === 0) {
    throw new CounterError('EMPTY_READING', 'لا توجد واجهات مقروءة. لن تُسجَّل القراءة.');
  }
  const good = {};
  const invalid = [];
  for (const i of ifaces) {
    if (!i || !i.name) continue;
    if (isCount(i.rx) && isCount(i.tx)) {
      if (good[i.name]) continue; // لا تحتسب الواجهة مرتين
      good[i.name] = { rx: i.rx, tx: i.tx, kind: typeof i.kind === 'string' ? i.kind : 'other', vlanId: Number.isInteger(i.vlanId) && i.vlanId > 0 ? i.vlanId : null, parent: typeof i.parent === 'string' ? i.parent : null, bridge: typeof i.bridge === 'string' ? i.bridge : null, running: i.running === true, disabled: i.disabled === true, comment: typeof i.comment === 'string' ? i.comment.slice(0, 300) : '' };
    } else {
      invalid.push(i.name);
    }
  }
  if (Object.keys(good).length === 0) {
    throw new CounterError('NO_VALID_COUNTERS', 'كل العدادات المقروءة غير صالحة. لن تُسجَّل القراءة.');
  }
  return { ts, uptimeSec, ifaces: good, invalid };
}

// هل أُعيد تشغيل الراوتر بين القراءتين؟
export function detectReboot(prev, curr, toleranceSec = 300) {
  if (prev.uptimeSec === null || curr.uptimeSec === null) return { rebooted: false, known: false };
  if (curr.uptimeSec < prev.uptimeSec) return { rebooted: true, reason: 'uptime-decreased', known: true };
  const elapsed = (curr.ts - prev.ts) / 1000;
  if (curr.uptimeSec + toleranceSec < prev.uptimeSec + elapsed) {
    return { rebooted: true, reason: 'uptime-below-expected', known: true };
  }
  return { rebooted: false, known: true };
}

// يحسب نتائج الفترة بين قراءتين. لا يعدّل أياً منهما.
// يعيد { reboot, results: {name: {status, rx, tx, total, reason}}, missing: [names] }
export function computePeriod(prev, curr, { toleranceSec = 300 } = {}) {
  const results = {};
  if (!prev) {
    for (const n of Object.keys(curr.ifaces)) results[n] = { status: STATUS.FIRST, rx: null, tx: null, total: null };
    for (const n of curr.invalid) results[n] = { status: STATUS.INVALID, rx: null, tx: null, total: null };
    return { reboot: { rebooted: false, known: false }, results, missing: [] };
  }
  if (curr.ts <= prev.ts) throw new CounterError('TIME_ORDER', 'وقت القراءة الحالية ليس بعد السابقة');

  const reboot = detectReboot(prev, curr, toleranceSec);
  for (const [n, c] of Object.entries(curr.ifaces)) {
    const p = prev.ifaces[n];
    if (!p) { results[n] = { status: STATUS.NEW, rx: null, tx: null, total: null }; continue; }
    if (reboot.rebooted) {
      results[n] = { status: STATUS.RESET, rx: null, tx: null, total: null, reason: reboot.reason };
    } else if (c.rx < p.rx || c.tx < p.tx) {
      results[n] = { status: STATUS.RESET, rx: null, tx: null, total: null, reason: 'counter-decreased' };
    } else {
      const rx = c.rx - p.rx;
      const tx = c.tx - p.tx;
      results[n] = { status: STATUS.OK, rx, tx, total: rx + tx };
    }
  }
  for (const n of curr.invalid) results[n] = { status: STATUS.INVALID, rx: null, tx: null, total: null };
  const missing = Object.keys(prev.ifaces).filter((n) => !(n in curr.ifaces) && !curr.invalid.includes(n));
  return { reboot, results, missing };
}

// يضيف قراءة إلى التاريخ دون تكرار ودون حذف. يعيد تاريخاً جديداً (لا يعدّل الأصل).
// history: [{ reading, period }]  period = نتيجة computePeriod مقابل القراءة السابقة.
export function appendReading(history, reading, opts) {
  const last = history.length ? history[history.length - 1] : null;
  if (history.some((h) => h.reading.ts === reading.ts)) {
    return { history, duplicate: true, period: null };
  }
  if (last && reading.ts < last.reading.ts) {
    throw new CounterError('OUT_OF_ORDER', 'قراءة أقدم من آخر قراءة محفوظة. لم تُضف.');
  }
  const period = computePeriod(last ? last.reading : null, reading, opts);
  return { history: [...history, { reading, period }], duplicate: false, period };
}

// مجموع استهلاك مجموعة واجهات يحددها المستخدم، مع تجاهل غير الحاسوب منها.
// لا يُجمع إلا الواجهات ذات الحالة OK؛ ويُرجع أيضاً عدد الواجهات المستبعدة ليظهر في الواجهة.
export function sumPeriod(period, names) {
  let rx = 0, tx = 0, counted = 0, skipped = 0;
  for (const n of new Set(names)) {
    const r = period.results[n];
    if (r && r.status === STATUS.OK) { rx += r.rx; tx += r.tx; counted++; } else { skipped++; }
  }
  return { rx, tx, total: rx + tx, counted, skipped };
}

// عرض بوحدات مفهومة. الأساس 1024 ليتوافق مع قسمة 1024 في صيغ Excel.
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  const GB = 1024 ** 3, MB = 1024 ** 2;
  if (n >= GB) return `${(n / GB).toFixed(2)} GB`;
  return `${(n / MB).toFixed(2)} MB`;
}
