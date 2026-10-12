'use strict';
/* ประสิทธิภาพกับข้อมูลจำลอง 1 ปี (300 บิล/วัน, รูป 50 รูป)
   node qa/perf.js            (QA_FROM=<โค้ดเดิม> เพื่อวัดก่อนแก้)
   วัด: event loop lag ตอนว่าง/บันทึก/สำรอง/กู้คืน, เวลาตอบ API, ขนาดไฟล์สำรอง, ยิง 200 ออเดอร์ใน 10 วินาทีจาก 40 IP */
const fs = require('node:fs');
const path = require('node:path');
const { makeApp, start, sleep, rmrf, checker } = require('./lib');

const DAY = 86400000;
function seed(dir) {
  const D = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
  const m = D.menu;
  while (m.items.length < 60) m.items.push({ id: m.nextId++, name: 'เมนูทดสอบ ' + m.nextId, price: 40 + (m.nextId % 50), cat: m.categories[m.nextId % m.categories.length].id, station: 'hot', desc: 'ข้าวผัดกุ้งใส่ไข่ ' + m.nextId, image: '', hidden: false });
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  for (let i = 0; i < 50; i++) {        // รูปหลังย่อในเบราว์เซอร์ราว 60-120 KB เนื้อไฟล์ JPEG บีบอัดซ้ำไม่ลง
    const name = 'm' + m.items[i].id + '-' + (0x10000000 + i).toString(16) + '.jpg';
    fs.writeFileSync(path.join(dir, 'images', name), Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), require('crypto').randomBytes(60000 + (i * 1200))]));
    m.items[i].image = name;
  }
  const now = Date.now(), files = {};
  let no = 1; const recent = [];
  for (let d = 365; d >= 0; d--) {
    for (let b = 0; b < 300; b++) {
      const at = now - d * DAY - (300 - b) * 100000;
      const items = [1, 2, 3].map(k => { const it = m.items[(no * k) % m.items.length]; return { name: it.name, qty: 1 + (k % 2), price: it.price }; });
      const sub = items.reduce((a, i) => a + i.price * i.qty, 0), svc = Math.round(sub * 0.1);
      const s = { no: no++, at, table: 1 + (b % 12), sub, svc, vat: 0, total: sub + svc, method: b % 3 ? 'cash' : 'transfer', items };
      const d0 = new Date(at), f = d0.getFullYear() + '-' + String(d0.getMonth() + 1).padStart(2, '0') + '.jsonl';
      (files[f] = files[f] || []).push(JSON.stringify(s));
      if (d < 8) recent.push(s);
    }
  }
  fs.mkdirSync(path.join(dir, 'sales'), { recursive: true });
  for (const f of Object.keys(files)) fs.writeFileSync(path.join(dir, 'sales', f), files[f].join('\n') + '\n');
  D.sales = recent; D.nextBill = no; D.salesArchived = true;
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(D));
  return { bills: no - 1, months: Object.keys(files).length };
}
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
async function timed(fn) { const t = process.hrtime.bigint(); const r = await fn(); return [Number(process.hrtime.bigint() - t) / 1e6, r]; }
function lagIn(log, from, to) {
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => l.split(' ').map(Number));
  return Math.max(0, ...rows.filter(([t]) => t >= from && t <= to + 300).map(r => r[1]));
}

