// Merge SQLite's authoritative manual line balances into the legacy UI state.
// All other day fields (router readings, sales, card counts, etc.) are preserved.
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export function mergeLineBalances(state, records) {
  if (!state || typeof state !== 'object' || !state.d || typeof state.d !== 'object' || Array.isArray(state.d)) throw new TypeError('حالة التطبيق غير صالحة');
  if (!Array.isArray(records)) throw new TypeError('قراءات أرصدة SQLite غير صالحة');
  const next = JSON.parse(JSON.stringify(state));
  for (const entry of Object.values(next.d)) {
    if (entry && typeof entry === 'object') { delete entry.b; delete entry.o; }
  }
  for (const row of records) {
    if (!row || !DAY_RE.test(String(row.day)) || !Array.isArray(row.balances) || row.balances.length !== 3 || !Array.isArray(row.adjustments) || row.adjustments.length !== 3) throw new TypeError('سجل أرصدة SQLite غير صالح');
    const hasBalances = row.balances.some(v => v != null), hasAdjustments = row.adjustments.some(v => v != null);
    if (!hasBalances && !hasAdjustments) continue;
    const entry = next.d[row.day] || (next.d[row.day] = {});
    if (hasBalances) entry.b = row.balances;
    if (hasAdjustments) entry.o = row.adjustments;
  }
  return next;
}
