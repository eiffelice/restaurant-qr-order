'use strict';
/* สำเนาข้อมูลไป MySQL กับเซิร์ฟเวอร์จริง (MySQL 8 / MariaDB) ทุกอย่างผ่าน TCP proxy ที่สคริปต์นี้ตัดสายได้
   QA_MYSQL="mysql://root:รหัส@127.0.0.1:3306/mysql,mysql://root@127.0.0.1:3307/mysql#ssl=verify-ca&ca=/path/ca.pem"
     ผู้ใช้ที่สร้างฐานข้อมูลและผู้ใช้ได้ (สคริปต์สร้างฐานข้อมูล ovqa_* กับผู้ใช้สิทธิ์ตาม README แล้วลบทิ้งตอนจบ) คั่นหลายเครื่องด้วย ,
     #ssl=1|verify-ca&ca=ไฟล์ = ทดสอบการเข้ารหัสกับเครื่องนั้นด้วย
   QA_MYSQL_BILLS = จำนวนบิลย้อนหลังที่ใช้ทดสอบส่งครั้งแรก (ค่าเริ่มต้น 20000)
   ตรวจ: ยอดใน MySQL = sales/ = สรุปยอด = CSV ทุกสตางค์, เอกสาร/สต็อก/สินค้า/รายชื่อตรงกับในเครื่อง, ภาษาไทย/อีโมจิ/ข้อความแทรก SQL ตรงตามต้นฉบับ,
         MySQL ล่ม/สายหลุดกลาง transaction ร้านขายได้และส่งครบไม่ซ้ำ, เปิดโปรแกรมใหม่ไม่ส่งซ้ำ, กู้คืนข้อมูลแล้ว MySQL ตรงกับที่กู้,
         หลายสาขาในฐานข้อมูลเดียว, เครื่องใหม่ชนกับเครื่องเดิม/ใช้แทน, ระหว่างส่งข้อมูลจำนวนมากหน้าร้านไม่ค้าง, รหัสผ่านไม่อยู่ใน log
   node qa/mysql.js */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { ROOT, PIN, makeApp, start, sleep, until, salesLines, checker } = require('./lib');
const FROM = process.env.QA_FROM || ROOT;
const M = require(path.join(FROM, 'lib', 'mysql'));
const { mysqlConfig } = require(path.join(FROM, 'lib', 'config'));

const r2 = x => Math.round(x * 100) / 100;
const NASTY = ["it's", "\\'; DROP TABLE ov_sales; --", 'ไทย 😀 ' + "'".repeat(3), "x'); DELETE FROM ov_sales; /*", 'ก\\ข\\\\ค', '"double" `back`'];

// TCP proxy: ตัดสายที่ต่ออยู่ (cut) หรือปิดไม่รับสายใหม่ (down/up) เพื่อจำลองเน็ตหลุด/MySQL ล่ม
function proxy(host, port) {
  const socks = new Set(); let srv = null, p = 0;
  const up = () => new Promise(r => {
    srv = net.createServer(c => {
      const u = net.connect(port, host);
      [c, u].forEach(x => socks.add(x));
      const end = () => { c.destroy(); u.destroy(); socks.delete(c); socks.delete(u); };
      c.on('error', end); u.on('error', end); c.on('close', end); u.on('close', end);
      c.pipe(u); u.pipe(c);
    });
    srv.listen(p, '127.0.0.1', () => { p = srv.address().port; r(p); });
  });
  return { up, cut: () => socks.forEach(s => s.destroy()), down: () => new Promise(r => { socks.forEach(s => s.destroy()); srv.close(() => r()); }), get port() { return p; } };
}

function parseTarget(raw) {
  const [url, frag] = raw.split('#');
  const c = mysqlConfig({ MYSQL_URL: url });
  if (!c.MYSQL) throw new Error('QA_MYSQL ไม่ถูกต้อง: ' + c.MYSQL_ERR);
  const f = new URLSearchParams(frag || '');
  return { admin: c.MYSQL, ssl: f.get('ssl') || '', ca: f.get('ca') || '' };
}

