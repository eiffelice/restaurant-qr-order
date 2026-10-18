'use strict';
// รัน:  npm test   (หรือ node --test)
// แต่ละชุดจะคัดลอกระบบไปโฟลเดอร์ชั่วคราว จึงไม่แตะข้อมูลจริงของร้าน
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PIN = '246810';
let portSeq = 4100 + Math.floor(Math.random() * 500);

const tempDirs = [];
after(() => { setTimeout(() => tempDirs.forEach(d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } }), 300); });

function makeApp(menuOverride) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-order-'));
  tempDirs.push(dir);
  fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(dir, 'server.js'));
  fs.cpSync(path.join(ROOT, 'public'), path.join(dir, 'public'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'lib'), path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'menu.json'), menuOverride || fs.readFileSync(path.join(ROOT, 'menu.json')));
  return dir;
}

async function until(fn, ms) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('รอเกิน ' + ms + ' ms');
    await new Promise(r => setTimeout(r, 50));
  }
}

// ปิดเซิร์ฟเวอร์ทดสอบทุกตัวเสมอ แม้เคสจะ fail กลางทาง (ไม่อย่างนั้นชุดทดสอบจะค้าง)
const running = new Set();
after(() => { running.forEach(p => { try { p.kill('SIGKILL'); } catch (e) { /* ignore */ } }); });
process.on('exit', () => running.forEach(p => { try { p.kill('SIGKILL'); } catch (e) { /* ignore */ } }));

// fetch() ปฏิเสธพอร์ตสงวนบางตัว ถ้าสุ่มได้พอร์ตนี้ เทสต์จะล้มแบบสุ่ม
const BAD_PORTS = new Set([4190, 5060, 5061, 6000]);
function start(dir, env) {
  let port = portSeq++;
  while (BAD_PORTS.has(port)) port = portSeq++;
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: dir, env: Object.assign({}, process.env, { PORT: String(port), STAFF_PIN: PIN, ORDER_LIMIT: '1000' }, env || {})
  });
  running.add(proc);
  proc.on('exit', () => running.delete(proc));
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start:\n' + out)), 5000);
    proc.stdout.on('data', () => { if (out.includes('พร้อมใช้งาน')) { clearTimeout(t); resolve(); } });
    proc.on('exit', code => { clearTimeout(t); reject(Object.assign(new Error('exited ' + code + '\n' + out), { code, out })); });
  });
  const B = 'http://127.0.0.1:' + port;
  let cookie = '';
  async function call(method, p, body, opts) {
    opts = opts || {};
    const headers = Object.assign({}, opts.headers || {});
    if (opts.staff !== false && cookie) headers.cookie = cookie;
    if (body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
    const r = await fetch(B + p, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const sc = r.headers.get('set-cookie');
    if (sc && sc.startsWith('st=')) cookie = sc.split(';')[0];
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* csv */ }
    return { status: r.status, json, text, headers: r.headers };
  }
  return {
    ready, proc, dir, B, call,
    get output() { return out; },
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
    login: () => call('POST', '/api/login', { pin: PIN }),
    guest: (method, p, body, headers) => call(method, p, body, { staff: false, headers }),
    stop: () => new Promise(r => { if (proc.exitCode !== null) return r(); proc.on('exit', r); proc.kill('SIGTERM'); })
  };
}

describe('ระบบหลัก', () => {
  let s, keys;
  before(async () => {
    s = start(makeApp());
    await s.ready;
  });
  after(() => s.stop());

  test('หน้าพนักงานต้องเข้าสู่ระบบ และรหัสผิดถูกปฏิเสธ', async () => {
    assert.equal((await s.call('GET', '/api/state')).status, 401);
    assert.equal((await s.call('POST', '/api/login', { pin: '000000' })).status, 401);
    assert.equal((await s.login()).status, 200);
    const st = await s.call('GET', '/api/state');
    assert.equal(st.status, 200);
    keys = st.json.keys;
  });

  test('POST ที่ไม่ใช่ JSON ถูกปฏิเสธ (กันการยิงจากฟอร์มเว็บอื่น)', async () => {
    const r = await s.call('POST', '/api/soldout', '{"id":1,"soldOut":true}', { headers: { 'content-type': 'text/plain' } });
    assert.equal(r.status, 415);
  });

  test('ลูกค้าเข้าได้เฉพาะโต๊ะที่ตรงกับ QR', async () => {
    assert.equal((await s.guest('GET', '/api/table?t=5')).status, 403);
    assert.equal((await s.guest('GET', '/api/table?t=5&k=' + keys[6])).status, 403);
    assert.equal((await s.guest('GET', '/api/table?t=5&k=' + keys[5])).status, 200);
    assert.equal((await s.guest('GET', '/api/table?t=99&k=' + keys[5])).status, 400);
  });

  test('สั่งอาหาร: ราคามาจากเซิร์ฟเวอร์ หมายเหตุถูกกรอง ข้อมูลผิดถูกปฏิเสธ', async () => {
    assert.equal((await s.guest('POST', '/api/order', { table: 5, key: keys[5], items: [{ id: 999, qty: 1 }] })).status, 400);
    assert.equal((await s.guest('POST', '/api/order', { table: 5, key: keys[5], items: [{ id: 1, qty: 0 }] })).status, 400);
    assert.equal((await s.guest('POST', '/api/order', { table: 5, key: keys[5], items: [{ id: 1, qty: 21 }] })).status, 400);
    const r = await s.guest('POST', '/api/order', {
      table: 5, key: keys[5], memo: 'แพ้ถั่ว\n\u0007',
      items: [{ id: 1, qty: 2, price: 1, note: ['ไม่เผ็ด', '<script>'] }, { id: 15, qty: 1 }]
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.tickets.length, 2, 'แยกตั๋วครัวร้อนกับเครื่องดื่ม');
    const t = await s.guest('GET', '/api/table?t=5&k=' + keys[5]);
    assert.equal(t.json.sub, 60 * 2 + 40);
    const dish = t.json.tickets.flatMap(k => k.items).find(i => i.id === 1);
    assert.deepEqual(dish.note, ['ไม่เผ็ด']);
    const st = await s.call('GET', '/api/state');
    assert.equal(st.json.tickets[0].memo, 'แพ้ถั่ว');
  });

  test('กดส่งซ้ำด้วย reqId เดิม ไม่สร้างออเดอร์ซ้ำ', async () => {
    const body = { table: 6, key: keys[6], reqId: 'abcdef0123456789', items: [{ id: 2, qty: 1 }] };
    const a = await s.guest('POST', '/api/order', body);
    const b = await s.guest('POST', '/api/order', body);
    assert.deepEqual(a.json, b.json);
    const t = await s.guest('GET', '/api/table?t=6&k=' + keys[6]);
    assert.equal(t.json.tickets.length, 1);
  });

  test('เมนูหมดสั่งไม่ได้ และลูกค้าเห็นสถานะหมดแบบสด', async () => {
    await s.call('POST', '/api/soldout', { id: 3, soldOut: true });
    const r = await s.guest('POST', '/api/order', { table: 7, key: keys[7], items: [{ id: 3, qty: 1 }] });
    assert.equal(r.status, 400);
    const t = await s.guest('GET', '/api/table?t=7&k=' + keys[7]);
    assert.ok(t.json.soldOut.includes(3));
    await s.call('POST', '/api/soldout', { id: 3, soldOut: false });
  });

  test('ปิดรับออเดอร์ QR: ลูกค้าสั่งไม่ได้ แต่พนักงานสั่งแทนได้', async () => {
    await s.call('POST', '/api/settings', { acceptOrders: false });
    assert.equal((await s.guest('POST', '/api/order', { table: 8, key: keys[8], items: [{ id: 4, qty: 1 }] })).status, 403);
    assert.equal((await s.call('POST', '/api/order', { table: 8, items: [{ id: 4, qty: 1 }] })).status, 200);
    await s.call('POST', '/api/settings', { acceptOrders: true });
    assert.equal((await s.guest('POST', '/api/order', { table: 8, key: keys[8], items: [{ id: 4, qty: 1 }] })).status, 200);
  });

  test('หน้าจอเก่าย้อนสถานะออเดอร์ไม่ได้', async () => {
    const st = await s.call('GET', '/api/state');
    const k = st.json.tickets.find(x => x.table === 6);
    assert.equal((await s.call('POST', '/api/ticket', { id: k.id, from: 'new', status: 'cooking' })).status, 200);
    assert.equal((await s.call('POST', '/api/ticket', { id: k.id, from: 'cooking', status: 'ready' })).status, 200);
    const stale = await s.call('POST', '/api/ticket', { id: k.id, from: 'new', status: 'cooking' });
    assert.equal(stale.status, 409);
    const after = await s.call('GET', '/api/state');
    assert.equal(after.json.tickets.find(x => x.id === k.id).status, 'ready');
  });

  test('ลดจำนวนโต๊ะไม่ได้ ถ้าโต๊ะที่จะหายยังเปิดบิลอยู่', async () => {
    await s.call('POST', '/api/order', { table: 12, items: [{ id: 2, qty: 1 }] });
    const r = await s.call('POST', '/api/settings', { tables: 8 });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /12/);
    assert.equal((await s.call('GET', '/api/state')).json.settings.tables, 12);
  });

  test('ปิดบิล: ต้องส่งยอดที่ตรวจแล้ว ถ้ามีสั่งเพิ่มระหว่างนั้นจะถูกปฏิเสธ', async () => {
    assert.equal((await s.call('POST', '/api/pay', { table: 5, svc: true, vat: true })).status, 400);
    const bill = (await s.call('GET', '/api/state')).json.bills[5];
    await s.guest('POST', '/api/order', { table: 5, key: keys[5], items: [{ id: 18, qty: 1 }] });   // ลูกค้าสั่งน้ำเพิ่มตอนพนักงานกำลังคิดเงิน
    const stale = await s.call('POST', '/api/pay', { table: 5, svc: true, vat: true, expectedSub: bill.sub });
    assert.equal(stale.status, 409);
    const fresh = (await s.call('GET', '/api/state')).json.bills[5];
    assert.equal(fresh.sub, 175);
    const ok = await s.call('POST', '/api/pay', { table: 5, svc: true, vat: true, method: 'transfer', expectedSub: fresh.sub });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.sale.svc, 18);                       // 10% ของ 175 = 17.5 ปัดเป็น 18
    assert.equal(ok.json.sale.vat, 14);                       // 7% ของ 193 = 13.51 ปัดเป็น 14
    assert.equal(ok.json.sale.total, 207);
    assert.equal(ok.json.sale.method, 'transfer');
    const after = (await s.call('GET', '/api/state')).json;
    assert.equal(after.tickets.filter(k => k.table === 5).length, 0);
  });

  test('ปิดโต๊ะซ้ำไม่ได้ และยอดเข้ารายงานแยกเงินสด/โอน', async () => {
    assert.equal((await s.call('POST', '/api/pay', { table: 5, expectedSub: 0 })).status, 409);
    const sub8 = (await s.call('GET', '/api/state')).json.bills[8].sub;
    assert.equal((await s.call('POST', '/api/pay', { table: 8, method: 'cash', expectedSub: sub8 })).status, 200);
    const rep = await s.call('GET', '/api/report');
    assert.equal(rep.json.count, 2);
    assert.ok(rep.json.cash > 0 && rep.json.transfer > 0);
    assert.equal(rep.json.total, rep.json.cash + rep.json.transfer);
    assert.equal(rep.json.bills.length, 2);
  });

  test('ยอดขายถูกเก็บถาวรรายเดือนและ export CSV ได้', async () => {
    const files = fs.readdirSync(path.join(s.dir, 'sales'));
    assert.equal(files.length, 1);
    assert.equal(fs.readFileSync(path.join(s.dir, 'sales', files[0]), 'utf8').trim().split('\n').length, 2);
    const csv = await s.call('GET', '/api/export.csv');
    assert.equal(csv.status, 200);
    // fetch().text() ตัด BOM ทิ้งให้ จึงอ่านไบต์ดิบแทน
    const bytes = Buffer.from(await (await fetch(s.B + '/api/export.csv', { headers: { cookie: s.cookie } })).arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'มี BOM ให้ Excel อ่านภาษาไทยถูก');
    assert.match(csv.text, /โอน\/QR/);
    assert.match(csv.text, /เงินสด/);
    assert.equal((await s.guest('GET', '/api/export.csv')).status, 401);
    assert.equal((await s.call('GET', '/api/export.csv?month=../../x')).status, 400);
  });

  test('ข้อความผิดพลาดภายในไม่หลุดออกไปหาผู้ใช้', async () => {
    const r = await s.guest('POST', '/api/order', '{bad json', {});
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'รูปแบบข้อมูลไม่ถูกต้อง');
  });

  test('ออกจากระบบแล้วเรียก API พนักงานไม่ได้', async () => {
    await s.call('POST', '/api/logout', {});
    const r = await fetch(s.B + '/api/state');
    assert.equal(r.status, 401);
  });
});

describe('ความทนทานของข้อมูล', () => {
  test('data.json เสียหาย: กู้จากสำรอง รหัส QR เดิมยังใช้ได้', async () => {
    const dir = makeApp();
    let s = start(dir); await s.ready; await s.login();
    const key1 = (await s.call('GET', '/api/state')).json.keys[1];
    await s.stop();
    s = start(dir); await s.ready; await s.stop();         // เปิดครั้งที่สองเพื่อสร้าง data.json.bak
    fs.writeFileSync(path.join(dir, 'data.json'), '{"broken');
    s = start(dir); await s.ready; await s.login();
    assert.equal((await s.call('GET', '/api/state')).json.keys[1], key1);
    assert.ok(fs.readdirSync(dir).some(f => f.startsWith('data.json.corrupt-')), 'เก็บไฟล์เสียไว้ตรวจสอบ');
    await s.stop();
  });

  test('data.json และไฟล์สำรองเสียทั้งคู่: หยุดทำงานแทนการสร้างรหัส QR ใหม่ทับ', async () => {
    const dir = makeApp();
    fs.writeFileSync(path.join(dir, 'data.json'), '{"broken');
    const s = start(dir);
    await assert.rejects(s.ready, e => e.code === 1 && /กู้คืนข้อมูลไม่ได้/.test(e.out));
    assert.equal(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'), '{"broken');
  });

  test('ยอดขายจากเวอร์ชันก่อนถูกย้ายลงไฟล์รายเดือน', async () => {
    const dir = makeApp();
    const at = Date.now();
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({
      tickets: [], calls: {}, keys: { 1: 'aaaaaaaa' }, nextTicket: 1, nextBill: 3, secret: 'x'.repeat(32),
      sales: [{ no: 1, at, table: 1, sub: 100, svc: 10, vat: 0, total: 110, items: [{ name: 'ก', qty: 1 }] },
              { no: 2, at, table: 2, sub: 50, svc: 5, vat: 0, total: 55, items: [{ name: 'ข', qty: 1 }] }]
    }));
    const s = start(dir); await s.ready;
    const files = fs.readdirSync(path.join(dir, 'sales'));
    assert.equal(fs.readFileSync(path.join(dir, 'sales', files[0]), 'utf8').trim().split('\n').length, 2);
    await s.login();
    assert.equal((await s.call('GET', '/api/report')).json.total, 165);
    assert.equal((await s.call('GET', '/api/state')).json.keys[1], 'aaaaaaaa');
    await s.stop();
  });

  test('menu.json ผิด: แจ้งข้อผิดพลาดเป็นภาษาไทยที่ชี้จุดผิด', async () => {
    const bad = JSON.stringify({ categories: ['ก'], stations: { hot: 'ครัว' }, items: [
      { id: 1, name: 'ข้าว', price: 50, cat: 0, station: 'hot' },
      { id: 1, name: 'ซ้ำ', price: 'ห้าสิบ', cat: 3, station: 'grill' }] });
    const s = start(makeApp(bad));
    await assert.rejects(s.ready, e => /id" 1 ซ้ำ/.test(e.out) && /price/.test(e.out) && /cat/.test(e.out) && /station/.test(e.out));
  });
});

describe('กันสแปม', () => {
  test('ลูกค้าสั่งถี่เกินถูกจำกัด และนับแยกตาม IP จริงเมื่อใช้ TRUST_PROXY', async () => {
    const s = start(makeApp(), { ORDER_LIMIT: '2', TRUST_PROXY: '1' });
    await s.ready; await s.login();
    const k = (await s.call('GET', '/api/state')).json.keys[1];
    const o = ip => s.guest('POST', '/api/order', { table: 1, key: k, items: [{ id: 18, qty: 1 }] }, { 'cf-connecting-ip': ip });
    assert.equal((await o('1.1.1.1')).status, 200);
    assert.equal((await o('1.1.1.1')).status, 200);
    assert.equal((await o('1.1.1.1')).status, 429);
    assert.equal((await o('2.2.2.2')).status, 200, 'ลูกค้าอีกคนไม่โดนลิมิตของคนแรก');
    assert.equal((await s.call('POST', '/api/order', { table: 1, items: [{ id: 18, qty: 1 }] })).status, 200, 'พนักงานไม่ถูกจำกัด');
    await s.stop();
  });
});

/* ---------- เมนู รูปอาหาร สำรองและกู้คืน ---------- */
const JPG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(200, 7)]);
async function upload(s, id, buf, type, asStaff) {
  const headers = { 'content-type': type || 'image/jpeg' };
  if (asStaff !== false) headers.cookie = s.cookie;
  const r = await fetch(s.B + '/api/menu/image?id=' + id, { method: 'POST', headers, body: buf });
  return { status: r.status, json: await r.json().catch(() => null) };
}
// ดาวน์โหลดไฟล์สำรอง (gzip) แล้วแตกเป็น JSON
async function getBackup(s, name) {
  const r = await fetch(s.B + '/api/backup/download?name=' + encodeURIComponent(name), { headers: { cookie: s.cookie } });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  if (r.status === 200) json = JSON.parse((buf[0] === 0x1f ? require('node:zlib').gunzipSync(buf) : buf).toString('utf8'));
  return { status: r.status, headers: r.headers, buf, json };
}
async function restoreRaw(s, buf, type) {
  const r = await fetch(s.B + '/api/backup/restore', { method: 'POST', headers: { cookie: s.cookie, 'content-type': type || 'application/gzip' }, body: buf });
  const sc = r.headers.get('set-cookie');
  if (sc && sc.startsWith('st=')) s.cookie = sc.split(';')[0];     // กู้คืนจากอีกเครื่องแล้วได้ cookie ใหม่
  return { status: r.status, json: await r.json().catch(() => null) };
}
const item = (over) => Object.assign({ name: 'ข้าวไข่เจียว', price: 45, cat: 1, station: 'hot', desc: 'ไข่ฟู' }, over || {});

