// جسر محلي للتجربة داخل Termux فقط. المتصفح لا يستطيع فتح اتصال TCP خام بالراوتر،
// فيتحدث مع هذا الجسر بـ HTTP، والجسر يفتح الـ TCP ويمرّر البايتات كما هي (لا يفهم البروتوكول).
// داخل تطبيق أندرويد يُستبدل الجسر بـ Plugin أصلي بنفس واجهة Transport.
//
// تشغيل:  node bridge/server.js      ثم افتح  http://127.0.0.1:8787/dev.html
//
// الأمان:
//  - يستمع على 127.0.0.1 فقط (لا يُرى من الشبكة).
//  - يرفض أي طلب /tcp/* بدون ترويسة X-Bridge (تمنع صفحات المواقع الأخرى من استخدامه، لأنها تستلزم preflight ولا نردّ عليه).
//  - يتحقق من ترويسة Host (حماية من DNS rebinding).
//  - لا يتصل إلا بعناوين IPv4 خاصة، وبالمنفذين 8728 و8729 افتراضياً.
//  - لا يسجّل محتوى البايتات (قد تحوي كلمة المرور).

import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { SQLiteStore } from '../core/sqlite-store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const MAX_BUFFER = 16 * 1024 * 1024;
const IDLE_MS = 60_000;

