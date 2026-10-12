'use strict';
/* ข้อมูลของร้านทั้งหมดอยู่ใน state.D และบันทึกลง data.json
   ยอดขายถาวรอยู่ใน sales/YYYY-MM.jsonl รูปอาหารอยู่ใน images/ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./config');
const U = require('./util');
const log = require('./log');
const { isNum, isInt, isStr } = U;

const state = {
  D: null,
  changeSeq: 0,          // เพิ่มทุกครั้งที่ข้อมูลเปลี่ยน ใช้ตัดสินว่าต้องสำรองอัตโนมัติหรือไม่
  saveError: null,       // { at, message } เมื่อเขียนไฟล์ไม่สำเร็จ แสดงเป็นป้ายเตือนที่หน้าพนักงาน
  restoring: false
};

/* ---------- เมนูตั้งต้น: menu.json ใช้ครั้งแรกครั้งเดียว หลังจากนั้นแก้ในหน้าเว็บ ---------- */
function seedMenu() {
  let m;
  try { m = JSON.parse(fs.readFileSync(C.MENU_SEED, 'utf8')); }
  catch (e) { U.die('อ่าน menu.json ไม่ได้: ' + e.message + '\n  ตรวจเครื่องหมาย , และ " ในไฟล์'); }
  const errs = [];
  if (!Array.isArray(m.categories) || !m.categories.length) errs.push('ต้องมี "categories" อย่างน้อย 1 หมวด');
  if (!m.stations || typeof m.stations !== 'object' || !Object.keys(m.stations).length) errs.push('ต้องมี "stations" อย่างน้อย 1 สถานี');
  if (!Array.isArray(m.items) || !m.items.length) errs.push('ต้องมี "items" อย่างน้อย 1 รายการ');
  const ids = new Set(), cats = Array.isArray(m.categories) ? m.categories.length : 0, st = m.stations || {};
  (Array.isArray(m.items) ? m.items : []).forEach((it, i) => {
    const w = 'เมนูลำดับที่ ' + (i + 1) + (it && it.name ? ' (' + it.name + ')' : '');
    if (!it || typeof it !== 'object') { errs.push(w + ': รูปแบบไม่ถูกต้อง'); return; }
    if (!isInt(it.id) || it.id < 1) errs.push(w + ': "id" ต้องเป็นเลขจำนวนเต็มบวก');
    else if (ids.has(it.id)) errs.push(w + ': "id" ' + it.id + ' ซ้ำกับเมนูอื่น');
    else ids.add(it.id);
    if (!isStr(it.name) || !it.name.trim()) errs.push(w + ': ต้องมี "name"');
    if (typeof it.price !== 'number' || !(it.price >= 0)) errs.push(w + ': "price" ต้องเป็นตัวเลขไม่ติดลบ');
    if (!isInt(it.cat) || it.cat < 0 || it.cat >= cats) errs.push(w + ': "cat" ต้องอยู่ระหว่าง 0 ถึง ' + (cats - 1));
    if (!st[it.station]) errs.push(w + ': "station" ต้องเป็นหนึ่งใน ' + Object.keys(st).join(', '));
  });
  if (errs.length) U.die('menu.json มีปัญหา:\n  - ' + errs.join('\n  - '));
  return {
    version: 1,
    stations: m.stations,
    notes: Array.isArray(m.notes) ? m.notes.map(String) : [],
    categories: m.categories.map((n, i) => ({ id: i + 1, name: String(n) })),
    items: m.items.map(it => ({ id: it.id, name: it.name.trim(), price: it.price, cat: it.cat + 1, station: it.station, desc: String(it.desc || ''), image: '', hidden: false })),
    nextId: Math.max.apply(null, m.items.map(it => it.id)) + 1,
    nextCatId: m.categories.length + 1
  };
}

/* ---------- normalize: ตรวจและซ่อมทุกระเบียนที่อ่านจาก data.json หรือไฟล์สำรอง ----------
   ระเบียนที่เสียถูกตัดทิ้ง (นับไว้ใน report.dropped) แทนที่จะปล่อยให้หน้าพนักงานพังทั้งหน้า */
