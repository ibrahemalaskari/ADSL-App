import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const html=fs.readFileSync(new URL('../www/adsl-app.html',import.meta.url),'utf8');
test('واجهة الأدوات توصل استيراد وتصدير Excel إلى المحرك ولا تعرض رسالة وهمية',()=>{
  assert.match(html,/id="excel-import-file"/);
  assert.match(html,/id="excel-template-file"/);
  assert.match(html,/importWorkbook\(await readExcelFile\(file\),\{codec:browserCodec\}\)/);
  assert.match(html,/exportMonth\(await readExcelFile\(file\),S,month,\{codec:browserCodec\}\)/);
  assert.match(html,/\/db\/import-state/);
  assert.doesNotMatch(html,/imp:\(\)=>toast\('الاستيراد يعمل/);
});
