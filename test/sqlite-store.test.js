import test from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStore, SCHEMA_VERSION } from '../core/sqlite-store.js';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function store() { return new SQLiteStore({ filename: ':memory:' }); }

test('ترحيل الحالة القديمة يفصل الأرصدة اليدوية عن بيانات الراوتر والمبيعات', () => {
  const s = store();
  const state = { op: { '2026-08': [10, 20, 30] }, d: {
    '2026-08-01': { b: [1, 2, 3], o: [null, 0.5, -1], s: 900, p: 4.25, lb: 4567890, lp: true, lr: '2026-08-03', lx: 2, c: [1, 2, 3, 4, 5] },
    '2026-08-02': { b: [7, null, 9], s: 100 },
  } };
  const result = s.migrateLegacy({ state, lastSync: { at: '2026-08-04T00:00:00.000Z', ok: true, readOn: '2026-08-03', summary: { new: 1 } }, log: { entries: [{ id: 1, ts: '2026-08-04T00:00:00.000Z', level: 'info', code: 'OK', msg: 'تمت المزامنة' }] }, alert: { t: 15, n: 1 } });
  assert.equal(result.migrated, true);
  assert.equal(result.manualBalanceRows, 5);
  assert.equal(result.routerDays, 1);
  const db = s.db;
  assert.deepEqual(db.prepare('SELECT line_id,balance_gb FROM line_balance_readings WHERE day=? ORDER BY line_id').all('2026-08-01').map((r) => ({ ...r })), [
    { line_id: 0, balance_gb: 1 }, { line_id: 1, balance_gb: 2 }, { line_id: 2, balance_gb: 3 },
  ]);
  assert.equal(db.prepare('SELECT adjustment_gb FROM line_balance_adjustments WHERE day=? AND line_id=2').get('2026-08-01').adjustment_gb, -1);
  assert.equal(db.prepare('SELECT source_type FROM daily_sales WHERE day=?').get('2026-08-01').source_type, 'legacy_unknown');
  assert.deepEqual({ ...db.prepare('SELECT used_gb,used_bytes,legacy_lb,is_pinned,last_read_on,expired_count FROM router_card_days').get() }, {
    used_gb: 4.25, used_bytes: 4567890, legacy_lb: 4567890, is_pinned: 1, last_read_on: '2026-08-03', expired_count: 2,
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM router_card_counts').get().n, 5);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM month_opening_balances').get().n, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM router_sync_runs').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operation_logs').get().n, 1);
  assert.equal(db.prepare("SELECT value_json FROM app_settings WHERE key='alert'").get().value_json, '{"t":15,"n":1}');
  s.close();
});

test('الترحيل مرة واحدة فقط ولا يكرر الصفوف', () => {
  const s = store(); const payload = { state: { d: { '2026-01-01': { b: [1, 2, 3] } } } };
  assert.equal(s.migrateLegacy(payload).alreadyMigrated, false);
  assert.equal(s.migrateLegacy({ state: { d: {} } }).alreadyMigrated, true);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM line_balance_readings').get().n, 3);
  s.close();
});

test('فشل التحقق لا يترك ترحيلاً جزئياً ويمكن إعادة المحاولة', () => {
  const s = store();
  assert.throws(() => s.migrateLegacy({ state: { d: { invalid: { b: [1, 2, 3] } } } }), /تاريخ غير صالح/);
  assert.equal(s.status().migrated, false);
  assert.equal(s.status().manualBalanceRows, 0);
  assert.equal(s.migrateLegacy({ state: { d: { '2026-01-01': { b: [1, 2, 3] } } } }).migrated, true);
  s.close();
});

test('يحفظ أسماء VLAN المخصصة ضمن إعدادات SQLite أثناء الترحيل', () => {
  const s = store();
  s.migrateLegacy({ state: { d: {}, op: {}, vn: { 0: 'اسم مخصص', 2: 'اسم آخر' } } });
  assert.equal(s.db.prepare("SELECT value_json FROM app_settings WHERE key='vlan_names'").get().value_json, '{"0":"اسم مخصص","2":"اسم آخر"}');
  s.close();
});

