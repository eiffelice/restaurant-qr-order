'use strict';
/* อัปเดตร้านที่ใช้งานอยู่: เปิดโค้ดเวอร์ชันเก่าสร้างข้อมูลจริง แล้ววางโค้ดใหม่ทับในโฟลเดอร์เดียวกัน เปิดใหม่
   ต้องไม่เสีย: ออเดอร์ค้าง รหัส QR ที่พิมพ์ไว้ ยอดขาย เลขบิล PIN พนักงาน log และไฟล์สำรองจากเวอร์ชันเก่ากู้คืนได้
   รัน: node qa/upgrade.js <โฟลเดอร์โค้ดเวอร์ชันเก่า>   เช่น git worktree add ../old main แล้ว node qa/upgrade.js ../old */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { makeApp, start, rmrf, checker, PIN, ROOT } = require('./lib');

const OLD = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(OLD, 'server.js'))) { console.error('ระบุโฟลเดอร์โค้ดเวอร์ชันเก่า'); process.exit(2); }

const loginCookie = (s, pin) => new Promise(resolve => {
  const d = JSON.stringify({ pin });
  const r = http.request(s.B + '/api/login', { method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d) } }, res => {
    res.resume(); res.on('end', () => resolve({ status: res.statusCode, cookie: (res.headers['set-cookie'] || [''])[0].split(';')[0] }));
  });
  r.end(d);
});
const get = (s, p, cookie) => fetch(s.B + p, { headers: cookie ? { cookie } : {} }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));

