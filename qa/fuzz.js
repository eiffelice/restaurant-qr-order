'use strict';
/* Fuzz ทุก API: ยิงข้อมูลผิดรูปแบบ (ชนิดผิด ค่าสุดโต่ง ข้อความยาว path traversal JSON เสีย content-type ผิด)
   เข้าทุก endpoint ทั้งในฐานะเจ้าของ แคชเชียร์ ครัว และลูกค้า (ไม่มี cookie)
   ผ่านเมื่อ: ไม่มีคำตอบ 5xx, เซิร์ฟเวอร์ไม่ล่ม, เปิดใหม่ได้โดยไม่ต้องซ่อมข้อมูล, ไม่มี request_failed ใน app log, audit chain ครบ
   รัน: node qa/fuzz.js [จำนวนครั้งต่อ endpoint ต่อบทบาท=40]   ใส่ FUZZ_SEED=123 เพื่อสุ่มชุดเดิมซ้ำ */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { makeApp, start, sleep, rmrf, checker, PIN, ROOT } = require('./lib');

const N = +process.argv[2] || 40;
let seed = +process.env.FUZZ_SEED || Date.now() % 100000;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = a => a[Math.floor(rnd() * a.length)];

const WEIRD = [
  undefined, null, true, false, 0, -1, 1, 1.5, -0.01, 1e9, -1e9, 2 ** 53, Number.MAX_VALUE, '', ' ', '0', '1', '-1', 'NaN', 'Infinity',
  'x'.repeat(5000), '<img src=x onerror=alert(1)>', '../../data.json', '..\\..\\server.js', '%2e%2e/', '=cmd|calc', '\u0000', '\ud800', 'ไทย 🍜',
  [], [1, 2], [null], [{}], {}, { a: 1 }, { __proto__: { admin: true } }, { constructor: { prototype: { x: 1 } } }, '#ffffff', '#00ff00', 'red;}', '25:61', '00:00', '23:59',
  'owner', 's1', 'cash', 'transfer', 'bill', 'staff', 'new', 'cooking', 'ready', 'served', 'kitchen', 'cashier', 'hot',
  'buy', 'sell', 'wholesale', 'retail', 'cafe', 'buyback', 0.333, 0.0004, 10001
];
const FIELDS = ['table', 'key', 'id', 'items', 'memo', 'reqId', 'kind', 'status', 'from', 'reason', 'approvePin', 'expectedSub', 'svc', 'vat', 'method',
  'received', 'name', 'price', 'cat', 'station', 'desc', 'hidden', 'was', 'notes', 'dir', 'soldOut', 'shop', 'promptpay', 'tables', 'baseUrl',
  'acceptOrders', 'accent', 'requireSeat', 'hours', 'pin', 'role', 'active', 'open', 'expect', 'address', 'phone', 'taxId', 'footer',
  'level', 'kitchen', 'biz', 'modes', 'sku', 'unit', 'dec', 'price2'];
function value(depth) {
  const r = rnd();
  if (depth < 2 && r < 0.12) return Array.from({ length: Math.floor(rnd() * 4) }, () => ({ id: value(depth + 1), qty: value(depth + 1), note: value(depth + 1) }));
  if (depth < 2 && r < 0.2) return { on: value(depth + 1), open: value(depth + 1), close: value(depth + 1) };
  if (depth < 2 && r < 0.25) return { table: value(depth + 1), kitchen: value(depth + 1), counter: value(depth + 1), buy: value(depth + 1) };
  return pick(WEIRD);
}
function body() {
  if (rnd() < 0.1) return pick([null, [], 'x', 42, true]);
  const o = {};
  const n = 1 + Math.floor(rnd() * 6);
  for (let i = 0; i < n; i++) o[pick(FIELDS)] = value(0);
  return o;
}
const QUERIES = () => '?' + ['t', 'k', 'id', 'name', 'month', 'date', 'kind', 'accent'].filter(() => rnd() < 0.5).map(k => { let v; try { v = encodeURIComponent(String(pick(WEIRD))); } catch (e) { v = '%ED%A0%80%zz'; } return k + '=' + v; }).join('&');   // ตัวอักษรที่ encode ไม่ได้ → ส่ง % เสียแทน

function req(s, method, p, raw, headers) {
  return new Promise(resolve => {
    const r = http.request(s.B + p, { method, headers: Object.assign({}, headers || {}), agent: false, timeout: 10000 }, res => {
      let t = ''; res.on('data', c => { if (t.length < 2000) t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t }));
    });
    r.on('error', e => resolve({ status: 0, text: String(e.code || e) }));
    r.on('timeout', () => { r.destroy(); resolve({ status: -1, text: 'timeout' }); });
    if (raw !== undefined) r.end(raw); else r.end();
  });
}

