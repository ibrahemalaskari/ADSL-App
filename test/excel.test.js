// اختبارات استيراد/تصدير Excel على قالب المستخدم الفعلي (test/fixtures/template.xlsx).
// التحقق من أن Excel/WPS يفتح الملف وأن الصيغ تُحسب صحيحة خارج نطاق هذه الاختبارات (تُجرى يدوياً، انظر README).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readZip, extractEntry, makeEntry, writeZip, crc32 } from '../core/zip.js';
import { importWorkbook, exportMonth, mergeState, listMonths, serialToIso, isoToSerial, ExcelError, fixCardValueFormulas } from '../core/excel.js';
import { nodeCodec as codec } from '../core/node-codec.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = new Uint8Array(fs.readFileSync(path.join(here, 'fixtures', 'template.xlsx')));
const td = new TextDecoder();
const te = new TextEncoder();

const part = async (bytes, name) => {
  const e = readZip(bytes).find((x) => x.name === name);
  return e ? td.decode(await extractEntry(e, codec)) : null;
};
const rebuild = async (bytes, edits) => {
  const out = [];
  for (const e of readZip(bytes)) {
    if (edits[e.name]) out.push(await makeEntry(e.name, te.encode(edits[e.name](td.decode(await extractEntry(e, codec)))), codec, e));
    else out.push(e);
  }
  return writeZip(out);
};
const SHEET = 'xl/worksheets/sheet1.xml';

const STATE = {
  d: {
    '2026-08-01': { b: [85.7, 0, 20.26], s: 7700, p: 25.59, c: [17, 15, 8, 0, 1] },
    '2026-08-02': { b: [74.53, 0, 9.89], s: 7500 },
    '2026-08-03': { b: [60.48, 0, 48.4], o: [null, null, 11.6], s: 9000 },
    '2026-08-31': { b: [10, 0, 5], s: 100 },
  },
  op: { '2026-08': [100, 5, 30] },
};

test('crc32 يطابق القيمة المعيارية', () => {
  assert.equal(crc32(te.encode('123456789')), 0xCBF43926);
});

test('تحويل التواريخ: 45839 = 2025-07-01 والعكس', () => {
  assert.equal(serialToIso(45839), '2025-07-01');
  assert.equal(isoToSerial('2025-07-01'), 45839);
  assert.equal(isoToSerial('2026-08-03'), 46237); // قيمة B8 في الملف المُصدَّر والمفتوح بـ openpyxl
  assert.equal(isoToSerial('2026-08-31'), 46265);
});

test('استيراد القالب الفعلي: الفوارق اليدوية الخمس فقط، بلا بيانات مختلقة', async () => {
  const r = await importWorkbook(TEMPLATE, { codec });
  assert.deepEqual(r.months, ['2025-07']);
  assert.equal(r.stats.rowsWithDate, 31);
  assert.equal(r.stats.manualDiffs, 5);
  assert.deepEqual(r.state.d, {
    '2025-07-07': { o: [8.66, null, 5.96] },
    '2025-07-14': { o: [null, null, 3.48] },
    '2025-07-16': { o: [13.21, null, null] },
    '2025-07-19': { o: [null, null, 6.95] },
  });
  assert.deepEqual(r.state.op, {}); // C3:E3 فارغة: لا رصيد بداية مُختلق
  assert.deepEqual(r.warnings, []);
});

test('تصدير ثم استيراد يعيد الحالة نفسها (الأرصدة والفوارق اليدوية والمبيعات والكروت ورصيد البداية)', async () => {
  const out = await exportMonth(TEMPLATE, STATE, '2026-08', { codec });
  const back = await importWorkbook(out, { codec });
  assert.deepEqual(back.months, ['2026-08']);
  assert.deepEqual(back.state, STATE);
  assert.deepEqual(back.warnings, []);
});

test('التصدير بلا شهر يسأل: MONTH_REQUIRED مع قائمة الأشهر ولا ينتج ملفاً', async () => {
  const st = { d: { ...STATE.d, '2026-07-05': { s: 1 } }, op: {} };
  await assert.rejects(() => exportMonth(TEMPLATE, st, undefined, { codec }), (e) => {
    assert.ok(e instanceof ExcelError);
    assert.equal(e.code, 'MONTH_REQUIRED');
    assert.deepEqual(e.details.months, [{ key: '2026-07', days: 1 }, { key: '2026-08', days: 4 }]);
    return true;
  });
});

test('شهر بلا بيانات أو صيغة خاطئة => خطأ ولا ملف', async () => {
  await assert.rejects(() => exportMonth(TEMPLATE, STATE, '2026-09', { codec }), { code: 'NO_DATA' });
  await assert.rejects(() => exportMonth(TEMPLATE, STATE, '2026-13', { codec }), { code: 'MONTH_INVALID' });
  await assert.rejects(() => exportMonth(TEMPLATE, STATE, 'أغسطس', { codec }), { code: 'MONTH_INVALID' });
});

