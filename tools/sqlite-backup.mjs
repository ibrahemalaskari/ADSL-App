#!/usr/bin/env node
// Safe, consistent SQLite backup for the live ADSL database (WAL-aware via VACUUM INTO).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_DEFAULT = path.join(ROOT, 'data', 'adsl.sqlite');
const BACKUP_DEFAULT = path.join(ROOT, 'data', 'backups');
const PREFIX = 'adsl-sqlite-backup-';
const quoteSql = (s) => `'${String(s).replaceAll("'", "''")}'`;
const stamp = (d = new Date()) => d.toISOString().replaceAll(':','').replaceAll('-','').replaceAll('.','').replace('T','-').replace('Z','');

export function verifyDatabase(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('ملف قاعدة البيانات غير موجود');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all().map(x => Object.values(x)[0]);
    if (integrity.length !== 1 || integrity[0] !== 'ok') throw new Error(`فشل integrity_check: ${integrity.join('; ')}`);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name);
    const version = db.prepare("SELECT value FROM app_meta WHERE key='schema_version'").get()?.value ?? null;
    const counts = {};
    for (const t of ['line_balance_readings','line_balance_adjustments','month_opening_balances','router_card_days','sales_records','sales_sync_runs']) {
      if (tables.includes(t)) counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
    }
    return { ok: true, integrity: 'ok', schemaVersion: version, tables: tables.length, counts };
  } finally { db.close(); }
}

export function createSqliteBackup({ database = DB_DEFAULT, directory = BACKUP_DEFAULT, keep = 12 } = {}) {
  if (!Number.isInteger(keep) || keep < 1 || keep > 1000) throw new Error('عدد الاحتفاظ غير صالح (1-1000)');
  if (!fs.existsSync(database)) throw new Error(`قاعدة التشغيل غير موجودة: ${database}`);
  fs.mkdirSync(directory, { recursive: true });
  const dest = path.join(directory, `${PREFIX}${stamp()}.sqlite`);
  if (fs.existsSync(dest)) throw new Error('ملف النسخة موجود مسبقاً؛ لم يتم استبداله');
  const src = new DatabaseSync(database);
  try {
    src.exec(`VACUUM INTO ${quoteSql(dest)}`);
  } finally { src.close(); }
  try {
    const result = verifyDatabase(dest);
    if (!result.ok) throw new Error('النسخة لم تجتز الفحص');
    // Rotate only known backup files after a newly created backup passed verification.
    const files = fs.readdirSync(directory).filter(n => n.startsWith(PREFIX) && n.endsWith('.sqlite'))
      .map(n => ({ n, t: fs.statSync(path.join(directory,n)).mtimeMs })).sort((a,b)=>b.t-a.t);
    for (const f of files.slice(keep)) fs.unlinkSync(path.join(directory, f.n));
    return { file: dest, sizeBytes: fs.statSync(dest).size, verification: result, retained: Math.min(files.length, keep) };
  } catch (e) {
    try { fs.unlinkSync(dest); } catch {}
    throw e;
  }
}

function usage() { console.log(`نسخ SQLite احتياطي وفحصه\n\nUsage:\n  node tools/sqlite-backup.mjs create [database] [backup-directory]\n  node tools/sqlite-backup.mjs verify <backup-file>\n\nDefault database: ${DB_DEFAULT}\nDefault backup folder: ${BACKUP_DEFAULT}\n`); }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [cmd, a, b] = process.argv.slice(2);
    if (cmd === 'create') console.log(JSON.stringify(createSqliteBackup({ database: a || DB_DEFAULT, directory: b || BACKUP_DEFAULT }), null, 2));
    else if (cmd === 'verify' && a) console.log(JSON.stringify(verifyDatabase(a), null, 2));
    else { usage(); process.exitCode = cmd ? 2 : 0; }
  } catch (e) { console.error(`خطأ: ${e.message}`); process.exitCode = 1; }
}
