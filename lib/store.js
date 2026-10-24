'use strict';
/* ข้อมูลของร้านทั้งหมดอยู่ใน state.D และบันทึกลง data.json
   ยอดขายถาวรอยู่ใน sales/YYYY-MM.jsonl รูปอาหารอยู่ใน images/ */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const C = require('./config');
const U = require('./util');
const log = require('./log');
const theme = require('./theme');
const biz = require('./biz');
const { isNum, isInt, isStr } = U;

const state = {
  D: null,
  changeSeq: 0,          // เพิ่มทุกครั้งที่ข้อมูลเปลี่ยน ใช้ตัดสินว่าต้องสำรองอัตโนมัติหรือไม่
  saveError: null,       // { at, message } เมื่อเขียนไฟล์ไม่สำเร็จ แสดงเป็นป้ายเตือนที่หน้าพนักงาน
  restoring: false,
  restoreGen: 0          // เพิ่มทุกครั้งที่กู้คืนเสร็จ งานเบื้องหลังที่อ่านไฟล์ข้าม await (สำเนา MySQL) ใช้ตรวจว่าข้อมูลถูกสลับระหว่างทางหรือไม่
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
    items: m.items.map(it => ({ id: it.id, name: it.name.trim(), price: it.price, cat: it.cat + 1, station: it.station, desc: String(it.desc || ''), image: '', hidden: false, rec: false,
      sku: '', unit: '', dec: false, price2: 0, track: false, stock: 0, cost: 0, min: 0 })),
    nextId: Math.max.apply(null, m.items.map(it => it.id)) + 1,
    nextCatId: m.categories.length + 1
  };
}

/* ---------- normalize: ตรวจและซ่อมทุกระเบียนที่อ่านจาก data.json หรือไฟล์สำรอง ----------
   ระเบียนที่เสียถูกตัดทิ้ง (นับไว้ใน report.dropped) แทนที่จะปล่อยให้หน้าพนักงานพังทั้งหน้า */