test('حفظ ومسح أرصدة الخطوط في SQLite لا يغيّر بيانات الراوتر أو المبيعات', () => {
  const s=store();
  s.migrateLegacy({state:{d:{'2026-08-01':{b:[1,2,3],o:[0,null,-1],s:50,p:4,lb:4000,lp:true,c:[1,2,3,4,5]}}}});
  const saved=s.saveLineBalances('2026-08-01',{balances:[8,9,10],adjustments:[null,0.25,-0.5]});
  assert.deepEqual(saved,{day:'2026-08-01',balances:[8,9,10],adjustments:[null,0.25,-0.5]});
  assert.equal(s.db.prepare('SELECT amount FROM daily_sales WHERE day=?').get('2026-08-01').amount,50);
  assert.equal(s.db.prepare('SELECT used_gb FROM router_card_days WHERE day=?').get('2026-08-01').used_gb,4);
  s.clearLineBalances('2026-08-01');
  assert.deepEqual(s.getLineBalances('2026-08-01'),{day:'2026-08-01',balances:[null,null,null],adjustments:[null,null,null]});
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM daily_sales').get().n,1);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM router_card_days').get().n,1);
  s.close();
});

test('قراءة جميع أرصدة الخطوط تعيد الأيام الموجودة في SQLite فقط', () => {
  const s=store();
  s.migrateLegacy({state:{d:{'2026-01-01':{b:[1,null,3],o:[null,0,null]},'2026-01-02':{s:9}}}});
  s.saveLineBalances('2026-01-03',{balances:[null,5,null],adjustments:[null,null,-1]});
  assert.deepEqual(s.getAllLineBalances(),[
    {day:'2026-01-01',balances:[1,null,3],adjustments:[null,0,null]},
    {day:'2026-01-03',balances:[null,5,null],adjustments:[null,null,-1]},
  ]);
  s.close();
});


