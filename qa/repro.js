'use strict';
/* ทำให้บั๊กฝั่งเซิร์ฟเวอร์เกิดขึ้นจริง แบบรันซ้ำได้
   node qa/repro.js <เคส>          เคส: crash-order, dup-bill-crash, dup-bill-restore, restore-race, csv-injection, qr-guess, two-instances, all
   QA_FROM=<โฟลเดอร์โค้ดเดิม> node qa/repro.js <เคส>     รันกับโค้ดก่อนแก้
   ผลลัพธ์: "BUG" = ทำให้เกิดได้ (exit 1), "OK" = ไม่เกิด */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { makeApp, start, sleep, until, rmrf, salesLines } = require('./lib');

const JPG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(2000, 7)]);
const keysOf = async s => (await s.call('GET', '/api/state')).json.keys;
async function payTable(s, t, method) {
  const st = (await s.call('GET', '/api/state')).json;
  if (!st.bills[t]) return { status: 0 };
  return s.call('POST', '/api/pay', { table: t, method: method || 'cash', expectedSub: st.bills[t].sub, svc: true, vat: false });
}

const cases = {
  /* kill -9 ระหว่างออเดอร์เข้าต่อเนื่อง 20 รอบ: ออเดอร์/บิลที่ตอบ 200 แล้วต้องไม่หาย ไฟล์ต้องไม่เสีย เลขบิลต้องไม่ซ้ำ */
  async 'crash-order'() {
    const app = makeApp(); const problems = [];
    const ackOrders = new Map();   // memo -> table
    const ackPays = [];            // { no, table }
    const paidTables = new Set();
    // ปิดบิลที่ถูก kill -9 ก่อนได้คำตอบ: เซิร์ฟเวอร์อาจบันทึกไปแล้ว (บิลอยู่ใน sales/ ออเดอร์ของโต๊ะนั้นจึงหายจากจอถูกต้อง)
    // ไม่ใช่ "ตอบ 200 แล้วหาย" เดิมนับเป็นปัญหา (false positive บน Linux ราว 1 ใน 3 รอบ ทั้งโค้ดเก่าและใหม่)
    let inflight = null;
    for (let round = 1; round <= 20; round++) {
      const s = start(app.code); await s.ready; await s.login();
      const st = (await s.call('GET', '/api/state')).json;
      // ตรวจผลของรอบก่อน
      // ปัญหาแต่ละรายการนับครั้งเดียว แล้วเลิกติดตาม
      if (inflight) {
        const done = salesLines(app.code).some(l => !l._bad && l.table === inflight.t && l.at >= inflight.since && !ackPays.some(p => p.no === l.no));
        if (done) inflight.memos.forEach(m => paidTables.add(m));
        inflight = null;
      }
      const memos = new Set(st.tickets.map(k => k.memo));
      for (const [memo, t] of ackOrders) if (!memos.has(memo) && !paidTables.has(memo)) { problems.push('รอบ ' + round + ': ออเดอร์ ' + memo + ' (โต๊ะ ' + t + ') ตอบ 200 แล้วแต่หาย'); ackOrders.delete(memo); }
      const rep = (await s.call('GET', '/api/report')).json;
      const billNos = new Set(rep.bills.map(b => b.no));
      const lines = salesLines(app.code);
      const bad = lines.filter(l => l._bad); if (bad.length) problems.push('รอบ ' + round + ': sales มีบรรทัดเสีย ' + bad.length);
      const nos = lines.filter(l => !l._bad).map(l => l.no);
      const dup = nos.filter((n, i) => nos.indexOf(n) !== i);
      if (dup.length) problems.push('รอบ ' + round + ': เลขบิลใน sales ซ้ำ ' + JSON.stringify([...new Set(dup)]));
      for (let j = ackPays.length - 1; j >= 0; j--) {
        const p = ackPays[j];
        if (!billNos.has(p.no)) { problems.push('รอบ ' + round + ': บิล ' + p.no + ' ตอบ 200 แล้วแต่ไม่อยู่ในสรุปยอด'); ackPays.splice(j, 1); }
        else if (!nos.includes(p.no)) { problems.push('รอบ ' + round + ': บิล ' + p.no + ' ไม่อยู่ใน sales/'); ackPays.splice(j, 1); }
      }
      try { JSON.parse(fs.readFileSync(path.join(app.code, 'data.json'), 'utf8')); } catch (e) { problems.push('รอบ ' + round + ': data.json เสีย'); }
      if (round === 20) { await s.stop(); break; }
      // ยิงต่อเนื่อง แล้ว kill -9 ณ เวลาสุ่ม
      const keys = st.keys; let stop = false, i = 0;
      const killAt = 150 + Math.floor(Math.random() * 600);
      const loop = (async () => {
        while (!stop) {
          i++;
          const memo = 'r' + round + '-' + i, t = 1 + (i % 12);
          if (i % 9 === 0) {
            // ปิดบิลโต๊ะที่สั่งไว้ แล้วจดว่าออเดอร์ของโต๊ะนั้นถูกปิดไปแล้ว
            const tickets = (await s.call('GET', '/api/state').catch(() => null));
            if (!tickets || !tickets.json) continue;
            const open = tickets.json.tickets.filter(k => k.table === t);
            inflight = { t, since: Date.now() - 1000, memos: open.map(k => k.memo).concat([...ackOrders].filter(([, tt]) => tt === t).map(([m]) => m)) };
            const r = await payTable(s, t).catch(() => null);
            if (r) inflight = null;          // ได้คำตอบแล้ว (สำเร็จหรือไม่ก็รู้ผล)
            if (r && r.status === 200) { ackPays.push({ no: r.json.sale.no, table: t }); open.forEach(k => paidTables.add(k.memo)); for (const [m, tt] of ackOrders) if (tt === t) paidTables.add(m); }
            continue;
          }
          const r = await s.call('POST', '/api/order', { table: t, key: keys[t], items: [{ id: 1, qty: 1 }], memo }, { staff: false }).catch(() => null);
          if (r && r.status === 200) ackOrders.set(memo, t);
        }
      })();
      await sleep(killAt); await s.kill9(); stop = true; await loop.catch(() => {});
    }
    rmrf(app.base);
    const kinds = {};
    problems.forEach(p => { const k = p.replace(/^รอบ \d+: /, '').replace(/[\w-]*\d[\w-]*/g, '#').replace(/\(โต๊ะ #\) /, ''); kinds[k] = (kinds[k] || 0) + 1; });
    console.log('ติดตาม: ออเดอร์ที่ตอบ 200 และไม่หาย ' + ackOrders.size + ', บิลที่ตอบ 200 และไม่หาย ' + ackPays.length);
    console.log('สรุปปัญหา: ' + JSON.stringify(kinds));
    return problems;
  },

  /* data.json เขียนไม่ได้ (ถูกล็อก) ขณะปิดบิล แล้วโปรแกรมดับ: เปิดใหม่แล้วปิดบิลต่อ เลขบิลต้องไม่ซ้ำ */
  async 'dup-bill-crash'() {
    const app = makeApp(); const df = path.join(app.code, 'data.json');
    let s = start(app.code); await s.ready; await s.login();
    const keys = await keysOf(s);
    await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 1 }] });
    await sleep(400);
    fs.copyFileSync(df, df + '.keep');
    fs.rmSync(df); fs.mkdirSync(df);                        // เขียนทับ data.json ไม่ได้ (เหมือนถูกล็อก)
    const p1 = await payTable(s, 1);
    await s.kill9();
    rmrf(df); fs.renameSync(df + '.keep', df);              // บนดิสก์ยังเป็น data.json ก่อนปิดบิล
    s = start(app.code); await s.ready; await s.login();
    await s.call('POST', '/api/order', { table: 2, key: keys[2], items: [{ id: 1, qty: 1 }] });
    const p2 = await payTable(s, 2);
    await s.stop();
    const nos = salesLines(app.code).map(l => l.no);
    rmrf(app.base);
    console.log('บิลแรก no=' + (p1.json && p1.json.sale.no) + ', บิลหลังเปิดใหม่ no=' + (p2.json && p2.json.sale.no) + ', ใน sales/: ' + JSON.stringify(nos));
    return new Set(nos).size !== nos.length ? ['เลขบิลซ้ำใน sales/: ' + JSON.stringify(nos)] : [];
  },

  /* สำรอง → ปิดบิล (ให้ใบเสร็จลูกค้าไปแล้ว) → กู้คืนไฟล์สำรองนั้น → ปิดบิลใหม่: เลขบิลต้องไม่ซ้ำกับใบเสร็จที่ออกไปแล้ว */
  async 'dup-bill-restore'() {
    const app = makeApp();
    const s = start(app.code); await s.ready; await s.login();
    const keys = await keysOf(s);
    const name = (await s.call('POST', '/api/backup', {})).json.backup.name;
    const file = fs.readFileSync(path.join(app.code, 'backups', name));
    await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 1 }] });
    const p1 = await payTable(s, 1);
    const r = await s.call('POST', '/api/backup/restore', file, { headers: { 'content-type': 'application/gzip' } });
    await s.call('POST', '/api/order', { table: 2, key: keys[2], items: [{ id: 1, qty: 1 }] });
    const p2 = await payTable(s, 2);
    await s.stop(); rmrf(app.base);
    console.log('กู้คืน ' + r.status + ', ใบเสร็จก่อนกู้คืน no=' + p1.json.sale.no + ', หลังกู้คืน no=' + p2.json.sale.no);
    return p1.json.sale.no === p2.json.sale.no ? ['เลขบิล ' + p2.json.sale.no + ' ถูกใช้ซ้ำหลังกู้คืน'] : [];
  },

  /* ออเดอร์ที่ body มาถึงระหว่างกำลังกู้คืน: ถ้าตอบ 200 ออเดอร์ต้องอยู่ในข้อมูลหลังกู้คืน */
  async 'restore-race'() {
    const app = makeApp();
    const s = start(app.code); await s.ready; await s.login();
    // ข้อมูลให้ใหญ่พอที่การกู้คืนใช้เวลาหลายร้อยมิลลิวินาที
    const sd = path.join(app.code, 'sales'); fs.mkdirSync(sd, { recursive: true });
    const line = JSON.stringify({ no: 1, at: Date.now() - 400 * 86400000, table: 1, sub: 100, svc: 10, vat: 0, total: 110, method: 'cash', items: [{ name: 'ข้าวผัด', qty: 1, price: 100 }] }) + '\n';
    for (let m = 1; m <= 12; m++) fs.writeFileSync(path.join(sd, '2024-' + String(m).padStart(2, '0') + '.jsonl'), line.repeat(9000));
    const keys = await keysOf(s);
    const name = (await s.call('POST', '/api/backup', {})).json.backup.name;
    const file = fs.readFileSync(path.join(app.code, 'backups', name));
    const problems = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      const memo = 'race-' + attempt;
      const body = Buffer.from(JSON.stringify({ table: 3, key: keys[3], items: [{ id: 1, qty: 1 }], memo }));
      // เปิดคำขอสั่งอาหารค้างไว้ ส่ง body ไปครึ่งเดียว
      let orderRes;
      const orderDone = new Promise(resolve => {
        const req = http.request(s.B + '/api/order', { method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': body.length } }, res => {
          let t = ''; res.on('data', c => { t += c; }); res.on('end', () => { orderRes = { status: res.statusCode, text: t }; resolve(); });
        });
        req.on('error', e => { orderRes = { status: 'err', text: e.message }; resolve(); });
        req.write(body.subarray(0, 10));
        cases._finish = () => req.end(body.subarray(10));
      });
      await sleep(100);
      const restoring = s.call('POST', '/api/backup/restore', file, { headers: { 'content-type': 'application/gzip' } });
      // รอจนเห็นว่าระบบอยู่ในช่วงกู้คืน (POST อื่นได้ 503) แล้วค่อยส่ง body ส่วนที่เหลือ
      let saw503 = false;
      for (let i = 0; i < 400 && !saw503; i++) { saw503 = (await s.call('POST', '/api/call/clear', { table: 9 })).status === 503; if (!saw503) await sleep(5); }
      cases._finish();
      await orderDone; const rr = await restoring;
      if (rr.headers['set-cookie']) s.cookie = rr.headers['set-cookie'][0].split(';')[0];
      const tickets = (await s.call('GET', '/api/state')).json.tickets;
      const kept = tickets.some(k => k.memo === memo);
      console.log('รอบ ' + attempt + ': เห็น 503=' + saw503 + ', ออเดอร์ตอบ ' + orderRes.status + ', กู้คืนตอบ ' + rr.status + ', ออเดอร์อยู่หลังกู้คืน=' + kept);
      if (orderRes.status === 200 && !kept) problems.push('รอบ ' + attempt + ': ออเดอร์ตอบ 200 แต่หายหลังกู้คืน');
    }
    await s.stop(); rmrf(app.base);
    return problems;
  },

  /* race: กู้คืนสองคำขอพร้อมกัน และกดรับเงินโต๊ะเดียวกัน 50 คำขอพร้อมกัน (double spend) */
  async 'race'() {
    const app = makeApp(); const problems = [];
    const s = start(app.code); await s.ready; await s.login();
    const sd = path.join(app.code, 'sales'); fs.mkdirSync(sd, { recursive: true });
    const line = JSON.stringify({ no: 1, at: Date.UTC(2024, 0, 5), table: 1, sub: 100, svc: 10, vat: 0, total: 110, method: 'cash', items: [{ name: 'ข้าว', qty: 1, price: 100 }] }) + '\n';
    const months = ['2024-01', '2024-02', '2024-03', '2024-04', '2024-05', '2024-06'];
    months.forEach(m => fs.writeFileSync(path.join(sd, m + '.jsonl'), line.repeat(9000)));
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const file = fs.readFileSync(path.join(app.code, 'backups', (await s.call('POST', '/api/backup', {})).json.backup.name));
    for (let round = 1; round <= 3; round++) {
      const rs = await Promise.all([1, 2].map(() => s.call('POST', '/api/backup/restore', file, { headers: { 'content-type': 'application/gzip' } })));
      const okN = rs.filter(r => r.status === 200).length;
      rs.forEach(r => { if (r.headers['set-cookie']) s.cookie = r.headers['set-cookie'][0].split(';')[0]; });
      const files = fs.existsSync(sd) ? fs.readdirSync(sd).sort() : [];
      const sizes = files.map(f => fs.statSync(path.join(sd, f)).size);
      const st = await s.call('GET', '/api/state');
      console.log('รอบ ' + round + ': ผล ' + JSON.stringify(rs.map(r => r.status)) + ', sales/ ' + files.length + ' ไฟล์, ' + (rs.find(r => r.status !== 200) || { json: {} }).json.error);
      if (okN !== 1) problems.push('รอบ ' + round + ': กู้คืนพร้อมกันสำเร็จ ' + okN + ' คำขอ (ควรเป็น 1 อีกคำขอต้องถูกปฏิเสธ)');
      if (files.join() !== months.map(m => m + '.jsonl').join() || sizes.some(z => z !== Buffer.byteLength(line) * 9000)) problems.push('รอบ ' + round + ': sales/ หลังกู้คืนไม่ครบ ' + JSON.stringify(files));
      if (st.status !== 200 || st.json.health.saveError) problems.push('รอบ ' + round + ': ระบบผิดปกติหลังกู้คืน');
    }
    // double spend: 50 คำขอรับเงินโต๊ะเดียวกันพร้อมกัน
    await s.call('POST', '/api/order', { table: 4, key: keys[4], items: [{ id: 1, qty: 2 }] });
    const sub = (await s.call('GET', '/api/state')).json.bills[4].sub;
    const pays = await Promise.all(Array.from({ length: 50 }, (_, i) => s.call('POST', '/api/pay', { table: 4, expectedSub: sub, method: i % 2 ? 'cash' : 'transfer' })));
    const codes = {}; pays.forEach(p => { codes[p.status] = (codes[p.status] || 0) + 1; });
    const recorded = salesLines(app.code).filter(l => l.table === 4).length;
    console.log('รับเงินพร้อมกัน 50 คำขอ: ' + JSON.stringify(codes) + ', บันทึกใน sales/ ' + recorded + ' บิล');
    if (codes[200] !== 1 || recorded !== 1) problems.push('รับเงินซ้ำได้ ' + codes[200] + ' ครั้ง');
    await s.stop(); rmrf(app.base);
    return problems;
  },

  /* CSV injection: ค่าที่ขึ้นต้นด้วย -ตัวเลข แล้วตามด้วยสูตร (payload มาตรฐานของ OWASP) */
  async 'csv-injection'() {
    const app = makeApp();
    const s = start(app.code); await s.ready; await s.login();
    const payload = "-2+3+cmd|' /C calc'!A0";
    const it = (await s.call('POST', '/api/menu/item', { name: payload, price: 10, cat: 1, station: 'hot' })).json.item;
    const keys = await keysOf(s);
    await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: it.id, qty: 1 }] });
    await payTable(s, 1);
    const csv = (await s.call('GET', '/api/export.csv')).text;
    await s.stop(); rmrf(app.base);
    const row = csv.split('\r\n')[1] || '';
    const cell = row.split('","').pop().replace(/"$/, '');
    console.log('ช่องรายการใน CSV: ' + cell);
    return /^[=+\-@]/.test(cell) ? ['ช่อง CSV ขึ้นต้นด้วย ' + cell[0] + ' โดยไม่มี \' นำหน้า Excel จะตีความเป็นสูตร'] : [];
  },

  /* เดารหัส QR: ยิงรหัสผิดจาก IP เดียว ระบบควรจำกัดก่อนจะเดาได้ไม่จำกัด */
  async 'qr-guess'() {
    const app = makeApp();
    const s = start(app.code, { ORDER_LIMIT: '8' }); await s.ready;
    const t0 = Date.now(); const codes = {};
    for (let i = 0; i < 300; i++) {
      const k = (0x10000000 + i).toString(16);
      const r = await s.call('GET', '/api/table?t=1&k=' + k, undefined, { staff: false });
      codes[r.status] = (codes[r.status] || 0) + 1;
    }
    const ms = Date.now() - t0;
    await s.stop(); rmrf(app.base);
    const rate = Math.round(300 / ms * 1000);
    console.log('ผล 300 ครั้ง: ' + JSON.stringify(codes) + ' ใน ' + ms + ' ms (~' + rate + ' ครั้ง/วินาที จากเครื่องเดียว)');
    console.log('รหัส 8 hex = 2^32 แบบ เดาโต๊ะหนึ่งได้เฉลี่ยใน ~' + Math.round(2 ** 31 / rate / 86400) + ' วันจาก IP เดียว (ถ้าไม่จำกัด)');
    return !codes[429] ? ['เดารหัส QR ผิด 300 ครั้งติดจาก IP เดียวโดยไม่ถูกจำกัดเลย'] : [];
  },

  /* เปิดระบบสองหน้าต่างบนข้อมูลชุดเดียวกัน (ทำตามคำแนะนำ PORT=3001 ในข้อความ error) */
  async 'two-instances'() {
    const app = makeApp();
    const a = start(app.code); await a.ready; await a.login();
    const b = start(app.code);
    let bStarted = true;
    try { await b.ready; } catch (e) { bStarted = false; console.log('หน้าต่างที่สองไม่ยอมเปิด: ' + (e.out || e.message).split('\n').filter(Boolean).slice(-2).join(' ')); }
    const problems = [];
    if (bStarted) {
      await b.login();
      const keys = await keysOf(a);
      await a.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 1 }], memo: 'จาก A' });
      await b.call('POST', '/api/order', { table: 2, key: keys[2], items: [{ id: 1, qty: 1 }], memo: 'จาก B' });
      const pa = await payTable(a, 1), pb = await payTable(b, 2);
      await sleep(400); await a.stop(); await b.stop();
      const d = JSON.parse(fs.readFileSync(path.join(app.code, 'data.json'), 'utf8'));
      const nos = salesLines(app.code).map(l => l.no);
      console.log('สองหน้าต่างเปิดพร้อมกันได้, บิล A no=' + pa.json.sale.no + ', บิล B no=' + pb.json.sale.no + ', data.json มียอดขาย ' + d.sales.length + ' บิล, sales/ ' + JSON.stringify(nos));
      problems.push('เปิดระบบซ้อนบนข้อมูลชุดเดียวกันได้');
      if (new Set(nos).size !== nos.length) problems.push('เลขบิลซ้ำใน sales/');
      if (d.sales.length < 2) problems.push('data.json เหลือยอดขายแค่ ' + d.sales.length + ' จาก 2 บิล (อีกหน้าต่างเขียนทับ)');
    } else { await a.stop(); }
    rmrf(app.base);
    return problems;
  }
};

async function main() {
  const which = process.argv[2] || 'all';
  const names = which === 'all' ? Object.keys(cases).filter(n => !n.startsWith('_')) : [which];
  let bugs = 0;
  for (const n of names) {
    if (!cases[n]) { console.error('ไม่รู้จักเคส ' + n); process.exit(2); }
    console.log('\n=== ' + n + (process.env.QA_FROM ? '  (โค้ดจาก ' + process.env.QA_FROM + ')' : '') + ' ===');
    const t0 = Date.now();
    const problems = await cases[n]();
    problems.slice(0, 15).forEach(p => console.log('  - ' + p));
    if (problems.length > 15) console.log('  ... และอีก ' + (problems.length - 15) + ' ข้อ');
    console.log(problems.length ? 'BUG (' + problems.length + ')' : 'OK', '·', Date.now() - t0, 'ms');
    if (problems.length) bugs++;
  }
  process.exitCode = bugs ? 1 : 0;
}
main().catch(e => { console.error(e); process.exit(2); });