const TICKET_STATUS = ['new', 'cooking', 'ready', 'served'];
function cleanLine(i) {
  if (!i || !isInt(i.id) || !isStr(i.name) || !isNum(i.price) || !isInt(i.qty) || i.qty < 1) return null;
  return { id: i.id, name: i.name, price: i.price, qty: i.qty, note: Array.isArray(i.note) ? i.note.filter(isStr) : [] };
}
function normalize(x, report) {
  report = report || { dropped: 0 };
  const drop = () => { report.dropped++; return false; };
  x = x && typeof x === 'object' && !Array.isArray(x) ? x : {};
  const st = Object.assign({
    shop: 'ร้านของฉัน', address: '', phone: '', taxId: '', footer: 'ขอบคุณที่ใช้บริการ',
    promptpay: '', tables: 12, svc: true, vat: false, baseUrl: '', soldOut: [], acceptOrders: true
  }, x.settings && typeof x.settings === 'object' ? x.settings : {});
  ['shop', 'address', 'phone', 'taxId', 'footer', 'promptpay', 'baseUrl'].forEach(k => { if (!isStr(st[k])) st[k] = ''; });
  if (!st.shop) st.shop = 'ร้านของฉัน';
  ['svc', 'vat', 'acceptOrders'].forEach(k => { st[k] = !!st[k]; });
  st.tables = isInt(st.tables) && st.tables >= 1 && st.tables <= 60 ? st.tables : 12;
  st.soldOut = Array.isArray(st.soldOut) ? st.soldOut.filter(isInt) : [];
  x.settings = st;

  x.tickets = (Array.isArray(x.tickets) ? x.tickets : []).filter(t => {
    if (!t || !isInt(t.id) || !isInt(t.table) || t.table < 1 || t.table > 60 || !Array.isArray(t.items)) return drop();
    t.items = t.items.map(cleanLine).filter(Boolean);
    if (!t.items.length) return drop();
    if (!TICKET_STATUS.includes(t.status)) t.status = 'new';
    if (!isNum(t.createdAt)) t.createdAt = Date.now();
    if (!isStr(t.station)) t.station = '';
    if (!isStr(t.memo)) t.memo = '';
    return true;
  });
  x.sales = (Array.isArray(x.sales) ? x.sales : []).filter(s => {
    if (!s || !isInt(s.no) || !isNum(s.at) || !isNum(s.total) || !Array.isArray(s.items)) return drop();
    ['sub', 'svc', 'vat'].forEach(k => { if (!isNum(s[k])) s[k] = 0; });
    if (!isInt(s.table)) s.table = 0;
    s.items = s.items.filter(i => i && isStr(i.name) && isInt(i.qty));
    return true;
  });
  const calls = {};
  if (x.calls && typeof x.calls === 'object') Object.keys(x.calls).forEach(t => {
    const c = x.calls[t];
    if (+t >= 1 && +t <= 60 && c && (c.kind === 'bill' || c.kind === 'staff') && isNum(c.at)) calls[+t] = c; else report.dropped++;
  });
  x.calls = calls;
  const keys = {};
  if (x.keys && typeof x.keys === 'object') Object.keys(x.keys).forEach(t => { if (isStr(x.keys[t]) && x.keys[t]) keys[t] = x.keys[t]; });
  x.keys = keys;
  // โต๊ะที่ยังเปิดอยู่ต้องไม่หายไปเพราะจำนวนโต๊ะในไฟล์น้อยกว่า
  st.tables = Math.max(st.tables, ...x.tickets.map(t => t.table), ...Object.keys(calls).map(Number));
  x.nextTicket = Math.max(isInt(x.nextTicket) ? x.nextTicket : 1, 1 + Math.max(0, ...x.tickets.map(t => t.id)));
  x.nextBill = Math.max(isInt(x.nextBill) ? x.nextBill : 1, 1 + Math.max(0, ...x.sales.map(s => s.no)));
  if (!isStr(x.secret) || x.secret.length < 16) x.secret = crypto.randomBytes(16).toString('hex');

  const m = x.menu;
  if (!m || typeof m !== 'object' || !Array.isArray(m.items) || !Array.isArray(m.categories)) x.menu = seedMenu();
  else {
    m.categories = m.categories.filter(c => (c && isInt(c.id) && isStr(c.name) && c.name) || drop());
    if (!m.categories.length) m.categories = [{ id: 1, name: 'เมนู' }];
    m.stations = m.stations && typeof m.stations === 'object' && Object.keys(m.stations).length ? m.stations : { hot: 'ครัว' };
    const first = Object.keys(m.stations)[0], seen = new Set();
    m.items = m.items.filter(i => {
      if (!i || !isInt(i.id) || seen.has(i.id) || !isStr(i.name) || !i.name || !isNum(i.price) || i.price < 0) return drop();
      seen.add(i.id);
      if (!isInt(i.cat)) i.cat = m.categories[0].id;
      if (!m.stations[i.station]) i.station = first;
      i.desc = isStr(i.desc) ? i.desc : '';
      i.image = isStr(i.image) && C.IMG_RE.test(i.image) ? i.image : '';
      i.hidden = !!i.hidden;
      return true;
    });
    m.notes = Array.isArray(m.notes) ? m.notes.filter(isStr) : [];
    m.version = isInt(m.version) ? m.version : 1;
  }
  const mm = x.menu;
  mm.nextId = Math.max(isInt(mm.nextId) ? mm.nextId : 1, 1 + Math.max(0, ...mm.items.map(i => i.id)));
  mm.nextCatId = Math.max(isInt(mm.nextCatId) ? mm.nextCatId : 1, 1 + Math.max(0, ...mm.categories.map(c => c.id)));
  return x;
}