test('مزامنة User Manager تحفظ الاستهلاك وأعداد الفئات والتثبيت وآخر قراءة في SQLite', () => {
  const s = store();
  const attemptedAt = '2026-11-25T02:00:00.000Z';
  const result = s.applyRouterSync({
    attemptedAt,
    status: 'ok',
    readOn: '2026-11-25',
    dateSource: 'router',
    summary: { total: 2, new: 1, updated: 0, pinned: 1, hidden: 0, unchanged: 0, alreadyPinned: 0, manual: 0 },
    days: [{ day: '2026-11-24', entry: { p: 0.5, lb: 536870912, c: [1, 2, 3, 4, 5], lp: true, lr: '2026-11-25', lx: 2 } }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.savedDays, 1);
  assert.deepEqual(s.getRouterCardDay('2026-11-24'), {
    day: '2026-11-24',
    entry: { p: 0.5, lb: 536870912, c: [1, 2, 3, 4, 5], lp: true, lr: '2026-11-25', lx: 2 },
    syncedAt: attemptedAt,
  });
  assert.deepEqual(s.getLastRouterSync(), {
    id: result.syncRunId,
    attemptedAt,
    status: 'ok',
    readOn: '2026-11-25',
    dateSource: 'router',
    summary: { total: 2, new: 1, updated: 0, pinned: 1, hidden: 0, unchanged: 0, alreadyPinned: 0, manual: 0 },
    errorCode: null,
  });
  assert.equal(s.status().routerDays, 1);
  s.close();
});

test('تحديث User Manager لا يغيّر الأرصدة اليدوية أو المبيعات ويحافظ على قيمة lb القديمة المنقولة', () => {
  const s = store();
  s.migrateLegacy({ state: { d: { '2026-11-24': { b: [10, 20, 30], o: [0.5, null, -1], s: 777, p: 0.25, lb: 268435456, lp: false, lr: '2026-11-24', lx: 0, c: [1, 1, 0, 0, 0] } } } });
  const before = {
    balances: s.getLineBalances('2026-11-24'),
    sales: s.db.prepare('SELECT amount,source_type FROM daily_sales WHERE day=?').get('2026-11-24'),
    legacyLb: s.db.prepare('SELECT legacy_lb FROM router_card_days WHERE day=?').get('2026-11-24').legacy_lb,
  };
  s.applyRouterSync({
    attemptedAt: '2026-11-25T03:00:00.000Z', status: 'ok', readOn: '2026-11-25', dateSource: 'device',
    summary: { total: 1, new: 0, updated: 1, pinned: 0, hidden: 0, unchanged: 0, alreadyPinned: 0, manual: 0 },
    days: [{ day: '2026-11-24', entry: { p: 0.75, lb: 805306368, c: [2, 1, 0, 0, 0], lp: false, lr: '2026-11-25', lx: 1 } }],
  });
  assert.deepEqual(s.getLineBalances('2026-11-24'), before.balances);
  assert.deepEqual(s.db.prepare('SELECT amount,source_type FROM daily_sales WHERE day=?').get('2026-11-24'), before.sales);
  assert.equal(s.db.prepare('SELECT legacy_lb FROM router_card_days WHERE day=?').get('2026-11-24').legacy_lb, before.legacyLb);
  assert.deepEqual(s.getRouterCardDay('2026-11-24').entry, { p: 0.75, lb: 805306368, c: [2, 1, 0, 0, 0], lp: false, lr: '2026-11-25', lx: 1 });
  s.close();
});

test('فشل محاولة المزامنة يسجل رمز الخطأ فقط ولا يغيّر أي يوم محفوظ', () => {
  const s = store();
  const day = { day: '2026-11-24', entry: { p: 0.5, lb: 536870912, c: [1, 2, 3, 4, 5], lp: false, lr: '2026-11-25', lx: 0 } };
  s.applyRouterSync({ attemptedAt: '2026-11-25T02:00:00.000Z', status: 'ok', readOn: '2026-11-25', dateSource: 'router', summary: { total: 1 }, days: [day] });
  const before = s.getRouterCardDay(day.day);
  s.applyRouterSync({ attemptedAt: '2026-11-25T02:05:00.000Z', status: 'error', errorCode: 'TIMEOUT', days: [] });
  assert.deepEqual(s.getRouterCardDay(day.day), before);
  assert.equal(s.getLastRouterSync().status, 'error');
  assert.equal(s.getLastRouterSync().errorCode, 'TIMEOUT');
  assert.equal(s.getLastRouterSync().summary, null);
  s.close();
});

test('مزامنة الراوتر ذرّية: فشل إدخال عدد كرت يتراجع عن اليوم والسجل معاً', () => {
  const s = store();
  s.db.exec("CREATE TRIGGER reject_router_count BEFORE INSERT ON router_card_counts WHEN NEW.face=250 BEGIN SELECT RAISE(ABORT,'forced test failure'); END;");
  assert.throws(() => s.applyRouterSync({
    attemptedAt: '2026-11-25T04:00:00.000Z', status: 'ok', readOn: '2026-11-25', dateSource: 'router', summary: { total: 1 },
    days: [{ day: '2026-11-24', entry: { p: 0.5, lb: 536870912, c: [1, 2, 3, 4, 5], lp: false, lr: '2026-11-25', lx: 0 } }],
  }), /forced test failure/);
  assert.equal(s.getRouterCardDay('2026-11-24'), null);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM router_sync_runs').get().n, 0);
  s.close();
});

test('رفض القيم غير الصالحة أو الأيام المكررة قبل اعتماد أي قراءة', () => {
  const s = store();
  const base = { attemptedAt: '2026-11-25T04:00:00.000Z', status: 'ok', readOn: '2026-11-25', dateSource: 'router', summary: { total: 1 } };
  const valid = { day: '2026-11-24', entry: { p: 0.5, lb: 536870912, c: [1, 2, 3, 4, 5], lp: false, lr: '2026-11-25', lx: 0 } };
  assert.throws(() => s.applyRouterSync({ ...base, days: [valid, valid] }), /مكرر/);
  assert.throws(() => s.applyRouterSync({ ...base, days: [{ ...valid, entry: { ...valid.entry, lb: -1 } }] }), /البايتات/);
  assert.throws(() => s.applyRouterSync({ ...base, days: [{ ...valid, entry: { ...valid.entry, c: [1, 2, -1, 4, 5] } }] }), /أعداد فئات الكروت/);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM router_card_days').get().n, 0);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM router_sync_runs').get().n, 0);
  s.close();
});

