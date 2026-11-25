import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../www/adsl-app.html', import.meta.url), 'utf8');

test('temporary/pinned status is always visible under program consumption in lines summary', () => {
  assert.match(html, /const trackedEntries=Object\.values\(S\.d\)\.filter\(e=>e&&e\.lb!=null\)/);
  assert.match(html, /temporaryEntries\?'<small class="program-state am">مؤقت<\/small>'/);
  assert.match(html, /'<small class="program-state gn">مثبّت<\/small>'/);
  assert.match(html, /'<small class="program-state muted">لا توجد قراءة من الراوتر<\/small>'/);
  assert.match(html, /SC\('app','الرصيد المستهلك في البرنامج',g\(r4\(T\.L\)\)\+programStatus\)/);
});

test('movement details label program consumption but do not add an explanatory paragraph', () => {
  assert.match(html, /programLabel='الرصيد المستهلك في البرنامج'/);
  assert.match(html, /v\(programLabel,g\(e\.p\)\|\|'—'\)/);
  assert.doesNotMatch(html, /استهلاك الكروت التي فُتحت في هذا اليوم/);
});

test('loss remains a separate value without temporary/pinned status', () => {
  assert.match(html, /v\('فاقد الرصيد',g\(x\.Sx\)\|\|'—'\)/);
  assert.doesNotMatch(html, /lossLabel='فاقد الرصيد'/);
  assert.match(html, /<small>استهلاك الخطوط<\/small>/);
});

test('SQLite migration is explicit, previews the legacy source, and never deletes localStorage', () => {
  assert.match(html, /const LEGACY_RAW=localStorage\.getItem\(KEY\)/);
  assert.match(html, /مراجعة وترحيل بيانات المتصفح إلى SQLite/);
  assert.match(html, /confirm\('مراجعة قبل الترحيل\\n\\n'/);
  assert.match(html, /const snap=readLegacySnapshot\(\)/);
  assert.match(html, /state:snap\.state/);
  assert.match(html, /function legacyCounts\(state\)/);
  assert.doesNotMatch(html, /localStorage\.removeItem\(KEY\)/);
  assert.match(html, /localStorage\.getItem\(KEY\)/);
  assert.match(html, /vlanNames/);
  assert.match(html, /fetch\('\/db\/status'/);
  assert.match(html, /fetch\('\/db\/migrate'/);
});


test('واجهة المزامنة تحفظ في SQLite وتعيد القراءة منها وتوفر النسخ والاستعادة', () => {
  assert.match(html, /fetch\('\/db\/router-sync'/);
  assert.match(html, /fetch\('\/db\/router-days'/);
  assert.match(html, /mergeRouterDaysIntoState/);
  assert.match(html, /إنشاء نسخة احتياطية/);
  assert.match(html, /استعادة نسخة/);
  assert.match(html, /import\('\/core\/backup\.js'\)/);
  assert.match(html, /parseBackup\(text\)/);
  assert.match(html, /restoreBackup\(/);
  assert.match(html, /router-restore/);
});
