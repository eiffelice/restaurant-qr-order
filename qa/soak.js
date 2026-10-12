'use strict';
/* รันต่อเนื่องดูหน่วยความจำรั่ว
   node qa/soak.js [นาที=30]
   โหลด: ลูกค้า 40 IP สั่งต่อเนื่อง, ปิดบิลเป็นระยะ, หน้าพนักงานดึง /api/state, SSE ต่อ/หลุดวนไป
   ผล: qa/out/soak-heap.jsonl และสรุปแนวโน้ม heap หลัง GC */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { makeApp, start, sleep, rmrf } = require('./lib');

async function main() {
  const minutes = +process.argv[2] || 30;
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  const log = path.join(__dirname, 'out', 'soak-heap.jsonl'); rmrf(log);
  const app = makeApp();
  const s = start(app.code, { HEAP_LOG: log, ORDER_LIMIT: '8' }, ['--expose-gc', '-r', path.join(__dirname, 'heap-probe.js')]);
  await s.ready; await s.login();
  const keys = (await s.call('GET', '/api/state')).json.keys;
  const end = Date.now() + minutes * 60000;
  let orders = 0, pays = 0, errs = 0, sse = 0, rejected = 0;
  const ips = Array.from({ length: 40 }, (_, i) => '127.0.1.' + (i + 1));
  const customer = async (ip, n) => {
    while (Date.now() < end) {
      const t = 1 + (n % 12);
      const r = await s.call('POST', '/api/order', { table: t, key: keys[t], items: [{ id: 1 + (n % 5), qty: 1 }], reqId: Math.random().toString(16).slice(2, 14) }, { staff: false, ip }).catch(() => null);
      if (r && r.status === 200) orders++; else if (r && r.status === 429) rejected++; else errs++;
      await s.call('GET', '/api/table?t=' + t + '&k=' + keys[t], undefined, { staff: false, ip }).catch(() => errs++);
      await sleep(7600);                                   // ไม่เกิน ORDER_LIMIT 8 ครั้ง/นาที
    }
  };
  const cashier = async () => {
    let t = 0;
    while (Date.now() < end) {
      t = 1 + (t % 12);
      const st = (await s.call('GET', '/api/state').catch(() => null));
      const b = st && st.json && st.json.bills[t];
      if (b) { const r = await s.call('POST', '/api/pay', { table: t, expectedSub: b.sub, method: t % 2 ? 'cash' : 'transfer', svc: true }).catch(() => null); if (r && r.status === 200) pays++; }
      await s.call('GET', '/api/report').catch(() => errs++);
      await sleep(3000);
    }
  };
  const screens = async () => {
    while (Date.now() < end) {
      await new Promise(resolve => {
        const req = http.get(s.B + '/api/events', { headers: { cookie: s.cookie }, agent: false }, res => { sse++; res.resume(); setTimeout(() => { req.destroy(); resolve(); }, 2000); });
        req.on('error', () => resolve());
      });
    }
  };
  const progress = setInterval(() => console.log(new Date().toLocaleTimeString() + ' ออเดอร์ ' + orders + ' บิล ' + pays + ' SSE ' + sse + ' 429 ' + rejected + ' error ' + errs), 60000);
  await Promise.all(ips.map((ip, i) => sleep(i * 190).then(() => customer(ip, i))).concat([cashier(), screens(), screens()]));
  clearInterval(progress);
  await sleep(11000);
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const st = (await s.call('GET', '/api/state')).json;
  await s.stop();
  const mb = x => (x / 1048576).toFixed(1);
  const pick = f => rows[Math.min(rows.length - 1, Math.floor(rows.length * f))];
  const a = pick(0.1), b = rows[rows.length - 1];
  const ds = fs.statSync(path.join(app.code, 'data.json')).size;
  console.log('\nสรุป ' + minutes + ' นาที: ออเดอร์ ' + orders + ', บิล ' + pays + ', SSE ต่อ/หลุด ' + sse + ', 429 ' + rejected + ', error ' + errs);
  console.log('heap หลัง GC: นาทีที่ ' + Math.round((a.t - rows[0].t) / 60000) + ' = ' + mb(a.heap) + ' MB → ท้าย = ' + mb(b.heap) + ' MB, RSS ' + mb(a.rss) + ' → ' + mb(b.rss) + ' MB, ตัวอย่าง ' + rows.length + ' จุด');
  console.log('ข้อมูลที่โตตามการใช้งานจริง: data.json ' + mb(ds) + ' MB, ตั๋วเปิดอยู่ ' + st.tickets.length);
  rmrf(app.base);
}
main().catch(e => { console.error(e); process.exit(2); });
