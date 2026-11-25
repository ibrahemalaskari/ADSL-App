// اختبارات قارئ الكروت (core/cardsreader.js) على راوتر وهمي. هذا اختبار منطق وبروتوكول،
// ولا يثبت أن RouterOS الحقيقي يعرض الحقول بهذه الأسماء (اسم حقل المستخدم تحديداً غير مؤكَّد).
import test from 'node:test';
import assert from 'node:assert/strict';
import { RouterOSClient } from '../core/routeros-api.js';
import { UM_TABLES } from '../core/usermanager.js';
import { readCards, formatCardsReport, CardsError } from '../core/cardsreader.js';
import { mergeReadings } from '../core/cards.js';
import { MemTransport } from './helpers.js';
import { fakeUmHandler, makeUmData } from './um-fake.js';

const PW = 'PW-secret-';
const mkUser = (i, name, profile, dl, ul) => ({
  '.id': '*' + (i + 1), customer: 'admin', username: name, password: PW + i, 'actual-profile': profile,
  ...(dl === undefined ? {} : { 'download-used': dl }), ...(ul === undefined ? {} : { 'upload-used': ul }),
  'caller-id': 'AA:BB:CC:00:00:01',
});
const mkSess = (i, user, from) => ({ '.id': '*' + (i + 1), user, 'from-time': from, 'user-ip': '10.9.9.9' });

function data() {
  const d = makeUmData({ users: 0, sessions: 0 });
  d.users = [
    mkUser(0, 'carda-aaa', '100RY', '200000000', '100000000'), // 300000000 بايت
    mkUser(1, 'cardb-bbb', '500RY', '1000', '24'),
    mkUser(2, 'cardc-ccc', '', '5', '5'),                       // منتهية
    mkUser(3, 'cardd-ddd', '3000RY', '1', '1'),                 // متجاهلة
    mkUser(4, 'carde-eee', '100RY'),                            // بلا استهلاك ولا جلسات
  ];
  d.sessions = [
    mkSess(0, 'carda-aaa', 'nov/21/2026 10:00:00'), mkSess(1, 'carda-aaa', 'nov/20/2026 09:00:00'),
    mkSess(2, 'cardb-bbb', 'nov/21/2026 11:00:00'), mkSess(3, 'cardc-ccc', 'nov/10/2026 11:00:00'),
    mkSess(4, 'cardd-ddd', 'nov/21/2026 12:00:00'),
  ];
  return d;
}

async function connected(opts) {
  const t = new MemTransport(fakeUmHandler(opts));
  const c = new RouterOSClient(t, { timeoutMs: 600 });
  await c.connect({ host: '192.168.88.1' });
  await c.login('reader', 'secret');
  return { t, c };
}

const noLeaks = (s) => {
  assert.ok(!s.includes(PW), 'كلمة مرور ظهرت');
  assert.ok(!/card[a-e]-/.test(s), 'اسم مستخدم ظهر');
  assert.ok(!s.includes('AA:BB:CC') && !s.includes('10.9.9.9'), 'MAC أو IP ظهر');
};

test('readCards: يجمّع الكروت حسب أول جلسة، والاستهلاك = تنزيل + رفع، وبلا أسماء في الناتج', async () => {
  const { c } = await connected({ data: data() });
  const r = await readCards(c);
  assert.equal(r.nameKey, 'username');
  assert.deepEqual(r.agg.days['2026-11-20'], { counts: [1, 0, 0, 0, 0], usedBytes: 300000000, expired: 0 });
  assert.deepEqual(r.agg.days['2026-11-21'], { counts: [0, 0, 0, 1, 0], usedBytes: 1024, expired: 0 });
  assert.deepEqual(r.agg.days['2026-11-10'], { counts: [0, 0, 0, 0, 0], usedBytes: 0, expired: 1 });
  assert.equal(r.agg.totals.ignored, 1);
  assert.equal(r.agg.totals.neverOpened, 1);
  noLeaks(JSON.stringify(r));
});

