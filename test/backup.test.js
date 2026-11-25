import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBackup, parseBackup, serializeBackup, describeBackup, restoreBackup, mergeBackupState, validateState,
  findSecretKeys, canonicalJson, crc32, backupFileName, BackupError, BACKUP_VERSION,
} from '../core/backup.js';
import { createLog } from '../core/oplog.js';
import { mergeReadings } from '../core/cards.js';

const NOW = Date.UTC(2026, 10, 23, 2, 30, 0);
const GB = 1073741824;

// حالة تحاكي بنية الواجهة + أيام مقروءة من الراوتر (lb/lp/lr/lx)
const mkState = () => ({
  d: {
    '2026-11-20': { b: [85.7, 0, 20.26], s: 7700, p: 25.59, c: [17, 15, 8, 0, 1] },                 // يدوي
    '2026-11-21': { b: [74.53, 0, 9.89], o: [null, null, 11.6], s: 7500 },                       // أرصدة فقط
    '2026-11-22': { p: 0.7451, c: [1, 2, 0, 0, 0], lb: 0.7451 * GB, lp: true, lr: '2026-11-24', lx: 0 },  // مقروء ومثبّت
    '2026-11-23': { p: 0.5, c: [1, 0, 0, 0, 0], lb: 0.5 * GB, lp: false, lr: '2026-11-23', lx: 2 },       // مقروء غير مثبّت
  },
  op: { '2026-11': [90, 0, 30] },
  vn: { 0: 'البيت', 3: 'الدكان' },
});
const mk = (extra = {}, opts = {}) => createBackup({ state: mkState(), ...extra }, { now: NOW, appVersion: '0.6.0', ...opts });
const code = (c) => (e) => e instanceof BackupError && e.code === c;

test('crc32: القيمة القياسية لـ 123456789 وللنص الفارغ', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 'cbf43926');
  assert.equal(crc32(new Uint8Array(0)), '00000000');
});

test('canonicalJson: ترتيب المفاتيح ثابت، ويرفض ما لا يُحفظ بأمانة', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: null }] }), '{"a":[2,{"c":null,"d":1}],"b":1}');
  assert.equal(canonicalJson({ a: 1, u: undefined }), '{"a":1}', 'undefined يُهمل كما في JSON');
  assert.throws(() => canonicalJson({ a: NaN }), code('BACKUP_VALUE'));
  assert.throws(() => canonicalJson({ a: Infinity }), code('BACKUP_VALUE'));
  assert.throws(() => canonicalJson({ a: new Date() }), code('BACKUP_VALUE'));
  assert.throws(() => canonicalJson({ a: () => 1 }), code('BACKUP_VALUE'));
});

test('validateState: يقبل بنية الواجهة وحقول الكروت، ويكشف الأخطاء بمسارها', () => {
  assert.deepEqual(validateState(mkState()), []);
  assert.deepEqual(validateState({ d: {} }), []);
  assert.deepEqual(validateState({ d: { '2026-11-20': { newField: { x: 1 } } } }), [], 'حقل غير معروف يُترك');
  const probs = validateState({
    d: { '2026-02-30': {}, '2026-13-01': {}, 'x': {}, '2026-11-20': { b: [1, 2, 3, 4], o: ['a'], c: 'no', s: '5', p: NaN, lb: -1, lp: 1, lr: 5, lx: 1.5 }, '2026-11-21': 7 },
    op: { '2026-11': [1], '26-11': [1], '2026-10': [null, 'z'] },
    vn: { a: 'x', 1: 5 },
  });
  const text = probs.join('\n');
  for (const frag of ['d.2026-02-30', 'd.2026-13-01', 'd.x', 'd.2026-11-20.b', 'd.2026-11-20.o[0]', 'd.2026-11-20.c', 'd.2026-11-20.s', 'd.2026-11-20.p', 'd.2026-11-20.lb', 'd.2026-11-20.lp', 'd.2026-11-20.lr', 'd.2026-11-20.lx', 'd.2026-11-21', 'op.26-11', 'op.2026-10[1]', 'vn.a', 'vn.1']) {
    assert.ok(text.includes(frag), `يجب أن يُذكر ${frag}`);
  }
  assert.ok(probs.length <= 20, 'عدد المشاكل المعروضة محدود');
  assert.ok(validateState(null).length && validateState({}).length && validateState({ d: [] }).length);
});

