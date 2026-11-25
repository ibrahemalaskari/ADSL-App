// Transport للمتصفح: يتحدث مع جسر Termux (bridge/server.js) عبر HTTP.
// داخل تطبيق أندرويد يُكتب Transport آخر بنفس الواجهة (open/write/read/close) فوق Plugin أصلي.
import { RosError, mapNetError } from './routeros-api.js';

export class BridgeTransport {
  constructor(baseUrl = '') { this.base = baseUrl; this.id = null; }

  async _fetch(path, init = {}) {
    try {
      return await fetch(this.base + path, { ...init, headers: { 'x-bridge': '1', ...(init.headers || {}) } });
    } catch (e) {
      throw new RosError('BRIDGE_DOWN', 'تعذر الوصول إلى جسر Termux', String(e && e.message));
    }
  }

  async open({ host, port, tls = false, timeoutMs = 8000 }) {
    const r = await this._fetch('/tcp/open', { method: 'POST', body: JSON.stringify({ host, port, tls, timeoutMs }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const errno = j.error && j.error.errno;
      throw new RosError(mapNetError(errno), 'فشل فتح الاتصال بالراوتر', errno || `HTTP ${r.status}`);
    }
    this.id = j.id;
  }

  async write(bytes) {
    const r = await this._fetch(`/tcp/write?id=${this.id}`, { method: 'POST', body: bytes });
    if (!r.ok) throw new RosError('CONNECTION_CLOSED', 'تعذرت الكتابة إلى الاتصال', `HTTP ${r.status}`);
  }

  // يعيد Uint8Array (فارغة عند انتهاء مهلة الانتظار) أو null عند إغلاق الاتصال.
  async read(maxWaitMs) {
    const r = await this._fetch(`/tcp/read?id=${this.id}&wait=${Math.floor(maxWaitMs)}`, { method: 'POST' });
    if (!r.ok) throw new RosError('CONNECTION_CLOSED', 'فُقد الاتصال بالجسر', `HTTP ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length === 0 && r.headers.get('x-closed') === '1') return null;
    return buf;
  }

  async close() {
    if (this.id) { try { await this._fetch(`/tcp/close?id=${this.id}`, { method: 'POST' }); } catch { /* تجاهل */ } }
    this.id = null;
  }
}