describe('จัดการเมนูและรูปอาหาร', () => {
  let s, keys, newId;
  before(async () => { s = start(makeApp()); await s.ready; await s.login(); keys = (await s.call('GET', '/api/state')).json.keys; });
  after(() => s.stop());

  test('เพิ่มเมนูใหม่ แล้วลูกค้าเห็นและสั่งได้ทันที', async () => {
    const r = await s.call('POST', '/api/menu/item', item());
    assert.equal(r.status, 200);
    newId = r.json.item.id;
    assert.equal(newId, 23, 'id ต่อจากเมนูเดิม');
    const m = await s.guest('GET', '/api/menu');
    const it = m.json.items.find(x => x.id === newId);
    assert.equal(it.name, 'ข้าวไข่เจียว');
    assert.equal(it.desc, 'ไข่ฟู');
    assert.equal((await s.guest('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: newId, qty: 2 }] })).status, 200);
    assert.equal((await s.guest('GET', '/api/table?t=1&k=' + keys[1])).json.sub, 90);
  });

  test('ข้อมูลเมนูไม่ครบหรือผิดถูกปฏิเสธ', async () => {
    assert.equal((await s.call('POST', '/api/menu/item', item({ name: '  ' }))).status, 400);
    assert.equal((await s.call('POST', '/api/menu/item', item({ price: null }))).status, 400, 'ราคาว่างต้องไม่กลายเป็น 0 บาท');
    assert.equal((await s.call('POST', '/api/menu/item', item({ price: '' }))).status, 400);
    assert.equal((await s.call('POST', '/api/menu/item', item({ price: -5 }))).status, 400);
    assert.equal((await s.call('POST', '/api/menu/item', item({ cat: 999 }))).status, 400);
    assert.equal((await s.call('POST', '/api/menu/item', item({ station: 'grill' }))).status, 400);
    assert.equal((await s.guest('POST', '/api/menu/item', item())).status, 401);
  });

  test('แก้ราคาแล้วมีผลกับออเดอร์ใหม่เท่านั้น และลูกค้ารู้ว่าเมนูเปลี่ยน', async () => {
    const v0 = (await s.guest('GET', '/api/table?t=2&k=' + keys[2])).json.menuVersion;
    await s.guest('POST', '/api/order', { table: 2, key: keys[2], items: [{ id: 1, qty: 1 }] });
    assert.equal((await s.call('POST', '/api/menu/item', { id: 1, name: 'ผัดกะเพราหมูสับ', price: 65, cat: 1, station: 'hot' })).status, 200);
    await s.guest('POST', '/api/order', { table: 2, key: keys[2], items: [{ id: 1, qty: 1 }] });
    const t = await s.guest('GET', '/api/table?t=2&k=' + keys[2]);
    assert.equal(t.json.sub, 125);
    assert.ok(t.json.menuVersion > v0);
    const bill = (await s.call('GET', '/api/state')).json.bills[2];
    assert.deepEqual(bill.lines.map(l => l.price).sort(), [60, 65], 'ใบเสร็จแยกบรรทัดตามราคาจริงที่สั่ง');
  });

  test('ซ่อนเมนู: ลูกค้าไม่เห็นและสั่งไม่ได้', async () => {
    await s.call('POST', '/api/menu/item', { id: 22, name: 'ไอศกรีมกะทิ', price: 50, cat: 5, station: 'dessert', hidden: true });
    assert.ok(!(await s.guest('GET', '/api/menu')).json.items.some(x => x.id === 22));
    assert.equal((await s.guest('POST', '/api/order', { table: 3, key: keys[3], items: [{ id: 22, qty: 1 }] })).status, 400);
  });

  test('อัปโหลดรูป: รับเฉพาะรูปจริง ขนาดไม่เกิน 3MB และเปิดดูได้', async () => {
    const ok = await upload(s, newId, JPG);
    assert.equal(ok.status, 200);
    const img = await fetch(s.B + '/img/' + ok.json.image);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.equal((await upload(s, newId, Buffer.from('<script>alert(1)</script>'))).status, 400, 'ไฟล์ปลอมเป็นรูป');
    assert.equal((await upload(s, newId, JPG, 'text/html')).status, 415);
    // เซิร์ฟเวอร์ตอบ 413 แล้วตัดการเชื่อมต่อทันทีระหว่างที่ client ยังส่งไม่จบ บน Windows client อาจเห็นแค่การเชื่อมต่อถูกตัด
    const big = await upload(s, newId, Buffer.concat([JPG, Buffer.alloc(3 * 1024 * 1024)])).catch(e => ({ status: e.cause && e.cause.code }));
    assert.ok([413, 'ECONNRESET', 'EPIPE'].includes(big.status), 'ไฟล์ใหญ่เกินต้องถูกปฏิเสธ (ได้ ' + big.status + ')');
    assert.equal((await upload(s, newId, JPG, 'image/jpeg', false)).status, 401);
    assert.equal((await upload(s, 9999, JPG)).status, 404);
    const again = await upload(s, newId, JPG);
    assert.notEqual(again.json.image, ok.json.image);
    assert.equal((await fetch(s.B + '/img/' + ok.json.image)).status, 404, 'รูปเก่าถูกลบเมื่อเปลี่ยนรูป');
    assert.equal((await fetch(s.B + '/img/..%2Fdata.json')).status, 404);
    assert.equal((await s.guest('GET', '/api/menu')).json.items.find(x => x.id === newId).image, again.json.image);
  });

  test('หมวดหมู่: เพิ่ม แก้ชื่อ เลื่อน ลบได้ แต่ลบหมวดที่ยังมีเมนูไม่ได้', async () => {
    assert.equal((await s.call('POST', '/api/menu/category/delete', { id: 1 })).status, 400);
    const c = await s.call('POST', '/api/menu/category', { name: 'เมนูแนะนำ' });
    assert.equal(c.status, 200);
    assert.equal((await s.call('POST', '/api/menu/category', { id: c.json.category.id, name: 'แนะนำวันนี้' })).status, 200);
    await s.call('POST', '/api/menu/category/move', { id: c.json.category.id, dir: -1 });
    const cats = (await s.call('GET', '/api/state')).json.menu.categories;
    assert.equal(cats[cats.length - 2].name, 'แนะนำวันนี้');
    assert.ok(!(await s.guest('GET', '/api/menu')).json.categories.some(x => x.name === 'แนะนำวันนี้'), 'หมวดว่างไม่แสดงให้ลูกค้า');
    assert.equal((await s.call('POST', '/api/menu/category/delete', { id: c.json.category.id })).status, 200);
  });

  test('ลบเมนู: รูปถูกลบด้วย และบิลที่สั่งไปแล้วยังถูกต้อง', async () => {
    const img = (await s.call('GET', '/api/state')).json.menu.items.find(x => x.id === newId).image;
    assert.equal((await s.call('POST', '/api/menu/item/delete', { id: newId })).status, 200);
    assert.equal((await fetch(s.B + '/img/' + img)).status, 404);
    const bill = (await s.call('GET', '/api/state')).json.bills[1];
    assert.equal(bill.sub, 90, 'ออเดอร์เดิมของเมนูที่ลบยังคิดเงินได้');
  });

  test('ตัวเลือกหมายเหตุแก้ได้ และลูกค้าเลือกได้เฉพาะที่ร้านกำหนด', async () => {
    assert.equal((await s.call('POST', '/api/menu/notes', { notes: ['ไม่ใส่ผักชี', 'พิเศษ', 'พิเศษ', ' '] })).status, 200);
    assert.deepEqual((await s.guest('GET', '/api/menu')).json.notes, ['ไม่ใส่ผักชี', 'พิเศษ']);
    await s.guest('POST', '/api/order', { table: 4, key: keys[4], items: [{ id: 2, qty: 1, note: ['พิเศษ', 'ไม่เผ็ด'] }] });
    const t = await s.guest('GET', '/api/table?t=4&k=' + keys[4]);
    assert.deepEqual(t.json.tickets[0].items[0].note, ['พิเศษ']);
  });
});

describe('สำรองและกู้คืนข้อมูล', () => {
  test('สำรองเอง: ไฟล์มีครบทุกอย่าง และคัดลอกไป BACKUP_DIR', async () => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-copy-'));
    tempDirs.push(copy);
    const s = start(makeApp(), { BACKUP_DIR: copy });
    await s.ready; await s.login();
    const id = (await s.call('POST', '/api/menu/item', item())).json.item.id;
    const img = (await upload(s, id, JPG)).json.image;
    await s.call('POST', '/api/order', { table: 1, items: [{ id, qty: 1 }] });
    await s.call('POST', '/api/pay', { table: 1, expectedSub: 45, method: 'cash' });
    const b = await s.call('POST', '/api/backup', {});
    assert.equal(b.status, 200);
    assert.equal(b.json.backup.copied, true);
    assert.ok(fs.existsSync(path.join(s.dir, 'backups', b.json.backup.name)));
    assert.ok(fs.existsSync(path.join(copy, b.json.backup.name)));
    const list = await s.call('GET', '/api/backups');
    assert.ok(list.json.list.some(f => f.name === b.json.backup.name));
    assert.match(b.json.backup.name, /\.json\.gz$/, 'ไฟล์สำรองบีบอัด gzip');
    const dl = await getBackup(s, b.json.backup.name);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('content-type'), 'application/gzip');
    assert.match(dl.headers.get('content-disposition'), /attachment/);
    const file = dl.json;
    assert.equal(file.app, 'ordervai-backup');
    assert.ok(file.data.menu.items.some(x => x.id === id));
    assert.ok(file.images[img], 'มีรูปอาหารในไฟล์สำรอง');
    assert.equal(Object.keys(file.sales).length, 1, 'มียอดขายในไฟล์สำรอง');
    assert.equal((await s.guest('GET', '/api/backup/download?name=' + encodeURIComponent(b.json.backup.name))).status, 401);
    assert.equal((await s.call('GET', '/api/backup/download?name=..%2Fdata.json')).status, 400);
    await s.stop();
  });

  test('กู้คืน: ข้อมูลกลับเหมือนตอนสำรอง และระบบสำรองข้อมูลปัจจุบันไว้ก่อน', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const id = (await s.call('POST', '/api/menu/item', item())).json.item.id;
    await upload(s, id, JPG);
    await s.call('POST', '/api/settings', { shop: 'ครัวคุณแม่', address: '12 ถ.สุขุมวิท', taxId: '1234567890123' });
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const name = (await s.call('POST', '/api/backup', {})).json.backup.name;
    const gz = (await getBackup(s, name)).buf;
    // ทำข้อมูลพังหลังสำรอง
    await s.call('POST', '/api/menu/item/delete', { id });
    await s.call('POST', '/api/settings', { shop: 'ชื่อผิด' });
    assert.equal((await s.call('POST', '/api/backup/restore', '{"app":"other"}')).status, 400);
    assert.equal((await s.call('GET', '/api/state')).json.settings.shop, 'ชื่อผิด', 'ไฟล์ผิดไม่ทำให้ข้อมูลเปลี่ยน');
    const r = await restoreRaw(s, gz);
    assert.equal(r.status, 200);
    assert.match(r.json.safetyBackup, /before-restore/);
    const st = (await s.call('GET', '/api/state')).json;
    assert.equal(st.settings.shop, 'ครัวคุณแม่');
    assert.equal(st.settings.address, '12 ถ.สุขุมวิท');
    assert.deepEqual(st.keys, keys, 'รหัส QR เดิม ไม่ต้องพิมพ์ QR ใหม่');
    const back = st.menu.items.find(x => x.id === id);
    assert.ok(back && back.image);
    assert.equal((await fetch(s.B + '/img/' + back.image)).status, 200, 'รูปกลับมาด้วย');
    assert.ok((await s.call('GET', '/api/backups')).json.list.some(f => f.reason === 'before-restore'));
    assert.equal((await fetch(s.B + '/api/backup/restore', { method: 'POST', headers: { 'content-type': 'application/gzip' }, body: gz })).status, 401);
    assert.ok(!fs.readdirSync(s.dir).some(f => /restore-tmp|\.old-/.test(f)), 'ไม่มีโฟลเดอร์ชั่วคราวค้าง');
    await s.stop();
  });

  test('ย้ายเครื่อง: กู้ไฟล์สำรองลงเครื่องใหม่ได้ครบ', async () => {
    const a = start(makeApp()); await a.ready; await a.login();
    const id = (await a.call('POST', '/api/menu/item', item())).json.item.id;
    await upload(a, id, JPG);
    await a.call('POST', '/api/order', { table: 5, items: [{ id: 6, qty: 1 }] });
    await a.call('POST', '/api/pay', { table: 5, expectedSub: 180, method: 'transfer' });
    await a.call('POST', '/api/order', { table: 7, items: [{ id: 1, qty: 1 }] });       // โต๊ะที่ยังเปิดอยู่ตอนย้าย
    const stA = (await a.call('GET', '/api/state')).json;
    const name = (await a.call('POST', '/api/backup', {})).json.backup.name;
    const gz = (await getBackup(a, name)).buf;
    await a.stop();
    const b = start(makeApp()); await b.ready; await b.login();
    assert.equal((await restoreRaw(b, gz)).status, 200);
    const stB = (await b.call('GET', '/api/state')).json;
    assert.deepEqual(stB.keys, stA.keys);
    assert.equal(stB.tickets.length, 1);
    assert.equal(stB.menu.items.length, stA.menu.items.length);
    assert.equal((await fetch(b.B + '/img/' + stB.menu.items.find(x => x.id === id).image)).status, 200);
    assert.equal((await b.call('GET', '/api/report')).json.transfer, 180);
    assert.equal((await b.call('GET', '/api/export.csv')).text.split('\n').length, 2);
    await b.stop();
  });

  test('สำรองอัตโนมัติหลังเปิดระบบ', async () => {
    const s = start(makeApp()); await s.ready;
    await new Promise(r => setTimeout(r, 3600));
    assert.ok(fs.readdirSync(path.join(s.dir, 'backups')).some(f => /-auto\.json\.gz$/.test(f)));
    await s.stop();
  });
});

/* ---------- จาก code review ---------- */
describe('จาก code review', () => {
  test('TRUST_PROXY: คนใน WiFi ปลอม header เพื่อหลบลิมิตเดารหัสไม่ได้', async (t) => {
    const lan = Object.values(os.networkInterfaces()).flat().find(n => n && (n.family === 'IPv4' || n.family === 4) && !n.internal);
    if (!lan) return t.skip('เครื่องนี้ไม่มี IP วง LAN ให้ทดสอบ');
    const s = start(makeApp(), { TRUST_PROXY: '1' });
    await s.ready;
    const port = new URL(s.B).port, codes = [];
    for (let i = 0; i < 9; i++) {
      const r = await fetch('http://' + lan.address + ':' + port + '/api/login', {
        method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.9.9.' + i }, body: JSON.stringify({ pin: String(100000 + i) })
      });
      codes.push(r.status);
    }
    assert.ok(codes.includes(429), 'ต้องโดนลิมิต แม้เปลี่ยน header ทุกครั้ง: ' + codes.join(','));
    await s.stop();
  });

  test('TRUST_PROXY ไม่ยอมเปิดถ้ารหัสพนักงานสั้น', async () => {
    const s = start(makeApp(), { TRUST_PROXY: '1', STAFF_PIN: '1234' });
    await assert.rejects(s.ready, e => e.code === 1 && /อย่างน้อย 6 หลัก/.test(e.out));
  });

  test('กู้คืนไฟล์ที่มีข้อมูลเสียบางส่วน: หน้าพนักงานยังใช้ได้ และข้ามเฉพาะส่วนที่เสีย', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    await s.call('POST', '/api/order', { table: 3, items: [{ id: 1, qty: 1 }] });
    const name = (await s.call('POST', '/api/backup', {})).json.backup.name;
    const b = (await getBackup(s, name)).json;
    b.data.tickets.push({ id: 99, table: 2, station: 'hot', status: 'new' });            // ไม่มี items
    b.data.tickets.push({ id: 100, table: 'x', items: [] });
    b.data.menu.items.push({ id: 'abc', name: 5 });
    b.data.settings.tables = 'สิบ';
    const r = await s.call('POST', '/api/backup/restore', b);
    assert.equal(r.status, 200);
    assert.equal(r.json.dropped, 3);
    const st = await s.call('GET', '/api/state');
    assert.equal(st.status, 200, 'หน้าพนักงานต้องโหลดได้');
    assert.equal(st.json.tickets.length, 1, 'ออเดอร์ที่ดียังอยู่');
    assert.equal(st.json.settings.tables, 12);
    assert.equal((await s.call('GET', '/api/report')).status, 200);
    await s.stop();
  });

  test('data.json ถูกแก้มือจนข้อมูลบางส่วนผิดรูป: ระบบยังเปิดได้', async () => {
    const dir = makeApp();
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({
      keys: { 1: 'aaaaaaaa' }, secret: 'y'.repeat(32), settings: { tables: 4, soldOut: 'x' },
      tickets: [{ id: 1, table: 9, items: [{ id: 1, name: 'ข้าว', price: 50, qty: 1 }] }, null, { id: 2 }],
      sales: [{ no: 1 }], calls: { 2: 'bad' }, menu: { categories: [{ id: 1, name: 'ก' }], items: [{ id: 1, name: 'ข้าว', price: 50, cat: 1 }, {}] }
    }));
    const s = start(dir); await s.ready; await s.login();
    const st = await s.call('GET', '/api/state');
    assert.equal(st.status, 200);
    assert.equal(st.json.settings.tables, 9, 'ขยายจำนวนโต๊ะให้ครอบโต๊ะที่ยังเปิดอยู่');
    assert.equal(st.json.keys[1], 'aaaaaaaa');
    assert.match(s.output, /ข้อมูลเสีย/);
    await s.stop();
  });

  test('CSV: ชื่อเมนูที่ขึ้นต้นด้วย = ไม่กลายเป็นสูตรใน Excel', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const id = (await s.call('POST', '/api/menu/item', { name: '=HYPERLINK("http://x")', price: 10, cat: 1, station: 'hot' })).json.item.id;
    await s.call('POST', '/api/order', { table: 1, items: [{ id, qty: 1 }] });
    await s.call('POST', '/api/pay', { table: 1, expectedSub: 10 });
    const csv = (await s.call('GET', '/api/export.csv')).text;
    assert.match(csv, /"'=HYPERLINK/);
    assert.match(csv, /"10"/, 'ตัวเลขปกติไม่ถูกเติม \'');
    await s.stop();
  });
});

/* ---------- ข้อเสนอแนะจาก code review รอบสอง ---------- */
describe('ความทนทานต่อการใช้งานจริง', () => {
  test('ส่งข้อมูลเกินขนาดแบบไม่หยุด: ตอบ 413 และตัดการเชื่อมต่อทันที', async () => {
    const s = start(makeApp()); await s.ready;
    const port = +new URL(s.B).port;
    const r = await new Promise(resolve => {
      const req = require('node:http').request({ host: '127.0.0.1', port, path: '/api/order', method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } });
      let status = null, sent = 0, iv = null;
      const t0 = Date.now();
      req.on('response', res => { status = res.statusCode; res.resume(); });
      req.on('error', () => {});
      req.on('close', () => { clearInterval(iv); resolve({ status, sent, ms: Date.now() - t0 }); });
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      iv = setInterval(() => { if (sent > 64 * 1024 * 1024) { clearInterval(iv); req.end(); return; } req.write(chunk); sent += chunk.length; }, 2);
    });
    assert.equal(r.status, 413);
    assert.ok(r.sent < 8 * 1024 * 1024, 'เซิร์ฟเวอร์ต้องตัดก่อนรับข้อมูลไปจนจบ (ส่งไป ' + r.sent + ' ไบต์)');
    // ประกาศขนาดเกินตั้งแต่ header: ปฏิเสธทันทีโดยไม่ต้องรออ่าน
    const big = await fetch(s.B + '/api/order', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(50 * 1024 * 1024) }, body: '{}', duplex: 'half' }).catch(e => ({ status: 'err', e }));
    assert.ok(big.status === 413 || big.status === 'err');
    assert.equal((await fetch(s.B + '/api/menu')).status, 200, 'เซิร์ฟเวอร์ยังทำงานปกติ');
    await s.stop();
  });

  test('บันทึกไฟล์ไม่สำเร็จ: หน้าพนักงานได้รับคำเตือน และหายเองเมื่อกลับมาปกติโดยข้อมูลไม่หาย', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const df = path.join(s.dir, 'data.json');
    fs.rmSync(df); fs.mkdirSync(df); fs.writeFileSync(path.join(df, 'x'), 'x');   // ทำให้เขียนทับ data.json ไม่ได้
    await s.call('POST', '/api/order', { table: 1, items: [{ id: 1, qty: 1 }] });
    await new Promise(r => setTimeout(r, 400));
    let h = (await s.call('GET', '/api/state')).json.health;
    assert.ok(h.saveError && h.saveError.message, 'ต้องมีคำเตือน');
    fs.rmSync(df, { recursive: true });
    await s.call('POST', '/api/order', { table: 1, items: [{ id: 2, qty: 1 }] });
    await new Promise(r => setTimeout(r, 400));
    h = (await s.call('GET', '/api/state')).json.health;
    assert.equal(h.saveError, null, 'คำเตือนหายเมื่อบันทึกได้แล้ว');
    assert.equal(JSON.parse(fs.readFileSync(df, 'utf8')).tickets.length, 2, 'ออเดอร์ช่วงที่บันทึกไม่ได้ไม่หาย');
    await s.stop();
  });

  test('บันทึกไม่สำเร็จ: ระบบไม่ค้างระหว่างลองใหม่ และบันทึกให้เองโดยไม่ต้องรอออเดอร์ถัดไป', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const df = path.join(s.dir, 'data.json');
    fs.rmSync(df); fs.mkdirSync(df); fs.writeFileSync(path.join(df, 'x'), 'x');
    await s.call('POST', '/api/order', { table: 1, items: [{ id: 1, qty: 1 }] });
    // บน Windows การเขียนทับโฟลเดอร์ได้ EPERM ซึ่งเป็นกรณีที่ระบบลองซ้ำ ช่วงนั้นคำขออื่นต้องยังตอบได้ทันที
    let slowest = 0;
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      assert.equal((await s.guest('GET', '/api/menu')).status, 200);
      slowest = Math.max(slowest, Date.now() - t0);
      await new Promise(r => setTimeout(r, 80));
    }
    assert.ok(slowest < 300, 'ระบบค้างระหว่างลองบันทึกซ้ำ ' + slowest + ' ms');
    assert.ok((await s.call('GET', '/api/state')).json.health.saveError, 'ต้องมีคำเตือน');
    fs.rmSync(df, { recursive: true });
    await until(() => fs.existsSync(df) && fs.statSync(df).isFile(), 8000);
    assert.equal(JSON.parse(fs.readFileSync(df, 'utf8')).tickets.length, 1);
    assert.equal((await s.call('GET', '/api/state')).json.health.saveError, null);
    await s.stop();
  });

  test('เขียนยอดขายลงไฟล์รายเดือนไม่ได้: คำเตือนไม่หายเอง เขียนให้ครบเมื่อกลับมาปกติ และไม่ซ้ำแม้ปิดเปิดใหม่', async () => {
    const dir = makeApp(), sd = path.join(dir, 'sales');
    let s = start(dir); await s.ready; await s.login();
    const lines = () => fs.readdirSync(sd).reduce((n, f) => n + fs.readFileSync(path.join(sd, f), 'utf8').split('\n').filter(Boolean).length, 0);
    const warn = async () => (await s.call('GET', '/api/state')).json.health.saveError;
    const pay = async t => {
      await s.call('POST', '/api/order', { table: t, items: [{ id: 1, qty: 1 }] });
      const sub = (await s.call('GET', '/api/state')).json.bills[t].sub;
      assert.equal((await s.call('POST', '/api/pay', { table: t, method: 'cash', expectedSub: sub })).status, 200);
    };
    fs.writeFileSync(sd, 'x');                                     // ทำให้สร้างโฟลเดอร์ sales ไม่ได้
    await pay(1);
    await new Promise(r => setTimeout(r, 300));
    assert.ok(await warn(), 'data.json บันทึกได้ แต่บิลยังไม่ลง sales/ ต้องยังเตือนอยู่');
    await s.stop();                                                // ปิดโปรแกรมทั้งที่บิลยังค้างอยู่
    s = start(dir); await s.ready; await s.login();
    assert.ok(await warn(), 'เปิดใหม่แล้วยังเขียนไม่ได้ ต้องเตือน');
    fs.rmSync(sd);
    await until(async () => !(await warn()), 8000);
    assert.equal(lines(), 1, 'บิลที่ค้างอยู่ถูกเขียนลงไฟล์');
    await pay(2);
    assert.equal(lines(), 2);
    await s.stop();
    s = start(dir); await s.ready;
    assert.equal(lines(), 2, 'เปิดใหม่ไม่เขียนบิลซ้ำ');
    await s.stop();
  });

  test('ไฟล์สำรองแบบเก่า (.json ไม่บีบอัด) ยังกู้คืนได้ และไฟล์ gzip ที่เสียถูกปฏิเสธโดยข้อมูลไม่เปลี่ยน', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    await s.call('POST', '/api/settings', { shop: 'ร้านเดิม' });
    const name = (await s.call('POST', '/api/backup', {})).json.backup.name;
    const json = (await getBackup(s, name)).json;
    json.format = 1;
    await s.call('POST', '/api/settings', { shop: 'เปลี่ยนแล้ว' });
    const broken = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4, 5, 6]);
    assert.equal((await restoreRaw(s, broken)).status, 400);
    assert.equal((await s.call('GET', '/api/state')).json.settings.shop, 'เปลี่ยนแล้ว');
    assert.equal((await restoreRaw(s, Buffer.from(JSON.stringify(json)), 'application/json')).status, 200);
    assert.equal((await s.call('GET', '/api/state')).json.settings.shop, 'ร้านเดิม');
    await s.stop();
  });
});

describe('สำรองอัตโนมัติ', () => {
  test('สำรองเฉพาะเมื่อข้อมูลเปลี่ยน ไม่สร้างไฟล์ซ้ำตอนร้านปิด', async () => {
    const s = start(makeApp(), { BACKUP_EVERY_MIN: '0.02' });      // ทุก 1.2 วินาที เพื่อทดสอบ
    await s.ready; await s.login();
    const autos = () => fs.readdirSync(path.join(s.dir, 'backups')).filter(f => /-auto\.json\.gz$/.test(f)).length;
    await new Promise(r => setTimeout(r, 4000));
    assert.equal(autos(), 1, 'ครั้งแรกหลังเปิดระบบ');
    await new Promise(r => setTimeout(r, 3000));
    assert.equal(autos(), 1, 'ไม่มีอะไรเปลี่ยน ไม่สำรองซ้ำ');
    await new Promise(r => setTimeout(r, 1000));                     // ให้ชื่อไฟล์คนละวินาที
    await s.call('POST', '/api/order', { table: 1, items: [{ id: 1, qty: 1 }] });
    await new Promise(r => setTimeout(r, 3000));
    assert.equal(autos(), 2, 'มีออเดอร์ใหม่ สำรองให้');
    await s.stop();
  });
});

describe('แจ้งหน้าพนักงานแบบสด', () => {
  test('บันทึกไม่สำเร็จหรือกลับมาปกติ: ส่งสัญญาณให้หน้าพนักงานรีเฟรชเอง', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    let events = 0;
    const sse = require('node:http').get(s.B + '/api/events', { headers: { cookie: s.cookie } }, res => {
      res.on('data', d => { events += (String(d).match(/event: change/g) || []).length; });
    });
    await new Promise(r => setTimeout(r, 200));
    const df = path.join(s.dir, 'data.json');
    fs.rmSync(df); fs.mkdirSync(df); fs.writeFileSync(path.join(df, 'x'), 'x');
    await s.call('POST', '/api/order', { table: 1, items: [{ id: 1, qty: 1 }] });
    await new Promise(r => setTimeout(r, 500));
    assert.equal(events, 2, 'ออเดอร์ใหม่ 1 ครั้ง + บันทึกไม่สำเร็จ 1 ครั้ง');
    fs.rmSync(df, { recursive: true });
    await s.call('POST', '/api/order', { table: 1, items: [{ id: 2, qty: 1 }] });
    await new Promise(r => setTimeout(r, 500));
    assert.equal(events, 4, 'ออเดอร์ใหม่ 1 ครั้ง + กลับมาบันทึกได้ 1 ครั้ง');
    sse.destroy();
    await s.stop();
  });
});