test('createBackup: غلاف صحيح بمجموع تحقق، ولا يغيّر الحالة الأصلية', () => {
  const st = mkState();
  const before = JSON.stringify(st);
  const b = createBackup({ state: st }, { now: NOW, appVersion: '0.6.0' });
  assert.equal(b.format, 'adsl-backup');
  assert.equal(b.version, BACKUP_VERSION);
  assert.equal(b.createdAt, '2026-11-23T02:30:00.000Z');
  assert.match(b.checksum, /^crc32:[0-9a-f]{8}$/);
  assert.equal(JSON.stringify(st), before);
  b.data.state.d['2026-11-20'].s = 1;
  assert.equal(st.d['2026-11-20'].s, 7700, 'النسخة مستقلة عن الأصل');
  // حتمية: نفس المدخل ينتج نفس المجموع
  assert.equal(mk().checksum, mk().checksum);
});

test('createBackup: يرفض حالة غير سليمة وأسراراً وإعدادات باطلة', () => {
  assert.throws(() => createBackup({ state: { d: { bad: {} } } }, { now: NOW }), (e) => e.code === 'BACKUP_BAD_STATE' && e.details.length > 0);
  assert.throws(() => createBackup({}, { now: NOW }), code('BACKUP_BAD_STATE'));
  assert.throws(() => mk({ settings: { host: '10.0.0.1', password: 'abc' } }), (e) => e.code === 'BACKUP_SECRET' && e.details.includes('$.settings.password'));
  assert.throws(() => mk({ settings: { nested: { rosPass: 'x' } } }), code('BACKUP_SECRET'));
  assert.throws(() => mk({ settings: [1] }), code('BACKUP_BAD_SETTINGS'));
  assert.throws(() => mk({ log: { entries: 'x' } }), code('BACKUP_BAD_LOG'));
  assert.throws(() => createBackup({ state: mkState() }, { now: NaN }), code('BACKUP_BAD_TIME'));
  // رسالة الخطأ لا تحمل القيمة السرّية نفسها
  try { mk({ settings: { password: 'S3CRET-VALUE' } }); } catch (e) { assert.ok(!JSON.stringify([e.message, e.details]).includes('S3CRET-VALUE')); }
  assert.deepEqual(findSecretKeys({ a: [{ token: 1 }], ok: 1 }), ['$.a[0].token']);
});

test('دورة كاملة: createBackup ثم serialize ثم parse تعيد الحالة نفسها تماماً', () => {
  const log = createLog({ now: () => NOW });
  log.info('SYNC_OK', 'تمت', { days: 2 });
  const b = mk({ settings: { wan: { WAN1: 'الفورجي', WAN2: 'Adsl 8M', WAN3: 'Adsl 4M' } }, log: log.snapshot() });
  const back = parseBackup(serializeBackup(b));
  assert.deepEqual(back, b);
  assert.deepEqual(back.data.state, mkState());
  const r = restoreBackup({ state: { d: {}, op: {} } }, back, { mode: 'replace' });
  assert.deepEqual(r.state, mkState());
  assert.deepEqual(r.settings, { wan: { WAN1: 'الفورجي', WAN2: 'Adsl 8M', WAN3: 'Adsl 4M' } });
  assert.equal(r.logSnapshot.entries.length, 1);
});

