// فحص اليوزر مانجر (RouterOS v6) عبر API — قراءة فقط.
// الغرض: معرفة ما يُتاح فعلاً عبر API في الإصدار المثبّت وما أسماء الحقول، قبل بناء أي شيء عليه.
//
// مسارات القوائم أدناه من القائمة /tool user-manager في v6. (ج11) صُحِّح مساران كانا خاطئين:
// القيود تحت /profile/limitation (لا /limitation)، وربط الباقة بالقيد هو /profile/profile-limitation.
// مصدر التصحيح: أوامر console منشورة في منتدى ميكروتيك لـ v6 (وليس تجربة على راوتر المستخدم).
// ما زالت المسارات غير مؤكدة على راوتر حقيقي حتى يُشغَّل الفحص. أسماء الحقول تُكتشف من ردّ الراوتر ولا تُفترض.
//
// قاعدة أمان: لا يُرسل إلا أوامر */print عبر العميل (وضع القراءة فقط الافتراضي).
//
// سياسة البيانات (مبدأ مقترح لم يُقرّه المستخدم صراحةً بعد، ويُطبَّق هنا افتراضياً):
//  - لا تظهر في التقرير أسماء المستخدمين ولا كلمات المرور ولا عناوين IP أو MAC ولا التعليقات.
//  - قوائم الإعداد (الباقات والقيود وربطهما): تُعرض قيمها كاملة عدا الحقول المحجوبة.
//  - قائمتا المستخدمين والجلسات: أعداد وأسماء حقول وإحصاءات حقول محددة فقط.
//  - اكتشاف أسماء حقول المستخدمين يتطلب قراءة عيّنة صغيرة (SAMPLE_SIZE صفوف) بكل حقولها
//    (وفيها كلمات المرور). تمرّ هذه الصفوف على شبكة الراوتر المحلية وتُهمَل قيمها في الذاكرة فوراً.
//  - شبكة أمان أخيرة: أي قيمة من حقل سرّي رآها الفحص تُحجب من النص النهائي إن ظهرت فيه.

import { RosError, readSystem, readApiService } from './routeros-api.js';

export const SAMPLE_SIZE = 5;
export const MAX_CONFIG_ROWS = 80;
const HEAVY_MS = 60000;

export const UM_TABLES = {
  profile: { path: '/tool/user-manager/profile/print', kind: 'config', title: 'الباقات (profile)' },
  limitation: { path: '/tool/user-manager/profile/limitation/print', kind: 'config', title: 'القيود (profile limitation)' },
  profileLimitation: { path: '/tool/user-manager/profile/profile-limitation/print', kind: 'config', title: 'ربط الباقات بالقيود (profile-limitation)' },
  user: { path: '/tool/user-manager/user/print', kind: 'private', title: 'المستخدمون (user)' },
  session: { path: '/tool/user-manager/session/print', kind: 'private', title: 'الجلسات (session)' },
};

// ---------------------------------------------------------------- تصنيف الحقول

const SECRET_RE = /pass|secret|psk|token|private|(^|-)key($|-)/i;
const IDENTITY_RE = /^(user|username|login)$|caller|station|(^|-)mac($|-)|addr|(^|-)ip($|-)|phone|email|comment|note|owner|customer|wireless|identity/i;
// الحقول التي يجوز عرض أمثلة قيمها وإحصاءاتها في القوائم الخاصة (قائمة بيضاء).
const SAFE_VALUE_RE = /^(actual-profile|profile|state|status|disabled|incomplete|shared-users|active-sessions|started|ended|from-time|till-time|active|uptime|download|upload|last-seen|terminate-cause|(download|upload|uptime|transfer)-used)$/i;

export const isSecretKey = (k) => SECRET_RE.test(k);
export const isHiddenKey = (k) => SECRET_RE.test(k) || IDENTITY_RE.test(k);
export const isShowableKey = (k) => !isHiddenKey(k) && SAFE_VALUE_RE.test(k);