test('الصيغ خارج G6:I36 تبقى كما هي حرفياً، وW8 لم يُمسّ', async () => {
  const out = await exportMonth(TEMPLATE, STATE, '2026-08', { codec });
  const formulas = (xml) => {
    const m = new Map();
    for (const c of xml.matchAll(/<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g)) {
      if (c[2] === '/>') continue;
      const ref = /\sr="([A-Z]+)(\d+)"/.exec(c[1]);
      const f = /<f\b[^>]*?(?:\/>|>[^<]*<\/f>)/.exec(c[3]);
      if (!f) continue;
      if ('GHI'.includes(ref[1]) && Number(ref[2]) >= 6 && Number(ref[2]) <= 36) continue;
      m.set(ref[1] + ref[2], f[0]);
    }
    return m;
  };
  const before = formulas(await part(TEMPLATE, SHEET));
  const after = formulas(await part(out, SHEET));
  assert.equal(before.size, 170); // 258 صيغة في الورقة، منها 88 داخل G6:I36
  // الاستثناء الوحيد: ثابت الفئة 500 في R6 وR7 صار 2000 (قرار المستخدم ج13). كل ما عداه حرفياً كما هو.
  const expected = new Map(before);
  for (const r of ['R6', 'R7']) {
    const n = r.slice(1);
    assert.ok(expected.get(r).includes(`P${n}*1500`), r);
    expected.set(r, expected.get(r).replace(`P${n}*1500`, `P${n}*2000`));
  }
  assert.deepEqual([...after], [...expected]);
  assert.match(after.get('W8'), /SUM\(W6:W7\)/);
});

test('صيغة R: ثابت الفئة 500 صار 2000 في R6 وماستر R7، والثوابت الأخرى والمجموعة المشتركة كما هي (قرار ج13)', async () => {
  const out = await exportMonth(TEMPLATE, STATE, '2026-08', { codec });
  const xml = await part(out, SHEET);
  const cell = (ref) => new RegExp(`<c r="${ref}"[^>]*?(?:/>|>([\\s\\S]*?)</c>)`).exec(xml)[1];
  assert.equal(cell('R6'), '<f>(M6*300+N6*650+O6*800+P6*2000+Q6*5000)/1024</f>');
  assert.equal(cell('R7'), '<f t="shared" ref="R7:R36" si="3">(M7*300+N7*650+O7*800+P7*2000+Q7*5000)/1024</f>');
  assert.match(cell('R8'), /^<f t="shared" si="3" ?\/>$/);
  assert.equal(cell('T6'), '<f>J6-R6</f>');
  assert.ok(!/\*1500/.test(xml), 'لا بقايا لـ1500 في الورقة');
});

test('fixCardValueFormulas: لا يمسّ إلا صيغة R المطابقة حرفياً لصيغة القالب (ما عدّله المستخدم يبقى)', () => {
  const orig = '<c r="R6" s="1"><f>(M6*300+N6*650+O6*800+P6*1500+Q6*5000)/1024</f></c>';
  assert.equal(fixCardValueFormulas(orig), orig.replace('P6*1500', 'P6*2000'));
  const custom = '<c r="R6" s="1"><f>(M6*300+N6*650+O6*800+P6*1750+Q6*5000)/1024</f></c>';
  assert.equal(fixCardValueFormulas(custom), custom);
  const otherCol = '<c r="S6" s="1"><f>(M6*300+N6*650+O6*800+P6*1500+Q6*5000)/1024</f></c>';
  assert.equal(fixCardValueFormulas(otherCol), otherCol);
  const wrongRow = '<c r="R6" s="1"><f>(M7*300+N7*650+O7*800+P7*1500+Q7*5000)/1024</f></c>';
  assert.equal(fixCardValueFormulas(wrongRow), wrongRow);
  const shared = '<c r="R8" s="6"><f t="shared" si="3" /></c>';
  assert.equal(fixCardValueFormulas(shared), shared);
});

