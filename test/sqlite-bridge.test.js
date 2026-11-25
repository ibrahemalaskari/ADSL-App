import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createBridge } from '../bridge/server.js';

test('واجهتا حالة SQLite وترحيل localStorage عبر الجسر المحلي', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adsl-db-'));
  const bridge = createBridge({ port: 0, databasePath: path.join(dir, 'app.sqlite') });
  const port = await bridge.start(); const base = `http://127.0.0.1:${port}`;
  t.after(async () => { await bridge.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  let r = await fetch(`${base}/db/status`); assert.equal(r.status, 200);
  assert.equal((await r.json()).migrated, false);
  r = await fetch(`${base}/db/migrate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: { d: { '2026-02-01': { b: [3, 2, 1], p: 2, lb: 1000, c: [1, 0, 0, 0, 0] } } } }) });
  assert.equal(r.status, 200); const migrated = await r.json();
  assert.equal(migrated.migrated, true); assert.equal(migrated.manualBalanceRows, 3); assert.equal(migrated.routerDays, 1);
  r = await fetch(`${base}/db/migrate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: { d: {} } }) });
  assert.equal((await r.json()).alreadyMigrated, true);
});

test('واجهات أرصدة الخطوط تحفظ وتقرأ وتمسح الحقول اليدوية فقط', async (t) => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'adsl-line-db-'));
  const bridge=createBridge({port:0,databasePath:path.join(dir,'app.sqlite')});
  const port=await bridge.start(),base=`http://127.0.0.1:${port}`;
  t.after(async()=>{await bridge.stop();fs.rmSync(dir,{recursive:true,force:true})});
  await fetch(`${base}/db/migrate`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state:{d:{'2026-03-01':{s:7,p:2,lb:2000,c:[1,0,0,0,0]}}}})});
  let r=await fetch(`${base}/db/line-balances`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({day:'2026-03-01',balances:[1,2,3],adjustments:[0,null,-1]})});
  assert.equal(r.status,200);assert.deepEqual(await r.json(),{day:'2026-03-01',balances:[1,2,3],adjustments:[0,null,-1]});
  r=await fetch(`${base}/db/line-balances?day=2026-03-01`);assert.deepEqual(await r.json(),{day:'2026-03-01',balances:[1,2,3],adjustments:[0,null,-1]});
  r=await fetch(`${base}/db/line-balances`);assert.deepEqual(await r.json(),{days:[{day:'2026-03-01',balances:[1,2,3],adjustments:[0,null,-1]}]});
  r=await fetch(`${base}/db/line-balances`,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({day:'2026-03-01'})});assert.equal(r.status,200);
  r=await fetch(`${base}/db/status`);const status=await r.json();assert.equal(status.manualBalanceRows,0);assert.equal(status.routerDays,1);
});

test('واجهات مزامنة الراوتر ونسخه الاحتياطي تحفظ وتستعيد قراءات SQLite', async (t) => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'adsl-router-api-'));
  const bridge=createBridge({port:0,databasePath:path.join(dir,'app.sqlite')});
  const port=await bridge.start(),base=`http://127.0.0.1:${port}`;
  t.after(async()=>{await bridge.stop();fs.rmSync(dir,{recursive:true,force:true})});
  await fetch(`${base}/db/migrate`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state:{d:{'2026-11-24':{s:120,b:[3,4,5]}}}})});
  const day={day:'2026-11-24',entry:{p:0.5,lb:536870912,c:[1,2,3,4,5],lp:false,lr:'2026-11-25',lx:2}};
  let r=await fetch(`${base}/db/router-sync`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({days:[day],attemptedAt:'2026-11-25T04:00:00.000Z',status:'ok',readOn:'2026-11-25',dateSource:'router',summary:{total:1,new:1,updated:0,pinned:0,hidden:0,unchanged:0,alreadyPinned:0,manual:0}})});
  assert.equal(r.status,200);assert.equal((await r.json()).savedDays,1);
  r=await fetch(`${base}/db/router-days`);let data=await r.json();assert.equal(data.days.length,1);assert.equal(data.lastSync.status,'ok');
  r=await fetch(`${base}/db/router-restore`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({days:[{...day,day:'2026-11-23'}],mode:'merge'})});assert.equal(r.status,200);assert.equal((await r.json()).added,1);
  r=await fetch(`${base}/db/router-days`);data=await r.json();assert.equal(data.days.length,2);
  r=await fetch(`${base}/db/status`);const st=await r.json();assert.equal(st.manualBalanceRows,3);
});