test('ترقية أرشيف المبيعات من المخطط 3 تحفظ السجلات القديمة وتعلّم اكتمالها كمجهول تحفظياً', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'adsl-sqlite-v3-'));
  const filename=path.join(dir,'legacy-v3.sqlite');
  const old=new DatabaseSync(filename);
  old.exec(`CREATE TABLE sales_records (
    sale_key TEXT PRIMARY KEY,router_key TEXT NOT NULL,username TEXT NOT NULL,profile_name TEXT,
    price REAL,sale_day TEXT NOT NULL,started_at TEXT NOT NULL,nas_port_id TEXT,first_session_id TEXT,
    session_count INTEGER NOT NULL,download_bytes INTEGER NOT NULL,upload_bytes INTEGER NOT NULL,uptime_seconds INTEGER NOT NULL,
    first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL
  );
  INSERT INTO sales_records VALUES('old','router','voucher',NULL,NULL,'2026-11-20','2026-11-20 10:00:00',NULL,NULL,1,0,0,0,'2026-11-20T00:00:00.000Z','2026-11-20T00:00:00.000Z');`);
  old.close();
  const s=new SQLiteStore({filename});
  const row=s.getSalesData().records[0];
  assert.equal(row.saleKey,'old');
  assert.equal(row.trafficComplete,0);
  assert.equal(row.durationComplete,0);
  assert.equal(s.diagnostics().counts.incompleteTrafficSales,1);
  s.close();fs.rmSync(dir,{recursive:true,force:true});
});