/* ---------- จาก QA: เงิน ข้อมูลไม่หาย และสิทธิ์ ---------- */
const kill9 = s => new Promise(r => { if (s.proc.exitCode !== null) return r(); s.proc.on('exit', r); s.proc.kill('SIGKILL'); });
// เรียกจาก IP ต้นทางที่กำหนด (127.0.0.x) เพื่อจำลองมือถือคนละเครื่อง
function fromIp(s, ip, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = data ? { 'content-type': 'application/json', 'content-length': data.length } : {};
    const req = require('node:http').request(s.B + p, { method, headers, localAddress: ip, agent: false }, res => {
      let t = ''; res.on('data', c => { t += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(t); } catch (e) { /* ignore */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    req.end(data || undefined);
  });
}
async function payTable(s, t, method) {
  const sub = (await s.call('GET', '/api/state')).json.bills[t].sub;
  return s.call('POST', '/api/pay', { table: t, method: method || 'cash', expectedSub: sub });
}
const salesNos = dir => fs.readdirSync(path.join(dir, 'sales')).flatMap(f => fs.readFileSync(path.join(dir, 'sales', f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).no));

describe('จาก QA: เงินและข้อมูลไม่หาย', () => {
  test('ได้ 200 แล้วต้องอยู่บนดิสก์แล้ว: ไฟดับทันทีหลังสั่งอาหารหรือแก้ข้อมูล ข้อมูลไม่หาย', async () => {
    const dir = makeApp();
    let s = start(dir); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    assert.equal((await s.guest('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 2 }], memo: 'ก่อนไฟดับ' })).status, 200);
    assert.equal((await s.call('POST', '/api/soldout', { id: 2, soldOut: true })).status, 200);
    await kill9(s);
    s = start(dir); await s.ready; await s.login();
    const st = (await s.call('GET', '/api/state')).json;
    assert.ok(st.tickets.some(k => k.memo === 'ก่อนไฟดับ'), 'ออเดอร์ที่ลูกค้าเห็นว่าส่งสำเร็จต้องไม่หาย');
    assert.ok(st.settings.soldOut.includes(2), 'การแก้ข้อมูลที่พนักงานเห็นว่าสำเร็จต้องไม่หาย');
    await s.stop();
  });

  test('เขียน data.json ไม่ได้ตอนปิดบิลแล้วโปรแกรมดับ: เปิดใหม่แล้วเลขบิลไม่ซ้ำกับที่อยู่ใน sales/', async () => {
    const dir = makeApp(), df = path.join(dir, 'data.json');
    let s = start(dir); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 1 }] });
    await new Promise(r => setTimeout(r, 300));
    fs.copyFileSync(df, df + '.keep');
    fs.rmSync(df); fs.mkdirSync(df);                              // เขียนทับ data.json ไม่ได้ เหมือนถูกล็อก
    assert.equal((await payTable(s, 1)).status, 200);
    await kill9(s);
    fs.rmSync(df, { recursive: true }); fs.renameSync(df + '.keep', df);   // บนดิสก์ยังเป็นข้อมูลก่อนปิดบิล
    s = start(dir); await s.ready; await s.login();
    await s.call('POST', '/api/order', { table: 2, key: keys[2], items: [{ id: 1, qty: 1 }] });
    assert.equal((await payTable(s, 2)).status, 200);
    const nos = salesNos(dir);
    assert.equal(new Set(nos).size, nos.length, 'เลขบิลซ้ำ ' + JSON.stringify(nos));
    await s.stop();
  });

  test('กู้คืนไฟล์สำรองที่เก่ากว่าใบเสร็จที่ออกไปแล้ว: บิลใหม่ไม่ใช้เลขซ้ำ', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const name = (await s.call('POST', '/api/backup', {})).json.backup.name;
    const file = (await getBackup(s, name)).buf;
    await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 1 }] });
    const first = (await payTable(s, 1)).json.sale.no;
    assert.equal((await restoreRaw(s, file)).status, 200);
    await s.call('POST', '/api/order', { table: 2, key: keys[2], items: [{ id: 1, qty: 1 }] });
    const next = (await payTable(s, 2)).json.sale.no;
    assert.ok(next > first, 'ใบเสร็จเลข ' + first + ' ออกไปแล้ว บิลหลังกู้คืนได้เลข ' + next);
    await s.stop();
  });

  test('ออเดอร์ที่ส่งมาถึงระหว่างกำลังกู้คืน: ต้องไม่ได้ 200 แล้วหายไปเงียบๆ', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const sd = path.join(s.dir, 'sales'); fs.mkdirSync(sd, { recursive: true });
    const line = JSON.stringify({ no: 1, at: Date.UTC(2024, 0, 5), table: 1, sub: 100, svc: 10, vat: 0, total: 110, method: 'cash', items: [{ name: 'ข้าวผัด', qty: 1, price: 100 }] }) + '\n';
    for (let m = 1; m <= 6; m++) fs.writeFileSync(path.join(sd, '2024-0' + m + '.jsonl'), line.repeat(9000));   // ให้การกู้คืนใช้เวลาพอให้ชนกัน
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const file = (await getBackup(s, (await s.call('POST', '/api/backup', {})).json.backup.name)).buf;
    const body = Buffer.from(JSON.stringify({ table: 3, key: keys[3], items: [{ id: 1, qty: 1 }], memo: 'ระหว่างกู้คืน' }));
    let finish;
    const order = new Promise(resolve => {
      const req = require('node:http').request(s.B + '/api/order', { method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': body.length } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', () => resolve('err'));
      req.write(body.subarray(0, 10));                           // ส่ง body ไปครึ่งเดียวก่อน
      finish = () => req.end(body.subarray(10));
    });
    await new Promise(r => setTimeout(r, 100));
    const restoring = restoreRaw(s, file);
    let saw503 = false;
    for (let i = 0; i < 400 && !saw503; i++) { saw503 = (await s.call('POST', '/api/call/clear', { table: 9 })).status === 503; if (!saw503) await new Promise(r => setTimeout(r, 5)); }
    assert.ok(saw503, 'ต้องจับจังหวะกำลังกู้คืนได้');
    finish();
    const status = await order;
    assert.equal((await restoring).status, 200);
    const kept = (await s.call('GET', '/api/state')).json.tickets.some(k => k.memo === 'ระหว่างกู้คืน');
    assert.ok(status !== 200 || kept, 'ออเดอร์ได้ 200 แต่หายหลังกู้คืน');
    assert.equal(status, 503, 'ระหว่างกู้คืนต้องบอกลูกค้าให้ลองใหม่');
    await s.stop();
  });

  test('กดกู้คืนสองครั้งพร้อมกัน (สองเครื่อง): กู้คืนได้ครั้งเดียว อีกครั้งถูกปฏิเสธ', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const file = (await getBackup(s, (await s.call('POST', '/api/backup', {})).json.backup.name)).buf;
    // last-byte sync: ส่งไฟล์ทั้งสองคำขอจนเหลือไบต์สุดท้าย แล้วปล่อยพร้อมกัน ให้เซิร์ฟเวอร์อ่านเสร็จพร้อมกันแน่นอน
    const finish = [];
    const reqs = [0, 1].map(() => new Promise(resolve => {
      const req = require('node:http').request(s.B + '/api/backup/restore', { method: 'POST', agent: false, headers: { cookie: s.cookie, 'content-type': 'application/gzip', 'content-length': file.length } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', () => resolve('err'));
      req.write(file.subarray(0, file.length - 1));
      finish.push(() => req.end(file.subarray(file.length - 1)));
    }));
    await new Promise(r => setTimeout(r, 200));
    finish.forEach(f => f());
    const codes = (await Promise.all(reqs)).sort();
    assert.ok(codes[0] === 200 && [409, 503].includes(codes[1]), 'กู้คืนซ้อนกันได้ ' + JSON.stringify(codes));
    assert.equal((await s.call('GET', '/api/state')).status, 200);
    await s.stop();
  });

  test('CSV: ค่าที่ขึ้นต้นด้วยตัวเลขติดลบแล้วตามด้วยสูตร (-2+3+cmd...) ไม่กลายเป็นสูตรใน Excel', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const it = (await s.call('POST', '/api/menu/item', item({ name: "-2+3+cmd|' /C calc'!A0" }))).json.item;
    const keys = (await s.call('GET', '/api/state')).json.keys;
    await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: it.id, qty: 1 }] });
    await payTable(s, 1);
    const row = (await s.call('GET', '/api/export.csv')).text.split('\r\n')[1];
    assert.ok(row.endsWith("\"'-2+3+cmd|' /C calc'!A0 x1\""), row);
    await s.stop();
  });
});

describe('จาก QA: สิทธิ์และการเดารหัส', () => {
  test('ทุก endpoint ของพนักงานตอบ 401 เมื่อไม่มี cookie (endpoint ที่เพิ่มในอนาคตถูกตรวจด้วย)', async () => {
    const PUBLIC = ['POST /api/login', 'POST /api/logout', 'GET /api/menu', 'GET /api/table', 'POST /api/order', 'POST /api/call', 'GET /api/brand'];
    const all = Object.keys(require('../lib/routes').api);
    PUBLIC.forEach(k => assert.ok(all.includes(k), 'รายการ public ไม่ตรงกับ api: ' + k));
    const s = start(makeApp()); await s.ready;
    const checked = [];
    for (const k of all.filter(x => !PUBLIC.includes(x)).concat(['GET /api/events'])) {
      const [method, p] = k.split(' ');
      const r = await fetch(s.B + p + '?id=1&name=x&month=2024-01', { method, headers: method === 'POST' ? { 'content-type': 'application/json' } : {}, body: method === 'POST' ? '{}' : undefined });
      assert.equal(r.status, 401, k + ' ต้องเข้าสู่ระบบก่อน');
      await r.body?.cancel();
      checked.push(k);
    }
    assert.ok(checked.length >= 20, 'ตรวจ ' + checked.length + ' endpoint');
    await s.stop();
  });

  test('เดารหัส QR ผิดติดกันจาก IP เดียวถูกจำกัด แต่ลูกค้าเครื่องอื่นยังสั่งได้', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const codes = {};
    for (let i = 0; i < 60; i++) {
      const r = await fromIp(s, '127.0.0.9', 'GET', '/api/table?t=1&k=' + (0x10000000 + i).toString(16));
      codes[r.status] = (codes[r.status] || 0) + 1;
    }
    assert.ok(codes[429] > 0, 'เดาผิด 60 ครั้งต้องถูกจำกัด ' + JSON.stringify(codes));
    assert.equal((await fromIp(s, '127.0.0.9', 'GET', '/api/table?t=1&k=' + keys[1])).status, 429, 'ถูกจำกัดแล้ว รหัสถูกก็ยังไม่ให้ลอง');
    assert.equal((await fromIp(s, '127.0.0.10', 'GET', '/api/table?t=1&k=' + keys[1])).status, 200, 'มือถือเครื่องอื่นไม่โดนด้วย');
    assert.equal((await fromIp(s, '127.0.0.10', 'POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 1 }] })).status, 200);
    await s.stop();
  });

  test('เดา PIN จากหลาย IP (ตั้ง IP เองใน WiFi ร้าน): รหัสผิดรวมถูกจำกัด แต่เครื่องร้านยังเข้าสู่ระบบได้', async () => {
    const s = start(makeApp()); await s.ready;
    const codes = {};
    await Promise.all(Array.from({ length: 50 }, (_, ip) => (async () => {
      for (let j = 0; j < 6; j++) {
        const r = await fromIp(s, '127.0.4.' + (ip + 1), 'POST', '/api/login', { pin: String(100000 + ip * 6 + j) });
        codes[r.status] = (codes[r.status] || 0) + 1;
      }
    })()));
    assert.ok(codes[401] <= 30 && codes[429] >= 270, 'เดาผิดได้ ' + JSON.stringify(codes));
    assert.equal((await fromIp(s, '127.0.4.200', 'POST', '/api/login', { pin: PIN })).status, 429, 'ช่วงถูกพัก เครื่องอื่นในวงต้องรอแม้รหัสถูก');
    assert.equal((await s.login()).status, 200, 'เครื่องร้านเอง (127.0.0.1) เข้าสู่ระบบได้เสมอ');
    await s.stop();
  });

  test('เปิดระบบซ้อนบนข้อมูลชุดเดียวกัน (แม้คนละพอร์ต): ตัวที่สองไม่ยอมเปิดและไม่แตะข้อมูล', async () => {
    const dir = makeApp();
    const a = start(dir); await a.ready; await a.login();
    const before = fs.readFileSync(path.join(dir, 'data.json'), 'utf8');
    const b = start(dir);
    await assert.rejects(b.ready, e => e.code === 1 && /เปิดอยู่แล้ว/.test(e.out), 'ตัวที่สองต้องหยุดพร้อมบอกเหตุผล');
    assert.equal(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'), before, 'ตัวที่สองต้องไม่เขียน data.json');
    assert.equal((await a.call('GET', '/api/state')).status, 200, 'ตัวแรกยังทำงานปกติ');
    await a.stop();
    const c = start(dir); await c.ready;                          // ปิดตัวแรกแล้วเปิดใหม่ได้ตามปกติ
    await c.stop();
  });
});

/* ---------- Log: audit / security / app และเงินทอน ---------- */
const monthNow = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
const readLog = (dir, kind) => { try { return fs.readFileSync(path.join(dir, 'logs', kind + '-' + monthNow() + '.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) { return []; } };
const allLogText = dir => { try { return fs.readdirSync(path.join(dir, 'logs')).map(f => fs.readFileSync(path.join(dir, 'logs', f), 'utf8')).join('\n'); } catch (e) { return ''; } };

describe('Log และเงินทอน', () => {
  test('เงินทอน: รับเงินน้อยกว่ายอดถูกปฏิเสธโดยบิลไม่ถูกปิด รับมากกว่าได้เงินทอนถูกต้อง', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 2 }] });
    const sub = (await s.call('GET', '/api/state')).json.bills[1].sub;   // 120 → ค่าบริการ 12 = 132
    const short = await s.call('POST', '/api/pay', { table: 1, expectedSub: sub, svc: true, method: 'cash', received: 100 });
    assert.equal(short.status, 400);
    assert.ok((await s.call('GET', '/api/state')).json.bills[1], 'บิลยังเปิดอยู่');
    assert.equal((await s.call('POST', '/api/pay', { table: 1, expectedSub: sub, svc: true, method: 'cash', received: '500' })).status, 400, 'ต้องเป็นตัวเลข');
    const ok = await s.call('POST', '/api/pay', { table: 1, expectedSub: sub, svc: true, method: 'cash', received: 500 });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.sale.total, 132);
    assert.deepEqual([ok.json.received, ok.json.change], [500, 368]);
    const paid = readLog(s.dir, 'audit').find(e => e.action === 'bill.paid');
    assert.deepEqual([paid.total, paid.received, paid.change, paid.method], [132, 500, 368, 'cash']);
    await s.stop();
  });

  test('audit: ยกเลิกออเดอร์ แก้ราคา เปลี่ยน PromptPay กู้คืน ถูกบันทึกพร้อมค่าเดิม ค่าใหม่ เครื่อง และรหัสคำขอ', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    await s.call('POST', '/api/settings', { promptpay: '0811111111' });
    const file = (await getBackup(s, (await s.call('POST', '/api/backup', {})).json.backup.name)).buf;
    const o = await s.guest('POST', '/api/order', { table: 2, key: keys[2], items: [{ id: 1, qty: 3 }], memo: 'เผ็ดน้อย' });
    const r = await s.call('POST', '/api/ticket/void', { id: o.json.tickets[0], reason: 'ลูกค้าเปลี่ยนใจ' });
    assert.ok(r.headers.get('x-request-id'), 'ทุกคำขอมีรหัสอ้างอิง');
    await s.call('POST', '/api/menu/item', item({ id: 1, name: 'ผัดกะเพราหมูสับ', price: 75, cat: 1, station: 'hot' }));
    await s.call('POST', '/api/settings', { promptpay: '0899999999' });
    assert.equal((await restoreRaw(s, file)).status, 200);
    const ev = readLog(s.dir, 'audit'), by = a => ev.filter(e => e.action === a);
    const v = by('ticket.voided')[0];
    assert.deepEqual([v.table, v.value, v.items[0].qty, v.by], [2, 180, 3, 'staff']);
    assert.equal(v.req, r.headers.get('x-request-id'), 'log เชื่อมกับคำขอได้');
    assert.ok(v.ip && v.dev, 'บอกว่าทำจากเครื่องไหน');
    const p = by('menu.item.updated')[0];
    assert.deepEqual([p.before.price, p.after.price], [60, 75]);
    const pp = by('settings.changed').map(e => [e.before.promptpay, e.after.promptpay]);
    assert.deepEqual(pp, [['', '0811111111'], ['0811111111', '0899999999']]);
    assert.equal(by('order.created')[0].by, 'guest');
    assert.equal(by('backup.restored').length, 1, 'บันทึกการกู้คืน');
    assert.ok(by('settings.changed').length === 2 && by('ticket.voided').length === 1, 'กู้คืนแล้ว log เดิมไม่ถูกย้อนตาม');
    const day = (await s.call('GET', '/api/audit')).json;
    assert.equal(day.chain.ok, true);
    assert.ok(day.events.some(e => e.action === 'ticket.voided'));
    await s.stop();
  });

  test('ไม่มี PIN, cookie, รหัส QR หรือ secret หลุดลง log ทุกชนิด', async () => {
    const s = start(makeApp()); await s.ready;
    await s.call('POST', '/api/login', { pin: '000000' });
    await s.login();
    const st = (await s.call('GET', '/api/state')).json;
    await s.guest('GET', '/api/table?t=1&k=deadbeef');
    await s.guest('POST', '/api/order', { table: 1, key: st.keys[1], items: [{ id: 1, qty: 1 }] });
    await s.call('POST', '/api/settings', { shop: 'ร้านทดสอบ', tables: 14 });     // ensureKeys สร้างรหัส QR ใหม่ให้โต๊ะ 13-14
    await s.call('GET', '/api/export.csv');
    const text = allLogText(s.dir), data = JSON.parse(fs.readFileSync(path.join(s.dir, 'data.json'), 'utf8'));
    assert.ok(text.length > 0);
    assert.ok(!text.includes(PIN), 'มี PIN');
    assert.ok(!text.includes(s.cookie.slice(3)), 'มี cookie พนักงาน');
    assert.ok(!text.includes(data.secret), 'มี secret');
    Object.values(data.keys).forEach(k => assert.ok(!text.includes(k), 'มีรหัส QR ' + k));
    await s.stop();
  });

  test('security: รหัสผิด เข้าหน้าพนักงานไม่ได้ และรหัส QR ผิด ถูกบันทึก โดยเหตุการณ์ซ้ำไม่ท่วม log', async () => {
    const s = start(makeApp()); await s.ready;
    await s.call('POST', '/api/login', { pin: '111111' });
    for (let i = 0; i < 20; i++) await s.guest('GET', '/api/state');           // แท็บเล็ตที่หลุดระบบเรียกซ้ำ
    for (let i = 0; i < 5; i++) await s.guest('GET', '/api/table?t=3&k=0000000' + i);
    await s.login();
    const ev = readLog(s.dir, 'security'), n = a => ev.filter(e => e.action === a).length;
    assert.equal(n('auth.login_failed'), 1);
    assert.equal(n('auth.login'), 1);
    assert.equal(n('auth.denied'), 1, '401 ซ้ำจากที่เดิมบันทึกครั้งเดียว');
    assert.equal(n('qr.denied'), 1);
    const r = await s.guest('GET', '/api/state');
    assert.ok(r.json.requestId && r.json.requestId === r.headers.get('x-request-id'), 'error บอกรหัสอ้างอิง');
    assert.ok(readLog(s.dir, 'app').some(e => e.msg === 'start'), 'app log บันทึกตอนเปิดระบบ');
    await s.stop();
  });

  test('แก้ไขไฟล์ audit นอกระบบ: ตรวจเจอ และไม่คัดลอกทับสำเนาเดิมใน BACKUP_DIR', async () => {
    const dir = makeApp(), copy = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-bkcopy-')); tempDirs.push(copy);
    const s = start(dir, { BACKUP_DIR: copy }); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const o = await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 1 }] });
    await s.call('POST', '/api/ticket/void', { id: o.json.tickets[0], reason: 'ลูกค้าเปลี่ยนใจ' });
    await s.call('POST', '/api/backup', {});
    const f = 'audit-' + monthNow() + '.jsonl', mirror = path.join(copy, 'logs', f);
    const good = fs.readFileSync(mirror, 'utf8');
    assert.ok(good.includes('ticket.voided'), 'สำเนา log ไปอยู่นอกเครื่อง');
    // คนในร้านลบบรรทัดยกเลิกออเดอร์ทิ้งเพื่อปิดบังเงินที่หายไป
    const lf = path.join(dir, 'logs', f);
    fs.writeFileSync(lf, fs.readFileSync(lf, 'utf8').split('\n').filter(l => !l.includes('ticket.voided')).join('\n'));
    const chain = (await s.call('GET', '/api/audit')).json.chain;
    assert.equal(chain.ok, false, 'ต้องตรวจเจอว่า log ถูกแก้');
    const bk = (await s.call('POST', '/api/backup', {})).json.backup;
    assert.equal(bk.copied, false);
    assert.match(bk.copyError, /ตรวจพบการแก้ไข log/);
    assert.equal(fs.readFileSync(mirror, 'utf8'), good, 'สำเนาเดิมที่ยังดีไม่ถูกทับ');
    await s.stop();
  });

  test('แก้ตัวเลขใน audit โดยขนาดไฟล์เท่าเดิม: หน้าสรุปยอดตรวจเจอทันที ไม่ใช่รอรอบตรวจถัดไป', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const o = await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 3 }] });
    await s.call('POST', '/api/ticket/void', { id: o.json.tickets[0], reason: 'ลูกค้าเปลี่ยนใจ' });
    assert.equal((await s.call('GET', '/api/audit')).json.chain.ok, true, 'ตรวจครั้งแรก ระบบจำผลไว้');
    const lf = path.join(s.dir, 'logs', 'audit-' + monthNow() + '.jsonl');
    const text = fs.readFileSync(lf, 'utf8'), fake = text.replace('"value":180', '"value":100');
    assert.ok(fake !== text && fake.length === text.length);
    await new Promise(r => setTimeout(r, 20));
    fs.writeFileSync(lf, fake);                                    // ลดมูลค่าที่ยกเลิก ขนาดไฟล์ไม่เปลี่ยน
    const chain = (await s.call('GET', '/api/audit')).json.chain;
    assert.equal(chain.ok, false, 'ต้องตรวจเจอ ' + JSON.stringify(chain));
    await s.stop();
  });

  test('เขียน log ไม่ได้: ป้ายเตือนขึ้น ระบบยังรับออเดอร์ได้ และ log ที่ค้างถูกเขียนครบเมื่อกลับมาปกติ', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const ld = path.join(s.dir, 'logs');
    fs.rmSync(ld, { recursive: true, force: true }); fs.writeFileSync(ld, 'x');       // สร้างโฟลเดอร์ logs ไม่ได้
    for (let i = 0; i < 3; i++) assert.equal((await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 1 }], memo: 'ค้าง' + i })).status, 200);
    await new Promise(r => setTimeout(r, 300));
    assert.ok((await s.call('GET', '/api/state')).json.health.saveError, 'ต้องเตือน');
    fs.rmSync(ld);
    await until(async () => !(await s.call('GET', '/api/state')).json.health.saveError, 8000);
    const memos = readLog(s.dir, 'audit').filter(e => e.action === 'order.created').map(e => e.memo);
    assert.deepEqual(memos, ['ค้าง0', 'ค้าง1', 'ค้าง2'], 'ไม่หายและเรียงตามลำดับ');
    assert.equal((await s.call('GET', '/api/audit')).json.chain.ok, true);
    await s.stop();
  });

  test('ลบ log ที่เก่าเกินระยะเก็บตอนเปิดระบบ (audit 25 เดือน, security 6, app 3)', async () => {
    const dir = makeApp(); fs.mkdirSync(path.join(dir, 'logs'));
    const ago = n => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
    const files = { ['audit-' + ago(24)]: 1, ['audit-' + ago(25)]: 0, ['security-' + ago(5)]: 1, ['security-' + ago(6)]: 0, ['app-' + ago(2)]: 1, ['app-' + ago(3)]: 0 };
    Object.keys(files).forEach(f => fs.writeFileSync(path.join(dir, 'logs', f + '.jsonl'), '{}\n'));
    fs.writeFileSync(path.join(dir, 'logs', 'อื่นๆ.txt'), 'ไม่ใช่ log');
    const s = start(dir); await s.ready;
    Object.keys(files).forEach(f => assert.equal(fs.existsSync(path.join(dir, 'logs', f + '.jsonl')), !!files[f], f));
    assert.ok(fs.existsSync(path.join(dir, 'logs', 'อื่นๆ.txt')), 'ไฟล์อื่นไม่ถูกลบ');
    await s.stop();
  });
});

