// www/link.js — ربط الواجهة بالراوتر عبر الجسر المحلي.
// المرحلة 1 (ج19): كشف الجسر وتعريف `window.ADSL_LINK`.
// المرحلة 2 (ج20): اختبار الاتصال بالراوتر، قراءة فقط. لا يُحفظ شيء، وكلمة المرور تبقى في الذاكرة طوال الاختبار فقط.
// إن لم يوجد الجسر (Artifact أو ملف مفتوح مباشرة) تعمل الصفحة وحدها كما كانت.
import { RouterOSClient, RosError, readSystem, readApiService, diagnose } from '../core/routeros-api.js';
import { readCards, CardsError } from '../core/cardsreader.js';
import { readRouterSales, SalesReadError } from '../core/sales.js';
import { mergeReadings, parseRosDate } from '../core/cards.js';
import { BridgeTransport } from '../core/bridge-transport.js';
import { discoverInterfaces } from '../core/routeros-api.js';
import { makeReading } from '../core/counters.js';

export const LINK_VERSION = 4;

// الجسر يقبل الاتصال من localhost و127.0.0.1 فقط، فلا معنى للكشف من أي مضيف آخر.
export function isLocalPage(loc) {
  return !!loc && loc.protocol === 'http:' && (loc.hostname === '127.0.0.1' || loc.hostname === 'localhost');
}

// يعيد دائماً كائناً ولا يرمي استثناءً: { available: true } أو { available: false, reason }.
export async function detectBridge({ fetchImpl, base = '', timeoutMs = 1500 } = {}) {
  if (typeof fetchImpl !== 'function') return { available: false, reason: 'NO_FETCH' };
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const r = await fetchImpl(base + '/health', {
      headers: { 'x-bridge': '1' },
      cache: 'no-store',
      signal: ctl ? ctl.signal : undefined,
    });
    if (!r.ok) return { available: false, reason: 'HTTP_' + r.status };
    const j = await r.json().catch(() => null);
    return j && j.ok === true ? { available: true } : { available: false, reason: 'BAD_REPLY' };
  } catch (e) {
    return { available: false, reason: e && e.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- اختبار الاتصال (قراءة فقط)

// الأرقام العربية والفارسية (لوحة مفاتيح الهاتف العربية) تُحوَّل إلى لاتينية قبل التحقق.
const normDigits = (s) => String(s ?? '').replace(/[٠-٩]/g, (c) => c.charCodeAt(0) - 1632).replace(/[۰-۹]/g, (c) => c.charCodeAt(0) - 1776).trim();
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// عنوان IPv4 فقط (الجسر لا يقبل غير العناوين المحلية الخاصة). كلمة المرور لا تُفحص هنا: كلمة مرور فارغة صالحة في RouterOS.
export function validateRouterForm({ host, port, user } = {}) {
  const m = IPV4.exec(normDigits(host));
  if (!m || m.slice(1).some((o) => Number(o) > 255)) return { ok: false, message: 'أدخل عنوان الراوتر بصيغة IPv4 مثل 192.168.88.1.' };
  const ps = normDigits(port);
  const p = ps === '' ? 8728 : Number(ps);
  if (!/^\d*$/.test(ps) || !Number.isInteger(p) || p < 1 || p > 65535) return { ok: false, message: 'رقم المنفذ غير صالح (المعتاد 8728).' };
  const u = String(user ?? '').trim();
  if (!u) return { ok: false, message: 'أدخل اسم المستخدم.' };
  return { ok: true, host: m.slice(1).map(Number).join('.'), port: p, user: u };
}

// يحوّل تفاصيل الخطأ إلى نص آمن: لا يخرج منه كائن الراوتر الخام، وتُحجب كلمة المرور إن ظهرت في أي نص.
function safeError(d, secrets = []) {
  let t = d.technical;
  if (Array.isArray(t)) t = t.map((x) => (x && x.message) || '').filter(Boolean).join('; ');
  else if (t && typeof t === 'object') t = '';
  t = t == null ? '' : String(t);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 3) {
      if (t.includes(secret)) t = t.split(secret).join('***');
    }
  }
  let message = String(d.message || 'تعذر تنفيذ العملية.');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 3 && message.includes(secret)) message = message.split(secret).join('***');
  }
  return { cause: d.cause, code: d.code, message, technical: t };
}