/* ---------- บันทึก ----------
   เขียนไม่สำเร็จ (ไฟล์ถูกล็อก ดิสก์เต็ม) ให้ตั้งเวลาลองใหม่เรื่อยๆ จนสำเร็จ ห้ามหยุดรอแบบ sync
   เพราะ Node มี thread เดียว ระหว่างรอ ลูกค้าทุกโต๊ะและจอครัวจะค้างไปด้วย */
const BACKOFF = [50, 200, 500, 1000, 2000, 5000];
const backoff = n => BACKOFF[Math.min(n, BACKOFF.length - 1)];
let saveTimer = null, dataFails = 0;
let salesTimer = null, salesFails = 0;
const salesQueue = [];          // บิลที่ยังเขียนลง sales/ ไม่สำเร็จ เรียงตามลำดับที่ปิดบิล

// สถานะการบันทึกเปลี่ยน (เสีย ↔ กลับมาปกติ) ต้องแจ้งหน้าพนักงานทันที
// เพราะการบันทึกเกิดหลังการแจ้งเตือนออเดอร์ 150 ms หน้าจอจะไม่รู้เองถ้าไม่บอก
let onHealthChange = () => {};
function setHealthListener(fn) { onHealthChange = fn; }
// แยกสถานะ data.json, sales/ และ logs/ ป้ายเตือนหายเมื่อบันทึกได้ครบทุกอย่างเท่านั้น
const failing = { data: null, sales: null, logs: null };
function noteSave(kind, err) {
  const msg = err ? err.message : null;
  if (msg && msg !== failing[kind]) {
    console.error({ sales: 'บันทึกยอดขายไม่สำเร็จ:', logs: 'บันทึก log ไม่สำเร็จ:' }[kind] || 'บันทึกข้อมูลไม่สำเร็จ:', msg);
    if (kind !== 'logs') log.app('error', 'save_failed', { what: kind, error: msg });
  }
  failing[kind] = msg;
  const now = failing.data || failing.sales || failing.logs;
  if (!now) {
    if (state.saveError) { state.saveError = null; console.error('บันทึกข้อมูลได้ตามปกติแล้ว'); log.app('info', 'save_recovered'); onHealthChange(); }
    return;
  }
  const first = !state.saveError;
  state.saveError = { at: first ? Date.now() : state.saveError.at, message: now };
  if (first) onHealthChange();
}
// พลาดครั้งแรกเพราะไฟล์ถูกล็อกชั่วครู่ยังไม่เตือน ส่วนใหญ่หายเองก่อนลองรอบถัดไป
log.setHealthListener(e => noteSave('logs', e));
function failed(kind, e, fails) { if (fails || !U.isTransient(e)) noteSave(kind, e); }

function writeNow() {
  clearTimeout(saveTimer); saveTimer = null;
  try { U.writeAtomic(C.DATA_FILE, JSON.stringify(state.D)); dataFails = 0; noteSave('data', null); }
  catch (e) { failed('data', e, dataFails); saveTimer = setTimeout(writeNow, backoff(dataFails++)); }
}
// เขียนทันทีก่อนตอบ 200 ถ้ารอรวบเขียนทีหลัง ไฟดับช่วงนั้นออเดอร์ที่ลูกค้าเห็นว่าสั่งสำเร็จจะหาย
function save() { state.changeSeq++; writeNow(); }

