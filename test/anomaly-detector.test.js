import test from 'node:test';
import assert from 'node:assert/strict';
import { toGigabytes, detectMeasurementAnomaly, detectDailyAnomalies } from '../core/anomaly-detector.js';
const period = { from: '2026-11-25T00:00', to: '2026-11-26T00:00' };
test('تحويل الوحدات إلى GB دون خلط MB وGB', () => {
  assert.equal(toGigabytes(1024, 'MB'), 1);
  assert.equal(toGigabytes(1, 'GB'), 1);
  assert.equal(toGigabytes(1024 ** 3, 'B'), 1);
  assert.equal(toGigabytes(1, 'TB'), null);
});
test('التسوية بين وحدتين مختلفتين متكافئتين', () => {
  const r = detectMeasurementAnomaly({ ...period, value: 1024, unit: 'MB' }, { ...period, value: 1, unit: 'GB' });
  assert.equal(r.status, 'ok'); assert.equal(r.differenceGB, 0);
});
test('الفرق الكبير تحذير لا خطأ قطعي', () => {
  const r = detectMeasurementAnomaly({ ...period, value: 10, unit: 'GB' }, { ...period, value: 8, unit: 'GB' });
  assert.equal(r.status, 'warning'); assert.equal(r.code, 'MEASUREMENT_GAP');
});
test('القيمة صفر الحقيقية لا تعامل كبيانات مفقودة', () => {
  const r = detectMeasurementAnomaly({ ...period, value: 0, unit: 'GB' }, { ...period, value: 0, unit: 'GB' });
  assert.equal(r.status, 'ok'); assert.equal(r.differenceGB, 0);
});
test('القراءة الناقصة لا تتحول إلى صفر', () => {
  assert.equal(detectMeasurementAnomaly({ ...period, value: null, unit: 'GB' }, { ...period, value: 0, unit: 'GB' }).code, 'MISSING_MEASUREMENT');
});
test('اختلاف نافذة القياس يجعل المقارنة غير مكتملة', () => {
  const r = detectMeasurementAnomaly({ ...period, value: 1, unit: 'GB' }, { ...period, to: '2026-11-25T23:59', value: 1, unit: 'GB' });
  assert.equal(r.status, 'incomplete'); assert.equal(r.code, 'PERIOD_MISMATCH');
});
test('رفض الحدود غير الصالحة', () => assert.throws(() => detectMeasurementAnomaly({}, {}, { relativeTolerance: -1 }), TypeError));
test('تسوية مجموعة أيام تحفظ ترتيب النتائج', () => {
  const r = detectDailyAnomalies([{ day: '2026-11-25', left: { ...period, value: 2, unit: 'GB' }, right: { ...period, value: 2, unit: 'GB' } }, { day: '2026-11-26' }]);
  assert.equal(r[0].status, 'ok'); assert.equal(r[1].status, 'incomplete');
});
