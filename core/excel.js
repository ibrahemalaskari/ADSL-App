// استيراد وتصدير ملف Excel (الورقة الأولى فقط). بنية الملف في CLAUDE.md القسم 3.
//
// الاستيراد: يقرأ القيم فقط. رقم ثابت في G:I = فارق يدوي، والصيغة = فارق محسوب (يُتجاهل).
//   الخلية الفارغة = null وليست 0. القيمة غير الرقمية تُتجاهل مع تحذير ولا تُحوَّل إلى 0.
// التصدير: يعدّل XML الورقة مباشرة. يكتب فقط في خلايا الإدخال، وتبقى كل الصيغ كما هي
//   عدا كتلة G6:I36 التي تُعاد كتابتها صيغةً صيغةً (ثابت للفارق اليدوي، وإلا الصيغة الأصلية نفسها)،
//   وعدا ثابت الفئة 500 في صيغة العمود R (1500 ← 2000، قرار المستخدم ج13؛ انظر fixCardValueFormulas).
//   الورقة الثانية والأجزاء الأخرى تُنسخ بلا تغيير. calcChain يُحذف ويُفرض إعادة الحساب عند الفتح.
// بلا اعتماديات: الضغط عبر codec (انظر zip.js).

import { readZip, extractEntry, makeEntry, writeZip } from './zip.js';

const td = new TextDecoder('utf-8');
const te = new TextEncoder();

export class ExcelError extends Error {
  constructor(code, message, details) { super(message); this.name = 'ExcelError'; this.code = code; this.details = details; }
}

export const LAYOUT = Object.freeze({
  headerRow: 5, firstRow: 6, lastRow: 36, openingRow: 3,
  balanceCols: ['C', 'D', 'E'], diffCols: ['G', 'H', 'I'], salesCol: 'K', programCol: 'L',
  cardCols: ['M', 'N', 'O', 'P', 'Q'],
});

// الأعمدة التي نقرأها أو نكتبها فقط (بعد توحيد المسافات). غيّرها ⇒ نرفض الملف بدل التخمين.
const REQUIRED_HEADERS = {
  B: 'التاريخ', C: 'رصيد Adsl 8M', D: 'رصيد الفورجي', E: 'رصيد Adsl 4M',
  G: 'فارق Adsl', H: 'فارق الفورجي', I: 'فارق 4M', K: 'المبيعات', L: 'الرصيد المستهلك في البرنامج',
  M: 'عدد الكروت ابو 100', N: 'عدد الكروت ابو 200', O: 'عدد الكروت ابو 250',
  P: 'عدد الكروت ابو 500', Q: 'عدد الكروت ابو 1000',
};

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const pad2 = (n) => String(n).padStart(2, '0');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const colIdx = (L) => { let n = 0; for (const ch of L) n = n * 26 + ch.charCodeAt(0) - 64; return n; };

function unescapeXml(s) {
  return s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g, (m, g) => {
    if (g === 'lt') return '<'; if (g === 'gt') return '>'; if (g === 'quot') return '"';
    if (g === 'apos') return "'"; if (g === 'amp') return '&';
    return String.fromCodePoint(g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10));
  });
}

function attr(tag, name) {
  const m = new RegExp('\\s' + name.replace(':', '\\:') + '="([^"]*)"').exec(tag);
  return m ? unescapeXml(m[1]) : null;
}