async function sync(s, wantState) {
  let m;
  await until(async () => {
    const r = await s.call('POST', '/api/mysql/sync', {});
    m = r.json && r.json.mysql;
    return m && !m.syncing && m.state === (wantState || 'ok');
  }, 120000, 'รอส่งไป MySQL ' + JSON.stringify(m));
  return m;
}
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
function journalLines(dir, prefix) {
  const jd = path.join(dir, 'journal'), out = [];
  if (!fs.existsSync(jd)) return out;
  for (const f of fs.readdirSync(jd).filter(x => x.startsWith(prefix)).sort()) {
    for (const l of fs.readFileSync(path.join(jd, f), 'utf8').split('\n')) { if (l) try { out.push(JSON.parse(l)); } catch (e) { /* ignore */ } }
  }
  return out;
}

// ขายทุกแบบ: โต๊ะ (ค่าบริการ+VAT) หน้าร้าน (ทศนิยม ราคาส่ง) รับซื้อ เอกสาร (QT→INV→รับชำระ, PO→รับของ, ยกเลิก) สต็อก รายชื่อ
async function workload(s, tag) {
  await s.call('POST', '/api/settings', { modes: { table: true, kitchen: true, counter: true, buy: true, stock: true, docs: true } });
  let st = (await s.call('GET', '/api/state')).json;
  const cat = st.menu.categories[0].id, stn = Object.keys(st.menu.stations)[0];
  const meat = (await s.call('POST', '/api/menu/item', { name: 'หมูสับ 😀 ' + tag, price: 189.5, cat, station: stn, unit: 'กก.', dec: true, price2: 170, track: true, cost: 120.125, min: 5, sku: 'QA-' + tag })).json.item;
  const gone = (await s.call('POST', '/api/menu/item', { name: 'จะลบ ' + tag, price: 10, cat, station: stn })).json.item;
  await s.call('POST', '/api/stock/adjust', { mode: 'in', reason: 'รับเข้า QA', lines: [{ id: meat.id, qty: 50, price: 118 }] });
  st = (await s.call('GET', '/api/state')).json;
  const it = st.menu.items.filter(m => !m.track);
  await s.call('POST', '/api/order', { table: 1, key: st.keys[1], items: [{ id: it[0].id, qty: 2, note: [] }, { id: it[3].id, qty: 1, note: [] }], reqId: 'qa-' + tag, memo: NASTY[1].slice(0, 30) });
  const bill = (await s.call('GET', '/api/state')).json.bills[1];
  const pay = await s.call('POST', '/api/pay', { table: 1, expectedSub: bill.sub, svc: true, vat: true, method: 'cash', received: 2000 });
  if (pay.status !== 200) throw new Error('pay ' + JSON.stringify(pay.json));
  const sale = async b => { const r = await s.call('POST', '/api/sale', b); if (r.status !== 200) throw new Error('sale ' + JSON.stringify(r.json)); return r.json.sale; };
  await sale({ items: [{ id: meat.id, qty: 1.235 }], expectedSub: r2(189.5 * 1.235), method: 'transfer', memo: NASTY[0] + ' ' + NASTY[2] });
  await sale({ items: [{ id: meat.id, qty: 2 }, { id: it[1].id, qty: 3 }], level: 'wholesale', expectedSub: r2(170 * 2 + it[1].price * 3), method: 'cash', memo: NASTY[3].slice(0, 40) });
  await sale({ items: [{ id: it[2].id, qty: 4 }], kind: 'buy', expectedSub: r2(it[2].price * 4), method: 'cash', memo: 'รับซื้อ ' + NASTY[4] });
  for (const n of NASTY) await s.call('POST', '/api/contact', { name: n + ' ' + tag, kind: 'customer', address: 'ที่อยู่ ' + n, phone: '081-000-0000' });
  const qt = (await s.call('POST', '/api/doc', { type: 'QT', vat: true, discount: 33.33, party: { name: 'บริษัท ' + NASTY[1].slice(0, 20) }, note: NASTY[5],
    lines: [{ id: meat.id, name: meat.name, qty: 3.5, unit: 'กก.', price: 185 }, { name: 'ค่าส่ง', qty: 1, unit: 'เที่ยว', price: 150 }] })).json.doc;
  const inv = (await s.call('POST', '/api/doc/convert', { no: qt.no, rev: qt.rev })).json.doc;
  const paid = await s.call('POST', '/api/doc/pay', { no: inv.no, expectedTotal: inv.total, method: 'transfer' });
  if (paid.status !== 200) throw new Error('doc pay ' + JSON.stringify(paid.json));
  const inv2 = (await s.call('POST', '/api/doc', { type: 'INV', party: { name: 'ลูกค้าเชื่อ' }, lines: [{ id: meat.id, name: meat.name, qty: 1, unit: 'กก.', price: 190 }] })).json.doc;
  await s.call('POST', '/api/doc/cancel', { no: inv2.no, reason: 'ลูกค้ายกเลิก' });
  const po = (await s.call('POST', '/api/doc', { type: 'PO', party: { name: 'ผู้ขาย ' + tag }, lines: [{ id: meat.id, name: meat.name, qty: 20, unit: 'กก.', price: 115 }] })).json.doc;
  await s.call('POST', '/api/doc/receive', { no: po.no, rev: po.rev, lines: [{ qty: 18, price: 116 }] });
  await s.call('POST', '/api/stock/adjust', { mode: 'count', reason: 'นับ', lines: [{ id: meat.id, qty: 60, expect: (await s.call('GET', '/api/state')).json.menu.items.find(m => m.id === meat.id).stock }] });
  await s.call('POST', '/api/menu/item/delete', { id: gone.id });
  return { meat, gone };
}
async function quickSales(s, n, label) {
  const md = (await s.call('GET', '/api/state')).json.settings.modes;
  if (!md.counter) await s.call('POST', '/api/settings', { modes: Object.assign({}, md, { counter: true }) });
  const it = (await s.call('GET', '/api/state')).json.menu.items.find(m => !m.track && !m.hidden);
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    const r = await s.call('POST', '/api/sale', { items: [{ id: it.id, qty: 1 + (i % 3) }], expectedSub: r2(it.price * (1 + (i % 3))), method: i % 2 ? 'cash' : 'transfer', memo: label + ' ' + i });
    if (r.status !== 200) throw new Error('quick sale ' + JSON.stringify(r.json));
    worst = Math.max(worst, Date.now() - t0);
  }
  return worst;
}