function appendSale(s) {
  fs.mkdirSync(C.SALES_DIR, { recursive: true });
  fs.appendFileSync(path.join(C.SALES_DIR, U.monthKey(s.at) + '.jsonl'), JSON.stringify(s) + '\n');
}
let needCheck = false;          // ต้องเทียบบิลใน data.json กับ sales/ ก่อนเขียน (ตอนเปิดระบบและหลังกู้คืน)
function flushSales() {
  clearTimeout(salesTimer); salesTimer = null;
  if (state.restoring) { salesTimer = setTimeout(flushSales, 1000); return; }   // กู้คืนกำลังสลับโฟลเดอร์ sales อยู่
  try {
    if (needCheck) { queueMissingSales(); needCheck = false; }
    while (salesQueue.length) { appendSale(salesQueue[0]); salesQueue.shift(); }
    salesFails = 0; noteSave('sales', null);
  } catch (e) { failed('sales', e, salesFails); salesTimer = setTimeout(flushSales, backoff(salesFails++)); }
}
function archiveSale(s) { salesQueue.push(s); flushSales(); }
// อ่านไฟล์ไม่ได้ให้ throw (แล้วลองใหม่ทีหลัง) ห้ามถือว่าว่าง ไม่อย่างนั้นจะเขียนบิลซ้ำทั้งเดือน
function archivedNos(file) {
  let text;
  try { text = fs.readFileSync(path.join(C.SALES_DIR, file), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return new Set(); throw e; }
  const nos = new Set();
  text.split('\n').forEach(l => { try { const s = JSON.parse(l); if (s && isInt(s.no)) nos.add(s.no); } catch (e) { /* บรรทัดว่างหรือเสีย */ } });
  return nos;
}
function queueMissingSales() {
  const have = {}, missing = [];
  state.D.sales.forEach(s => {
    const f = U.monthKey(s.at) + '.jsonl';
    if (!have[f]) have[f] = archivedNos(f);
    if (!have[f].has(s.no)) missing.push(s);
  });
  salesQueue.length = 0; salesQueue.push(...missing);
}
// บิลใน data.json ที่ยังไม่อยู่ใน sales/ (เขียนไม่สำเร็จแล้วปิดโปรแกรม หรือข้อมูลจากเวอร์ชันแรก) เขียนเพิ่มให้ครบ
// ตั้งคิวใหม่จากข้อมูลปัจจุบันทั้งหมด คิวเดิมก่อนกู้คืนจึงถูกทิ้ง
function reconcileSales() { needCheck = true; flushSales(); }
// เลขบิลเพิ่มตามเวลา จึงดูแค่ไฟล์เดือนนี้กับไฟล์ล่าสุด
function maxArchivedNo() {
  const files = U.listDir(C.SALES_DIR, C.SALES_RE).sort();
  let max = 0;
  new Set([files[files.length - 1], U.monthKey(Date.now()) + '.jsonl']).forEach(f => {
    if (!f) return;
    try { archivedNos(f).forEach(n => { if (n > max) max = n; }); }
    catch (e) { console.error('อ่าน sales/' + f + ' ไม่ได้ ตรวจเลขบิลล่าสุดไม่ได้:', e.message); }
  });
  return max;
}
// ปิดโปรแกรม: ไม่มีคำขออื่นรออยู่แล้ว จึงลองซ้ำแบบหยุดรอได้ ยอดขายที่ยังเขียนไม่ได้ เปิดครั้งหน้าจะเติมให้เอง
function writeFinal() {
  clearTimeout(saveTimer); clearTimeout(salesTimer);
  // ถ้ายังไม่ได้เทียบกับ sales/ คิวอาจเป็นของข้อมูลก่อนกู้คืน ปล่อยให้เปิดครั้งหน้าเทียบใหม่
  if (!needCheck) {
    try { while (salesQueue.length) { U.retry(() => appendSale(salesQueue[0])); salesQueue.shift(); } }
    catch (e) { console.error('บันทึกยอดขายไม่สำเร็จ:', e.message); }
  }
  try { U.retry(() => U.writeAtomic(C.DATA_FILE, JSON.stringify(state.D))); }
  catch (e) { console.error('บันทึกข้อมูลไม่สำเร็จ:', e.message); }
  log.app('info', 'shutdown');
  log.flushFinal();
}
function trimSales() {
  const cut = U.dayStart(Date.now()) - (C.KEEP_DAYS - 1) * C.DAY;
  state.D.sales = state.D.sales.filter(s => s.at >= cut);
}
function ensureKeys() {
  const D = state.D;
  for (let t = 1; t <= D.settings.tables; t++) if (!D.keys[t]) D.keys[t] = crypto.randomBytes(4).toString('hex');
}

/* ---------- โหลดตอนเปิดระบบ (ไม่ล้างข้อมูลเงียบๆ เมื่อไฟล์เสีย) ---------- */
function load() {
  fs.mkdirSync(C.DATA_DIR, { recursive: true });
  let D = {};
  if (fs.existsSync(C.DATA_FILE)) {
    let ok = false;
    try { D = JSON.parse(fs.readFileSync(C.DATA_FILE, 'utf8')); ok = !!D && typeof D === 'object'; } catch (e) { ok = false; }
    if (ok) {
      try { fs.copyFileSync(C.DATA_FILE, C.DATA_FILE + '.bak'); } catch (e) { /* สำรองไม่ได้ไม่เป็นไร */ }
    } else {
      const bad = C.DATA_FILE + '.corrupt-' + Date.now();
      try { fs.copyFileSync(C.DATA_FILE, bad); } catch (e) { /* ignore */ }
      console.error('\n! data.json เสียหาย เก็บสำเนาไว้ที่ ' + bad);
      try {
        D = JSON.parse(fs.readFileSync(C.DATA_FILE + '.bak', 'utf8'));
        console.error('  กู้คืนจาก data.json.bak (ข้อมูล ณ ตอนเปิดระบบครั้งก่อน) แล้ว');
        log.app('warn', 'data_recovered_from_bak', { corruptCopy: path.basename(bad) });
        console.error('  ถ้าต้องการข้อมูลใหม่กว่านั้น กู้จากไฟล์ในโฟลเดอร์ backups ผ่านหน้า ตั้งค่า > สำรองข้อมูล\n');
      } catch (e) {
        U.die('กู้คืนข้อมูลไม่ได้ ระบบหยุดเพื่อไม่ให้รหัส QR และยอดขายถูกสร้างใหม่ทับ\n  ไฟล์ที่เสียหายอยู่ที่ ' + bad +
          '\n  ถ้ามีไฟล์ในโฟลเดอร์ backups ให้ลบ data.json แล้วเปิดระบบ จากนั้นกู้คืนจากไฟล์สำรองในหน้า ตั้งค่า');
      }
    }
  }
  const rep = { dropped: 0 };
  state.D = normalize(D, rep);
  if (rep.dropped) { console.error('! พบข้อมูลเสีย ' + rep.dropped + ' รายการใน data.json ตัดทิ้งแล้ว ส่วนที่เหลือใช้งานได้ตามปกติ'); log.app('warn', 'data_records_dropped', { count: rep.dropped }); }
  ensureKeys();
  reconcileSales();     // ก่อน trimSales เพื่อให้บิลเก่ากว่า 8 วันที่ยังไม่อยู่ใน sales/ ถูกเขียนก่อนตัดทิ้ง
  // บิลที่ลง sales/ แล้วแต่ data.json บันทึกไม่ทัน (เขียนไม่ได้แล้วโปรแกรมดับ) ห้ามถูกใช้เลขซ้ำ
  state.D.nextBill = Math.max(state.D.nextBill, 1 + maxArchivedNo());
  trimSales();
  writeNow();
}

/* ---------- คำนวณ ---------- */
function billOf(t) {
  const map = {}, order = [];
  state.D.tickets.filter(k => k.table === t).forEach(k => k.items.forEach(it => {
    const key = it.id + '|' + it.price;
    if (!map[key]) { map[key] = { id: it.id, name: it.name, price: it.price, qty: 0 }; order.push(key); }
    map[key].qty += it.qty;
  }));
  const lines = order.map(k => map[k]);
  let sub = 0; lines.forEach(l => { sub += l.price * l.qty; });
  return { lines, sub: Math.round(sub * 100) / 100 };
}
function totals(sub, svcOn, vatOn) {
  const svc = svcOn ? Math.round(sub * 0.10) : 0;
  const vat = vatOn ? Math.round((sub + svc) * 0.07) : 0;
  return { svc, vat, total: Math.round((sub + svc + vat) * 100) / 100 };
}
function openTableNumbers() {
  const s = new Set(state.D.tickets.map(k => k.table));
  Object.keys(state.D.calls).forEach(t => s.add(+t));
  return Array.from(s);
}
function menuItem(id) { return state.D.menu.items.find(m => m.id === id); }
function removeImageFile(name) { if (name && C.IMG_RE.test(name)) { try { fs.unlinkSync(path.join(C.IMG_DIR, name)); } catch (e) { /* ignore */ } } }

module.exports = {
  state, seedMenu, normalize, load, save, writeNow, writeFinal, archiveSale, reconcileSales, trimSales, ensureKeys, setHealthListener,
  billOf, totals, openTableNumbers, menuItem, removeImageFile
};
