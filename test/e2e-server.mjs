// خادم مساعد لاختبار الصفحة في متصفح: راوتر وهمي (TCP) + الجسر + منفذ تحكم لتغيير حالة الراوتر الوهمي.
// يطبع سطر JSON فيه المنافذ. هذا ليس RouterOS حقيقياً.
import net from 'node:net';
import http from 'node:http';
import { createBridge } from '../bridge/server.js';
import { SentenceParser, encodeSentence } from '../core/routeros-api.js';
import { fakeRouterHandler } from './helpers.js';

const MB = 1024 * 1024;
const state = { uptime: '3d00:00:00', rx1: 100 * MB, tx1: 10 * MB, rx3: 50 * MB, tx3: 5 * MB };
const ifaces = () => [
  { '.id': '*1', name: 'ether1', type: 'ether', running: 'true', disabled: 'false', 'rx-byte': String(state.rx1), 'tx-byte': String(state.tx1) },
  { '.id': '*3', name: 'bridge1', type: 'bridge', running: 'true', disabled: 'false', 'rx-byte': String(state.rx3), 'tx-byte': String(state.tx3) },
  { '.id': '*4', name: 'vlan10', type: 'vlan', running: 'true', disabled: 'false', comment: '<b>بيت</b>', 'rx-byte': '300', 'tx-byte': '400' },
  { '.id': '*2', name: 'ether2', type: 'ether', running: 'false', disabled: 'false', 'rx-byte': '0', 'tx-byte': '0' },
  { '.id': '*5', name: 'vlan20', type: 'vlan', running: 'true', disabled: 'false', 'rx-byte': 'oops' },
];
let fake = net.createServer((sock) => {
  const handler = fakeRouterHandler({ uptime: state.uptime, ifaces: ifaces() }); const parser = new SentenceParser(); const ctx = {};
  sock.on('data', (d) => { for (const w of parser.push(new Uint8Array(d))) for (const s of handler(w, ctx) || []) sock.write(encodeSentence(s)); });
  sock.on('error', () => {});
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const bridge = createBridge({ port: 0, allowedPorts: null });
const bridgePort = await bridge.start();
const ctl = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/set') { for (const [k, v] of u.searchParams) state[k] = k === 'uptime' ? v : Number(v); }
  if (u.pathname === '/stop') { fake.close(); fake.closeAllConnections?.(); }
  res.end('ok');
});
await new Promise((r) => ctl.listen(0, '127.0.0.1', r));
console.log(JSON.stringify({ bridge: bridgePort, fake: fake.address().port, ctl: ctl.address().port }));