// يعيد دائماً كائناً ولا يرمي استثناءً:
//   نجاح: { ok:true, host, port, v6, system:{identity,version,board,uptimeRaw}, api, apiNote }
//   فشل : { ok:false, host?, error:{cause, code, message, technical} }
// كل ما يُرسل للراوتر: /login ثم أوامر /print فقط (العميل بوضع القراءة فقط). لا يُحفظ شيء.
export async function testRouterConnection({ host, port, user, password = '', transportFactory, timeoutMs = 10000 } = {}) {
  const v = validateRouterForm({ host, port, user });
  if (!v.ok) return { ok: false, error: { cause: 'input', code: 'BAD_INPUT', message: v.message, technical: '' } };
  const pw = String(password ?? '');
  let c = null;
  try {
    c = new RouterOSClient((transportFactory || (() => new BridgeTransport('')))(), { timeoutMs });
    await c.connect({ host: v.host, port: v.port, tls: false });
    await c.login(v.user, pw);
    const system = await readSystem(c);
    let api = null; let apiNote = null;
    try {
      api = (await readApiService(c)).api || null;
      if (!api) apiNote = 'خدمة API غير ظاهرة في قائمة الخدمات.';
    } catch (e) {
      apiNote = 'تعذرت قراءة إعدادات خدمة API: ' + diagnose(e).message; // الاتصال نفسه نجح، فلا يُعدّ هذا فشلاً
    }
    return { ok: true, host: v.host, port: v.port, v6: /^6\./.test(system.version || ''), system, api, apiNote };
  } catch (e) {
    return { ok: false, host: v.host, error: safeError(diagnose(e), [pw, v.user]) };
  } finally {
    if (c) await c.close();
  }
}



// ---------------------------------------------------------------- قراءة الكروت ودمجها في حالة الواجهة (المرحلة 3)

const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const countActions = (results, actions) => results.filter((r) => actions.includes(r.action)).length;

// ينفّذ قراءة كاملة ثم الدمج في الذاكرة فقط. لا يكتب شيئاً في الراوتر ولا يحفظ شيئاً بنفسه.
// أسماء المستخدمين تبقى داخل readCards؛ الناتج هو حالة مجمّعة بلا أسماء أو كلمات مرور.
export async function syncRouterCards({ host, port, user, password = '', state = { d: {} }, transportFactory, timeoutMs = 10000 } = {}) {
  const v = validateRouterForm({ host, port, user });
  if (!v.ok) return { ok: false, error: { cause: 'input', code: 'BAD_INPUT', message: v.message, technical: '' } };
  const pw = String(password ?? '');
  let client = null;
  try {
    const transport = (transportFactory || (() => new BridgeTransport('')))();
    client = new RouterOSClient(transport, { timeoutMs, readOnly: true });
    await client.connect({ host: v.host, port: v.port, tls: false });
    await client.login(v.user, pw);

    const system = await readSystem(client);
    if (!/^6\./.test(system.version || '')) {
      return { ok: false, error: { cause: 'compatibility', code: 'UNSUPPORTED_ROUTEROS', message: 'هذا الربط مخصص لـ RouterOS v6. لم تُسجَّل أي قراءة.', technical: system.version || '' } };
    }

    const routerDay = system.clock && parseRosDate(system.clock.date);
    const readOn = routerDay || localDay();
    const cards = await readCards(client, { withSanity: true });
    const current = state && typeof state === 'object' ? state : { d: {} };
    const merged = mergeReadings(current, cards.agg, readOn);
    const results = merged.results;
    const summary = {
      total: results.length,
      new: countActions(results, ['new']),
      updated: countActions(results, ['updated']),
      pinned: countActions(results, ['pinned', 'pinned-max']),
      hidden: countActions(results, ['hidden-old', 'skipped-no-classified-cards']),
      unchanged: countActions(results, ['unchanged', 'decreased']),
      alreadyPinned: countActions(results, ['skipped-pinned']),
      manual: countActions(results, ['skipped-manual']),
    };
    const sanity = cards.sanity && cards.sanity.available
      ? { available: true, rows: cards.sanity.rows.map((r) => ({ profile: r.profile, users: r.users, withUsage: r.withUsage, ratio: r.ratio })) }
      : { available: false, reason: cards.sanity && cards.sanity.reason || 'غير متاح' };

    return {
      ok: true,
      host: v.host,
      port: v.port,
      readOn,
      dateSource: routerDay ? 'router' : 'device',
      router: { identity: system.identity, version: system.version, board: system.board },
      state: merged.state,
      results,
      summary,
      warnings: [...cards.warnings, ...(!routerDay ? ['تعذّرت قراءة تاريخ الراوتر؛ استُخدم تاريخ الهاتف لهذه المزامنة.'] : [])],
      sanity,
    };
  } catch (e) {
    if (e instanceof CardsError) {
      return { ok: false, error: { cause: 'cards', code: e.code, message: e.message, technical: '' } };
    }
    if (e instanceof RosError) {
      return { ok: false, error: safeError(diagnose(e), [pw, v.user]) };
    }
    const d = diagnose(e);
    return { ok: false, error: safeError({ ...d, code: e && e.code || d.code, message: 'تعذرت مزامنة الكروت. لم تُحفظ أي بيانات.' }, [pw, v.user]) };
  } finally {
    if (client) await client.close();
  }
}


