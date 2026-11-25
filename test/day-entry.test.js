import test from 'node:test';
import assert from 'node:assert/strict';
import { clearLineBalanceEntry, saveLineBalanceEntry } from '../core/day-entry.js';

const day = '2026-11-25';
const base = () => ({
  op: { '2026-11': [10, 20, 30] },
  vn: { 0: 'البيت' },
  d: {
    [day]: {
      b: [90, 80, 70], o: [null, -2, null], s: 5000,
      p: 1.25, c: [2, 3, 4, 0, 1], lb: 1342177280,
      lp: false, lr: '2026-11-25', lx: 1,
    },
  },
});

test('حفظ أرصدة الخطوط يغيّر b/o فقط ويحافظ على قراءات الراوتر والمبيعات', () => {
  const state = base();
  const next = saveLineBalanceEntry(state, day, {
    balances: [89, 78, 69], adjustments: [null, -1, null],
  });
  assert.deepEqual(next.d[day], {
    b: [89, 78, 69], o: [null, -1, null], s: 5000,
    p: 1.25, c: [2, 3, 4, 0, 1], lb: 1342177280,
    lp: false, lr: '2026-11-25', lx: 1,
  });
  assert.deepEqual(state, base(), 'the original state is not mutated');
  assert.deepEqual(next.op, state.op);
  assert.deepEqual(next.vn, state.vn);
});

test('مسح أرصدة الخطوط لا يمسح بيانات الراوتر أو المبيعات لذلك اليوم', () => {
  const next = clearLineBalanceEntry(base(), day);
  assert.deepEqual(next.d[day], {
    s: 5000, p: 1.25, c: [2, 3, 4, 0, 1], lb: 1342177280,
    lp: false, lr: '2026-11-25', lx: 1,
  });
});

test('مسح اليوم يحذف السجل فقط عندما لا يبقى أي حقل آخر', () => {
  const state = { d: { [day]: { b: [1, 2, 3], o: [null, null, null] } } };
  assert.deepEqual(clearLineBalanceEntry(state, day), { d: {} });
});

test('إزالة الأرصدة بقيم فارغة تحفظ الحقول المستوردة فقط', () => {
  const next = saveLineBalanceEntry(base(), day, {
    balances: [null, null, null], adjustments: [null, null, null],
  });
  assert.equal(next.d[day].b, undefined);
  assert.equal(next.d[day].o, undefined);
  assert.equal(next.d[day].lb, 1342177280);
  assert.deepEqual(next.d[day].c, [2, 3, 4, 0, 1]);
});

test('يرفض الرصيد السلبي والقيم غير الرقمية لكنه يسمح بفارق تعبئة سالب', () => {
  const state = base();
  assert.throws(() => saveLineBalanceEntry(state, day, {
    balances: [-1, 2, 3], adjustments: [null, null, null],
  }), /negative values/);
  assert.throws(() => saveLineBalanceEntry(state, day, {
    balances: [1, NaN, 3], adjustments: [null, null, null],
  }), /finite number/);
  assert.equal(saveLineBalanceEntry(state, day, {
    balances: [1, 2, 3], adjustments: [null, -4, null],
  }).d[day].o[1], -4);
});

test('واجهة اليوم تسمح بتعديل الأرصدة فقط ولا تعرض حقول المبيعات أو بيانات الراوتر كمدخلات', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../www/adsl-app.html', import.meta.url), 'utf8');
  const openDay = html.slice(html.indexOf('function openDay('), html.indexOf('function openOp('));
  assert.match(openDay, /field\('b'\+i/);
  assert.match(openDay, /field\('o'\+i/);
  assert.doesNotMatch(openDay, /field\('s'/);
  assert.doesNotMatch(openDay, /field\('p'/);
  assert.doesNotMatch(openDay, /field\('c'\+i/);
  assert.match(openDay, /saveLineBalanceEntry/);
  assert.match(openDay, /clearLineBalanceEntry/);
});

test('لوحة المبيعات للعرض فقط وزر الإضافة يظهر في الخطوط والأيام فقط', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../www/adsl-app.html', import.meta.url), 'utf8');
  const sales = html.slice(html.indexOf('function sales()'), html.indexOf('function vlan()'));
  assert.doesNotMatch(sales, /data-a=\"(?:add|day)\"/);
  assert.match(html, /\$\('fab'\)\.hidden=tab!='lines'&&tab!='days'/);
});