const dataKeys = (row) => Object.keys(row).filter((k) => !k.startsWith('.'));
function unionKeys(rows) {
  const s = new Set();
  for (const r of rows) for (const k of dataKeys(r)) s.add(k);
  return [...s];
}
function noteSecrets(ctx, rows) {
  for (const r of rows) for (const [k, v] of Object.entries(r)) if (SECRET_RE.test(k) && v) ctx.secrets.add(v);
}
function visibleFields(row) {
  const o = {};
  for (const k of dataKeys(row)) if (!isHiddenKey(k)) o[k] = row[k];
  return o;
}

function pickSample(ids, n = SAMPLE_SIZE) {
  if (ids.length <= n) return ids.slice();
  const out = new Set();
  for (let i = 0; i < n; i++) out.add(ids[Math.round((i * (ids.length - 1)) / (n - 1))]);
  return [...out];
}

function hintFor(e) {
  if (e.code === 'PERMISSION_DENIED') {
    return 'صلاحيات الحساب لا تكفي لقراءة هذه القائمة. لم يُغيَّر شيء في الراوتر. القرار لك: حساب بصلاحيات أوسع أو الاكتفاء بما يُقرأ.';
  }
  if (/no such command|no such item|bad command|unknown|not found/i.test(e.message || '')) {
    return 'الراوتر لا يعرف هذا المسار. إما أن حزمة user-manager غير مثبّتة، أو أن API لا يعرض هذه القائمة في هذا الإصدار. لا يمكن التمييز بين الاحتمالين من هذا الخطأ وحده.';
  }
  return 'رفض الراوتر الأمر بخطأ غير معروف. الرسالة كما وصلت أعلاه.';
}

// ---------------------------------------------------------------- الإحصاءات

function columnStats(rows, key) {
  let present = 0, numeric = 0, sum = 0, max = null, nonZero = 0;
  const counts = new Map();
  for (const r of rows) {
    const v = r[key];
    if (v === undefined) continue;
    present++;
    counts.set(v, (counts.get(v) || 0) + 1);
    if (/^\d+$/.test(v)) {
      const n = Number(v);
      numeric++;
      if (Number.isSafeInteger(n)) {
        sum = sum === null ? null : (Number.isSafeInteger(sum + n) ? sum + n : null);
        if (max === null || n > max) max = n;
        if (n > 0) nonZero++;
      } else sum = null;
    }
  }
  const st = { present, missing: rows.length - present, numeric };
  if (numeric > 0) Object.assign(st, { sum, max, nonZero });
  if (counts.size <= 6) {
    st.values = [...counts].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
  } else {
    st.distinct = counts.size; // عدد فقط: لا تُعرض قيم من صفوف لم تُؤخذ منها العيّنة (الأمثلة من العيّنة وحدها)
  }
  return st;
}

function aggregateUsers(rows, keys) {
  const profileKey = keys.find((k) => k === 'actual-profile') || keys.find((k) => k === 'profile') || null;
  const byProfile = new Map();
  if (profileKey) for (const r of rows) byProfile.set(r[profileKey] || '', (byProfile.get(r[profileKey] || '') || 0) + 1);
  const stats = {};
  for (const k of keys) if (k !== profileKey) stats[k] = columnStats(rows, k);
  return {
    rows: rows.length,
    profileKey,
    byProfile: [...byProfile].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    stats,
  };
}

// ---------------------------------------------------------------- قراءة قائمة