test('واجهات أرصدة بداية الشهر تحفظها وتعيدها بعد طلب مستقل', async (t) => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'adsl-month-db-'));
  const bridge=createBridge({port:0,databasePath:path.join(dir,'app.sqlite')});
  const port=await bridge.start(),base=`http://127.0.0.1:${port}`;
  t.after(async()=>{await bridge.stop();fs.rmSync(dir,{recursive:true,force:true})});
  await fetch(`${base}/db/migrate`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state:{d:{}}})});
  let r=await fetch(`${base}/db/month-openings`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({month:'2026-11',balances:[30.5,null,12]})});
  assert.equal(r.status,200);
  assert.deepEqual(await r.json(),{month:'2026-11',balances:[30.5,null,12]});
  r=await fetch(`${base}/db/month-openings?month=2026-11`);
  assert.equal(r.status,200);
  assert.deepEqual(await r.json(),{month:'2026-11',balances:[30.5,null,12]});
  r=await fetch(`${base}/db/month-openings`);
  assert.deepEqual(await r.json(),{months:[{month:'2026-11',balances:[30.5,null,12]}]});
  r=await fetch(`${base}/db/month-openings`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({month:'2026-11',balances:[null,null,null]})});
  assert.equal(r.status,200);
  r=await fetch(`${base}/db/month-openings`);
  assert.deepEqual(await r.json(),{months:[]});
  r=await fetch(`${base}/db/month-openings`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({month:'2026-13',balances:[1,2,3]})});
  assert.equal(r.status,400);
});

test('واجهات أرشيف مبيعات User Manager: تسعير الباقات ومزامنة السجلات وملخص الشهر', async (t) => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'adsl-sales-api-'));
  const bridge=createBridge({port:0,databasePath:path.join(dir,'app.sqlite')});
  const port=await bridge.start(),base=`http://127.0.0.1:${port}`;
  t.after(async()=>{await bridge.stop();fs.rmSync(dir,{recursive:true,force:true})});
  await fetch(`${base}/db/migrate`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state:{d:{}}})});
  let r=await fetch(`${base}/db/sales-prices`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({items:[{profile:'100RY',price:100}]})});
  assert.equal(r.status,200);
  const record={saleKey:'router::u1::*1',username:'u1',profile:'100RY',saleDay:'2026-11-25',startedAt:'2026-11-25 10:00:00',nasPortId:'ether2',firstSessionId:'*1',sessionCount:1,downloadBytes:1000,uploadBytes:500,uptimeSeconds:60};
  r=await fetch(`${base}/db/sales-sync`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({routerKey:'192.168.88.1|Falcon',records:[record],profiles:['100RY'],capturedAt:'2026-11-25T06:00:00.000Z',warnings:[]})});
  assert.equal(r.status,200);assert.equal((await r.json()).summary.inserted,1);
  r=await fetch(`${base}/db/sales?from=2026-11-01&to=2026-11-30`);const data=await r.json();
  assert.equal(r.status,200);assert.equal(data.summary.vouchers,1);assert.equal(data.summary.revenue,100);assert.equal(data.records[0].username,'u1');
  r=await fetch(`${base}/db/sales?from=2026-11-30&to=2026-11-01`);assert.equal(r.status,400);
});


test('تشخيص قاعدة البيانات يعرض سلامة القاعدة، العدادات، والتنبيهات دون تعديل البيانات', async (t) => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'adsl-diagnostics-'));
  const bridge=createBridge({port:0,databasePath:path.join(dir,'app.sqlite')});
  const port=await bridge.start(),base=`http://127.0.0.1:${port}`;
  t.after(async()=>{await bridge.stop();fs.rmSync(dir,{recursive:true,force:true})});
  let r=await fetch(`${base}/db/diagnostics`); assert.equal(r.status,200);
  const before=await r.json(); assert.equal(before.ok,true); assert.deepEqual(before.integrity,['ok']);
  assert.equal(before.counts.salesRecords,0); assert.ok(before.alerts.some(a=>a.code==='SALES_SYNC_NOT_RUN'));
  r=await fetch(`${base}/db/status`); const status=await r.json(); assert.equal(status.salesRows,0);
});

