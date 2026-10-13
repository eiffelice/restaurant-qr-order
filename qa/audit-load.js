'use strict';
/* audit log ปลายเดือนของร้านที่ขายดี: เปิดแท็บสรุปยอดแล้วระบบยังลื่นไหม
   node qa/audit-load.js      (QA_FROM=<โค้ดเดิม> เพื่อวัดก่อนแก้)
   จำลอง audit 1 เดือน ~300 บิล/วัน (ออเดอร์ + เปลี่ยนสถานะ + รับเงิน ≈ 1,500 เหตุการณ์/วัน) ต่อ chain จริง */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { makeApp, start, sleep, rmrf, checker } = require('./lib');

function seedAudit(dir, perDay, days) {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  const f = path.join(dir, 'logs', 'audit-' + y + '-' + String(m + 1).padStart(2, '0') + '.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  let prev = '', out = [];
  const start0 = new Date(y, m, 1).getTime(), span = Math.max(1, Math.min(days, now.getDate() - 1)) * 86400000;
  const total = perDay * days;
  for (let i = 0; i < total; i++) {
    const ts = start0 + Math.floor(i / total * span);
    const rec = { at: new Date(ts).toISOString(), action: i % 5 === 4 ? 'bill.paid' : i % 5 ? 'ticket.status' : 'order.created', by: 'staff', ip: '192.168.1.' + (i % 50), dev: 'Android/Chrome', req: crypto.randomBytes(6).toString('hex'),
      table: 1 + i % 12, items: [{ name: 'ผัดกะเพราหมูสับ', qty: 2, price: 60 }, { name: 'ข้าวผัดกุ้ง', qty: 1, price: 90 }], value: 210, prev };
    rec.hash = crypto.createHash('sha256').update(prev + JSON.stringify(Object.assign({}, rec, { hash: undefined }))).digest('hex');
    delete rec.hash; rec.hash = crypto.createHash('sha256').update(prev + JSON.stringify(rec)).digest('hex');
    prev = rec.hash; out.push(JSON.stringify(rec));
  }
  fs.writeFileSync(f, out.join('\n') + '\n');
  return { lines: total, mb: fs.statSync(f).size / 1048576 };
}
function lagIn(log, from, to) {
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => l.split(' ').map(Number));
  return Math.max(0, ...rows.filter(([t]) => t >= from && t <= to + 300).map(r => r[1]));
}

async function main() {
  const ok = checker('audit-load');
  const app = makeApp(), lag = path.join(app.base, 'lag.log');
  const g = seedAudit(app.code, 1500, 30);
  console.log('audit จำลอง ' + g.lines + ' บรรทัด ' + g.mb.toFixed(1) + ' MB');
  const s = start(app.code, { LAG_LOG: lag }, ['-r', path.join(__dirname, 'lag-probe.js')]); await s.ready; await s.login();
  const keys = (await s.call('GET', '/api/state')).json.keys;
  await sleep(800);
  // แท็บสรุปยอดเปิดอยู่: ทุกออเดอร์ที่เข้า หน้าพนักงานโหลด /api/report และ /api/audit ใหม่
  const ms = [], from = Date.now();
  for (let i = 0; i < 15; i++) {
    await s.call('POST', '/api/order', { table: 1 + i % 12, key: keys[1 + i % 12], items: [{ id: 1, qty: 1 }] }, { staff: false });
    const t0 = Date.now(); const r = await s.call('GET', '/api/audit'); ms.push(Date.now() - t0);
    if (i === 0) console.log('ตรวจ chain: ' + JSON.stringify(r.json.chain) + ', เหตุการณ์วันนี้ ' + r.json.total);
  }
  const maxLag = lagIn(lag, from, Date.now());
  const first = ms[0], rest = ms.slice(1).sort((a, b) => a - b);
  console.log('GET /api/audit ครั้งแรก (ตรวจทั้งไฟล์) ' + first + ' ms, ครั้งต่อไป p50 ' + rest[7] + ' ms สูงสุด ' + rest[13] + ' ms · event loop lag สูงสุด ' + maxLag + ' ms');
  ok(rest[13] <= 100, 'หลังตรวจครั้งแรก เปิดประวัติการแก้ไขตอนปลายเดือนตอบภายใน 100 ms', rest[13]);
  ok(maxLag <= 50, 'ระบบไม่ค้างเกิน 50 ms ระหว่างแท็บสรุปยอดเปิดอยู่และมีออเดอร์เข้า', maxLag);
  await s.stop(); rmrf(app.base);
  ok.done();
}
main().catch(e => { console.error(e); process.exit(2); });