async function probeTable(c, key, meta, ctx, { fullSample }) {
  const out = { key, path: meta.path, title: meta.title, kind: meta.kind, status: 'ok' };
  try {
    if (meta.kind === 'config') {
      const rows = (await c.talk(meta.path, {}, { timeoutMs: HEAVY_MS })).rows;
      noteSecrets(ctx, rows);
      out.count = rows.length;
      out.keys = unionKeys(rows);
      out.rows = rows.slice(0, MAX_CONFIG_ROWS).map(visibleFields);
      out.truncated = rows.length > MAX_CONFIG_ROWS;
      return out;
    }

    // قائمة خاصة: أولاً المعرّفات فقط (لا حقول حساسة) لمعرفة العدد.
    const idRows = (await c.talk(meta.path, { '.proplist': '.id' }, { timeoutMs: HEAVY_MS })).rows;
    out.count = idRows.length;
    out.keys = [];
    if (out.count === 0) return out;

    // ثم عيّنة صغيرة بكل الحقول لاكتشاف الأسماء.
    let sample = [];
    if (fullSample) {
      sample = (await c.talk(meta.path, {}, { timeoutMs: HEAVY_MS })).rows.slice(0, SAMPLE_SIZE);
    } else {
      for (const id of pickSample(idRows.map((r) => r['.id']).filter(Boolean))) {
        const r = (await c.talk(meta.path, {}, { query: [`?.id=${id}`] })).rows;
        if (r[0]) sample.push(r[0]);
      }
    }
    noteSecrets(ctx, sample);
    out.sampleSize = sample.length;
    out.keys = unionKeys(sample);
    out.examples = {};
    for (const k of out.keys.filter(isShowableKey)) {
      const r = sample.find((x) => x[k] !== undefined && x[k] !== '');
      if (r) out.examples[k] = r[k];
    }
    sample = null; // تُهمَل الصفوف فوراً
    if (out.sampleSize === 0) {
      out.warning = 'تعذّر أخذ عيّنة بالاستعلام عن المعرّف، فلم تُكتشف أسماء الحقول. يمكن إعادة الفحص بخيار --full-sample (يقرأ كل الصفوف بكل حقولها ويُهمل القيم في الذاكرة).';
      return out;
    }

    // أخيراً: إحصاءات المستخدمين بحقول مسموحة فقط (لا يُطلب أي حقل حساس من الراوتر).
    const aggKeys = out.keys.filter(isShowableKey);
    if (key === 'user' && aggKeys.length) {
      const rows = (await c.talk(meta.path, { '.proplist': ['.id', ...aggKeys].join(',') }, { timeoutMs: HEAVY_MS })).rows;
      out.aggregate = aggregateUsers(rows, aggKeys);
      if (rows.length !== out.count) out.warning = `تغيّر عدد الصفوف بين القراءتين (${out.count} ثم ${rows.length}).`;
    }
    return out;
  } catch (e) {
    if (e instanceof RosError && (e.code === 'TRAP' || e.code === 'PERMISSION_DENIED')) {
      return { ...out, status: 'error', code: e.code, message: e.message, hint: hintFor(e) };
    }
    throw e; // انقطاع أو مهلة أو بروتوكول: لا نكمل على اتصال قد يحمل ردوداً متأخرة
  }
}

async function readPackage(c) {
  try {
    const rows = (await c.talk('/system/package/print')).rows;
    const um = rows.find((r) => r.name === 'user-manager');
    if (!um) return { found: false, listed: rows.map((r) => r.name).filter(Boolean) };
    return { found: true, version: um.version || null, disabled: um.disabled === 'true', scheduled: um.scheduled || '' };
  } catch (e) {
    if (e instanceof RosError && (e.code === 'TRAP' || e.code === 'PERMISSION_DENIED')) return { error: e.message, code: e.code };
    throw e;
  }
}

// ملخص الباقات مع قيودها وعدد مستخدميها (مشتق من القوائم أعلاه، وليس قراءة جديدة).
function buildProfileSummary(tables) {
  const prof = tables.profile, lim = tables.limitation, link = tables.profileLimitation, user = tables.user;
  if (!prof || prof.status !== 'ok' || !prof.rows.length) return null;
  const limByName = new Map(((lim && lim.status === 'ok' && lim.rows) || []).map((r) => [r.name, r]));
  const links = (link && link.status === 'ok' && link.rows) || [];
  const counts = new Map(((user && user.aggregate && user.aggregate.byProfile) || []).map((x) => [x.name, x.count]));
  const haveCounts = !!(user && user.aggregate && user.aggregate.profileKey);
  return prof.rows.map((p) => ({
    name: p.name || null,
    fields: p,
    limitations: links.filter((l) => l.profile === p.name).map((l) => ({ name: l.limitation || null, link: l, fields: limByName.get(l.limitation) || null })),
    users: haveCounts ? (counts.get(p.name) || 0) : null,
  }));
}

