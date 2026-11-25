import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { browserCodec } from '../core/browser-codec.js';
import { importWorkbook, exportMonth } from '../core/excel.js';
import { nodeCodec } from '../core/node-codec.js';
const template = new Uint8Array(fs.readFileSync(new URL('./fixtures/template.xlsx', import.meta.url)));
test('Browser codec round-trip and Excel template import/export', async () => {
  const input=new TextEncoder().encode('ADSL browser codec validation');
  const zipped=await browserCodec.deflateRaw(input);
  const restored=await browserCodec.inflateRaw(zipped);
  assert.equal(new TextDecoder().decode(restored),'ADSL browser codec validation');
  const imported=await importWorkbook(template,{codec:browserCodec});
  assert.equal(imported.stats.daysImported,4);
  const state={d:{'2026-08-01':{b:[85.7,0,20.26],s:7700,p:25.59,c:[17,15,8,0,1]}},op:{'2026-08':[100,5,30]}};
  const exported=await exportMonth(template,state,'2026-08',{codec:browserCodec});
  const back=await importWorkbook(exported,{codec:nodeCodec});
  assert.deepEqual(back.state,state);
});