// MySQL ต้องตรงกับไฟล์ในเครื่องทุกแถว ทุกสตางค์
async function compare(ok, c, db, shop, s, dir, label) {
  const Q = async sql => (await c.query(sql)).rows, sh = M.lit(shop);
  const sales = salesLines(dir).filter(x => !x._bad);
  const rows = await Q('SELECT * FROM ' + db + '.ov_sales WHERE shop=' + sh), byNo = new Map(rows.map(r => [+r.no, r]));
  const items = await Q('SELECT * FROM ' + db + '.ov_sale_items WHERE shop=' + sh + ' ORDER BY sale_no, line_no'), itemsOf = new Map();
  items.forEach(i => { const k = +i.sale_no; if (!itemsOf.has(k)) itemsOf.set(k, []); itemsOf.get(k).push(i); });
  const bad = [];
  sales.forEach(x => {
    const r = byNo.get(x.no), its = itemsOf.get(x.no) || [];
    const same = r && ['sub', 'svc', 'vat', 'total'].every(k => +r[k] === r2(x[k])) && +r.disc === r2(x.disc || 0) && r.kind === (x.kind === 'buy' ? 'buy' : 'sell') &&
      r.method === x.method && r.memo === (x.memo || '') && +r.table_no === (x.table || 0) && r.src === x._file && +r.item_count === x.items.length &&
      its.length === x.items.length && x.items.every((i, n) => its[n].name === i.name && +its[n].qty === Math.round(i.qty * 1000) / 1000 && +its[n].price === r2(i.price));
    if (!same) bad.push(x.no);
  });
  ok(rows.length === sales.length && !bad.length, label + ': บิลใน MySQL = sales/ ทุกบิล ทุกช่อง (' + sales.length + ' บิล)', bad.length || rows.length !== sales.length ? { mysql: rows.length, files: sales.length, bad: bad.slice(0, 5) } : undefined);
  if (s) {
    const rep = (await s.call('GET', '/api/report')).json;
    const sum = (await Q('SELECT COALESCE(SUM(total),0) t, COUNT(*) n FROM ' + db + ".ov_sales WHERE shop=" + sh + " AND kind='sell' AND day=" + M.lit(today())))[0];
    const buy = (await Q('SELECT COALESCE(SUM(total),0) t FROM ' + db + ".ov_sales WHERE shop=" + sh + " AND kind='buy' AND day=" + M.lit(today())))[0];
    ok(+sum.t === rep.total && +sum.n === rep.count && +buy.t === rep.buy.total, label + ': ยอดขายวันนี้ใน MySQL = สรุปยอด (ไม่นับรับซื้อ) และยอดรับซื้อแยก', { mysql: +sum.t, report: rep.total, buy: +buy.t, reportBuy: rep.buy.total });
    const month = today().slice(0, 7), csv = (await s.call('GET', '/api/export.csv?month=' + month)).text.split('\r\n').length - 1;
    const n = (await Q('SELECT COUNT(*) n FROM ' + db + '.ov_sales WHERE shop=' + sh + ' AND src=' + M.lit(month + '.jsonl')))[0].n;
    ok(+n === csv, label + ': จำนวนบิลเดือนนี้ = แถวใน CSV', { mysql: +n, csv });
  }
  const moves = journalLines(dir, 'stock-'), mrows = await Q('SELECT id, qty, bal, kind, ref FROM ' + db + '.ov_stock_moves WHERE shop=' + sh), mby = new Map(mrows.map(r => [r.id, r]));
  ok(mrows.length === moves.length && moves.every(v => { const r = mby.get(v.id); return r && +r.qty === v.qty && +r.bal === v.bal && r.kind === v.kind && r.ref === v.ref; }),
    label + ': ประวัติสต็อกใน MySQL = journal/ (' + moves.length + ' รายการ ยอดคงเหลือตรง)', { mysql: mrows.length, files: moves.length });
  const latest = new Map();
  journalLines(dir, 'docs-').forEach(d => { const o = latest.get(d.no); if (!o || d.rev > o.rev) latest.set(d.no, d); });
  const drows = await Q('SELECT * FROM ' + db + '.ov_docs WHERE shop=' + sh), dby = new Map(drows.map(r => [r.no, r]));
  const lines = await Q('SELECT doc_no, COUNT(*) n, SUM(amount) a FROM ' + db + '.ov_doc_lines WHERE shop=' + sh + ' GROUP BY doc_no'), lby = new Map(lines.map(r => [r.doc_no, r]));
  const dbad = Array.from(latest.values()).filter(d => { const r = dby.get(d.no), l = lby.get(d.no); return !r || +r.rev !== d.rev || r.status !== d.status || +r.total !== d.total || +r.sub !== d.sub || r.note !== d.note || r.party_name !== d.party.name || (d.lines.length ? !l || +l.n !== d.lines.length : !!l); }).map(d => d.no);
  ok(drows.length === latest.size && !dbad.length, label + ': เอกสารใน MySQL = ฉบับล่าสุดใน journal/ (' + latest.size + ' ฉบับ)', dbad.length || drows.length !== latest.size ? { mysql: drows.length, files: latest.size, bad: dbad } : undefined);
  if (s) {
    const st = (await s.call('GET', '/api/state')).json;
    const prow = await Q('SELECT * FROM ' + db + '.ov_products WHERE shop=' + sh), pby = new Map(prow.map(r => [+r.id, r]));
    const live = prow.filter(r => r.deleted === '0');
    ok(live.length === st.menu.items.length && st.menu.items.every(m => { const r = pby.get(m.id); return r && r.name === m.name && +r.price === m.price && +r.stock === m.stock && r.sku === (m.sku || '') && +r.track === (m.track ? 1 : 0); }),
      label + ': สินค้าใน MySQL = สินค้าในร้าน (ชื่อ ราคา คงเหลือ รหัส)', { mysql: live.length, shop: st.menu.items.length });
    const crow = await Q('SELECT id, name, address FROM ' + db + '.ov_contacts WHERE shop=' + sh + ' AND deleted=0');
    const cts = (await s.call('GET', '/api/contacts')).json.list || (await s.call('GET', '/api/contacts')).json.contacts || [];
    const cby = new Map(crow.map(r => [r.id, r]));
    ok(crow.length === cts.length && cts.every(x => cby.get(x.id) && cby.get(x.id).name === x.name && cby.get(x.id).address === x.address), label + ': รายชื่อใน MySQL ตรงทุกตัวอักษร (ไทย อีโมจิ \' \\ ข้อความแทรก SQL)', { mysql: crow.length, shop: cts.length });
  }
}
async function writes(c) {
  const r = (await c.query("SHOW GLOBAL STATUS WHERE Variable_name IN ('Com_insert','Com_replace','Com_update','Com_delete','Com_delete_multi','Com_insert_select','Com_replace_select','Com_update_multi')")).rows;
  return r.reduce((a, x) => a + +x.Value, 0);
}