test('تشخيص موسع يكشف سجلات مبيعات تحتاج مراجعة وتعدد السجلات لليوم دون اعتبارها أخطاء مؤكدة', async (t) => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'adsl-diag-sales-'));
  const bridge=createBridge({port:0,databasePath:path.join(dir,'app.sqlite')});
  const port=await bridge.start(),base=`http://127.0.0.1:${port}`;
  t.after(async()=>{await bridge.stop();fs.rmSync(dir,{recursive:true,force:true})});
  const rec=(key,day,time)=>({saleKey:key,username:'u',profile:'missing-price',saleDay:day,startedAt:`${day} ${time}`,nasPortId:null,firstSessionId:key,sessionCount:1,downloadBytes:0,uploadBytes:0,uptimeSeconds:0});
  let r=await fetch(`${base}/db/sales-sync`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({routerKey:'r',records:[rec('k1','2026-11-25','10:00:00'),rec('k2','2026-11-25','11:00:00')],profiles:['missing-price'],capturedAt:'2026-11-25T12:00:00.000Z',warnings:['sample warning']})});
  assert.equal(r.status,200);
  r=await fetch(`${base}/db/diagnostics`);const d=await r.json();
  assert.equal(d.counts.zeroTrafficSales,2);assert.equal(d.counts.zeroDurationSales,2);assert.equal(d.anomalies.length,2);
  assert.equal(d.duplicateUserDays.length,1);assert.ok(d.alerts.some(a=>a.code==='SALES_ZERO_TRAFFIC'));assert.ok(d.alerts.some(a=>a.code==='SALES_MULTI_RECORD_USER_DAY'));
});

test('واجهة دمج Excel في SQLite تحفظ البيانات المستوردة دون الكتابة فوق القيم الحالية', async (t) => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'adsl-excel-import-'));
  const bridge=createBridge({port:0,databasePath:path.join(dir,'app.sqlite')});
  const port=await bridge.start(),base=`http://127.0.0.1:${port}`;
  t.after(async()=>{await bridge.stop();fs.rmSync(dir,{recursive:true,force:true})});
  let r=await fetch(`${base}/db/migrate`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state:{d:{'2026-11-01':{b:[8,null,null],s:800}},op:{}}})});
  assert.equal(r.status,200);
  r=await fetch(`${base}/db/import-state`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state:{d:{'2026-11-01':{b:[99,2,3],s:999},'2026-11-02':{b:[1,2,3],s:100}},op:{'2026-11':[5,6,7]}}})});
  assert.equal(r.status,200);const merged=await r.json();assert.deepEqual(merged,{daysAdded:2,balancesAdded:5,adjustmentsAdded:0,salesAdded:1,routerDaysAdded:0,cardCountsAdded:0,openingsAdded:3});
  r=await fetch(`${base}/db/line-balances?day=2026-11-01`);assert.deepEqual((await r.json()).balances,[8,2,3]);
  r=await fetch(`${base}/db/month-openings?month=2026-11`);assert.deepEqual((await r.json()).balances,[5,6,7]);
  r=await fetch(`${base}/db/import-state`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state:{d:{'2026-02-30':{b:[1,2,3]}},op:{}}})});
  assert.equal(r.status,400);
  r=await fetch(`${base}/db/line-balances?day=2026-11-01`);assert.deepEqual((await r.json()).balances,[8,2,3]);
});


test('واجهة قراءات VLAN عبر الجسر تحفظ وتعرض وتستعيد تاريخ العدادات', async (t) => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'adsl-iface-db-'));
  const bridge=createBridge({port:0,databasePath:path.join(dir,'app.sqlite')});
  const port=await bridge.start(),base=`http://127.0.0.1:${port}`;
  t.after(async()=>{await bridge.stop();fs.rmSync(dir,{recursive:true,force:true})});
  const reading=(ts,rx,tx)=>({ts,uptimeSec:ts/1000,ifaces:{vlan1:{rx,tx,kind:'vlan',vlanId:1,parent:'ether1',running:true}}});
  let r=await fetch(`${base}/db/interface-readings`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(reading(1000000,1000,2000))});
  assert.equal(r.status,200);assert.equal((await r.json()).reading.period.results.vlan1.status,'first');
  r=await fetch(`${base}/db/interface-readings`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(reading(2000000,5000,7000))});
  assert.equal(r.status,200);assert.equal((await r.json()).reading.period.results.vlan1.total,9000);
  r=await fetch(`${base}/db/interface-readings?limit=20`);let data=await r.json();assert.equal(data.total,2);assert.equal(data.readings[1].reading.ifaces.vlan1.vlanId,1);
  const target=createBridge({port:0,databasePath:path.join(dir,'restored.sqlite')});const targetPort=await target.start();
  t.after(async()=>{await target.stop()});
  r=await fetch(`http://127.0.0.1:${targetPort}/db/interface-restore`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({readings:data.readings})});
  assert.equal(r.status,200);assert.equal((await r.json()).total,2);
  r=await fetch(`http://127.0.0.1:${targetPort}/db/interface-readings?limit=20`);data=await r.json();assert.equal(data.readings[1].period.results.vlan1.total,9000);
});