test('parseBackup: لا استعادة جزئية: كل خلل يرفض الملف برمز واضح', () => {
  const good = serializeBackup(mk());
  assert.doesNotThrow(() => parseBackup(good));
  assert.doesNotThrow(() => parseBackup('\uFEFF' + good), 'BOM يُتجاوز');
  assert.throws(() => parseBackup(42), code('BACKUP_PARSE'));
  assert.throws(() => parseBackup(good.slice(0, good.length - 30)), code('BACKUP_PARSE'), 'ملف مبتور');
  assert.throws(() => parseBackup('{"hello":1}'), code('BACKUP_FORMAT'));
  assert.throws(() => parseBackup('[]'), code('BACKUP_FORMAT'));
  const o = JSON.parse(good);
  const re = (fn) => { const c = JSON.parse(good); fn(c); return JSON.stringify(c); };
  assert.throws(() => parseBackup(re((c) => { c.version = 0; })), code('BACKUP_FORMAT'));
  assert.throws(() => parseBackup(re((c) => { c.version = 99; })), code('BACKUP_NEWER'));
  assert.throws(() => parseBackup(re((c) => { delete c.data.state; })), code('BACKUP_STRUCTURE'));
  assert.throws(() => parseBackup(re((c) => { delete c.checksum; })), code('BACKUP_CHECKSUM'));
  assert.throws(() => parseBackup(re((c) => { c.data.state.d['2026-11-20'].s = 1; })), code('BACKUP_CHECKSUM'), 'تعديل رقم واحد');
  assert.throws(() => parseBackup(re((c) => { c.createdAt = '2020-01-01T00:00:00.000Z'; })), code('BACKUP_CHECKSUM'), 'الغلاف مشمول بالمجموع');
  assert.equal(o.checksum, mk().checksum);
});

test('parseBackup: بنية حالة غير سليمة أو أسرار بمجموع تحقق صحيح تُرفض أيضاً', () => {
  // نعيد حساب المجموع بالدالتين نفسيهما ليكون الخلل في البنية لا في المجموع
  const forge = (mut) => {
    const c = JSON.parse(serializeBackup(mk()));
    mut(c);
    const body = canonicalJson({ format: c.format, version: c.version, createdAt: c.createdAt, appVersion: c.appVersion, data: c.data });
    c.checksum = 'crc32:' + crc32(new TextEncoder().encode(body));
    return JSON.stringify(c);
  };
  assert.throws(() => parseBackup(forge((c) => { c.data.state.d['2026-11-20'].b = ['x']; })), (e) => e.code === 'BACKUP_BAD_STATE' && e.details.some((m) => m.includes('b[0]')));
  assert.throws(() => parseBackup(forge((c) => { c.data.settings = { password: 'x' }; })), code('BACKUP_SECRET'));
  assert.throws(() => parseBackup(forge((c) => { c.data.settings = [1]; })), code('BACKUP_BAD_SETTINGS'));
  assert.throws(() => parseBackup(forge((c) => { c.data.log = { entries: 5 }; })), code('BACKUP_BAD_LOG'));
  assert.doesNotThrow(() => parseBackup(forge(() => {})), 'المحاكاة نفسها سليمة عند عدم التعديل');
});

test('describeBackup: ملخص للعرض قبل الاستعادة', () => {
  const d = describeBackup(mk({ settings: { a: 1 }, log: { v: 1, dropped: 0, entries: [{}, {}] } }));
  assert.equal(d.days, 4);
  assert.equal(d.firstDay, '2026-11-20');
  assert.equal(d.lastDay, '2026-11-23');
  assert.deepEqual(d.months, [{ key: '2026-11', days: 4 }]);
  assert.equal(d.pinned, 1);
  assert.equal(d.temporary, 1);
  assert.equal(d.hasSettings, true);
  assert.equal(d.logEntries, 2);
  assert.equal(d.appVersion, '0.6.0');
  const e = describeBackup(createBackup({ state: { d: {} } }, { now: NOW }));
  assert.equal(e.days, 0);
  assert.equal(e.firstDay, null);
});

test('backupFileName: بالتوقيت المحلي وأصفار بادئة', () => {
  assert.equal(backupFileName(new Date(2026, 10, 3, 5, 7, 9)), 'adsl-backup-20261103-050709.json');
  assert.equal(backupFileName(new Date(2026, 11, 31, 23, 59, 59)), 'adsl-backup-20261231-235959.json');
});