// ---------------------------------------------------------------- حجب القيم السرّية

export function scrubSecrets(text, secrets) {
  let out = text, count = 0;
  const list = [...secrets].filter((s) => typeof s === 'string' && s.length >= 4).sort((a, b) => b.length - a.length);
  for (const s of list) {
    const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // القيم الطويلة تُحجب أينما وردت؛ القصيرة (4 و5 أحرف) تُحجب كوحدة كاملة فقط لتقليل الحجب الخاطئ.
    const re = s.length >= 6 ? new RegExp(esc, 'g') : new RegExp(`(?<![\\p{L}\\p{N}_-])${esc}(?![\\p{L}\\p{N}_-])`, 'gu');
    out = out.replace(re, () => { count++; return '***'; });
  }
  return { text: out, count };
}

// ---------------------------------------------------------------- التقرير النصي

const kv = (o) => Object.entries(o).map(([k, v]) => `${k}=${v === '' ? '""' : v}`).join(' ');
const keysLine = (keys) => (keys.length ? keys.map((k) => (isHiddenKey(k) ? `${k}*` : k)).join(' | ') : '(لا حقول)');

function fmtStats(st) {
  const bits = [`موجود في ${st.present}`];
  if (st.missing) bits.push(`غائب في ${st.missing}`);
  if (st.numeric) bits.push(`رقمي ${st.numeric}`, `المجموع ${st.sum === null ? 'تجاوز الحد' : st.sum}`, `الأعلى ${st.max}`, `غير صفري ${st.nonZero}`);
  if (st.values) bits.push('القيم: ' + st.values.map((x) => `${x.value} (${x.count})`).join('، '));
  else bits.push(`قيم مختلفة ${st.distinct}`);
  return bits.join(' ; ');
}

