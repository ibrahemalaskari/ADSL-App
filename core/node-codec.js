// codec لوحدة zip.js مبني على zlib المدمجة في Node (Termux والاختبارات). لا يُستعمل في المتصفح.
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const inflate = promisify(zlib.inflateRaw);
const deflate = promisify(zlib.deflateRaw);

export const nodeCodec = {
  inflateRaw: async (u8) => new Uint8Array(await inflate(u8)),
  deflateRaw: async (u8) => new Uint8Array(await deflate(u8, { level: 9 })),
};
