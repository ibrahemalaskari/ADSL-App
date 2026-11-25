import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateLineConsumption, calculateDailyLineReconciliation } from '../core/line-balance-reconciliation.js';

test('يحسب الاستهلاك من فرق الرصيد بدقة أربع منازل', () => {
  assert.deepEqual(calculateLineConsumption(20, 13.45678), { consumption: 6.5432, status: 'OK', reason: null });
});

test('لا يخترع استهلاكاً عند غياب قراءة البداية أو النهاية', () => {
  assert.equal(calculateLineConsumption(null, 5).status, 'NP');
  assert.equal(calculateLineConsumption(10, null).status, 'NC');
  assert.equal(calculateLineConsumption(10, 12).status, 'RC');
});

test('الفارق اليدوي يتقدم على القراءة الآلية ويسمح بالقيمة السالبة', () => {
  assert.deepEqual(calculateLineConsumption(10, 15, -2), { consumption: -2, status: 'M', reason: 'manual-adjustment' });
});

test('التسوية اليومية تميز الإجمالي الجزئي عن المكتمل', () => {
  const result = calculateDailyLineReconciliation({ previous: [10, 20, null], current: [8, 18, 5], adjustments: [null, null, null] });
  assert.equal(result.total, 4);
  assert.equal(result.knownLines, 2);
  assert.equal(result.missingLines, 1);
  assert.equal(result.complete, false);
  assert.equal(result.hasWarnings, true);
});

test('يرفض المدخلات الرقمية غير الصالحة دون نتيجة محاسبية', () => {
  assert.throws(() => calculateLineConsumption(-1, 0), /غير صالح/);
  assert.throws(() => calculateLineConsumption(1, 0, 'abc'), /غير صالح/);
  assert.throws(() => calculateDailyLineReconciliation({ previous: [1], current: [1, 2, 3], adjustments: [null, null, null] }), /ثلاث قيم/);
});