export function formatReport(r) {
  const L = [];
  const push = (s = '') => L.push(s);
  push('تقرير فحص اليوزر مانجر (قراءة فقط)');
  push(`الوقت: ${r.generatedAt}`);
  push(`الراوتر: RouterOS ${r.system.version || '؟'} | ${r.system.board || '؟'}`);
  const api = r.apiService.api;
  if (api) {
    push(`خدمة API: ${api.disabled ? 'معطّلة' : 'مفعّلة'} على ${api.port || '؟'} | مسموح من: ${api.address ? api.address : 'كل العناوين (غير مقيّد)'}`);
    if (!api.disabled && !api.address) push('تنبيه: API غير مقيّدة بعنوان. قيّدها بشبكتك وعطّلها بعد الفحص (من عندك، الأداة لا تغيّر الراوتر).');
  }
  const p = r.package;
  if (p.error) push(`حزمة user-manager: تعذّر فحص قائمة الحزم (${p.error})`);
  else if (!p.found) push(`حزمة user-manager: غير ظاهرة في قائمة الحزم (الموجود: ${p.listed.join('، ') || 'لا شيء'})`);
  else push(`حزمة user-manager: مثبّتة، الإصدار ${p.version || '؟'}${p.disabled ? '، لكنها معطّلة' : ''}${p.scheduled ? `، مجدولة: ${p.scheduled}` : ''}`);
  push(`الوضع: ${r.fullSample ? 'عيّنة كاملة (--full-sample)' : `عيّنة من ${SAMPLE_SIZE} صفوف كحد أقصى`}`);
  push('الحقول المعلَّمة بنجمة * قيمها محجوبة عمداً.');

  for (const t of Object.values(r.tables)) {
    push();
    push(`== ${t.title} ==`);
    push(`المسار: ${t.path}`);
    if (t.status === 'error') {
      push(`النتيجة: فشل [${t.code}] ${t.message}`);
      push(`المعنى: ${t.hint}`);
      continue;
    }
    push(`النتيجة: نجحت القراءة | عدد الصفوف: ${t.count}`);
    if (t.count === 0) { push('القائمة فارغة (لا بيانات لعرضها).'); continue; }
    if (t.kind === 'config') {
      push(`الحقول: ${keysLine(t.keys)}`);
      t.rows.forEach((row, i) => push(`  ${i + 1}) ${kv(row)}`));
      if (t.truncated) push(`  ... عُرض ${MAX_CONFIG_ROWS} من ${t.count} صفاً`);
    } else {
      push(`الحقول (من عيّنة ${t.sampleSize}): ${keysLine(t.keys)}`);
      if (t.warning) push(`تنبيه: ${t.warning}`);
      const ex = Object.entries(t.examples || {});
      if (ex.length) push('أمثلة قيم (حقول مسموحة فقط): ' + ex.map(([k, v]) => `${k}=${v}`).join(' ; '));
      if (t.aggregate) {
        const a = t.aggregate;
        if (a.profileKey) {
          push(`توزيع المستخدمين حسب ${a.profileKey}:`);
          for (const x of a.byProfile.slice(0, 40)) push(`  ${x.name === '' ? '(بلا باقة)' : x.name}: ${x.count}`);
          if (a.byProfile.length > 40) push(`  ... و${a.byProfile.length - 40} باقة أخرى`);
        }
        push('إحصاءات الحقول المسموحة (على كل الصفوف):');
        for (const [k, st] of Object.entries(a.stats)) push(`  ${k}: ${fmtStats(st)}`);
      }
    }
  }

  if (r.profileSummary) {
    push();
    push('== ملخص الباقات مع قيودها (مشتق من القوائم أعلاه) ==');
    for (const s of r.profileSummary) {
      push(`• ${s.name || '(بلا اسم)'}${s.users === null ? '' : ` — مستخدمون: ${s.users}`}`);
      push(`    الباقة: ${kv(s.fields)}`);
      if (!s.limitations.length) push('    القيود: لا قيد مربوط بها');
      for (const l of s.limitations) {
        const linkExtra = Object.fromEntries(Object.entries(visibleFields(l.link)).filter(([k]) => k !== 'profile' && k !== 'limitation'));
        const extra = Object.keys(linkExtra).length ? ` | الربط: ${kv(linkExtra)}` : '';
        push(`    قيد ${l.name || '؟'}: ${l.fields ? kv(l.fields) : '(غير موجود في قائمة القيود)'}${extra}`);
      }
    }
  }

  const tabs = Object.values(r.tables);
  const ok = tabs.filter((t) => t.status === 'ok');
  push();
  push('== الخلاصة ==');
  push(`قوائم نجحت قراءتها: ${ok.length} من ${tabs.length}`);
  for (const t of tabs.filter((x) => x.status === 'error')) push(`  فشلت: ${t.title} [${t.code}]`);
  push('لم يُرسل أي أمر غير print، ولم يُغيَّر شيء في الراوتر.');
  push('حُجبت قيم حقول أسماء المستخدمين وكلمات المرور والعناوين والتعليقات (الحقول المعلَّمة بـ *).');
  return L.join('\n');
}

// ---------------------------------------------------------------- نقطة الدخول

// يعيد { report, text }. يرمي عند انقطاع الاتصال أو انتهاء المهلة (لا تقرير جزئي).
export async function probeUserManager(c, { fullSample = false, secrets = [], now = () => new Date() } = {}) {
  const ctx = { secrets: new Set(secrets.filter(Boolean)) };
  const sys = await readSystem(c);
  const report = {
    generatedAt: now().toISOString(),
    fullSample,
    system: { version: sys.version, board: sys.board },
    apiService: await readApiService(c),
    package: await readPackage(c),
    tables: {},
    profileSummary: null,
  };
  for (const [key, meta] of Object.entries(UM_TABLES)) report.tables[key] = await probeTable(c, key, meta, ctx, { fullSample });
  report.profileSummary = buildProfileSummary(report.tables);
  const { text, count } = scrubSecrets(formatReport(report), ctx.secrets);
  report.scrubbed = count;
  return { report, text: count ? `${text}\nحُجبت ${count} قيمة سرّية احتياطاً من النص أعلاه.` : text };
}