(async () => {
  const ok = checker('upgrade');
  const app = makeApp({ from: OLD });
  // ---------- เวอร์ชันเก่า: ร้านใช้งานจริง ----------
  let s = start(app.code); await s.ready; await s.login();
  await s.call('POST', '/api/settings', { shop: 'ร้านเดิม', promptpay: '0812345678', vat: true });   // ร้านเดิมเปิด VAT 7% (แบบเก่า: ค่าเริ่มต้นต่อบิล)
  await s.call('POST', '/api/staff', { name: 'แคชเชียร์เดิม', role: 'cashier', pin: '555111' });
  await s.call('POST', '/api/staff', { name: 'หุ้นส่วน', role: 'owner', pin: '555222' });
  const old = (await s.call('GET', '/api/state')).json;
  const keys = old.keys;
  for (const t of [1, 2]) await s.call('POST', '/api/order', { table: t, key: keys[t], items: [{ id: 1, qty: 2, note: ['ไม่เผ็ด'] }, { id: 3, qty: 1 }] }, { staff: false });
  const sub2 = (await s.call('GET', '/api/state')).json.bills[2].sub;
  const paid = (await s.call('POST', '/api/pay', { table: 2, expectedSub: sub2, vat: true, method: 'cash', received: 1000 })).json.sale;
  const cashOld = await loginCookie(s, '555111'), ownerOld = await loginCookie(s, PIN);
  const bk = (await s.call('POST', '/api/backup', {})).json.backup;
  const bkFile = fs.readFileSync(path.join(app.code, 'backups', bk.name));
  const before = (await s.call('GET', '/api/state')).json;
  await s.stop();
  // ---------- วางโค้ดใหม่ทับ (เหมือนเจ้าของร้านแตกไฟล์เวอร์ชันใหม่ทับโฟลเดอร์เดิม) ----------
  fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(app.code, 'server.js'));
  for (const d of ['lib', 'public']) { fs.rmSync(path.join(app.code, d), { recursive: true, force: true }); fs.cpSync(path.join(ROOT, d), path.join(app.code, d), { recursive: true }); }
  fs.copyFileSync(path.join(ROOT, 'menu.json'), path.join(app.code, 'menu.json'));
  s = start(app.code); let up = true; try { await s.ready; } catch (e) { up = false; console.log(e.message); }
  ok(up, 'เปิดเวอร์ชันใหม่บนข้อมูลเดิมได้');
  if (!up) { rmrf(app.base); return ok.done(); }
  // ---------- ตรวจหลังอัปเดต ----------
  ok((await get(s, '/api/state', cashOld.cookie)).status === 200, 'แท็บเล็ตแคชเชียร์ที่เข้าอยู่ ไม่หลุด (cookie แบบเดิมยังใช้ได้)');
  // cookie แบบเดิม <id>.<sig> (ก่อนมีวันหมดอายุ) ต้องหลุด ถ้าเวอร์ชันเก่าออก <id>.<iat>.<sig> อยู่แล้ว ต้องไม่หลุด
  const legacy = /^st=[^.;]+\.[^.;]+(;|$)/.test(ownerOld.cookie);
  ok((await get(s, '/api/state', ownerOld.cookie)).status === (legacy ? 401 : 200),
    legacy ? 'เจ้าของต้องเข้าสู่ระบบใหม่หนึ่งครั้ง (cookie แบบเดิมไม่มีวันหมดอายุ)' : 'เจ้าของที่เข้าอยู่ไม่หลุด (เวอร์ชันเก่ามีวันหมดอายุอยู่แล้ว)');
  await s.login();
  const after = (await s.call('GET', '/api/state')).json;
  ok(JSON.stringify(after.keys) === JSON.stringify(keys), 'รหัส QR ทุกโต๊ะเหมือนเดิม (QR ที่พิมพ์ติดโต๊ะใช้ต่อได้)');
  ok(after.tickets.length === before.tickets.length && after.tickets.every(t => t.table === 1), 'ออเดอร์ค้างของโต๊ะ 1 ยังอยู่ครบ', after.tickets.length);
  ok(after.settings.shop === 'ร้านเดิม' && after.settings.promptpay === '0812345678', 'ข้อมูลร้านและ PromptPay เหมือนเดิม');
  ok(after.settings.requireSeat === false && after.settings.hours.on === false && after.settings.accent === '' && after.settings.logo === '', 'ฟีเจอร์ใหม่ปิดเป็นค่าเริ่มต้น ร้านทำงานเหมือนเดิม');
  ok(after.settings.vatRegistered === true && after.settings.vatInclusive === false && after.settings.vatRate === 7 && !('vat' in after.settings), 'ร้านที่เคยเปิด VAT: เป็นจด VAT แบบบวกเพิ่ม 7% ให้เอง (tasks/spec-vat.md)', [after.settings.vatRegistered, after.settings.vatInclusive, after.settings.vatRate]);
  ok(after.nextBill === before.nextBill, 'เลขบิลถัดไปต่อเนื่อง', [before.nextBill, after.nextBill]);
  const tb = await get(s, '/api/table?t=1&k=' + keys[1]);
  ok(tb.status === 200 && tb.json.open === true && tb.json.tickets.length > 0, 'ลูกค้าโต๊ะ 1 ใช้ QR เดิมเห็นออเดอร์และสั่งต่อได้');
  const o = await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 2, qty: 1 }] }, { staff: false });
  ok(o.status === 200, 'สั่งอาหารเพิ่มได้');
  const sub1 = (await s.call('GET', '/api/state')).json.bills[1].sub;
  const p1 = (await s.call('POST', '/api/pay', { table: 1, expectedSub: sub1, method: 'transfer' })).json.sale;
  ok(p1 && p1.no === paid.no + 1, 'ปิดบิลต่อได้ เลขบิลต่อจากเวอร์ชันเก่า', [paid.no, p1 && p1.no]);
  ok(p1 && p1.vatRate === 7 && p1.vatIncl === false && p1.vat === Math.round(sub1 * 7) / 100 && p1.total === Math.round(sub1 * 107) / 100, 'บิลแรกหลังอัปเดต: VAT 7% คิดถึงสตางค์ (หน้าเว็บไม่ต้องส่ง vat)', p1 && [sub1, p1.vat, p1.total]);
  const oldBill = (await s.call('GET', '/api/report')).json.bills.find(b => b.no === paid.no);
  ok(paid.vat > 0 && oldBill && oldBill.vat === paid.vat && oldBill.total === paid.total && oldBill.vatRate === undefined, 'บิลที่ปิดก่อนอัปเดตไม่ถูกคิดใหม่', oldBill && [paid.vat, oldBill.vat, paid.total, oldBill.total]);
  const csv = (await s.call('GET', '/api/export.csv')).text || '';
  ok(csv.includes(String(paid.total)) && csv.includes(String(p1.total)) && csv.split('\n').filter(l => l.trim()).length >= 3, 'CSV มีบิลทั้งจากเวอร์ชันเก่าและใหม่');
  const cl = await loginCookie(s, '555111'), po = await loginCookie(s, '555222');
  ok(cl.status === 200 && po.status === 200, 'PIN พนักงานจากเวอร์ชันเก่าใช้เข้าสู่ระบบได้ (รวมหุ้นส่วนบทบาทเจ้าของ)');
  const au = await s.call('GET', '/api/audit');
  ok(au.status === 200 && au.json.chain.ok, 'audit chain ต่อเนื่องข้ามเวอร์ชัน', au.json && au.json.chain);
  // ไฟล์สำรองจากเวอร์ชันเก่า กู้คืนบนเวอร์ชันใหม่ได้
  const rs = await new Promise(resolve => {
    const r = http.request(s.B + '/api/backup/restore', { method: 'POST', agent: false, headers: { cookie: s.cookie, 'content-type': 'application/gzip', 'content-length': bkFile.length } }, res => { let t = ''; res.on('data', c => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t })); });
    r.end(bkFile);
  });
  ok(rs.status === 200, 'ไฟล์สำรองจากเวอร์ชันเก่ากู้คืนบนเวอร์ชันใหม่ได้', rs.status + ' ' + rs.text.slice(0, 120));
  await s.stop(); rmrf(app.base);
  ok.done();
})().catch(e => { console.error(e); process.exit(2); });
