// سجل العمليات والأخطاء (ج17). منطق نقي: بلا تخزين ولا شبكة ولا واجهة.
// التخزين الدائم (ملف أو قاعدة التطبيق) يُحقن من الخارج عبر snapshot() و restore().
//
// القواعد (من CLAUDE.md §6 و§7):
//  - لا تدخل كلمات المرور ولا الأسرار السجل: مفاتيح مثل password و secret و token تُحجب،
//    وأي قيمة سرّية مُسجَّلة عبر addSecret() تُحجب من النصوص. (الحجب شبكة أمان: لا يلتقط سرّاً لم يُسجَّل.)
//  - أسماء مستخدمي الكروت لا تدخل السجل: المفاتيح username و user و users تُحجب.
//  - لا قيم معقّدة في meta: أنواع بسيطة فقط، بطول محدود.
//  - السجل له سقف (max): عند تجاوزه يُحذف الأقدم ويُحسب في dropped، فلا يُخفى الحذف.
//  - دمج لقطة محفوظة لا يكرر المدخلات نفسها.

export const LEVELS = Object.freeze(['info', 'warn', 'error']);

const SECRET_KEY = /pass(word)?|pwd|secret|token|api[-_]?key|private/i;
const USER_KEY = /^(user|users|username|usernames|login)$/i;
const MASK = '***';
const MAX_MSG = 300;
const MAX_STR = 200;
const MAX_META_KEYS = 12;
const MIN_SECRET_LEN = 3; // أقصر من ذلك يحجب نصوصاً عادية بالخطأ

export class LogError extends Error {
  constructor(code, message) { super(message || code); this.name = 'LogError'; this.code = code; }
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// يحجب كل قيمة سرّية معروفة من نص.
export function maskSecrets(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length < MIN_SECRET_LEN) continue;
    out = out.split(s).join(MASK);
  }
  return out;
}

// يحوّل meta إلى كائن مسطّح آمن: مفاتيح سرّية وأسماء مستخدمين تُحجب، والقيم المعقّدة تُختصر.
export function sanitizeMeta(meta, secrets = []) {
  if (meta === null || meta === undefined) return null;
  if (typeof meta !== 'object' || Array.isArray(meta)) return { value: sanitizeValue(meta, secrets) };
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(meta)) {
    if (n >= MAX_META_KEYS) { out['…'] = `+${Object.keys(meta).length - MAX_META_KEYS} حقول لم تُحفظ`; break; }
    const key = clip(String(k), 40);
    out[key] = (SECRET_KEY.test(k) || USER_KEY.test(k)) ? MASK : sanitizeValue(v, secrets);
    n++;
  }
  return out;
}

function sanitizeValue(v, secrets) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return clip(maskSecrets(v, secrets), MAX_STR);
  if (Array.isArray(v)) return `[قائمة: ${v.length}]`;
  return '[كائن]';
}

const entryKey = (e) => `${e.ts}|${e.level}|${e.code}|${e.msg}`;

function validEntry(e) {
  return !!e && typeof e === 'object'
    && typeof e.ts === 'string' && Number.isFinite(Date.parse(e.ts))
    && LEVELS.includes(e.level)
    && typeof e.code === 'string' && e.code.length > 0
    && typeof e.msg === 'string';
}

