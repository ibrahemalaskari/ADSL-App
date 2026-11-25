// محرك تسوية مستقل: لا يفترض وحدات الحقول أو مصادرها؛ يجب تمرير الوحدة صراحةً.
// لا يصدر حكماً عند نقص البيانات أو اختلاف نافذة القياس، ويحوّل إلى GB قبل المقارنة.
const FACTORS = Object.freeze({ B: 1 / (1024 ** 3), KB: 1 / (1024 ** 2), MB: 1 / 1024, GB: 1 });
const finiteNonNegative = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function toGigabytes(value, unit) {
  if (!finiteNonNegative(value) || !Object.hasOwn(FACTORS, unit)) return null;
  const result = value * FACTORS[unit];
  return Number.isFinite(result) ? result : null;
}

/**
 * يقارن مصدرين لنفس الفترة. القياسات: {value, unit, from, to, source}.
 * options: {absoluteToleranceGB=0.05, relativeTolerance=0.05}.
 */
export function detectMeasurementAnomaly(left, right, options = {}) {
  const absoluteToleranceGB = options.absoluteToleranceGB ?? 0.05;
  const relativeTolerance = options.relativeTolerance ?? 0.05;
  if (![absoluteToleranceGB, relativeTolerance].every(x => finiteNonNegative(x))) {
    throw new TypeError('حدود المقارنة يجب أن تكون أرقاماً غير سالبة');
  }
  if (!left || !right || left.value == null || right.value == null) {
    return { status: 'incomplete', code: 'MISSING_MEASUREMENT', differenceGB: null, percent: null };
  }
  const a = toGigabytes(left.value, left.unit), b = toGigabytes(right.value, right.unit);
  if (a == null || b == null) return { status: 'incomplete', code: 'INVALID_VALUE_OR_UNIT', differenceGB: null, percent: null };
  if (!left.from || !left.to || !right.from || !right.to) {
    return { status: 'incomplete', code: 'MISSING_PERIOD', differenceGB: null, percent: null };
  }
  if (left.from !== right.from || left.to !== right.to) {
    return { status: 'incomplete', code: 'PERIOD_MISMATCH', differenceGB: null, percent: null };
  }
  const differenceGB = Math.round(Math.abs(a - b) * 1e6) / 1e6;
  const baseline = Math.max(a, b);
  const percent = baseline === 0 ? 0 : differenceGB / baseline * 100;
  const threshold = Math.max(absoluteToleranceGB, baseline * relativeTolerance);
  const warning = differenceGB > threshold;
  return {
    status: warning ? 'warning' : 'ok',
    code: warning ? 'MEASUREMENT_GAP' : 'WITHIN_TOLERANCE',
    leftGB: a, rightGB: b, differenceGB,
    percent: Math.round(percent * 100) / 100,
    toleranceGB: Math.round(threshold * 1e6) / 1e6,
    sources: [String(left.source || 'source-1').slice(0, 80), String(right.source || 'source-2').slice(0, 80)],
  };
}

export function detectDailyAnomalies(items, options = {}) {
  if (!Array.isArray(items)) throw new TypeError('قائمة التسويات غير صالحة');
  return items.map((item, index) => ({ index, day: item?.day || null, ...detectMeasurementAnomaly(item?.left, item?.right, options) }));
}
