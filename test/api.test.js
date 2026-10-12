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

// ปิดเซิร์ฟเวอร์ทดสอบทุกตัวเสมอ แม้เคสจะ fail กลางทาง (ไม่อย่างนั้นชุดทดสอบจะค้าง)
const running = new Set();
after(() => { running.forEach(p => { try { p.kill('SIGKILL'); } catch (e) { /* ignore */ } }); });
process.on('exit', () => running.forEach(p => { try { p.kill('SIGKILL'); } catch (e) { /* ignore */ } }));

function start(dir, env) {
  const port = portSeq++;
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
    assert.equal((await upload(s, newId, Buffer.concat([JPG, Buffer.alloc(3 * 1024 * 1024)]))).status, 413);
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
