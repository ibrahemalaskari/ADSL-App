// راوتر وهمي في الذاكرة لاختبار البروتوكول فقط. هذا ليس RouterOS، ونتائجه ليست اختباراً على راوتر حقيقي.
import { SentenceParser, encodeSentence, parseSentence } from '../core/routeros-api.js';

export class MemTransport {
  constructor(handler) {
    this.handler = handler;       // (words, ctx) => array of sentences (array of arrays) | 'close'
    this.parser = new SentenceParser();
    this.incoming = [];
    this.closed = false;
    this.written = [];            // كل الجمل التي كتبها العميل (لإثبات عدم إرسال أوامر ممنوعة)
    this.ctx = {};
  }
  async open() {}
  async write(bytes) {
    for (const words of this.parser.push(bytes)) {
      this.written.push(words);
      const out = this.handler(words, this.ctx);
      if (out === 'close') { this.closed = true; continue; }
      for (const s of out || []) this.incoming.push(encodeSentence(s));
    }
  }
  async read(maxWaitMs) {
    if (this.incoming.length) return this.incoming.shift();
    if (this.closed) return null;
    await new Promise((r) => setTimeout(r, Math.min(maxWaitMs, 30)));
    if (this.incoming.length) return this.incoming.shift();
    return this.closed ? null : new Uint8Array(0);
  }
  async close() { this.closed = true; }
}

export const re = (obj) => ['!re', ...Object.entries(obj).map(([k, v]) => `=${k}=${v}`)];
export const done = (obj = {}) => ['!done', ...Object.entries(obj).map(([k, v]) => `=${k}=${v}`)];
export const trap = (message) => ['!trap', `=message=${message}`];
export { parseSentence };

// جدول بيانات يشبه ما يرجعه v6 (أسماء الحقول من توثيق RouterOS، والقيم مختلقة للاختبار).
export function fakeRouterHandler({ user = 'reader', pass = 'secret', legacy = false, uptime = '3d04:05:06', ifaces } = {}) {
  const table = ifaces || [
    { '.id': '*1', name: 'ether1', type: 'ether', running: 'true', disabled: 'false', 'rx-byte': '1000', 'tx-byte': '2000' },
    { '.id': '*2', name: 'ether2', type: 'ether', running: 'false', disabled: 'false', 'rx-byte': '0', 'tx-byte': '0' },
    { '.id': '*3', name: 'bridge1', type: 'bridge', running: 'true', disabled: 'false', 'rx-byte': '5000', 'tx-byte': '6000' },
    { '.id': '*4', name: 'vlan10', type: 'vlan', running: 'true', disabled: 'false', comment: 'بيت', 'rx-byte': '300', 'tx-byte': '400' },
    { '.id': '*4', name: 'vlan10', type: 'vlan', running: 'true', disabled: 'false', 'rx-byte': '300', 'tx-byte': '400' }, // تكرار متعمد
    { '.id': '*5', name: 'vlan20', type: 'vlan', running: 'true', disabled: 'false', 'rx-byte': 'oops' },                   // قيمة غير صالحة
  ];
  return (w, ctx) => {
    const cmd = w[0];
    const a = Object.fromEntries(w.slice(1).filter((x) => x.startsWith('=')).map((x) => { const i = x.indexOf('=', 1); return [x.slice(1, i), x.slice(i + 1)]; }));
    if (cmd === '/login') {
      if (legacy) {
        if (!a.response) { ctx.challenge = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; return [done({ ret: ctx.challenge })]; }
        ctx.responseSeen = a.response;
        return ctx.expectResponse && a.response === ctx.expectResponse(ctx.challenge, pass) && a.name === user
          ? [done()] : [trap('cannot log in'), done()];
      }
      return a.name === user && a.password === pass ? [done()] : [trap('cannot log in'), done()];
    }
    if (cmd === '/system/resource/print') return [re({ uptime, version: '6.49.10 (long-term)', 'board-name': 'RB750Gr3' }), done()];
    if (cmd === '/system/identity/print') return [re({ name: 'MikroTik-Test' }), done()];
    if (cmd === '/system/clock/print') return [re({ time: '00:05:00', date: 'nov/23/2026', 'time-zone-name': 'Asia/Aden' }), done()];
    if (cmd === '/interface/print') return [...table.map(re), done()];
    if (cmd === '/interface/vlan/print') return [re({ name: 'vlan10', 'vlan-id': '10', interface: 'bridge1' }), re({ name: 'vlan20', 'vlan-id': '20', interface: 'bridge1' }), done()];
    if (cmd === '/interface/bridge/port/print') return [re({ interface: 'ether2', bridge: 'bridge1' }), done()];
    if (cmd === '/ip/service/print') return [re({ name: 'api', disabled: 'false', port: '8728', address: '192.168.88.0/24' }), re({ name: 'api-ssl', disabled: 'true', port: '8729' }), done()];
    return [trap('no such command'), done()];
  };
}