test('دمج: يضيف الأيام الناقصة ويملأ الفراغ ولا يكتب فوق موجود ولا يحذف يوماً، ويُبلغ بالتعارض', () => {
  const current = { d: { '2026-11-20': { b: [85.7, null, 20.26], s: 9999 }, '2026-11-25': { s: 1 } }, op: {}, vn: { 0: 'اسمي' } };
  const back = parseBackup(serializeBackup(mk()));
  const snap = JSON.stringify(current);
  const r = restoreBackup({ state: current }, back, { mode: 'merge' });
  assert.equal(JSON.stringify(current), snap, 'الحالة الأصلية لم تُعدَّل');
  const d = r.state.d;
  assert.equal(r.report.daysAdded, 3, '21 و22 و23 أُضيفت');
  assert.ok(d['2026-11-25'], 'يوم غير موجود في النسخة لا يُحذف');
  assert.equal(d['2026-11-20'].s, 9999, 'المبيعات الموجودة تبقى');
  assert.deepEqual(d['2026-11-20'].b, [85.7, 0, 20.26], 'الفراغ ملئ (الصفر الحقيقي من النسخة)');
  assert.ok(r.report.conflicts.some((c) => c.where === '2026-11-20.s' && c.current === 9999 && c.incoming === 7700));
  assert.equal(r.state.vn[0], 'اسمي', 'اسم موجود يبقى');
  assert.equal(r.state.vn[3], 'الدكان', 'اسم ناقص يُملأ');
  assert.ok(r.report.conflicts.some((c) => c.where === 'vn.0'));
  assert.deepEqual(r.state.op['2026-11'], [90, 0, 30]);
  assert.equal(r.report.mode, 'merge');
  assert.deepEqual(r.previous.state, current, 'previous نسخة الحالة قبل الاستعادة');
});

test('عزل: تعديل نتيجة الدمج لا يمسّ الحالة الأصلية ولا previous ولا كائن النسخة', () => {
  const current = { d: { '2026-11-01': { s: 5, b: [1, 2, 3] }, '2026-11-20': { s: 9999 } } };
  const back = parseBackup(serializeBackup(mk()));
  const r = restoreBackup({ state: current }, back);
  r.state.d['2026-11-01'].s = 111;            // يوم لم تلمسه النسخة
  r.state.d['2026-11-01'].b[0] = 111;
  r.state.d['2026-11-20'].s = 222;            // يوم دُمج
  r.state.d['2026-11-21'].b[0] = 333;         // يوم أُضيف من النسخة
  r.state.d['2026-11-22'].c[0] = 444;         // يوم كروت أُضيف من النسخة
  r.state.op['2026-11'][0] = 555;
  assert.equal(current.d['2026-11-01'].s, 5);
  assert.deepEqual(current.d['2026-11-01'].b, [1, 2, 3]);
  assert.equal(current.d['2026-11-20'].s, 9999);
  assert.equal(r.previous.state.d['2026-11-01'].s, 5, 'previous سليمة للتراجع');
  assert.equal(r.previous.state.d['2026-11-20'].s, 9999);
  current.d['2026-11-01'].s = 1234;           // تعديل الأصل بعد الاستعادة لا يغيّر previous (لقطة مستقلة)
  assert.equal(r.previous.state.d['2026-11-01'].s, 5, 'previous لقطة لا مرجع');
  assert.equal(back.data.state.d['2026-11-21'].b[0], 74.53, 'كائن النسخة لم يتغيّر');
  assert.deepEqual(back.data.state.d['2026-11-22'].c, [1, 2, 0, 0, 0]);
  assert.deepEqual(back.data.state.op['2026-11'], [90, 0, 30]);
});

