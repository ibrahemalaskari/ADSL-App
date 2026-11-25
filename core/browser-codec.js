// متوافق مع واجهات Compression Streams الحديثة في المتصفحات.
function transform(bytes, format, mode) {
  const C = mode === 'inflate' ? globalThis.DecompressionStream : globalThis.CompressionStream;
  if (!C) throw new Error('المتصفح لا يدعم ضغط ZIP المطلوب؛ حدّث Chrome/Android System WebView.');
  let stream;
  try { stream = new C(format); } catch { throw new Error('المتصفح لا يدعم raw deflate لملفات Excel.'); }
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const chunks = [];
  const done = (async () => { while (true) { const { value, done } = await reader.read(); if (done) break; chunks.push(value); } })();
  return writer.write(bytes).then(() => writer.close()).then(() => done).then(() => {
    const size = chunks.reduce((n, x) => n + x.length, 0), out = new Uint8Array(size);
    let offset = 0; for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  });
}
export const browserCodec = {
  inflateRaw: bytes => transform(bytes, 'deflate-raw', 'inflate'),
  deflateRaw: bytes => transform(bytes, 'deflate-raw', 'deflate'),
};
