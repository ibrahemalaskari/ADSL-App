// Transport مباشر لـ Node (Termux) فوق TCP، بنفس واجهة open/write/read/close المطلوبة من RouterOSClient.
// لا يحتاج الجسر. يلتزم بقيود الجسر نفسها: عناوين IPv4 خاصة فقط، والمنفذان 8728 و8729 فقط افتراضياً.
// API-SSL (8729 بتشفير) غير مدعوم هنا لأنه لم يُختبر.

import net from 'node:net';
import { RosError, mapNetError } from '../core/routeros-api.js';
import { isPrivateIPv4 } from '../bridge/server.js';

const MAX_BUFFER = 32 * 1024 * 1024;

export class NetTransport {
  constructor({ allowedPorts = [8728, 8729] } = {}) {
    this.allowedPorts = allowedPorts;
    this.sock = null;
    this.chunks = [];
    this.size = 0;
    this.closed = false;
    this.waiter = null;
  }

  _wake() { if (this.waiter) this.waiter(); }

  _wait(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => done(), ms);
      const done = () => { clearTimeout(t); this.waiter = null; resolve(); };
      this.waiter = done;
    });
  }

  async open({ host, port, tls = false, timeoutMs = 8000 }) {
    if (tls) throw new RosError('CONNECT_FAILED', 'API-SSL غير مدعوم في هذه الأداة (لم يُختبر)');
    if (!isPrivateIPv4(host)) throw new RosError('BAD_ADDRESS', 'مسموح فقط بعناوين IPv4 المحلية');
    if (!this.allowedPorts.includes(port)) throw new RosError('CONNECT_FAILED', 'منفذ غير مسموح');
    const sock = await new Promise((resolve, reject) => {
      const s = net.connect({ host, port });
      const fail = (e) => { s.destroy(); reject(new RosError(mapNetError(e && e.code), 'فشل فتح الاتصال بالراوتر', (e && e.code) || String(e && e.message))); };
      s.setTimeout(timeoutMs);
      s.once('timeout', () => fail({ code: 'ETIMEDOUT' }));
      s.once('error', fail);
      s.once('connect', () => { s.removeListener('error', fail); s.setTimeout(0); resolve(s); });
    });
    this.sock = sock;
    sock.on('data', (c) => {
      this.chunks.push(c); this.size += c.length;
      if (this.size > MAX_BUFFER) { sock.destroy(); this.closed = true; }
      this._wake();
    });
    sock.on('close', () => { this.closed = true; this._wake(); });
    sock.on('error', () => { this.closed = true; this._wake(); });
  }

  async write(bytes) {
    if (!this.sock || this.closed) throw new RosError('CONNECTION_CLOSED', 'الاتصال مغلق');
    await new Promise((resolve, reject) => this.sock.write(bytes, (e) => (e ? reject(new RosError('CONNECTION_CLOSED', 'تعذرت الكتابة', e.code)) : resolve())));
  }

  _take() {
    const buf = Buffer.concat(this.chunks);
    this.chunks = []; this.size = 0;
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
  }

  // يعيد Uint8Array (فارغة عند انتهاء مهلة الانتظار) أو null عند إغلاق الاتصال وفراغ المخزن.
  async read(maxWaitMs) {
    if (this.chunks.length) return this._take();
    if (this.closed) return null;
    await this._wait(maxWaitMs);
    if (this.chunks.length) return this._take();
    return this.closed ? null : new Uint8Array(0);
  }

  async close() {
    this.closed = true;
    if (this.sock) { this.sock.destroy(); this.sock = null; }
  }
}
