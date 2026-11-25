// النسخ الاحتياطي والاستعادة (ج17). منطق نقي: بلا ملفات ولا تخزين ولا واجهة ولا اعتماديات.
// القراءة والكتابة الفعلية للملفات تتم خارج هذه الوحدة (tools/backup-cli.mjs الآن، وتطبيق أندرويد لاحقاً).
//
// المحتوى: state (بنية الواجهة {d, op, vn}، وتشمل حقول الكروت lb/lp/lr/lx)، وsettings (إعدادات بسيطة)، وlog (لقطة core/oplog.js).
// لا يشمل: عدّادات RX/TX (دورها لم يُحسم، CLAUDE.md §2.1)، ولا كلمات المرور ولا الأسرار.
//
// القواعد (من CLAUDE.md §6 و§7):
//  - أي مفتاح اسمه password أو secret أو token ... يرفض النسخة، فلا تتسرّب الأسرار إلى ملف.
//  - لا استعادة جزئية: أي خلل في الملف (تحليل، صيغة، إصدار، مجموع تحقق، بنية) يرفض كل شيء ولا يُغيَّر شيء.
//  - الدمج لا يكتب فوق قيمة موجودة ولا يحذف يوماً، ويُبلغ بكل تعارض. الاستبدال لا يتم إلا بطلب صريح ويرجع نسخة الحالة السابقة.
//  - مجموع التحقق (CRC-32) يكشف التلف والبتر العرضيين فقط، لا التلاعب المقصود.

export const BACKUP_FORMAT = 'adsl-backup';
export const BACKUP_VERSION = 1;
export const MAX_BACKUP_CHARS = 20 * 1024 * 1024;

export class BackupError extends Error {
  constructor(code, message, details = null) { super(message || code); this.name = 'BackupError'; this.code = code; this.details = details; }
}

const SECRET_KEY = /pass(word)?|pwd|secret|token|api[-_]?key|private/i;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY = /^\d{4}-\d{2}$/;
const MAX_PROBLEMS = 20;
const MAX_CONFLICTS = 200;

// ---------- أدوات أساسية ----------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

// CRC-32 (IEEE) لبايتات، نتيجته 8 خانات سداسية.
export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return ((c ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
}

// JSON بترتيب مفاتيح ثابت ليكون مجموع التحقق قابلاً للتكرار. يرمي لما لا يُحفظ في JSON بأمانة.
export function canonicalJson(v, path = '$') {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return JSON.stringify(v);
  if (t === 'number') {
    if (!Number.isFinite(v)) throw new BackupError('BACKUP_VALUE', `رقم غير صالح في ${path}`);
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return '[' + v.map((x, i) => canonicalJson(x === undefined ? null : x, `${path}[${i}]`)).join(',') + ']';
  if (t === 'object') {
    if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
      throw new BackupError('BACKUP_VALUE', `نوع غير مدعوم في ${path}`);
    }
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k], `${path}.${k}`)).join(',') + '}';
  }
  throw new BackupError('BACKUP_VALUE', `نوع غير مدعوم في ${path}`);
}

const checksumOf = (env) => 'crc32:' + crc32(new TextEncoder().encode(canonicalJson({
  format: env.format, version: env.version, createdAt: env.createdAt, appVersion: env.appVersion, data: env.data,
})));

// مسارات المفاتيح السرّية (لا القيم) في أي عمق معقول.
export function findSecretKeys(value, path = '$', depth = 0, out = []) {
  if (depth > 8 || out.length >= MAX_PROBLEMS || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) { value.forEach((x, i) => findSecretKeys(x, `${path}[${i}]`, depth + 1, out)); return out; }
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY.test(k)) out.push(`${path}.${k}`);
    else findSecretKeys(v, `${path}.${k}`, depth + 1, out);
  }
  return out;
}