async function oneTarget(ok, raw) {
  const T = parseTarget(raw), A = T.admin;
  const admin = await M.connect(Object.assign({}, A, { timeout: 10000 }));
  const ver = (await admin.query('SELECT VERSION() v')).rows[0].v;
  const tag = crypto.randomBytes(3).toString('hex'), db = 'ovqa_' + tag, user = 'ovqa_' + tag, pw = "Qa-p@ss/#?" + tag + "ไทย'\\";
  console.log('\n== ' + ver + ' (' + A.host + ':' + A.port + ') ฐานข้อมูล ' + db);
  await admin.query('CREATE DATABASE ' + db + ' CHARACTER SET utf8mb4');
  for (const h of ['%', 'localhost']) {
    await admin.query('CREATE USER ' + M.lit(user) + '@' + M.lit(h) + ' IDENTIFIED BY ' + M.lit(pw));
    await admin.query('GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, ALTER ON ' + db + '.* TO ' + M.lit(user) + '@' + M.lit(h));   // สิทธิ์ตาม README
  }
  const px = proxy(A.host, A.port); await px.up();
  const url = 'mysql://' + user + '@127.0.0.1:' + px.port + '/' + db, env = { MYSQL_URL: url, MYSQL_PASSWORD: pw, MYSQL_SYNC_SEC: '2' };
  const apps = [];
  const open = async (e, base) => { const a = base || makeApp(); const s = start(a.code, Object.assign({}, env, e)); apps.push(s); await s.ready; await s.login(); return { s, dir: a.code, app: a }; };
  try {
    // 1) ขายทุกแบบ แล้วเทียบทุกแถว
    const A1 = await open({});
    await workload(A1.s, 'a');
    let m = await sync(A1.s);
    ok(m.server && m.shop === 'main' && m.target === user + '@127.0.0.1:' + px.port + '/' + db, 'สถานะบอกปลายทาง สาขา รุ่นเซิร์ฟเวอร์ (ไม่มีรหัสผ่าน)', { target: m.target, server: m.server });
    await compare(ok, admin, db, 'main', A1.s, A1.dir, 'ครั้งแรก');
    const charset = (await admin.query("SELECT TABLE_COLLATION c FROM information_schema.TABLES WHERE TABLE_SCHEMA=" + M.lit(db) + " AND TABLE_NAME='ov_sales'")).rows[0].c;
    ok(/^utf8mb4/.test(charset), 'ตาราง utf8mb4 (ภาษาไทย อีโมจิ)', charset);

    // 2) เปิดโปรแกรมใหม่: ไม่ส่งซ้ำ (ไม่มีคำสั่งเขียนเลย)
    await A1.s.stop();
    const before = await writes(admin);
    const s1b = start(A1.dir, env); apps.push(s1b); await s1b.ready; await s1b.login(); A1.s = s1b;
    m = await sync(A1.s);
    ok(await writes(admin) - before === 0, 'ปิดเปิดโปรแกรมใหม่ ไม่มีอะไรเปลี่ยน = ไม่เขียน MySQL เลย (จำตำแหน่งที่ส่งแล้ว)', { writes: await writes(admin) - before });

    // 3) MySQL ล่ม: ร้านขายได้ทันที แล้วส่งครบเมื่อกลับมา
    await px.down();
    const worst = await quickSales(A1.s, 25, 'ล่ม');
    ok(worst < 1000, 'MySQL ล่ม ขายหน้าร้าน 25 บิล ทุกบิลตอบภายใน 1 วินาที', { worstMs: worst });
    await until(async () => { const x = (await A1.s.call('GET', '/api/state')).json.mysql; return x.state === 'error'; }, 15000, 'สถานะ error');
    const e = (await A1.s.call('GET', '/api/state')).json.mysql;
    ok(/เชื่อมต่อ MySQL/.test(e.error), 'สถานะบอกว่าส่งไม่ได้เพราะอะไร', e.error);
    await px.up();
    await sync(A1.s);
    await compare(ok, admin, db, 'main', A1.s, A1.dir, 'หลัง MySQL กลับมา');

    // 4) กู้คืนข้อมูล: บิล/เอกสารหลังวันที่สำรองหายจากร้าน MySQL ต้องหายตาม
    const bk = (await A1.s.call('POST', '/api/backup', {})).json.backup;
    await quickSales(A1.s, 5, 'หลังสำรอง');
    const qt = (await A1.s.call('POST', '/api/doc', { type: 'QT', party: { name: 'ก่อนกู้คืน' }, lines: [{ name: 'x', qty: 1, price: 1 }] })).json.doc;
    await A1.s.call('POST', '/api/doc', { no: qt.no, rev: qt.rev, type: 'QT', party: { name: 'แก้แล้ว' }, lines: [{ name: 'x', qty: 2, price: 1 }] });
    await sync(A1.s);
    await A1.s.call('POST', '/api/reauth', { pin: PIN });
    const file = await A1.s.call('GET', '/api/backup/download?name=' + encodeURIComponent(bk.name));
    const rs = await A1.s.call('POST', '/api/backup/restore', file.buf, { headers: { 'content-type': 'application/gzip' } });
    ok(rs.status === 200, 'กู้คืนข้อมูลสำเร็จ', rs.status);
    await sync(A1.s);
    await compare(ok, admin, db, 'main', A1.s, A1.dir, 'หลังกู้คืน');
    await quickSales(A1.s, 3, 'หลังกู้คืน');
    await sync(A1.s);
    await compare(ok, admin, db, 'main', A1.s, A1.dir, 'ขายต่อหลังกู้คืน');

    // 5) อีกสาขาในฐานข้อมูลเดียวกัน
    const B = await open({ MYSQL_SHOP: 'branch2' });
    await workload(B.s, 'b');
    await sync(B.s);
    await compare(ok, admin, db, 'branch2', B.s, B.dir, 'สาขา branch2');
    await compare(ok, admin, db, 'main', A1.s, A1.dir, 'สาขา main ไม่ถูกแตะ');

    // 6) เครื่องใหม่ตั้งสาขาเดียวกัน: หยุดส่ง ไม่เขียนทับ · กดใช้กับเครื่องนี้ = แทนที่ · เครื่องเดิมหยุดส่งเอง
    const n0 = +(await admin.query('SELECT COUNT(*) n FROM ' + db + ".ov_sales WHERE shop='main'")).rows[0].n;
    const Cn = await open({});
    await quickSales(Cn.s, 2, 'เครื่องใหม่');
    const cm = await sync(Cn.s, 'conflict');
    ok(/เครื่องอื่น/.test(cm.error) && cm.alert, 'เครื่องใหม่ที่ใช้สาขาเดียวกัน: หยุดส่ง และแจ้งเจ้าของ', cm.error);
    ok(+(await admin.query('SELECT COUNT(*) n FROM ' + db + ".ov_sales WHERE shop='main'")).rows[0].n === n0, 'ข้อมูลของเครื่องเดิมไม่ถูกเขียนทับ');
    const tk = await Cn.s.call('POST', '/api/mysql/resync', { takeover: true });
    ok(tk.status === 200, 'กด "ใช้ฐานข้อมูลนี้กับเครื่องนี้"');
    await sync(Cn.s);
    await compare(ok, admin, db, 'main', Cn.s, Cn.dir, 'หลังเครื่องใหม่ใช้แทน');
    await quickSales(A1.s, 1, 'เครื่องเดิม');
    const old = await sync(A1.s, 'conflict');
    ok(old.state === 'conflict', 'เครื่องเดิมรู้ว่าถูกใช้แทนแล้ว หยุดส่ง', old.error);
    await compare(ok, admin, db, 'main', Cn.s, Cn.dir, 'เครื่องเดิมไม่ได้เขียนอะไรเพิ่ม');

    // 7) ส่งย้อนหลังจำนวนมาก + สายหลุดกลาง transaction: หน้าร้านไม่ค้าง ส่งครบไม่ซ้ำ
    const N = +process.env.QA_MYSQL_BILLS || 20000, big = makeApp(), sd = path.join(big.code, 'sales');
    fs.mkdirSync(sd, { recursive: true });
    const now = Date.now(), per = Math.ceil(N / 12), byFile = {};
    let total = 0;
    for (let i = 0; i < N; i++) {
      const at = now - (12 - Math.floor(i / per)) * 30 * 86400000 + (i % per) * 60000, d = new Date(at);
      const price = 35 + (i % 17) * 5.25, qty = 1 + (i % 4), sub = r2(price * qty);
      const f = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '.jsonl';
      (byFile[f] = byFile[f] || []).push(JSON.stringify({ no: i + 1, at, table: 0, sub, svc: 0, vat: 0, total: sub, method: i % 2 ? 'cash' : 'transfer', items: [{ name: 'ย้อนหลัง ' + (i % 50), qty, price }], memo: i % 97 ? undefined : NASTY[i % NASTY.length] }));
      total += sub;
    }
    Object.keys(byFile).forEach(f => fs.writeFileSync(path.join(sd, f), byFile[f].join('\n') + '\n'));
    const t0 = Date.now(), P = await open({ MYSQL_SHOP: 'perf' }, big);
    let lag = 0, probes = 0, cut = false;
    while (true) {
      const a = Date.now(); await P.s.call('GET', '/api/menu'); lag = Math.max(lag, Date.now() - a); probes++;
      if (!cut && Date.now() - t0 > 700) { px.cut(); cut = true; }
      const x = (await P.s.call('GET', '/api/state')).json.mysql;
      if (x.state === 'ok' && !x.syncing && x.lastOk > t0) break;
      if (Date.now() - t0 > 300000) break;
      await sleep(50);
    }
    const took = Date.now() - t0;
    const got = (await admin.query('SELECT COUNT(*) n, SUM(total) t FROM ' + db + ".ov_sales WHERE shop='perf'")).rows[0];
    ok(+got.n === N && Math.abs(+got.t - r2(total)) < 0.005, 'ส่งย้อนหลัง ' + N + ' บิล (' + Object.keys(byFile).length + ' เดือน) ครบทุกบิล ยอดรวมตรง แม้สายหลุดกลางทาง', { n: +got.n, total: +got.t, want: r2(total), seconds: Math.round(took / 1000) });
    ok(lag < 300, 'ระหว่างส่ง หน้าเมนูลูกค้าตอบเร็ว (ช้าสุด ' + lag + ' ms จาก ' + probes + ' ครั้ง)');
    const appLog = fs.readdirSync(path.join(P.dir, 'logs')).filter(f => f.startsWith('app-')).map(f => fs.readFileSync(path.join(P.dir, 'logs', f), 'utf8')).join('');
    ok(appLog.includes('mysql_failed') && appLog.includes('mysql_recovered'), 'สายหลุดระหว่างส่งจริง (log บอกว่าส่งไม่ได้ แล้วกลับมาส่งได้)');
    await compare(ok, admin, db, 'perf', null, P.dir, 'ย้อนหลัง');

    // 8) การเข้ารหัส
    if (T.ssl) {
      const tls = await open({ MYSQL_URL: 'mysql://' + user + '@' + A.host + ':' + A.port + '/' + db + '?ssl=' + T.ssl, MYSQL_CA: T.ca, MYSQL_SHOP: 'tls' });
      await quickSales(tls.s, 2, 'tls');
      const tm = await sync(tls.s);
      ok(tm.tls && tm.state === 'ok', 'ส่งผ่าน TLS (ssl=' + T.ssl + ' + MYSQL_CA) สำเร็จ');
      const cc = await M.connect(Object.assign({}, A, { user, password: pw, database: db, ssl: { verify: T.ssl === 'verify-ca' ? 'ca' : 'identity', ca: fs.readFileSync(T.ca, 'utf8') } }));
      const cipher = (await cc.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'")).rows[0].Value; cc.close();
      ok(!!cipher, 'การเชื่อมต่อเข้ารหัสจริง (' + cipher + ')');
      const noca = await open({ MYSQL_URL: 'mysql://' + user + '@' + A.host + ':' + A.port + '/' + db + '?ssl=1', MYSQL_SHOP: 'tls2' });
      const nm = await sync(noca.s, 'error');
      ok(/ใบรับรอง/.test(nm.error), 'ไม่มี CA ที่เชื่อถือ = ไม่ยอมเชื่อมต่อ บอกให้ตั้ง MYSQL_CA', nm.error);
    }
    // 9) รหัสผ่านต้องไม่อยู่ใน log / console ของทุกร้านที่เปิด
    await Promise.all(apps.map(a => a.stop()));
    const leak = apps.some(a => a.out.includes(pw)) || [A1, B, Cn, P].some(x => {
      const ld = path.join(x.dir, 'logs');
      return fs.existsSync(ld) && fs.readdirSync(ld).some(f => fs.readFileSync(path.join(ld, f), 'utf8').includes(pw));
    });
    ok(!leak, 'รหัสผ่าน MySQL ไม่อยู่ใน log หรือหน้าต่างโปรแกรม');
  } finally {
    await Promise.all(apps.map(a => a.stop()));
    await px.down().catch(() => {});
    if (!process.env.QA_KEEP) {
      await admin.query('DROP DATABASE IF EXISTS ' + db);
      for (const h of ['%', 'localhost']) await admin.query('DROP USER IF EXISTS ' + M.lit(user) + '@' + M.lit(h));
    } else console.log('  เก็บฐานข้อมูลไว้: ' + db);
    admin.close();
  }
}

async function main() {
  const list = String(process.env.QA_MYSQL || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!list.length) { console.log('ตั้ง QA_MYSQL=mysql://root:รหัส@127.0.0.1:3306/mysql ก่อน (ดูหัวไฟล์)'); process.exitCode = 2; return; }
  const ok = checker('mysql');
  for (const t of list) await oneTarget(ok, t);
  ok.done();
}
main().catch(e => { console.error(e); process.exit(1); });