const TICKET_STATUS = ['new', 'cooking', 'ready', 'served'];
/* เอกสาร: QT ใบเสนอราคา · INV ใบแจ้งหนี้/ใบส่งของ (รับชำระแล้วออกใบเสร็จ) · PO ใบสั่งซื้อ · GR ใบรับสินค้า · OUT ใบเบิก/ตัดสต็อก · CNT ใบตรวจนับ */
const DOC_STATUS = { QT: ['open', 'accepted', 'cancelled'], INV: ['unpaid', 'paid', 'cancelled'], PO: ['open', 'received', 'cancelled'], GR: ['done'], OUT: ['done'], CNT: ['done'] };
const DOC_FINAL = new Set(['accepted', 'cancelled', 'paid', 'received', 'done']);
const DOC_NO_RE = /^(QT|INV|PO|GR|OUT|CNT)(\d{4})-(\d{4,6})$/;
const MOVE_ID_RE = /^m[a-z0-9]+-\d+$/;
const CONTACT_LIM = { taxId: 13, branch: 30, address: 200, phone: 40, email: 80, note: 120 };
function cleanDocLine(l) {
  if (!l || !isStr(l.name) || !l.name.trim() || !isNum(l.qty) || !isNum(l.price)) return null;
  const o = { name: l.name.slice(0, 120), qty: l.qty, unit: isStr(l.unit) ? l.unit.slice(0, 12) : '', price: l.price };
  if (isInt(l.id)) o.id = l.id;
  ['got', 'before', 'after'].forEach(k => { if (isNum(l[k])) o[k] = l[k]; });
  return o;
}
function raiseSeq(seq, no) {
  const m = DOC_NO_RE.exec(no), s = m && seq[m[1]];
  if (!s) return;
  const y = +m[2], n = +m[3];
  if (y > s.y) { s.y = y; s.n = n; } else if (y === s.y && n > s.n) s.n = n;
}
// ตรวจและซ่อมเอกสารหนึ่งฉบับ (จาก data.json, ไฟล์สำรอง หรือ journal/) false = เสียจนใช้ไม่ได้
function cleanDoc(d) {
  if (!d || !DOC_STATUS[d.type] || !isStr(d.no) || !DOC_NO_RE.test(d.no) || d.no.indexOf(d.type) !== 0 || !isNum(d.date) || !Array.isArray(d.lines)) return false;
  if (!DOC_STATUS[d.type].includes(d.status)) return false;
  d.lines = d.lines.map(cleanDocLine).filter(Boolean);
  d.vat = d.vat === true;
  d.discount = isNum(d.discount) && d.discount >= 0 ? d.discount : 0;
  if (['sub', 'disc', 'net', 'vatAmt', 'total'].some(k => !isNum(d[k]))) Object.assign(d, docTotals(d.lines, d.discount, d.vat));
  const pt = d.party && typeof d.party === 'object' ? d.party : {};
  d.party = { name: isStr(pt.name) ? pt.name.slice(0, 100) : '' };
  ['address', 'taxId', 'branch', 'phone'].forEach(k => { d.party[k] = isStr(pt[k]) ? pt[k].slice(0, CONTACT_LIM[k]) : ''; });
  if (isStr(pt.contactId) && /^c\d+$/.test(pt.contactId)) d.party.contactId = pt.contactId;
  d.rev = isInt(d.rev) && d.rev >= 1 ? d.rev : 1;
  d.due = isNum(d.due) ? d.due : null;
  d.note = isStr(d.note) ? d.note.slice(0, 300) : '';
  d.ref = isStr(d.ref) && DOC_NO_RE.test(d.ref) ? d.ref : '';
  d.issuer = d.issuer && typeof d.issuer === 'object' && isStr(d.issuer.name) ? { id: String(d.issuer.id || '').slice(0, 10), name: d.issuer.name.slice(0, 30) } : null;
  if (!isNum(d.createdAt)) d.createdAt = d.date;
  if (!isNum(d.updatedAt)) d.updatedAt = d.createdAt;
  // ผลของเอกสาร: รับชำระ (ใบเสร็จเลขบิล) รับของ ยกเลิก
  ['paidAt', 'receivedAt', 'receipt'].forEach(k => { if (d[k] !== undefined && !isNum(d[k])) delete d[k]; });
  if (d.method !== undefined && d.method !== 'cash' && d.method !== 'transfer') delete d.method;
  if (d.cancelReason !== undefined) d.cancelReason = isStr(d.cancelReason) ? d.cancelReason.slice(0, 80) : '';
  return true;
}
/* ยอดเงินของเอกสาร: แต่ละแถวปัดเป็นสตางค์ → รวม → หักส่วนลดท้ายเอกสาร (ไม่เกินยอดรวม) → VAT 7% คิดเพิ่มปัดเป็นสตางค์ (ใบกำกับภาษีแสดง VAT ถึงสตางค์)
   สูตรนี้มีสองที่: ที่นี่ และ docCalc() ใน staff.html ต้องตรงกันทุกสตางค์ */
