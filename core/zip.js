// قارئ/كاتب ZIP مخصص لملفات xlsx. بلا اعتماديات: الضغط وفك الضغط يُحقنان عبر codec
// ({ inflateRaw(u8)=>Promise<u8>, deflateRaw(u8)=>Promise<u8> })، فيعمل في Node (node-codec.js)
// ويمكن لاحقاً في المتصفح عبر DecompressionStream('deflate-raw').
// عند إعادة الكتابة تُنسخ الأجزاء غير المعدّلة بايتاً ببايت (بلا إعادة ضغط).

const td = new TextDecoder('utf-8');
const te = new TextEncoder();

export class ZipError extends Error {
  constructor(code, message) { super(message); this.name = 'ZipError'; this.code = code; }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export function readZip(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('ZIP_INVALID', 'الملف ليس بصيغة xlsx/ZIP صالحة');
  const total = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < total; i++) {
    if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) throw new ZipError('ZIP_INVALID', 'فهرس الملف تالف');
    const e = {
      flags: dv.getUint16(p + 8, true), method: dv.getUint16(p + 10, true),
      time: dv.getUint16(p + 12, true), date: dv.getUint16(p + 14, true),
      crc: dv.getUint32(p + 16, true), csize: dv.getUint32(p + 20, true), usize: dv.getUint32(p + 24, true),
    };
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    e.name = td.decode(u8.subarray(p + 46, p + 46 + nlen));
    if (e.csize === 0xFFFFFFFF || e.usize === 0xFFFFFFFF || lho === 0xFFFFFFFF) throw new ZipError('ZIP_UNSUPPORTED', 'ملفات ZIP64 غير مدعومة');
    if (e.flags & 1) throw new ZipError('ZIP_UNSUPPORTED', 'الملف مشفّر بكلمة مرور ولا يمكن قراءته');
    if (lho + 30 > u8.length || dv.getUint32(lho, true) !== 0x04034b50) throw new ZipError('ZIP_INVALID', 'ترويسة جزء تالفة: ' + e.name);
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    if (start + e.csize > u8.length) throw new ZipError('ZIP_INVALID', 'الملف مبتور: ' + e.name);
    e.raw = u8.subarray(start, start + e.csize);
    entries.push(e);
    p += 46 + nlen + elen + clen;
  }
  return entries;
}

export async function extractEntry(entry, codec) {
  let data;
  if (entry.method === 0) data = entry.raw.slice();
  else if (entry.method === 8) data = await codec.inflateRaw(entry.raw);
  else throw new ZipError('ZIP_UNSUPPORTED', `طريقة ضغط غير مدعومة (${entry.method}) في ${entry.name}`);
  if (crc32(data) !== entry.crc) throw new ZipError('ZIP_CRC', 'فشل التحقق من سلامة الجزء: ' + entry.name);
  return data;
}

// جزء جديد من بيانات (يُضغط). like: جزء أصلي لنسخ علامة UTF-8 والتاريخ منه.
export async function makeEntry(name, data, codec, like) {
  let method = 8;
  let raw = await codec.deflateRaw(data);
  if (raw.length >= data.length) { method = 0; raw = data; }
  return {
    name, flags: (like ? like.flags : 0) & 0x0800, method,
    time: like ? like.time : 0, date: like ? like.date : 0x21,
    crc: crc32(data), csize: raw.length, usize: data.length, raw,
  };
}

export function writeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = te.encode(e.name);
    const flags = e.flags & ~0x0008; // الأحجام تُكتب في الترويسة المحلية
    const lh = new Uint8Array(30 + name.length);
    const v = new DataView(lh.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, flags, true);
    v.setUint16(8, e.method, true); v.setUint16(10, e.time, true); v.setUint16(12, e.date, true);
    v.setUint32(14, e.crc, true); v.setUint32(18, e.csize, true); v.setUint32(22, e.usize, true);
    v.setUint16(26, name.length, true); v.setUint16(28, 0, true);
    lh.set(name, 30);
    chunks.push(lh, e.raw);
    central.push({ e, name, flags, offset });
    offset += lh.length + e.raw.length;
  }
  const cdStart = offset;
  for (const { e, name, flags, offset: lho } of central) {
    const ch = new Uint8Array(46 + name.length);
    const v = new DataView(ch.buffer);
    v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true); v.setUint16(6, 20, true); v.setUint16(8, flags, true);
    v.setUint16(10, e.method, true); v.setUint16(12, e.time, true); v.setUint16(14, e.date, true);
    v.setUint32(16, e.crc, true); v.setUint32(20, e.csize, true); v.setUint32(24, e.usize, true);
    v.setUint16(28, name.length, true); v.setUint32(42, lho, true);
    ch.set(name, 46);
    chunks.push(ch);
    offset += ch.length;
  }
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true);
  ev.setUint32(12, offset - cdStart, true); ev.setUint32(16, cdStart, true);
  chunks.push(end);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