(async () => {
  const ok = checker('fuzz');
  console.log('seed', seed, 'ครั้งต่อ endpoint ต่อบทบาท', N);
  const app = makeApp(); const s = start(app.code, { PORT: String(6500 + Math.floor(Math.random() * 300)) }); await s.ready; await s.login();
  // เปิดทุกวิธีขาย (โต๊ะ จอครัว หน้าร้าน รับซื้อ) ให้ fuzz เข้าถึงโค้ดขายหน้าร้านและคิวด้วย
  await s.call('POST', '/api/settings', { modes: { table: true, kitchen: true, counter: true, buy: true } });
  const cash = (await s.call('POST', '/api/staff', { name: 'ฟัซ', role: 'cashier', pin: '611111' })).json;
  const kit = (await s.call('POST', '/api/staff', { name: 'ฟัซครัว', role: 'kitchen', pin: '622222' })).json;
  const wai = (await s.call('POST', '/api/staff', { name: 'ฟัซเสิร์ฟ', role: 'waiter', pin: '633333' })).json;
  // cookie ของแคชเชียร์/พนักงานเสิร์ฟ/ครัว (login ผ่าน lib ใช้ cookie เจ้าของ จึงเรียกตรง)
  const cookieOf = pin => new Promise(resolve => {
    const d = JSON.stringify({ pin });
    const r = http.request(s.B + '/api/login', { method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d) } }, res => { res.resume(); res.on('end', () => resolve((res.headers['set-cookie'] || [''])[0].split(';')[0])); });
    r.end(d);
  });
  const roles = { owner: s.cookie, cashier: await cookieOf('611111'), waiter: await cookieOf('633333'), kitchen: await cookieOf('622222'), guest: '' };
  ok(cash && kit && wai && roles.cashier && roles.waiter && roles.kitchen, 'เตรียมบัญชีทดสอบ');
  const keys = (await s.call('GET', '/api/state')).json.keys;
  const { api } = require(path.join(app.code, 'lib', 'routes.js'));
  // endpoint ที่ทำให้บัญชีทดสอบหลุดเอง ข้ามไป (ไม่ใช่ช่องโหว่ แต่ทำให้ fuzz ต่อไม่ได้)
  const SKIP = new Set(['POST /api/logout', 'POST /api/login', 'POST /api/staff/logout-all', 'POST /api/backup/restore']);
  const eps = Object.keys(api).filter(k => !SKIP.has(k)).concat(['GET /api/events-x', 'GET /img/../data.json', 'GET /theme.css', 'GET /order', 'GET /staff']);
  const fails = []; let total = 0; const codes = {};
  for (const ep of eps) {
    const [method, p0] = ep.split(' ');
    for (const [role, ck] of Object.entries(roles)) {
      for (let i = 0; i < N; i++) {
        const headers = ck ? { cookie: ck } : {};
        let raw;
        const p = p0 + (method === 'GET' || rnd() < 0.3 ? QUERIES() : '');
        if (method === 'POST') {
          const mode = rnd();
          if (mode < 0.08) { raw = '{"broken": '; headers['content-type'] = 'application/json'; }                  // JSON เสีย
          else if (mode < 0.14) { raw = 'a=1&b=2'; headers['content-type'] = 'application/x-www-form-urlencoded'; } // content-type ผิด
          else if (mode < 0.18) { raw = Buffer.alloc(200, 0xff); headers['content-type'] = pick(['image/png', 'image/jpeg', 'application/gzip']); }
          else { const b = body(); raw = JSON.stringify(b === undefined ? {} : b); headers['content-type'] = 'application/json'; }
          // ให้ลูกค้าบางครั้งใช้รหัส QR จริงของโต๊ะ เพื่อเข้าไปถึงโค้ดตรวจข้อมูลข้างใน
          if (role === 'guest' && headers['content-type'] === 'application/json' && rnd() < 0.5) {
            try { const o = JSON.parse(raw); if (o && typeof o === 'object' && !Array.isArray(o)) { const t = 1 + Math.floor(rnd() * 12); o.table = t; o.key = keys[t]; raw = JSON.stringify(o); } } catch (e) { /* ignore */ }
          }
        }
        const r = await req(s, method, p, raw, headers);
        total++; codes[r.status] = (codes[r.status] || 0) + 1;
        if (r.status >= 500 || r.status <= 0) fails.push({ ep, role, status: r.status, body: String(raw).slice(0, 200), text: r.text.slice(0, 200) });
      }
    }
  }
  console.log('ยิงทั้งหมด', total, 'ครั้ง', JSON.stringify(codes));
  ok(fails.length === 0, 'ไม่มีคำตอบ 5xx หรือการเชื่อมต่อหลุด', fails.slice(0, 5));
  const alive = await req(s, 'GET', '/api/menu');
  ok(alive.status === 200, 'เซิร์ฟเวอร์ยังตอบปกติหลัง fuzz');
  // ข้อมูลบนดิสก์ยังดี: ปิดแล้วเปิดใหม่ ต้องไม่ต้องซ่อม
  const dir = app.code; await s.stop();
  const s2 = start(app.code, { PORT: String(6900 + Math.floor(Math.random() * 90)) });
  let started = true; try { await s2.ready; } catch (e) { started = false; }
  ok(started, 'เปิดระบบใหม่บนข้อมูลหลัง fuzz ได้');
  const appLog = fs.readdirSync(path.join(dir, 'logs')).filter(f => f.startsWith('app-')).map(f => fs.readFileSync(path.join(dir, 'logs', f), 'utf8')).join('\n');
  ok(!/request_failed/.test(appLog), 'ไม่มี error 500 ใน app log', (appLog.match(/.*request_failed.*/g) || []).slice(0, 2));
  ok(!/"dropped":[1-9]|data_repaired|recovered/.test(appLog), 'ไม่มีข้อมูลเสียที่ต้องตัดทิ้งตอนเปิดใหม่', (appLog.match(/.*(dropped|repaired|recovered).*/g) || []).slice(0, 2));
  if (started) {
    await s2.login();
    const au = await s2.call('GET', '/api/audit');
    ok(au.status === 200 && au.json.chain && au.json.chain.ok, 'audit chain ครบหลัง fuzz', au.json && au.json.chain);
    const st = (await s2.call('GET', '/api/state')).json;
    ok(st && st.settings && Array.isArray(st.menu.items) && typeof st.keys === 'object', 'ข้อมูลร้านอ่านได้ครบ');
    await s2.stop();
  }
  rmrf(app.base);
  ok.done();
})().catch(e => { console.error(e); process.exit(2); });