function docTotals(lines, discount, vatOn) {
  const r2 = n => Math.round(n * 100) / 100;
  const sub = r2(lines.reduce((a, l) => a + r2(l.qty * l.price), 0));
  const disc = Math.min(sub, r2(Math.max(0, +discount || 0)));
  const net = r2(sub - disc), vatAmt = vatOn ? r2(net * 0.07) : 0;
  return { sub, disc, net, vatAmt, total: r2(net + vatAmt) };
}
// จำนวนเป็นทศนิยมได้ (สินค้าขายตามน้ำหนัก เช่น 0.35 กก. จากหน้าขายหน้าร้าน) สั่งผ่าน QR ยังเป็นจำนวนเต็มเสมอ
const okQty = q => isNum(q) && q > 0;
function cleanLine(i) {
  if (!i || !isInt(i.id) || !isStr(i.name) || !isNum(i.price) || !okQty(i.qty)) return null;
  return { id: i.id, name: i.name, price: i.price, qty: i.qty, note: Array.isArray(i.note) ? i.note.filter(isStr) : [] };
}
// โหมดการขาย: ทุกช่องเป็น true/false ต้องมีทางขายอย่างน้อยหนึ่งทาง (โต๊ะ หน้าร้าน หรือใบแจ้งหนี้) ไม่มี = ใช้แบบเดิม
function cleanModes(v) {
  if (!v || typeof v !== 'object') return Object.assign({}, biz.LEGACY_MODES);
  const m = { table: v.table === true, kitchen: v.kitchen === true, counter: v.counter === true, buy: v.buy === true, stock: v.stock === true, docs: v.docs === true };
  return m.table || m.counter || m.docs ? m : Object.assign({}, biz.LEGACY_MODES);
}
function normalize(x, report) {
  report = report || { dropped: 0 };
  const drop = () => { report.dropped++; return false; };
  x = x && typeof x === 'object' && !Array.isArray(x) ? x : {};
  const st = Object.assign({
    shop: 'ร้านของฉัน', address: '', phone: '', taxId: '', footer: 'ขอบคุณที่ใช้บริการ',
    promptpay: '', tables: 12, svc: true, vat: false, baseUrl: '', soldOut: [], acceptOrders: true, accent: '', logo: '', cover: '', payQr: '',
    requireSeat: false, hours: { on: false, open: '10:00', close: '22:00' },
    tagline: '', look: 'dark', social: {}, shareUrl: '', biz: '',
    creditDays: 30, quoteDays: 30, docNote: '', branch: ''
  }, x.settings && typeof x.settings === 'object' ? x.settings : {});
  ['shop', 'address', 'phone', 'taxId', 'footer', 'promptpay', 'baseUrl'].forEach(k => { if (!isStr(st[k])) st[k] = ''; });
  if (!st.shop) st.shop = 'ร้านของฉัน';
  ['svc', 'vat', 'acceptOrders'].forEach(k => { st[k] = !!st[k]; });
  st.tables = isInt(st.tables) && st.tables >= 1 && st.tables <= 60 ? st.tables : 12;
  st.soldOut = Array.isArray(st.soldOut) ? st.soldOut.filter(isInt) : [];
  // ธีมร้าน: สีปุ่มหลัก ('' = สีตั้งต้น) และไฟล์โลโก้ใน images/
  st.accent = isStr(st.accent) && theme.derive(st.accent).ok ? st.accent.toLowerCase() : '';
  st.logo = isStr(st.logo) && C.LOGO_RE.test(st.logo) ? st.logo : '';
  st.cover = isStr(st.cover) && C.COVER_RE.test(st.cover) ? st.cover : '';   // ภาพพื้นหลังหน้าลูกค้า
  st.payQr = isStr(st.payQr) && C.PAYQR_RE.test(st.payQr) ? st.payQr : '';   // รูป QR รับเงินที่ร้านอัปโหลด (ใช้แทน QR จากเบอร์ PromptPay)
  // ต้องเปิดโต๊ะก่อนลูกค้าสั่ง / ปิดรับ QR อัตโนมัติตามเวลา (HH:MM เวลาเครื่องร้าน)
  st.requireSeat = st.requireSeat === true;
  const hh = st.hours && typeof st.hours === 'object' ? st.hours : {}, HM = /^([01]\d|2[0-3]):[0-5]\d$/;
  st.hours = { on: hh.on === true, open: HM.test(hh.open) ? hh.open : '10:00', close: HM.test(hh.close) ? hh.close : '22:00' };
  // หน้าลูกค้า: คำโปรยใต้ชื่อร้าน, โทนสี (มืด/สว่าง/ตามเครื่องลูกค้า), ลิงก์โซเชียลมีเดียและลิงก์แชร์ร้าน
  // ลิงก์จากดิสก์/ไฟล์สำรองผ่าน cleanLink อีกรอบ (โดเมนผิด / javascript: กลายเป็นว่าง ไม่ขึ้นเป็นปุ่มในหน้าลูกค้า)
  st.tagline = isStr(st.tagline) ? st.tagline.slice(0, 80) : '';
  st.look = ['dark', 'light', 'auto'].includes(st.look) ? st.look : 'dark';
  const so = st.social && typeof st.social === 'object' ? st.social : {};
  st.social = {};
  ['facebook', 'instagram', 'line', 'tiktok'].forEach(k => { const r = U.cleanLink(k, so[k]); st.social[k] = r.ok ? r.url : ''; });
  const sh = U.cleanLink('share', st.shareUrl);
  st.shareUrl = sh.ok ? sh.url : '';
  // ประเภทธุรกิจ ('' = ยังไม่ได้เลือก ทำงานแบบร้านอาหาร) และโหมดการขาย (ข้อมูลเดิมไม่มี = โต๊ะ + ครัว เหมือนก่อน)
  st.biz = biz.KEYS.includes(st.biz) ? st.biz : '';
  st.modes = cleanModes(st.modes);
  // เอกสาร: เครดิตกี่วัน (ครบกำหนดชำระใบแจ้งหนี้) ยืนราคากี่วัน (ใบเสนอราคา) หมายเหตุท้ายเอกสาร สาขาของร้าน ('' = สำนักงานใหญ่)
  st.creditDays = isInt(st.creditDays) && st.creditDays >= 0 && st.creditDays <= 365 ? st.creditDays : 30;
  st.quoteDays = isInt(st.quoteDays) && st.quoteDays >= 1 && st.quoteDays <= 365 ? st.quoteDays : 30;
  st.docNote = isStr(st.docNote) ? st.docNote.slice(0, 300) : '';
  st.branch = isStr(st.branch) ? st.branch.slice(0, 30) : '';
  x.settings = st;

  // table 0 = ออเดอร์จากขายหน้าร้านที่จ่ายเงินแล้ว ต้องมีเลขคิว (q) ไม่อยู่ในบิลของโต๊ะใด
  x.tickets = (Array.isArray(x.tickets) ? x.tickets : []).filter(t => {
    if (!t || !isInt(t.id) || !isInt(t.table) || t.table < 0 || t.table > 60 || !Array.isArray(t.items)) return drop();
    if (t.table === 0 && !(isInt(t.q) && t.q >= 1)) return drop();
    if (t.table !== 0) delete t.q;
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
    s.items = s.items.filter(i => i && isStr(i.name) && okQty(i.qty));
    // kind 'buy' = ร้านรับซื้อของจ่ายเงินให้ลูกค้า (ไม่ใช่ยอดขาย) ไม่มี = ขาย
    if (s.kind !== 'buy') delete s.kind;
    if (s.memo !== undefined && !isStr(s.memo)) delete s.memo;
    if (s.q !== undefined && !isInt(s.q)) delete s.q;
    // บิลที่มาจากรับชำระใบแจ้งหนี้: ส่วนลดท้ายเอกสาร และเลขที่เอกสาร
    if (s.disc !== undefined && !(isNum(s.disc) && s.disc >= 0)) delete s.disc;
    if (s.doc !== undefined && !(isStr(s.doc) && DOC_NO_RE.test(s.doc))) delete s.doc;
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
  // โต๊ะที่พนักงานกด "เปิดโต๊ะ" แล้ว { [table]: { at } } ปิดบิลแล้วหายเอง
  const seated = {};
  if (x.seated && typeof x.seated === 'object') Object.keys(x.seated).forEach(k => { const t = +k, v = x.seated[k]; if (isInt(t) && t >= 1 && t <= 60 && v && isInt(v.at)) seated[t] = { at: v.at }; else drop(); });
  x.seated = seated;
  // โต๊ะที่ยังเปิดอยู่ต้องไม่หายไปเพราะจำนวนโต๊ะในไฟล์น้อยกว่า
  st.tables = Math.max(st.tables, ...x.tickets.map(t => t.table), ...Object.keys(calls).map(Number));
  x.nextTicket = Math.max(isInt(x.nextTicket) ? x.nextTicket : 1, 1 + Math.max(0, ...x.tickets.map(t => t.id)));
  x.nextBill = Math.max(isInt(x.nextBill) ? x.nextBill : 1, 1 + Math.max(0, ...x.sales.map(s => s.no)));
  // เลขคิวขายหน้าร้าน เริ่ม 1 ใหม่ทุกวัน
  const qd = x.queue && typeof x.queue === 'object' ? x.queue : {};
  x.queue = { day: isStr(qd.day) && /^\d{8}$/.test(qd.day) ? qd.day : '', n: isInt(qd.n) && qd.n >= 0 ? qd.n : 0 };
  if (!isStr(x.secret) || x.secret.length < 16) x.secret = crypto.randomBytes(16).toString('hex');
  // พนักงาน (บัญชีเจ้าของร้านมาจาก STAFF_PIN ไม่อยู่ในนี้) PIN เก็บเป็น HMAC เท่านั้น
  const sids = new Set();
  x.staff = (Array.isArray(x.staff) ? x.staff : []).filter(s => {
    if (!s || !isStr(s.id) || !/^s\d+$/.test(s.id) || sids.has(s.id) || !isStr(s.name) || !s.name ||
      !['owner', 'cashier', 'waiter', 'kitchen'].includes(s.role) || !isStr(s.pinHash) || !/^[a-f0-9]{64}$/.test(s.pinHash)) return drop();
    sids.add(s.id);
    s.active = s.active !== false;
    s.ver = isInt(s.ver) ? s.ver : 0;
    return true;
  });
  x.nextStaffId = Math.max(isInt(x.nextStaffId) ? x.nextStaffId : 1, 1 + Math.max(0, ...x.staff.map(s => +s.id.slice(1))));
  x.ownerVer = isInt(x.ownerVer) ? x.ownerVer : 0;
  // ผู้ติดต่อ (ลูกค้า/ผู้ขาย) ใช้เติมหัวเอกสาร เอกสารที่ออกแล้วเก็บสำเนาชื่อที่อยู่ของตัวเอง แก้ผู้ติดต่อทีหลังเอกสารเดิมไม่เปลี่ยน
  const cids = new Set();
  x.contacts = (Array.isArray(x.contacts) ? x.contacts : []).filter(c => {
    if (!c || !isStr(c.id) || !/^c\d+$/.test(c.id) || cids.has(c.id) || !isStr(c.name) || !c.name.trim()) return drop();
    cids.add(c.id);
    c.kind = ['customer', 'supplier', 'both'].includes(c.kind) ? c.kind : 'customer';
    Object.keys(CONTACT_LIM).forEach(k => { c[k] = isStr(c[k]) ? c[k].slice(0, CONTACT_LIM[k]) : ''; });
    return true;
  });
  x.nextContactId = Math.max(isInt(x.nextContactId) ? x.nextContactId : 1, 1 + Math.max(0, ...x.contacts.map(c => +c.id.slice(1))));
  // เอกสาร: ที่ยังค้างอยู่ทั้งหมด + ที่จบแล้วไม่เกิน KEEP_DAYS วัน (ทุกฉบับทุกครั้งที่เปลี่ยนอยู่ใน journal/docs-*.jsonl)
  const dnos = new Set();
  x.docs = (Array.isArray(x.docs) ? x.docs : []).filter(d => {
    if (!cleanDoc(d) || dnos.has(d.no)) return drop();
    dnos.add(d.no);
    return true;
  });
  // เลขเอกสารล่าสุดของแต่ละประเภทในปีนั้น ห้ามย้อนหรือซ้ำ (แบบเดียวกับเลขบิล กฎข้อ 21)
  const ds = x.docSeq && typeof x.docSeq === 'object' ? x.docSeq : {};
  x.docSeq = {};
  Object.keys(DOC_STATUS).forEach(t => { const v = ds[t]; x.docSeq[t] = v && isInt(v.y) && isInt(v.n) && v.n >= 0 ? { y: v.y, n: v.n } : { y: 0, n: 0 }; });
  x.docs.forEach(d => raiseSeq(x.docSeq, d.no));
  // ความเคลื่อนไหวสต็อกล่าสุด (วันนี้และเมื่อวาน) ไว้เทียบกับ journal/stock-*.jsonl ตอนเปิดระบบ
  x.moves = (Array.isArray(x.moves) ? x.moves : []).filter(v => (v && isStr(v.id) && MOVE_ID_RE.test(v.id) && isNum(v.at) && isInt(v.item) && isNum(v.qty) && isNum(v.bal)) || drop());

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
      i.image = isStr(i.image) && C.MENU_IMG_RE.test(i.image) ? i.image : '';
      i.hidden = !!i.hidden;
      i.rec = i.rec === true;          // เมนูแนะนำ (ขึ้นแถวบนสุดของหน้าลูกค้า)
      // ขายหน้าร้าน: รหัสสินค้า/บาร์โค้ด, หน่วย, ขายเป็นทศนิยม (น้ำหนัก ความยาว), ราคาส่ง (0 = ไม่มี)
      i.sku = isStr(i.sku) ? U.str(i.sku, 32) : '';
      i.unit = isStr(i.unit) ? U.str(i.unit, 12) : '';
      i.dec = i.dec === true;
      i.price2 = isNum(i.price2) && i.price2 > 0 ? i.price2 : 0;
      // สต็อก: นับหรือไม่ (track) ยอดคงเหลือ (ติดลบได้ = ขายเกินที่บันทึกไว้ ให้ตรวจนับ) ต้นทุนต่อหน่วยล่าสุด จุดสั่งซื้อ (เตือนใกล้หมด)
      i.track = i.track === true;
      i.stock = isNum(i.stock) ? Math.round(i.stock * 1000) / 1000 : 0;
      i.cost = isNum(i.cost) && i.cost >= 0 ? i.cost : 0;
      i.min = isNum(i.min) && i.min >= 0 ? i.min : 0;
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
// (บันทึกที่ล้มแล้วลองใหม่ด้วย timer ไม่ได้ผูกกับคำขอใด หน้าจอจะไม่รู้ว่าป้ายเตือนควรขึ้นหรือหายถ้าไม่บอก)
let onHealthChange = () => {};
function setHealthListener(fn) { onHealthChange = fn; }
// แยกสถานะ data.json, sales/, logs/ และ journal/ (สต็อก เอกสาร) ป้ายเตือนหายเมื่อบันทึกได้ครบทุกอย่างเท่านั้น
const failing = { data: null, sales: null, logs: null, stock: null, docs: null };
function noteSave(kind, err) {
  const msg = err ? err.message : null;
  if (msg && msg !== failing[kind]) {
    console.error({ sales: 'บันทึกยอดขายไม่สำเร็จ:', logs: 'บันทึก log ไม่สำเร็จ:', stock: 'บันทึกประวัติสต็อกไม่สำเร็จ:', docs: 'บันทึกเอกสารไม่สำเร็จ:' }[kind] || 'บันทึกข้อมูลไม่สำเร็จ:', msg);
    if (kind !== 'logs') log.app('error', 'save_failed', { what: kind, error: msg });
  }
  failing[kind] = msg;
  const now = Object.keys(failing).map(k => failing[k]).find(Boolean);
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
/* ---------- journal/: ประวัติสต็อก (stock-YYYY-MM.jsonl) และเอกสาร (docs-YYYY-MM.jsonl ทุกครั้งที่เอกสารเปลี่ยน ฉบับล่าสุด = rev สูงสุด) ----------
   หลักเดียวกับ sales/: เขียนต่อท้ายทันทีก่อนตอบ เขียนไม่ได้เข้าคิวลองใหม่ด้วย timer (ห้ามหยุดรอ กฎข้อ 17) ป้ายเตือนหายเมื่อเขียนครบ
   ตอนเปิดระบบและหลังกู้คืน เทียบรายการล่าสุดใน data.json (D.moves, D.docs) กับไฟล์ แล้วเติมที่ขาด
   คิวเก็บเป็นข้อความที่ serialize แล้ว (เอกสารถูกแก้ต่อได้ ถ้าเก็บ reference ไว้ เขียนทีหลังจะได้เนื้อหาใหม่กว่า rev ที่บันทึก) */
function journal(kind, fileOf, keyOf, recent) {
  const q = [];
  let timer = null, fails = 0, check = false;
  const entry = r => ({ file: fileOf(r), key: keyOf(r), line: JSON.stringify(r) + '\n' });
  function write(e) { fs.mkdirSync(C.JOURNAL_DIR, { recursive: true }); fs.appendFileSync(path.join(C.JOURNAL_DIR, e.file), e.line); }
  // อ่านไม่ได้ให้ throw (ลองใหม่ทีหลัง) ห้ามถือว่าว่าง ไม่อย่างนั้นจะเขียนซ้ำทั้งเดือน
  function keysIn(file) {
    let text;
    try { text = fs.readFileSync(path.join(C.JOURNAL_DIR, file), 'utf8'); }
    catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return new Set(); throw e; }
    const out = new Set();
    text.split('\n').forEach(l => { try { const r = JSON.parse(l); if (r) out.add(keyOf(r)); } catch (e) { /* บรรทัดว่างหรือเสีย */ } });
    return out;
  }
  function flush() {
    clearTimeout(timer); timer = null;
    if (state.restoring) { timer = setTimeout(flush, 1000); return; }
    try {
      if (check) {
        const have = {}, missing = [];
        recent().forEach(r => { const e = entry(r); if (!have[e.file]) have[e.file] = keysIn(e.file); if (!have[e.file].has(e.key)) missing.push(e); });
        q.length = 0; q.push(...missing); check = false;
      }
      while (q.length) { write(q[0]); q.shift(); }
      fails = 0; noteSave(kind, null);
    } catch (e) { failed(kind, e, fails); timer = setTimeout(flush, backoff(fails++)); }
  }
  return {
    add(r) { q.push(entry(r)); flush(); },
    reconcile() { check = true; flush(); },
    final() {
      clearTimeout(timer);
      if (check) return;
      try { while (q.length) { U.retry(() => write(q[0])); q.shift(); } } catch (e) { console.error('บันทึก journal/' + kind + ' ไม่สำเร็จ:', e.message); }
    }
  };
}
const moveLog = journal('stock', v => 'stock-' + U.monthKey(v.at) + '.jsonl', v => v.id, () => state.D.moves);
const docLog = journal('docs', d => 'docs-' + U.monthKey(d.date) + '.jsonl', d => d.no + '#' + d.rev, () => state.D.docs);
function reconcileJournals() { moveLog.reconcile(); docLog.reconcile(); }
// อ่านไฟล์ใน journal/ แบบ async (เปิดดูย้อนหลังระหว่างร้านเปิดอยู่ ห้ามค้างทั้งระบบ) ไฟล์ไม่มี = ว่าง
async function readJournal(file) {
  if (!C.JOURNAL_RE.test(file)) return [];
  let text = '';
  try { text = await fsp.readFile(path.join(C.JOURNAL_DIR, file), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const out = [];
  text.split('\n').forEach(l => { if (!l) return; try { const r = JSON.parse(l); if (r && typeof r === 'object') out.push(r); } catch (e) { /* บรรทัดเสีย */ } });
  return out;
}
// เลขเอกสารห้ามซ้ำแม้ data.json ย้อนไปฉบับเก่า (กู้จาก .bak) ดูเลขสูงสุดของปีนี้ในไฟล์ด้วย (ไฟล์ปีนี้มีไม่เกิน 12 ไฟล์ อ่านตอนเปิดระบบครั้งเดียว)
function raiseSeqFromJournal() {
  const y = new Date().getFullYear();
  U.listDir(C.JOURNAL_DIR, C.JOURNAL_RE).filter(f => f.startsWith('docs-' + y + '-')).forEach(f => {
    let text = '';
    try { text = fs.readFileSync(path.join(C.JOURNAL_DIR, f), 'utf8'); } catch (e) { console.error('อ่าน journal/' + f + ' ไม่ได้ ตรวจเลขเอกสารล่าสุดไม่ได้:', e.message); return; }
    text.split('\n').forEach(l => { try { const r = JSON.parse(l); if (r && isStr(r.no)) raiseSeq(state.D.docSeq, r.no); } catch (e) { /* บรรทัดเสีย */ } });
  });
}

// ปิดโปรแกรม: ไม่มีคำขออื่นรออยู่แล้ว จึงลองซ้ำแบบหยุดรอได้ ยอดขายที่ยังเขียนไม่ได้ เปิดครั้งหน้าจะเติมให้เอง
function writeFinal() {
  clearTimeout(saveTimer); clearTimeout(salesTimer);
  moveLog.final(); docLog.final();
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
// เรียกทุกครั้งที่มีบิลใหม่ ตัดเอกสารที่จบแล้วและความเคลื่อนไหวสต็อกเก่าไปด้วย (ร้านที่เปิดเครื่องทิ้งไว้หลายสัปดาห์ data.json ไม่โตเรื่อยๆ)
function trimSales() {
  const cut = U.dayStart(Date.now()) - (C.KEEP_DAYS - 1) * C.DAY;
  state.D.sales = state.D.sales.filter(s => s.at >= cut);
  trimJournals();
}
// เอกสารที่จบแล้วเกิน KEEP_DAYS วัน และใบเสนอราคาที่ค้างเกิน 90 วัน ออกจาก data.json (ยังอยู่ใน journal/ ค้นย้อนหลังได้)
// ความเคลื่อนไหวสต็อกเก็บแค่วันนี้กับเมื่อวาน (พอสำหรับเทียบกับไฟล์ตอนเปิดระบบ)
function trimJournals() {
  const D = state.D, now = Date.now(), cut = U.dayStart(now) - (C.KEEP_DAYS - 1) * C.DAY;
  D.docs = D.docs.filter(d => !(DOC_FINAL.has(d.status) && d.updatedAt < cut) && !(d.type === 'QT' && d.updatedAt < now - 90 * C.DAY));
  D.moves = D.moves.filter(v => v.at >= U.dayStart(now) - C.DAY);
}
/* ---------- เอกสารและสต็อก ---------- */
// เลขที่ถัดไปของประเภทนั้น เช่น INV2026-0007 เริ่ม 1 ใหม่ทุกปี (ตามปีที่ออก)
function nextDocNo(type) {
  const y = new Date().getFullYear(), s = state.D.docSeq[type];
  if (s.y < y) { s.y = y; s.n = 0; }
  s.n++;
  return type + s.y + '-' + String(s.n).padStart(4, '0');
}
// เอกสารเปลี่ยน (รวมสร้างใหม่): rev เพิ่ม บันทึกฉบับนี้ลง journal ทันที
function docChanged(d) {
  d.rev = (d.rev || 0) + 1; d.updatedAt = Date.now();
  if (!state.D.docs.includes(d)) state.D.docs.push(d);
  docLog.add(d);
}
// สต็อกเปลี่ยน delta หน่วย (ขาย = ติดลบ) บันทึกความเคลื่อนไหวพร้อมยอดคงเหลือหลังเปลี่ยน
let moveSeq = 0;
function stockMove(m, delta, kind, ref, note) {
  m.stock = Math.round((m.stock + delta) * 1000) / 1000;
  const v = { id: 'm' + Date.now().toString(36) + '-' + (++moveSeq), at: Date.now(), item: m.id, name: m.name, unit: m.unit || '', qty: Math.round(delta * 1000) / 1000, bal: m.stock, kind, ref: ref || '' };
  if (note) v.note = note;
  state.D.moves.push(v);
  moveLog.add(v);
  return v;
}
// นับสต็อกอยู่ไหม (ร้านเปิดสต็อก + สินค้านี้นับ)
function tracked(m) { return !!m && state.D.settings.modes.stock && m.track; }
// หน้าลูกค้า (QR) สั่งของที่นับสต็อกแล้วหมดไม่ได้ (หน้าขายหน้าร้านขายได้ แค่เตือน เพราะของอยู่ในมือแคชเชียร์แล้ว ยอดในระบบอาจผิด)
function outOfStock(m) { return tracked(m) && m.stock <= 0; }
function soldOutIds() {
  const D = state.D, ids = new Set(D.settings.soldOut);
  D.menu.items.forEach(m => { if (outOfStock(m)) ids.add(m.id); });
  return Array.from(ids);
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
  reconcileJournals();  // ก่อน trimJournals ด้วยเหตุผลเดียวกัน
  // บิลที่ลง sales/ แล้วแต่ data.json บันทึกไม่ทัน (เขียนไม่ได้แล้วโปรแกรมดับ) ห้ามถูกใช้เลขซ้ำ เลขเอกสารก็เช่นกัน
  state.D.nextBill = Math.max(state.D.nextBill, 1 + maxArchivedNo());
  raiseSeqFromJournal();
  trimSales();
  trimJournals();
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
  const s = new Set(state.D.tickets.filter(k => k.table >= 1).map(k => k.table));
  Object.keys(state.D.calls).forEach(t => s.add(+t));
  Object.keys(state.D.seated || {}).forEach(t => s.add(+t));
  return Array.from(s);
}
function menuItem(id) { return state.D.menu.items.find(m => m.id === id); }
// เลขคิวถัดไปของวันนี้ (ขายหน้าร้านที่ส่งเข้าจอครัว/บาร์)
function nextQueue() {
  const D = state.D, day = U.ymd(Date.now());
  if (D.queue.day !== day) D.queue = { day, n: 0 };
  return ++D.queue.n;
}
function removeImageFile(name) { if (name && C.IMG_RE.test(name)) { try { fs.unlinkSync(path.join(C.IMG_DIR, name)); } catch (e) { /* ignore */ } } }

module.exports = {
  state, seedMenu, normalize, load, save, writeNow, writeFinal, archiveSale, reconcileSales, trimSales, ensureKeys, setHealthListener,
  billOf, totals, openTableNumbers, menuItem, nextQueue, removeImageFile,
  DOC_STATUS, DOC_FINAL, DOC_NO_RE, CONTACT_LIM, docTotals, nextDocNo, docChanged, stockMove, tracked, outOfStock, soldOutIds,
  reconcileJournals, trimJournals, readJournal, raiseSeqFromJournal, raiseSeq, cleanDoc
};
