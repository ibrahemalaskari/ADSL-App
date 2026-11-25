// عميل بروتوكول MikroTik RouterOS API (متوافق مع v6: المنفذ 8728، وAPI-SSL على 8729).
// لا يعتمد على أي مكتبة، ولا يعرف شيئاً عن الشبكة: يتكلم عبر "Transport" يُمرَّر إليه
// (جسر Termux للتجربة المحلية، أو Plugin أصلي داخل تطبيق أندرويد).
//
// قاعدة أمان: العميل للقراءة فقط افتراضياً. لا يقبل إلا /login وأوامر */print.
// أي أمر كتابة (مثل إعداد Scheduler) يحتاج readOnly:false صريحاً وبموافقة المستخدم.

import { md5Hex } from './md5.js';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

// ---------------------------------------------------------------- الأخطاء

export class RosError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'RosError';
    this.code = code;
    this.details = details;
  }
}

// تحويل رموز أخطاء الشبكة (Node/أندرويد) إلى رموز موحدة.
export function mapNetError(errno) {
  switch (String(errno || '').toUpperCase()) {
    case 'ECONNREFUSED': return 'PORT_REFUSED';
    case 'ETIMEDOUT': case 'TIMEOUT': return 'NETWORK_TIMEOUT';
    case 'EHOSTUNREACH': case 'ENETUNREACH': case 'EHOSTDOWN': return 'HOST_UNREACHABLE';
    case 'ENOTFOUND': case 'EAI_AGAIN': return 'BAD_ADDRESS';
    case 'ECONNRESET': case 'EPIPE': return 'CONNECTION_CLOSED';
    default: return 'CONNECT_FAILED';
  }
}

// يحدد السبب المحتمل ويعطي رسالة عربية مفهومة. التفاصيل التقنية تبقى في err.details للسجل.
// ملاحظة صدق: رفض الاتصال يرجّح تعطيل API لكنه لا يثبته، وانتهاء المهلة لا يفرّق بين
// الشبكة وجدار ناري يحجب المنفذ.
export function diagnose(err) {
  const code = err instanceof RosError ? err.code : 'UNKNOWN';
  const table = {
    PORT_REFUSED: ['api_disabled', 'رفض الراوتر الاتصال بالمنفذ. السبب الأرجح أن خدمة API معطلة أو أن رقم المنفذ مختلف. فعّلها من IP > Services أو انتظر موعد Scheduler.'],
    NETWORK_TIMEOUT: ['network', 'لم يصل رد من الراوتر. تحقق من العنوان ومن اتصال الهاتف بشبكة الراوتر. وقد يكون المنفذ محجوباً بقاعدة جدار ناري أو API معطلاً.'],
    HOST_UNREACHABLE: ['network', 'لا يوجد مسار إلى الراوتر. تحقق من أن الهاتف على نفس الشبكة وأن العنوان صحيح.'],
    BAD_ADDRESS: ['network', 'عنوان الراوتر غير صالح.'],
    LOGIN_FAILED: ['credentials', 'رفض الراوتر اسم المستخدم أو كلمة المرور.'],
    PERMISSION_DENIED: ['permissions', 'الحساب لا يملك صلاحية قراءة هذه البيانات (يلزم صلاحيتا api وread على الأقل).'],
    TIMEOUT: ['timeout', 'انتهت مهلة انتظار رد الراوتر أثناء القراءة. لم تُسجَّل أي قراءة.'],
    CONNECTION_CLOSED: ['network', 'انقطع الاتصال أثناء العملية. لم تُسجَّل أي قراءة.'],
    READ_ONLY: ['internal', 'محاولة تنفيذ أمر غير قراءة أثناء وضع القراءة فقط. تم الرفض.'],
    BRIDGE_DOWN: ['bridge', 'جسر Termux غير شغال. شغّله بالأمر: node bridge/server.js ثم أعد المحاولة.'],
    CONNECT_FAILED: ['unknown', 'تعذر الاتصال بالراوتر لسبب غير محدد.'],
  };
  const [cause, message] = table[code] || ['unknown', 'حدث خطأ غير متوقع. راجع سجل العمليات.'];
  return { cause, code, message, technical: err && (err.details || err.message) };
}