test('دمج: إعادة الاستعادة نفسها لا تكرر ولا تغيّر شيئاً (مطابقة ذاتية)', () => {
  const back = parseBackup(serializeBackup(mk()));
  const r1 = restoreBackup({ state: { d: {}, op: {} } }, back);
  const r2 = restoreBackup({ state: r1.state }, back);
  assert.deepEqual(r2.state, r1.state);
  assert.equal(r2.report.daysAdded, 0);
  assert.equal(r2.report.conflictsTotal, 0);
  assert.ok(r2.report.valuesSame > 0);
});

test('دمج: مجموعة الكروت تُنسخ معاً فقط حين لا يوجد إدخال يدوي، ولا تُكتب فوق إدخال يدوي (حتى لا يطغى القارئ عليه)', () => {
  const back = parseBackup(serializeBackup(mk()));
  // يوم 22 عند المستخدم فيه إدخال يدوي p و c: لا تُنسخ lb ولا lp
  const manual = { d: { '2026-11-22': { p: 3, c: [9, 9, 9, 9, 9] } } };
  const r = restoreBackup({ state: manual }, back);
  const e = r.state.d['2026-11-22'];
  assert.equal(e.lb, undefined, 'لا lb فوق إدخال يدوي');
  assert.equal(e.lp, undefined);
  assert.equal(e.p, 3);
  assert.deepEqual(e.c, [9, 9, 9, 9, 9]);
  assert.ok(r.report.conflicts.some((c) => c.where === '2026-11-22.card'));
  // يوم موجود بلا أي كروت: تُنسخ المجموعة كاملة
  const empty = { d: { '2026-11-22': { s: 5 } } };
  const r2 = restoreBackup({ state: empty }, back);
  const e2 = r2.state.d['2026-11-22'];
  assert.equal(e2.lp, true);
  assert.equal(e2.lr, '2026-11-24');
  assert.equal(e2.lb, 0.7451 * GB);
  assert.equal(e2.p, 0.7451);
  assert.deepEqual(e2.c, [1, 2, 0, 0, 0]);
  assert.equal(e2.s, 5, 'مبيعات اليوم تبقى');
  // اليوم المقروء الموجود يبقى كما هو ولو اختلف عن النسخة
  const tracked = { d: { '2026-11-22': { p: 1, c: [0, 0, 0, 0, 0], lb: 1 * GB, lp: false, lr: '2026-11-22', lx: 0 } } };
  const r3 = restoreBackup({ state: tracked }, back);
  assert.equal(r3.state.d['2026-11-22'].lb, 1 * GB);
  assert.equal(r3.state.d['2026-11-22'].lp, false);
  assert.ok(r3.report.conflicts.some((c) => c.where === '2026-11-22.card'));
});

test('دمج: التعارضات لها سقف مع عدّ كلي صحيح', () => {
  const d1 = {}, d2 = {};
  for (let i = 0; i < 250; i++) {
    const k = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    d1[k] = { s: 1 }; d2[k] = { s: 2 };
  }
  const { report, state } = mergeBackupState({ d: d1 }, { d: d2 });
  assert.equal(report.conflictsTotal, 250);
  assert.equal(report.conflicts.length, 200);
  assert.equal(state.d['2026-01-01'].s, 1, 'الموجود يبقى');
});

test('استبدال: يستبدل كل شيء بطلب صريح، ويبلّغ عن الأيام التي ستضيع، ويرجع previous للتراجع', () => {
  const back = parseBackup(serializeBackup(mk({ settings: { x: 1 } })));
  const current = { d: { '2026-10-01': { s: 5 }, '2026-11-20': { s: 1 } }, op: { '2026-10': [1, 2, 3] } };
  const cs = JSON.stringify(current);
  const r = restoreBackup({ state: current, settings: { old: true } }, back, { mode: 'replace' });
  assert.deepEqual(r.state, mkState());
  assert.equal(r.report.mode, 'replace');
  assert.equal(r.report.daysDropped, 1, 'يوم 10-01 لم يكن في النسخة');
  assert.equal(r.report.daysAdded, 3);
  assert.deepEqual(r.settings, { x: 1 });
  assert.equal(JSON.stringify(r.previous.state), cs, 'previous = الحالة قبل الاستبدال كاملة');
  assert.deepEqual(r.previous.settings, { old: true });
  r.state.d['2026-11-20'].s = 777;
  assert.equal(back.data.state.d['2026-11-20'].s, 7700, 'النتيجة مستقلة عن كائن النسخة');
  // نسخة بلا إعدادات لا تمسح الإعدادات الحالية
  const noSet = parseBackup(serializeBackup(mk()));
  assert.deepEqual(restoreBackup({ state: current, settings: { keep: 1 } }, noSet, { mode: 'replace' }).settings, { keep: 1 });
});

