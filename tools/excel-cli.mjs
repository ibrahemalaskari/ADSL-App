#!/usr/bin/env node
// أداة تجربة لاستيراد وتصدير Excel في Termux، فوق core/excel.js.
//   node tools/excel-cli.mjs import <ملف.xlsx> [state.json]
//   node tools/excel-cli.mjs export <قالب.xlsx> <state.json> [خرج.xlsx]
// state.json هنا ملف تجريبي بنفس بنية الواجهة ({d, op}) لأن الواجهة لم تُربط بعد بالملفات.
// الاستيراد يدمج بلا تكرار ولا حذف ولا استبدال لقيمة موجودة، ويحفظ نسخة state.json.bak قبل الكتابة.
// التصدير يسأل دائماً عن الشهر، ولا يستبدل ملفاً موجوداً.

import fs from 'node:fs';
import readline from 'node:readline/promises';
import { importWorkbook, exportMonth, mergeState, listMonths, ExcelError } from '../core/excel.js';
import { nodeCodec as codec } from '../core/node-codec.js';

const [, , cmd, ...args] = process.argv;

function usage() {
  console.log('الاستعمال:\n  node tools/excel-cli.mjs import <ملف.xlsx> [state.json]\n  node tools/excel-cli.mjs export <قالب.xlsx> <state.json> [خرج.xlsx]');
  process.exit(2);
}

function loadState(file, mustExist) {
  if (!fs.existsSync(file)) {
    if (mustExist) throw new Error(`الملف غير موجود: ${file}`);
    return { d: {}, op: {} };
  }
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!s || typeof s !== 'object' || typeof s.d !== 'object') throw new Error('ينقصه الحقل d');
    return { ...s, d: s.d || {}, op: s.op || {} };
  } catch (e) {
    throw new Error(`تعذرت قراءة ${file} (لم يُعدَّل): ${e.message}`);
  }
}

async function doImport() {
  const [file, stateFile] = args;
  if (!file) usage();
  const res = await importWorkbook(fs.readFileSync(file), { codec });
  console.log(`الورقة المقروءة: ${res.sheetName}`);
  console.log(`الأشهر: ${res.months.join('، ') || 'لا شيء'} | صفوف بتاريخ: ${res.stats.rowsWithDate} | أيام فيها بيانات: ${res.stats.daysImported} | فوارق يدوية: ${res.stats.manualDiffs}`);
  console.log(`رصيد بداية الشهر: ${res.stats.openingFound ? 'موجود' : 'غير موجود (فارغ)'}`);
  for (const w of res.warnings) console.log('تنبيه: ' + w);
  if (!stateFile) { console.log('لم يُحفظ شيء (لم تُحدَّد state.json).'); return; }
  const base = loadState(stateFile, false);
  const { state, report } = mergeState(base, res.state);
  if (fs.existsSync(stateFile)) fs.copyFileSync(stateFile, stateFile + '.bak');
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));
  console.log(`حُفظ في ${stateFile}: أيام جديدة ${report.daysAdded}، قيم مُكمَّلة ${report.valuesFilled}، قيم مطابقة ${report.valuesSame}، تعارضات (لم تُستبدل) ${report.conflicts.length}`);
  for (const c of report.conflicts.slice(0, 10)) console.log(`  تعارض ${c.where}: الموجود ${c.current} والوارد ${c.incoming}`);
}

async function doExport() {
  const [template, stateFile, outArg] = args;
  if (!template || !stateFile) usage();
  const state = loadState(stateFile, true);
  const months = listMonths(state);
  if (!months.length) throw new Error('لا توجد بيانات أيام في state.json لتصديرها.');
  console.log('الأشهر المتاحة:');
  months.forEach((m, i) => console.log(`  ${i + 1}) ${m.key} (${m.days} يوماً)`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question('أي شهر تريد تصديره؟ (رقمه أو YYYY-MM، وEnter لآخر شهر): ')).trim();
  rl.close();
  let key = null;
  if (ans === '') key = months[months.length - 1].key;
  else if (/^\d+$/.test(ans) && Number(ans) >= 1 && Number(ans) <= months.length) key = months[Number(ans) - 1].key;
  else if (months.some((m) => m.key === ans)) key = ans;
  if (!key) throw new Error(`اختيار غير صالح: «${ans}». لم يُنشأ ملف.`);
  const bytes = await exportMonth(fs.readFileSync(template), state, key, { codec });
  const out = outArg || `export-${key}.xlsx`;
  try { fs.writeFileSync(out, bytes, { flag: 'wx' }); } catch (e) {
    if (e.code === 'EEXIST') throw new Error(`الملف موجود مسبقاً ولم يُستبدل: ${out}`);
    throw e;
  }
  console.log(`تم تصدير ${key} إلى ${out}`);
}

try {
  if (cmd === 'import') await doImport();
  else if (cmd === 'export') await doExport();
  else usage();
} catch (e) {
  console.error('خطأ: ' + (e instanceof ExcelError ? `[${e.code}] ` : '') + e.message);
  process.exit(1);
}
