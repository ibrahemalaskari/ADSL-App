// استخراج مبيعات User Manager في RouterOS v6 وتجميعها بصورة قابلة لإعادة المزامنة.
// لا تُقرأ كلمات المرور أو IP/MAC أو التعليقات. السعر يربط محلياً بالباقة لأن أمر
// المدفوعات الخاص بإصدار MUMS v6 (Mer.asa) غير مكشوف في تحليل التطبيق القديم.
import { RosError } from './routeros-api.js';

const SESSION_PATH = '/tool/user-manager/session/print';
const USER_PATH = '/tool/user-manager/user/print';
const HEAVY_MS = 60000;
const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };

export class SalesReadError extends Error {
  constructor(code, message) { super(message); this.name = 'SalesReadError'; this.code = code; }
}

export function parseRouterLocalDate(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) return makeDate(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = /^([A-Za-z]{3})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return makeDate(+m[3], MONTHS[m[1].toLowerCase()], +m[2], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return null;
}
function makeDate(y, m, d, hh, mm, ss) {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d || hh > 23 || mm > 59 || ss > 59) return null;
  const day = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  return { day, startedAt: `${day} ${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}` };
}

export function parseRouterBytes(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function parseRouterUptime(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  let dayClock = /^(\d+)d(\d{1,3}):([0-5]\d):([0-5]\d)$/.exec(s);
  if (dayClock) return Number(dayClock[1]) * 86400 + Number(dayClock[2]) * 3600 + Number(dayClock[3]) * 60 + Number(dayClock[4]);
  if (/^\d{1,3}:[0-5]\d:[0-5]\d$/.test(s)) {
    const [h,m,sec] = s.split(':').map(Number);
    return h * 3600 + m * 60 + sec;
  }
  const re = /(\d+)(w|d|h|m|s)/g;
  let match, total = 0, consumed = '', found = false;
  const scale = { w:604800, d:86400, h:3600, m:60, s:1 };
  while ((match = re.exec(s))) { found = true; consumed += match[0]; total += Number(match[1]) * scale[match[2]]; }
  return found && consumed === s ? (Number.isSafeInteger(total) ? total : null) : null;
}

const cleanText = (v, max = 255) => v == null ? '' : String(v).trim().slice(0, max);

export function aggregateSales({ sessions = [], users = [], routerKey, profilePrices = {} } = {}) {
  if (!Array.isArray(sessions) || !Array.isArray(users)) throw new TypeError('قوائم الجلسات والمستخدمين غير صالحة');
  if (!routerKey || typeof routerKey !== 'string') throw new TypeError('هوية الراوتر غير محددة');
  const warnings = [];
  const userProfiles = new Map();
  for (const u of users) {
    const name = cleanText(u.username || u.name);
    if (!name) continue;
    const profile = cleanText(u.profile || u['actual-profile'], 200);
    if (profile && !userProfiles.has(name)) userProfiles.set(name, profile);
    else if (profile && userProfiles.get(name) !== profile) warnings.push(`المستخدم ${name}: ظهرت له أكثر من باقة؛ استُخدمت أول باقة.`);
  }

  const groups = new Map();
  const seenIds = new Set();
  let duplicateSessions = 0, invalidDates = 0, invalidTraffic = 0, missingNames = 0;
  for (const raw of sessions) {
    const username = cleanText(raw.user || raw.username, 255);
    if (!username) { missingNames++; continue; }
    const sid = cleanText(raw['.id'] || raw.id, 160);
    if (sid && seenIds.has(sid)) { duplicateSessions++; continue; }
    if (sid) seenIds.add(sid);
    const parsed = parseRouterLocalDate(raw['from-time'] || raw.started || raw['start-time']);
    if (!parsed) { invalidDates++; continue; }
    const down = parseRouterBytes(raw.download);
    const up = parseRouterBytes(raw.upload);
    if (down == null || up == null) invalidTraffic++;
    const uptime = parseRouterUptime(raw.uptime);
    const s = {
      sid,
      parsed,
      nasPortId: cleanText(raw['nas-port-id'], 200),
      downloadBytes: down ?? 0,
      uploadBytes: up ?? 0,
      uptimeSeconds: uptime ?? 0,
      trafficComplete: down != null && up != null,
      durationComplete: uptime != null,
    };
    const list = groups.get(username) || [];
    list.push(s);
    groups.set(username, list);
  }

  const records = [];
  for (const [username, list] of groups) {
    list.sort((a,b) => a.parsed.startedAt.localeCompare(b.parsed.startedAt) || a.sid.localeCompare(b.sid));
    const first = list[0];
    const profile = userProfiles.get(username) || '';
    const priceRaw = profile ? profilePrices[profile] : null;
    const price = priceRaw == null || priceRaw === '' ? null : Number(priceRaw);
    const downloadBytes = list.reduce((n,x) => n + x.downloadBytes, 0);
    const uploadBytes = list.reduce((n,x) => n + x.uploadBytes, 0);
    const uptimeSeconds = list.reduce((n,x) => n + x.uptimeSeconds, 0);
    const trafficComplete = list.every(x => x.trafficComplete);
    const durationComplete = list.every(x => x.durationComplete);
    if (![downloadBytes, uploadBytes, uptimeSeconds].every(Number.isSafeInteger)) {
      warnings.push(`المستخدم ${username}: تجاوز مجموع حركة البيانات الحد الرقمي؛ لم يُدرج.`);
      continue;
    }
    const identity = first.sid || first.parsed.startedAt;
    const saleKey = `${encodeURIComponent(routerKey)}::${encodeURIComponent(username)}::${encodeURIComponent(identity)}`;
    records.push({
      saleKey, username, profile, saleDay: first.parsed.day, startedAt: first.parsed.startedAt,
      nasPortId: first.nasPortId, firstSessionId: first.sid || null,
      sessionCount: list.length, downloadBytes, uploadBytes, uptimeSeconds, trafficComplete, durationComplete,
      price: Number.isFinite(price) && price >= 0 ? price : null,
    });
  }
  const profiles = [...new Set(users.map(u => cleanText(u.profile || u['actual-profile'], 200)).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  if (duplicateSessions) warnings.push(`تم تجاهل ${duplicateSessions} جلسة مكررة.`);
  if (invalidDates) warnings.push(`تم تجاهل ${invalidDates} جلسة لوقت بدء غير مفهوم.`);
  if (invalidTraffic) warnings.push(`${invalidTraffic} جلسة بها قراءة تنزيل/رفع ناقصة أو غير رقمية؛ القيمة الجزئية لا تُعد قراءة مكتملة.`);
  const invalidUptime = sessions.filter(raw => parseRouterLocalDate(raw?.['from-time'] || raw?.started || raw?.['start-time']) && parseRouterUptime(raw?.uptime) == null).length;
  if (invalidUptime) warnings.push(`${invalidUptime} جلسة بها مدة اتصال ناقصة أو غير مفهومة.`);
  if (missingNames) warnings.push(`تم تجاهل ${missingNames} جلسة بلا اسم مستخدم.`);
  const sessionCount = records.reduce((n,x)=>n+x.sessionCount,0);
  return { records, profiles, warnings: [...new Set(warnings)], summary: {
    vouchers: records.length, sessions: sessionCount,
    unpriced: records.filter(x=>x.price==null).length,
    priced: records.filter(x=>x.price!=null).length,
    downloadBytes: records.reduce((n,x)=>n+x.downloadBytes,0),
    uploadBytes: records.reduce((n,x)=>n+x.uploadBytes,0),
    incompleteTraffic: records.filter(x=>!x.trafficComplete).length,
    incompleteDuration: records.filter(x=>!x.durationComplete).length,
  } };
}

async function readUsers(c) {
  let rows = await c.talk(USER_PATH, { '.proplist': '.id,username,actual-profile' }, { timeoutMs: HEAVY_MS });
  let nameKey = rows.rows.some(r => r.username) ? 'username' : null;
  if (!nameKey) {
    rows = await c.talk(USER_PATH, { '.proplist': '.id,name,actual-profile' }, { timeoutMs: HEAVY_MS });
    nameKey = rows.rows.some(r => r.name) ? 'name' : null;
  }
  if (rows.rows.length && !nameKey) throw new SalesReadError('SALES_NO_USER_KEY', 'لم يظهر حقل اسم المستخدم في قائمة User Manager.');
  return rows.rows.map(r => ({ username: r[nameKey] || '', profile: r['actual-profile'] || '' }));
}

export async function readRouterSales(c, { routerKey } = {}) {
  try {
    // RouterOSClient talk لا يضع tags لطلبات متوازية؛ نفّذ القائمتين بالتتابع كي لا تختلط الردود.
    const sessionResult = await c.talk(SESSION_PATH, { '.proplist': '.id,user,from-time,nas-port-id,download,upload,uptime' }, { timeoutMs: HEAVY_MS });
    const users = await readUsers(c);
    return aggregateSales({ sessions: sessionResult.rows, users, routerKey });
  } catch (e) {
    if (e instanceof SalesReadError) throw e;
    if (e instanceof RosError && (e.code === 'TRAP' || e.code === 'PERMISSION_DENIED')) {
      throw new SalesReadError(e.code === 'PERMISSION_DENIED' ? 'SALES_PERMISSION' : 'SALES_LIST_FAILED', `تعذّرت قراءة بيانات مبيعات User Manager: ${e.message}`);
    }
    throw e;
  }
}
