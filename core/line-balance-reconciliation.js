// Pure accounting rules for daily remaining-balance readings.
// Status codes intentionally match the existing UI: OK, M, NC, NP, RC.
const EPSILON = 1e-9;

function finiteOrNull(value, label) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new TypeError(`${label} غير صالح`);
  return n;
}

/**
 * Calculate consumption for one line between two readings.
 * A manual adjustment is an explicitly entered consumption and therefore
 * takes precedence over automatic subtraction, matching the established app rule.
 */
export function calculateLineConsumption(previous, current, adjustment = null) {
  const p = finiteOrNull(previous, 'الرصيد السابق');
  const c = finiteOrNull(current, 'الرصيد الحالي');
  if (adjustment != null && adjustment !== '') {
    const a = Number(adjustment);
    if (!Number.isFinite(a)) throw new TypeError('الفارق اليدوي غير صالح');
    return { consumption: a, status: 'M', reason: 'manual-adjustment' };
  }
  if (c == null) return { consumption: null, status: 'NC', reason: 'current-reading-missing' };
  if (p == null) return { consumption: null, status: 'NP', reason: 'previous-reading-missing' };
  if (c > p + EPSILON) return { consumption: null, status: 'RC', reason: 'balance-increased-without-adjustment' };
  return { consumption: Math.round((p - c) * 1e4) / 1e4, status: 'OK', reason: null };
}

/** Calculate a three-line daily summary without inventing missing readings. */
export function calculateDailyLineReconciliation({ previous = [], current = [], adjustments = [] } = {}) {
  for (const [name, values] of [['الرصيد السابق', previous], ['الرصيد الحالي', current], ['الفروقات اليدوية', adjustments]]) {
    if (!Array.isArray(values) || values.length !== 3) throw new TypeError(`${name}: يجب توفير ثلاث قيم`);
  }
  const lines = [0, 1, 2].map(i => calculateLineConsumption(previous[i], current[i], adjustments[i]));
  const known = lines.filter(x => x.consumption != null);
  const total = known.length ? Math.round(known.reduce((sum, x) => sum + x.consumption, 0) * 1e4) / 1e4 : null;
  return {
    lines,
    total,
    knownLines: known.length,
    missingLines: lines.filter(x => x.consumption == null).length,
    complete: lines.every(x => x.consumption != null),
    hasWarnings: lines.some(x => x.status === 'RC' || x.status === 'NC' || x.status === 'NP'),
  };
}