/* ---------- พนักงานรายคนและบทบาท ---------- */
// เข้าสู่ระบบด้วย PIN แล้วได้ "เครื่อง" ของคนนั้น เรียก API ด้วย cookie ของตัวเอง
// แต่ละเครื่องมี IP ของตัวเอง (เหมือนแท็บเล็ตคนละเครื่อง) ไม่ชนลิมิตเข้าสู่ระบบ 6 ครั้ง/นาที/IP
let deviceIp = 0;
async function device(s, pin) {
  const ip = '127.0.5.' + (1 + (deviceIp++ % 250));
  const login = await new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify({ pin }));
    const req = require('node:http').request(s.B + '/api/login', { method: 'POST', localAddress: ip, agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } }, res => {
      let t = ''; res.on('data', c => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(t), sc: res.headers['set-cookie'] }));
    });
    req.on('error', reject); req.end(data);
  });
  const d = { status: login.status, me: login.json.me, cookie: login.sc ? login.sc[0].split(';')[0] : '' };
  d.call = async (method, p, body) => {
    const rr = await fetch(s.B + p, { method, headers: Object.assign({ cookie: d.cookie }, body !== undefined ? { 'content-type': 'application/json' } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await rr.text(); let j = null; try { j = JSON.parse(t); } catch (e) { /* ignore */ }
    return { status: rr.status, json: j };
  };
  return d;
}
async function withStaff(s) {
  const add = async (name, role, pin) => (await s.call('POST', '/api/staff', { name, role, pin })).json.staff;
  return { cashier: await add('สมใจ', 'cashier', '520011'), kitchen: await add('ช่างต้ม', 'kitchen', '520022') };
}

describe('พนักงานรายคนและบทบาท', () => {
  test('เจ้าของเพิ่มแคชเชียร์และครัว แต่ละคนเข้าสู่ระบบด้วย PIN ของตัวเอง และ log บอกชื่อคนที่ทำ', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const st0 = (await s.call('GET', '/api/state')).json;
    assert.deepEqual(st0.me, { id: 'owner', name: 'เจ้าของร้าน', role: 'owner' }, 'STAFF_PIN เดิมคือบัญชีเจ้าของร้าน');
    const { cashier } = await withStaff(s);
    const c = await device(s, '520011');
    assert.equal(c.status, 200);
    assert.deepEqual(c.me, { id: cashier.id, name: 'สมใจ', role: 'cashier' });
    const keys = st0.keys;
    const o = await c.call('POST', '/api/order', { table: 4, items: [{ id: 1, qty: 1 }] });
    assert.equal(o.status, 200, 'แคชเชียร์สั่งแทนลูกค้าได้');
    await c.call('POST', '/api/ticket/void', { id: o.json.tickets[0], reason: 'ลูกค้าเปลี่ยนใจ' });
    const v = readLog(s.dir, 'audit').find(e => e.action === 'ticket.voided');
    assert.deepEqual([v.staff, v.name, v.role], [cashier.id, 'สมใจ', 'cashier'], 'log บอกว่าใครยกเลิก');
    assert.ok(readLog(s.dir, 'security').some(e => e.action === 'auth.login' && e.name === 'สมใจ'));
    assert.equal((await device(s, '999999')).status, 401);
    assert.ok(keys[1]);
    await s.stop();
  });

  test('สิทธิ์ตามบทบาท ตรวจทุก endpoint อัตโนมัติ (endpoint ที่ไม่ได้ประกาศสิทธิ์ = เจ้าของเท่านั้น)', async () => {
    const { api, PERM } = require('../lib/routes');
    const PUBLIC = ['POST /api/login', 'POST /api/logout', 'GET /api/menu', 'GET /api/table', 'POST /api/order', 'POST /api/call', 'GET /api/brand'];
    const s = start(makeApp()); await s.ready; await s.login();
    await withStaff(s);
    const who = { cashier: await device(s, '520011'), kitchen: await device(s, '520022') };
    const wrong = [];
    for (const k of Object.keys(api).filter(x => !PUBLIC.includes(x)).concat(['GET /api/events'])) {
      const [method, p] = k.split(' ');
      for (const role of ['cashier', 'kitchen']) {
        const r = await fetch(s.B + p + '?id=1&name=x&month=2024-01', { method, headers: Object.assign({ cookie: who[role].cookie }, method === 'POST' ? { 'content-type': 'application/json' } : {}), body: method === 'POST' ? '{}' : undefined });
        await r.body?.cancel();
        const allowed = (PERM[k] || ['owner']).includes(role);
        if (allowed ? (r.status === 401 || r.status === 403) : r.status !== 403) wrong.push(role + ' ' + k + ' → ' + r.status + (allowed ? ' (ควรทำได้)' : ' (ควรได้ 403)'));
      }
    }
    assert.deepEqual(wrong, []);
    const ks = (await who.kitchen.call('GET', '/api/state')).json;
    assert.deepEqual(ks.keys, {}, 'จอครัวไม่ได้รหัส QR ของโต๊ะ');
    assert.ok(Object.keys((await who.cashier.call('GET', '/api/state')).json.keys).length > 0, 'แคชเชียร์ได้รหัส QR ไว้สั่งแทนลูกค้า');
    assert.ok(readLog(s.dir, 'security').some(e => e.action === 'auth.forbidden' && e.role === 'kitchen'), 'บันทึกการพยายามทำเกินสิทธิ์');
    await s.stop();
  });

  test('แก้ราคาเมนูและตั้งเมนูหมด: log บอกชื่อคนที่ทำ ไม่ถูกชื่อเมนูทับ', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    await s.call('POST', '/api/staff', { name: 'ผู้จัดการแดง', role: 'owner', pin: '560011' });
    const m = await device(s, '560011');
    assert.equal((await m.call('POST', '/api/menu/item', { id: 1, name: 'ผัดกะเพราหมูสับ', price: 70, cat: 1, station: 'hot' })).status, 200);
    assert.equal((await m.call('POST', '/api/soldout', { id: 1, soldOut: true })).status, 200);
    const ev = readLog(s.dir, 'audit');
    const up = ev.find(e => e.action === 'menu.item.updated'), so = ev.find(e => e.action === 'menu.soldout');
    assert.deepEqual([up.name, up.role, up.itemName, up.after.price], ['ผู้จัดการแดง', 'owner', 'ผัดกะเพราหมูสับ', 70]);
    assert.deepEqual([so.name, so.itemName], ['ผู้จัดการแดง', 'ผัดกะเพราหมูสับ']);
    await s.stop();
  });

  test('PIN เจ้าของเป็นค่าเริ่มต้น 1234: หน้าพนักงานของเจ้าของได้คำเตือน (ไม่ใช่แค่ใน console)', async () => {
    const weak = start(makeApp(), { STAFF_PIN: '1234' }); await weak.ready;
    await weak.call('POST', '/api/login', { pin: '1234' });
    assert.equal((await weak.call('GET', '/api/state')).json.weakPin, true);
    await weak.stop();
    const s = start(makeApp()); await s.ready; await s.login();
    assert.equal((await s.call('GET', '/api/state')).json.weakPin, false, 'PIN 6 หลักไม่ต้องเตือน');
    await s.stop();
  });

  test('สองเครื่องแก้เมนูเดียวกัน: เครื่องที่เปิดหน้าแก้ค้างไว้บันทึกทับราคาที่อีกเครื่องเพิ่งแก้ไม่ได้', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const m = (await s.call('GET', '/api/state')).json.menu.items.find(x => x.id === 1);
    const was = { name: m.name, price: m.price, cat: m.cat, station: m.station, desc: m.desc, hidden: m.hidden };
    // เครื่อง A และ B เปิดหน้าแก้พร้อมกัน A ขึ้นราคาก่อน
    assert.equal((await s.call('POST', '/api/menu/item', Object.assign({}, was, { id: 1, price: 75, was }))).status, 200);
    // B แก้แค่คำอธิบาย แต่ฟอร์มยังถือราคาเดิม 60
    const r = await s.call('POST', '/api/menu/item', Object.assign({}, was, { id: 1, desc: 'แก้คำอธิบาย', was }));
    assert.equal(r.status, 409, 'ต้องบอกว่ามีคนแก้ไปก่อน');
    assert.equal((await s.call('GET', '/api/menu')).json.items.find(x => x.id === 1).price, 75, 'ราคาใหม่ต้องไม่ถูกทับ');
    await s.stop();
  });

  test('ครัวสั่งอาหารแทนลูกค้าโดยไม่มีรหัส QR ไม่ได้ แต่เปลี่ยนสถานะอาหารและตั้งเมนูหมดได้', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    await withStaff(s);
    const k = await device(s, '520022');
    assert.equal((await k.call('POST', '/api/order', { table: 1, items: [{ id: 1, qty: 1 }] })).status, 403);
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const o = await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 1 }] });
    assert.equal((await k.call('POST', '/api/ticket', { id: o.json.tickets[0], from: 'new', status: 'cooking' })).status, 200);
    assert.equal((await k.call('POST', '/api/soldout', { id: 2, soldOut: true })).status, 200);
    assert.equal((await k.call('POST', '/api/ticket/void', { id: o.json.tickets[0], reason: 'ลูกค้าเปลี่ยนใจ' })).status, 403, 'ครัวยกเลิกออเดอร์เองไม่ได้');
    await s.stop();
  });

  test('เปลี่ยน PIN, เปลี่ยนบทบาท, ปิดบัญชี, สั่งออกทุกเครื่อง: เครื่องที่คนนั้นเข้าอยู่หลุดทันที', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const { cashier } = await withStaff(s);
    const ok = async d => (await d.call('GET', '/api/state')).status;
    let d = await device(s, '520011');
    await s.call('POST', '/api/staff', { id: cashier.id, name: 'สมใจ', role: 'cashier', pin: '530011' });
    assert.equal(await ok(d), 401, 'เปลี่ยน PIN แล้วเครื่องเดิมหลุด');
    assert.equal((await device(s, '520011')).status, 401, 'PIN เก่าใช้ไม่ได้');
    d = await device(s, '530011'); assert.equal(await ok(d), 200);
    await s.call('POST', '/api/staff', { id: cashier.id, name: 'สมใจ', role: 'kitchen' });
    assert.equal(await ok(d), 401, 'ลดบทบาทแล้วเครื่องเดิมหลุด (ไม่ใช้สิทธิ์เก่าค้าง)');
    d = await device(s, '530011'); assert.equal(d.me.role, 'kitchen');
    await s.call('POST', '/api/staff/logout-all', { id: cashier.id });
    assert.equal(await ok(d), 401, 'สั่งออกทุกเครื่องแล้วหลุด');
    d = await device(s, '530011');
    await s.call('POST', '/api/staff', { id: cashier.id, name: 'สมใจ', role: 'kitchen', active: false });
    assert.equal(await ok(d), 401, 'ปิดบัญชีแล้วหลุด');
    assert.equal((await device(s, '530011')).status, 401, 'ปิดบัญชีแล้วเข้าไม่ได้');
    await s.call('POST', '/api/staff', { id: cashier.id, name: 'สมใจ', role: 'kitchen', active: true });
    assert.equal((await device(s, '530011')).status, 200, 'เปิดบัญชีกลับมาเข้าได้');
    const ev = readLog(s.dir, 'audit').filter(e => e.action.startsWith('staff.'));
    assert.ok(ev.some(e => e.action === 'staff.updated' && e.pinChanged === true) && ev.some(e => e.action === 'staff.sessions_revoked'));
    assert.equal((await s.call('GET', '/api/state')).status, 200, 'เจ้าของไม่หลุดตาม');
    await s.stop();
  });

  test('PIN ต้องเป็นตัวเลข 6-8 หลัก ห้ามซ้ำคนอื่นหรือซ้ำ PIN เจ้าของ และ PIN หรือ hash ไม่หลุดทาง API หรือ log', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const add = (pin, name) => s.call('POST', '/api/staff', { name: name || 'ทดสอบ', role: 'cashier', pin });
    assert.equal((await add('12345')).status, 400);
    assert.equal((await add('12a456')).status, 400);
    assert.equal((await add(PIN)).status, 400, 'ซ้ำ PIN เจ้าของ');
    assert.equal((await add('777777', 'คนแรก')).status, 200);
    assert.equal((await add('777777', 'คนที่สอง')).status, 400, 'ซ้ำ PIN คนอื่น');
    assert.equal((await s.call('POST', '/api/staff', { name: 'ไม่มี PIN', role: 'cashier' })).status, 400);
    assert.equal((await s.call('POST', '/api/staff', { id: 'owner', name: 'x', role: 'kitchen' })).status, 400, 'แก้บัญชีเจ้าของผ่านหน้าเว็บไม่ได้');
    const list = await s.call('GET', '/api/staff');
    const text = JSON.stringify(list.json) + JSON.stringify((await s.call('GET', '/api/state')).json) + allLogText(s.dir);
    const data = JSON.parse(fs.readFileSync(path.join(s.dir, 'data.json'), 'utf8'));
    assert.ok(!text.includes('777777') && !text.includes(data.staff[0].pinHash), 'PIN หรือ hash หลุด');
    assert.ok(!fs.readFileSync(path.join(s.dir, 'data.json'), 'utf8').includes('777777'), 'data.json ไม่เก็บ PIN ตรงๆ');
    await s.stop();
  });

  test('กู้คืนข้อมูล: พนักงานในไฟล์สำรองกลับมา และเครื่องที่กดกู้คืนยังเข้าระบบอยู่', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    await withStaff(s);
    const file = (await getBackup(s, (await s.call('POST', '/api/backup', {})).json.backup.name)).buf;
    await s.call('POST', '/api/staff', { name: 'เด็กใหม่', role: 'kitchen', pin: '540033' });
    assert.equal((await restoreRaw(s, file)).status, 200);
    assert.equal((await s.call('GET', '/api/state')).status, 200, 'เจ้าของยังเข้าระบบอยู่');
    const names = (await s.call('GET', '/api/staff')).json.list.map(a => a.name);
    assert.deepEqual(names, ['เจ้าของร้าน', 'สมใจ', 'ช่างต้ม']);
    assert.equal((await device(s, '520011')).status, 200, 'PIN ของพนักงานในไฟล์สำรองใช้ได้');
    assert.equal((await device(s, '540033')).status, 401, 'คนที่เพิ่มหลังวันสำรองไม่อยู่แล้ว');
    await s.stop();
  });
});

describe('ตามเกณฑ์ตรวจรับ: สถานะออเดอร์ การยกเลิก และราคาที่ลูกค้าเห็น', () => {
  test('สถานะออเดอร์เดินหน้าได้ทีละขั้นเท่านั้น ย้อนกลับ ข้ามขั้น หรือไม่บอกสถานะเดิม ไม่ได้ ทั้งครัวและแคชเชียร์', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    await withStaff(s);
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const id = (await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 1 }] })).json.tickets[0];
    const k = await device(s, '520022'), c = await device(s, '520011');
    assert.equal((await k.call('POST', '/api/ticket', { id, from: 'new', status: 'ready' })).status, 400, 'ข้ามจากใหม่ไปพร้อมเสิร์ฟไม่ได้');
    assert.equal((await k.call('POST', '/api/ticket', { id, status: 'cooking' })).status, 400, 'ต้องบอกสถานะเดิม');
    assert.equal((await k.call('POST', '/api/ticket', { id, from: 'new', status: 'cooking' })).status, 200);
    assert.equal((await k.call('POST', '/api/ticket', { id, from: 'cooking', status: 'ready' })).status, 200);
    assert.equal((await c.call('POST', '/api/ticket', { id, from: 'ready', status: 'cooking' })).status, 400, 'ย้อนกลับไปทำใหม่ไม่ได้');
    assert.equal((await c.call('POST', '/api/ticket', { id, from: 'ready', status: 'served' })).status, 200);
    assert.equal((await s.call('POST', '/api/ticket', { id, from: 'served', status: 'new' })).status, 400, 'เจ้าของก็ย้อนไม่ได้');
    assert.equal((await s.call('GET', '/api/state')).json.tickets.find(t => t.id === id).status, 'served');
    const ev = readLog(s.dir, 'audit').filter(e => e.action === 'ticket.status');
    assert.deepEqual(ev.map(e => e.after), ['cooking', 'ready', 'served'], 'log มีเฉพาะที่เปลี่ยนจริง');
    await s.stop();
  });

  test('ยกเลิกออเดอร์ต้องมีเหตุผล ครัวเริ่มทำแล้วแคชเชียร์ต้องมี PIN เจ้าของ และ log บอกเหตุผลกับคนอนุมัติ', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    await withStaff(s);
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const order = async () => (await s.call('POST', '/api/order', { table: 2, key: keys[2], items: [{ id: 1, qty: 2 }] })).json.tickets[0];
    const c = await device(s, '520011');
    const a = await order(), b = await order(), d = await order();
    assert.equal((await c.call('POST', '/api/ticket/void', { id: a })).status, 400, 'ไม่มีเหตุผล');
    assert.equal((await c.call('POST', '/api/ticket/void', { id: a, reason: ' ' })).status, 400, 'เหตุผลว่าง');
    assert.equal((await c.call('POST', '/api/ticket/void', { id: a, reason: 'สั่งผิด หรือกดซ้ำ' })).status, 200, 'ครัวยังไม่ทำ แคชเชียร์ยกเลิกเองได้');
    await s.call('POST', '/api/ticket', { id: b, from: 'new', status: 'cooking' });
    let r = await c.call('POST', '/api/ticket/void', { id: b, reason: 'ลูกค้าเปลี่ยนใจ' });
    assert.deepEqual([r.status, r.json.code], [403, 'need_approval'], 'ครัวทำแล้ว ต้องให้เจ้าของอนุมัติ');
    r = await c.call('POST', '/api/ticket/void', { id: b, reason: 'ลูกค้าเปลี่ยนใจ', approvePin: '520011' });
    assert.equal(r.status, 403, 'PIN แคชเชียร์เองอนุมัติไม่ได้');
    r = await c.call('POST', '/api/ticket/void', { id: b, reason: 'ลูกค้าเปลี่ยนใจ', approvePin: PIN });
    assert.equal(r.status, 200);
    await s.call('POST', '/api/ticket', { id: d, from: 'new', status: 'cooking' });
    assert.equal((await s.call('POST', '/api/ticket/void', { id: d, reason: 'ของหมด' })).status, 200, 'เจ้าของยกเลิกเองได้เลย');
    const ev = readLog(s.dir, 'audit').filter(e => e.action === 'ticket.voided');
    assert.deepEqual(ev.map(e => e.reason), ['สั่งผิด หรือกดซ้ำ', 'ลูกค้าเปลี่ยนใจ', 'ของหมด']);
    assert.deepEqual([ev[1].name, ev[1].approvedBy.id, ev[1].value], ['สมใจ', 'owner', 120], 'บอกทั้งคนกดและคนอนุมัติ');
    assert.equal(ev[0].approvedBy, undefined);
    assert.ok(readLog(s.dir, 'security').some(e => e.action === 'approve.failed'), 'PIN อนุมัติผิดถูกบันทึก');
    assert.ok(!allLogText(s.dir).includes(PIN), 'PIN ไม่อยู่ใน log');
    await s.stop();
  });

  test('ราคาเปลี่ยนระหว่างลูกค้าดูเมนู: ไม่รับออเดอร์ด้วยยอดใหม่เงียบๆ แต่ตอบ 409 ให้ลูกค้าเห็นยอดใหม่ก่อน', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    await s.call('POST', '/api/menu/item', item({ id: 1, name: 'ผัดกะเพราหมูสับ', price: 75, cat: 1, station: 'hot' }));
    let r = await s.guest('POST', '/api/order', { table: 3, key: keys[3], items: [{ id: 1, qty: 2 }], expect: 120, reqId: 'aa11bb22cc33' });
    assert.deepEqual([r.status, r.json.code], [409, 'price_changed']);
    assert.equal((await s.call('GET', '/api/state')).json.tickets.length, 0, 'ไม่มีออเดอร์เข้าครัว');
    r = await s.guest('POST', '/api/order', { table: 3, key: keys[3], items: [{ id: 1, qty: 2 }], expect: 150, reqId: 'aa11bb22cc33' });
    assert.equal(r.status, 200, 'ยอดตรงกับที่เห็น สั่งได้ (reqId เดิมใช้ต่อได้ เพราะครั้งก่อนไม่ถูกบันทึก)');
    assert.equal((await s.guest('POST', '/api/order', { table: 3, key: keys[3], items: [{ id: 1, qty: 1 }] })).status, 200, 'หน้าเก่าที่ไม่ส่ง expect ยังสั่งได้');
    await s.stop();
  });
});

