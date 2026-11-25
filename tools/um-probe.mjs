#!/usr/bin/env node
// أداة فحص اليوزر مانجر في Termux — قراءة فقط (أوامر print فقط).
//   node tools/um-probe.mjs [عنوان_الراوتر] [اسم_المستخدم] [--full-sample] [--port 8728] [--out ملف.txt] [--no-save]
// كلمة المرور تُسأل دائماً بإدخال مخفي (أو من المتغير ROS_PASS)، ولا تُقبل كمعامل في الأمر.
// الناتج يُطبع ويُحفظ في um-probe-<وقت>.txt (لا يستبدل ملفاً موجوداً). التقرير لا يحتوي أسماء
// مستخدمين ولا كلمات مرور ولا عناوين. الأداة لا تغيّر أي إعداد في الراوتر.

import fs from 'node:fs';
import readline from 'node:readline/promises';
import { RouterOSClient, RosError, diagnose } from '../core/routeros-api.js';
import { probeUserManager, SAMPLE_SIZE } from '../core/usermanager.js';
import { NetTransport } from './net-transport.mjs';

function parseArgs(argv) {
  const o = { pos: [], fullSample: false, port: 8728, out: null, save: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--full-sample') o.fullSample = true;
    else if (a === '--no-save') o.save = false;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--out') o.out = argv[++i];
    else if (a.startsWith('--')) throw new Error(`خيار غير معروف: ${a}`);
    else o.pos.push(a);
  }
  if (!Number.isInteger(o.port)) throw new Error('رقم المنفذ غير صالح');
  return o;
}

function usage() {
  console.log(`الاستعمال:
  node tools/um-probe.mjs [العنوان] [المستخدم] [الخيارات]
الخيارات:
  --full-sample   يقرأ كل صفوف المستخدمين بكل حقولها (وفيها كلمات المرور) ويُهمل القيم فوراً؛ لا تستعمله إلا إن فشل الوضع العادي
  --port N        المنفذ (الافتراضي 8728؛ المسموح 8728 و8729 فقط)
  --out ملف       اسم ملف التقرير (الافتراضي um-probe-<وقت>.txt)
  --no-save       لا يحفظ ملفاً`);
}

// إدخال مخفي (بلا صدى). في بيئة غير تفاعلية يقرأ سطراً عادياً.
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    if (!stdin.isTTY) {
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (d) => { buf += d; if (buf.includes('\n')) { stdin.pause(); resolve(buf.split('\n')[0].replace(/\r$/, '')); } });
      stdin.on('end', () => resolve(buf));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let s = '';
    const finish = (fn, val) => { stdin.removeListener('data', onData); stdin.setRawMode(false); stdin.pause(); process.stdout.write('\n'); fn(val); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish(resolve, s);
        if (ch === '\u0003') return finish(reject, new Error('أُلغيت العملية'));
        if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1);
        else s += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const stamp = () => {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { usage(); return; }

  console.log('فحص اليوزر مانجر — قراءة فقط. لن يُغيَّر شيء في الراوتر.');
  console.log(`سيُقرأ عدد الصفوف أولاً، ثم عيّنة من ${SAMPLE_SIZE} مستخدمين كحد أقصى لاكتشاف أسماء الحقول (وفيها كلمات مرورهم، تُهمَل فوراً ولا تُحفظ ولا تُعرض).`);

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

  const client = new RouterOSClient(new NetTransport(), { timeoutMs: 10000 }); // readOnly افتراضياً
  try {
    await client.connect({ host, port: opts.port });
    await client.login(user, pass);
    const { text } = await probeUserManager(client, { fullSample: opts.fullSample, secrets: [pass] });
    console.log('\n' + text + '\n');
    if (opts.save) {
      const file = opts.out || `um-probe-${stamp()}.txt`;
      try { fs.writeFileSync(file, text + '\n', { flag: 'wx' }); console.log(`حُفظ التقرير في: ${file}`); }
      catch (e) { console.log(e.code === 'EEXIST' ? `الملف موجود مسبقاً ولم يُستبدل: ${file}` : `تعذّر حفظ الملف: ${e.message}`); }
    }
    console.log('تذكير: عطّل خدمة API الآن من الراوتر (أنت من يفعل ذلك): /ip service disable api');
  } finally {
    await client.close();
  }
}

// تفاصيل تقنية مقروءة (قد تكون نصاً أو مصفوفة رسائل trap من الراوتر)
const techText = (t) => (Array.isArray(t)
  ? t.map((x) => (x && x.message) || JSON.stringify(x)).join('; ')
  : (t && typeof t === 'object' ? JSON.stringify(t) : String(t)));

main().catch((e) => {
  if (e instanceof RosError) {
    const d = diagnose(e);
    console.error(`فشل الفحص [${d.code}]: ${d.message}`);
    if (d.technical && d.technical !== d.message) console.error('تفصيل: ' + techText(d.technical));
  } else {
    console.error(`خطأ: ${e.message}`); // مثل خيار غير معروف أو إلغاء المستخدم
  }
  console.error('لم يُكتب شيء في الراوتر ولم يُحفظ تقرير.');
  process.exit(1);
});