test('كتلة G6:I36: ثابت للفارق اليدوي وإلا الصيغة الأصلية، بلا صيغ مشتركة معلّقة', async () => {
  const out = await exportMonth(TEMPLATE, STATE, '2026-08', { codec });
  const xml = await part(out, SHEET);
  const cell = (ref) => new RegExp(`<c r="${ref}"[^>]*?(?:/>|>([\\s\\S]*?)</c>)`).exec(xml)[1];
  assert.equal(cell('G6'), '<f>C3-C6</f>');
  assert.equal(cell('H6'), '<f>D3-D6</f>');
  assert.equal(cell('G7'), '<f>C6-C7</f>');
  assert.equal(cell('I8'), '<v>11.6</v>'); // 2026-08-03 هو الصف 8
  assert.equal(cell('G8'), '<f>C7-C8</f>');
  assert.equal(cell('I36'), '<f>E35-E36</f>');
  assert.ok(!/si="4"/.test(xml), 'مجموعة الصيغ المشتركة G8:I36 يجب أن تُستبدل كلها');
  for (const ref of ['S6:S36', 'F7:F36', 'J7:J36', 'R7:R36', 'L37:T37']) assert.ok(xml.includes(`ref="${ref}"`), 'ماستر محفوظ: ' + ref);
});

test('لا قيم مخزّنة قديمة في خلايا الصيغ، وcalcChain محذوف مع إشاراته، وإعادة الحساب مفروضة', async () => {
  const out = await exportMonth(TEMPLATE, STATE, '2026-08', { codec });
  const xml = await part(out, SHEET);
  assert.equal([...xml.matchAll(/<c\b[^>]*?>((?:(?!<\/c>)[\s\S])*?)<\/c>/g)].filter((m) => /<f\b/.test(m[1]) && /<v>/.test(m[1])).length, 0);
  const names = readZip(out).map((e) => e.name);
  assert.ok(!names.includes('xl/calcChain.xml'));
  assert.ok(!(await part(out, '[Content_Types].xml')).includes('calcChain'));
  assert.ok(!(await part(out, 'xl/_rels/workbook.xml.rels')).includes('calcChain'));
  assert.match(await part(out, 'xl/workbook.xml'), /<calcPr[^>]*fullCalcOnLoad="1"/);
});

test('الأجزاء غير المعدّلة (الورقة الثانية والتنسيق والنصوص) مطابقة بايتاً للأصل', async () => {
  const out = await exportMonth(TEMPLATE, STATE, '2026-08', { codec });
  for (const n of ['xl/worksheets/sheet2.xml', 'xl/styles.xml', 'xl/sharedStrings.xml', 'xl/theme/theme1.xml', 'docProps/app.xml', 'docProps/core.xml']) {
    assert.equal(await part(out, n), await part(TEMPLATE, n), n);
  }
  assert.deepEqual(readZip(out)[0].name, '[Content_Types].xml');
});

test('طول الشهر: 28 و29 و30 و31 يوماً، والأيام الزائدة بلا تاريخ', async () => {
  const mk = (key, n) => ({ d: Object.fromEntries(Array.from({ length: n }, (_, i) => [`${key}-${String(i + 1).padStart(2, '0')}`, { s: i + 1 }])), op: {} });
  for (const [key, n] of [['2027-02', 28], ['2028-02', 29], ['2026-04', 30], ['2026-08', 31]]) {
    const back = await importWorkbook(await exportMonth(TEMPLATE, mk(key, n), key, { codec }), { codec });
    assert.equal(back.stats.rowsWithDate, n, key);
    assert.equal(Object.keys(back.state.d).length, n, key);
    assert.deepEqual(back.months, [key]);
  }
});

test('قيم القالب القديمة (الفوارق اليدوية الخمس) لا تتسرب إلى شهر جديد', async () => {
  const st = { d: { '2026-08-01': { b: [1, 2, 3] } }, op: {} };
  const back = await importWorkbook(await exportMonth(TEMPLATE, st, '2026-08', { codec }), { codec });
  assert.deepEqual(back.state.d, { '2026-08-01': { b: [1, 2, 3] } });
  assert.equal(back.stats.manualDiffs, 0);
});

test('قيمة غير رقمية في الحالة => EXCEL_VALUE ولا ملف', async () => {
  const st = { d: { '2026-08-01': { b: ['abc', 0, 0] } }, op: {} };
  await assert.rejects(() => exportMonth(TEMPLATE, st, '2026-08', { codec }), { code: 'EXCEL_VALUE' });
});

test('تغيّر عناوين الأعمدة => EXCEL_STRUCTURE (لا تخمين)', async () => {
  const bad = await rebuild(TEMPLATE, { 'xl/sharedStrings.xml': (x) => x.replace('رصيد  Adsl  4M', 'رصيد آخر') });
  await assert.rejects(() => importWorkbook(bad, { codec }), { code: 'EXCEL_STRUCTURE' });
  await assert.rejects(() => exportMonth(bad, STATE, '2026-08', { codec }), { code: 'EXCEL_STRUCTURE' });
});

