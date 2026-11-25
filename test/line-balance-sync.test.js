import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLineBalances } from '../core/line-balance-sync.js';

test('SQLite تستبدل الأرصدة اليدوية فقط وتحافظ على المبيعات وقراءات الراوتر',()=>{
  const old={op:{'2026-01':[4,5,6]},d:{'2026-01-01':{b:[1,2,3],o:[0,0,0],s:77,p:8,lb:9000,lp:true,c:[1,2,3,4,5]},'2026-01-02':{b:[7,8,9],s:12}}};
  const next=mergeLineBalances(old,[{day:'2026-01-01',balances:[10,null,30],adjustments:[null,0.5,null]},{day:'2026-01-03',balances:[2,3,4],adjustments:[null,null,null]}]);
  assert.deepEqual(next.d['2026-01-01'],{s:77,p:8,lb:9000,lp:true,c:[1,2,3,4,5],b:[10,null,30],o:[null,0.5,null]});
  assert.deepEqual(next.d['2026-01-02'],{s:12});
  assert.deepEqual(next.d['2026-01-03'],{b:[2,3,4]});
  assert.deepEqual(next.op,old.op);
  assert.deepEqual(old.d['2026-01-01'].b,[1,2,3]);
});

test('رفض بيانات SQLite غير الصالحة دون تعديل الحالة الأصلية',()=>{
  const state={d:{'2026-01-01':{b:[1,2,3],s:4}}};
  assert.throws(()=>mergeLineBalances(state,[{day:'bad',balances:[1,2,3],adjustments:[null,null,null]}]));
  assert.deepEqual(state.d['2026-01-01'].b,[1,2,3]);
});