describe('ธีมร้าน: สีปุ่มและโลโก้', () => {
  const logoUp = (s, buf, type, cookie) => fetch(s.B + '/api/settings/logo', { method: 'POST', headers: { 'content-type': type || 'image/jpeg', cookie: cookie === undefined ? s.cookie : cookie }, body: buf })
    .then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));

  test('สีที่เจ้าของเลือก: ระบบคำนวณสีตัวหนังสือให้ผ่าน WCAG AA ทุกสีตัวอย่าง ทั้ง light และ dark', () => {
    const T = require('../lib/theme');
    for (const p of T.PRESETS.filter(x => x.color).concat([{ color: '#ffff00' }, { color: '#000000' }, { color: '#84cc16' }])) {
      const d = T.derive(p.color);
      assert.ok(d.ok, p.color);
      for (const [m, bgs] of [['light', ['#ffffff', '#f8fafc']], ['dark', ['#111827', '#0b0f17']]]) {
        const v = d[m];
        assert.ok(T.contrast(v.accent, v['accent-ink']) >= 4.5, p.color + ' ' + m + ' ตัวหนังสือบนปุ่ม');
        for (const bg of bgs.concat(v['accent-soft'])) assert.ok(T.contrast(v['accent-text'], bg) >= 4.5, p.color + ' ' + m + ' ตัวหนังสือสีเน้นบน ' + bg);
        for (const bg of bgs) assert.ok(T.contrast(v.focus, bg) >= 3, p.color + ' ' + m + ' กรอบโฟกัส');
      }
    }
    assert.equal(T.derive('#ffffff').ok, false, 'สีขาวกลืนกับพื้น ไม่รับ');
    assert.equal(T.derive('red').ok, false);
    assert.ok(!T.css('').includes('--accent'), 'ไม่ตั้งสี = ใช้สีตั้งต้นในหน้า');
  });

  test('ตั้งสีปุ่ม: เจ้าของเท่านั้น สีผิดรูปแบบหรือขาวเกินไม่รับ /theme.css เปลี่ยนตาม และลง audit', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    await withStaff(s);
    const c = await device(s, '520011');
    assert.equal((await c.call('POST', '/api/settings', { accent: '#dc2626' })).status, 403);
    assert.equal((await s.call('POST', '/api/settings', { accent: 'red;}body{display:none' })).status, 400);
    assert.equal((await s.call('POST', '/api/settings', { accent: '#fafafa' })).status, 400);
    assert.equal((await s.call('POST', '/api/settings', { accent: '#DC2626' })).status, 200);
    let css = await (await fetch(s.B + '/theme.css')).text();
    assert.match(css, /--accent:#dc2626/);
    assert.match(css, /prefers-color-scheme:dark/);
    assert.equal((await s.call('GET', '/api/state')).json.settings.accent, '#dc2626');
    const p = await s.call('GET', '/api/theme/preview?accent=%23ea580c');
    assert.ok(p.json.ok && p.json.light['accent-ink'] && p.json.presets.length >= 6);
    assert.equal((await c.call('GET', '/api/theme/preview?accent=%23ea580c')).status, 403);
    assert.equal((await s.call('POST', '/api/settings', { accent: '' })).status, 200);
    css = await (await fetch(s.B + '/theme.css')).text();
    assert.ok(!css.includes('--accent'), 'กลับเป็นสีตั้งต้น');
    const ev = readLog(s.dir, 'audit').filter(e => e.action === 'settings.changed' && e.after && 'accent' in e.after);
    assert.deepEqual(ev.map(e => e.after.accent), ['#dc2626', '']);
    await s.stop();
  });

  test('โลโก้: อัปโหลดตรวจจาก magic bytes, แสดงในหน้าเข้าสู่ระบบ/หน้าลูกค้า, เปลี่ยนแล้วไฟล์เก่าถูกลบ, อยู่ในไฟล์สำรอง', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    await withStaff(s);
    const c = await device(s, '520011');
    assert.equal((await logoUp(s, JPG, 'image/jpeg', c.cookie)).status, 403, 'แคชเชียร์เปลี่ยนโลโก้ไม่ได้');
    assert.equal((await logoUp(s, JPG, 'image/jpeg', '')).status, 401);
    assert.equal((await logoUp(s, Buffer.from('<svg onload=alert(1)>'), 'image/png')).status, 400, 'ไม่ใช่รูปจริง');
    const v0 = (await s.guest('GET', '/api/menu')).json.version;
    const a = await logoUp(s, JPG);
    assert.equal(a.status, 200);
    assert.match(a.json.logo, /^logo-[a-f0-9]{8}\.jpg$/);
    assert.equal((await s.guest('GET', '/api/brand')).json.logo, a.json.logo, 'หน้าเข้าสู่ระบบเห็นโลโก้โดยไม่ต้องเข้าสู่ระบบ');
    const m = (await s.guest('GET', '/api/menu')).json;
    assert.equal(m.logo, a.json.logo);
    assert.ok(m.version > v0, 'หน้าลูกค้ารู้ว่าต้องโหลดใหม่');
    assert.equal((await fetch(s.B + '/img/' + a.json.logo)).status, 200);
    const b = await logoUp(s, JPG);
    assert.ok(!fs.existsSync(path.join(s.dir, 'images', a.json.logo)), 'โลโก้เก่าถูกลบ');
    const bk = (await s.call('POST', '/api/backup', {})).json.backup;
    assert.ok((await getBackup(s, bk.name)).json.images[b.json.logo], 'โลโก้อยู่ในไฟล์สำรอง');
    assert.equal((await s.call('POST', '/api/settings/logo/delete', {})).status, 200);
    assert.equal((await s.guest('GET', '/api/brand')).json.logo, '');
    assert.equal((await restoreRaw(s, (await getBackup(s, bk.name)).buf)).status, 200);
    assert.equal((await s.guest('GET', '/api/brand')).json.logo, b.json.logo, 'กู้คืนแล้วโลโก้กลับมา');
    assert.equal((await fetch(s.B + '/img/' + b.json.logo)).status, 200);
    const ev = readLog(s.dir, 'audit').map(e => e.action);
    assert.ok(ev.includes('settings.logo.updated') && ev.includes('settings.logo.removed'));
    await s.stop();
  });

  test('data.json ที่มีสีหรือชื่อไฟล์โลโก้แปลกปลอม ถูกล้างเป็นค่าตั้งต้น ไม่หลุดไปใน CSS หรือ path', async () => {
    const dir = makeApp();
    let s = start(dir); await s.ready; await s.stop();
    const f = path.join(dir, 'data.json'), d = JSON.parse(fs.readFileSync(f, 'utf8'));
    d.settings.accent = '#fff;}*{display:none}'; d.settings.logo = '../data.json';
    d.menu.items[0].image = 'logo-0123abcd.png';
    fs.writeFileSync(f, JSON.stringify(d));
    s = start(dir); await s.ready; await s.login();
    const st2 = (await s.call('GET', '/api/state')).json;
    assert.deepEqual([st2.settings.accent, st2.settings.logo, st2.menu.items[0].image], ['', '', '']);
    assert.ok(!(await (await fetch(s.B + '/theme.css')).text()).includes('display'));
    await s.stop();
  });
});

describe('จาก security review: เดา PIN เจ้าของผ่านหน้าต่างอนุมัติ', () => {
  test('PIN อนุมัติยกเลิกออเดอร์ผิด นับรวมเพดาน 30 ครั้ง/นาทีทุก IP เหมือนหน้าเข้าสู่ระบบ (แคชเชียร์ตั้ง IP เองหลายเครื่องก็เดาต่อไม่ได้)', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    await withStaff(s);
    const c = await device(s, '520011');
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const id = (await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 1 }] })).json.tickets[0];
    await s.call('POST', '/api/ticket', { id, from: 'new', status: 'cooking' });
    const tryPin = (ip, pin) => new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify({ id, reason: 'ลูกค้าเปลี่ยนใจ', approvePin: pin }));
      const req = require('node:http').request(s.B + '/api/ticket/void', { method: 'POST', localAddress: ip, agent: false, headers: { cookie: c.cookie, 'content-type': 'application/json', 'content-length': data.length } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end(data);
    });
    const codes = [];
    for (let i = 0; i < 40; i++) codes.push(await tryPin('127.0.6.' + (1 + Math.floor(i / 5)), String(100000 + i)));   // 8 เครื่อง เครื่องละ 5 ครั้ง (ไม่ติดลิมิตต่อ IP)
    const wrong = codes.filter(x => x === 403).length;
    assert.ok(wrong <= 30, 'เดาผิดได้ไม่เกิน 30 ครั้งต่อนาทีรวมทุก IP (ได้ ' + wrong + ')');
    assert.equal(codes[codes.length - 1], 429, 'ครั้งท้ายๆ ถูกพัก');
    assert.equal(await tryPin('127.0.6.200', PIN), 429, 'ระหว่างพัก PIN ถูกก็ใช้ไม่ได้ (ไม่อย่างนั้นใช้ผลพักเป็นตัวบอกว่าเดาถูก)');
    assert.ok((await s.call('GET', '/api/state')).json.tickets.some(t => t.id === id), 'ออเดอร์ยังอยู่');
    await s.stop();
  });
});

describe('กันออเดอร์ปลอมและการแกล้ง', () => {
  const hhmm = m => { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
  const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

  test('พนักงานบทบาทเจ้าของ (ไม่ใช่ STAFF_PIN) ใส่ PIN อนุมัติยกเลิกออเดอร์ได้', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    await withStaff(s);
    await s.call('POST', '/api/staff', { name: 'หุ้นส่วน', role: 'owner', pin: '730001' });
    const c = await device(s, '520011');
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const id = (await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 1 }] })).json.tickets[0];
    await s.call('POST', '/api/ticket', { id, from: 'new', status: 'cooking' });
    const r = await c.call('POST', '/api/ticket/void', { id, reason: 'ลูกค้าเปลี่ยนใจ', approvePin: '730001' });
    assert.equal(r.status, 200, 'PIN ของหุ้นส่วนที่เป็นเจ้าของอนุมัติได้');
    assert.equal(readLog(s.dir, 'audit').find(e => e.action === 'ticket.voided').approvedBy.name, 'หุ้นส่วน');
    await s.stop();
  });

  test('ต้องเปิดโต๊ะก่อนสั่ง: QR โต๊ะว่างสั่งไม่ได้ เรียกพนักงานได้ เปิดโต๊ะแล้วสั่งได้ ปิดบิลแล้วโต๊ะปิดเอง', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    await withStaff(s);
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const order = t => s.guest('POST', '/api/order', { table: t, key: keys[t], items: [{ id: 1, qty: 1 }] });
    assert.equal((await order(2)).status, 200, 'โต๊ะ 2 มีลูกค้าก่อนเปิดใช้โหมดนี้');
    assert.equal((await s.call('POST', '/api/settings', { requireSeat: true })).status, 200);
    let r = await order(1);
    assert.deepEqual([r.status, r.json.code], [403, 'seat'], 'โต๊ะว่างที่ยังไม่เปิด สั่งผ่าน QR ไม่ได้');
    let tb = (await s.guest('GET', '/api/table?t=1&k=' + keys[1])).json;
    assert.deepEqual([tb.open, tb.closedReason, tb.seated], [false, 'seat', false]);
    assert.match(tb.closedText, /เรียกพนักงาน/);
    assert.equal((await s.guest('POST', '/api/call', { table: 1, key: keys[1], kind: 'staff' })).status, 200, 'ยังเรียกพนักงานมาเปิดโต๊ะได้');
    assert.equal((await order(2)).status, 200, 'โต๊ะที่มีออเดอร์อยู่แล้วสั่งเพิ่มได้ ไม่ต้องเปิดใหม่');
    assert.equal((await s.call('POST', '/api/order', { table: 3, items: [{ id: 1, qty: 1 }] })).status, 200, 'พนักงานสั่งแทนได้เสมอ');
    const k = await device(s, '520022');
    assert.equal((await k.call('POST', '/api/table/seat', { table: 1, open: true })).status, 403, 'ครัวเปิดโต๊ะไม่ได้');
    const c = await device(s, '520011');
    assert.equal((await c.call('POST', '/api/table/seat', { table: 1, open: true })).status, 200, 'แคชเชียร์เปิดโต๊ะ');
    assert.equal((await order(1)).status, 200, 'เปิดแล้วลูกค้าสั่งได้');
    assert.equal((await c.call('POST', '/api/table/seat', { table: 1, open: false })).status, 409, 'ปิดโต๊ะที่ยังมีออเดอร์ไม่ได้');
    assert.equal((await s.call('POST', '/api/settings', { tables: 1 })).status, 400, 'ลดโต๊ะที่เปิดอยู่ไม่ได้');
    await payTable(s, 1);
    r = await order(1);
    assert.equal(r.status, 403, 'ปิดบิลแล้วโต๊ะปิดเอง ลูกค้าคนถัดไปต้องให้พนักงานเปิดใหม่');
    assert.ok(!(await s.call('GET', '/api/state')).json.seated[1]);
    await c.call('POST', '/api/table/seat', { table: 4, open: true });
    assert.equal((await c.call('POST', '/api/table/seat', { table: 4, open: false })).status, 200, 'ปิดโต๊ะที่เปิดผิดได้');
    assert.equal((await order(4)).status, 403);
    const ev = readLog(s.dir, 'audit').map(e => e.action);
    assert.ok(ev.includes('table.seated') && ev.includes('table.unseated'));
    assert.ok(readLog(s.dir, 'security').some(e => e.action === 'order.closed' && e.reason === 'seat'), 'ความพยายามสั่งเข้าโต๊ะที่ยังไม่เปิดถูกบันทึก');
    await s.stop();
  });

  test('ปิดรับ QR ตามเวลาร้าน: นอกเวลาสั่งไม่ได้ ในเวลาและช่วงข้ามเที่ยงคืนสั่งได้ พนักงานสั่งแทนได้เสมอ', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const order = () => s.guest('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 1 }] });
    const m = nowMin();
    assert.equal((await s.call('POST', '/api/settings', { hours: { on: true, open: hhmm(m + 60), close: hhmm(m + 120) } })).status, 200);
    let r = await order();
    assert.deepEqual([r.status, r.json.code], [403, 'hours'], 'ยังไม่ถึงเวลาเปิด');
    assert.match(r.json.error, new RegExp(hhmm(m + 60)));
    const tb = (await s.guest('GET', '/api/table?t=1&k=' + keys[1])).json;
    assert.deepEqual([tb.open, tb.closedReason], [false, 'hours']);
    assert.equal((await s.call('GET', '/api/state')).json.qrClosed, 'hours', 'หน้าพนักงานรู้ว่านอกเวลา');
    assert.equal((await s.call('POST', '/api/order', { table: 1, items: [{ id: 1, qty: 1 }] })).status, 200, 'พนักงานสั่งแทนได้');
    await s.call('POST', '/api/settings', { hours: { on: true, open: hhmm(m - 60), close: hhmm(m + 60) } });
    assert.equal((await order()).status, 200, 'ในเวลาเปิด');
    await s.call('POST', '/api/settings', { hours: { on: true, open: hhmm(m - 60), close: hhmm(m - 120) } });
    assert.equal((await order()).status, 200, 'ร้านเปิดข้ามเที่ยงคืน (เวลาปิดน้อยกว่าเวลาเปิด) ตอนนี้อยู่ในช่วงเปิด');
    await s.call('POST', '/api/settings', { hours: { on: false, open: hhmm(m + 60), close: hhmm(m + 120) } });
    assert.equal((await order()).status, 200, 'ปิดการตั้งเวลา = รับตลอด');
    for (const bad of [{ on: true, open: '25:00', close: '10:00' }, { on: true, open: '10:00', close: '10:00' }, { on: 'yes', open: '10:00', close: '11:00' }, 'x'])
      assert.equal((await s.call('POST', '/api/settings', { hours: bad })).status, 400, JSON.stringify(bad));
    assert.ok(readLog(s.dir, 'audit').some(e => e.action === 'settings.changed' && e.after && e.after.hours), 'เปลี่ยนเวลาลง audit');
    await s.stop();
  });

  test('เปลี่ยนรหัส QR โต๊ะเดียว: QR เก่าโต๊ะนั้นใช้ไม่ได้ทันที โต๊ะอื่นไม่กระทบ เจ้าของเท่านั้น และไม่บันทึกรหัสใน log', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    await withStaff(s);
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const c = await device(s, '520011');
    assert.equal((await c.call('POST', '/api/table/rekey', { table: 3 })).status, 403, 'แคชเชียร์เปลี่ยนไม่ได้');
    assert.equal((await s.call('POST', '/api/table/rekey', { table: 3 })).status, 200);
    const k2 = (await s.call('GET', '/api/state')).json.keys;
    assert.notEqual(k2[3], keys[3]);
    assert.equal(k2[4], keys[4], 'โต๊ะอื่นรหัสเดิม');
    assert.equal((await s.guest('GET', '/api/table?t=3&k=' + keys[3])).status, 403, 'QR แผ่นเก่าใช้ไม่ได้');
    assert.equal((await s.guest('GET', '/api/table?t=3&k=' + k2[3])).status, 200, 'QR แผ่นใหม่ใช้ได้');
    const text = allLogText(s.dir);
    assert.ok(text.includes('table.rekeyed') && !text.includes(keys[3]) && !text.includes(k2[3]), 'log บอกว่าเปลี่ยน แต่ไม่มีตัวรหัส');
    await s.stop();
  });
});

describe('ยืนยัน PIN ซ้ำก่อนทำเรื่องสำคัญ และอายุการเข้าสู่ระบบของเจ้าของ', () => {
  test('เกิน REAUTH_SEC หลังเข้าสู่ระบบ: เปลี่ยน PromptPay จัดการพนักงาน ดาวน์โหลดไฟล์สำรอง กู้คืน เปลี่ยนรหัส QR ต้องใส่ PIN ซ้ำ', async () => {
    const s = start(makeApp(), { REAUTH_SEC: '1.5' }); await s.ready; await s.login();
    assert.equal((await s.call('POST', '/api/settings', { promptpay: '0811111111' })).status, 200, 'เพิ่งเข้าสู่ระบบ ทำได้เลย');
    const bk = (await s.call('POST', '/api/backup', {})).json.backup;
    const file = (await getBackup(s, bk.name)).buf;
    await new Promise(r => setTimeout(r, 1700));
    const need = async (r, what) => { assert.equal(r.status, 403, what); assert.equal(r.json && r.json.code, 'reauth', what); };
    await need(await s.call('POST', '/api/settings', { promptpay: '0822222222' }), 'เปลี่ยน PromptPay');
    await need(await s.call('POST', '/api/settings', { baseUrl: 'http://evil.example' }), 'เปลี่ยนที่อยู่ใน QR');
    assert.equal((await s.call('POST', '/api/settings', { shop: 'ร้านใหม่' })).status, 200, 'แก้ชื่อร้านไม่ต้องยืนยัน');
    await need(await s.call('POST', '/api/staff', { name: 'ใหม่', role: 'cashier', pin: '640001' }), 'เพิ่มพนักงาน');
    await need(await s.call('POST', '/api/staff/logout-all', { id: 'owner' }), 'สั่งออกทุกเครื่อง');
    await need(await s.call('POST', '/api/table/rekey', { table: 1 }), 'เปลี่ยนรหัส QR');
    const dl = await fetch(s.B + '/api/backup/download?name=' + bk.name, { headers: { cookie: s.cookie } });
    assert.equal(dl.status, 403, 'ดาวน์โหลดไฟล์สำรอง'); await dl.body?.cancel();
    await need(await restoreRaw(s, file), 'กู้คืน');
    assert.equal((await s.call('GET', '/api/state')).json.settings.promptpay, '0811111111', 'ไม่มีอะไรเปลี่ยน');
    assert.equal((await s.call('GET', '/api/reauth')).json.fresh, false);
    assert.equal((await s.call('POST', '/api/reauth', { pin: '000000' })).status, 400, 'PIN ผิด');
    assert.equal((await s.call('POST', '/api/reauth', { pin: PIN })).status, 200);
    assert.equal((await s.call('GET', '/api/reauth')).json.fresh, true);
    assert.equal((await s.call('POST', '/api/settings', { promptpay: '0822222222' })).status, 200, 'ยืนยันแล้วทำได้');
    assert.equal((await restoreRaw(s, file)).status, 200, 'กู้คืนได้');
    assert.equal((await s.call('POST', '/api/settings', { promptpay: '0833333333' })).status, 200, 'หลังกู้คืนได้ cookie ใหม่ที่ยืนยันแล้วต่อ');
    const sec = readLog(s.dir, 'security').map(e => e.action);
    assert.ok(sec.includes('auth.reauth') && sec.includes('auth.reauth_failed'));
    assert.ok(!allLogText(s.dir).includes(PIN));
    await s.stop();
  });

  test('การยืนยัน PIN ผูกกับเครื่อง: เครื่องหนึ่งยืนยันแล้ว cookie ของอีกเครื่อง (หรือที่ถูกขโมย) ยังต้องยืนยันเอง', async () => {
    const s = start(makeApp(), { REAUTH_SEC: '1.5' }); await s.ready;
    const a = await device(s, PIN), b = await device(s, PIN);
    assert.notEqual(a.cookie, b.cookie, 'แต่ละเครื่องได้ cookie ไม่ซ้ำกัน');
    await new Promise(r => setTimeout(r, 1700));
    assert.equal((await a.call('POST', '/api/reauth', { pin: PIN })).status, 200);
    assert.equal((await a.call('POST', '/api/settings', { promptpay: '0811111111' })).status, 200);
    assert.equal((await b.call('POST', '/api/settings', { promptpay: '0899999999' })).status, 403, 'อีกเครื่องยังต้องยืนยันเอง');
    await s.stop();
  });

  test('เจ้าของหมดอายุการเข้าสู่ระบบตาม OWNER_SESSION_MIN แต่แคชเชียร์ยังอยู่ cookie แบบเดิมของเจ้าของใช้ไม่ได้ ของแคชเชียร์ยังใช้ได้', async () => {
    const s = start(makeApp(), { OWNER_SESSION_MIN: '0.03' }); await s.ready; await s.login();
    await withStaff(s);
    const c = await device(s, '520011');
    await new Promise(r => setTimeout(r, 2200));
    assert.equal((await s.call('GET', '/api/state')).status, 401, 'เจ้าของหมดอายุ ต้องเข้าสู่ระบบใหม่');
    assert.equal((await c.call('GET', '/api/state')).status, 200, 'แคชเชียร์ไม่หมดอายุ');
    // cookie แบบเดิม <id>.<ลายเซ็น> (ก่อนเวอร์ชันนี้)
    const D = JSON.parse(fs.readFileSync(path.join(s.dir, 'data.json'), 'utf8'));
    const h = x => require('node:crypto').createHmac('sha256', D.secret).update(x).digest('hex');
    const cs = D.staff.find(x => x.id === c.me.id);
    const legacy = (id, ver, ph) => 'st=' + id + '.' + h('sess|' + id + '|' + ver + '|' + ph);
    const get = ck => fetch(s.B + '/api/state', { headers: { cookie: ck } }).then(async r => { await r.body?.cancel(); return r.status; });
    assert.equal(await get(legacy(cs.id, cs.ver, cs.pinHash)), 200, 'cookie แบบเดิมของแคชเชียร์ยังใช้ได้ (แท็บเล็ตครัวไม่หลุดตอนอัปเดต)');
    assert.equal(await get(legacy('owner', D.ownerVer || 0, h('pin:' + PIN))), 401, 'cookie แบบเดิมของเจ้าของไม่มีวันหมดอายุ จึงไม่รับ');
    await s.stop();
  });
});

describe('ภาพพื้นหลังหน้าลูกค้าและเมนูขายดี', () => {
  const up = (s, buf, type, cookie, kind) => fetch(s.B + '/api/settings/' + (kind || 'cover'), { method: 'POST', headers: { 'content-type': type || 'image/jpeg', cookie: cookie === undefined ? s.cookie : cookie }, body: buf })
    .then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));

  test('ภาพพื้นหลัง: เจ้าของเท่านั้น ตรวจ magic bytes แสดงในเมนูและหน้าเข้าสู่ระบบ เปลี่ยนแล้วไฟล์เก่าถูกลบ อยู่ในไฟล์สำรอง', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    await withStaff(s);
    const c = await device(s, '520011');
    assert.equal((await up(s, JPG, 'image/jpeg', c.cookie)).status, 403, 'แคชเชียร์เปลี่ยนไม่ได้');
    assert.equal((await up(s, JPG, 'image/jpeg', '')).status, 401);
    assert.equal((await up(s, Buffer.from('<svg/>'), 'image/png')).status, 400, 'ไม่ใช่รูปจริง');
    const v0 = (await s.guest('GET', '/api/menu')).json.version;
    const a = await up(s, JPG);
    assert.equal(a.status, 200);
    assert.match(a.json.cover, /^cover-[a-f0-9]{8}\.jpg$/);
    const m = (await s.guest('GET', '/api/menu')).json;
    assert.equal(m.cover, a.json.cover);
    assert.ok(m.version > v0, 'หน้าลูกค้าที่เปิดอยู่รู้ว่าต้องโหลดใหม่');
    assert.equal((await s.guest('GET', '/api/brand')).json.cover, a.json.cover, 'หน้าเข้าสู่ระบบใช้ภาพเดียวกัน');
    assert.equal((await fetch(s.B + '/img/' + a.json.cover)).status, 200);
    const b = await up(s, JPG);
    assert.ok(!fs.existsSync(path.join(s.dir, 'images', a.json.cover)), 'ภาพเก่าถูกลบ');
    assert.equal((await up(s, JPG, 'image/jpeg', undefined, 'logo')).status, 200);
    const st = (await s.call('GET', '/api/state')).json.settings;
    assert.ok(st.cover === b.json.cover && st.logo, 'ภาพพื้นหลังกับโลโก้แยกกัน ไม่ทับกัน');
    const bk = (await s.call('POST', '/api/backup', {})).json.backup;
    assert.ok((await getBackup(s, bk.name)).json.images[b.json.cover], 'ภาพพื้นหลังอยู่ในไฟล์สำรอง');
    assert.equal((await s.call('POST', '/api/settings/cover/delete', {})).status, 200);
    assert.equal((await s.guest('GET', '/api/menu')).json.cover, '');
    assert.ok(!fs.existsSync(path.join(s.dir, 'images', b.json.cover)));
    const ev = readLog(s.dir, 'audit').map(e => e.action);
    assert.ok(ev.includes('settings.cover.updated') && ev.includes('settings.cover.removed'));
    await s.stop();
  });

  test('ชื่อไฟล์ภาพพื้นหลังแปลกปลอมใน data.json ถูกล้าง และรูปเมนูอ้างไฟล์ภาพพื้นหลังไม่ได้', async () => {
    const dir = makeApp();
    let s = start(dir); await s.ready; await s.stop();
    const f = path.join(dir, 'data.json'), d = JSON.parse(fs.readFileSync(f, 'utf8'));
    d.settings.cover = '../data.json'; d.menu.items[0].image = 'cover-0123abcd.jpg';
    fs.writeFileSync(f, JSON.stringify(d));
    s = start(dir); await s.ready;
    const m = (await s.guest('GET', '/api/menu')).json;
    assert.deepEqual([m.cover, m.items[0].image], ['', '']);
    await s.stop();
  });

  test('เมนูขายดี: 3 เมนูที่ขายมากสุดใน 7 วันจากบิลจริง (อย่างน้อย 3 จาน) ไม่มีบิลก็ไม่มีป้าย', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    assert.deepEqual((await s.guest('GET', '/api/menu')).json.popular, [], 'ยังไม่มียอดขาย ไม่มีป้ายขายดี');
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const sell = async (t, items) => { await s.call('POST', '/api/order', { table: t, key: keys[t], items }); await payTable(s, t); };
    await sell(1, [{ id: 3, qty: 5 }, { id: 1, qty: 4 }, { id: 2, qty: 2 }]);
    await sell(2, [{ id: 4, qty: 3 }, { id: 2, qty: 2 }, { id: 5, qty: 2 }]);
    const pop = (await s.guest('GET', '/api/menu')).json.popular;
    assert.deepEqual(pop, [3, 1, 2], 'เรียงตามจำนวนจาน (2 = 4 จานรวมสองบิล), เมนู 5 ขายแค่ 2 จาน ไม่ได้ป้าย');
    await s.stop();
  });
});