// ---------- التواريخ ----------
const epochOf = (d1904) => (d1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30));
export function serialToIso(n, d1904 = false) {
  return new Date(epochOf(d1904) + Math.floor(n) * 864e5).toISOString().slice(0, 10);
}
export function isoToSerial(iso, d1904 = false) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - epochOf(d1904)) / 864e5);
}
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// ---------- فتح الحزمة ----------
async function openPackage(bytes, codec) {
  if (!codec) throw new ExcelError('NO_CODEC', 'لم يُمرَّر codec للضغط (core/node-codec.js في Node).');
  const entries = readZip(bytes);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const read = async (name, required = true) => {
    const e = byName.get(name);
    if (!e) { if (required) throw new ExcelError('EXCEL_STRUCTURE', 'الملف لا يحوي الجزء المطلوب: ' + name); return null; }
    return td.decode(await extractEntry(e, codec));
  };
  const wb = await read('xl/workbook.xml');
  const rels = await read('xl/_rels/workbook.xml.rels');
  const sheetTag = /<sheet\b[^>]*>/.exec(wb);
  if (!sheetTag) throw new ExcelError('EXCEL_STRUCTURE', 'لا توجد أوراق في الملف');
  const rid = attr(sheetTag[0], 'r:id');
  let target = null;
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) if (attr(m[0], 'Id') === rid) target = attr(m[0], 'Target');
  if (!target) throw new ExcelError('EXCEL_STRUCTURE', 'تعذر تحديد مسار الورقة الأولى');
  const sheetPath = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
  const pr = /<workbookPr\b[^>]*>/.exec(wb);
  const date1904 = !!pr && ['1', 'true'].includes(attr(pr[0], 'date1904'));
  return { entries, byName, read, codec, sheetPath, sheetName: attr(sheetTag[0], 'name'), date1904, wb, rels };
}

async function readSharedStrings(pkg) {
  const xml = await pkg.read('xl/sharedStrings.xml', false);
  if (!xml) return [];
  const out = [];
  for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const body = m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    let s = '';
    for (const t of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) s += unescapeXml(t[1]);
    out.push(s);
  }
  return out;
}

const CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
function parseCellMatch(m) {
  const attrs = m[1], inner = m[2] || '';
  const ref = attr(attrs, 'r');
  const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
  const im = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner);
  let is = null;
  if (im) { is = ''; for (const t of im[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) is += unescapeXml(t[1]); }
  return {
    ref, t: attr(attrs, 't'), hasF: /<f\b/.test(inner),
    v: vm && vm[1] !== '' ? vm[1] : null, is,
    rest: attrs.replace(/\sr="[^"]*"/, '').replace(/\st="[^"]*"/, '').replace(/\/\s*$/, '').trimEnd(),
    inner,
  };
}

function parseSheetCells(xml) {
  const cells = new Map();
  for (const m of xml.matchAll(CELL_RE)) { const c = parseCellMatch(m); if (c.ref) cells.set(c.ref, c); }
  return cells;
}

function cellValue(c, sst) {
  if (!c) return null;
  if (c.t === 'inlineStr') return c.is;
  if (c.v === null) return null;
  switch (c.t) {
    case 's': return sst[Number(c.v)] ?? null;
    case 'str': return unescapeXml(c.v);
    case 'b': return c.v === '1';
    case 'e': return { error: c.v };
    default: { const n = Number(c.v); return Number.isFinite(n) ? n : null; }
  }
}

function checkHeaders(cells, sst) {
  const bad = [];
  for (const [col, want] of Object.entries(REQUIRED_HEADERS)) {
    const got = cellValue(cells.get(col + LAYOUT.headerRow), sst);
    if (typeof got !== 'string' || norm(got) !== want) bad.push({ cell: col + LAYOUT.headerRow, expected: want, found: got });
  }
  if (bad.length) {
    throw new ExcelError('EXCEL_STRUCTURE',
      'بنية الورقة الأولى لا تطابق القالب المعتمد (العناوين في الصف 5). ' +
      bad.slice(0, 3).map((b) => `${b.cell}: المتوقع «${b.expected}» والموجود «${b.found ?? 'فارغ'}»`).join('؛ '), bad);
  }
}

// ---------- الاستيراد ----------
function readNumber(cell, ref, sst, warnings) {
  if (!cell) return null;
  const v = cellValue(cell, sst);
  if (v === null) return null;
  if (isNum(v)) {
    if (cell.hasF) warnings.push(`${ref}: خلية إدخال تحوي صيغة، أُخذت قيمتها المخزّنة ${v}`);
    return v;
  }
  warnings.push(`${ref}: قيمة غير رقمية «${typeof v === 'string' ? v : 'خطأ'}» تم تجاهلها`);
  return null;
}