test('ترقية قاعدة قديمة من المخطط 1 إلى المخطط 3 تحفظ الصفوف السابقة', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adsl-sqlite-v1-'));
  const filename = path.join(dir, 'legacy.sqlite');
  const old = new DatabaseSync(filename);
  old.exec(`
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO app_meta(key,value) VALUES('schema_version','1'),('legacy_migration_v1','2026-11-20T00:00:00.000Z');
    CREATE TABLE router_card_days (day TEXT PRIMARY KEY, used_gb REAL, used_bytes INTEGER, legacy_lb REAL, is_pinned INTEGER, last_read_on TEXT, expired_count INTEGER, imported_at TEXT NOT NULL);
    INSERT INTO router_card_days(day,used_gb,used_bytes,legacy_lb,is_pinned,last_read_on,expired_count,imported_at)
    VALUES('2026-11-24',0.5,536870912,536870912,1,'2026-11-25',2,'2026-11-20T00:00:00.000Z');
  `);
  old.close();
  const s = new SQLiteStore({ filename });
  assert.equal(SCHEMA_VERSION, 5);
  assert.equal(s.status().schemaVersion, 5);
  assert.deepEqual(s.getRouterCardDay('2026-11-24'), {
    day: '2026-11-24',
    entry: { p: 0.5, lb: 536870912, c: [null, null, null, null, null], lp: true, lr: '2026-11-25', lx: 2 },
    syncedAt: null,
  });
  assert.ok(s.db.prepare('PRAGMA table_info(router_card_days)').all().some((row) => row.name === 'synced_at'));
  s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('استعادة نسخة الراوتر تدمج دون الكتابة فوق الأيام وتحافظ على المبيعات والخطوط، والاستبدال يقتصر على جداول الراوتر', () => {
  const s=store();
  s.migrateLegacy({state:{d:{'2026-11-20':{b:[1,2,3],s:900,p:1,lb:100,c:[1,0,0,0,0],lp:false,lr:'2026-11-21',lx:0}}}});
  const incoming=[
    {day:'2026-11-20',entry:{p:99,lb:999,c:[9,9,9,9,9],lp:true,lr:'2026-11-25',lx:0}},
    {day:'2026-11-21',entry:{p:2,lb:200,c:[2,null,0,0,0],lp:false,lr:'2026-11-25',lx:1}},
  ];
  let out=s.restoreRouterData({days:incoming,mode:'merge'});
  assert.equal(out.added,1);assert.equal(out.skipped,1);assert.equal(s.getRouterCardDay('2026-11-21').entry.c[1],null);
  assert.equal(s.getRouterCardDay('2026-11-20').entry.p,1);
  assert.equal(s.db.prepare('SELECT amount FROM daily_sales WHERE day=?').get('2026-11-20').amount,900);
  assert.deepEqual(s.getLineBalances('2026-11-20').balances,[1,2,3]);
  out=s.restoreRouterData({days:incoming,mode:'replace',lastSync:{attemptedAt:'2026-11-25T05:00:00.000Z',status:'ok',readOn:'2026-11-25',dateSource:'router',summary:{total:2,new:2,updated:0,pinned:0,hidden:0,unchanged:0,alreadyPinned:0,manual:0}}});
  assert.equal(out.added,2);assert.equal(s.getRouterCardDay('2026-11-20').entry.p,99);
  assert.equal(s.db.prepare('SELECT amount FROM daily_sales WHERE day=?').get('2026-11-20').amount,900);
  assert.deepEqual(s.getLineBalances('2026-11-20').balances,[1,2,3]);
  assert.equal(s.getLastRouterSync().readOn,'2026-11-25');
  s.close();
});


test('أرصدة بداية الشهر: حفظ وقراءة وتحديث ومسح آمن في SQLite', () => {
  const s=store();
  assert.deepEqual(s.saveMonthOpeningBalances('2026-11',[12.5,null,0]),{month:'2026-11',balances:[12.5,null,0]});
  assert.deepEqual(s.getMonthOpeningBalances('2026-11'),{month:'2026-11',balances:[12.5,null,0]});
  assert.deepEqual(s.getAllMonthOpeningBalances(),[{month:'2026-11',balances:[12.5,null,0]}]);
  assert.throws(()=>s.saveMonthOpeningBalances('2026-11',[-1,4,5]),/غير صالحة/);
  assert.deepEqual(s.getMonthOpeningBalances('2026-11'),{month:'2026-11',balances:[12.5,null,0]});
  s.saveMonthOpeningBalances('2026-11',[null,null,null]);
  assert.deepEqual(s.getAllMonthOpeningBalances(),[]);
  assert.throws(()=>s.saveMonthOpeningBalances('2026-13',[1,2,3]),/الشهر غير صالح/);
  s.close();
});

test('SQLite ترفض تواريخ الأيام المستحيلة والأرصدة السالبة دون كتابة جزئية', () => {
  const s=store();
  assert.throws(()=>s.migrateLegacy({state:{d:{'2026-02-31':{b:[1,2,3]}}}}),/تاريخ غير صالح/);
  assert.throws(()=>s.saveLineBalances('2026-02-31',{balances:[1,2,3],adjustments:[0,0,0]}),/تاريخ غير صالح/);
  assert.throws(()=>s.saveLineBalances('2026-02-28',{balances:[1,-2,3],adjustments:[0,0,0]}),/قيمة رصيد غير صالحة/);
  assert.deepEqual(s.getLineBalances('2026-02-28'),{day:'2026-02-28',balances:[null,null,null],adjustments:[null,null,null]});
  assert.throws(()=>s.clearLineBalances('2026-02-31'),/تاريخ غير صالح/);
  assert.throws(()=>s.getLineBalances('2026-02-31'),/تاريخ غير صالح/);
  s.close();
});

test('أرشيف المبيعات يحفظ اكتمال الحركة والمدة ولا يخلط الصفر الحقيقي بالقراءة الناقصة', () => {
  const s=store();
  const base={saleDay:'2026-11-25',startedAt:'2026-11-25 09:10:00',sessionCount:1,downloadBytes:0,uploadBytes:0,uptimeSeconds:0};
  s.applySalesSync({routerKey:'router',capturedAt:'2026-11-25T06:00:00.000Z',records:[
    {...base,saleKey:'complete',username:'complete',trafficComplete:true,durationComplete:true},
    {...base,saleKey:'incomplete',username:'incomplete',trafficComplete:false,durationComplete:false},
  ]});
  const data=s.getSalesData();
  assert.equal(data.summary.incompleteTraffic,1);
  assert.equal(data.summary.incompleteDuration,1);
  assert.equal(data.records.find(x=>x.username==='complete').trafficComplete,1);
  assert.equal(data.records.find(x=>x.username==='incomplete').trafficComplete,0);
  const diagnostics=s.diagnostics();
  assert.ok(diagnostics.alerts.some(x=>x.code==='SALES_TRAFFIC_INCOMPLETE'));
  s.applySalesSync({routerKey:'router',capturedAt:'2026-11-25T07:00:00.000Z',records:[{...base,saleKey:'incomplete',username:'incomplete',trafficComplete:true,durationComplete:true,downloadBytes:10}]});
  const refreshed=s.getSalesData().records.find(x=>x.username==='incomplete');
  assert.equal(refreshed.trafficComplete,1,'إعادة المزامنة تحدّث أعلام الاكتمال أيضاً');
  s.close();
});

test('أرشيف مبيعات User Manager: حفظ أسعار الباقات، منع التكرار، وتحديث السجلات السابقة', () => {
  const s=store();
  const capturedAt='2026-11-25T06:00:00.000Z';
  const record={saleKey:'router::voucher-1::*1',username:'voucher-1',profile:'100RY',saleDay:'2026-11-25',startedAt:'2026-11-25 09:10:00',nasPortId:'ether2',firstSessionId:'*1',sessionCount:2,downloadBytes:1000,uploadBytes:200,uptimeSeconds:3600};
  const first=s.applySalesSync({routerKey:'192.168.88.1|Falcon',records:[record],profiles:['100RY'],capturedAt});
  assert.deepEqual(first.summary,{vouchers:1,sessions:2,inserted:1,updated:0,unchanged:0,unpriced:1,priced:0,warningCount:0});
  assert.equal(s.getSalesData({from:'2026-11-25',to:'2026-11-25'}).summary.unpriced,1);
  s.saveSalesPrices({items:[{profile:'100RY',price:100}]});
  let data=s.getSalesData({from:'2026-11-25',to:'2026-11-25'});
  assert.equal(data.summary.revenue,100);assert.equal(data.summary.unpriced,0);assert.equal(data.records[0].price,100);
  const repeat=s.applySalesSync({routerKey:'192.168.88.1|Falcon',records:[{...record,downloadBytes:1500}],profiles:['100RY'],capturedAt:'2026-11-25T07:00:00.000Z'});
  assert.equal(repeat.summary.inserted,0);assert.equal(repeat.summary.updated,1);assert.equal(repeat.summary.unchanged,0);
  const stable=s.applySalesSync({routerKey:'192.168.88.1|Falcon',records:[{...record,downloadBytes:1500}],profiles:['100RY'],capturedAt:'2026-11-25T08:00:00.000Z'});
  assert.equal(stable.summary.unchanged,1);assert.equal(stable.summary.updated,0);
  data=s.getSalesData({from:'2026-11-25',to:'2026-11-25'});
  assert.equal(data.summary.vouchers,1);assert.equal(data.summary.downloadBytes,1500);assert.equal(data.summary.revenue,100);
  assert.equal(s.getSalesSyncRuns({limit:10}).length,3);
  s.close();
});

test('أرشيف المبيعات: رفض السجل غير السليم ذرياً وتصفير التشغيل يحتفظ بتسعير الباقات', () => {
  const s=store();
  s.saveSalesPrices({items:[{profile:'200RY',price:200}]});
  const bad={saleKey:'x',username:'u',profile:'200RY',saleDay:'2026-02-30',startedAt:'2026-02-30 10:00:00',sessionCount:1,downloadBytes:0,uploadBytes:0,uptimeSeconds:0};
  assert.throws(()=>s.applySalesSync({routerKey:'r',records:[bad],capturedAt:'2026-11-25T06:00:00.000Z'}));
  assert.equal(s.status().salesRows,0);
  s.applySalesSync({routerKey:'r',records:[{...bad,saleDay:'2026-11-25',startedAt:'2026-11-25 10:00:00'}],profiles:['200RY'],capturedAt:'2026-11-25T06:00:00.000Z'});
  s.resetOperationalData();
  assert.equal(s.status().salesRows,0);
  assert.equal(s.getSalesPrices().find(x=>x.profile==='200RY').price,200);
  s.close();
});

test('استيراد Excel بعد الترحيل يملأ الفراغات فقط ولا يكتب فوق القيم الموجودة', () => {
  const s=store();
  s.migrateLegacy({state:{d:{'2026-11-01':{b:[10,null,null],s:500}},op:{'2026-11':[1,null,null]}}});
  const result=s.mergeImportedState({d:{
    '2026-11-01':{b:[99,20,30],o:[null,2,null],s:900},
    '2026-11-02':{b:[5,6,7],s:100,p:2.5,lb:268435456,lp:true,lr:'2026-11-03',lx:1,c:[1,2,3,4,5]},
  },op:{'2026-11':[99,2,3]}});
  assert.deepEqual(result,{daysAdded:2,balancesAdded:5,adjustmentsAdded:1,salesAdded:1,routerDaysAdded:1,cardCountsAdded:5,openingsAdded:2});
  assert.deepEqual(s.getLineBalances('2026-11-01'),{day:'2026-11-01',balances:[10,20,30],adjustments:[null,2,null]});
  assert.equal(s.db.prepare('SELECT amount FROM daily_sales WHERE day=?').get('2026-11-01').amount,500);
  assert.equal(s.db.prepare('SELECT amount FROM daily_sales WHERE day=?').get('2026-11-02').amount,100);
  assert.equal(s.db.prepare('SELECT used_gb FROM router_card_days WHERE day=?').get('2026-11-02').used_gb,2.5);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM router_card_counts WHERE day=?').get('2026-11-02').n,5);
  assert.deepEqual(s.getMonthOpeningBalances('2026-11').balances,[1,2,3]);
  assert.equal(s.mergeImportedState({d:{'2026-11-02':{b:[5,6,7],s:100}},op:{}}).daysAdded,0);
  s.close();
});


test('قراءات عدادات الواجهات تحفظ تاريخاً وفروقاً صحيحة وتتعامل مع التكرار', () => {
  const s = store();
  const first = s.saveInterfaceReading({ ts: 1000000, uptimeSec: 100, ifaces: [
    { name: 'vlan1', rx: 1000, tx: 2000, kind: 'vlan', vlanId: 1, parent: 'ether1', running: true },
  ] });
  assert.equal(first.ok, true);
  assert.equal(first.reading.period.results.vlan1.status, 'first');
  const second = s.saveInterfaceReading({ ts: 2000000, uptimeSec: 1100, ifaces: [
    { name: 'vlan1', rx: 5000, tx: 7000, kind: 'vlan', vlanId: 1, parent: 'ether1', running: true },
  ] });
  assert.equal(second.reading.period.results.vlan1.total, 9000);
  assert.equal(second.reading.reading.ifaces.vlan1.vlanId, 1);
  assert.equal(s.saveInterfaceReading({ ts: 2000000, uptimeSec: 1100, ifaces: [{ name: 'vlan1', rx: 5000, tx: 7000, kind: 'vlan', vlanId: 1 }] }).duplicate, true);
  const all = s.getInterfaceReadings({ limit: 10 });
  assert.equal(all.total, 2);
  assert.equal(all.readings.length, 2);
  assert.equal(all.readings[1].period.results.vlan1.total, 9000);
  s.close();
});

test('قراءة عدادات غير صالحة لا تحفظ أي سجل، والقراءة الأقدم لا تقبل', () => {
  const s = store();
  assert.throws(() => s.saveInterfaceReading({ ts: 1, uptimeSec: 1, ifaces: [] }), /لا توجد واجهات/);
  s.saveInterfaceReading({ ts: 100, uptimeSec: 10, ifaces: [{ name: 'vlan1', rx: 1, tx: 1, vlanId: 1 }] });
  assert.throws(() => s.saveInterfaceReading({ ts: 99, uptimeSec: 9, ifaces: [{ name: 'vlan1', rx: 2, tx: 2, vlanId: 1 }] }), /أقدم/);
  assert.equal(s.getInterfaceReadings().total, 1);
  s.close();
});