test('نص في خلية رقمية => تحذير وتجاهل، وليس صفراً', async () => {
  const bad = await rebuild(TEMPLATE, { [SHEET]: (x) => x.replace('<c r="C6" s="22" />', '<c r="C6" s="22" t="inlineStr"><is><t>abc</t></is></c>') });
  const r = await importWorkbook(bad, { codec });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /C6/);
  assert.ok(!r.state.d['2025-07-01']);
});

test('مجموعة صيغ مشتركة تتجاوز G6:I36 => EXCEL_SHARED ولا تعديل', async () => {
  const bad = await rebuild(TEMPLATE, { [SHEET]: (x) => x.replace('ref="G8:I36"', 'ref="G8:J36"') });
  await assert.rejects(() => exportMonth(bad, STATE, '2026-08', { codec }), { code: 'EXCEL_SHARED' });
});

test('ملف ليس xlsx => ZIP_INVALID', async () => {
  await assert.rejects(() => importWorkbook(te.encode('not a zip file at all, just text'), { codec }), { code: 'ZIP_INVALID' });
});

test('الدمج: بلا تكرار ولا حذف ولا استبدال، ويُبلَّغ عن التعارض، والأصل لا يتغير', () => {
  const base = { d: { '2026-08-01': { b: [10, 0, 5], s: 100 }, '2026-07-31': { s: 1 } }, op: {}, vn: { 0: 'x' } };
  const snap = JSON.stringify(base);
  const inc = { d: { '2026-08-01': { b: [10, 7, 6], s: 200, p: 3 }, '2026-08-02': { s: 5 } }, op: { '2026-08': [1, 2, 3] } };
  const { state, report } = mergeState(base, inc);
  assert.equal(JSON.stringify(base), snap);
  assert.deepEqual(Object.keys(state.d).sort(), ['2026-07-31', '2026-08-01', '2026-08-02']);
  assert.deepEqual(state.d['2026-08-01'].b, [10, 0, 5]); // 0≠7 و5≠6: تعارضان، تبقى القيم الموجودة
  assert.equal(report.conflicts.length, 3); // b[1] وb[2] وs
  assert.equal(state.vn[0], 'x');
  assert.equal(report.daysAdded, 1);
  assert.equal(state.d['2026-08-01'].s, 100); // لم يُستبدل
  assert.equal(state.d['2026-08-01'].p, 3);   // كُمِّل
  assert.deepEqual(state.op['2026-08'], [1, 2, 3]);
  const again = mergeState(state, inc).state;
  assert.deepEqual(again, state); // إعادة الدمج لا تغيّر شيئاً (لا تكرار)
  assert.equal(mergeState(base, inc, { onConflict: 'replace' }).state.d['2026-08-01'].s, 200);
});

test('listMonths يعدّ الأيام لكل شهر ويتجاهل المفاتيح غير التاريخية', () => {
  assert.deepEqual(listMonths({ d: { '2026-08-01': {}, '2026-08-02': {}, 'x': {}, '2026-09-01': {} } }), [{ key: '2026-08', days: 2 }, { key: '2026-09', days: 1 }]);
  assert.deepEqual(listMonths({}), []);
});

test('أداة سطر الأوامر: استيراد ثم تصدير يسأل عن الشهر ولا يستبدل ملفاً موجوداً', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adslcli-'));
  const cli = path.join(here, '..', 'tools', 'excel-cli.mjs');
  const tpl = path.join(here, 'fixtures', 'template.xlsx');
  const stateFile = path.join(dir, 'state.json');
  let r = spawnSync('node', [cli, 'import', tpl, stateFile], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /فوارق يدوية: 5/);
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(Object.keys(st.d).length, 4);
  // استيراد ثانٍ لنفس الملف: لا أيام جديدة (بلا تكرار) ونسخة احتياطية
  r = spawnSync('node', [cli, 'import', tpl, stateFile], { encoding: 'utf8' });
  assert.match(r.stdout, /أيام جديدة 0/);
  assert.ok(fs.existsSync(stateFile + '.bak'));
  // تصدير: يسأل، نجيب 1
  const out = path.join(dir, 'july.xlsx');
  r = spawnSync('node', [cli, 'export', tpl, stateFile, out], { encoding: 'utf8', input: '1\n' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /أي شهر تريد تصديره/);
  assert.ok(fs.existsSync(out));
  // الملف الموجود لا يُستبدل
  r = spawnSync('node', [cli, 'export', tpl, stateFile, out], { encoding: 'utf8', input: '1\n' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /لم يُستبدل/);
  // اختيار غير صالح => لا ملف
  const out2 = path.join(dir, 'x.xlsx');
  r = spawnSync('node', [cli, 'export', tpl, stateFile, out2], { encoding: 'utf8', input: '9\n' });
  assert.equal(r.status, 1);
  assert.ok(!fs.existsSync(out2));
  fs.rmSync(dir, { recursive: true, force: true });
});