export async function importWorkbook(bytes, { codec } = {}) {
  const pkg = await openPackage(bytes, codec);
  const sst = await readSharedStrings(pkg);
  const cells = parseSheetCells(await pkg.read(pkg.sheetPath));
  checkHeaders(cells, sst);

  const warnings = [];
  const d = {};
  const months = new Set();
  let firstMonth = null, rowsWithDate = 0, manualDiffs = 0;

  for (let r = LAYOUT.firstRow; r <= LAYOUT.lastRow; r++) {
    const dv = cellValue(cells.get('B' + r), sst);
    const rd = (col) => readNumber(cells.get(col + r), col + r, sst, warnings);
    if (!isNum(dv)) {
      const stray = [...LAYOUT.balanceCols, LAYOUT.salesCol, LAYOUT.programCol, ...LAYOUT.cardCols].some((c) => cells.get(c + r) && cellValue(cells.get(c + r), sst) !== null);
      if (stray) warnings.push(`الصف ${r}: توجد بيانات بلا تاريخ صالح في العمود B، تم تجاهل الصف`);
      continue;
    }
    rowsWithDate++;
    const iso = serialToIso(dv, pkg.date1904);
    months.add(iso.slice(0, 7));
    if (!firstMonth) firstMonth = iso.slice(0, 7);

    const b = LAYOUT.balanceCols.map(rd);
    const o = LAYOUT.diffCols.map((col) => {
      const c = cells.get(col + r);
      if (!c || c.hasF) return null; // صيغة = فارق محسوب
      const v = cellValue(c, sst);
      if (v === null) return null;
      if (isNum(v)) return v;
      warnings.push(`${col}${r}: قيمة غير رقمية «${typeof v === 'string' ? v : 'خطأ'}» في عمود الفوارق تم تجاهلها`);
      return null;
    });
    const s = rd(LAYOUT.salesCol), p = rd(LAYOUT.programCol);
    const c = LAYOUT.cardCols.map((col) => {
      const v = rd(col);
      if (v !== null && !Number.isInteger(v)) { warnings.push(`${col}${r}: عدد كروت غير صحيح (${v})، قُطع إلى ${Math.trunc(v)}`); return Math.trunc(v); }
      return v;
    });
    const entry = {};
    if (b.some((x) => x !== null)) entry.b = b;
    if (o.some((x) => x !== null)) { entry.o = o; manualDiffs += o.filter((x) => x !== null).length; }
    if (s !== null) entry.s = s;
    if (p !== null) entry.p = p;
    if (c.some((x) => x !== null)) entry.c = c;
    if (Object.keys(entry).length) d[iso] = entry;
  }

  const op = {};
  const opening = LAYOUT.balanceCols.map((col) => readNumber(cells.get(col + LAYOUT.openingRow), col + LAYOUT.openingRow, sst, warnings));
  if (opening.some((x) => x !== null)) {
    if (firstMonth) op[firstMonth] = opening;
    else warnings.push('رصيد بداية الشهر موجود لكن لا توجد تواريخ، تم تجاهله');
  }
  return {
    sheetName: pkg.sheetName,
    months: [...months].sort(),
    state: { d, op },
    warnings,
    stats: { rowsWithDate, daysImported: Object.keys(d).length, manualDiffs, openingFound: Object.keys(op).length > 0 },
  };
}

// ---------- الدمج بلا تكرار ولا حذف ----------
export function listMonths(state) {
  const cnt = {};
  for (const k of Object.keys((state && state.d) || {})) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(k)) cnt[k.slice(0, 7)] = (cnt[k.slice(0, 7)] || 0) + 1;
  }
  return Object.keys(cnt).sort().map((key) => ({ key, days: cnt[key] }));
}

