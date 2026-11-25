// قراءة كروت اليوزر مانجر من الراوتر (قراءة فقط: أوامر print فقط عبر العميل).
// تُقرأ حقول محددة فقط: اسم المستخدم (لربط الجلسات)، والباقة الفعلية، والاستهلاك؛ ومن الجلسات: المستخدم ووقت البدء.
// لا تُطلب كلمات المرور ولا العناوين ولا التعليقات. أسماء المستخدمين تبقى في الذاكرة داخل هذه الدالة،
// والناتج تجميعات فقط (قرار المستخدم ج12).
//
// ما لم يُتحقق منه على راوتر حقيقي: اسم حقل المستخدم في قائمة users (يُجرَّب username ثم name)،
// ووحدة download-used وupload-used (مرجّح البايت)، وأن مجموعهما هو ما يقابل transfer-limit.
// لذلك يُرجع القارئ فحص اتساق (sanity) يقارن أعلى استهلاك لكل باقة بحدّها، ليُراجع المستخدم الأرقام قبل الاعتماد.

import { RosError, toCount } from './routeros-api.js';
import { UM_TABLES } from './usermanager.js';
import { aggregateCards, DEFAULT_CARD_CONFIG, isTooOldForFirstSight } from './cards.js';

const HEAVY_MS = 60000;
const NAME_KEYS = ['username', 'name'];
const USER_FIELDS = ['actual-profile', 'download-used', 'upload-used'];

export class CardsError extends Error {
  constructor(code, message) { super(message); this.name = 'CardsError'; this.code = code; }
}

async function readList(c, path, proplist) {
  try {
    return (await c.talk(path, { '.proplist': proplist }, { timeoutMs: HEAVY_MS })).rows;
  } catch (e) {
    if (e instanceof RosError && (e.code === 'TRAP' || e.code === 'PERMISSION_DENIED')) {
      throw new CardsError(e.code === 'PERMISSION_DENIED' ? 'CARDS_PERMISSION' : 'CARDS_LIST_FAILED',
        `تعذّرت قراءة ${path}: ${e.message}`);
    }
    throw e; // انقطاع أو مهلة: لا نكمل
  }
}

// قراءة المستخدمين. نطلب `.id` ومفتاح اسم واحد في كل طلب (كما يفعل فحص اليوزر مانجر الذي نجح على الراوتر الحقيقي)،
// ولا نجرّب المفتاح الثاني إلا إن لم يظهر الأول. (ج14: أول تقرير حقيقي خرج بلا أي `actual-profile` بينما أظهر فحص ج11 أن
// لـ4005 مستخدماً باقة فعلية؛ السبب غير مؤكد، وهذا الطلب يطابق الصيغة التي نجحت، والتشخيص أدناه يبيّن ما وصل فعلاً.)
async function readUsers(c) {
  let rows = [];
  for (const key of NAME_KEYS) {
    rows = await readList(c, UM_TABLES.user.path, ['.id', key, ...USER_FIELDS].join(','));
    if (!rows.length) return { rows, nameKey: undefined };
    if (rows.some((r) => r[key] !== undefined && r[key] !== '')) return { rows, nameKey: key };
  }
  return { rows, nameKey: undefined };
}

// تشخيص: أسماء الحقول التي وصلت فعلاً في صفوف المستخدمين وعدد الصفوف التي فيها قيمة (أسماء حقول وأعداد فقط، بلا قيم).
function fieldCounts(rows) {
  const m = new Map();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      if (k === '.id' || v === undefined || v === '') continue;
      m.set(k, (m.get(k) || 0) + 1);
    }
  }
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
}

// فحص الاتساق: أعلى استهلاك لكل باقة مقابل حدّها (transfer-limit). لا يغيّر شيئاً، ويُهمَل إن تعذّرت قراءة الحدود.
async function readSanity(c, userRows) {
  let limits, links;
  try {
    limits = (await c.talk(UM_TABLES.limitation.path, {}, { timeoutMs: HEAVY_MS })).rows;
    links = (await c.talk(UM_TABLES.profileLimitation.path, {}, { timeoutMs: HEAVY_MS })).rows;
  } catch (e) {
    if (e instanceof RosError && (e.code === 'TRAP' || e.code === 'PERMISSION_DENIED')) return { available: false, reason: e.message };
    throw e;
  }
  const limitBy = new Map(limits.map((l) => [l.name, toCount(l['transfer-limit'])]));
  const profLimit = new Map();
  for (const l of links) if (l.profile && !profLimit.has(l.profile)) profLimit.set(l.profile, limitBy.get(l.limitation) ?? null);

  const by = new Map();
  for (const u of userRows) {
    if (!u.profile) continue;
    const s = by.get(u.profile) || { profile: u.profile, users: 0, withUsage: 0, maxUsedBytes: 0 };
    s.users++;
    if (u.usedBytes) { s.withUsage++; if (u.usedBytes > s.maxUsedBytes) s.maxUsedBytes = u.usedBytes; }
    by.set(u.profile, s);
  }
  const rows = [...by.values()].map((s) => {
    const limit = profLimit.get(s.profile) ?? null;
    return { ...s, limitBytes: limit, ratio: limit ? Math.round((s.maxUsedBytes / limit) * 1000) / 1000 : null };
  }).sort((a, b) => b.users - a.users);
  return { available: true, rows };
}

