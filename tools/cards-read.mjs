#!/usr/bin/env node
// أداة قراءة كروت اليوزر مانجر في Termux — قراءة فقط (أوامر print فقط).
//   node tools/cards-read.mjs [العنوان] [المستخدم] [--days 14] [--state ملف.json] [--port 8728] [--out ملف.txt] [--no-save] [--no-sanity]
// تعرض لكل يوم: عدد الكروت لكل فئة (100/200/250/500/1000) والرصيد المستهلك L، ثم فحص اتساق الوحدات.
// مع --state تُطبَّق قاعدة التثبيت وتُحفظ حالة الأيام (أرقام فقط) في الملف، فتتكرر التجربة يوماً بعد يوم.
// كلمة المرور بإدخال مخفي (أو ROS_PASS) ولا تُقبل معاملاً. التقرير والحالة لا يحتويان أسماء مستخدمين.
// الأداة لا تغيّر أي إعداد في الراوتر.

import fs from 'node:fs';
import readline from 'node:readline/promises';
import { RouterOSClient, RosError, diagnose, readSystem } from '../core/routeros-api.js';
import { readCards, formatCardsReport, CardsError } from '../core/cardsreader.js';
import { mergeReadings, parseRosDate } from '../core/cards.js';
import { NetTransport } from './net-transport.mjs';
import { promptHidden } from './prompt-hidden.mjs';

function parseArgs(argv) {
  const o = { pos: [], port: 8728, out: null, save: true, help: false, sanity: true, days: 14, state: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-save') o.save = false;
    else if (a === '--no-sanity') o.sanity = false;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--days') o.days = Number(argv[++i]);
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--state') o.state = argv[++i];
    else if (a.startsWith('--')) throw new Error(`خيار غير معروف: ${a}`);
    else o.pos.push(a);
  }
  if (!Number.isInteger(o.port)) throw new Error('رقم المنفذ غير صالح');
  if (!Number.isInteger(o.days) || o.days < 1) throw new Error('--days رقم صحيح موجب');
  if (o.state !== null && !o.state) throw new Error('--state يحتاج اسم ملف');
  return o;
}

function usage() {
  console.log(`الاستعمال:
  node tools/cards-read.mjs [العنوان] [المستخدم] [الخيارات]
الخيارات:
  --days N        عدد الأيام المعروضة (الافتراضي 14، الأحدث أولاً)
  --state ملف     يطبّق قاعدة التثبيت ويحفظ حالة الأيام (أرقام فقط) في هذا الملف
  --port N        المنفذ (8728 أو 8729 فقط)
  --out ملف       اسم ملف التقرير (الافتراضي cards-read-<وقت>.txt)
  --no-save       لا يحفظ ملف تقرير
  --no-sanity     يتخطى فحص الاتساق (قراءة الحدود)`);
}

const pad = (n) => String(n).padStart(2, '0');
const stamp = () => { const d = new Date(); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; };
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function loadState(file) {
  if (!fs.existsSync(file)) return { d: {} };
  let s;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`ملف الحالة تالف أو ليس JSON ولم يُمسّ: ${file}`); }
  if (!s || typeof s !== 'object' || typeof s.d !== 'object' || s.d === null) throw new Error(`ملف الحالة ليس بالبنية المتوقعة ولم يُمسّ: ${file}`);
  return s;
}

// كتابة ذرّية: ملف مؤقت ثم إعادة تسمية، فلا يبقى ملف حالة نصف مكتوب.
function saveState(file, state) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1) + '\n', { flag: 'wx' });
  fs.renameSync(tmp, file);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { usage(); return; }

  console.log('قراءة كروت اليوزر مانجر — قراءة فقط. لن يُغيَّر شيء في الراوتر.');
  console.log('تُقرأ أسماء المستخدمين في الذاكرة فقط لربط الجلسات بالمستخدمين، ولا تُعرض ولا تُحفظ. لا تُقرأ كلمات المرور.');

  let [host, user] = opts.pos;
  if (!host || !user) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!host) host = (await rl.question('عنوان الراوتر: ')).trim();
      if (!user) user = (await rl.question('اسم المستخدم: ')).trim();
    } finally { rl.close(); }
  }
  if (!host || !user) throw new Error('العنوان واسم المستخدم مطلوبان');
  const pass = process.env.ROS_PASS !== undefined ? process.env.ROS_PASS : await promptHidden('كلمة المرور (لن تظهر): ');

  let state = null;
  if (opts.state) state = loadState(opts.state); // نتأكد من سلامته قبل أي اتصال

  const client = new RouterOSClient(new NetTransport(), { timeoutMs: 10000 }); // readOnly افتراضياً
  try {
    await client.connect({ host, port: opts.port });
    await client.login(user, pass);
    const sys = await readSystem(client);
    let readOn = sys.clock && parseRosDate(sys.clock.date);
    let dayNote = '';
    if (!readOn) { readOn = localDay(); dayNote = ' (من ساعة الجهاز: تعذّرت قراءة تاريخ الراوتر)'; }

    const res = await readCards(client, { withSanity: opts.sanity });

    let merged = null;
    if (state) merged = mergeReadings(state, res.agg, readOn);
    const text = formatCardsReport(res, { generatedAt: new Date().toISOString(), readOn: readOn + dayNote, days: opts.days, results: merged && merged.results, stored: merged && merged.state.d });
    if (merged) saveState(opts.state, merged.state); // بعد نجاح القراءة والتنسيق كاملين
    console.log('\n' + text + '\n');
    if (merged) console.log(`حُفظت حالة الأيام في: ${opts.state}`);
    if (opts.save) {
      const file = opts.out || `cards-read-${stamp()}.txt`;
      try { fs.writeFileSync(file, text + '\n', { flag: 'wx' }); console.log(`حُفظ التقرير في: ${file}`); }
      catch (e) { console.log(e.code === 'EEXIST' ? `الملف موجود مسبقاً ولم يُستبدل: ${file}` : `تعذّر حفظ الملف: ${e.message}`); }
    }
    console.log('تذكير: عطّل خدمة API الآن من الراوتر (أنت من يفعل ذلك): /ip service disable api');
  } finally {
    await client.close();
  }
}

const techText = (t) => (Array.isArray(t)
  ? t.map((x) => (x && x.message) || JSON.stringify(x)).join('; ')
  : (t && typeof t === 'object' ? JSON.stringify(t) : String(t)));

main().catch((e) => {
  if (e instanceof RosError) {
    const d = diagnose(e);
    console.error(`فشلت القراءة [${d.code}]: ${d.message}`);
    if (d.technical && d.technical !== d.message) console.error('تفصيل: ' + techText(d.technical));
  } else if (e instanceof CardsError) {
    console.error(`فشلت القراءة [${e.code}]: ${e.message}`);
  } else {
    console.error(`خطأ: ${e.message}`);
  }
  console.error('لم يُكتب شيء في الراوتر، ولم يُحفظ تقرير أو حالة في هذه المحاولة.');
  process.exit(1);
});