// يدمج incoming في base دون تعديل base. القيم الموجودة لا تُستبدل إلا بـ onConflict:'replace'.
export function mergeState(base, incoming, { onConflict = 'keep' } = {}) {
  const out = { ...base, d: { ...((base && base.d) || {}) }, op: { ...((base && base.op) || {}) } };
  const rep = { daysAdded: 0, valuesFilled: 0, valuesSame: 0, conflicts: [] };
  const mv = (cur, inc, where) => {
    if (inc === null || inc === undefined) return cur;
    if (cur === null || cur === undefined) { rep.valuesFilled++; return inc; }
    if (cur === inc) { rep.valuesSame++; return cur; }
    rep.conflicts.push({ where, current: cur, incoming: inc });
    return onConflict === 'replace' ? inc : cur;
  };
  const mergeArr = (cur, inc, where) => {
    const n = Math.max((cur || []).length, (inc || []).length);
    return Array.from({ length: n }, (_, i) => mv(cur ? cur[i] : null, inc ? inc[i] : null, `${where}[${i}]`));
  };
  for (const [k, inc] of Object.entries((incoming && incoming.d) || {})) {
    const cur = out.d[k];
    if (!cur) { out.d[k] = JSON.parse(JSON.stringify(inc)); rep.daysAdded++; continue; }
    const m = { ...cur };
    for (const f of ['b', 'o', 'c']) if (inc[f]) m[f] = mergeArr(cur[f], inc[f], `${k}.${f}`);
    for (const f of ['s', 'p']) if (inc[f] !== undefined) m[f] = mv(cur[f], inc[f], `${k}.${f}`);
    out.d[k] = m;
  }
  for (const [k, inc] of Object.entries((incoming && incoming.op) || {})) {
    out.op[k] = out.op[k] ? mergeArr(out.op[k], inc, `op.${k}`) : [...inc];
  }
  return { state: out, report: rep };
}

// ---------- التصدير ----------
function parseRows(inner) {
  const rows = [];
  for (const m of inner.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = Number(attr(m[1], 'r'));
    if (!Number.isInteger(r)) throw new ExcelError('EXCEL_STRUCTURE', 'صف بلا رقم في الورقة');
    rows.push({ r, raw: m[0], attrs: m[1].replace(/\/\s*$/, ''), cells: null });
  }
  return rows;
}

function loadCells(row) {
  if (row.cells) return;
  row.cells = [];
  const body = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/.exec(row.raw)[1] || '';
  for (const m of body.matchAll(CELL_RE)) {
    const c = parseCellMatch(m);
    row.cells.push({ col: c.ref.replace(/\d+/, ''), rest: c.rest, inner: c.inner, t: c.t });
  }
}

function serializeRow(row) {
  const cs = row.cells.map((c) => {
    const rest = c.rest ? (c.rest.startsWith(' ') ? c.rest : ' ' + c.rest) : '';
    const t = c.t ? ` t="${c.t}"` : '';
    return c.inner ? `<c r="${c.col}${row.r}"${rest}${t}>${c.inner}</c>` : `<c r="${c.col}${row.r}"${rest}${t}/>`;
  }).join('');
  return cs ? `<row${row.attrs}>${cs}</row>` : `<row${row.attrs}/>`;
}

function range(ref) {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(ref);
  return { c1: colIdx(m[1]), r1: Number(m[2]), c2: colIdx(m[3] || m[1]), r2: Number(m[4] || m[2]) };
}

// كتلة G6:I36 ستُعاد كتابتها كلها؛ يجب ألا تتقاطع مع مجموعة صيغ مشتركة تمتد خارجها.
function assertSharedGroupsSafe(xml) {
  const B = { c1: colIdx('G'), r1: LAYOUT.firstRow, c2: colIdx('I'), r2: LAYOUT.lastRow };
  for (const m of xml.matchAll(/<f\b[^>]*\bt="shared"[^>]*\bref="([^"]+)"[^>]*>/g)) {
    const g = range(m[1]);
    const overlap = g.c1 <= B.c2 && g.c2 >= B.c1 && g.r1 <= B.r2 && g.r2 >= B.r1;
    const inside = g.c1 >= B.c1 && g.c2 <= B.c2 && g.r1 >= B.r1 && g.r2 <= B.r2;
    if (overlap && !inside) {
      throw new ExcelError('EXCEL_SHARED', `مجموعة صيغ مشتركة (${m[1]}) تتقاطع مع G6:I36 وتمتد خارجها؛ لم يُعدَّل الملف حفظاً للصيغ.`);
    }
  }
}

