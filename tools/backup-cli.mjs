#!/usr/bin/env node
// أداة Termux للنسخ الاحتياطي والاستعادة، فوق core/backup.js (ج17).
//   node tools/backup-cli.mjs create  <state.json> [--out ملف.json]
//   node tools/backup-cli.mjs inspect <backup.json>
//   node tools/backup-cli.mjs restore <state.json> <backup.json> [--mode merge|replace] [--out ملف.json]
// state.json بنية الواجهة ({d, op, vn})، مثل cards-state.json الذي يكتبه cards-read.mjs.
// الأداة لا تعدّل ملف الحالة ولا تستبدل ملفاً موجوداً أبداً: كل ما تكتبه ملف جديد (--out)، وأنت من يقرر استبدال الأصل.
// لا تتصل بالراوتر ولا بالشبكة. لا تشمل الإعدادات والسجل (core/backup.js يدعمهما للتطبيق لاحقاً).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createBackup, serializeBackup, parseBackup, describeBackup, restoreBackup, backupFileName, BackupError,
} from '../core/backup.js';

const USAGE = `الاستعمال:
  node tools/backup-cli.mjs create  <state.json> [--out ملف.json]
  node tools/backup-cli.mjs inspect <backup.json>
  node tools/backup-cli.mjs restore <state.json> <backup.json> [--mode merge|replace] [--out ملف.json]
الأداة لا تعدّل ملف الحالة ولا تستبدل ملفاً موجوداً؛ تكتب ملفاً جديداً فقط.`;

function parseArgs(argv) {
  const o = { pos: [], out: null, mode: 'merge' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') { o.out = argv[++i]; if (!o.out) throw new Error('--out يحتاج اسم ملف'); }
    else if (a === '--mode') { o.mode = argv[++i]; if (o.mode !== 'merge' && o.mode !== 'replace') throw new Error('--mode: merge أو replace'); }
    else if (a.startsWith('--')) throw new Error(`خيار غير معروف: ${a}`);
    else o.pos.push(a);
  }
  return o;
}

function readText(file, what) {
  if (!fs.existsSync(file)) throw new Error(`${what} غير موجود: ${file}`);
  return fs.readFileSync(file, 'utf8');
}

function loadState(file) {
  let s;
  try { s = JSON.parse(readText(file, 'ملف الحالة')); } catch (e) {
    if (e instanceof SyntaxError) throw new Error(`ملف الحالة ليس JSON صالحاً ولم يُمسّ: ${file}`);
    throw e;
  }
  return s;
}

// كتابة بلا استبدال: يرفض إن وُجد الملف، ثم ملف مؤقت وإعادة تسمية فلا يبقى ملف نصف مكتوب.
function writeNew(file, text) {
  if (fs.existsSync(file)) throw new Error(`الملف موجود ولن يُستبدل: ${file} (اختر اسماً آخر بـ --out)`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { flag: 'wx' });
  fs.renameSync(tmp, file);
}

const appVersion = () => {
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version || null; } catch { return null; }
};

function printDescribe(d) {
  console.log(`الصيغة: ${d.version} | أُنشئت: ${d.createdAt} | إصدار التطبيق: ${d.appVersion || 'غير معروف'}`);
  console.log(`الأيام: ${d.days}${d.firstDay ? ` (من ${d.firstDay} إلى ${d.lastDay})` : ''}`);
  if (d.months.length) console.log(`الأشهر: ${d.months.map((m) => `${m.key} (${m.days})`).join('، ')}`);
  console.log(`أيام الكروت المثبّتة: ${d.pinned} | غير المثبّتة (مؤقتة): ${d.temporary}`);
  console.log(`إعدادات: ${d.hasSettings ? 'نعم' : 'لا'} | مدخلات السجل: ${d.logEntries}`);
}

function doCreate(o) {
  const [stateFile] = o.pos;
  if (!stateFile) throw new Error('create يحتاج ملف الحالة');
  const backup = createBackup({ state: loadState(stateFile) }, { appVersion: appVersion() });
  const out = o.out || backupFileName();
  writeNew(out, serializeBackup(backup));
  // نتحقق مما كُتب فعلاً (لا مما نعتقد أننا كتبناه)
  const back = parseBackup(fs.readFileSync(out, 'utf8'));
  console.log(`كُتبت النسخة: ${out}`);
  printDescribe(describeBackup(back));
  console.log('تحقق: قُرئ الملف المكتوب وطابق مجموع التحقق والبنية.');
}

function doInspect(o) {
  const [file] = o.pos;
  if (!file) throw new Error('inspect يحتاج ملف النسخة');
  printDescribe(describeBackup(parseBackup(readText(file, 'ملف النسخة'))));
  console.log('مجموع التحقق والبنية سليمان.');
}

function doRestore(o) {
  const [stateFile, backupFile] = o.pos;
  if (!stateFile || !backupFile) throw new Error('restore يحتاج ملف الحالة وملف النسخة');
  let current;
  if (fs.existsSync(stateFile)) current = loadState(stateFile);
  else { current = { d: {} }; console.log(`(ملف الحالة غير موجود: يُعامل كحالة فارغة)`); }
  const backup = parseBackup(readText(backupFile, 'ملف النسخة'));
  const res = restoreBackup({ state: current }, backup, { mode: o.mode });
  const out = o.out || `${stateFile}.restored.json`;
  writeNew(out, JSON.stringify(res.state, null, 1) + '\n');
  const r = res.report;
  console.log(`الوضع: ${r.mode === 'merge' ? 'دمج (لا يُكتب فوق موجود ولا يُحذف يوم)' : 'استبدال'}`);
  console.log(`أيام أُضيفت: ${r.daysAdded}${r.mode === 'replace' ? ` | أيام ستضيع من الحالة الحالية: ${r.daysDropped}` : ` | قيم مُلئت: ${r.valuesFilled} | قيم مطابقة: ${r.valuesSame}`}`);
  if (r.mode === 'merge') {
    console.log(`تعارضات (بقيت قيمة الحالة الحالية): ${r.conflictsTotal}`);
    for (const c of r.conflicts.slice(0, 10)) console.log(`  ${c.where}: الحالي=${JSON.stringify(c.current)} | في النسخة=${JSON.stringify(c.incoming)}`);
    if (r.conflictsTotal > 10) console.log(`  … و${r.conflictsTotal - 10} أخرى`);
  }
  console.log(`كُتبت الحالة الناتجة في: ${out}`);
  console.log(`ملف الحالة الأصلي لم يُمسّ: ${stateFile}. لاعتماد النتيجة انقلها أنت فوقه بعد المراجعة.`);
}

try {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h') { console.log(USAGE); process.exit(cmd ? 0 : 2); }
  const o = parseArgs(rest);
  if (cmd === 'create') doCreate(o);
  else if (cmd === 'inspect') doInspect(o);
  else if (cmd === 'restore') doRestore(o);
  else { console.log(USAGE); process.exit(2); }
} catch (e) {
  if (e instanceof BackupError) {
    console.error(`خطأ (${e.code}): ${e.message}`);
    for (const d of (e.details || []).slice(0, 20)) console.error(`  - ${d}`);
  } else console.error(`خطأ: ${e.message}`);
  process.exit(1);
}