// now: دالة ترجع وقتاً بالميلي ثانية (تُحقن في الاختبارات). max: سقف عدد المدخلات.
export function createLog({ max = 500, now = () => Date.now() } = {}) {
  if (!Number.isInteger(max) || max < 1) throw new LogError('BAD_MAX', 'سقف السجل يجب أن يكون عدداً صحيحاً موجباً');
  let entries = [];
  let dropped = 0;
  let nextId = 1;
  let secrets = [];

  const trim = () => {
    if (entries.length > max) { dropped += entries.length - max; entries = entries.slice(entries.length - max); }
  };

  function add(level, code, message, meta = null) {
    if (!LEVELS.includes(level)) throw new LogError('BAD_LEVEL', `مستوى غير معروف: ${level}`);
    if (typeof code !== 'string' || !code) throw new LogError('BAD_CODE', 'رمز السجل مطلوب');
    const t = now();
    if (!Number.isFinite(t)) throw new LogError('BAD_TIME', 'وقت غير صالح');
    const e = {
      id: nextId++,
      ts: new Date(t).toISOString(),
      level,
      code: clip(maskSecrets(code, secrets), 60),
      msg: clip(maskSecrets(message == null ? '' : message, secrets), MAX_MSG),
      meta: sanitizeMeta(meta, secrets),
    };
    entries.push(e);
    trim();
    return e;
  }

  return {
    add,
    info: (code, msg, meta) => add('info', code, msg, meta),
    warn: (code, msg, meta) => add('warn', code, msg, meta),
    error: (code, msg, meta) => add('error', code, msg, meta),

    // يسجّل خطأً: يأخذ code و message منه إن وُجدا. لا يُسجَّل stack (قد يحمل مسارات وقيماً).
    logError(err, context = null) {
      const code = (err && err.code) || (err && err.name) || 'ERROR';
      const msg = (err && err.message) || String(err);
      return add('error', String(code), msg, context);
    },

    // قيم سرّية تُحجب من النصوص من الآن فصاعداً (كلمة مرور الراوتر مثلاً). لا تُحفظ في snapshot().
    addSecret(value) { if (typeof value === 'string' && value.length >= MIN_SECRET_LEN && !secrets.includes(value)) secrets.push(value); },

    // يرجع نسخة؛ filter: { level, code, since } كلها اختيارية.
    entries({ level = null, code = null, since = null } = {}) {
      const t = since == null ? null : Date.parse(since);
      return entries
        .filter((e) => (!level || e.level === level) && (!code || e.code === code) && (t === null || Date.parse(e.ts) >= t))
        .map((e) => ({ ...e, meta: e.meta ? { ...e.meta } : null }));
    },

    counts() {
      const c = { info: 0, warn: 0, error: 0 };
      for (const e of entries) c[e.level]++;
      return { ...c, total: entries.length, dropped };
    },

    // لقطة للحفظ (بلا أسرار). dropped يُحفظ حتى لا يُخفى ما أُسقط.
    snapshot() {
      return { v: 1, dropped, entries: entries.map((e) => ({ ...e, meta: e.meta ? { ...e.meta } : null })) };
    },

    // يدمج لقطة محفوظة في السجل الحالي بلا تكرار، ويرتّب بالوقت، ثم يطبّق السقف.
    // مدخلات غير صالحة تُتجاهل وتُعدّ في rejected (لا يفشل الدمج كله بسببها).
    restore(snap) {
      if (!snap || typeof snap !== 'object' || !Array.isArray(snap.entries)) {
        throw new LogError('BAD_SNAPSHOT', 'لقطة السجل غير صالحة');
      }
      const have = new Set(entries.map(entryKey));
      let added = 0, duplicates = 0, rejected = 0;
      for (const e of snap.entries) {
        if (!validEntry(e)) { rejected++; continue; }
        const clean = {
          id: 0,
          ts: new Date(Date.parse(e.ts)).toISOString(),
          level: e.level,
          code: clip(maskSecrets(e.code, secrets), 60),
          msg: clip(maskSecrets(e.msg, secrets), MAX_MSG),
          meta: sanitizeMeta(e.meta, secrets),
        };
        if (have.has(entryKey(clean))) { duplicates++; continue; }
        have.add(entryKey(clean));
        entries.push(clean);
        added++;
      }
      entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
      entries.forEach((e, i) => { e.id = i + 1; });
      nextId = entries.length + 1;
      if (Number.isInteger(snap.dropped) && snap.dropped > 0) dropped += snap.dropped;
      const before = entries.length;
      trim();
      return { added, duplicates, rejected, trimmed: before - entries.length };
    },
  };
}

// نص عربي مقروء لعرض السجل (للأدوات والواجهة). المدخلات كما هي بلا حقول إضافية.
export function formatLog(list) {
  const tag = { info: 'معلومة', warn: 'تنبيه', error: 'خطأ' };
  return list.map((e) => {
    const m = e.meta ? ' ' + Object.entries(e.meta).map(([k, v]) => `${k}=${v}`).join(' ') : '';
    return `${e.ts} [${tag[e.level]}] ${e.code}: ${e.msg}${m}`;
  }).join('\n');
}