// قراءة عدادات الواجهات وVLAN من RouterOS v6 (قراءة فقط).
export async function readRouterInterfaces({ host, port, user, password = '', transportFactory, timeoutMs = 10000 } = {}) {
  const v = validateRouterForm({ host, port, user });
  if (!v.ok) return { ok: false, error: { cause: 'input', code: 'BAD_INPUT', message: v.message, technical: '' } };
  const pw = String(password ?? ''); let client = null;
  try {
    client = new RouterOSClient((transportFactory || (() => new BridgeTransport('')))(), { timeoutMs, readOnly: true });
    await client.connect({ host: v.host, port: v.port, tls: false }); await client.login(v.user, pw);
    const system = await readSystem(client);
    if (!/^6\./.test(system.version || '')) return { ok: false, error: { cause: 'compatibility', code: 'UNSUPPORTED_ROUTEROS', message: 'قراءة عدادات الفيلانات مهيأة لـ RouterOS v6. لم تُحفظ قراءة.', technical: system.version || '' } };
    const { interfaces, warnings } = await discoverInterfaces(client);
    const reading = makeReading({ ts: Date.now(), uptimeSec: system.uptimeSec, ifaces: interfaces });
    return { ok: true, system: { identity: system.identity, version: system.version, board: system.board }, reading, warnings };
  } catch (e) { const d = diagnose(e); return { ok: false, error: safeError({ ...d, code: e && e.code || d.code, message: d.message || 'تعذرت قراءة عدادات الواجهات.' }, [pw, v.user]) }; }
  finally { if (client) await client.close(); }
}

// ---------------------------------------------------------------- قراءة مبيعات User Manager (RouterOS v6) — لا أوامر كتابة.
export async function syncRouterSales({ host, port, user, password = '', transportFactory, timeoutMs = 10000 } = {}) {
  const v = validateRouterForm({ host, port, user });
  if (!v.ok) return { ok: false, error: { cause: 'input', code: 'BAD_INPUT', message: v.message, technical: '' } };
  const pw = String(password ?? '');
  let client = null;
  try {
    client = new RouterOSClient((transportFactory || (() => new BridgeTransport('')))(), { timeoutMs, readOnly: true });
    await client.connect({ host: v.host, port: v.port, tls: false });
    await client.login(v.user, pw);
    const system = await readSystem(client);
    if (!/^6\./.test(system.version || '')) {
      return { ok: false, error: { cause: 'compatibility', code: 'UNSUPPORTED_ROUTEROS', message: 'قراءة المبيعات الحالية مهيأة لمسارات User Manager في RouterOS v6. لم تُحفظ أي بيانات.', technical: system.version || '' } };
    }
    const routerKey = `${v.host}|${system.identity || system.board || 'RouterOS-v6'}`;
    const result = await readRouterSales(client, { routerKey });
    return { ok: true, routerKey, system, ...result };
  } catch (e) {
    const d = diagnose(e);
    return { ok: false, error: safeError({ ...d, code: e && e.code || d.code,
      message: e instanceof SalesReadError ? e.message : d.message || 'تعذّرت قراءة مبيعات User Manager.' }, [pw, v.user]) };
  } finally {
    if (client) await client.close();
  }
}

// التشغيل داخل المتصفح فقط (الاختبارات في Node تستورد الدوال أعلاه دون أثر جانبي).
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const link = {
    version: LINK_VERSION,
    local: isLocalPage(window.location),
    available: false,
    reason: 'NOT_CHECKED',
    testConnection: testRouterConnection,
    async readInterfaces(args) {
      if (!link.local) return { ok: false, error: { cause: 'local_only', code: 'NOT_LOCAL', message: 'قراءة الواجهات متاحة عبر localhost فقط.', technical: '' } };
      if (!link.available) return { ok: false, error: { cause: 'bridge', code: 'BRIDGE_DOWN', message: 'جسر Termux غير متاح.', technical: '' } };
      return readRouterInterfaces(args);
    },
    async syncSales(args) {
      if (!link.local) return { ok: false, error: { cause: 'local_only', code: 'NOT_LOCAL', message: 'مزامنة المبيعات متاحة عند فتح التطبيق عبر localhost فقط.', technical: '' } };
      if (!link.available) return { ok: false, error: { cause: 'bridge', code: 'BRIDGE_DOWN', message: 'جسر Termux غير متاح. شغّله ثم أعد المحاولة.', technical: '' } };
      return syncRouterSales(args);
    },
    async syncCards(args) {
      if (!link.local) return { ok: false, error: { cause: 'local_only', code: 'NOT_LOCAL', message: 'مزامنة الراوتر متاحة عند فتح التطبيق عبر localhost فقط.', technical: '' } };
      if (!link.available) return { ok: false, error: { cause: 'bridge', code: 'BRIDGE_DOWN', message: 'جسر Termux غير متاح. شغّله ثم أعد المحاولة.', technical: '' } };
      return syncRouterCards(args);
    },
    async check() {
      if (!link.local) { link.available = false; link.reason = 'NOT_LOCAL'; }
      else {
        const r = await detectBridge({ fetchImpl: window.fetch.bind(window) });
        link.available = r.available;
        link.reason = r.available ? 'OK' : r.reason;
      }
      window.dispatchEvent(new CustomEvent('adsl-link', { detail: { available: link.available, reason: link.reason } }));
      return link.available;
    },
  };
  window.ADSL_LINK = link;
  link.check();
}
