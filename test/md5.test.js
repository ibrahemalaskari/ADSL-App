import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { md5Hex } from '../core/md5.js';

test('MD5 يطابق crypto لأطوال حدية وعشوائية', () => {
  for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
    const b = new Uint8Array(randomBytes(n));
    assert.equal(md5Hex(b), createHash('md5').update(b).digest('hex'), `length ${n}`);
  }
});
test('MD5 قيمة معروفة', () => {
  assert.equal(md5Hex(new TextEncoder().encode('abc')), '900150983cd24fb0d6963f7d28e17f72');
});