// ---------- التحقق من بنية الحالة ----------
const realDate = (s) => {
  if (!DAY_KEY.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

// يرجع قائمة مشاكل (فارغة إن سليمة). الحقول غير المعروفة في اليوم تُترك ولا تُفحص.
export function validateState(state) {
  const P = [];
  const bad = (m) => { if (P.length < MAX_PROBLEMS) P.push(m); };
  if (!isObj(state)) return ['الحالة ليست كائناً'];
  if (!isObj(state.d)) bad('الحقل d (الأيام) مفقود أو ليس كائناً');
  const numArr = (a, max, where) => {
    if (!Array.isArray(a)) return bad(`${where}: ليس قائمة`);
    if (a.length > max) bad(`${where}: أطول من ${max}`);
    a.forEach((x, i) => { if (x !== null && !isNum(x)) bad(`${where}[${i}]: ليس رقماً ولا فارغاً`); });
  };
  const nullNum = (x, where) => { if (x !== null && x !== undefined && !isNum(x)) bad(`${where}: ليس رقماً ولا فارغاً`); };
  for (const [k, e] of Object.entries(isObj(state.d) ? state.d : {})) {
    if (!realDate(k)) { bad(`d.${k}: ليس تاريخاً صالحاً (YYYY-MM-DD)`); continue; }
    if (!isObj(e)) { bad(`d.${k}: ليس كائناً`); continue; }
    if (e.b !== undefined) numArr(e.b, 3, `d.${k}.b`);
    if (e.o !== undefined) numArr(e.o, 3, `d.${k}.o`);
    if (e.c !== undefined) numArr(e.c, 5, `d.${k}.c`);
    nullNum(e.s, `d.${k}.s`);
    nullNum(e.p, `d.${k}.p`);
    nullNum(e.lb, `d.${k}.lb`);
    if (isNum(e.lb) && e.lb < 0) bad(`d.${k}.lb: سالب`);
    if (e.lp !== undefined && typeof e.lp !== 'boolean') bad(`d.${k}.lp: ليس منطقياً`);
    if (e.lr !== undefined && e.lr !== null && typeof e.lr !== 'string') bad(`d.${k}.lr: ليس نصاً`);
    if (e.lx !== undefined && e.lx !== null && !(Number.isInteger(e.lx) && e.lx >= 0)) bad(`d.${k}.lx: ليس عدداً صحيحاً غير سالب`);
  }
  if (state.op !== undefined) {
    if (!isObj(state.op)) bad('op: ليس كائناً');
    else for (const [k, a] of Object.entries(state.op)) { if (!MONTH_KEY.test(k)) bad(`op.${k}: ليس شهراً (YYYY-MM)`); else numArr(a, 3, `op.${k}`); }
  }
  if (state.vn !== undefined) {
    if (!isObj(state.vn)) bad('vn: ليس كائناً');
    else for (const [k, v] of Object.entries(state.vn)) { if (!/^\d+$/.test(k)) bad(`vn.${k}: مفتاح غير رقمي`); if (typeof v !== 'string') bad(`vn.${k}: ليس نصاً`); }
  }
  return P;
}

// ---------- الإنشاء ----------
// sections: { state (مطلوب), settings?, log? }. now: ميلي ثانية (للاختبار).
export function createBackup({ state, settings, log } = {}, { now = Date.now(), appVersion = null } = {}) {
  const problems = validateState(state);
  if (problems.length) throw new BackupError('BACKUP_BAD_STATE', 'حالة التطبيق غير سليمة، لم تُنشأ نسخة (حتى لا تُنشأ نسخة لا تُستعاد).', problems);
  if (settings !== undefined && !isObj(settings)) throw new BackupError('BACKUP_BAD_SETTINGS', 'الإعدادات ليست كائناً');
  if (log !== undefined && !(isObj(log) && Array.isArray(log.entries))) throw new BackupError('BACKUP_BAD_LOG', 'لقطة السجل غير صالحة');
  const data = { state: clone(state) };
  if (settings !== undefined) data.settings = clone(settings);
  if (log !== undefined) data.log = clone(log);
  const secrets = findSecretKeys(data);
  if (secrets.length) throw new BackupError('BACKUP_SECRET', 'وُجدت مفاتيح سرّية في البيانات؛ لم تُنشأ نسخة. لا تُحفظ كلمات المرور في النسخ الاحتياطية.', secrets);
  if (!Number.isFinite(now)) throw new BackupError('BACKUP_BAD_TIME', 'وقت غير صالح');
  const env = { format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt: new Date(now).toISOString(), appVersion, data };
  env.checksum = checksumOf(env);
  return env;
}

export const serializeBackup = (backup) => JSON.stringify(backup, null, 1) + '\n';

// ---------- القراءة والتحقق (كلها أو لا شيء) ----------
export function parseBackup(text) {
  if (typeof text !== 'string') throw new BackupError('BACKUP_PARSE', 'محتوى النسخة ليس نصاً');
  if (text.length > MAX_BACKUP_CHARS) throw new BackupError('BACKUP_TOO_LARGE', 'ملف النسخة أكبر من الحد المسموح');
  let obj;
  try { obj = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) { throw new BackupError('BACKUP_PARSE', `الملف ليس JSON صالحاً (قد يكون مبتوراً): ${e.message}`); }
  if (!isObj(obj) || obj.format !== BACKUP_FORMAT) throw new BackupError('BACKUP_FORMAT', 'هذا الملف ليس نسخة احتياطية لهذا التطبيق.');
  if (!Number.isInteger(obj.version) || obj.version < 1) throw new BackupError('BACKUP_FORMAT', 'رقم صيغة النسخة غير صالح.');
  if (obj.version > BACKUP_VERSION) throw new BackupError('BACKUP_NEWER', `النسخة بصيغة أحدث (${obj.version}) من التي يفهمها هذا الإصدار (${BACKUP_VERSION}). حدّث التطبيق.`);
  if (!isObj(obj.data) || !isObj(obj.data.state)) throw new BackupError('BACKUP_STRUCTURE', 'النسخة بلا حالة (data.state).');
  if (typeof obj.checksum !== 'string') throw new BackupError('BACKUP_CHECKSUM', 'مجموع التحقق مفقود.');
  let expect;
  try { expect = checksumOf(obj); } catch (e) { throw new BackupError('BACKUP_STRUCTURE', `بيانات النسخة غير صالحة: ${e.message}`); }
  if (obj.checksum !== expect) throw new BackupError('BACKUP_CHECKSUM', 'مجموع التحقق لا يطابق: الملف تالف أو معدَّل. لم يُستعد شيء.');
  const problems = validateState(obj.data.state);
  if (problems.length) throw new BackupError('BACKUP_BAD_STATE', 'بنية الحالة داخل النسخة غير سليمة. لم يُستعد شيء.', problems);
  const secrets = findSecretKeys(obj.data);
  if (secrets.length) throw new BackupError('BACKUP_SECRET', 'النسخة تحوي مفاتيح سرّية ولن تُستعاد.', secrets);
  if (obj.data.settings !== undefined && !isObj(obj.data.settings)) throw new BackupError('BACKUP_BAD_SETTINGS', 'الإعدادات داخل النسخة ليست كائناً.');
  if (obj.data.log !== undefined && !(isObj(obj.data.log) && Array.isArray(obj.data.log.entries))) throw new BackupError('BACKUP_BAD_LOG', 'السجل داخل النسخة غير صالح.');
  return obj;
}

// ---------- وصف مختصر لعرضه قبل الاستعادة ----------
export function describeBackup(backup) {
  const days = Object.keys(backup.data.state.d).sort();
  const m = {};
  let pinned = 0, temporary = 0;
  for (const k of days) {
    m[k.slice(0, 7)] = (m[k.slice(0, 7)] || 0) + 1;
    const e = backup.data.state.d[k];
    if (e.lb != null) { if (e.lp) pinned++; else temporary++; }
  }
  return {
    createdAt: backup.createdAt, appVersion: backup.appVersion, version: backup.version,
    days: days.length, firstDay: days[0] || null, lastDay: days[days.length - 1] || null,
    months: Object.keys(m).sort().map((key) => ({ key, days: m[key] })),
    pinned, temporary,
    hasSettings: backup.data.settings !== undefined,
    logEntries: backup.data.log ? backup.data.log.entries.length : 0,
  };
}

// اسم ملف بالتوقيت المحلي للجهاز (كما تفعل أدوات التقارير): adsl-backup-YYYYMMDD-HHMMSS.json
export function backupFileName(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `adsl-backup-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.json`;
}

// ---------- الاستعادة ----------
function newReport(mode) { return { mode, daysAdded: 0, valuesFilled: 0, valuesSame: 0, conflicts: [], conflictsTotal: 0 }; }
function conflict(rep, where, current, incoming) {
  rep.conflictsTotal++;
  if (rep.conflicts.length < MAX_CONFLICTS) rep.conflicts.push({ where, current, incoming });
}
function mv(rep, cur, inc, where) {
  if (inc === null || inc === undefined) return cur;
  if (cur === null || cur === undefined) { rep.valuesFilled++; return inc; }
  if (cur === inc) { rep.valuesSame++; return cur; }
  conflict(rep, where, cur, inc);
  return cur; // الموجود يبقى دائماً في الدمج
}
function mergeArr(rep, cur, inc, where) {
  const n = Math.max((cur || []).length, (inc || []).length);
  return Array.from({ length: n }, (_, i) => mv(rep, cur ? cur[i] : null, inc ? inc[i] : null, `${where}[${i}]`));
}
function mergeFlat(rep, cur, inc, where) {
  const out = { ...(cur || {}) };
  for (const [k, v] of Object.entries(inc || {})) {
    if (!(k in out)) { out[k] = clone(v); rep.valuesFilled++; }
    else if (canonicalJson(out[k]) === canonicalJson(v)) rep.valuesSame++;
    else conflict(rep, `${where}.${k}`, out[k], v);
  }
  return out;
}
const cardOf = (e) => canonicalJson({ lb: e.lb, lp: e.lp, lr: e.lr, lx: e.lx, p: e.p, c: e.c });
const emptyManual = (e) => e.lb == null && e.p == null && (e.c || []).every((x) => x == null);

// يدمج incoming في base دون تعديل base. لا يُكتب فوق قيمة موجودة، ولا يُحذف يوم.
// مجموعة الكروت (lb/lp/lr/lx مع p و c) تُنسخ معاً أو لا تُنسخ: لا تُنسخ فوق إدخال يدوي قائم (p أو c) حتى
// لا يصير اليوم «مقروءاً من الراوتر» فيكتب القارئ فوق إدخال المستخدم (انظر applyDayReading).
// (هذه الدالة منفصلة عن mergeState في core/excel.js عمداً: تلك لا تعرف vn ولا حقول الكروت.)
export function mergeBackupState(base, incoming) {
  const rep = newReport('merge');
  const out = { ...base, d: { ...(base.d || {}) } };
  if (base.op || incoming.op) out.op = { ...(base.op || {}) }; // لا نضيف حقلاً فارغاً لحالة لم يكن فيها
  if (base.vn || incoming.vn) out.vn = { ...(base.vn || {}) };
  for (const [k, inc] of Object.entries(incoming.d || {})) {
    const cur = out.d[k];
    if (!cur) { out.d[k] = clone(inc); rep.daysAdded++; continue; }
    const m = { ...cur };
    for (const f of ['b', 'o']) if (inc[f]) m[f] = mergeArr(rep, cur[f], inc[f], `${k}.${f}`);
    if (inc.s !== undefined) m.s = mv(rep, cur.s, inc.s, `${k}.s`);
    if (inc.lb != null) {
      if (emptyManual(cur)) {
        for (const f of ['lb', 'lp', 'lr', 'lx', 'p']) if (inc[f] !== undefined) m[f] = inc[f];
        if (inc.c) m.c = [...inc.c];
        rep.valuesFilled++;
      } else if (cardOf(cur) === cardOf(inc)) rep.valuesSame++;
      else conflict(rep, `${k}.card`, { lb: cur.lb ?? null, lp: cur.lp ?? null, lr: cur.lr ?? null, p: cur.p ?? null }, { lb: inc.lb, lp: inc.lp ?? null, lr: inc.lr ?? null, p: inc.p ?? null });
    } else {
      if (inc.p !== undefined) m.p = mv(rep, cur.p, inc.p, `${k}.p`);
      if (inc.c) m.c = mergeArr(rep, cur.c, inc.c, `${k}.c`);
    }
    out.d[k] = m;
  }
  for (const [k, inc] of Object.entries(incoming.op || {})) {
    out.op[k] = out.op[k] ? mergeArr(rep, out.op[k], inc, `op.${k}`) : [...inc];
    if (!base.op || !base.op[k]) rep.valuesFilled += inc.filter((x) => x != null).length;
  }
  if (incoming.vn) out.vn = mergeFlat(rep, out.vn, incoming.vn, 'vn');
  return { state: out, report: rep };
}

// current: { state, settings? }. backup: ناتج parseBackup. mode: 'merge' (الافتراضي) أو 'replace'.
// يرجع { state, settings, logSnapshot, report, previous }.
//   previous = نسخة من الحالة والإعدادات قبل الاستعادة: على المُستدعي حفظها قبل اعتماد النتيجة (للتراجع).
//   logSnapshot = لقطة السجل من النسخة (أو null) ليُمرَّر إلى log.restore() الذي يدمجها بلا تكرار.
export function restoreBackup(current, backup, { mode = 'merge' } = {}) {
  if (mode !== 'merge' && mode !== 'replace') throw new BackupError('BACKUP_BAD_MODE', `وضع غير معروف: ${mode}`);
  const cur = current || {};
  const curState = cur.state || { d: {}, op: {} };
  const cp = validateState(curState);
  if (cp.length) throw new BackupError('BACKUP_BAD_STATE', 'الحالة الحالية غير سليمة؛ لم تُجرَ الاستعادة حتى لا يضيع شيء.', cp);
  const inc = backup && backup.data;
  if (!inc || !isObj(inc.state) || validateState(inc.state).length) throw new BackupError('BACKUP_STRUCTURE', 'النسخة لم تُتحقق بـ parseBackup().');
  const previous = { state: clone(curState), settings: cur.settings === undefined ? undefined : clone(cur.settings) };
  const logSnapshot = inc.log ? clone(inc.log) : null;

  if (mode === 'replace') {
    const state = clone(inc.state);
    const report = newReport('replace');
    report.daysAdded = Object.keys(state.d).filter((k) => !(k in (curState.d || {}))).length;
    report.daysDropped = Object.keys(curState.d || {}).filter((k) => !(k in state.d)).length;
    return { state, settings: inc.settings !== undefined ? clone(inc.settings) : cur.settings, logSnapshot, report, previous };
  }
  // نمرّر نسخة من الحالة الحالية: النتيجة لا تشارك كائنات مع current ولا مع previous، فتعديلها لاحقاً لا يفسد التراجع.
  const { state, report } = mergeBackupState(clone(curState), inc.state);
  let settings = cur.settings;
  if (inc.settings !== undefined) settings = mergeFlat(report, cur.settings || {}, inc.settings, 'settings');
  return { state, settings, logSnapshot, report, previous };
}