export async function readCards(c, { config = DEFAULT_CARD_CONFIG, withSanity = true } = {}) {
  const warnings = [];

  const { rows: uRaw, nameKey } = await readUsers(c);
  if (uRaw.length && !nameKey) {
    throw new CardsError('CARDS_NO_USER_KEY', 'لم يُعثر على حقل اسم المستخدم في قائمة المستخدمين (جُرّب: ' + NAME_KEYS.join('، ') + '). شغّل أداة فحص اليوزر مانجر لمعرفة اسم الحقل الفعلي.');
  }

  let badUsage = 0;
  const users = uRaw.map((r) => {
    const dl = r['download-used'], ul = r['upload-used'];
    const d = dl === undefined || dl === '' ? 0 : toCount(dl);
    const u = ul === undefined || ul === '' ? 0 : toCount(ul);
    if (d === null || u === null) badUsage++;
    return { name: r[nameKey], profile: r['actual-profile'] || '', usedBytes: (d || 0) + (u || 0) };
  });
  if (badUsage) warnings.push(`${badUsage} مستخدماً بقيمة استهلاك غير رقمية (لم تُحتسب القيمة غير الصالحة).`);

  const userFields = fieldCounts(uRaw);
  if (uRaw.length && !userFields['actual-profile']) {
    warnings.push('لا مستخدم واحد وصل له حقل actual-profile في هذه القراءة (من ' + uRaw.length + '): لا تُصنَّف كروت ولا يُعرض يوم ولا يُجرى فحص الاتساق. إن كان فحص اليوزر مانجر (um-probe) يُظهر باقات للمستخدمين فالفرق بين القراءتين هو المشكلة؛ أرسل نتيجتيهما.');
  }

  const sRaw = await readList(c, UM_TABLES.session.path, 'user,from-time');
  const sessions = sRaw.map((r) => ({ user: r.user, from: r['from-time'] }));

  const agg = aggregateCards({ users, sessions }, config);
  if (agg.totals.badTimes) warnings.push(`${agg.totals.badTimes} جلسة بوقت بدء غير مفهوم (تُجوهلت).`);
  if (agg.totals.usedWithoutSession) warnings.push(`${agg.totals.usedWithoutSession} مستخدماً له استهلاك بلا أي جلسة ظاهرة (ربما حُذفت الجلسات القديمة)؛ لا يُحتسب لأي يوم.`);
  if (agg.totals.expired) warnings.push(`${agg.totals.expired} كرتاً بلا باقة (منتهية الصلاحية): لا تُنسب لفئة ولا يدخل استهلاكها في L. الأيام التي بدأت بها ناقصة تُعدّ قديمة وتُخفى (قرار المستخدم).`);
  if (Object.keys(agg.unmapped).length) warnings.push('باقات غير مربوطة بفئة (لم تُحتسب): ' + Object.entries(agg.unmapped).map(([k, v]) => `${k} (${v})`).join('، '));

  const sanity = withSanity ? await readSanity(c, users) : null;
  return { agg, sanity, warnings, nameKey, userFields };
}

// ---------------------------------------------------------------- التقرير النصي (بلا أسماء مستخدمين)

const MIB = 1048576;
const mib = (b) => (b / MIB).toFixed(1);
const ACTION_AR = {
  new: 'قراءة أولى (مؤقت)', updated: 'تغيّرت (مؤقت)', unchanged: 'بلا تغيير في اليوم نفسه (مؤقت)', pinned: 'ثُبّت الآن',
  'skipped-pinned': 'مثبّت (القيمة المخزّنة، لم تُحدَّث)', 'skipped-manual': 'إدخال يدوي موجود (لم يُمسّ)',
  'pinned-max': 'نقص الرقم: ثُبّت على أكبر قيمة رُصدت', decreased: 'نقص الرقم في يوم الكروت نفسه: حُفظ الأكبر ولم يُثبَّت بعد',
  'hidden-old': 'يوم قديم مخفي', 'skipped-no-classified-cards': 'لا كروت مصنّفة',
};