async function main() {
  const ok = checker('perf');
  const app = makeApp(); const log = path.join(app.base, 'lag.log');
  let s = start(app.code); await s.ready; await s.stop();
  const g = seed(app.code);
  console.log('ข้อมูลจำลอง: ' + g.bills + ' บิล ' + g.months + ' ไฟล์เดือน รูป 50 รูป, data.json ' + (fs.statSync(path.join(app.code, 'data.json')).size / 1048576).toFixed(2) + ' MB');
  const t0 = Date.now();
  s = start(app.code, { LAG_LOG: log, ORDER_LIMIT: '8' }, ['-r', path.join(__dirname, 'lag-probe.js')]); await s.ready; await s.login();
  console.log('เปิดระบบ (โหลด + ตรวจ sales/): ' + (Date.now() - t0) + ' ms');
  const keys = (await s.call('GET', '/api/state')).json.keys;
  await sleep(1500);
  const idleFrom = Date.now(); await sleep(2000);
  const idle = lagIn(log, idleFrom, Date.now());

  // เวลาตอบ
  const times = {};
  for (const [name, p] of [['/api/state', '/api/state'], ['/api/menu', '/api/menu'], ['/api/report', '/api/report'], ['/api/table', '/api/table?t=1&k=' + keys[1]]]) {
    const a = []; for (let i = 0; i < 40; i++) a.push((await timed(() => s.call('GET', p)))[0]);
    times[name] = { p50: +pct(a, 0.5).toFixed(1), p95: +pct(a, 0.95).toFixed(1) };
  }
  const [csvMs, csv] = await timed(() => s.call('GET', '/api/export.csv'));
  // บันทึก: ออเดอร์ทีละรายการ (แต่ละครั้งเขียน data.json)
  const saveFrom = Date.now(); const orderMs = [];
  for (let i = 0; i < 40; i++) orderMs.push((await timed(() => s.call('POST', '/api/order', { table: 1 + (i % 12), key: keys[1 + (i % 12)], items: [{ id: 1, qty: 1 }] })))[0]);
  const saveLag = lagIn(log, saveFrom, Date.now());
  // ปิดบิล
  const payFrom = Date.now();
  for (let t = 1; t <= 12; t++) { const st = (await s.call('GET', '/api/state')).json; if (st.bills[t]) await s.call('POST', '/api/pay', { table: t, expectedSub: st.bills[t].sub, method: 'cash' }); }
  const payLag = lagIn(log, payFrom, Date.now());
  // สำรอง ขณะมีออเดอร์เข้าต่อเนื่อง
  let during = []; let busy = true;
  const bg = (async () => { let i = 0; while (busy) { during.push((await timed(() => s.call('GET', '/api/table?t=2&k=' + keys[2], undefined, { staff: false })))[0]); await sleep(20); i++; } })();
  const bkFrom = Date.now();
  const [bkMs, bk] = await timed(() => s.call('POST', '/api/backup', {}));
  busy = false; await bg;
  const bkLag = lagIn(log, bkFrom, Date.now());
  const bkSize = bk.json.backup.size;
  // กู้คืน (ระบบหยุดรับ POST อยู่แล้ว วัดไว้เป็นข้อมูล)
  const file = fs.readFileSync(path.join(app.code, 'backups', bk.json.backup.name));
  const rsFrom = Date.now();
  const [rsMs, rs] = await timed(() => s.call('POST', '/api/backup/restore', file, { headers: { 'content-type': 'application/gzip' } }));
  const rsLag = lagIn(log, rsFrom, Date.now());
  if (rs.headers['set-cookie']) s.cookie = rs.headers['set-cookie'][0].split(';')[0];

  // 200 ออเดอร์ใน 10 วินาทีจาก 40 IP (IP ละ 5 ครั้ง ไม่เกิน ORDER_LIMIT) + กดซ้ำด้วย reqId เดิม 20 ครั้ง
  const before = (await s.call('GET', '/api/state')).json.tickets.length;
  const sent = []; const burstFrom = Date.now();
  await Promise.all(Array.from({ length: 40 }, (_, ip) => (async () => {
    for (let j = 0; j < 5; j++) {
      await sleep(Math.random() * 1900);
      const memo = 'b' + ip + '-' + j, t = 1 + ((ip + j) % 12), reqId = require('crypto').randomBytes(8).toString('hex');
      const r = await s.call('POST', '/api/order', { table: t, key: keys[t], items: [{ id: 2, qty: 1 }], memo, reqId }, { staff: false, ip: '127.0.2.' + (ip + 1) });
      sent.push({ memo, status: r.status, t, reqId, ip });
    }
  })()));
  const burstMs = Date.now() - burstFrom; const burstLag = lagIn(log, burstFrom, Date.now());
  const again = sent.slice(0, 20);
  const dupRes = await Promise.all(again.map(x => s.call('POST', '/api/order', { table: x.t, key: keys[x.t], items: [{ id: 2, qty: 1 }], memo: x.memo, reqId: x.reqId }, { staff: false, ip: '127.0.3.' + (x.ip + 1) })));
  const tickets = (await s.call('GET', '/api/state')).json.tickets;
  const memos = tickets.map(k => k.memo).filter(m => /^b\d+-\d+$/.test(m));
  const acked = sent.filter(x => x.status === 200).map(x => x.memo);
  await s.stop();
  const disk = JSON.parse(fs.readFileSync(path.join(app.code, 'data.json'), 'utf8')).tickets.map(k => k.memo).filter(m => /^b\d+-\d+$/.test(m));

  console.log('\nevent loop lag สูงสุด (ms): ว่าง ' + idle + ' | ออเดอร์ทีละรายการ ' + saveLag + ' | ปิดบิล ' + payLag + ' | สำรอง ' + bkLag + ' | 200 ออเดอร์ ' + burstLag + ' | กู้คืน ' + rsLag);
  console.log('เวลาตอบ (ms): ' + JSON.stringify(times) + ', สั่งอาหาร p50/p95 ' + pct(orderMs, 0.5).toFixed(1) + '/' + pct(orderMs, 0.95).toFixed(1) + ', CSV เดือนนี้ ' + csvMs.toFixed(0) + ' (' + (csv.buf.length / 1048576).toFixed(1) + ' MB)');
  console.log('สำรอง ' + bkMs.toFixed(0) + ' ms ขนาด ' + (bkSize / 1048576).toFixed(1) + ' MB · ระหว่างสำรอง ลูกค้าดูสถานะโต๊ะ p95 ' + pct(during, 0.95).toFixed(1) + ' ms สูงสุด ' + Math.max(...during).toFixed(1) + ' ms · กู้คืน ' + rsMs.toFixed(0) + ' ms');
  console.log('ยิง 200 ออเดอร์ใน ' + burstMs + ' ms: ตอบ 200 = ' + acked.length + ', สถานะอื่น ' + JSON.stringify(sent.filter(x => x.status !== 200).map(x => x.status)) + ', ตั๋วใหม่ ' + (tickets.length - before));
  ok(idle <= 50 && saveLag <= 50 && payLag <= 50 && bkLag <= 50 && burstLag <= 50, 'event loop lag ระหว่างบันทึกและสำรอง ≤ 50 ms');
  ok(acked.length === 200, 'ออเดอร์ 200 ครั้งตอบ 200 ครบ');
  ok(new Set(memos).size === memos.length && acked.every(m => memos.includes(m)), 'ไม่มีออเดอร์หายหรือซ้ำ (ในหน่วยความจำ)');
  ok(acked.every(m => disk.includes(m)) && disk.length === new Set(disk).size, 'ไม่มีออเดอร์หายหรือซ้ำ (ใน data.json หลังปิดโปรแกรม)');
  ok(dupRes.every(r => r.status === 200) && memos.length === 200, 'กดซ้ำด้วย reqId เดิม 20 ครั้ง (แม้คนละ IP) ไม่สร้างออเดอร์ซ้ำ', memos.length);
  rmrf(app.base);
  ok.done();
}
main().catch(e => { console.error(e); process.exit(2); });