// قرار المستخدم (ج13): ثابت الفئة 500 في صيغة R (قيمة الكروت) صار 2000 بدل 1500، فيكتب المصدِّر الصيغة بـ2000.
// لا تُعدَّل إلا خلية في العمود R نصُّ صيغتها مطابق حرفياً لصيغة القالب الأصلية؛ أي صيغة أخرى (عدّلها المستخدم) تبقى كما هي.
// الخلايا التابعة لصيغة مشتركة (<f t="shared" si="3"/>) بلا نص، وتتبع نص الماستر (R7) تلقائياً.
export function fixCardValueFormulas(body) {
  return body.replace(/(<c\b[^>]*?\sr="R(\d+)"[^>]*?>\s*<f\b[^>]*?>)([^<]*)(<\/f>)/g, (m, pre, row, f, post) => {
    const old = `(M${row}*300+N${row}*650+O${row}*800+P${row}*1500+Q${row}*5000)/1024`;
    return f === old ? `${pre}${old.replace(`P${row}*1500`, `P${row}*2000`)}${post}` : m;
  });
}

function editSheet(xml, state, monthKey, d1904) {
  assertSharedGroupsSafe(xml);
  const i0 = xml.indexOf('<sheetData>'), i1 = xml.indexOf('</sheetData>');
  if (i0 < 0 || i1 < 0) throw new ExcelError('EXCEL_STRUCTURE', 'تعذر العثور على بيانات الورقة');
  const head = xml.slice(0, i0 + 11), tail = xml.slice(i1);
  const rows = parseRows(xml.slice(i0 + 11, i1));
  const [y, mo] = monthKey.split('-').map(Number);
  const N = daysInMonth(y, mo);

  const getRow = (r, create) => {
    let row = rows.find((x) => x.r === r);
    if (!row && create) {
      row = { r, raw: '', attrs: ` r="${r}"`, cells: [] };
      const at = rows.findIndex((x) => x.r > r);
      rows.splice(at < 0 ? rows.length : at, 0, row);
    }
    if (row) loadCells(row);
    return row;
  };
  const row6 = getRow(LAYOUT.firstRow);
  if (!row6) throw new ExcelError('EXCEL_STRUCTURE', 'الصف 6 غير موجود في الورقة');
  const styleOf = (col) => { const c = row6.cells.find((x) => x.col === col); return c ? c.rest : ''; };
  const cellAt = (row, col) => {
    let c = row.cells.find((x) => x.col === col);
    if (!c) {
      c = { col, rest: styleOf(col), inner: '', t: null };
      const at = row.cells.findIndex((x) => colIdx(x.col) > colIdx(col));
      row.cells.splice(at < 0 ? row.cells.length : at, 0, c);
    }
    return c;
  };
  const setNum = (row, col, v) => { const c = cellAt(row, col); c.t = null; c.inner = `<v>${String(v)}</v>`; };
  const setFormula = (row, col, f) => { const c = cellAt(row, col); c.t = null; c.inner = `<f>${f}</f>`; };
  const clear = (row, col) => { const c = row.cells.find((x) => x.col === col); if (c) { c.t = null; c.inner = ''; } };
  const put = (row, col, v, where) => {
    if (v === null || v === undefined || v === '') return clear(row, col);
    if (!isNum(v)) throw new ExcelError('EXCEL_VALUE', `قيمة غير رقمية في ${where}: ${JSON.stringify(v)}`);
    setNum(row, col, v);
  };

  // رصيد بداية الشهر
  const opening = (state.op && state.op[monthKey]) || [];
  const hasOpening = opening.some((x) => x !== null && x !== undefined && x !== '');
  let createdRow3 = false;
  if (hasOpening || getRow(LAYOUT.openingRow)) {
    const existed = !!getRow(LAYOUT.openingRow);
    const r3 = getRow(LAYOUT.openingRow, true);
    createdRow3 = !existed;
    LAYOUT.balanceCols.forEach((col, i) => put(r3, col, opening[i], `${col}${LAYOUT.openingRow} (${monthKey})`));
  }

  for (let r = LAYOUT.firstRow; r <= LAYOUT.lastRow; r++) {
    const day = r - LAYOUT.firstRow + 1;
    const row = getRow(r);
    if (!row) throw new ExcelError('EXCEL_STRUCTURE', `الصف ${r} غير موجود في الورقة`);
    const key = `${monthKey}-${pad2(day)}`;
    const e = day <= N ? (state.d && state.d[key]) || {} : {};
    if (day <= N) setNum(row, 'B', isoToSerial(key, d1904)); else clear(row, 'B');
    LAYOUT.balanceCols.forEach((col, i) => put(row, col, e.b && e.b[i], `${col}${r} (${key})`));
    put(row, LAYOUT.salesCol, e.s, `K${r} (${key})`);
    put(row, LAYOUT.programCol, e.p, `L${r} (${key})`);
    LAYOUT.cardCols.forEach((col, i) => put(row, col, e.c && e.c[i], `${col}${r} (${key})`));
    LAYOUT.diffCols.forEach((col, i) => {
      const man = e.o && e.o[i];
      if (man !== null && man !== undefined && man !== '') put(row, col, man, `${col}${r} (${key})`);
      else { const src = LAYOUT.balanceCols[i]; setFormula(row, col, `${src}${r === LAYOUT.firstRow ? LAYOUT.openingRow : r - 1}-${src}${r}`); }
    });
  }

  let body = rows.map((x) => (x.cells ? serializeRow(x) : x.raw)).join('');
  // القيم المخزّنة القديمة للصيغ لم تعد صحيحة: تُحذف ويُعاد الحساب عند فتح الملف.
  body = body.replace(/<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g, (m, a, end, inner) => {
    if (end === '/>' || !/<f\b/.test(inner)) return m;
    return `<c${a.replace(/\st="[^"]*"/, '')}>${inner.replace(/<v>[\s\S]*?<\/v>/, '')}</c>`;
  });
  body = fixCardValueFormulas(body);
  let out = head + body + tail;
  if (createdRow3) out = out.replace(/(<dimension ref=")([A-Z]+)(\d+)(:[A-Z]+\d+")/, (m, a, c, r, z) => a + c + Math.min(Number(r), LAYOUT.openingRow) + z);
  return out;
}