// ---------------------------------------------------------------- الترميز

export function encodeLength(n) {
  if (!Number.isInteger(n) || n < 0) throw new RosError('PROTOCOL', 'طول كلمة غير صالح');
  if (n < 0x80) return Uint8Array.of(n);
  if (n < 0x4000) { const v = n | 0x8000; return Uint8Array.of(v >> 8, v & 0xff); }
  if (n < 0x200000) { const v = n | 0xc00000; return Uint8Array.of(v >> 16, (v >> 8) & 0xff, v & 0xff); }
  if (n < 0x10000000) {
    const v = (n | 0xe0000000) >>> 0;
    return Uint8Array.of(v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  }
  return Uint8Array.of(0xf0, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
}

export function encodeSentence(words) {
  const parts = [];
  for (const w of words) {
    const b = enc.encode(w);
    parts.push(encodeLength(b.length), b);
  }
  parts.push(Uint8Array.of(0));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// يقرأ طول الكلمة من buf عند pos. يعيد null إن لم تكتمل البايتات بعد.
function readLength(buf, pos) {
  if (pos >= buf.length) return null;
  const c = buf[pos];
  if (c < 0x80) return { len: c, size: 1 };
  if ((c & 0xc0) === 0x80) {
    if (pos + 2 > buf.length) return null;
    return { len: ((c & 0x3f) << 8) | buf[pos + 1], size: 2 };
  }
  if ((c & 0xe0) === 0xc0) {
    if (pos + 3 > buf.length) return null;
    return { len: ((c & 0x1f) << 16) | (buf[pos + 1] << 8) | buf[pos + 2], size: 3 };
  }
  if ((c & 0xf0) === 0xe0) {
    if (pos + 4 > buf.length) return null;
    return { len: (((c & 0x0f) << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]) >>> 0, size: 4 };
  }
  if (c === 0xf0) {
    if (pos + 5 > buf.length) return null;
    return { len: ((buf[pos + 1] << 24) | (buf[pos + 2] << 16) | (buf[pos + 3] << 8) | buf[pos + 4]) >>> 0, size: 5 };
  }
  throw new RosError('PROTOCOL', 'بايت تحكم غير مدعوم في رد الراوتر');
}

// يستقبل البايتات على دفعات (قد تنقسم الجملة بين دفعتين) ويُخرج الجمل المكتملة.
export class SentenceParser {
  constructor() { this.buf = new Uint8Array(0); this.words = []; }
  push(chunk) {
    if (chunk && chunk.length) {
      const nb = new Uint8Array(this.buf.length + chunk.length);
      nb.set(this.buf); nb.set(chunk, this.buf.length);
      this.buf = nb;
    }
    const sentences = [];
    let pos = 0;
    for (;;) {
      const l = readLength(this.buf, pos);
      if (!l) break;
      if (l.len === 0) { // نهاية الجملة
        pos += l.size;
        sentences.push(this.words);
        this.words = [];
        continue;
      }
      if (pos + l.size + l.len > this.buf.length) break; // الكلمة لم تكتمل
      const start = pos + l.size;
      this.words.push(dec.decode(this.buf.subarray(start, start + l.len)));
      pos = start + l.len;
    }
    this.buf = this.buf.slice(pos);
    return sentences;
  }
}

export function parseSentence(words) {
  const type = words[0] || '';
  const attrs = {};
  let tag = null;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith('=') || w.startsWith('.')) {
      const eq = w.indexOf('=', 1);
      if (eq === -1) continue;
      const key = w.startsWith('=') ? w.slice(1, eq) : w.slice(0, eq);
      const val = w.slice(eq + 1);
      if (key === '.tag') tag = val; else attrs[key] = val;
    } else if (type === '!fatal' || type === '!trap') {
      attrs.message = attrs.message || w;
    }
  }
  return { type, attrs, tag };
}

// ---------------------------------------------------------------- مساعدات القيم

// عداد بايتات: أعداد صحيحة غير سالبة فقط. القيمة المفقودة أو غير الصالحة = null (وليس 0).
export function toCount(v) {
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

// يحوّل uptime في RouterOS (مثل 1w2d03:04:05 أو 3d04:05:06 أو 1d2h3m4s) إلى ثوانٍ.
export function parseUptime(s) {
  if (typeof s !== 'string' || !s) return null;
  let m = s.match(/^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+):(\d+):(\d+))?$/);
  if (m && (m[1] || m[2] || m[3] !== undefined)) {
    return (+m[1] || 0) * 604800 + (+m[2] || 0) * 86400 + (+m[3] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[5] || 0);
  }
  m = s.match(/^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (m && (m[1] || m[2] || m[3] || m[4] || m[5])) {
    return (+m[1] || 0) * 604800 + (+m[2] || 0) * 86400 + (+m[3] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[5] || 0);
  }
  return null;
}

function hexToBytes(h) {
  if (!/^([0-9a-fA-F]{2})*$/.test(h)) throw new RosError('PROTOCOL', 'تحدٍّ غير صالح من الراوتر');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

// ---------------------------------------------------------------- العميل
//
// واجهة Transport المطلوبة (كلها async):
//   open({host, port, tls, timeoutMs})  يرمي RosError برمز من mapNetError عند الفشل
//   write(Uint8Array)
//   read(maxWaitMs) -> Uint8Array (قد يكون فارغاً عند انتهاء مهلة الانتظار) أو null عند إغلاق الاتصال
//   close()

export class RouterOSClient {
  constructor(transport, { timeoutMs = 10000, readOnly = true } = {}) {
    this.t = transport;
    this.timeoutMs = timeoutMs;
    this.readOnly = readOnly;
    this.parser = new SentenceParser();
    this.queue = [];
    this.opened = false;
    this.loggedIn = false;
  }

  async connect({ host, port = 8728, tls = false }) {
    await this.t.open({ host, port, tls, timeoutMs: this.timeoutMs });
    this.opened = true;
  }

  async _readSentence(deadline) {
    while (this.queue.length === 0) {
      const left = deadline - Date.now();
      if (left <= 0) throw new RosError('TIMEOUT', 'انتهت مهلة انتظار الرد');
      const chunk = await this.t.read(Math.min(left, 2000));
      if (chunk === null) throw new RosError('CONNECTION_CLOSED', 'أُغلق الاتصال');
      for (const s of this.parser.push(chunk)) this.queue.push(s);
    }
    return this.queue.shift();
  }

  // ينفذ أمراً ويجمع الردود حتى !done. يرمي عند !trap أو !fatal.
  async talk(path, params = {}, { query = [], timeoutMs } = {}) {
    if (!this.opened) throw new RosError('CONNECTION_CLOSED', 'لا يوجد اتصال مفتوح');
    if (this.readOnly && path !== '/login' && !/\/print$/.test(path)) {
      throw new RosError('READ_ONLY', `أمر غير مسموح في وضع القراءة فقط: ${path}`);
    }
    const words = [path, ...Object.entries(params).map(([k, v]) => `=${k}=${v}`), ...query];
    await this.t.write(encodeSentence(words));
    const deadline = Date.now() + (timeoutMs || this.timeoutMs);
    const rows = [];
    const traps = [];
    let done = null;
    while (!done) {
      const p = parseSentence(await this._readSentence(deadline));
      if (p.type === '!re') rows.push(p.attrs);
      else if (p.type === '!trap') traps.push(p.attrs);
      else if (p.type === '!done') done = p.attrs;
      else if (p.type === '!fatal') throw new RosError('CONNECTION_CLOSED', p.attrs.message || 'fatal', p.attrs);
      else if (p.type === '!empty') done = {};
      else throw new RosError('PROTOCOL', `رد غير متوقع: ${p.type}`);
    }
    if (traps.length) {
      const msg = traps.map((t) => t.message).filter(Boolean).join('; ');
      const perm = /not enough permissions/i.test(msg);
      throw new RosError(perm ? 'PERMISSION_DENIED' : 'TRAP', msg || 'خطأ من الراوتر', traps);
    }
    return { rows, done };
  }

  // تسجيل الدخول: الطريقة الحديثة (6.43+) أولاً، وإن ردّ الراوتر بتحدٍّ نكمل بالطريقة القديمة.
  async login(user, password) {
    let r;
    try {
      r = await this.talk('/login', { name: user, password });
    } catch (e) {
      if (e instanceof RosError && e.code === 'TRAP') throw new RosError('LOGIN_FAILED', e.message, e.details);
      throw e;
    }
    if (r.done && r.done.ret) {
      const input = new Uint8Array([0, ...enc.encode(password), ...hexToBytes(r.done.ret)]);
      try {
        await this.talk('/login', { name: user, response: '00' + md5Hex(input) });
      } catch (e) {
        if (e instanceof RosError && e.code === 'TRAP') throw new RosError('LOGIN_FAILED', e.message, e.details);
        throw e;
      }
    }
    this.loggedIn = true;
  }

  async close() {
    this.opened = false;
    this.loggedIn = false;
    try { await this.t.close(); } catch { /* الإغلاق لا يجب أن يخفي الخطأ الأصلي */ }
  }
}

// ---------------------------------------------------------------- قراءات (قراءة فقط)

export async function readSystem(c) {
  const res = (await c.talk('/system/resource/print')).rows[0] || {};
  const ident = (await c.talk('/system/identity/print')).rows[0] || {};
  let clock = {};
  try { clock = (await c.talk('/system/clock/print')).rows[0] || {}; } catch { /* اختياري */ }
  return {
    identity: ident.name || null,
    version: res.version || null,
    board: res['board-name'] || null,
    uptimeSec: parseUptime(res.uptime),
    uptimeRaw: res.uptime || null,
    clock: clock.time ? { time: clock.time, date: clock.date, timeZone: clock['time-zone-name'] || null } : null,
  };
}

export async function readApiService(c) {
  const rows = (await c.talk('/ip/service/print')).rows;
  const api = rows.find((r) => r.name === 'api');
  const apiSsl = rows.find((r) => r.name === 'api-ssl');
  const pick = (r) => r && { disabled: r.disabled === 'true', port: r.port || null, address: r.address || '' };
  return { api: pick(api), apiSsl: pick(apiSsl) };
}

const KIND = { ether: 'ethernet', vlan: 'vlan', bridge: 'bridge' };

// اكتشاف الواجهات مباشرة من الراوتر (دون قائمة ثابتة). لا يُنشئ أي سجل افتراضي.
export async function discoverInterfaces(c) {
  const warnings = [];
  const all = (await c.talk('/interface/print', { '.proplist': '.id,name,type,running,disabled,comment,rx-byte,tx-byte' })).rows;

  const vlanInfo = new Map();
  try {
    for (const v of (await c.talk('/interface/vlan/print', { '.proplist': 'name,vlan-id,interface' })).rows) {
      vlanInfo.set(v.name, { vlanId: Number(v['vlan-id']), parent: v.interface });
    }
  } catch (e) { warnings.push(`تعذرت قراءة تفاصيل VLAN: ${e.message}`); }

  const bridgeOf = new Map();
  try {
    for (const p of (await c.talk('/interface/bridge/port/print', { '.proplist': 'interface,bridge' })).rows) {
      if (p.interface && p.bridge) bridgeOf.set(p.interface, p.bridge);
    }
  } catch (e) { warnings.push(`تعذرت قراءة منافذ Bridge: ${e.message}`); }

  const seen = new Set();
  const list = [];
  for (const r of all) {
    const key = r['.id'] || r.name;
    if (!r.name || seen.has(key)) continue; // لا تحتسب الواجهة مرتين
    seen.add(key);
    const v = vlanInfo.get(r.name);
    list.push({
      id: r['.id'] || null,
      name: r.name,
      type: r.type || null,
      kind: KIND[r.type] || 'other',
      running: r.running === 'true',
      disabled: r.disabled === 'true',
      comment: r.comment || '',
      vlanId: v ? v.vlanId : null,
      parent: v ? v.parent : null,
      bridge: bridgeOf.get(r.name) || null,
      rx: toCount(r['rx-byte']), // null إن غابت أو كانت غير صالحة
      tx: toCount(r['tx-byte']),
    });
  }
  return { interfaces: list, warnings };
}