describe('หน้าลูกค้าแบบใหม่: ลิงก์โซเชียลมีเดีย แชร์ร้าน คำโปรย โทนสี เมนูแนะนำ', () => {
  test('ลิงก์โซเชียลมีเดีย: รับชื่อบัญชีหรือลิงก์ ตรวจโดเมน ไม่รับ javascript: เจ้าของเท่านั้น ลูกค้าเห็นใน /api/menu และ audit', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    await withStaff(s);
    const c = await device(s, '520011');
    assert.equal((await c.call('POST', '/api/settings', { social: { facebook: 'https://facebook.com/x' } })).status, 403, 'แคชเชียร์แก้ไม่ได้');
    const bad = async (body, what) => { const r = await s.call('POST', '/api/settings', body); assert.equal(r.status, 400, what); assert.ok(r.json.error, what); };
    await bad({ social: { facebook: 'javascript:alert(1)' } }, 'javascript:');
    await bad({ social: { facebook: 'https://evil.example/facebook.com' } }, 'โดเมนอื่น');
    await bad({ social: { facebook: 'https://facebook.com.evil.example/x' } }, 'โดเมนปลอมต่อท้าย');
    await bad({ social: { instagram: 'http://instagram.com/x' } }, 'http ไม่รับสำหรับโซเชียลมีเดีย');
    await bad({ social: { line: '@มี ช่องว่าง' } }, 'ชื่อบัญชีผิดรูปแบบ');
    await bad({ shareUrl: 'ftp://x.example/a' }, 'ลิงก์แชร์ต้อง http(s)');
    await bad({ social: 'x' }, 'social ต้องเป็น object');
    const v0 = (await s.guest('GET', '/api/menu')).json.version;
    const ok = await s.call('POST', '/api/settings', { social: { facebook: 'facebook.com/kruapadaeng', instagram: '@krua.pa', line: '@kruapa', tiktok: 'kruapa' }, shareUrl: 'https://maps.app.goo.gl/abc', tagline: 'อาหารไทยต้นตำรับ' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const m = (await s.guest('GET', '/api/menu')).json;
    assert.deepEqual(m.social, { facebook: 'https://facebook.com/kruapadaeng', instagram: 'https://www.instagram.com/krua.pa/', line: 'https://line.me/R/ti/p/@kruapa', tiktok: 'https://www.tiktok.com/@kruapa' });
    assert.equal(m.shareUrl, 'https://maps.app.goo.gl/abc');
    assert.equal(m.tagline, 'อาหารไทยต้นตำรับ');
    assert.ok(m.version > v0, 'หน้าลูกค้าที่เปิดอยู่โหลดข้อมูลร้านใหม่เอง');
    assert.equal((await s.call('POST', '/api/settings', { social: { tiktok: '' } })).status, 200, 'ส่งเฉพาะช่องที่แก้ได้ ว่าง = เอาออก');
    const m2 = (await s.guest('GET', '/api/menu')).json.social;
    assert.ok(m2.tiktok === '' && m2.facebook, 'ช่องอื่นไม่หาย');
    const ev = readLog(s.dir, 'audit').filter(e => e.action === 'settings.changed' && e.after && e.after.social);
    assert.ok(ev.length >= 2 && ev[0].after.social.facebook === 'https://facebook.com/kruapadaeng');
    await s.stop();
  });

  test('เปลี่ยนลิงก์โซเชียลมีเดีย/แชร์ = พาลูกค้าไปที่อื่น ต้องใส่ PIN ซ้ำ (แก้คำโปรย/โทนสีไม่ต้อง)', async () => {
    const s = start(makeApp(), { REAUTH_SEC: '1.5' }); await s.ready; await s.login();
    await new Promise(r => setTimeout(r, 1700));
    const need = async (r, what) => { assert.equal(r.status, 403, what); assert.equal(r.json && r.json.code, 'reauth', what); };
    await need(await s.call('POST', '/api/settings', { social: { line: '@evil' } }), 'เปลี่ยน LINE');
    await need(await s.call('POST', '/api/settings', { shareUrl: 'https://evil.example' }), 'เปลี่ยนลิงก์แชร์');
    assert.equal((await s.call('POST', '/api/settings', { tagline: 'ใหม่', look: 'light', social: { line: '' }, shareUrl: '' })).status, 200, 'ค่าเดิม (ว่าง) ส่งซ้ำได้ ไม่ต้องยืนยัน');
    const st = (await s.call('GET', '/api/state')).json.settings;
    assert.deepEqual([st.tagline, st.look, st.social.line, st.shareUrl], ['ใหม่', 'light', '', '']);
    await s.stop();
  });

  test('ตั้งค่าผิดช่องหนึ่ง = ไม่มีอะไรเปลี่ยนเลย (เดิมชื่อร้านที่แก้มาด้วยเปลี่ยนในหน่วยความจำ ไม่มี audit)', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const before = (await s.call('GET', '/api/state')).json.settings;
    assert.equal((await s.call('POST', '/api/settings', { shop: 'ชื่อใหม่', address: 'ที่อยู่ใหม่', promptpay: '123' })).status, 400);
    assert.equal((await s.call('POST', '/api/settings', { shop: 'ชื่อใหม่', look: 'neon' })).status, 400);
    assert.equal((await s.call('POST', '/api/settings', { tagline: 'x', social: { facebook: 'https://x.example' } })).status, 400);
    await s.call('POST', '/api/settings', { svc: before.svc });     // บันทึกครั้งถัดไป (ถ้าค่าค้างในหน่วยความจำจะถูกเขียนลงดิสก์ตอนนี้)
    const after = (await s.call('GET', '/api/state')).json.settings;
    assert.deepEqual([after.shop, after.address, after.look, after.tagline], [before.shop, before.address, before.look, before.tagline]);
    assert.equal(readLog(s.dir, 'audit').filter(e => e.action === 'settings.changed').length, 0);
    await s.stop();
  });

  test('โทนสีหน้าลูกค้า: ค่าเริ่มต้นมืด /theme.css มีสีร้านสำหรับ data-look ทั้งมืดและสว่าง หน้าพนักงานยังตามเครื่อง', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    assert.equal((await s.guest('GET', '/api/menu')).json.look, 'dark');
    await s.call('POST', '/api/settings', { accent: '#1d4ed8' });
    const css = await (await fetch(s.B + '/theme.css')).text();
    assert.match(css, /:root\[data-look=dark\]\{--accent:/);
    assert.match(css, /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-look=light\]\)\{--accent:/);
    const html = await (await fetch(s.B + '/order?t=1&k=x')).text();
    assert.match(html, /<meta name="referrer" content="no-referrer">/, 'ลิงก์ออกไปเว็บอื่นไม่ส่งที่อยู่หน้า (มีรหัส QR)');
    await s.stop();
  });

  test('เมนูแนะนำ: เจ้าของตั้งได้ ลูกค้าเห็น rec, was ไม่ตรง (อีกเครื่องแก้ไปแล้ว) ได้ 409, ไฟล์เก่าที่ไม่มี rec = ไม่แนะนำ', async () => {
    const dir = makeApp();
    let s = start(dir); await s.ready; await s.login();
    const m = (await s.call('GET', '/api/state')).json.menu.items[0];
    assert.equal(m.rec, false);
    const base = { id: m.id, name: m.name, price: m.price, cat: m.cat, station: m.station, desc: m.desc };
    assert.equal((await s.call('POST', '/api/menu/item', Object.assign({ rec: true }, base))).status, 200);
    assert.equal((await s.guest('GET', '/api/menu')).json.items.find(i => i.id === m.id).rec, true);
    const stale = await s.call('POST', '/api/menu/item', Object.assign({ rec: false, was: { name: m.name, price: m.price, rec: false } }, base));
    assert.equal(stale.status, 409, 'อีกเครื่องเปิดแนะนำไปแล้ว');
    await s.stop();
    const f = path.join(dir, 'data.json'), d = JSON.parse(fs.readFileSync(f, 'utf8'));
    d.menu.items.forEach(i => { delete i.rec; }); d.menu.items[1].rec = 'yes';
    d.settings.social = { facebook: 'javascript:alert(1)', line: 'https://line.me/R/ti/p/@ok' }; d.settings.shareUrl = 'data:text/html,x'; d.settings.look = 'neon';
    fs.writeFileSync(f, JSON.stringify(d));
    s = start(dir); await s.ready;
    const g = (await s.guest('GET', '/api/menu')).json;
    assert.ok(g.items.every(i => i.rec === false), 'rec ที่ไม่ใช่ true = ไม่แนะนำ');
    assert.deepEqual([g.social.facebook, g.social.line, g.shareUrl, g.look], ['', 'https://line.me/R/ti/p/@ok', '', 'dark'], 'ลิงก์อันตรายจากไฟล์ถูกล้าง');
    await s.stop();
  });
});

describe('รูป QR รับเงินที่ร้านอัปโหลด (แทน QR จากเบอร์ PromptPay)', () => {
  test('เจ้าของเท่านั้น + ใส่ PIN ซ้ำ ตรวจว่าเป็นรูปจริง เปลี่ยนแล้วไฟล์เก่าถูกลบ อยู่ในไฟล์สำรอง audit ไม่ทำให้หน้าลูกค้าโหลดใหม่', async () => {
    const dir = makeApp();
    let s = start(dir, { REAUTH_SEC: '2' }); await s.ready; await s.login();
    await withStaff(s);
    const c = await device(s, '520011');
    const up = (cookie, buf, type) => fetch(s.B + '/api/settings/payqr', { method: 'POST', headers: { 'content-type': type || 'image/jpeg', cookie }, body: buf })
      .then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
    assert.equal((await up(c.cookie, JPG)).status, 403, 'แคชเชียร์เปลี่ยนรูป QR รับเงินไม่ได้');
    assert.equal((await up('', JPG)).status, 401);
    assert.equal((await up(s.cookie, Buffer.from('<svg/>'), 'image/png')).status, 400, 'ไม่ใช่รูปจริง');
    const v0 = (await s.guest('GET', '/api/menu')).json.version;
    const a = await up(s.cookie, JPG);
    assert.equal(a.status, 200);
    assert.match(a.json.payqr, /^payqr-[a-f0-9]{8}\.jpg$/);
    assert.equal((await s.call('GET', '/api/state')).json.settings.payQr, a.json.payqr, 'หน้าพนักงานได้ชื่อไฟล์ไปแสดงบนใบแจ้งยอด');
    const m = (await s.guest('GET', '/api/menu')).json;
    assert.equal(m.version, v0, 'หน้าลูกค้าไม่ต้องโหลดเมนูใหม่');
    assert.ok(!('payQr' in m), 'หน้าลูกค้าไม่ได้ใช้รูปนี้');
    assert.equal((await fetch(s.B + '/img/' + a.json.payqr)).status, 200);
    const b = await up(s.cookie, JPG);
    assert.ok(!fs.existsSync(path.join(s.dir, 'images', a.json.payqr)), 'รูปเก่าถูกลบ');
    const bk = (await s.call('POST', '/api/backup', {})).json.backup;
    assert.ok((await getBackup(s, bk.name)).json.images[b.json.payqr], 'รูป QR รับเงินอยู่ในไฟล์สำรอง');
    await new Promise(r => setTimeout(r, 2200));
    const r1 = await up(s.cookie, JPG);
    assert.equal(r1.status, 403); assert.equal(r1.json.code, 'reauth', 'หมดเวลายืนยัน: เปลี่ยนรูปต้องใส่ PIN ซ้ำ');
    const r2 = await s.call('POST', '/api/settings/payqr/delete', {});
    assert.equal(r2.status, 403); assert.equal(r2.json.code, 'reauth', 'เลิกใช้รูปก็ต้องใส่ PIN ซ้ำ (เงินกลับไปเข้าเบอร์ PromptPay)');
    assert.equal((await s.call('GET', '/api/state')).json.settings.payQr, b.json.payqr, 'ไม่มีอะไรเปลี่ยน');
    assert.equal((await s.call('POST', '/api/reauth', { pin: PIN })).status, 200);
    assert.equal((await s.call('POST', '/api/settings/payqr/delete', {})).status, 200);
    assert.equal((await s.call('GET', '/api/state')).json.settings.payQr, '');
    assert.ok(!fs.existsSync(path.join(s.dir, 'images', b.json.payqr)));
    const ev = readLog(s.dir, 'audit').map(e => e.action);
    assert.equal(ev.filter(x => x === 'settings.payqr.updated').length, 2);
    assert.ok(ev.includes('settings.payqr.removed'));
    await s.stop();
    // ชื่อไฟล์แปลกปลอมใน data.json ถูกล้าง
    const f = path.join(dir, 'data.json'), d = JSON.parse(fs.readFileSync(f, 'utf8'));
    d.settings.payQr = '../data.json'; fs.writeFileSync(f, JSON.stringify(d));
    s = start(dir); await s.ready; await s.login();
    assert.equal((await s.call('GET', '/api/state')).json.settings.payQr, '');
    await s.stop();
  });
});

describe('บทบาทพนักงานเสิร์ฟ: ดูแลโต๊ะได้ ไม่แตะเงิน', () => {
  test('สั่งแทนลูกค้า รับทราบการเรียก เปิดโต๊ะ เสิร์ฟได้ · รับเงิน ยกเลิกออเดอร์ สรุปยอด CSV ตั้งค่าไม่ได้ (ตรวจทุก endpoint)', async () => {
    const { api, PERM } = require('../lib/routes');
    const s = start(makeApp()); await s.ready; await s.login();
    const add = await s.call('POST', '/api/staff', { name: 'น้องเอ', role: 'waiter', pin: '520033' });
    assert.equal(add.status, 200, JSON.stringify(add.json));
    const w = await device(s, '520033');
    assert.equal(w.me.role, 'waiter');
    assert.equal((await s.call('GET', '/api/staff')).json.roles.waiter, 'พนักงานเสิร์ฟ');
    // ทุก endpoint: ทำได้เฉพาะที่ PERM ให้พนักงานเสิร์ฟ
    const PUBLIC = ['POST /api/login', 'POST /api/logout', 'GET /api/menu', 'GET /api/table', 'POST /api/order', 'POST /api/call', 'GET /api/brand'];
    const wrong = [];
    for (const k of Object.keys(api).filter(x => !PUBLIC.includes(x)).concat(['GET /api/events'])) {
      const [method, p] = k.split(' ');
      const r = await fetch(s.B + p + '?id=1&name=x&month=2024-01', { method, headers: Object.assign({ cookie: w.cookie }, method === 'POST' ? { 'content-type': 'application/json' } : {}), body: method === 'POST' ? '{}' : undefined });
      await r.body?.cancel();
      const allowed = (PERM[k] || ['owner']).includes('waiter');
      if (allowed ? (r.status === 401 || r.status === 403) : r.status !== 403) wrong.push(k + ' → ' + r.status + (allowed ? ' (ควรทำได้)' : ' (ควรได้ 403)'));
    }
    assert.deepEqual(wrong, []);
    for (const k of ['POST /api/pay', 'POST /api/ticket/void', 'GET /api/report', 'GET /api/export.csv', 'POST /api/settings', 'GET /api/audit', 'POST /api/backup']) {
      assert.ok(!(PERM[k] || ['owner']).includes('waiter'), k + ' ต้องไม่ใช่สิทธิ์พนักงานเสิร์ฟ');
    }
    // ร้านปิดรับ QR อยู่ ลูกค้าสั่งเองไม่ได้ แต่พนักงานเสิร์ฟสั่งแทนได้ (ไม่ต้องมีรหัส QR)
    await s.call('POST', '/api/settings', { acceptOrders: false });
    const o = await w.call('POST', '/api/order', { table: 3, items: [{ id: 1, qty: 2 }] });
    assert.equal(o.status, 200, JSON.stringify(o.json));
    const tk = (await s.call('GET', '/api/state')).json.tickets.find(k => k.table === 3);
    assert.equal(tk.by, 'staff', 'ออเดอร์บันทึกว่าพนักงานสั่ง');
    const t = await w.call('GET', '/api/table?t=3');
    assert.equal(t.status, 200); assert.equal(t.json.staff, true, 'เปิดหน้าลูกค้าในโหมดพนักงานได้');
    // ลูกค้าเรียก → พนักงานเสิร์ฟเห็นและรับทราบได้
    const keys = (await s.call('GET', '/api/state')).json.keys;
    await s.guest('POST', '/api/call', { table: 5, key: keys[5], kind: 'staff' });
    const ws = (await w.call('GET', '/api/state')).json;
    assert.equal(ws.calls[5].kind, 'staff');
    assert.ok(!('sales' in ws) && !('report' in ws), 'state ไม่มียอดขาย');
    assert.deepEqual(ws.keys, {}, 'ไม่ได้รหัส QR ของโต๊ะ (สั่งแทนด้วย cookie พนักงาน ปิดบัญชีแล้วไม่มีรหัสติดตัวไปสั่งเข้าโต๊ะได้)');
    assert.equal((await w.call('GET', '/api/table?t=3&k=')).status, 200, 'เปิดหน้าโต๊ะในโหมดพนักงานได้โดยไม่มีรหัส');
    assert.equal((await w.call('POST', '/api/call/clear', { table: 5 })).status, 200);
    assert.equal((await w.call('POST', '/api/table/seat', { table: 6, open: true })).status, 200);
    assert.equal((await w.call('POST', '/api/ticket', { id: tk.id, from: 'new', status: 'cooking' })).status, 200);
    // เรื่องเงิน: ไม่ได้
    const sub = (await s.call('GET', '/api/state')).json.bills[3].sub;
    assert.equal((await w.call('POST', '/api/pay', { table: 3, expectedSub: sub, method: 'cash' })).status, 403);
    assert.equal((await w.call('POST', '/api/ticket/void', { id: tk.id, reason: 'ลูกค้าเปลี่ยนใจ' })).status, 403);
    assert.equal((await w.call('GET', '/api/report')).status, 403);
    assert.ok((await s.call('GET', '/api/state')).json.tickets.some(k => k.id === tk.id), 'ออเดอร์ยังอยู่ บิลยังไม่ถูกปิด');
    // ครัวยังสั่งแทนลูกค้าไม่ได้เหมือนเดิม
    const kc = await (async () => { await s.call('POST', '/api/staff', { name: 'ครัว', role: 'kitchen', pin: '520022' }); return device(s, '520022'); })();
    assert.equal((await kc.call('POST', '/api/order', { table: 4, items: [{ id: 1, qty: 1 }] })).status, 403);
    await s.stop();
  });
});

describe('กู้คืนไฟล์สำรองที่รูปของร้านหายไป', () => {
  test('ไฟล์สำรองอ้างถึงรูป QR รับเงิน โลโก้ ภาพพื้นหลัง แต่ไม่มีไฟล์ติดมา: ล้างทิ้ง ใบแจ้งยอดกลับไปใช้ QR จากเบอร์ (ไม่แสดงรูปเสีย)', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const up = (kind) => fetch(s.B + '/api/settings/' + kind, { method: 'POST', headers: { 'content-type': 'image/jpeg', cookie: s.cookie }, body: JPG }).then(r => r.json());
    const q = await up('payqr'), l = await up('logo'), c = await up('cover');
    const bk = (await s.call('POST', '/api/backup', {})).json.backup;
    const data = (await getBackup(s, bk.name)).json;
    delete data.images[q.payqr]; delete data.images[l.logo]; delete data.images[c.cover];
    const r = await restoreRaw(s, Buffer.from(JSON.stringify(data)), 'application/json');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await s.login();
    const st = (await s.call('GET', '/api/state')).json.settings;
    assert.deepEqual([st.payQr, st.logo, st.cover], ['', '', '']);
    await s.stop();
  });
});