// results: ناتج mergeReadings (اختياري)، days: كم يوماً يُعرض (الأحدث أولاً).
// stored: حالة الأيام بعد الدمج (state.d) إن وُجدت؛ فتُعرض القيم المخزّنة (المثبّتة تبقى بقيمتها لا بقيمة القراءة الجديدة).
export function formatCardsReport({ agg, sanity, warnings, nameKey, userFields }, { generatedAt, readOn, days = 14, results = null, stored = null } = {}) {
  const L = [];
  const t = agg.totals;
  L.push('تقرير قراءة كروت اليوزر مانجر (قراءة فقط)');
  L.push(`الوقت: ${generatedAt}`);
  L.push(`يوم الراوتر المعتمد للقراءة: ${readOn}`);
  L.push(`المستخدمون: ${t.users} | فُتح لهم جلسة: ${t.opened + t.ignored + t.unmappedCards} | لم يُفتح: ${t.neverOpened}`);
  L.push(`منها: مصنّفة ${t.opened - t.expired} | منتهية بلا باقة ${t.expired} | باقات متجاهلة ${t.ignored} | غير مربوطة ${t.unmappedCards}`);
  L.push('الأعمدة: عدد الكروت أبو 100 | 200 | 250 | 500 | 1000');
  L.push(`حقل اسم المستخدم المستعمل: ${nameKey || '—'}`);
  if (userFields) {
    const f = Object.entries(userFields).map(([k, n]) => `${k} ${n}`).join(' | ');
    L.push(`حقول وصلت في صفوف المستخدمين (الاسم وعدد الصفوف التي فيها قيمة): ${f || 'لا شيء'}`);
  }

  // الأيام القديمة (بدأت ناقصة بكروت منتهية الصلاحية) تُخفى. مع ناتج الدمج يُعرف اليوم القديم من نتيجته؛
  // وبلا ناتج دمج (بلا ملف حالة) لا يُعرف أيّ يوم كان مكتملاً عند أول قراءة، فيُخفى كل يوم فيه كروت منتهية.
  const byDay = new Map((results || []).map((r) => [r.day, r.action]));
  const allKeys = Object.keys(agg.days).sort().reverse();
  const readDay = (/^\d{4}-\d{2}-\d{2}/.exec(String(readOn || '')) || [null])[0]; // readOn قد يحمل ملاحظة بعد التاريخ
  const isOld = (k) => (results ? ['hidden-old', 'skipped-no-classified-cards'].includes(byDay.get(k)) : (agg.days[k].expired > 0 || isTooOldForFirstSight(k, readDay)));
  const keys = allKeys.filter((k) => !isOld(k));
  const hiddenOld = allKeys.length - keys.length;
  L.push('');
  L.push(`== الأيام: عُرض ${Math.min(days, keys.length)} من ${keys.length} (الأحدث أولاً) ==`);
  for (const k of keys.slice(0, days)) {
    const d = agg.days[k];
    const st = stored && stored[k] && stored[k].lb != null ? stored[k] : null;
    const counts = st ? st.c : d.counts, bytes = st ? st.lb : d.usedBytes;
    const bits = [k, counts.join(' | '), `L=${(bytes / 1073741824).toFixed(4)} جيجا (${mib(bytes)} م.ب)`];
    if (d.expired) bits.push(`منتهية الآن: ${d.expired}`);
    if (byDay.has(k)) bits.push(ACTION_AR[byDay.get(k)] || byDay.get(k));
    L.push(bits.join(' ; '));
  }
  if (hiddenOld) {
    L.push(`أيام قديمة مخفية: ${hiddenOld} (عمرها أكبر من يوم قبل يوم القراءة، أو بدأت ناقصة بكروت منتهية الصلاحية قبل أول قراءة لها)`);
    if (!results) L.push('(بلا --state لا يُعرف أي يوم كان مكتملاً عند أول قراءة، فتُخفى كل الأيام التي فيها كروت منتهية أو التي عمرها أكبر من يوم.)');
  }

  L.push('');
  L.push('== فحص الاتساق: أعلى استهلاك لكل باقة مقابل حدّها ==');
  if (!sanity) L.push('(لم يُطلب)');
  else if (!sanity.available) L.push(`تعذّرت قراءة الحدود: ${sanity.reason}`);
  else if (!sanity.rows.length) L.push('(لا مستخدم له باقة فعلية في هذه القراءة، فلا يوجد ما يُفحص.)');
  else {
    L.push('إن زادت النسبة كثيراً عن 1 فالوحدة أو تعريف الاستهلاك (تنزيل + رفع) يحتاج مراجعة.');
    for (const r of sanity.rows) {
      L.push(`${r.profile}: مستخدمون ${r.users} | بهم استهلاك ${r.withUsage} | الأعلى ${mib(r.maxUsedBytes)} م.ب | الحد ${r.limitBytes == null ? 'غير معروف' : mib(r.limitBytes) + ' م.ب'} | النسبة ${r.ratio == null ? '—' : r.ratio}`);
    }
  }

  if (warnings.length) { L.push(''); L.push('== تنبيهات =='); warnings.forEach((w) => L.push('- ' + w)); }
  L.push('');
  L.push('لم يُرسل أي أمر غير print، ولم يُغيَّر شيء في الراوتر. لا يحتوي التقرير أسماء مستخدمين ولا كلمات مرور.');
  return L.join('\n');
}