function forceRecalc(wb) {
  if (/<calcPr\b/.test(wb)) {
    return wb.replace(/<calcPr\b([^>]*?)(\/?)>/, (m, a, sl) => `<calcPr${a.replace(/\sfullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"${sl}>`);
  }
  const tag = '<calcPr fullCalcOnLoad="1"/>';
  return wb.includes('<extLst') ? wb.replace('<extLst', tag + '<extLst') : wb.replace('</workbook>', tag + '</workbook>');
}

// يصدّر شهراً واحداً إلى نسخة من القالب. monthKey = 'YYYY-MM'. بلا monthKey يُرمى MONTH_REQUIRED
// ومعه قائمة الأشهر المتاحة (details.months) لتسأل الواجهة المستخدم أي شهر يريد.
export async function exportMonth(templateBytes, state, monthKey, { codec } = {}) {
  const months = listMonths(state);
  if (!monthKey) throw new ExcelError('MONTH_REQUIRED', 'اختر الشهر المراد تصديره.', { months });
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) throw new ExcelError('MONTH_INVALID', 'صيغة الشهر يجب أن تكون YYYY-MM', { months });
  if (!months.some((m) => m.key === monthKey)) throw new ExcelError('NO_DATA', `لا توجد بيانات مسجلة لشهر ${monthKey}، لم يُنشأ ملف.`, { months });

  const pkg = await openPackage(templateBytes, codec);
  const sst = await readSharedStrings(pkg);
  const sheetXml = await pkg.read(pkg.sheetPath);
  checkHeaders(parseSheetCells(sheetXml), sst);

  const newSheet = editSheet(sheetXml, state, monthKey, pkg.date1904);

  const out = [];
  for (const e of pkg.entries) {
    if (e.name === 'xl/calcChain.xml') continue;
    if (e.name === pkg.sheetPath) out.push(await makeEntry(e.name, te.encode(newSheet), codec, e));
    else if (e.name === 'xl/workbook.xml') out.push(await makeEntry(e.name, te.encode(forceRecalc(pkg.wb)), codec, e));
    else if (e.name === 'xl/_rels/workbook.xml.rels') out.push(await makeEntry(e.name, te.encode(pkg.rels.replace(/<Relationship\b[^>]*?calcChain[^>]*?\/>/g, '')), codec, e));
    else if (e.name === '[Content_Types].xml') {
      const ct = await pkg.read(e.name);
      out.push(await makeEntry(e.name, te.encode(ct.replace(/<Override\b[^>]*?calcChain[^>]*?\/>/g, '')), codec, e));
    } else out.push(e);
  }
  return writeZip(out);
}