export function isPrivateIPv4(s) {
  if (typeof s !== 'string' || !net.isIPv4(s)) return false;
  const [a, b] = s.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function connectTcp({ host, port, useTls, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const sock = useTls
      // API-SSL في v6 بدون شهادة يستعمل شفرات ADH القديمة؛ OpenSSL الحديث يمنعها افتراضياً. غير مُختبَر.
      ? tls.connect({ host, port, rejectUnauthorized: false, ciphers: 'ADH:@SECLEVEL=0' })
      : net.connect({ host, port });
    const fail = (e) => { sock.destroy(); reject(e); };
    sock.setTimeout(timeoutMs);
    sock.once('timeout', () => fail(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    sock.once('error', fail);
    sock.once(useTls ? 'secureConnect' : 'connect', () => {
      sock.removeListener('error', fail);
      sock.setTimeout(0);
      resolve(sock);
    });
  });
}

export function createBridge({ port = 8787, host = '127.0.0.1', allowedPorts = [8728, 8729], staticRoot = ROOT, databasePath = process.env.ADSL_DB_PATH || path.join(ROOT, 'data', 'adsl.sqlite') } = {}) {
  const sessions = new Map();
  let store = null;
  const getStore = () => store || (store = new SQLiteStore({ filename: databasePath }));

  const dropSession = (id) => {
    const s = sessions.get(id);
    if (!s) return;
    clearTimeout(s.idle);
    s.sock.destroy();
    sessions.delete(id);
  };
  const touch = (s, id) => { clearTimeout(s.idle); s.idle = setTimeout(() => dropSession(id), IDLE_MS); };

  const send = (res, status, body, headers = {}) => {
    const isJson = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
    res.writeHead(status, { 'cache-control': 'no-store', ...(isJson ? { 'content-type': 'application/json' } : {}), ...headers });
    res.end(isJson ? JSON.stringify(body) : body);
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_BUFFER) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  async function handleTcp(req, res, url) {
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    if (req.headers['x-bridge'] !== '1') return send(res, 403, { error: 'missing X-Bridge header' });
    const op = url.pathname.slice('/tcp/'.length);
    const id = url.searchParams.get('id');

    if (op === 'open') {
      let p;
      try { p = JSON.parse((await readBody(req)).toString('utf8')); } catch { return send(res, 400, { error: { errno: 'BAD_REQUEST' } }); }
      if (!isPrivateIPv4(p.host)) return send(res, 400, { error: { errno: 'ENOTFOUND', detail: 'مسموح فقط بعناوين IPv4 المحلية' } });
      const portNum = Number(p.port);
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535 || (allowedPorts && !allowedPorts.includes(portNum))) {
        return send(res, 400, { error: { errno: 'BAD_REQUEST', detail: 'منفذ غير مسموح' } });
      }
      try {
        const sock = await connectTcp({ host: p.host, port: portNum, useTls: !!p.tls, timeoutMs: Math.min(Number(p.timeoutMs) || 8000, 30000) });
        const sid = randomBytes(8).toString('hex');
        const s = { sock, chunks: [], size: 0, closed: false, waiters: [], idle: null };
        const wake = () => { for (const w of s.waiters.splice(0)) w(); };
        sock.on('data', (c) => { s.chunks.push(c); s.size += c.length; if (s.size > MAX_BUFFER) sock.destroy(); wake(); });
        sock.on('close', () => { s.closed = true; wake(); });
        sock.on('error', () => { s.closed = true; wake(); });
        sessions.set(sid, s);
        touch(s, sid);
        return send(res, 200, { id: sid });
      } catch (e) {
        return send(res, 502, { error: { errno: e.code || 'ECONNFAILED' } });
      }
    }

    const s = sessions.get(id);
    if (!s) return send(res, 404, { error: 'no such session' });
    touch(s, id);

    if (op === 'write') {
      const body = await readBody(req);
      if (s.closed) return send(res, 410, { error: 'closed' });
      s.sock.write(body);
      return send(res, 204, null);
    }
    if (op === 'read') {
      const wait = Math.max(0, Math.min(Number(url.searchParams.get('wait')) || 0, 10000));
      if (s.chunks.length === 0 && !s.closed && wait > 0) {
        await new Promise((resolve) => { const t = setTimeout(resolve, wait); s.waiters.push(() => { clearTimeout(t); resolve(); }); });
      }
      const data = Buffer.concat(s.chunks); s.chunks = []; s.size = 0;
      return send(res, 200, data, { 'content-type': 'application/octet-stream', 'x-closed': s.closed && data.length === 0 ? '1' : '0' });
    }
    if (op === 'close') { dropSession(id); return send(res, 204, null); }
    return send(res, 404, { error: 'unknown op' });
  }

  function handleStatic(req, res, url) {
    if (req.method !== 'GET') return send(res, 405, 'method not allowed');
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/www/dev.html';
    else if (/^\/[^/]+\.html$/.test(p)) p = '/www' + p;
    // مسموح فقط www/ و core/ ، ومنع الخروج من الجذر
    const full = path.resolve(staticRoot, '.' + p);
    const okDir = ['www', 'core'].some((d) => full.startsWith(path.join(staticRoot, d) + path.sep));
    if (!okDir || !MIME[path.extname(full)]) return send(res, 404, 'not found');
    fs.readFile(full, (err, buf) => (err ? send(res, 404, 'not found') : send(res, 200, buf, { 'content-type': MIME[path.extname(full)] })));
  }

  const server = http.createServer(async (req, res) => {
    try {
      const hostName = String(req.headers.host || '').replace(/:\d+$/, '');
      if (hostName !== '127.0.0.1' && hostName !== 'localhost') return send(res, 403, 'bad host');
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/health') return send(res, 200, { ok: true });
      if (url.pathname === '/db/reset' && req.method === 'POST') {
        let payload;
        try { payload = JSON.parse((await readBody(req)).toString('utf8')); }
        catch { return send(res, 400, { error: 'BAD_JSON' }); }
        if (payload?.confirm !== 'RESET_OPERATIONAL_DATA') {
          return send(res, 403, { error: 'RESET_CONFIRMATION_REQUIRED' });
        }
        try { return send(res, 200, getStore().resetOperationalData()); }
        catch (e) {
          return send(res, 500, { error: 'RESET_FAILED', message: String(e.message || e).slice(0, 180) });
        }
      }

      if (url.pathname === '/db/sales' && req.method === 'GET') {
        try {
          const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 5000;
          return send(res, 200, getStore().getSalesData({
            from: url.searchParams.get('from') || null,
            to: url.searchParams.get('to') || null,
            profile: url.searchParams.get('profile') || null,
            nasPortId: url.searchParams.get('nasPortId') || null,
            limit,
          }));
        } catch (e) { return send(res, 400, { error: 'INVALID_SALES_FILTER', message: String(e.message || e).slice(0, 160) }); }
      }
      if (url.pathname === '/db/sales-prices' && req.method === 'GET') return send(res, 200, { prices: getStore().getSalesPrices() });
      if (url.pathname === '/db/sales-prices' && req.method === 'PUT') {
        let payload;
        try { payload = JSON.parse((await readBody(req)).toString('utf8')); } catch { return send(res, 400, { error: 'BAD_JSON' }); }
        try { return send(res, 200, getStore().saveSalesPrices(payload)); }
        catch (e) { return send(res, 400, { error: 'INVALID_SALES_PRICES', message: String(e.message || e).slice(0, 180) }); }
      }
      if (url.pathname === '/db/sales-sync' && req.method === 'POST') {
        let payload;
        try { payload = JSON.parse((await readBody(req)).toString('utf8')); } catch { return send(res, 400, { error: 'BAD_JSON' }); }
        try { return send(res, 200, getStore().applySalesSync(payload)); }
        catch (e) { return send(res, 400, { error: 'INVALID_SALES_SYNC', message: String(e.message || e).slice(0, 180) }); }
      }

      if (url.pathname === '/db/status' && req.method === 'GET') return send(res, 200, getStore().status());
      if (url.pathname === '/db/diagnostics' && req.method === 'GET') return send(res, 200, getStore().diagnostics());
      if (url.pathname === '/db/router-days' && req.method === 'GET') {
        return send(res, 200, { days: getStore().getAllRouterCardDays(), lastSync: getStore().getLastRouterSync(), runs: getStore().getRouterSyncRuns({ limit: 30 }) });
      }
      if (url.pathname === '/db/interface-readings' && req.method === 'GET') {
        try { const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 120; return send(res, 200, getStore().getInterfaceReadings({ limit })); }
        catch (e) { return send(res, 400, { error: 'INVALID_INTERFACE_FILTER', message: String(e.message || e).slice(0, 160) }); }
      }
      if (url.pathname === '/db/interface-restore' && req.method === 'POST') {
        let payload;
        try { payload = JSON.parse((await readBody(req)).toString('utf8')); } catch { return send(res, 400, { error: 'BAD_JSON' }); }
        try { return send(res, 200, getStore().restoreInterfaceReadings(payload.readings)); }
        catch (e) { return send(res, 400, { error: 'INVALID_INTERFACE_BACKUP', message: String(e.message || e).slice(0, 180) }); }
      }
      if (url.pathname === '/db/interface-readings' && req.method === 'POST') {
        let payload;
        try { payload = JSON.parse((await readBody(req)).toString('utf8')); } catch { return send(res, 400, { error: 'BAD_JSON' }); }
        try { return send(res, 200, getStore().saveInterfaceReading(payload)); }
        catch (e) { return send(res, 400, { error: 'INVALID_INTERFACE_READING', message: String(e.message || e).slice(0, 180) }); }
      }

      if (url.pathname === '/db/router-sync' && req.method === 'POST') {
        let payload;
        try { payload = JSON.parse((await readBody(req)).toString('utf8')); } catch { return send(res, 400, { error: 'BAD_JSON' }); }
        try { return send(res, 200, getStore().applyRouterSync(payload)); }
        catch (e) { return send(res, 400, { error: 'INVALID_ROUTER_SYNC', message: String(e.message || e).slice(0, 180) }); }
      }
      if (url.pathname === '/db/router-restore' && req.method === 'POST') {
        let payload;
        try { payload = JSON.parse((await readBody(req)).toString('utf8')); } catch { return send(res, 400, { error: 'BAD_JSON' }); }
        try { return send(res, 200, getStore().restoreRouterData(payload)); }
        catch (e) { return send(res, 400, { error: 'INVALID_ROUTER_BACKUP', message: String(e.message || e).slice(0, 180) }); }
      }
      if (url.pathname === '/db/month-openings' && req.method === 'GET') {
        const month=url.searchParams.get('month');
        try { return send(res,200,month?getStore().getMonthOpeningBalances(month):{months:getStore().getAllMonthOpeningBalances()}); }
        catch(e){ return send(res,400,{error:'BAD_MONTH',message:String(e.message||'').slice(0,120)}); }
      }
      if (url.pathname === '/db/month-openings' && req.method === 'PUT') {
        let payload; try { payload=JSON.parse((await readBody(req)).toString('utf8')); } catch { return send(res,400,{error:'BAD_JSON'}); }
        try { return send(res,200,getStore().saveMonthOpeningBalances(payload.month,payload.balances)); }
        catch(e){ return send(res,400,{error:'INVALID_MONTH_OPENINGS',message:String(e.message||'').slice(0,160)}); }
      }
      if (url.pathname === '/db/line-balances' && req.method === 'GET') {
        const day = url.searchParams.get('day');
        try { return send(res, 200, day ? getStore().getLineBalances(day) : { days: getStore().getAllLineBalances() }); }
        catch (e) { return send(res, 400, { error: 'BAD_DAY', message: String(e.message || '').slice(0, 120) }); }
      }
      if (url.pathname === '/db/line-balances' && req.method === 'PUT') {
        let payload;
        try { payload = JSON.parse((await readBody(req)).toString('utf8')); } catch { return send(res, 400, { error: 'BAD_JSON' }); }
        try { return send(res, 200, getStore().saveLineBalances(payload.day, payload)); }
        catch (e) { return send(res, 400, { error: 'INVALID_LINE_BALANCES', message: String(e.message || '').slice(0, 160) }); }
      }
      if (url.pathname === '/db/line-balances' && req.method === 'DELETE') {
        let payload;
        try { payload = JSON.parse((await readBody(req)).toString('utf8')); } catch { return send(res, 400, { error: 'BAD_JSON' }); }
        try { return send(res, 200, getStore().clearLineBalances(payload.day)); }
        catch (e) { return send(res, 400, { error: 'INVALID_LINE_BALANCES', message: String(e.message || '').slice(0, 160) }); }
      }
      if (url.pathname === '/db/import-state' && req.method === 'POST') {
        let payload;
        try { payload = JSON.parse((await readBody(req)).toString('utf8')); } catch { return send(res, 400, { error: 'BAD_JSON' }); }
        try { return send(res, 200, getStore().mergeImportedState(payload.state)); }
        catch (e) { return send(res, 400, { error: 'IMPORT_FAILED', message: String(e.message || 'invalid data').slice(0, 200) }); }
      }
      if (url.pathname === '/db/migrate' && req.method === 'POST') {
        let payload;
        try { payload = JSON.parse((await readBody(req)).toString('utf8')); } catch { return send(res, 400, { error: 'BAD_JSON' }); }
        try { return send(res, 200, getStore().migrateLegacy(payload)); }
        catch (e) { return send(res, 400, { error: 'MIGRATION_FAILED', message: String(e.message || 'invalid data').slice(0, 200) }); }
      }
      if (url.pathname.startsWith('/tcp/')) return await handleTcp(req, res, url);
      return handleStatic(req, res, url);
    } catch {
      if (!res.headersSent) send(res, 500, { error: 'internal' }); else res.end();
    }
  });

  return {
    server,
    start: () => new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
    stop: () => new Promise((resolve) => { for (const id of [...sessions.keys()]) dropSession(id); if (store) { store.close(); store = null; } server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 8787;
  const b = createBridge({ port });
  b.start().then((p) => {
    console.log(`الجسر يعمل: http://127.0.0.1:${p}/dev.html`);
    console.log('للإيقاف: Ctrl+C');
  });
}
