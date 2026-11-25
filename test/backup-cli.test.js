import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'backup-cli.mjs');
const run = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'adsl-bk-'));
const STATE = { d: { '2026-11-22': { lb: 5e9, p: 4.6566, c: [5, 0, 0, 0, 0], lp: true, lr: '2026-11-23', lx: 1 }, '2026-11-23': { b: [60.1, 0, 30.2], s: 7000 } }, op: { '2026-11': [90, 0, 30] } };
const put = (dir, name, obj) => fs.writeFileSync(path.join(dir, name), typeof obj === 'string' ? obj : JSON.stringify(obj));
const leftovers = (dir) => fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));

test('CLI: create ثم inspect ثم restore يعيد الحالة نفسها، ولا يترك ملفات مؤقتة', () => {
  const dir = tmp();
  put(dir, 'state.json', STATE);
  const c = run(dir, 'create', 'state.json', '--out', 'b.json');
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /كُتبت النسخة: b\.json/);
  assert.match(c.stdout, /الأيام: 2/);
  assert.match(c.stdout, /تحقق: قُرئ الملف المكتوب/);
  const i = run(dir, 'inspect', 'b.json');
  assert.equal(i.status, 0, i.stderr);
  assert.match(i.stdout, /أيام الكروت المثبّتة: 1/);
  const r = run(dir, 'restore', 'empty.json', 'b.json', '--out', 'out.json'); // ملف حالة غير موجود = فارغ
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /غير موجود: يُعامل كحالة فارغة/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8')), STATE);
  assert.deepEqual(leftovers(dir), []);
});

test('CLI: restore لا يمسّ ملف الحالة الأصلي، ويُبلغ بالتعارض في الدمج وبالأيام الضائعة في الاستبدال', () => {
  const dir = tmp();
  put(dir, 'state.json', STATE);
  assert.equal(run(dir, 'create', 'state.json', '--out', 'b.json').status, 0);
  const cur = { d: { '2026-11-23': { b: [60.1, 0, 30.2], s: 9999 }, '2026-11-25': { s: 1 } } };
  put(dir, 'cur.json', cur);
  const before = fs.readFileSync(path.join(dir, 'cur.json'), 'utf8');
  const m = run(dir, 'restore', 'cur.json', 'b.json', '--out', 'merged.json');
  assert.equal(m.status, 0, m.stderr);
  assert.match(m.stdout, /تعارضات \(بقيت قيمة الحالة الحالية\): 1/);
  assert.match(m.stdout, /2026-11-23\.s: الحالي=9999 \| في النسخة=7000/);
  const merged = JSON.parse(fs.readFileSync(path.join(dir, 'merged.json'), 'utf8'));
  assert.equal(merged.d['2026-11-23'].s, 9999);
  assert.ok(merged.d['2026-11-25'], 'يوم الحالة الحالية لا يُحذف');
  assert.ok(merged.d['2026-11-22'], 'يوم النسخة أُضيف');
  const rp = run(dir, 'restore', 'cur.json', 'b.json', '--mode', 'replace', '--out', 'rep.json');
  assert.equal(rp.status, 0, rp.stderr);
  assert.match(rp.stdout, /أيام ستضيع من الحالة الحالية: 1/);
  assert.equal(fs.readFileSync(path.join(dir, 'cur.json'), 'utf8'), before, 'الأصل لم يُمسّ');
});

test('CLI: لا يستبدل ملفاً موجوداً أبداً (create وrestore)', () => {
  const dir = tmp();
  put(dir, 'state.json', STATE);
  put(dir, 'taken.json', 'محتوى مهم');
  const c = run(dir, 'create', 'state.json', '--out', 'taken.json');
  assert.equal(c.status, 1);
  assert.match(c.stderr, /ولن يُستبدل/);
  assert.equal(fs.readFileSync(path.join(dir, 'taken.json'), 'utf8'), 'محتوى مهم');
  assert.equal(run(dir, 'create', 'state.json', '--out', 'b.json').status, 0);
  const r = run(dir, 'restore', 'state.json', 'b.json', '--out', 'taken.json');
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'taken.json'), 'utf8'), 'محتوى مهم');
  assert.deepEqual(leftovers(dir), []);
});

test('CLI: ملف تالف أو مبتور أو حالة غير سليمة: خروج 1 برمز الخطأ، ولا ملف ناتج', () => {
  const dir = tmp();
  put(dir, 'state.json', STATE);
  assert.equal(run(dir, 'create', 'state.json', '--out', 'b.json').status, 0);
  const good = fs.readFileSync(path.join(dir, 'b.json'), 'utf8');
  put(dir, 'bad.json', good.replace('"s": 7000', '"s": 7001'));
  put(dir, 'trunc.json', good.slice(0, 200));
  put(dir, 'inv.json', { d: { bad: {} } });
  put(dir, 'notjson.json', 'ليس json');
  const a = run(dir, 'inspect', 'bad.json');
  assert.equal(a.status, 1);
  assert.match(a.stderr, /BACKUP_CHECKSUM/);
  assert.match(run(dir, 'inspect', 'trunc.json').stderr, /BACKUP_PARSE/);
  const r = run(dir, 'restore', 'state.json', 'bad.json', '--out', 'never.json');
  assert.equal(r.status, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'never.json')), 'لا ملف ناتج عند الرفض');
  const v = run(dir, 'create', 'inv.json', '--out', 'x.json');
  assert.equal(v.status, 1);
  assert.match(v.stderr, /BACKUP_BAD_STATE/);
  assert.match(v.stderr, /d\.bad/);
  assert.ok(!fs.existsSync(path.join(dir, 'x.json')));
  const n = run(dir, 'create', 'notjson.json', '--out', 'y.json');
  assert.equal(n.status, 1);
  assert.match(n.stderr, /ليس JSON صالحاً/);
  assert.equal(run(dir, 'create', 'missing.json').status, 1);
  assert.deepEqual(leftovers(dir), []);
});

test('CLI: وسائط خاطئة ومساعدة', () => {
  const dir = tmp();
  assert.equal(run(dir).status, 2);
  assert.equal(run(dir, '--help').status, 0);
  assert.equal(run(dir, 'bogus').status, 2);
  assert.match(run(dir, 'create', '--zzz').stderr, /خيار غير معروف/);
  assert.match(run(dir, 'restore', 'a.json', 'b.json', '--mode', 'x').stderr, /merge أو replace/);
  assert.match(run(dir, 'create').stderr, /create يحتاج ملف الحالة/);
});
