// إدارة إدخال أرصدة الخطوط فقط.
// لا تقبل هذه الوحدة حقول المبيعات أو قراءات الراوتر، وتحافظ عليها كما هي.

const LINE_COUNT = 3;

function normalizeValues(values, field, { allowNegative = false } = {}) {
  if (!Array.isArray(values) || values.length !== LINE_COUNT) {
    throw new TypeError(`${field}: expected exactly ${LINE_COUNT} values`);
  }
  return values.map((value, index) => {
    if (value == null || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new TypeError(`${field}[${index}]: expected a finite number or null`);
    if (!allowNegative && n < 0) throw new RangeError(`${field}[${index}]: negative values are not allowed`);
    return n;
  });
}

function hasValues(values) {
  return Array.isArray(values) && values.some((value) => value != null);
}

function cloneState(state) {
  if (!state || typeof state !== 'object' || !state.d || typeof state.d !== 'object') {
    throw new TypeError('state.d is required');
  }
  return { ...state, d: { ...state.d } };
}

/**
 * Saves only the three manual line balances (b) and their optional top-up
 * adjustments (o). All other day fields are preserved byte-for-byte by value.
 */
export function saveLineBalanceEntry(state, day, { balances, adjustments }) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new TypeError('day must be YYYY-MM-DD');
  }
  const b = normalizeValues(balances, 'balances');
  const o = normalizeValues(adjustments, 'adjustments', { allowNegative: true });
  const next = cloneState(state);
  const entry = { ...(next.d[day] || {}) };

  if (hasValues(b)) entry.b = b;
  else delete entry.b;

  if (hasValues(o)) entry.o = o;
  else delete entry.o;

  if (Object.keys(entry).length) next.d[day] = entry;
  else delete next.d[day];
  return next;
}

/** Clears only user-entered line balances/adjustments, never imported facts. */
export function clearLineBalanceEntry(state, day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new TypeError('day must be YYYY-MM-DD');
  }
  const next = cloneState(state);
  const entry = { ...(next.d[day] || {}) };
  delete entry.b;
  delete entry.o;
  if (Object.keys(entry).length) next.d[day] = entry;
  else delete next.d[day];
  return next;
}
