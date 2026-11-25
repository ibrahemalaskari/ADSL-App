// SQLite persistence and one-time, non-destructive migration from browser localStorage.
// Node-only module: imported by the local Termux bridge, never exposed as a static file.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 5;
import { makeReading, appendReading } from './counters.js';
const FACES = [100, 200, 250, 500, 1000];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function json(value) { return JSON.stringify(value ?? null); }
function finiteOrNull(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function isValidDay(value) {
  if (typeof value !== 'string' || !DAY_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
function assertTimestamp(value, label = 'وقت المزامنة') {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError(`${label} غير صالح`);
  const date = new Date(value);
  if (date.toISOString() !== value) throw new TypeError(`${label} يجب أن يكون بصيغة ISO`);
  return value;
}
function validateRouterEntry(day, entry) {
  if (!isValidDay(day)) throw new TypeError(`تاريخ راوتر غير صالح: ${day}`);
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError(`بيانات يوم الراوتر غير صالحة: ${day}`);
  const p = Number(entry.p), lb = Number(entry.lb), lx = Number(entry.lx);
  if (entry.p == null || !Number.isFinite(p) || p < 0) throw new TypeError(`استهلاك البرنامج غير صالح: ${day}`);
  if (!Number.isSafeInteger(lb) || lb < 0) throw new TypeError(`استهلاك البايتات غير صالح: ${day}`);
  if (typeof entry.lp !== 'boolean') throw new TypeError(`حالة تثبيت اليوم غير صالحة: ${day}`);
  if (!isValidDay(entry.lr)) throw new TypeError(`تاريخ آخر قراءة غير صالح: ${day}`);
  if (!Number.isSafeInteger(lx) || lx < 0) throw new TypeError(`عدد الكروت المنتهية غير صالح: ${day}`);
  if (!Array.isArray(entry.c) || entry.c.length !== FACES.length || entry.c.some((n) => !Number.isSafeInteger(n) || n < 0)) {
    throw new TypeError(`أعداد فئات الكروت غير صالحة: ${day}`);
  }
  return { p, lb, lp: entry.lp, lr: entry.lr, lx, c: entry.c.slice() };
}
const SYNC_SUMMARY_FIELDS = ['total', 'new', 'updated', 'pinned', 'hidden', 'unchanged', 'alreadyPinned', 'manual'];
function normalizeSyncSummary(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('ملخص المزامنة غير صالح');
  const out = {};
  for (const key of SYNC_SUMMARY_FIELDS) {
    if (value[key] == null) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new TypeError(`قيمة ملخص المزامنة غير صالحة: ${key}`);
    out[key] = value[key];
  }
  return out;
}
function parseJsonOrNull(value) { try { return value == null ? null : JSON.parse(value); } catch { return null; } }
function assertState(state) {
  if (!state || typeof state !== 'object' || !state.d || typeof state.d !== 'object' || Array.isArray(state.d)) throw new TypeError('حالة الأيام غير صالحة');
  for (const day of Object.keys(state.d)) if (!isValidDay(day)) throw new TypeError(`تاريخ غير صالح: ${day}`);
}

export class SQLiteStore {
  constructor({ filename }) {
    if (!filename) throw new TypeError('filename is required');
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS line_balance_readings (day TEXT NOT NULL, line_id INTEGER NOT NULL CHECK(line_id BETWEEN 0 AND 2), balance_gb REAL, updated_at TEXT NOT NULL, PRIMARY KEY(day,line_id));
      CREATE TABLE IF NOT EXISTS line_balance_adjustments (day TEXT NOT NULL, line_id INTEGER NOT NULL CHECK(line_id BETWEEN 0 AND 2), adjustment_gb REAL, updated_at TEXT NOT NULL, PRIMARY KEY(day,line_id));
      CREATE TABLE IF NOT EXISTS month_opening_balances (month_key TEXT NOT NULL, line_id INTEGER NOT NULL CHECK(line_id BETWEEN 0 AND 2), balance_gb REAL, updated_at TEXT NOT NULL, PRIMARY KEY(month_key,line_id));
      CREATE TABLE IF NOT EXISTS daily_sales (day TEXT PRIMARY KEY, amount REAL, source_type TEXT NOT NULL, imported_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS router_card_days (day TEXT PRIMARY KEY, used_gb REAL, used_bytes INTEGER, legacy_lb REAL, is_pinned INTEGER, last_read_on TEXT, expired_count INTEGER, imported_at TEXT NOT NULL, synced_at TEXT);
      CREATE TABLE IF NOT EXISTS router_card_counts (day TEXT NOT NULL, face INTEGER NOT NULL, card_count REAL, PRIMARY KEY(day,face), FOREIGN KEY(day) REFERENCES router_card_days(day) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS router_sync_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, attempted_at TEXT NOT NULL, status TEXT, read_on TEXT, date_source TEXT, summary_json TEXT, error_code TEXT);
      CREATE TABLE IF NOT EXISTS interface_counter_readings (ts INTEGER PRIMARY KEY, uptime_sec REAL, reading_json TEXT NOT NULL, period_json TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_logs (id INTEGER PRIMARY KEY, occurred_at TEXT, level TEXT, code TEXT, message TEXT);
      CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sales_profile_prices (profile_name TEXT PRIMARY KEY, price REAL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sales_records (
        sale_key TEXT PRIMARY KEY, router_key TEXT NOT NULL, username TEXT NOT NULL, profile_name TEXT,
        price REAL, sale_day TEXT NOT NULL, started_at TEXT NOT NULL, nas_port_id TEXT,
        first_session_id TEXT, session_count INTEGER NOT NULL, download_bytes INTEGER NOT NULL,
        upload_bytes INTEGER NOT NULL, uptime_seconds INTEGER NOT NULL,
        traffic_complete INTEGER NOT NULL DEFAULT 1 CHECK(traffic_complete IN (0,1)),
        duration_complete INTEGER NOT NULL DEFAULT 1 CHECK(duration_complete IN (0,1)),
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sales_day ON sales_records(sale_day);
      CREATE INDEX IF NOT EXISTS idx_sales_profile ON sales_records(profile_name);
      CREATE INDEX IF NOT EXISTS idx_sales_port ON sales_records(nas_port_id);
      CREATE TABLE IF NOT EXISTS sales_sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, captured_at TEXT NOT NULL, status TEXT NOT NULL,
        router_key TEXT, session_count INTEGER NOT NULL DEFAULT 0, voucher_count INTEGER NOT NULL DEFAULT 0,
        inserted_count INTEGER NOT NULL DEFAULT 0, updated_count INTEGER NOT NULL DEFAULT 0,
        unpriced_count INTEGER NOT NULL DEFAULT 0, warning_count INTEGER NOT NULL DEFAULT 0, error_code TEXT
      );
    `);
    // ترقية إضافية غير هدّامة من مخطط 0.7.4: إضافة وقت المزامنة دون المساس بالصفوف القديمة.
    const salesColumns = new Set(this.db.prepare('PRAGMA table_info(sales_records)').all().map((row) => row.name));
    if (!salesColumns.has('traffic_complete')) this.db.exec('ALTER TABLE sales_records ADD COLUMN traffic_complete INTEGER NOT NULL DEFAULT 0 CHECK(traffic_complete IN (0,1))');
    if (!salesColumns.has('duration_complete')) this.db.exec('ALTER TABLE sales_records ADD COLUMN duration_complete INTEGER NOT NULL DEFAULT 0 CHECK(duration_complete IN (0,1))');
    const routerColumns = new Set(this.db.prepare('PRAGMA table_info(router_card_days)').all().map((row) => row.name));
    if (!routerColumns.has('synced_at')) this.db.exec('ALTER TABLE router_card_days ADD COLUMN synced_at TEXT');
    this.db.prepare("INSERT INTO app_meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(SCHEMA_VERSION));
  }

  diagnostics() {
    const integrity = this.db.prepare('PRAGMA integrity_check').all().map(r => r.integrity_check || Object.values(r)[0]);
    const routerSync = this.getLastRouterSync();
    const salesSync = this.getSalesSyncRuns({ limit: 1 })[0] || null;
    const counts = {
      routerDays: this.db.prepare('SELECT COUNT(*) AS n FROM router_card_days').get().n,
      salesRecords: this.db.prepare('SELECT COUNT(*) AS n FROM sales_records').get().n,
      unpricedSales: this.db.prepare('SELECT COUNT(*) AS n FROM sales_records WHERE price IS NULL').get().n,
      lineBalanceDays: this.db.prepare('SELECT COUNT(DISTINCT day) AS n FROM line_balance_readings').get().n,
      priceProfiles: this.db.prepare('SELECT COUNT(*) AS n FROM sales_profile_prices').get().n,
      routerSyncRuns: this.db.prepare('SELECT COUNT(*) AS n FROM router_sync_runs').get().n,
      interfaceReadings: this.db.prepare('SELECT COUNT(*) AS n FROM interface_counter_readings').get().n,
      salesSyncRuns: this.db.prepare('SELECT COUNT(*) AS n FROM sales_sync_runs').get().n,
      zeroTrafficSales: this.db.prepare('SELECT COUNT(*) AS n FROM sales_records WHERE traffic_complete=1 AND download_bytes=0 AND upload_bytes=0').get().n,
      incompleteTrafficSales: this.db.prepare('SELECT COUNT(*) AS n FROM sales_records WHERE traffic_complete=0').get().n,
      incompleteDurationSales: this.db.prepare('SELECT COUNT(*) AS n FROM sales_records WHERE duration_complete=0').get().n,
      zeroDurationSales: this.db.prepare('SELECT COUNT(*) AS n FROM sales_records WHERE duration_complete=1 AND uptime_seconds=0').get().n,
      pricedSales: this.db.prepare('SELECT COUNT(*) AS n FROM sales_records WHERE price IS NOT NULL').get().n,
    };
    const anomalies = this.db.prepare(`SELECT sale_day AS day,username,profile_name AS profile,session_count AS sessions,
      download_bytes AS downloadBytes,upload_bytes AS uploadBytes,uptime_seconds AS uptimeSeconds,
      traffic_complete AS trafficComplete,duration_complete AS durationComplete,price
      FROM sales_records WHERE (traffic_complete=1 AND download_bytes=0 AND upload_bytes=0) OR duration_complete=0 OR traffic_complete=0 OR price IS NULL
      ORDER BY sale_day DESC,username LIMIT 100`).all();
    const duplicateUserDays = this.db.prepare(`SELECT sale_day AS day,username,COUNT(*) AS records
      FROM sales_records GROUP BY sale_day,username HAVING COUNT(*)>1 ORDER BY sale_day DESC LIMIT 100`).all();
    const alerts = [];
    if (integrity.length !== 1 || integrity[0] !== 'ok') alerts.push({ level: 'critical', code: 'SQLITE_INTEGRITY', message: 'فحص سلامة قاعدة البيانات لم ينجح.' });
    if (!routerSync || routerSync.status !== 'ok') alerts.push({ level: 'warning', code: 'ROUTER_SYNC_MISSING_OR_FAILED', message: 'لا توجد مزامنة راوتر ناجحة مسجلة.' });
    if (!salesSync) alerts.push({ level: 'info', code: 'SALES_SYNC_NOT_RUN', message: 'لم يتم تشغيل مزامنة المبيعات بعد.' });
    if (counts.unpricedSales) alerts.push({ level: 'warning', code: 'SALES_UNPRICED', message: `يوجد ${counts.unpricedSales} سجل مبيعات غير مسعّر.` });
    if (counts.incompleteTrafficSales) alerts.push({ level: 'warning', code: 'SALES_TRAFFIC_INCOMPLETE', message: `يوجد ${counts.incompleteTrafficSales} سجل حركة بياناته ناقصة؛ لم تُعامل القراءة الناقصة كصفر موثوق.` });
    if (counts.incompleteDurationSales) alerts.push({ level: 'warning', code: 'SALES_DURATION_INCOMPLETE', message: `يوجد ${counts.incompleteDurationSales} سجل مدة جلسته غير مكتملة.` });
    if (counts.zeroTrafficSales) alerts.push({ level: 'warning', code: 'SALES_ZERO_TRAFFIC', message: `يوجد ${counts.zeroTrafficSales} سجل بجلسات دون حركة بيانات؛ يحتاج مراجعة ولا يعني بالضرورة خطأ.` });
    if (duplicateUserDays.length) alerts.push({ level: 'info', code: 'SALES_MULTI_RECORD_USER_DAY', message: `ظهرت ${duplicateUserDays.length} حالات مستخدم لديه أكثر من سجل في اليوم؛ قد تكون طبيعية وتحتاج مراجعة.` });
    if (salesSync?.warningCount) alerts.push({ level: 'warning', code: 'SALES_SYNC_WARNINGS', message: `آخر مزامنة مبيعات سجلت ${salesSync.warningCount} تحذيراً.` });
    return { ok: integrity.length === 1 && integrity[0] === 'ok', checkedAt: new Date().toISOString(), integrity, counts,
      latest: { routerSync, salesSync }, anomalies, duplicateUserDays, alerts };
  }

  status() {
    const migrated = this.db.prepare("SELECT value FROM app_meta WHERE key='legacy_migration_v1'").get();
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM line_balance_readings').get().n;
    const days = this.db.prepare('SELECT COUNT(*) AS n FROM router_card_days').get().n;
    const sales = this.db.prepare('SELECT COUNT(*) AS n FROM sales_records').get().n;
    const interfaceReadings = this.db.prepare('SELECT COUNT(*) AS n FROM interface_counter_readings').get().n;
    return { ok: true, schemaVersion: SCHEMA_VERSION, migrated: !!migrated, manualBalanceRows: count, routerDays: days, salesRows: sales, interfaceReadings };
  }

  // استيراد Excel بعد ترحيل SQLite: دمج إضافي غير هدّام، يملأ الفراغات فقط.
  mergeImportedState(state) {
    assertState(state);
    const now = new Date().toISOString();
    const report = { daysAdded: 0, balancesAdded: 0, adjustmentsAdded: 0, salesAdded: 0, routerDaysAdded: 0, cardCountsAdded: 0, openingsAdded: 0 };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const getB = this.db.prepare('SELECT balance_gb FROM line_balance_readings WHERE day=? AND line_id=?');
      const putB = this.db.prepare('INSERT INTO line_balance_readings(day,line_id,balance_gb,updated_at) VALUES(?,?,?,?)');
      const getO = this.db.prepare('SELECT adjustment_gb FROM line_balance_adjustments WHERE day=? AND line_id=?');
      const putO = this.db.prepare('INSERT INTO line_balance_adjustments(day,line_id,adjustment_gb,updated_at) VALUES(?,?,?,?)');
      const getS = this.db.prepare('SELECT amount FROM daily_sales WHERE day=?');
      const putS = this.db.prepare("INSERT INTO daily_sales(day,amount,source_type,imported_at) VALUES(?,?,'excel_import',?)");
      const getRouter = this.db.prepare('SELECT day FROM router_card_days WHERE day=?');
      const putRouter = this.db.prepare('INSERT INTO router_card_days(day,used_gb,used_bytes,legacy_lb,is_pinned,last_read_on,expired_count,imported_at) VALUES(?,?,?,?,?,?,?,?)');
      const putCard = this.db.prepare('INSERT INTO router_card_counts(day,face,card_count) VALUES(?,?,?)');
      for (const [day, e] of Object.entries(state.d || {})) {
        let found = false;
        for (let i=0;i<3;i++) {
          const b = Array.isArray(e.b) ? finiteOrNull(e.b[i]) : null;
          if (b != null && !getB.get(day,i)) { putB.run(day,i,b,now); report.balancesAdded++; found=true; }
          const o = Array.isArray(e.o) ? finiteOrNull(e.o[i]) : null;
          if (o != null && !getO.get(day,i)) { putO.run(day,i,o,now); report.adjustmentsAdded++; found=true; }
        }
        if (e.s != null && finiteOrNull(e.s) != null && !getS.get(day)) { putS.run(day,finiteOrNull(e.s),now); report.salesAdded++; found=true; }
        const hasRouter = ['p','lb','lp','lr','lx'].some(k => e[k] != null) || (Array.isArray(e.c) && e.c.some(v => v != null));
        if (hasRouter && !getRouter.get(day)) {
          putRouter.run(day,finiteOrNull(e.p),finiteOrNull(e.lb),finiteOrNull(e.lb),e.lp == null ? null : (e.lp ? 1 : 0),e.lr == null ? null : String(e.lr),finiteOrNull(e.lx),now);
          report.routerDaysAdded++; found=true;
          const faces=[100,200,250,500,1000]; for(let i=0;i<faces.length;i++){const cv=Array.isArray(e.c)?finiteOrNull(e.c[i]):null;if(cv!=null){putCard.run(day,faces[i],cv);report.cardCountsAdded++;}}
        }
        if (found) report.daysAdded++;
      }
      const getOpen = this.db.prepare('SELECT balance_gb FROM month_opening_balances WHERE month_key=? AND line_id=?');
      const putOpen = this.db.prepare('INSERT INTO month_opening_balances(month_key,line_id,balance_gb,updated_at) VALUES(?,?,?,?)');
      for (const [month, values] of Object.entries(state.op || {})) for (let i=0;i<3;i++) {
        const v = Array.isArray(values) ? finiteOrNull(values[i]) : null;
        if (v != null && !getOpen.get(month,i)) { putOpen.run(month,i,v,now); report.openingsAdded++; }
      }
      this.db.exec('COMMIT');
      return report;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  migrateLegacy({ state, lastSync = null, log = null, alert = null }) {
    assertState(state);
    if (this.db.prepare("SELECT value FROM app_meta WHERE key='legacy_migration_v1'").get()) return { ...this.status(), alreadyMigrated: true };
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const balance = this.db.prepare('INSERT INTO line_balance_readings(day,line_id,balance_gb,updated_at) VALUES(?,?,?,?)');
      const adjustment = this.db.prepare('INSERT INTO line_balance_adjustments(day,line_id,adjustment_gb,updated_at) VALUES(?,?,?,?)');
      const sales = this.db.prepare("INSERT INTO daily_sales(day,amount,source_type,imported_at) VALUES(?,?, 'legacy_unknown', ?)");
      const cardDay = this.db.prepare('INSERT INTO router_card_days(day,used_gb,used_bytes,legacy_lb,is_pinned,last_read_on,expired_count,imported_at) VALUES(?,?,?,?,?,?,?,?)');
      const cardCount = this.db.prepare('INSERT INTO router_card_counts(day,face,card_count) VALUES(?,?,?)');
      for (const [day, entry] of Object.entries(state.d)) {
        const b = Array.isArray(entry?.b) ? entry.b : [];
        const o = Array.isArray(entry?.o) ? entry.o : [];
        for (let i = 0; i < 3; i++) {
          const bv = finiteOrNull(b[i]); if (bv != null) balance.run(day, i, bv, now);
          const ov = finiteOrNull(o[i]); if (ov != null) adjustment.run(day, i, ov, now);
        }
        if (entry?.s != null) sales.run(day, finiteOrNull(entry.s), now);
        const hasRouterData = ['p','lb','lp','lr','lx','c'].some(k => entry?.[k] != null);
        if (hasRouterData) {
          cardDay.run(day, finiteOrNull(entry.p), finiteOrNull(entry.lb), finiteOrNull(entry.lb), entry.lp == null ? null : (entry.lp ? 1 : 0), entry.lr == null ? null : String(entry.lr), finiteOrNull(entry.lx), now);
          const c = Array.isArray(entry.c) ? entry.c : [];
          for (let i = 0; i < FACES.length; i++) { const cv = finiteOrNull(c[i]); if (cv != null) cardCount.run(day, FACES[i], cv); }
        }
      }
      for (const [month, values] of Object.entries(state.op || {})) {
        if (!/^\d{4}-\d{2}$/.test(month) || !Array.isArray(values)) continue;
        for (let i = 0; i < 3; i++) { const v = finiteOrNull(values[i]); if (v != null) this.db.prepare('INSERT INTO month_opening_balances(month_key,line_id,balance_gb,updated_at) VALUES(?,?,?,?)').run(month,i,v,now); }
      }
      if (lastSync && typeof lastSync === 'object' && typeof lastSync.at === 'string') {
        this.db.prepare('INSERT INTO router_sync_runs(attempted_at,status,read_on,date_source,summary_json,error_code) VALUES(?,?,?,?,?,?)').run(lastSync.at,lastSync.ok?'ok':'error',lastSync.readOn||null,lastSync.dateSource||null,json(lastSync.summary),lastSync.errorCode||null);
      }
      if (Array.isArray(log?.entries)) {
        const ins = this.db.prepare('INSERT INTO operation_logs(id,occurred_at,level,code,message) VALUES(?,?,?,?,?)');
        for (const item of log.entries) {
          const message = String(item.msg || item.message || '').slice(0, 1000);
          if (/password|كلمة المرور|username|اسم المستخدم/i.test(message)) continue;
          ins.run(Number.isInteger(item.id)?item.id:null,item.ts||item.at||item.time||null,item.level||'info',item.code||'LEGACY',message);
        }
      }
      if (alert && typeof alert === 'object') this.db.prepare('INSERT OR REPLACE INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)').run('alert',json(alert),now);
      if (state.vn && typeof state.vn === 'object' && !Array.isArray(state.vn)) this.db.prepare('INSERT OR REPLACE INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)').run('vlan_names',json(state.vn),now);
      this.db.prepare("INSERT INTO app_meta(key,value) VALUES('legacy_migration_v1',?)").run(now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { ...this.status(), alreadyMigrated: false };
  }

  saveMonthOpeningBalances(month, balances) {
    if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new TypeError('الشهر غير صالح');
    if (!Array.isArray(balances) || balances.length !== 3) throw new TypeError('أرصدة بداية الشهر غير صالحة');
    const clean = balances.map(v => { if (v == null || v === '') return null; const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new TypeError('قيمة رصيد بداية الشهر غير صالحة'); return n; });
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const put = this.db.prepare('INSERT INTO month_opening_balances(month_key,line_id,balance_gb,updated_at) VALUES(?,?,?,?) ON CONFLICT(month_key,line_id) DO UPDATE SET balance_gb=excluded.balance_gb,updated_at=excluded.updated_at');
      const del = this.db.prepare('DELETE FROM month_opening_balances WHERE month_key=? AND line_id=?');
      for (let i=0;i<3;i++) { if (clean[i] == null) del.run(month,i); else put.run(month,i,clean[i],now); }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return this.getMonthOpeningBalances(month);
  }

  getMonthOpeningBalances(month) {
    if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new TypeError('الشهر غير صالح');
    const rows=this.db.prepare('SELECT line_id,balance_gb FROM month_opening_balances WHERE month_key=?').all(month);
    const balances=[null,null,null]; for (const row of rows) balances[row.line_id]=row.balance_gb;
    return { month, balances };
  }

  getAllMonthOpeningBalances() {
    return this.db.prepare('SELECT DISTINCT month_key FROM month_opening_balances ORDER BY month_key').all().map(({month_key})=>this.getMonthOpeningBalances(month_key));
  }

  saveLineBalances(day, { balances = [], adjustments = [] } = {}) {
    if (!isValidDay(day)) throw new TypeError('تاريخ غير صالح');
    if (!Array.isArray(balances) || !Array.isArray(adjustments) || balances.length !== 3 || adjustments.length !== 3) throw new TypeError('بيانات أرصدة الخطوط غير صالحة');
    const clean = (v, allowNegative) => {
      if (v == null || v === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n) || (!allowNegative && n < 0)) throw new TypeError('قيمة رصيد غير صالحة');
      return n;
    };
    const cleanBalances = balances.map(v => clean(v, false));
    const cleanAdjustments = adjustments.map(v => clean(v, true));
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const putB = this.db.prepare('INSERT INTO line_balance_readings(day,line_id,balance_gb,updated_at) VALUES(?,?,?,?) ON CONFLICT(day,line_id) DO UPDATE SET balance_gb=excluded.balance_gb,updated_at=excluded.updated_at');
      const putO = this.db.prepare('INSERT INTO line_balance_adjustments(day,line_id,adjustment_gb,updated_at) VALUES(?,?,?,?) ON CONFLICT(day,line_id) DO UPDATE SET adjustment_gb=excluded.adjustment_gb,updated_at=excluded.updated_at');
      const delB = this.db.prepare('DELETE FROM line_balance_readings WHERE day=? AND line_id=?');
      const delO = this.db.prepare('DELETE FROM line_balance_adjustments WHERE day=? AND line_id=?');
      for (let i=0;i<3;i++) { const b=cleanBalances[i], o=cleanAdjustments[i]; if (b == null) delB.run(day,i); else putB.run(day,i,b,now); if (o == null) delO.run(day,i); else putO.run(day,i,o,now); }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return this.getLineBalances(day);
  }

  clearLineBalances(day) {
    if (!isValidDay(day)) throw new TypeError('تاريخ غير صالح');
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare('DELETE FROM line_balance_readings WHERE day=?').run(day); this.db.prepare('DELETE FROM line_balance_adjustments WHERE day=?').run(day); this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return this.getLineBalances(day);
  }

  getLineBalances(day) {
    if (!isValidDay(day)) throw new TypeError('تاريخ غير صالح');
    const b=this.db.prepare('SELECT line_id,balance_gb FROM line_balance_readings WHERE day=?').all(day);
    const o=this.db.prepare('SELECT line_id,adjustment_gb FROM line_balance_adjustments WHERE day=?').all(day);
    const balances=[null,null,null], adjustments=[null,null,null];
    for (const r of b) balances[r.line_id]=r.balance_gb;
    for (const r of o) adjustments[r.line_id]=r.adjustment_gb;
    return { day, balances, adjustments };
  }

  getAllLineBalances() {
    const days=this.db.prepare(`SELECT day FROM line_balance_readings UNION SELECT day FROM line_balance_adjustments ORDER BY day`).all();
    return days.map(({day})=>this.getLineBalances(day));
  }

  // ---------------- مبيعات User Manager: أرشيف مستقل لا يخلط مع المبيعات اليدوية اليومية.
  getSalesPrices() {
    return this.db.prepare('SELECT profile_name AS profile,price,updated_at AS updatedAt FROM sales_profile_prices ORDER BY profile_name').all();
  }

  saveSalesPrices({ items = [] } = {}) {
    if (!Array.isArray(items) || items.length > 500) throw new TypeError('قائمة أسعار الباقات غير صالحة');
    const clean = [], seen = new Set();
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('تعريف سعر باقة غير صالح');
      const profile = String(item.profile ?? '').trim();
      if (!profile || profile.length > 200 || /[\u0000-\u001f]/.test(profile)) throw new TypeError('اسم الباقة غير صالح');
      if (seen.has(profile)) throw new TypeError(`الباقة مكررة: ${profile}`);
      seen.add(profile);
      let price = null;
      if (item.price != null && item.price !== '') {
        price = Number(item.price);
        if (!Number.isFinite(price) || price < 0 || price > 1000000000) throw new TypeError(`السعر غير صالح للباقة ${profile}`);
      }
      clean.push({ profile, price });
    }
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const put = this.db.prepare(`INSERT INTO sales_profile_prices(profile_name,price,updated_at) VALUES(?,?,?)
        ON CONFLICT(profile_name) DO UPDATE SET price=excluded.price,updated_at=excluded.updated_at`);
      const update = this.db.prepare('UPDATE sales_records SET price=? WHERE profile_name=?');
      for (const item of clean) { put.run(item.profile, item.price, now); update.run(item.price, item.profile); }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { ok: true, prices: this.getSalesPrices() };
  }

  applySalesSync({ routerKey, records = [], profiles = [], capturedAt = new Date().toISOString(), warnings = [] } = {}) {
    assertTimestamp(capturedAt, 'وقت مزامنة المبيعات');
    if (typeof routerKey !== 'string' || !routerKey.trim() || routerKey.length > 300) throw new TypeError('هوية الراوتر غير صالحة');
    if (!Array.isArray(records) || records.length > 100000) throw new TypeError('قائمة المبيعات غير صالحة');
    if (!Array.isArray(profiles) || profiles.length > 500) throw new TypeError('قائمة الباقات غير صالحة');
    if (!Array.isArray(warnings) || warnings.length > 500) throw new TypeError('قائمة التنبيهات غير صالحة');
    const cleanProfiles = [...new Set(profiles.map(x => String(x ?? '').trim()).filter(x => x && x.length <= 200))];
    const normalized = [], seen = new Set();
    for (const r of records) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) throw new TypeError('سجل مبيعات غير صالح');
      const saleKey = String(r.saleKey ?? '');
      const username = String(r.username ?? '').trim();
      const profile = r.profile == null ? '' : String(r.profile).trim();
      if (!saleKey || saleKey.length > 1000 || !username || username.length > 255) throw new TypeError('هوية سجل المبيعات غير صالحة');
      if (seen.has(saleKey)) throw new TypeError('مفتاح مبيعات مكرر');
      seen.add(saleKey);
      const day = r.saleDay;
      if (!isValidDay(day)) throw new TypeError(`تاريخ مبيعات غير صالح: ${day}`);
      const startedAt = String(r.startedAt ?? '');
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(startedAt) || startedAt.slice(0,10) !== day) throw new TypeError('وقت بدء سجل المبيعات غير صالح');
      const sessionCount = Number(r.sessionCount), downloadBytes = Number(r.downloadBytes), uploadBytes = Number(r.uploadBytes), uptimeSeconds = Number(r.uptimeSeconds);
      const trafficComplete = r.trafficComplete !== false, durationComplete = r.durationComplete !== false;
      if (!Number.isSafeInteger(sessionCount) || sessionCount < 1 || !Number.isSafeInteger(downloadBytes) || downloadBytes < 0 || !Number.isSafeInteger(uploadBytes) || uploadBytes < 0 || !Number.isSafeInteger(uptimeSeconds) || uptimeSeconds < 0) throw new TypeError('عدادات المبيعات غير صالحة');
      normalized.push({ saleKey, username, profile: profile.slice(0,200) || null, day, startedAt,
        nasPortId: r.nasPortId == null ? null : String(r.nasPortId).slice(0,200),
        firstSessionId: r.firstSessionId == null ? null : String(r.firstSessionId).slice(0,160),
        sessionCount, downloadBytes, uploadBytes, uptimeSeconds, trafficComplete, durationComplete });
    }
    const safeWarnings = warnings.map(x => String(x).slice(0,500)).filter(Boolean);
    const now = capturedAt;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const putProfile = this.db.prepare('INSERT OR IGNORE INTO sales_profile_prices(profile_name,price,updated_at) VALUES(?,NULL,?)');
      for (const profile of cleanProfiles) putProfile.run(profile, now);
      const getPrice = this.db.prepare('SELECT price FROM sales_profile_prices WHERE profile_name=?');
      const previous = this.db.prepare(`SELECT router_key,username,profile_name,price,sale_day,started_at,nas_port_id,first_session_id,session_count,download_bytes,upload_bytes,uptime_seconds,traffic_complete,duration_complete FROM sales_records WHERE sale_key=?`);
      const put = this.db.prepare(`INSERT INTO sales_records(
        sale_key,router_key,username,profile_name,price,sale_day,started_at,nas_port_id,first_session_id,
        session_count,download_bytes,upload_bytes,uptime_seconds,traffic_complete,duration_complete,first_seen_at,last_seen_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(sale_key) DO UPDATE SET router_key=excluded.router_key,username=excluded.username,
        profile_name=excluded.profile_name,price=excluded.price,sale_day=excluded.sale_day,started_at=excluded.started_at,
        nas_port_id=excluded.nas_port_id,first_session_id=excluded.first_session_id,session_count=excluded.session_count,
        download_bytes=excluded.download_bytes,upload_bytes=excluded.upload_bytes,uptime_seconds=excluded.uptime_seconds,
        traffic_complete=excluded.traffic_complete,duration_complete=excluded.duration_complete,
        last_seen_at=excluded.last_seen_at`);
      let inserted = 0, updated = 0, unchanged = 0, unpriced = 0, sessionCount = 0;
      for (const r of normalized) {
        const mapping = r.profile ? getPrice.get(r.profile) : null;
        const price = mapping && mapping.price != null ? mapping.price : null;
        if (price == null) unpriced++;
        const prior = previous.get(r.saleKey);
        const values = [routerKey.trim(), r.username, r.profile, price, r.day, r.startedAt, r.nasPortId, r.firstSessionId, r.sessionCount, r.downloadBytes, r.uploadBytes, r.uptimeSeconds, Number(r.trafficComplete), Number(r.durationComplete)];
        if (!prior) inserted++;
        else if (values.every((v, i) => (v ?? null) === (Object.values(prior)[i] ?? null))) unchanged++;
        else updated++;
        sessionCount += r.sessionCount;
        put.run(r.saleKey, routerKey.trim(), r.username, r.profile, price, r.day, r.startedAt,
          r.nasPortId, r.firstSessionId, r.sessionCount, r.downloadBytes, r.uploadBytes,
          r.uptimeSeconds, Number(r.trafficComplete), Number(r.durationComplete), now, now);
      }
      const run = this.db.prepare(`INSERT INTO sales_sync_runs(captured_at,status,router_key,session_count,voucher_count,inserted_count,updated_count,unpriced_count,warning_count)
        VALUES(?,'ok',?,?,?,?,?,?,?)`).run(now, routerKey.trim(), sessionCount, normalized.length, inserted, updated, unpriced, safeWarnings.length);
      this.db.exec('COMMIT');
      return { ok: true, syncRunId: Number(run.lastInsertRowid), summary: {
        vouchers: normalized.length, sessions: sessionCount, inserted, updated, unchanged, unpriced,
        priced: normalized.length - unpriced, warningCount: safeWarnings.length,
      }, warnings: safeWarnings, prices: this.getSalesPrices() };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  getSalesData({ from = null, to = null, profile = null, nasPortId = null, limit = 5000 } = {}) {
    if (from != null && !isValidDay(from)) throw new TypeError('تاريخ البداية غير صالح');
    if (to != null && !isValidDay(to)) throw new TypeError('تاريخ النهاية غير صالح');
    if (from && to && from > to) throw new TypeError('نطاق التاريخ معكوس');
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new TypeError('حد سجلات المبيعات غير صالح');
    const clauses = [], args = [];
    if (from) { clauses.push('sale_day>=?'); args.push(from); }
    if (to) { clauses.push('sale_day<=?'); args.push(to); }
    if (profile) { clauses.push('profile_name=?'); args.push(String(profile)); }
    if (nasPortId) { clauses.push('nas_port_id=?'); args.push(String(nasPortId)); }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const summary = this.db.prepare(`SELECT COUNT(*) AS vouchers,COALESCE(SUM(session_count),0) AS sessions,
      COALESCE(SUM(CASE WHEN price IS NOT NULL THEN price ELSE 0 END),0) AS revenue,
      SUM(CASE WHEN price IS NULL THEN 1 ELSE 0 END) AS unpriced,
      COALESCE(SUM(download_bytes),0) AS downloadBytes,COALESCE(SUM(upload_bytes),0) AS uploadBytes,
      COUNT(DISTINCT sale_day) AS days FROM sales_records${where}`).get(...args);
    const records = this.db.prepare(`SELECT sale_key AS saleKey,router_key AS routerKey,username,profile_name AS profile,
      price,sale_day AS saleDay,started_at AS startedAt,nas_port_id AS nasPortId,first_session_id AS firstSessionId,
      session_count AS sessionCount,download_bytes AS downloadBytes,upload_bytes AS uploadBytes,
      uptime_seconds AS uptimeSeconds,traffic_complete AS trafficComplete,duration_complete AS durationComplete,first_seen_at AS firstSeenAt,last_seen_at AS lastSeenAt
      FROM sales_records${where} ORDER BY sale_day DESC,started_at DESC,username LIMIT ?`).all(...args, limit);
    const byDay = this.db.prepare(`SELECT sale_day AS day,COUNT(*) AS vouchers,
      COALESCE(SUM(CASE WHEN price IS NOT NULL THEN price ELSE 0 END),0) AS revenue,
      SUM(CASE WHEN price IS NULL THEN 1 ELSE 0 END) AS unpriced,
      COALESCE(SUM(download_bytes+upload_bytes),0) AS trafficBytes
      FROM sales_records${where} GROUP BY sale_day ORDER BY sale_day DESC`).all(...args);
    return { from, to, summary: { vouchers: summary.vouchers, sessions: summary.sessions,
      revenue: summary.revenue, unpriced: summary.unpriced || 0, priced: summary.vouchers - (summary.unpriced || 0),
      downloadBytes: summary.downloadBytes, uploadBytes: summary.uploadBytes,
      incompleteTraffic: this.db.prepare(`SELECT COUNT(*) AS n FROM sales_records${where}${where ? ' AND' : ' WHERE'} traffic_complete=0`).get(...args).n,
      incompleteDuration: this.db.prepare(`SELECT COUNT(*) AS n FROM sales_records${where}${where ? ' AND' : ' WHERE'} duration_complete=0`).get(...args).n, days: summary.days,
      truncated: summary.vouchers > records.length }, byDay, records, prices: this.getSalesPrices(),
      lastSync: this.getSalesSyncRuns({limit:1})[0] || null };
  }

  getSalesSyncRuns({ limit = 20 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('حد سجل مزامنة المبيعات غير صالح');
    return this.db.prepare(`SELECT id,captured_at AS capturedAt,status,router_key AS routerKey,
      session_count AS sessions,voucher_count AS vouchers,inserted_count AS inserted,updated_count AS updated,
      unpriced_count AS unpriced,warning_count AS warningCount,error_code AS errorCode
      FROM sales_sync_runs ORDER BY id DESC LIMIT ?`).all(limit);
  }

  // يعتمد قراءة User Manager كاملة في معاملة واحدة. لا يكتب أي حقل للخطوط أو المبيعات.
  // days: [{ day, entry: { p, lb, c, lp, lr, lx } }]. لا تُمرّر أسماء مستخدمي User Manager مطلقاً.
  applyRouterSync({ days = [], attemptedAt = new Date().toISOString(), status = 'ok', readOn = null, dateSource = null, summary = null, errorCode = null } = {}) {
    assertTimestamp(attemptedAt);
    if (!Array.isArray(days)) throw new TypeError('قائمة أيام الراوتر غير صالحة');
    if (status !== 'ok' && status !== 'error') throw new TypeError('حالة المزامنة غير صالحة');

    const normalizedDays = [];
    const seen = new Set();
    for (const item of days) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('عنصر يوم الراوتر غير صالح');
      const day = item.day;
      if (seen.has(day)) throw new TypeError(`يوم راوتر مكرر: ${day}`);
      seen.add(day);
      normalizedDays.push({ day, entry: validateRouterEntry(day, item.entry) });
    }

    let safeReadOn = null, safeDateSource = null, safeSummary = null, safeErrorCode = null;
    if (status === 'ok') {
      if (!isValidDay(readOn)) throw new TypeError('تاريخ القراءة غير صالح');
      if (dateSource !== 'router' && dateSource !== 'device') throw new TypeError('مصدر تاريخ القراءة غير صالح');
      safeReadOn = readOn;
      safeDateSource = dateSource;
      safeSummary = normalizeSyncSummary(summary);
      if (errorCode != null) throw new TypeError('لا يجوز إرفاق رمز خطأ بمزامنة ناجحة');
    } else {
      if (normalizedDays.length) throw new TypeError('لا تحفظ أياماً عند فشل المزامنة');
      if (errorCode != null && (typeof errorCode !== 'string' || !/^[A-Z0-9_]{1,50}$/.test(errorCode))) throw new TypeError('رمز خطأ المزامنة غير صالح');
      safeErrorCode = errorCode || 'SYNC_FAILED';
    }

    const putDay = this.db.prepare(`
      INSERT INTO router_card_days(day,used_gb,used_bytes,legacy_lb,is_pinned,last_read_on,expired_count,imported_at,synced_at)
      VALUES(?,?,?,NULL,?,?,?,?,?)
      ON CONFLICT(day) DO UPDATE SET
        used_gb=excluded.used_gb,
        used_bytes=excluded.used_bytes,
        is_pinned=excluded.is_pinned,
        last_read_on=excluded.last_read_on,
        expired_count=excluded.expired_count,
        synced_at=excluded.synced_at
    `);
    const deleteCounts = this.db.prepare('DELETE FROM router_card_counts WHERE day=?');
    const putCount = this.db.prepare('INSERT INTO router_card_counts(day,face,card_count) VALUES(?,?,?)');
    const putRun = this.db.prepare(`
      INSERT INTO router_sync_runs(attempted_at,status,read_on,date_source,summary_json,error_code)
      VALUES(?,?,?,?,?,?)
    `);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const { day, entry } of normalizedDays) {
        putDay.run(day, entry.p, entry.lb, entry.lp ? 1 : 0, entry.lr, entry.lx, attemptedAt, attemptedAt);
        deleteCounts.run(day);
        for (let i = 0; i < FACES.length; i++) putCount.run(day, FACES[i], entry.c[i]);
      }
      const run = putRun.run(attemptedAt, status, safeReadOn, safeDateSource, json(safeSummary), safeErrorCode);
      this.db.exec('COMMIT');
      return {
        ok: true,
        savedDays: normalizedDays.length,
        syncRunId: Number(run.lastInsertRowid),
        days: normalizedDays.map(({ day }) => this.getRouterCardDay(day)),
        lastSync: this.getLastRouterSync(),
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // استعادة بيانات الراوتر فقط من نسخة احتياطية. لا تمسّ أرصدة الخطوط أو المبيعات.
  // mode=merge يضيف الأيام الناقصة فقط؛ mode=replace يستبدل جداول الراوتر وحدها.
  restoreRouterData({ days = [], mode = 'merge', lastSync = null } = {}) {
    if (!Array.isArray(days) || (mode !== 'merge' && mode !== 'replace')) throw new TypeError('بيانات استعادة الراوتر غير صالحة');
    const normalized = [];
    const seen = new Set();
    for (const item of days) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('عنصر يوم الراوتر غير صالح');
      if (seen.has(item.day)) throw new TypeError('يوجد يوم راوتر مكرر');
      seen.add(item.day);
      const e=item.entry;
      if (!isValidDay(item.day) || !e || typeof e!=='object' || Array.isArray(e)) throw new TypeError('بيانات يوم الراوتر غير صالحة');
      if (!Number.isFinite(Number(e.p)) || Number(e.p)<0 || !Number.isSafeInteger(e.lb) || e.lb<0 || typeof e.lp!=='boolean' || !isValidDay(e.lr) || !Number.isSafeInteger(e.lx) || e.lx<0 || !Array.isArray(e.c) || e.c.length!==FACES.length || e.c.some(n=>n!=null&&(!Number.isSafeInteger(n)||n<0))) throw new TypeError(`بيانات يوم الراوتر غير صالحة: ${item.day}`);
      normalized.push({ day: item.day, entry: {p:Number(e.p),lb:e.lb,lp:e.lp,lr:e.lr,lx:e.lx,c:e.c.map(n=>n==null?null:n)} });
    }
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (mode === 'replace') {
        this.db.exec('DELETE FROM router_card_counts; DELETE FROM router_card_days; DELETE FROM router_sync_runs;');
      }
      const has = this.db.prepare('SELECT 1 AS yes FROM router_card_days WHERE day=?');
      const putDay = this.db.prepare(`INSERT INTO router_card_days(day,used_gb,used_bytes,legacy_lb,is_pinned,last_read_on,expired_count,imported_at,synced_at) VALUES(?,?,?,?,?,?,?,?,?)`);
      const putCount = this.db.prepare('INSERT INTO router_card_counts(day,face,card_count) VALUES(?,?,?)');
      let added = 0, skipped = 0;
      for (const {day,entry} of normalized) {
        if (mode === 'merge' && has.get(day)) { skipped++; continue; }
        putDay.run(day,entry.p,entry.lb,entry.lb,entry.lp?1:0,entry.lr,entry.lx,now,now);
        for (let i=0;i<FACES.length;i++) putCount.run(day,FACES[i],entry.c[i]);
        added++;
      }
      if (lastSync && typeof lastSync === 'object' && (mode === 'replace' || !this.getLastRouterSync())) {
        assertTimestamp(lastSync.attemptedAt);
        if (lastSync.status !== 'ok' && lastSync.status !== 'error') throw new TypeError('حالة آخر مزامنة غير صالحة');
        let readOn=null,dateSource=null,summary=null,errorCode=null;
        if(lastSync.status==='ok') { if(!isValidDay(lastSync.readOn)||!['router','device'].includes(lastSync.dateSource)) throw new TypeError('بيانات آخر مزامنة غير صالحة'); readOn=lastSync.readOn;dateSource=lastSync.dateSource;summary=normalizeSyncSummary(lastSync.summary); }
        else { errorCode=typeof lastSync.errorCode==='string'&&/^[A-Z0-9_]{1,50}$/.test(lastSync.errorCode)?lastSync.errorCode:'SYNC_FAILED'; }
        this.db.prepare('INSERT INTO router_sync_runs(attempted_at,status,read_on,date_source,summary_json,error_code) VALUES(?,?,?,?,?,?)').run(lastSync.attemptedAt,lastSync.status,readOn,dateSource,json(summary),errorCode);
      }
      this.db.exec('COMMIT');
      return { ok:true, mode, added, skipped, days:this.getAllRouterCardDays() };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  saveInterfaceReading(input) {
    if (!input || typeof input !== 'object' || !Number.isFinite(input.ts) || (!Array.isArray(input.ifaces) && (!input.ifaces || typeof input.ifaces !== 'object' || Array.isArray(input.ifaces)))) throw new TypeError('قراءة عدادات الواجهات غير صالحة');
    const ifaceRows = Array.isArray(input.ifaces) ? input.ifaces : Object.entries(input.ifaces).map(([name, value]) => ({ name, ...value }));
    const reading = makeReading({ ts: input.ts, uptimeSec: input.uptimeSec ?? null, ifaces: ifaceRows });
    const exists = this.db.prepare('SELECT 1 AS yes FROM interface_counter_readings WHERE ts=?').get(reading.ts);
    if (exists) { const row = this.db.prepare('SELECT ts,reading_json,period_json,created_at FROM interface_counter_readings WHERE ts=?').get(reading.ts); return { ok: true, duplicate: true, reading: { ts: row.ts, reading: parseJsonOrNull(row.reading_json), period: parseJsonOrNull(row.period_json), createdAt: row.created_at } }; }
    const lastRow = this.db.prepare('SELECT reading_json FROM interface_counter_readings ORDER BY ts DESC LIMIT 1').get();
    const history = lastRow ? [{ reading: JSON.parse(lastRow.reading_json), period: null }] : [];
    const result = appendReading(history, reading);
    const period = result.period;
    const createdAt = new Date().toISOString();
    this.db.prepare('INSERT INTO interface_counter_readings(ts,uptime_sec,reading_json,period_json,created_at) VALUES(?,?,?,?,?)')
      .run(reading.ts, reading.uptimeSec, json(reading), json(period), createdAt);
    return { ok: true, duplicate: false, reading: { reading, period, createdAt } };
  }

  restoreInterfaceReadings(input) {
    if (!Array.isArray(input) || input.length > 2000) throw new TypeError('قائمة قراءات الواجهات غير صالحة أو تتجاوز 2000 قراءة');
    const incoming = input.map((x) => makeReading({ ts: x?.reading?.ts ?? x?.ts, uptimeSec: x?.reading?.uptimeSec ?? x?.uptimeSec ?? null, ifaces: Object.entries(x?.reading?.ifaces || x?.ifaces || {}).map(([name, v]) => ({ name, ...v })) }));
    const existing = this.db.prepare('SELECT reading_json FROM interface_counter_readings').all().map(r => JSON.parse(r.reading_json));
    const byTs = new Map(existing.map(r => [r.ts, r]));
    for (const r of incoming) if (!byTs.has(r.ts)) byTs.set(r.ts, r);
    const ordered = [...byTs.values()].sort((a,b)=>a.ts-b.ts);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM interface_counter_readings');
      const put=this.db.prepare('INSERT INTO interface_counter_readings(ts,uptime_sec,reading_json,period_json,created_at) VALUES(?,?,?,?,?)');
      let history=[];
      for(const reading of ordered){const appended=appendReading(history,reading);history=appended.history;put.run(reading.ts,reading.uptimeSec,json(reading),json(appended.period),new Date().toISOString())}
      this.db.exec('COMMIT');
      return {ok:true,total:ordered.length,added:ordered.length-existing.length};
    } catch(e){this.db.exec('ROLLBACK');throw e}
  }

  getInterfaceReadings({ limit = 120, from = null, to = null } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 2000) throw new TypeError('حد قراءات الواجهات يجب أن يكون بين 1 و2000');
    if (from != null && !Number.isFinite(Number(from))) throw new TypeError('بداية الفترة غير صالحة');
    if (to != null && !Number.isFinite(Number(to))) throw new TypeError('نهاية الفترة غير صالحة');
    const rows = this.db.prepare(`SELECT ts,reading_json,period_json,created_at FROM interface_counter_readings
      WHERE (? IS NULL OR ts>=?) AND (? IS NULL OR ts<=?) ORDER BY ts DESC LIMIT ?`)
      .all(from == null ? null : Number(from), from == null ? null : Number(from), to == null ? null : Number(to), to == null ? null : Number(to), limit);
    return { readings: rows.reverse().map(r => ({ ts: r.ts, reading: parseJsonOrNull(r.reading_json), period: parseJsonOrNull(r.period_json), createdAt: r.created_at })), total: this.db.prepare('SELECT COUNT(*) AS n FROM interface_counter_readings').get().n };
  }

  getRouterCardDay(day) {
    if (!isValidDay(day)) throw new TypeError('تاريخ راوتر غير صالح');
    const row = this.db.prepare(`
      SELECT day,used_gb,used_bytes,is_pinned,last_read_on,expired_count,synced_at
      FROM router_card_days WHERE day=?
    `).get(day);
    if (!row) return null;
    const counts = Array(FACES.length).fill(null);
    for (const item of this.db.prepare('SELECT face,card_count FROM router_card_counts WHERE day=?').all(day)) {
      const index = FACES.indexOf(item.face);
      if (index >= 0) counts[index] = item.card_count;
    }
    return {
      day: row.day,
      entry: {
        p: row.used_gb,
        lb: row.used_bytes,
        c: counts,
        lp: row.is_pinned == null ? null : !!row.is_pinned,
        lr: row.last_read_on,
        lx: row.expired_count,
      },
      syncedAt: row.synced_at || null,
    };
  }

  getAllRouterCardDays() {
    return this.db.prepare('SELECT day FROM router_card_days ORDER BY day').all().map(({ day }) => this.getRouterCardDay(day));
  }

  getRouterSyncRuns({ limit = 20 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('حد سجل المزامنة يجب أن يكون بين 1 و100');
    return this.db.prepare(`
      SELECT id,attempted_at,status,read_on,date_source,summary_json,error_code
      FROM router_sync_runs ORDER BY id DESC LIMIT ?
    `).all(limit).map((row) => ({
      id: row.id,
      attemptedAt: row.attempted_at,
      status: row.status,
      readOn: row.read_on,
      dateSource: row.date_source,
      summary: parseJsonOrNull(row.summary_json),
      errorCode: row.error_code,
    }));
  }

  getLastRouterSync() {
    return this.getRouterSyncRuns({ limit: 1 })[0] || null;
  }

  // تصفير البيانات التشغيلية فقط مع الحفاظ على إعدادات التطبيق وبنية القاعدة.
  resetOperationalData() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        DELETE FROM router_card_counts;
        DELETE FROM router_card_days;
        DELETE FROM interface_counter_readings;
        DELETE FROM router_sync_runs;
        DELETE FROM sales_records;
        DELETE FROM sales_sync_runs;
        DELETE FROM daily_sales;
        DELETE FROM line_balance_adjustments;
        DELETE FROM line_balance_readings;
        DELETE FROM month_opening_balances;
        DELETE FROM operation_logs;
      `);
      this.db.exec('COMMIT');
      return { ok: true };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() { this.db.close(); }
}