test('restoreBackup: يرفض وضعاً مجهولاً وحالة حالية تالفة ونسخة لم تُتحقق، دون تغيير شيء', () => {
  const back = parseBackup(serializeBackup(mk()));
  assert.throws(() => restoreBackup({ state: { d: {} } }, back, { mode: 'overwrite' }), code('BACKUP_BAD_MODE'));
  assert.throws(() => restoreBackup({ state: { d: { bad: {} } } }, back), (e) => e.code === 'BACKUP_BAD_STATE' && /الحالية/.test(e.message));
  assert.throws(() => restoreBackup({ state: { d: {} } }, { data: { state: { d: { bad: {} } } } }), code('BACKUP_STRUCTURE'));
  assert.throws(() => restoreBackup({ state: { d: {} } }, null), code('BACKUP_STRUCTURE'));
  // بلا حالة حالية أصلاً: يعامل كحالة فارغة
  const r = restoreBackup(undefined, back);
  assert.equal(r.report.daysAdded, 4);
});

test('السجل عبر النسخة: الاستعادة تمرّر لقطة السجل فيدمجها log.restore بلا تكرار', () => {
  const src = createLog({ now: () => NOW });
  src.warn('SYNC_WARN', 'يوم لم يُثبَّت', { day: '2026-11-23' });
  const back = parseBackup(serializeBackup(mk({ log: src.snapshot() })));
  const { logSnapshot } = restoreBackup({ state: { d: {} } }, back);
  const dst = createLog({ now: () => NOW + 5000 });
  assert.deepEqual(dst.restore(logSnapshot), { added: 1, duplicates: 0, rejected: 0, trimmed: 0 });
  assert.deepEqual(dst.restore(logSnapshot), { added: 0, duplicates: 1, rejected: 0, trimmed: 0 });
  assert.equal(restoreBackup({ state: { d: {} } }, parseBackup(serializeBackup(mk()))).logSnapshot, null);
});

test('تكامل: حالة ناتجة عن mergeReadings الحقيقية (مؤقت ثم مثبّت على الأكبر) تُقبل وتعود من النسخة مطابقة', () => {
  const agg = (counts, usedBytes, expired = 0) => ({ days: { '2026-11-22': { counts, usedBytes, expired } } });
  let st = { d: {} };
  const seen = [];
  for (const [a, on] of [[agg([5, 0, 0, 0, 0], 5e9), '2026-11-22'], [agg([4, 0, 0, 0, 0], 4e9, 1), '2026-11-23']]) {
    const r = mergeReadings(st, a, on);
    st = r.state;
    seen.push(r.results[0].action);
    assert.deepEqual(validateState(st), [], `الحالة بعد ${on} يجب أن تكون سليمة`);
  }
  assert.deepEqual(seen, ['new', 'pinned-max'], 'المسارات الفعلية التي مرّت: يوم جديد ثم تثبيت على الأكبر');
  assert.equal(st.d['2026-11-22'].lp, true);
  const back = parseBackup(serializeBackup(createBackup({ state: st }, { now: NOW })));
  assert.deepEqual(back.data.state, st);
  const r = restoreBackup({ state: { d: {} } }, back);
  assert.deepEqual(r.state, st);
  assert.equal(describeBackup(back).pinned, 1);
});