test('readCards: قراءة فقط، ولا يُطلب حقل كلمة المرور ولا أي حقل هوية غير الاسم', async () => {
  const { t, c } = await connected({ data: data() });
  await readCards(c);
  const sent = t.written.filter((w) => w[0] !== '/login');
  assert.ok(sent.length >= 4);
  for (const w of sent) assert.ok(w[0].endsWith('/print'), `أمر غير print: ${w[0]}`);
  const proplists = sent.flatMap((w) => w.filter((x) => x.startsWith('=.proplist='))).join(' ');
  assert.ok(!/pass|caller|ip|comment/i.test(proplists), 'حقل حساس في proplist: ' + proplists);
  assert.ok(proplists.includes('download-used') && proplists.includes('from-time'));
});

test('readCards: فحص الاتساق يقارن أعلى استهلاك لكل باقة بحدّها', async () => {
  const { c } = await connected({ data: data() });
  const { sanity } = await readCards(c);
  assert.equal(sanity.available, true);
  const p100 = sanity.rows.find((x) => x.profile === '100RY');
  assert.deepEqual([p100.users, p100.withUsage, p100.maxUsedBytes, p100.limitBytes], [2, 1, 300000000, 314572800]);
  assert.equal(p100.ratio, 0.954);
  const p500 = sanity.rows.find((x) => x.profile === '500RY');
  assert.equal(p500.limitBytes, 2097152000);
});

test('readCards: تعذّر قراءة الحدود لا يُسقط القراءة، ويُعلَن في الفحص', async () => {
  const { c } = await connected({ data: data(), deny: [UM_TABLES.limitation.path] });
  const r = await readCards(c);
  assert.equal(r.sanity.available, false);
  assert.ok(r.agg.days['2026-11-20']);
});

test('readCards: غياب حقل اسم المستخدم خطأ صريح لا تخمين', async () => {
  const { c } = await connected({ data: data(), userMutate: ({ username, ...rest }) => rest });
  await assert.rejects(() => readCards(c), (e) => e instanceof CardsError && e.code === 'CARDS_NO_USER_KEY' && /username/.test(e.message));
});

test('readCards: رفض الصلاحيات خطأ مفهوم، وانقطاع الاتصال استثناء بلا نتيجة جزئية', async () => {
  const a = await connected({ data: data(), deny: [UM_TABLES.session.path] });
  await assert.rejects(() => readCards(a.c), (e) => e instanceof CardsError && e.code === 'CARDS_PERMISSION');
  const b = await connected({ data: data(), dropOn: UM_TABLES.session.path });
  await assert.rejects(() => readCards(b.c), (e) => !(e instanceof CardsError));
});

test('readCards: قيمة استهلاك غير رقمية تُنبَّه ولا تُحتسب، وجلسة بوقت غير مفهوم تُنبَّه', async () => {
  const d = data();
  d.users[0]['download-used'] = '1.5GiB';
  d.sessions.push(mkSess(9, 'carda-aaa', 'not-a-time'));
  const { c } = await connected({ data: d });
  const r = await readCards(c);
  assert.ok(r.warnings.some((w) => /غير رقمية/.test(w)));
  assert.ok(r.warnings.some((w) => /وقت بدء غير مفهوم/.test(w)));
  assert.equal(r.agg.days['2026-11-20'].usedBytes, 100000000); // الرفع فقط
});

test('formatCardsReport: تقرير بلا أسماء، فيه الأيام والتنبيهات وفحص الاتساق وحالة التثبيت', async () => {
  const { c } = await connected({ data: data() });
  const r = await readCards(c);
  const first = mergeReadings({ d: {} }, r.agg, '2026-11-21');
  const second = mergeReadings(first.state, r.agg, '2026-11-22');
  const text = formatCardsReport(r, { generatedAt: '2026-11-23T00:35:58.000Z', readOn: '2026-11-22', days: 14, results: second.results });
  noLeaks(text);
  assert.match(text, /2026-11-21 ; 0 \| 0 \| 0 \| 1 \| 0 ; L=0\.0000 جيجا/);
  assert.match(text, /2026-11-20 ; 1 \| 0 \| 0 \| 0 \| 0 ; L=0\.2794 جيجا/);
  assert.match(text, /ثُبّت الآن/);
  assert.match(text, /أيام قديمة مخفية: 1/);
  assert.ok(!/2026-11-10 ;/.test(text), 'اليوم القديم (كروته منتهية) لا يُعرض');
  assert.ok(!/غير مكتمل/.test(text));
  assert.match(text, /100RY: مستخدمون 2/);
  assert.match(text, /تنبيهات/);
});

