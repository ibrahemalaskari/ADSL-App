// راوتر وهمي لقوائم اليوزر مانجر. ليس RouterOS، وبنية الردود فيه من تقدير توثيق v6 وليست من راوتر حقيقي.
// كل البيانات (الباقات والمستخدمون وكلمات المرور) مختلقة للاختبار فقط.
import { fakeRouterHandler, re, done, trap } from './helpers.js';

export const FAKE_PASS_PREFIX = 'PW-secret-';
export const FAKE_USER_PREFIX = 'u00';

export function makeUmData({ users = 120, sessions = 40 } = {}) {
  const profiles = [
    { '.id': '*1', name: '100RY', owner: 'admin', 'name-for-users': '100', validity: '2d', price: '100', 'starts-at': 'logon' },
    { '.id': '*2', name: '200RY', owner: 'admin', 'name-for-users': '200', validity: '4d', price: '200', 'starts-at': 'logon' },
    { '.id': '*3', name: '250جيب', owner: 'admin', 'name-for-users': '250', validity: '4d', price: '250', 'starts-at': 'logon' },
    { '.id': '*4', name: '500RY', owner: 'admin', 'name-for-users': '500', validity: '10d', price: '500', 'starts-at': 'logon' },
  ];
  const limitations = [
    { '.id': '*1', name: '100RY', owner: 'admin', 'transfer-limit': '314572800', 'uptime-limit': '4h' },
    { '.id': '*2', name: '200RY', owner: 'admin', 'transfer-limit': '681574400', 'uptime-limit': '10h' },
    { '.id': '*3', name: '250RY', owner: 'admin', 'transfer-limit': '838860800', 'uptime-limit': '10h' },
    { '.id': '*4', name: '500RY', owner: 'admin', 'transfer-limit': '2097152000', 'uptime-limit': '2d' },
  ];
  const profileLimitations = [
    { '.id': '*1', profile: '100RY', limitation: '100RY' },
    { '.id': '*2', profile: '200RY', limitation: '200RY' },
    { '.id': '*3', profile: '250جيب', limitation: '250RY' },
    { '.id': '*4', profile: '500RY', limitation: '500RY' },
  ];
  const names = profiles.map((p) => p.name);
  const userRows = Array.from({ length: users }, (_, i) => ({
    '.id': '*' + (i + 1).toString(16).toUpperCase(),
    customer: 'admin',
    username: `${FAKE_USER_PREFIX}${String(i).padStart(5, '0')}`,
    password: `${FAKE_PASS_PREFIX}${i}`,
    'actual-profile': names[i % 4],
    'download-used': String(i * 1000),
    'upload-used': String(i * 100),
    'uptime-used': '1h2m3s',
    'last-seen': 'nov/22/2026 18:30:00',
    'active-sessions': i % 10 === 0 ? '1' : '0',
    disabled: 'false',
    incomplete: 'false',
    'caller-id': `AA:BB:CC:00:${String(i % 100).padStart(2, '0')}:01`,
    'ip-address': `10.9.${i % 200}.${(i % 250) + 1}`,
  }));
  const sessionRows = Array.from({ length: sessions }, (_, i) => ({
    '.id': '*' + (i + 1).toString(16).toUpperCase(),
    user: userRows[i % users].username,
    'acct-session-id': `8100${i}`,
    'calling-station-id': `AA:BB:CC:00:${String(i % 100).padStart(2, '0')}:01`,
    'framed-ip-address': `10.9.1.${(i % 250) + 1}`,
    'user-ip': `10.9.2.${(i % 250) + 1}`, // اسما الحقلين من التقرير الحقيقي (ج11)
    'host-ip': `10.9.3.${(i % 250) + 1}`,
    started: 'nov/22/2026 18:00:00',
    ended: 'nov/22/2026 19:00:00',
    'from-time': 'nov/22/2026 18:00:00',
    'till-time': 'nov/22/2026 19:00:00',
    uptime: '1h',
    download: String(i * 5000),
    upload: String(i * 500),
    status: 'closed',
  }));
  return { profiles, limitations, profileLimitations, users: userRows, sessions: sessionRows };
}

const PATHS = {
  '/tool/user-manager/profile/print': 'profiles',
  '/tool/user-manager/profile/limitation/print': 'limitations',
  '/tool/user-manager/profile/profile-limitation/print': 'profileLimitations',
  '/tool/user-manager/user/print': 'users',
  '/tool/user-manager/session/print': 'sessions',
};

// خيارات: missing (القوائم غير معروفة)، deny (قائمة يُرفض الوصول إليها)، noIdQuery (الاستعلام ?.id لا يُرجع شيئاً)،
// dropOn (مسار يقطع الاتصال)، noPackage (حزمة user-manager غير مثبّتة)، data (بيانات بديلة)، mutate(row) لتعديل كل صف مستخدم.
export function fakeUmHandler({ missing = false, deny = [], noIdQuery = false, dropOn = null, noPackage = false, data = makeUmData(), userMutate = null } = {}) {
  const base = fakeRouterHandler({ user: 'reader', pass: 'secret' });
  const users = userMutate ? data.users.map(userMutate) : data.users;
  const tables = { ...data, users };
  return (w, ctx) => {
    const cmd = w[0];
    if (cmd === '/system/package/print') {
      const rows = [{ name: 'system', version: '6.47.6' }, { name: 'routing', version: '6.47.6' }];
      if (!noPackage) rows.push({ name: 'user-manager', version: '6.47.6', disabled: 'false', scheduled: '' });
      return [...rows.map(re), done()];
    }
    if (!PATHS[cmd]) return base(w, ctx);
    if (dropOn === cmd) return 'close';
    if (missing) return [trap('no such command or directory (user-manager)'), done()];
    if (deny.includes(cmd)) return [trap('not enough permissions (9)'), done()];
    const args = {}; const queries = [];
    for (const x of w.slice(1)) {
      if (x.startsWith('=')) { const i = x.indexOf('=', 1); args[x.slice(1, i)] = x.slice(i + 1); }
      else if (x.startsWith('?')) { const i = x.indexOf('='); queries.push([x.slice(1, i), x.slice(i + 1)]); }
    }
    let rows = tables[PATHS[cmd]];
    if (queries.length) {
      if (noIdQuery && queries.some(([k]) => k === '.id')) rows = [];
      else rows = rows.filter((r) => queries.every(([k, v]) => r[k] === v));
    }
    const prop = args['.proplist'] ? args['.proplist'].split(',') : null;
    const out = rows.map((r) => (prop ? Object.fromEntries(Object.entries(r).filter(([k]) => prop.includes(k))) : r));
    return [...out.map(re), done()];
  };
}