describe('หลายประเภทธุรกิจ: ขายหน้าร้าน ขายตามน้ำหนัก ราคาส่ง รับซื้อ และคิว', () => {
  const sales = dir => { try { return fs.readdirSync(path.join(dir, 'sales')).flatMap(f => fs.readFileSync(path.join(dir, 'sales', f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))); } catch (e) { return []; } };
  const counterOn = (s, extra) => s.call('POST', '/api/settings', { modes: Object.assign({ counter: true }, extra || {}) });
  const sell = (s, body) => s.call('POST', '/api/sale', Object.assign({ method: 'cash' }, body));

  test('ร้านเดิมที่ยังไม่เลือกประเภทธุรกิจ: ทำงานแบบร้านอาหารเหมือนเดิม ยังไม่มีขายหน้าร้าน', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const st = (await s.call('GET', '/api/state')).json;
    assert.equal(st.settings.biz, '');
    assert.deepEqual(st.settings.modes, { table: true, kitchen: true, counter: false, buy: false, stock: false, docs: false });
    assert.equal(st.biz.terms.item, 'เมนู');
    assert.equal(st.biz.terms.kitchen, 'ครัว');
    const r = await sell(s, { items: [{ id: 1, qty: 1 }], expectedSub: 60 });
    assert.equal(r.status, 409, 'ยังไม่เปิดขายหน้าร้าน');
    assert.equal(sales(s.dir).length, 0);
    const list = (await s.call('GET', '/api/biz')).json.list;
    assert.equal(list.length, 14);
    ['cafe', 'retail', 'wholesale', 'fresh', 'restaurant', 'hardware', 'salon', 'stationery', 'bubbletea', 'bakery', 'fashion', 'pharmacy', 'online', 'buyback']
      .forEach(k => assert.ok(list.some(p => p.key === k), 'มีประเภท ' + k));
    await s.stop();
  });

  test('เลือกประเภทธุรกิจและโหมด: ตรวจค่า เลิกใช้โต๊ะที่ยังมีบิลไม่ได้ (ไม่มีอะไรเปลี่ยน) QR โต๊ะสั่งไม่ได้เมื่อเลิกใช้โต๊ะ และลง audit', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    assert.equal((await s.call('POST', '/api/settings', { biz: 'casino' })).status, 400);
    assert.equal((await s.call('POST', '/api/settings', { modes: { table: false, counter: false } })).status, 400, 'ต้องมีทางขายอย่างน้อยหนึ่งทาง');
    assert.equal((await s.call('POST', '/api/settings', { modes: { buy: true } })).status, 400, 'รับซื้อต้องใช้หน้าขายหน้าร้าน');
    assert.equal((await s.call('POST', '/api/settings', { modes: { table: 'no' } })).status, 400);
    await s.guest('POST', '/api/order', { table: 3, key: keys[3], items: [{ id: 1, qty: 1 }] });
    const busy = await s.call('POST', '/api/settings', { shop: 'ร้านใหม่', biz: 'retail', modes: { table: false, kitchen: false, counter: true } });
    assert.equal(busy.status, 400);
    assert.match(busy.json.error, /โต๊ะ 3/);
    let st = (await s.call('GET', '/api/state')).json;
    assert.deepEqual([st.settings.shop, st.settings.biz, st.settings.modes.table], ['ร้านของฉัน', '', true], 'ผิดแล้วไม่มีอะไรเปลี่ยน');
    await payTable(s, 3);
    const v0 = st.menu.version;
    assert.equal((await s.call('POST', '/api/settings', { biz: 'retail', modes: { table: false, kitchen: false, counter: true } })).status, 200);
    st = (await s.call('GET', '/api/state')).json;
    assert.equal(st.biz.key, 'retail');
    assert.equal(st.biz.terms.item, 'สินค้า');
    assert.ok(st.menu.version > v0, 'หน้าลูกค้าเห็นว่าต้องโหลดใหม่');
    const o = await s.guest('POST', '/api/order', { table: 4, key: keys[4], items: [{ id: 1, qty: 1 }] });
    assert.equal(o.status, 403);
    assert.equal(o.json.code, 'off');
    assert.equal((await s.guest('GET', '/api/table?t=4&k=' + keys[4])).json.open, false);
    assert.equal((await s.guest('GET', '/api/menu')).json.terms.food, 'สินค้า');
    const a = readLog(s.dir, 'audit').filter(e => e.action === 'settings.changed').pop();
    assert.equal(a.after.biz, 'retail');
    assert.equal(a.after.modes.counter, true);
    await s.stop();
  });

  test('โหลดสินค้าตัวอย่าง: แทนที่เมนูทั้งหมด id ไม่ใช้ซ้ำ รูปเดิมถูกลบ เจ้าของเท่านั้น และลง audit', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const up = await upload(s, 1, JPG);
    const imgFile = path.join(s.dir, 'images', up.json.image);
    assert.ok(fs.existsSync(imgFile));
    await s.call('POST', '/api/soldout', { id: 2, soldOut: true });
    const before = (await s.call('GET', '/api/state')).json.menu;
    const maxId = Math.max(...before.items.map(i => i.id));
    await withStaff(s);
    const c = await device(s, '520011');
    assert.equal((await c.call('POST', '/api/biz/sample', { biz: 'fresh' })).status, 403);
    assert.equal((await s.call('POST', '/api/biz/sample', { biz: 'nope' })).status, 400);
    const r = await s.call('POST', '/api/biz/sample', { biz: 'fresh' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const st = (await s.call('GET', '/api/state')).json;
    assert.equal(st.menu.items.length, r.json.items);
    assert.ok(st.menu.items.every(i => i.id > maxId), 'id ใหม่ไม่ซ้ำกับเมนูที่เคยมี');
    assert.ok(st.menu.items.some(i => i.dec && i.unit === 'กก.'), 'ของสดขายตามน้ำหนัก');
    assert.ok(st.menu.version > before.version);
    assert.deepEqual(st.settings.soldOut, []);
    assert.ok(!fs.existsSync(imgFile), 'รูปของเมนูเดิมถูกลบ');
    const a = readLog(s.dir, 'audit').find(e => e.action === 'menu.sample_loaded');
    assert.deepEqual([a.biz, a.before.items, a.after.items], ['fresh', before.items.length, r.json.items]);
    // สำรองเมนูเดิมไว้ก่อนแทนที่ กู้คืนแล้วเมนูเดิมกลับมา
    assert.match(r.json.safetyBackup, /before-sample/);
    const bk = await getBackup(s, r.json.safetyBackup);
    assert.equal(bk.json.data.menu.items.length, before.items.length);
    assert.ok(bk.json.images[up.json.image], 'รูปเมนูเดิมอยู่ในไฟล์สำรอง');
    await s.stop();
  });

  test('ขายหน้าร้าน: ราคามาจากเซิร์ฟเวอร์ ค่าบริการ/VAT สูตรเดิม ยอดไม่ตรงได้ 409 ส่งซ้ำด้วย reqId เดิมไม่ขายซ้ำ ลงยอดขาย สรุปยอด และ CSV', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    assert.equal((await counterOn(s)).status, 200);
    // ลูกค้าเห็น/พนักงานเห็นยอดเก่า: ไม่ขายด้วยยอดใหม่เงียบๆ
    const bad = await sell(s, { items: [{ id: 1, qty: 2, price: 1 }, { id: 15, qty: 1 }], expectedSub: 2 });
    assert.equal(bad.status, 409);
    assert.equal(bad.json.code, 'price_changed');
    assert.equal(sales(s.dir).length, 0);
    const body = { items: [{ id: 1, qty: 2, price: 1 }, { id: 15, qty: 1 }], expectedSub: 160, svc: true, vat: true, received: 200, reqId: 'a1b2c3d4e5f60718', memo: 'กลับบ้าน\n\u0007' };
    const ok = await sell(s, body);
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.deepEqual([ok.json.sale.sub, ok.json.sale.svc, ok.json.sale.vat, ok.json.sale.total], [160, 16, 12, 188]);   // 10% ของ 160, 7% ของ 176 = 12.32
    assert.equal(ok.json.change, 12);
    assert.equal(ok.json.sale.table, 0);
    assert.equal(ok.json.sale.memo, 'กลับบ้าน');
    const again = await sell(s, body);
    assert.deepEqual(again.json, ok.json, 'กดซ้ำได้ผลเดิม');
    assert.equal(sales(s.dir).length, 1, 'ไม่ขายซ้ำ');
    assert.equal((await sell(s, { items: [{ id: 1, qty: 1 }], expectedSub: 60, received: 50 })).status, 400, 'เงินที่รับมาไม่พอ');
    assert.equal((await sell(s, { items: [{ id: 1, qty: 1.5 }], expectedSub: 90 })).status, 400, 'สินค้าที่ไม่ได้ขายตามน้ำหนักต้องเป็นจำนวนเต็ม');
    assert.equal((await sell(s, { items: [{ id: 1, qty: 0 }], expectedSub: 0 })).status, 400);
    assert.equal((await sell(s, { items: [], expectedSub: 0 })).status, 400);
    await s.call('POST', '/api/soldout', { id: 3, soldOut: true });
    assert.equal((await sell(s, { items: [{ id: 3, qty: 1 }], expectedSub: 90 })).status, 400, 'ของหมดขายไม่ได้');
    const it = (await s.call('POST', '/api/menu/item', item({ hidden: true }))).json.item;
    assert.equal((await sell(s, { items: [{ id: it.id, qty: 1 }], expectedSub: 45 })).status, 400, 'สินค้าที่ซ่อนขายไม่ได้');
    // ลงสรุปยอดและ CSV
    const rep = (await s.call('GET', '/api/report')).json;
    assert.equal(rep.count, 1);
    assert.equal(rep.total, 188);
    assert.equal(rep.cash, 188);
    assert.equal(rep.bills[0].no, ok.json.sale.no);
    const row = (await s.call('GET', '/api/export.csv')).text.split('\r\n')[1];
    assert.match(row, /"หน้าร้าน"/);
    assert.match(row, /"ขาย","กลับบ้าน","0","ผัดกะเพราหมูสับ x2; ชาไทยเย็น x1"$/);
    const a = readLog(s.dir, 'audit').find(e => e.action === 'sale.created');
    assert.deepEqual([a.no, a.total, a.received, a.change, a.staff], [ok.json.sale.no, 188, 200, 12, 'owner']);
    assert.ok(readLog(s.dir, 'audit').some(e => e.action === 'sale.rejected' && e.expectedSub === 2 && e.actualSub === 160));
    // แคชเชียร์ขายได้ พนักงานเสิร์ฟ/ครัวไม่ได้ (เงิน)
    await withStaff(s);
    await s.call('POST', '/api/staff', { name: 'น้องเอ', role: 'waiter', pin: '520033' });
    const c = await device(s, '520011'), w = await device(s, '520033'), k = await device(s, '520022');
    assert.equal((await c.call('POST', '/api/sale', { items: [{ id: 15, qty: 1 }], expectedSub: 40, method: 'transfer' })).status, 200);
    assert.equal((await w.call('POST', '/api/sale', { items: [{ id: 15, qty: 1 }], expectedSub: 40 })).status, 403);
    assert.equal((await k.call('POST', '/api/sale', { items: [{ id: 15, qty: 1 }], expectedSub: 40 })).status, 403);
    await s.stop();
  });

  test('ขายตามน้ำหนักและราคาส่ง: จำนวนทศนิยม 3 ตำแหน่ง ปัดเป็นสตางค์ต่อแถว ราคาส่งทั้งบิล และยังอยู่ครบหลังเปิดระบบใหม่', async () => {
    const dir = makeApp();
    let s = start(dir); await s.ready; await s.login();
    await counterOn(s);
    const pork = (await s.call('POST', '/api/menu/item', item({ name: 'หมูสับ', price: 89, unit: 'กก.', dec: true }))).json.item;
    const cement = (await s.call('POST', '/api/menu/item', item({ name: 'ปูนซีเมนต์', price: 155, price2: 145, unit: 'ถุง', sku: '6001' }))).json.item;
    assert.deepEqual([pork.dec, pork.unit, cement.price2, cement.sku], [true, 'กก.', 145, '6001']);
    // หมูสับสองแถว 0.35 + 0.333 = 0.683 กก. × 89 = 60.787 → 60.79 · ปูนราคาส่ง 2 × 145 = 290
    const r = await sell(s, { items: [{ id: pork.id, qty: 0.35 }, { id: pork.id, qty: 0.333 }, { id: cement.id, qty: 2 }], level: 'wholesale', expectedSub: 350.79 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.sale.level, 'wholesale');
    assert.deepEqual(r.json.sale.items, [{ name: 'หมูสับ', qty: 0.683, price: 89, unit: 'กก.' }, { name: 'ปูนซีเมนต์', qty: 2, price: 145, unit: 'ถุง' }]);
    const retail = await sell(s, { items: [{ id: cement.id, qty: 2 }], expectedSub: 310 });
    assert.equal(retail.status, 200, 'ไม่เลือกราคาส่ง = ราคาปลีก');
    assert.equal((await sell(s, { items: [{ id: pork.id, qty: 0.0004 }], expectedSub: 0 })).status, 400);
    assert.equal((await sell(s, { items: [{ id: pork.id, qty: 'abc' }], expectedSub: 0 })).status, 400);
    assert.match((await s.call('GET', '/api/export.csv')).text, /หมูสับ x0\.683 กก\.; ปูนซีเมนต์ x2 ถุง/);
    await s.stop();
    s = start(dir); await s.ready; await s.login();
    const top = (await s.call('GET', '/api/report')).json.top;
    assert.deepEqual(top.find(x => x.name === 'หมูสับ'), { name: 'หมูสับ', qty: 0.683 }, 'จำนวนทศนิยมไม่ถูกตัดทิ้งตอนเปิดระบบใหม่');
    assert.equal(sales(dir).length, 2);
    await s.stop();
  });

  test('สินค้า: รหัสสินค้าห้ามซ้ำ ตัวอักษรแปลกไม่รับ หน้าจอรุ่นเก่าที่ไม่ส่งช่องใหม่ไม่ล้างค่าเดิม และ was ครอบช่องใหม่', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const a = (await s.call('POST', '/api/menu/item', item({ name: 'สมุด', sku: 'NB-01', unit: 'เล่ม', price2: 12 }))).json.item;
    const dup = await s.call('POST', '/api/menu/item', item({ name: 'สมุดอีกแบบ', sku: 'nb-01' }));
    assert.equal(dup.status, 400);
    assert.match(dup.json.error, /สมุด/);
    assert.equal((await s.call('POST', '/api/menu/item', item({ sku: '<b>' }))).status, 400);
    assert.equal((await s.call('POST', '/api/menu/item', item({ price2: -1 }))).status, 400);
    // หน้าจอรุ่นก่อน (ไม่รู้จัก sku/unit/dec/price2) แก้ราคา: ช่องใหม่ต้องอยู่ครบ
    const old = await s.call('POST', '/api/menu/item', { id: a.id, name: 'สมุด', price: 20, cat: 1, station: 'hot', desc: '' });
    assert.equal(old.status, 200);
    assert.deepEqual([old.json.item.sku, old.json.item.unit, old.json.item.price2, old.json.item.price], ['NB-01', 'เล่ม', 12, 20]);
    const stale = await s.call('POST', '/api/menu/item', item({ id: a.id, name: 'สมุด', price: 20, sku: 'NB-02', was: { sku: 'NB-00' } }));
    assert.equal(stale.status, 409, 'อีกเครื่องเปลี่ยนรหัสสินค้าไปแล้ว');
    assert.equal((await s.call('POST', '/api/menu/item', item({ id: a.id, name: 'สมุด', price: 20, sku: 'NB-02', price2: '', was: { sku: 'NB-01' } }))).json.item.price2, 0, 'เว้นว่าง = ไม่มีราคาส่ง');
    await s.stop();
  });

  test('รับซื้อของ: ร้านจ่ายเงินให้ลูกค้า ไม่มีค่าบริการ/VAT ยอดแยกจากยอดขาย ไม่นับเป็นเมนูขายดี', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    await counterOn(s);
    assert.equal((await sell(s, { kind: 'buy', items: [{ id: 1, qty: 1 }], expectedSub: 60 })).status, 409, 'ยังไม่เปิดโหมดรับซื้อ');
    await counterOn(s, { buy: true });
    await s.call('POST', '/api/soldout', { id: 1, soldOut: true });
    const b = await sell(s, { kind: 'buy', items: [{ id: 1, qty: 5 }], expectedSub: 300, svc: true, vat: true, received: 1000 });
    assert.equal(b.status, 200, JSON.stringify(b.json));
    assert.deepEqual([b.json.sale.kind, b.json.sale.svc, b.json.sale.vat, b.json.sale.total, b.json.change], ['buy', 0, 0, 300, null]);
    await sell(s, { items: [{ id: 15, qty: 2 }], expectedSub: 80, method: 'transfer' });
    const rep = (await s.call('GET', '/api/report')).json;
    assert.deepEqual([rep.count, rep.total, rep.cash, rep.transfer], [1, 80, 0, 80], 'ยอดขายไม่รวมรับซื้อ');
    assert.deepEqual(rep.buy, { count: 1, total: 300, cash: 300, transfer: 0 });
    assert.ok(!rep.top.some(x => x.name === 'ผัดกะเพราหมูสับ'));
    assert.equal(rep.days[6].total, 80);
    assert.ok(!(await s.guest('GET', '/api/menu')).json.popular.includes(1), 'ของที่รับซื้อไม่ใช่เมนูขายดี');
    assert.match((await s.call('GET', '/api/export.csv')).text, /"รับซื้อ"/);
    await s.stop();
  });

  test('ส่งเข้าจอครัว/บาร์เป็นคิว: เลขคิวต่อเนื่อง ไม่อยู่ในบิลโต๊ะ ยกเลิกจากจอไม่ได้ ลูกค้ารับแล้วหายจากจอ เลิกใช้จอไม่ได้ถ้าคิวค้าง', async () => {
    const dir = makeApp();
    let s = start(dir); await s.ready; await s.login();
    await counterOn(s, { kitchen: true });
    const r1 = await sell(s, { items: [{ id: 1, qty: 1, note: ['ไม่เผ็ด', 'แปลกๆ'] }, { id: 15, qty: 1 }], expectedSub: 100, kitchen: true, memo: 'คุณเอ' });
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    assert.equal(r1.json.queue, 1);
    const r2 = await sell(s, { items: [{ id: 16, qty: 1 }], expectedSub: 50, kitchen: true });
    assert.equal(r2.json.queue, 2);
    const r3 = await sell(s, { items: [{ id: 16, qty: 1 }], expectedSub: 50 });
    assert.equal(r3.json.queue, null, 'ไม่ได้เลือกส่งเข้าจอ = ไม่มีคิว');
    let st = (await s.call('GET', '/api/state')).json;
    const q1 = st.tickets.filter(k => k.q === 1);
    assert.deepEqual(q1.map(k => [k.table, k.station]).sort(), [[0, 'bar'], [0, 'hot']], 'แยกตั๋วตามจุดทำ');
    assert.deepEqual(q1.find(k => k.station === 'hot').items[0].note, ['ไม่เผ็ด'], 'หมายเหตุผ่านเฉพาะที่ร้านกำหนด');
    assert.equal(q1[0].memo, 'คุณเอ');
    assert.deepEqual(st.bills, {}, 'คิวจ่ายแล้ว ไม่มีบิลค้าง');
    const rep = (await s.call('GET', '/api/report')).json;
    assert.deepEqual([rep.pending, rep.openTables, rep.count], [0, 0, 3]);
    assert.equal((await s.call('POST', '/api/ticket/void', { id: q1[0].id, reason: 'ลูกค้าเปลี่ยนใจ' })).status, 409, 'คิวที่จ่ายแล้วยกเลิกจากจอไม่ได้');
    const off = await s.call('POST', '/api/settings', { modes: { kitchen: false } });
    assert.equal(off.status, 400);
    assert.match(off.json.error, /คิว 1, 2/);
    // เปิดระบบใหม่: คิวยังอยู่
    await s.stop();
    s = start(dir); await s.ready; await s.login();
    st = (await s.call('GET', '/api/state')).json;
    assert.equal(st.tickets.filter(k => k.table === 0).length, 3);
    for (const k of st.tickets.filter(x => x.table === 0)) {
      for (const [from, to] of [['new', 'cooking'], ['cooking', 'ready'], ['ready', 'served']]) {
        assert.equal((await s.call('POST', '/api/ticket', { id: k.id, from, status: to })).status, 200);
      }
    }
    st = (await s.call('GET', '/api/state')).json;
    assert.equal(st.tickets.length, 0, 'ลูกค้ารับแล้ว ตั๋วหายจากจอ');
    assert.equal((await s.call('POST', '/api/settings', { modes: { kitchen: false } })).status, 200);
    assert.equal((await sell(s, { items: [{ id: 16, qty: 1 }], expectedSub: 50, kitchen: true })).json.queue, null, 'ไม่ใช้จอครัว = ไม่ส่งคิว');
    assert.ok(readLog(dir, 'audit').some(e => e.action === 'ticket.status' && e.queue === 1 && e.after === 'served'));
    await s.stop();
  });

  test('data.json ที่ประเภทธุรกิจ โหมด คิว หรือสินค้าผิดรูป: ระบบเปิดได้ ค่าผิดถูกซ่อมเป็นค่าตั้งต้น', async () => {
    const dir = makeApp();
    let s = start(dir); await s.ready; await s.stop();
    const D = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
    D.settings.biz = '<script>';
    D.settings.modes = { table: false, counter: false, kitchen: 'yes' };
    D.queue = { day: 'x', n: -3 };
    D.tickets = [{ id: 1, table: 0, station: 'hot', status: 'new', createdAt: 1, items: [{ id: 1, name: 'x', price: 1, qty: 1 }] },
      { id: 2, table: 0, q: 4, station: 'hot', status: 'new', createdAt: 1, items: [{ id: 1, name: 'x', price: 1, qty: 0.5 }] },
      { id: 3, table: 2, q: 9, station: 'hot', status: 'new', createdAt: 1, items: [{ id: 1, name: 'x', price: 1, qty: 1 }] }];
    D.sales = [{ no: 1, at: Date.now(), table: 0, sub: 10, svc: 0, vat: 0, total: 10, method: 'cash', kind: 'gift', memo: 5, items: [{ name: 'หมู', qty: 0.25, price: 40 }, { name: 'เสีย', qty: -1, price: 1 }] }];
    D.menu.items[0].sku = 123; D.menu.items[0].price2 = -5; D.menu.items[0].dec = 'true'; D.menu.items[0].unit = 'ก'.repeat(40);
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(D));
    s = start(dir); await s.ready; await s.login();
    const st = (await s.call('GET', '/api/state')).json;
    assert.equal(st.settings.biz, '');
    assert.deepEqual(st.settings.modes, { table: true, kitchen: true, counter: false, buy: false, stock: false, docs: false });
    assert.deepEqual(st.tickets.map(k => [k.id, k.q]), [[2, 4], [3, undefined]], 'คิวไม่มีเลขถูกตัดทิ้ง ตั๋วโต๊ะไม่มีเลขคิว');
    const m = st.menu.items[0];
    assert.deepEqual([m.sku, m.price2, m.dec, m.unit.length], ['', 0, false, 12]);
    const rep = (await s.call('GET', '/api/report')).json;
    assert.equal(rep.bills[0].kind, undefined);
    assert.deepEqual(rep.bills[0].items, [{ name: 'หมู', qty: 0.25, price: 40 }]);
    assert.equal(rep.bills[0].memo, undefined);
    await s.stop();
  });
});