test('formatCardsReport: اليوم المثبّت يُعرض بقيمته المخزّنة لا بقيمة القراءة الجديدة', async () => {
  const { c } = await connected({ data: data() });
  const r = await readCards(c);
  const s1 = mergeReadings({ d: {} }, r.agg, '2026-11-21');
  const s2 = mergeReadings(s1.state, r.agg, '2026-11-22'); // 2026-11-20 يُثبَّت هنا بـ 300000000
  assert.equal(s2.state.d['2026-11-20'].lp, true);
  r.agg.days['2026-11-20'].usedBytes = 999999999; // راوتر «تغيّرت بياناته» بعد التثبيت
  const s3 = mergeReadings(s2.state, r.agg, '2026-11-23');
  const text = formatCardsReport(r, { generatedAt: 'x', readOn: '2026-11-23', results: s3.results, stored: s3.state.d });
  assert.match(text, /2026-11-20 ; 1 \| 0 \| 0 \| 0 \| 0 ; L=0\.2794 جيجا .*مثبّت \(القيمة المخزّنة/);
  assert.ok(!text.includes('0.9313'), 'قيمة القراءة الجديدة لا تظهر لليوم المثبّت');
});

test('formatCardsReport: بلا ملف حالة تُخفى الأيام التي فيها كروت منتهية، مع تنبيه أن التمييز غير ممكن', async () => {
  const { c } = await connected({ data: data() });
  const r = await readCards(c);
  const text = formatCardsReport(r, { generatedAt: 'x', readOn: '2026-11-21', days: 14 });
  assert.match(text, /2026-11-21 ;/);
  assert.match(text, /2026-11-20 ;/);
  assert.ok(!/2026-11-10 ;/.test(text));
  assert.match(text, /أيام قديمة مخفية: 1/);
  assert.match(text, /بلا --state لا يُعرف/);
});

test('formatCardsReport: يوم ثُبّت على الأكبر بعد نقصان يُعرض بقيمته المخزّنة مع عبارة التثبيت على الأكبر', async () => {
  const { c } = await connected({ data: data() });
  const r = await readCards(c);
  const s1 = mergeReadings({ d: {} }, r.agg, '2026-11-21');
  r.agg.days['2026-11-20'] = { counts: [0, 0, 0, 0, 0], usedBytes: 0, expired: 1 }; // كرت اليوم انتهى واختفى
  const s2 = mergeReadings(s1.state, r.agg, '2026-11-22');
  assert.equal(s2.results.find((x) => x.day === '2026-11-20').action, 'pinned-max');
  const text = formatCardsReport(r, { generatedAt: 'x', readOn: '2026-11-22', results: s2.results, stored: s2.state.d });
  assert.match(text, /2026-11-20 ; 1 \| 0 \| 0 \| 0 \| 0 ; L=0\.2794 جيجا .*ثُبّت على أكبر قيمة رُصدت/);
});

// ---------------------------------------------------------------- ج14: أول تقرير حقيقي خرج بلا أي actual-profile

const userReqs = (t) => t.written.filter((w) => w[0] === UM_TABLES.user.path);
const proplistOf = (w) => (w.find((x) => x.startsWith('=.proplist=')) || '').slice('=.proplist='.length);

test('readCards: طلب المستخدمين يطابق صيغة الفحص الناجح (.id ومفتاح اسم واحد) ولا يطلب name ما دام username يعمل', async () => {
  const { t, c } = await connected({ data: data() });
  const r = await readCards(c);
  const reqs = userReqs(t);
  assert.equal(reqs.length, 1, 'طلب واحد فقط للمستخدمين');
  assert.equal(proplistOf(reqs[0]), '.id,username,actual-profile,download-used,upload-used');
  assert.equal(r.nameKey, 'username');
});

test('readCards: إن لم يظهر username يُجرَّب name في طلب منفصل، ويعمل التجميع بالمفتاح الثاني', async () => {
  const { t, c } = await connected({ data: data(), userMutate: ({ username, ...rest }) => ({ ...rest, name: username }) });
  const r = await readCards(c);
  assert.equal(r.nameKey, 'name');
  assert.deepEqual(userReqs(t).map(proplistOf), [
    '.id,username,actual-profile,download-used,upload-used',
    '.id,name,actual-profile,download-used,upload-used',
  ]);
  assert.deepEqual(r.agg.days['2026-11-20'], { counts: [1, 0, 0, 0, 0], usedBytes: 300000000, expired: 0 });
});

test('readCards: يُرجع أسماء الحقول التي وصلت وأعدادها (بلا قيم)، ويطبعها التقرير مع حقل الاسم المستعمل', async () => {
  const { c } = await connected({ data: data() });
  const r = await readCards(c);
  assert.deepEqual(r.userFields, { username: 5, 'actual-profile': 4, 'download-used': 4, 'upload-used': 4 });
  const text = formatCardsReport(r, { generatedAt: 'x', readOn: '2026-11-23' });
  assert.match(text, /حقل اسم المستخدم المستعمل: username/);
  assert.match(text, /username 5 \| actual-profile 4 \| download-used 4 \| upload-used 4/);
  noLeaks(text);
  assert.ok(!/\.id/.test(text.split('\n').filter((l) => /حقول وصلت/.test(l)).join('')), 'المعرّف الداخلي لا يُعدّ');
});

test('readCards: لا actual-profile لأي مستخدم ← تنبيه صريح وسطر في فحص الاتساق، لا قسم فارغ صامت', async () => {
  const { c } = await connected({ data: data(), userMutate: ({ 'actual-profile': _p, ...rest }) => rest });
  const r = await readCards(c);
  assert.equal(r.userFields['actual-profile'], undefined);
  assert.ok(r.warnings.some((w) => /لا مستخدم واحد وصل له حقل actual-profile/.test(w) && /um-probe/.test(w)));
  assert.equal(r.sanity.available, true);
  assert.equal(r.sanity.rows.length, 0);
  const text = formatCardsReport(r, { generatedAt: 'x', readOn: '2026-11-23' });
  assert.match(text, /لا مستخدم له باقة فعلية في هذه القراءة/);
  assert.match(text, /لا مستخدم واحد وصل له حقل actual-profile/);
  assert.ok(!/actual-profile \d/.test(text), 'الحقل الغائب لا يُدرج في أسطر الحقول');
  noLeaks(text);
});

test('readCards: قائمة مستخدمين فارغة لا تنتج تنبيه الباقة ولا خطأ، وطلب واحد فقط', async () => {
  const d = makeUmData({ users: 0, sessions: 0 });
  const { t, c } = await connected({ data: d });
  const r = await readCards(c);
  assert.equal(userReqs(t).length, 1);
  assert.equal(r.nameKey, undefined);
  assert.ok(!r.warnings.some((w) => /actual-profile/.test(w)));
});

// ج15: يوم قديم بكرت لم تنتهِ باقته (لا كروت منتهية فيه) يُخفى بسبب العمر، بملف حالة وبلا ملف حالة.
test('formatCardsReport (ج15): يوم قديم بلا كروت منتهية يُخفى بسبب العمر مع حالة ودونها، ولا يُكتب في الحالة', async () => {
  const d = data();
  d.users.push(mkUser(5, 'carda-zzz', '250RY', '1000', '24'));
  d.sessions.push(mkSess(5, 'carda-zzz', 'nov/05/2026 10:00:00')); // عمره 16 يوماً، وباقته ما زالت قائمة
  const { c } = await connected({ data: d });
  const r = await readCards(c);
  assert.deepEqual(r.agg.days['2026-11-05'], { counts: [0, 0, 1, 0, 0], usedBytes: 1024, expired: 0 });

  const noState = formatCardsReport(r, { generatedAt: 'x', readOn: '2026-11-21', days: 14 });
  noLeaks(noState);
  assert.ok(!/2026-11-05 ;/.test(noState), 'اليوم القديم لا يُعرض بلا ملف حالة');
  assert.ok(!/2026-11-10 ;/.test(noState));
  assert.match(noState, /أيام قديمة مخفية: 2/);
  assert.match(noState, /2026-11-20 ;/);

  const m = mergeReadings({ d: {} }, r.agg, '2026-11-21');
  const withState = formatCardsReport(r, { generatedAt: 'x', readOn: '2026-11-21', days: 14, results: m.results, stored: m.state.d });
  assert.ok(!/2026-11-05 ;/.test(withState));
  assert.match(withState, /أيام قديمة مخفية: 2/);
  assert.equal(m.state.d['2026-11-05'], undefined);
  assert.deepEqual(Object.keys(m.state.d).sort(), ['2026-11-20', '2026-11-21']);
});