describe('สต็อกสินค้าและเอกสาร (ใบเสนอราคา ใบแจ้งหนี้ ใบสั่งซื้อ ใบรับสินค้า ใบเบิก ใบตรวจนับ)', () => {
  const Y = new Date().getFullYear();
  const journal = (dir, kind) => { try { return fs.readdirSync(path.join(dir, 'journal')).filter(f => f.startsWith(kind + '-')).flatMap(f => fs.readFileSync(path.join(dir, 'journal', f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))); } catch (e) { return []; } };
  const item = async (s, id) => (await s.call('GET', '/api/state')).json.menu.items.find(i => i.id === id);
  const on = (s, modes) => s.call('POST', '/api/settings', { modes: Object.assign({ counter: true, stock: true, docs: true }, modes || {}) });

  test('สต็อก: ตรวจนับเริ่มนับ ขายหน้าร้าน/ปิดบิลโต๊ะตัด รับซื้อเพิ่ม บัตรสต็อกมียอดคงเหลือทุกครั้ง หน้าลูกค้าเห็นหมดเมื่อสต็อกหมด', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    assert.equal((await s.call('POST', '/api/stock/adjust', { mode: 'count', lines: [{ id: 1, qty: 5 }] })).status, 409, 'ยังไม่เปิดสต็อก');
    await on(s, { buy: true });
    const c = await s.call('POST', '/api/stock/adjust', { mode: 'count', reason: 'ยอดเริ่มต้น', lines: [{ id: 1, qty: 5 }] });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.equal(c.json.doc.no, 'CNT' + Y + '-0001');
    assert.deepEqual([(await item(s, 1)).track, (await item(s, 1)).stock], [true, 5]);
    const stale = await s.call('POST', '/api/stock/adjust', { mode: 'count', lines: [{ id: 1, qty: 9, expect: 4 }] });
    assert.equal(stale.status, 409, 'ยอดเปลี่ยนระหว่างนับ ห้ามทับเงียบๆ');
    await s.call('POST', '/api/sale', { items: [{ id: 1, qty: 2 }], expectedSub: 120, method: 'cash' });
    assert.equal((await s.guest('POST', '/api/order', { table: 2, key: keys[2], items: [{ id: 1, qty: 4 }] })).status, 400, 'สั่งเกินสต็อกที่เหลือไม่ได้');
    await s.guest('POST', '/api/order', { table: 2, key: keys[2], items: [{ id: 1, qty: 3 }] });
    assert.equal((await item(s, 1)).stock, 3, 'สั่งที่โต๊ะยังไม่ตัด ตัดตอนปิดบิล');
    await payTable(s, 2);
    assert.equal((await item(s, 1)).stock, 0);
    assert.equal((await s.guest('POST', '/api/order', { table: 3, key: keys[3], items: [{ id: 1, qty: 1 }] })).status, 400, 'สต็อกหมด ลูกค้าสั่งผ่าน QR ไม่ได้');
    assert.ok((await s.guest('GET', '/api/menu')).json.items.find(i => i.id === 1).soldOut);
    assert.ok((await s.guest('GET', '/api/table?t=3&k=' + keys[3])).json.soldOut.includes(1));
    assert.equal((await s.call('POST', '/api/sale', { items: [{ id: 1, qty: 1 }], expectedSub: 60, method: 'cash' })).status, 200, 'หน้าร้านขายได้แม้ระบบบอกหมด (ของอยู่ในมือ) สต็อกติดลบ');
    assert.equal((await item(s, 1)).stock, -1);
    await s.call('POST', '/api/sale', { kind: 'buy', items: [{ id: 1, qty: 2 }], expectedSub: 120, method: 'cash' });
    assert.equal((await item(s, 1)).stock, 1, 'รับซื้อ = เข้า');
    assert.equal((await s.call('POST', '/api/stock/adjust', { mode: 'out', lines: [{ id: 1, qty: 1 }] })).status, 400, 'เบิกออกต้องมีเหตุผล');
    const out = await s.call('POST', '/api/stock/adjust', { mode: 'out', reason: 'ของเสีย', lines: [{ id: 1, qty: 1 }] });
    assert.equal(out.json.doc.no, 'OUT' + Y + '-0001');
    const gin = await s.call('POST', '/api/stock/adjust', { mode: 'in', reason: 'ซื้อจากตลาด', party: { name: 'ร้านส่งเจริญ' }, lines: [{ id: 1, qty: 10, price: 30 }, { id: 2, qty: 4 }] });
    assert.equal(gin.status, 200, JSON.stringify(gin.json));
    assert.deepEqual([(await item(s, 1)).stock, (await item(s, 1)).cost, (await item(s, 2)).stock, (await item(s, 2)).track], [10, 30, 4, true]);
    const card = (await s.call('GET', '/api/stock?id=1')).json;
    assert.deepEqual(card.moves.map(v => [v.kind, v.qty, v.bal]), [['count', 5, 5], ['sale', -2, 3], ['sale', -3, 0], ['sale', -1, -1], ['buy', 2, 1], ['out', -1, 0], ['gr', 10, 10]]);
    assert.ok(card.moves.every(v => v.ref), 'ทุกบรรทัดอ้างเลขบิลหรือเลขเอกสาร');
    assert.equal(journal(s.dir, 'stock').length, 8, 'ประวัติสต็อกลงไฟล์ครบ');
    const csv = (await s.call('GET', '/api/stock.csv')).text;
    assert.match(csv, /"ผัดกะเพราหมูสับ","จานเดียว","","10","30","300"/);
    const a = readLog(s.dir, 'audit').filter(e => e.action === 'stock.adjusted');
    assert.equal(a.length, 3);
    await s.stop();
  });

  test('ใบเสนอราคา → ใบแจ้งหนี้ (ตัดสต็อก) → รับชำระ (บิลขาย ลงสรุปยอดและ CSV) เลขที่รันต่อเนื่อง ยอดคิดที่เซิร์ฟเวอร์ แก้ทับกันไม่ได้', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    const qt = { type: 'QT', party: { name: 'บริษัท ตัวอย่าง จำกัด', taxId: '0105555555555', branch: 'สำนักงานใหญ่', address: '1 ถ.สุขุมวิท' }, saveContact: true,
      lines: [{ id: 2, qty: 3, price: 70 }, { name: 'ค่าขนส่ง', qty: 1, unit: 'เที่ยว', price: 150 }], discount: 20, vat: true, note: 'ราคานี้รวมติดตั้ง' };
    assert.equal((await s.call('POST', '/api/doc', qt)).status, 409, 'ยังไม่เปิดเอกสาร');
    await on(s);
    await s.call('POST', '/api/stock/adjust', { mode: 'count', lines: [{ id: 2, qty: 10 }] });
    for (const [bad, msg] of [[{ party: { name: '' } }, /ชื่อลูกค้า/], [{ party: { name: 'x', taxId: '123' } }, /13 หลัก/], [{ discount: 9999 }, /ส่วนลด/], [{ lines: [] }, /ยังไม่มีรายการ/], [{ lines: [{ name: 'x', qty: 1, price: '' }] }, /ราคา/], [{ lines: [{ id: 999, qty: 1, price: 1 }] }, /ไม่พบสินค้า/]]) {
      const r = await s.call('POST', '/api/doc', Object.assign({}, qt, bad));
      assert.equal(r.status, 400, JSON.stringify(bad)); assert.match(r.json.error, msg);
    }
    const q = (await s.call('POST', '/api/doc', qt)).json.doc;
    assert.equal(q.no, 'QT' + Y + '-0001');
    assert.deepEqual([q.sub, q.disc, q.net, q.vatAmt, q.total], [360, 20, 340, 23.8, 363.8]);
    assert.equal(q.lines[0].name, 'ข้าวผัดกุ้ง', 'รายการจากสินค้าใช้ชื่อสินค้า');
    assert.equal(q.due - q.date, 30 * 86400000, 'ยืนราคา 30 วันตามค่าตั้งต้น');
    const contacts = (await s.call('GET', '/api/contacts')).json.list;
    assert.equal(contacts[0].name, 'บริษัท ตัวอย่าง จำกัด');
    assert.equal(q.party.contactId, contacts[0].id);
    assert.equal((await s.call('POST', '/api/doc', Object.assign({}, qt, { no: q.no, rev: q.rev + 5 }))).status, 409, 'อีกเครื่องแก้ไปแล้ว');
    const q2 = (await s.call('POST', '/api/doc', Object.assign({}, qt, { no: q.no, rev: q.rev, discount: 0, saveContact: false }))).json.doc;
    assert.deepEqual([q2.no, q2.rev, q2.total], [q.no, 2, 385.2]);
    // ลูกค้าตกลง → ใบแจ้งหนี้ ตัดสต็อก
    const inv = (await s.call('POST', '/api/doc/convert', { no: q.no, rev: 2 })).json.doc;
    assert.deepEqual([inv.no, inv.type, inv.status, inv.ref, inv.total], ['INV' + Y + '-0001', 'INV', 'unpaid', q.no, 385.2]);
    assert.equal((await item(s, 2)).stock, 7);
    assert.equal((await s.call('GET', '/api/doc?no=' + q.no)).json.doc.status, 'accepted');
    assert.equal((await s.call('POST', '/api/doc', Object.assign({}, qt, { no: inv.no, rev: inv.rev }))).status, 409, 'ใบแจ้งหนี้ที่ออกแล้วแก้ไม่ได้');
    assert.equal((await s.call('GET', '/api/state')).json.docStats.unpaid, 1);
    // รับชำระ
    assert.equal((await s.call('POST', '/api/doc/pay', { no: inv.no, expectedTotal: 1, method: 'transfer' })).status, 409);
    const paid = await s.call('POST', '/api/doc/pay', { no: inv.no, expectedTotal: 385.2, method: 'transfer' });
    assert.equal(paid.status, 200, JSON.stringify(paid.json));
    assert.deepEqual([paid.json.sale.doc, paid.json.sale.total, paid.json.sale.sub, paid.json.sale.vat], [inv.no, 385.2, 360, 25.2]);
    assert.equal((await item(s, 2)).stock, 7, 'รับชำระไม่ตัดสต็อกซ้ำ');
    assert.equal((await s.call('POST', '/api/doc/pay', { no: inv.no, expectedTotal: 385.2 })).status, 409, 'รับชำระซ้ำไม่ได้');
    const rep = (await s.call('GET', '/api/report')).json;
    assert.deepEqual([rep.count, rep.total, rep.transfer], [1, 385.2, 385.2]);
    assert.match((await s.call('GET', '/api/export.csv')).text, new RegExp('"' + inv.no + ' บริษัท ตัวอย่าง จำกัด","0","ข้าวผัดกุ้ง x3; ค่าขนส่ง x1 เที่ยว"'));
    assert.equal((await s.call('POST', '/api/doc/cancel', { no: inv.no, reason: 'ลูกค้าคืนของ' })).status, 409, 'รับชำระแล้วยกเลิกไม่ได้');
    // ใบแจ้งหนี้ใบใหม่แล้วยกเลิก: คืนสต็อก
    const inv2 = (await s.call('POST', '/api/doc', { type: 'INV', party: { name: 'คุณเอ' }, lines: [{ id: 2, qty: 2, price: 90 }] })).json.doc;
    assert.deepEqual([inv2.no, (await item(s, 2)).stock], ['INV' + Y + '-0002', 5]);
    assert.equal((await s.call('POST', '/api/doc/cancel', { no: inv2.no })).status, 400, 'ต้องมีเหตุผล');
    assert.equal((await s.call('POST', '/api/doc/cancel', { no: inv2.no, reason: 'ออกผิด' })).status, 200);
    assert.equal((await item(s, 2)).stock, 7, 'ยกเลิกแล้วคืนสต็อก');
    // รายการ ค้นหา และสิทธิ์
    const list = (await s.call('GET', '/api/docs?type=sales')).json;
    assert.deepEqual(list.docs.map(d => d.no).sort(), [inv.no, inv2.no, q.no].sort());
    assert.equal((await s.call('GET', '/api/docs?status=open')).json.docs.length, 0);
    assert.equal((await s.call('GET', '/api/docs?q=คุณเอ')).json.docs[0].no, inv2.no);
    assert.equal((await s.call('GET', '/api/docs?month=' + monthNow() + '&type=INV')).json.docs.length, 2, 'ค้นจาก journal/ ได้');
    await withStaff(s);
    const cs = await device(s, '520011');
    const cq = await cs.call('POST', '/api/doc', Object.assign({}, qt, { saveContact: false }));
    assert.equal(cq.json.doc.no, 'QT' + Y + '-0002', 'แคชเชียร์ออกใบเสนอราคาได้');
    assert.equal((await cs.call('POST', '/api/doc', { type: 'PO', party: { name: 'ผู้ขาย' }, lines: [{ name: 'x', qty: 1, price: 1 }] })).status, 403, 'ใบสั่งซื้อเฉพาะเจ้าของ');
    assert.equal((await cs.call('POST', '/api/doc/cancel', { no: cq.json.doc.no, reason: 'xx' })).status, 403, 'ยกเลิกเอกสารเฉพาะเจ้าของ');
    const revs = journal(s.dir, 'docs').filter(r => r.no === q.no).map(r => r.rev);
    assert.deepEqual(revs, [1, 2, 3], 'ทุกครั้งที่เอกสารเปลี่ยนลง journal');
    assert.ok(['doc.created', 'doc.updated', 'doc.converted', 'doc.paid', 'doc.cancelled', 'contact.created'].every(a => readLog(s.dir, 'audit').some(e => e.action === a)));
    await s.stop();
  });

  test('ใบสั่งซื้อ: รับของตามจริง → ใบรับสินค้า สต็อกเพิ่ม ต้นทุนล่าสุดเปลี่ยน สินค้าที่ยังไม่นับเริ่มนับ ยกเลิกได้เฉพาะก่อนรับของ', async () => {
    const s = start(makeApp()); await s.ready; await s.login();
    await on(s);
    const po = (await s.call('POST', '/api/doc', { type: 'PO', party: { name: 'ห้างส่งวัสดุ' }, lines: [{ id: 3, qty: 10, price: 40 }, { id: 4, qty: 5, price: 25 }], vat: true })).json.doc;
    assert.deepEqual([po.no, po.status, po.due, po.total], ['PO' + Y + '-0001', 'open', null, 561.75]);   // (400 + 125) × 1.07
    assert.equal((await item(s, 3)).track, false, 'สั่งซื้อยังไม่เพิ่มสต็อก');
    assert.equal((await s.call('POST', '/api/doc/receive', { no: po.no, rev: po.rev + 1, lines: [{ qty: 8 }, { qty: 0 }] })).status, 409);
    assert.equal((await s.call('POST', '/api/doc/receive', { no: po.no, rev: po.rev, lines: [{ qty: 0 }, { qty: 0 }] })).status, 400);
    const r = await s.call('POST', '/api/doc/receive', { no: po.no, rev: po.rev, lines: [{ qty: 8, price: 42 }, { qty: 0 }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.doc.no, r.json.doc.type, r.json.doc.ref, r.json.doc.lines.length, r.json.po.status], ['GR' + Y + '-0001', 'GR', po.no, 1, 'received']);
    assert.deepEqual(r.json.po.lines.map(l => l.got), [8, 0]);
    const i3 = await item(s, 3);
    assert.deepEqual([i3.track, i3.stock, i3.cost], [true, 8, 42], 'เริ่มนับสต็อกจากที่รับ ต้นทุนล่าสุด');
    assert.equal((await s.call('POST', '/api/doc/receive', { no: po.no, rev: r.json.po.rev, lines: [{ qty: 1 }, { qty: 1 }] })).status, 409, 'รับซ้ำไม่ได้');
    const po2 = (await s.call('POST', '/api/doc', { type: 'PO', party: { name: 'ห้างส่งวัสดุ' }, lines: [{ id: 3, qty: 1, price: 40 }] })).json.doc;
    assert.equal((await s.call('POST', '/api/doc/cancel', { no: po2.no, reason: 'สั่งซ้ำ' })).json.doc.status, 'cancelled');
    assert.equal((await s.call('POST', '/api/doc/cancel', { no: po.no, reason: 'xx' })).status, 409, 'รับของแล้วยกเลิกไม่ได้');
    // เลิกใช้เอกสารทั้งที่มีใบสั่งซื้อรอรับของไม่ได้
    await s.call('POST', '/api/doc', { type: 'PO', party: { name: 'ห้างส่งวัสดุ' }, lines: [{ id: 3, qty: 1, price: 40 }] });
    const off = await s.call('POST', '/api/settings', { modes: { docs: false } });
    assert.equal(off.status, 400); assert.match(off.json.error, /PO/);
    await s.stop();
  });

  test('เลขที่เอกสารไม่ซ้ำแม้ data.json ย้อนไปฉบับเก่า และไฟล์สำรองมีประวัติสต็อก/เอกสาร กู้คืนแล้วกลับมาครบ', async () => {
    const dir = makeApp();
    let s = start(dir); await s.ready; await s.login();
    await on(s);
    const qt = n => s.call('POST', '/api/doc', { type: 'QT', party: { name: 'ลูกค้า ' + n }, lines: [{ name: 'งาน ' + n, qty: 1, price: 100 }] });
    assert.equal((await qt(1)).json.doc.no, 'QT' + Y + '-0001');
    await s.call('POST', '/api/stock/adjust', { mode: 'count', lines: [{ id: 1, qty: 7 }] });
    const bk = (await s.call('POST', '/api/backup', {})).json.backup;
    const old = fs.readFileSync(path.join(dir, 'data.json'));
    await qt(2); await qt(3);
    await s.stop();
    fs.writeFileSync(path.join(dir, 'data.json'), old);             // data.json ย้อนไปก่อนออก QT-0002/0003
    s = start(dir); await s.ready; await s.login();
    assert.equal((await qt(4)).json.doc.no, 'QT' + Y + '-0004', 'ไม่ใช้เลข 0002 ซ้ำกับที่ส่งให้ลูกค้าไปแล้ว');
    const data = (await getBackup(s, bk.name)).json;
    assert.ok(Object.keys(data.journal).some(f => /^docs-/.test(f)) && Object.keys(data.journal).some(f => /^stock-/.test(f)), 'ไฟล์สำรองมี journal/');
    const r = await restoreRaw(s, (await getBackup(s, bk.name)).buf);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await s.login();
    assert.equal((await s.call('GET', '/api/stock?id=1')).json.moves.length, 1, 'บัตรสต็อกกลับมาจากไฟล์สำรอง');
    assert.equal((await s.call('GET', '/api/docs?month=' + monthNow() + '&type=QT')).json.docs.length, 1, 'เอกสารเป็นแบบตอนสำรอง');
    assert.equal((await qt(5)).json.doc.no, 'QT' + Y + '-0005', 'กู้คืนแล้วเลขเอกสารไม่ย้อน');
    await s.stop();
  });

  test('เขียนประวัติสต็อก/เอกสารลง journal/ ไม่ได้: ป้ายเตือน ขายต่อได้ เขียนครบเมื่อกลับมาปกติ ไม่ซ้ำแม้ปิดเปิดใหม่', async () => {
    const dir = makeApp(), jd = path.join(dir, 'journal');
    let s = start(dir); await s.ready; await s.login();
    await on(s);
    await s.call('POST', '/api/stock/adjust', { mode: 'count', lines: [{ id: 1, qty: 50 }] });
    const warn = async () => (await s.call('GET', '/api/state')).json.health.saveError;
    fs.rmSync(jd, { recursive: true, force: true }); fs.writeFileSync(jd, 'x');      // สร้างโฟลเดอร์ journal ไม่ได้
    assert.equal((await s.call('POST', '/api/sale', { items: [{ id: 1, qty: 1 }], expectedSub: 60, method: 'cash' })).status, 200, 'ขายได้ตามปกติ');
    assert.equal((await s.call('POST', '/api/doc', { type: 'INV', party: { name: 'ก' }, lines: [{ id: 1, qty: 2, price: 60 }] })).status, 200);
    await new Promise(r => setTimeout(r, 300));
    assert.ok(await warn(), 'ต้องเตือน');
    await s.stop();
    s = start(dir); await s.ready; await s.login();
    assert.ok(await warn(), 'เปิดใหม่แล้วยังเขียนไม่ได้ ต้องเตือน');
    fs.rmSync(jd);
    await until(async () => !(await warn()), 8000);
    // ตรวจนับ 50 เขียนไปแล้วในโฟลเดอร์เดิมที่ถูกลบทิ้ง ยังอยู่ใน data.json (วันนี้) จึงถูกเขียนกลับด้วย
    assert.deepEqual(journal(dir, 'stock').map(v => v.qty), [50, -1, -2], 'ความเคลื่อนไหวที่ค้างถูกเขียนครบ');
    assert.deepEqual(journal(dir, 'docs').map(d => d.type).sort(), ['CNT', 'INV'], 'ใบตรวจนับ (เขียนกลับ) และใบแจ้งหนี้ที่ค้าง');
    await s.stop();
    s = start(dir); await s.ready;
    assert.equal(journal(dir, 'stock').length, 3, 'เปิดใหม่ไม่เขียนซ้ำ');
    await s.stop();
  });

  test('data.json ที่เอกสาร ผู้ติดต่อ สต็อก ผิดรูป: ระบบเปิดได้ ตัดทิ้งเฉพาะที่เสีย', async () => {
    const dir = makeApp();
    let s = start(dir); await s.ready; await s.stop();
    const D = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
    D.contacts = [{ id: 'c1', name: 'ดี', kind: 'weird', taxId: 5 }, { id: 'x', name: 'เสีย' }, null];
    D.docs = [{ no: 'QT2026-0009', type: 'QT', status: 'open', date: Date.now(), lines: [{ name: 'ก', qty: 1, price: 10 }, { qty: 'x' }], party: { name: 'ดี' } },
      { no: 'INV2026-0001', type: 'QT', status: 'open', date: 1, lines: [] }, { no: '../x', type: 'PO', status: 'open', date: 1, lines: [] }, { no: 'PO2026-0001', type: 'PO', status: 'paid', date: 1, lines: [] }];
    D.menu.items[0].stock = 'x'; D.menu.items[0].track = 'yes'; D.menu.items[0].cost = -1;
    D.moves = [{ id: 'bad' }];
    D.docSeq = { QT: { y: 'x' } };
    fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(D));
    s = start(dir); await s.ready; await s.login();
    const st = (await s.call('GET', '/api/state')).json;
    assert.deepEqual([st.menu.items[0].stock, st.menu.items[0].track, st.menu.items[0].cost], [0, false, 0]);
    const c = (await s.call('GET', '/api/contacts')).json.list;
    assert.deepEqual(c.map(x => [x.id, x.kind, x.taxId]), [['c1', 'customer', '']]);
    const docs = (await s.call('GET', '/api/docs')).json.docs;
    assert.deepEqual(docs.map(d => d.no), ['QT2026-0009']);
    assert.deepEqual([docs[0].lines.length, docs[0].total], [1, 10], 'แถวเสียตัดทิ้ง ยอดคิดใหม่จากแถวที่เหลือ');
    await on(s);
    const n = (await s.call('POST', '/api/doc', { type: 'QT', party: { name: 'ข' }, lines: [{ name: 'ข', qty: 1, price: 1 }] })).json.doc.no;
    assert.equal(n, Y === 2026 ? 'QT2026-0010' : 'QT' + Y + '-0001', 'เลขต่อจากที่มีอยู่ ไม่ซ้ำเลขเดิม');
    await s.stop();
  });

  // หน้าออกเอกสารคิดยอดเอง (docCalc) ระหว่างพิมพ์ ถ้าไม่ตรงกับเซิร์ฟเวอร์ (store.docTotals) ยอดบนหน้าจอกับบนเอกสารจะต่างกันเป็นสตางค์
  test('ยอดเอกสารในหน้าพนักงาน = เซิร์ฟเวอร์ทุกสตางค์ และจำนวนเงินเป็นตัวหนังสือถูกต้อง', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'staff.html'), 'utf8');
    const fn = name => {
      const i = html.indexOf('function ' + name + '(');
      assert.ok(i >= 0, 'ไม่พบ ' + name);
      let d = 0, j = html.indexOf('{', i);
      for (; j < html.length; j++) { if (html[j] === '{') d++; else if (html[j] === '}' && --d === 0) break; }
      return html.slice(i, j + 1);
    };
    const consts = /var TH_D=[^\n]+/.exec(html)[0];
    const page = new Function(consts + '\n' + ['round2', 'r3', 'docCalc', 'bahtText'].map(fn).join('\n') + '\nreturn { docCalc, bahtText };')();
    const { docTotals } = require('../lib/store');
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let k = 0; k < 500; k++) {
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => ({ qty: Math.round(rnd() * 50000) / 1000 || 1, price: Math.round(rnd() * 500000) / 100 }));
      const sub = docTotals(lines, 0, false).sub, disc = rnd() < 0.5 ? 0 : Math.round(rnd() * sub * 100) / 100, vat = rnd() < 0.5;
      assert.deepEqual(page.docCalc(lines, disc, vat), docTotals(lines, disc, vat), JSON.stringify({ lines, disc, vat }));
    }
    const T = { 0: 'ศูนย์บาทถ้วน', 0.5: 'ห้าสิบสตางค์', 1: 'หนึ่งบาทถ้วน', 11: 'สิบเอ็ดบาทถ้วน', 21: 'ยี่สิบเอ็ดบาทถ้วน', 101: 'หนึ่งร้อยเอ็ดบาทถ้วน', 110: 'หนึ่งร้อยสิบบาทถ้วน',
      1234.5: 'หนึ่งพันสองร้อยสามสิบสี่บาทห้าสิบสตางค์', 20000.01: 'สองหมื่นบาทหนึ่งสตางค์', 1000000: 'หนึ่งล้านบาทถ้วน', 1000001: 'หนึ่งล้านเอ็ดบาทถ้วน',
      11000000: 'สิบเอ็ดล้านบาทถ้วน', 21500321.21: 'ยี่สิบเอ็ดล้านห้าแสนสามร้อยยี่สิบเอ็ดบาทยี่สิบเอ็ดสตางค์', 168.51: 'หนึ่งร้อยหกสิบแปดบาทห้าสิบเอ็ดสตางค์' };
    Object.keys(T).forEach(n => assert.equal(page.bahtText(+n), T[n], n));
  });
});
