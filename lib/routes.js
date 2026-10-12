'use strict';
/* API ทั้งหมด: ลูกค้า (ต้องมีรหัส QR ของโต๊ะ) และพนักงาน (ต้องเข้าสู่ระบบ) */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const C = require('./config');
const U = require('./util');
const store = require('./store');
const backup = require('./backup');
const { state: st } = store;
const { fail, send, readBody, readRaw, str } = U;

/* ---------- เครือข่าย / สิทธิ์ ---------- */
function lanCandidates() {
  const out = [], nets = os.networkInterfaces();
  Object.keys(nets).forEach(name => (nets[name] || []).forEach(n => {
    if ((n.family === 'IPv4' || n.family === 4) && !n.internal) out.push(n.address);
  }));
  const rank = a => a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3;
  return out.sort((a, b) => rank(a) - rank(b));
}
function lanUrl() { const c = lanCandidates(); return 'http://' + (c[0] || 'localhost') + ':' + C.PORT; }

function staffToken() { return crypto.createHash('sha256').update(C.PIN + st.D.secret).digest('hex'); }
function staffCookie() { return 'st=' + staffToken() + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000'; }
function isStaff(req) {
  const c = (req.headers.cookie || '').split(/;\s*/).find(x => x.startsWith('st='));
  return !!c && U.safeEq(c.slice(3), staffToken());
}
function requireStaff(req) { if (!isStaff(req)) throw fail('ต้องเข้าสู่ระบบพนักงาน', 401); }
function isLoopback(a) { return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'; }
function ipOf(req) {
  // เชื่อ header ของ proxy เฉพาะคำขอที่มาจากเครื่องนี้เอง (cloudflared รันบนเครื่องเดียวกัน)
  // ไม่อย่างนั้นคนใน WiFi ร้านจะปลอม header เพื่อหลบลิมิตการเดารหัสพนักงานได้
  if (C.TRUST_PROXY && isLoopback(req.socket.remoteAddress)) {
    const h = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (h) return h;
  }
  return req.socket.remoteAddress || 'x';
}
const hits = new Map();
function limited(kind, ip, max, windowMs) {
  const k = kind + '|' + ip, now = Date.now();
  const arr = (hits.get(k) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { hits.set(k, arr); return true; }
  arr.push(now); hits.set(k, arr);
  return false;
}
const recentOrders = new Map();     // กันสั่งซ้ำเมื่อเน็ตหลุดแล้วลูกค้ากดส่งใหม่
setInterval(() => {
  const now = Date.now();
  hits.forEach((arr, k) => { if (!arr.length || now - arr[arr.length - 1] > 120000) hits.delete(k); });
  recentOrders.forEach((v, k) => { if (now - v.at > 600000) recentOrders.delete(k); });
}, 60000).unref();

function tableNo(v) {
  const t = Math.floor(+v);
  if (!(t >= 1 && t <= st.D.settings.tables)) throw fail('ไม่พบโต๊ะนี้');
  return t;
}
function checkAccess(req, t, key) {
  if (isStaff(req)) return;
  if (!key || !st.D.keys[t] || !U.safeEq(key, st.D.keys[t])) throw fail('QR ของโต๊ะไม่ถูกต้อง กรุณาสแกนใหม่ที่โต๊ะ', 403);
}

/* ---------- live update ไปหน้าพนักงาน (SSE) ---------- */
const clients = new Set();
function broadcast() { clients.forEach(r => { try { r.write('event: change\ndata: {}\n\n'); } catch (e) { clients.delete(r); } }); }
setInterval(() => clients.forEach(r => { try { r.write(': ping\n\n'); } catch (e) { clients.delete(r); } }), 25000).unref();
store.setHealthListener(broadcast);
function changed() { store.save(); broadcast(); }
function menuChanged() { st.D.menu.version++; changed(); }

/* ---------- API ---------- */
const api = {
  'POST /api/login': async (req, res) => {
    if (limited('login', ipOf(req), 6, 60000)) throw fail('ลองบ่อยเกินไป รอสักครู่', 429);
    const b = await readBody(req, C.BODY_LIMIT);
    if (!U.safeEq(String(b.pin || ''), C.PIN)) throw fail('รหัสไม่ถูกต้อง', 401);
    send(res, 200, { ok: true }, { 'Set-Cookie': staffCookie() });
  },

  'POST /api/logout': async (req, res) => {
    send(res, 200, { ok: true }, { 'Set-Cookie': 'st=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
  },

  /* ---- ลูกค้า ---- */
  'GET /api/menu': async (req, res) => {
    const D = st.D;
    const vis = D.menu.items.filter(m => !m.hidden);
    const used = new Set(vis.map(m => m.cat));
    send(res, 200, {
      shop: D.settings.shop, version: D.menu.version, notes: D.menu.notes,
      categories: D.menu.categories.filter(c => used.has(c.id)),
      items: vis.map(m => ({ id: m.id, name: m.name, price: m.price, cat: m.cat, desc: m.desc, image: m.image, soldOut: D.settings.soldOut.includes(m.id) })),
      svc: D.settings.svc, vat: D.settings.vat, tables: D.settings.tables
    });
  },

  'GET /api/table': async (req, res, url) => {
    const D = st.D;
    const t = tableNo(url.searchParams.get('t'));
    checkAccess(req, t, url.searchParams.get('k'));
    const b = store.billOf(t);
    send(res, 200, {
      table: t, staff: isStaff(req), sub: b.sub, call: D.calls[t] || null, menuVersion: D.menu.version,
      open: D.settings.acceptOrders, soldOut: D.settings.soldOut, svc: D.settings.svc, vat: D.settings.vat,
      tickets: D.tickets.filter(k => k.table === t).map(k => ({ id: k.id, status: k.status, createdAt: k.createdAt, items: k.items }))
    });
  },

  'POST /api/order': async (req, res) => {
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D;
    const t = tableNo(b.table);
    checkAccess(req, t, b.key);
    const staff = isStaff(req);
    const reqId = typeof b.reqId === 'string' && /^[a-f0-9]{8,64}$/.test(b.reqId) ? t + ':' + b.reqId : null;
    if (reqId && recentOrders.has(reqId)) return send(res, 200, recentOrders.get(reqId).result);
    if (!staff && !D.settings.acceptOrders) throw fail('ร้านปิดรับออเดอร์ผ่าน QR ชั่วคราว กรุณาเรียกพนักงาน', 403);
    if (!staff && limited('order', ipOf(req), C.ORDER_LIMIT, 60000)) throw fail('สั่งถี่เกินไป กรุณารอสักครู่', 429);
    if (!Array.isArray(b.items) || !b.items.length) throw fail('ยังไม่ได้เลือกอาหาร');
    if (b.items.length > 40) throw fail('สั่งครั้งละไม่เกิน 40 เมนู');
    const groups = {}; let count = 0;
    for (const it of b.items) {
      const m = store.menuItem(it && +it.id);
      if (!m || m.hidden) throw fail('มีเมนูที่ไม่มีขายแล้ว กรุณารีเฟรชหน้าเมนู');
      if (D.settings.soldOut.includes(m.id)) throw fail(m.name + ' หมดแล้ว');
      const qty = Math.floor(+it.qty);
      if (!(qty >= 1 && qty <= 20)) throw fail('จำนวนไม่ถูกต้อง');
      const note = (Array.isArray(it.note) ? it.note : []).filter(n => D.menu.notes.includes(n)).slice(0, 10);
      count += qty;
      const station = D.menu.stations[m.station] ? m.station : Object.keys(D.menu.stations)[0];
      (groups[station] = groups[station] || []).push({ id: m.id, name: m.name, price: m.price, qty, note });
    }
    if (count > 60) throw fail('สั่งครั้งละไม่เกิน 60 รายการ');
    const memo = str(b.memo, 80);
    const made = [];
    Object.keys(groups).forEach(s => {
      const k = { id: D.nextTicket++, table: t, station: s, createdAt: Date.now(), status: 'new', memo, by: staff ? 'staff' : 'guest', items: groups[s] };
      D.tickets.push(k); made.push(k.id);
    });
    const result = { ok: true, tickets: made };
    if (reqId) recentOrders.set(reqId, { at: Date.now(), result });
    changed();
    send(res, 200, result);
  },

  'POST /api/call': async (req, res) => {
    const b = await readBody(req, C.BODY_LIMIT);
    const t = tableNo(b.table);
    checkAccess(req, t, b.key);
    if (limited('call', ipOf(req), 6, 60000)) throw fail('กดถี่เกินไป', 429);
    st.D.calls[t] = { kind: b.kind === 'bill' ? 'bill' : 'staff', at: Date.now() };
    changed();
    send(res, 200, { ok: true });
  },

  /* ---- พนักงาน: ออเดอร์และบิล ---- */
  'GET /api/state': async (req, res) => {
    requireStaff(req);
    const D = st.D, bills = {};
    D.tickets.forEach(k => { if (!bills[k.table]) bills[k.table] = store.billOf(k.table); });
    send(res, 200, {
      settings: D.settings, menu: D.menu, stations: D.menu.stations,
      tickets: D.tickets, calls: D.calls, bills, keys: D.keys, nextBill: D.nextBill,
      backup: { last: D.lastBackup || null, copyDir: C.BK_COPY || '' },
      health: { saveError: st.saveError },
      lan: lanUrl(), lanAll: lanCandidates().map(a => 'http://' + a + ':' + C.PORT), now: Date.now()
    });
  },

  'POST /api/ticket': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const k = st.D.tickets.find(x => x.id === +b.id);
    if (!k) throw fail('ไม่พบออเดอร์ อาจถูกยกเลิกหรือปิดบิลไปแล้ว', 404);
    if (!['new', 'cooking', 'ready', 'served'].includes(b.status)) throw fail('สถานะไม่ถูกต้อง');
    if (b.from && b.from !== k.status) throw fail('ออเดอร์นี้ถูกอัปเดตจากอีกเครื่องแล้ว หน้าจอจะรีเฟรชให้', 409);
    k.status = b.status;
    changed();
    send(res, 200, { ok: true });
  },

  'POST /api/ticket/void': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, n = D.tickets.length;
    D.tickets = D.tickets.filter(x => x.id !== +b.id);
    if (D.tickets.length === n) throw fail('ไม่พบออเดอร์', 404);
    changed();
    send(res, 200, { ok: true });
  },

  'POST /api/call/clear': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    delete st.D.calls[+b.table];
    changed();
    send(res, 200, { ok: true });
  },

  'POST /api/pay': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D;
    const t = tableNo(b.table);
    const bill = store.billOf(t);
    if (!bill.lines.length) throw fail('โต๊ะนี้ไม่มีรายการ หรือปิดบิลไปแล้ว', 409);
    if (typeof b.expectedSub !== 'number') throw fail('ไม่มียอดที่ต้องตรวจสอบ');
    if (b.expectedSub !== bill.sub) throw fail('ยอดของโต๊ะ ' + t + ' เปลี่ยนไปแล้ว (มีการสั่งเพิ่มหรือยกเลิก) ตรวจยอดใหม่ก่อนรับเงิน', 409);
    const x = store.totals(bill.sub, !!b.svc, !!b.vat);
    const sale = {
      no: D.nextBill++, at: Date.now(), table: t, sub: bill.sub, svc: x.svc, vat: x.vat, total: x.total,
      method: b.method === 'transfer' ? 'transfer' : 'cash',
      items: bill.lines.map(l => ({ name: l.name, qty: l.qty, price: l.price }))
    };
    D.sales.push(sale);
    store.archiveSale(sale);
    store.trimSales();
    D.tickets = D.tickets.filter(k => k.table !== t);
    delete D.calls[t];
    st.changeSeq++;
    store.writeNow(); broadcast();      // ยอดเงินบันทึกทันที ไม่รอ debounce
    send(res, 200, { ok: true, sale });
  },

  /* ---- พนักงาน: ตั้งค่าร้าน ---- */
  'POST /api/settings': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const s = st.D.settings;
    if (typeof b.shop === 'string') s.shop = str(b.shop, 60) || s.shop;
    if (typeof b.address === 'string') s.address = str(b.address, 160);
    if (typeof b.phone === 'string') s.phone = str(b.phone, 40);
    if (typeof b.footer === 'string') s.footer = str(b.footer, 80);
    if (typeof b.taxId === 'string') {
      const d = b.taxId.replace(/\D/g, '');
      if (d && d.length !== 13) throw fail('เลขประจำตัวผู้เสียภาษีต้องมี 13 หลัก');
      s.taxId = d;
    }
    if (typeof b.promptpay === 'string') {
      const d = b.promptpay.replace(/\D/g, '');
      if (d && d.length !== 10 && d.length !== 13) throw fail('PromptPay ต้องเป็นเบอร์มือถือ 10 หลัก หรือเลขบัตร 13 หลัก');
      s.promptpay = d;
    }
    if (b.tables !== undefined) {
      const n = Math.floor(+b.tables);
      if (!(n >= 1 && n <= 60)) throw fail('จำนวนโต๊ะต้องอยู่ระหว่าง 1 ถึง 60');
      const busy = store.openTableNumbers().filter(t => t > n).sort((a, c) => a - c);
      if (busy.length) throw fail('โต๊ะ ' + busy.join(', ') + ' ยังเปิดอยู่ ปิดบิลก่อนลดจำนวนโต๊ะ');
      s.tables = n;
    }
    if (typeof b.svc === 'boolean') s.svc = b.svc;
    if (typeof b.vat === 'boolean') s.vat = b.vat;
    if (typeof b.acceptOrders === 'boolean') s.acceptOrders = b.acceptOrders;
    if (typeof b.baseUrl === 'string') {
      const u = b.baseUrl.trim().replace(/\/+$/, '');
      if (u && !/^https?:\/\/[^\s"'<>]+$/i.test(u)) throw fail('ที่อยู่เว็บต้องขึ้นต้นด้วย http:// หรือ https://');
      s.baseUrl = u;
    }
    store.ensureKeys();
    changed();
    send(res, 200, { ok: true });
  },

  'POST /api/soldout': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const id = +b.id;
    if (!store.menuItem(id)) throw fail('ไม่พบเมนู', 404);
    const set = new Set(st.D.settings.soldOut);
    if (b.soldOut) set.add(id); else set.delete(id);
    st.D.settings.soldOut = Array.from(set);
    changed();
    send(res, 200, { ok: true });
  },

  /* ---- พนักงาน: จัดการเมนู ---- */
  'POST /api/menu/item': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D;
    const name = str(b.name, 60);
    if (!name) throw fail('ใส่ชื่อเมนู');
    const price = typeof b.price === 'number' || (typeof b.price === 'string' && b.price.trim() !== '') ? Number(b.price) : NaN;
    if (!isFinite(price) || price < 0 || price > 100000) throw fail('ราคาต้องเป็นตัวเลข 0 ถึง 100,000');
    const cat = +b.cat;
    if (!D.menu.categories.some(c => c.id === cat)) throw fail('เลือกหมวดหมู่');
    const station = String(b.station || '');
    if (!D.menu.stations[station]) throw fail('เลือกจุดที่ทำเมนูนี้');
    const fields = { name, price: Math.round(price * 100) / 100, cat, station, desc: str(b.desc, 120), hidden: !!b.hidden };
    let m;
    if (b.id) {
      m = store.menuItem(+b.id);
      if (!m) throw fail('ไม่พบเมนูนี้ อาจถูกลบไปแล้ว', 404);
      Object.assign(m, fields);
    } else {
      m = Object.assign({ id: D.menu.nextId++, image: '' }, fields);
      D.menu.items.push(m);
    }
    menuChanged();
    send(res, 200, { ok: true, item: m });
  },

  'POST /api/menu/item/delete': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, m = store.menuItem(+b.id);
    if (!m) throw fail('ไม่พบเมนูนี้', 404);
    D.menu.items = D.menu.items.filter(x => x !== m);
    D.settings.soldOut = D.settings.soldOut.filter(id => id !== m.id);
    store.removeImageFile(m.image);
    menuChanged();
    send(res, 200, { ok: true });
  },

  'POST /api/menu/image': async (req, res, url) => {
    requireStaff(req);
    if (!store.menuItem(+url.searchParams.get('id'))) throw fail('ไม่พบเมนูนี้', 404);
    if (!/^image\/(jpeg|png|webp)$/i.test(req.headers['content-type'] || '')) throw fail('รองรับเฉพาะรูป JPG, PNG หรือ WebP', 415);
    const buf = await readRaw(req, C.IMG_MAX);
    const m = store.menuItem(+url.searchParams.get('id'));
    if (!m) throw fail('ไม่พบเมนูนี้', 404);
    const ext = U.sniffImage(buf);
    if (!ext) throw fail('ไฟล์นี้ไม่ใช่รูป JPG, PNG หรือ WebP');
    fs.mkdirSync(C.IMG_DIR, { recursive: true });
    const name = 'm' + m.id + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
    U.writeAtomic(path.join(C.IMG_DIR, name), buf);
    const old = m.image;
    m.image = name;
    store.removeImageFile(old);
    menuChanged();
    send(res, 200, { ok: true, image: name });
  },

  'POST /api/menu/image/delete': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const m = store.menuItem(+b.id);
    if (!m) throw fail('ไม่พบเมนูนี้', 404);
    store.removeImageFile(m.image);
    m.image = '';
    menuChanged();
    send(res, 200, { ok: true });
  },

  'POST /api/menu/category': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, name = str(b.name, 30);
    if (!name) throw fail('ใส่ชื่อหมวดหมู่');
    let c;
    if (b.id) {
      c = D.menu.categories.find(x => x.id === +b.id);
      if (!c) throw fail('ไม่พบหมวดหมู่นี้', 404);
      c.name = name;
    } else {
      c = { id: D.menu.nextCatId++, name };
      D.menu.categories.push(c);
    }
    menuChanged();
    send(res, 200, { ok: true, category: c });
  },

  'POST /api/menu/category/delete': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, id = +b.id;
    if (!D.menu.categories.some(c => c.id === id)) throw fail('ไม่พบหมวดหมู่นี้', 404);
    const n = D.menu.items.filter(m => m.cat === id).length;
    if (n) throw fail('หมวดนี้ยังมี ' + n + ' เมนู ย้ายหรือลบเมนูก่อน');
    if (D.menu.categories.length === 1) throw fail('ต้องมีอย่างน้อย 1 หมวดหมู่');
    D.menu.categories = D.menu.categories.filter(c => c.id !== id);
    menuChanged();
    send(res, 200, { ok: true });
  },

  'POST /api/menu/category/move': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const a = st.D.menu.categories, i = a.findIndex(c => c.id === +b.id), j = i + (b.dir < 0 ? -1 : 1);
    if (i < 0) throw fail('ไม่พบหมวดหมู่นี้', 404);
    if (j >= 0 && j < a.length) { const t = a[i]; a[i] = a[j]; a[j] = t; menuChanged(); }
    send(res, 200, { ok: true });
  },

  'POST /api/menu/notes': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    if (!Array.isArray(b.notes)) throw fail('รูปแบบไม่ถูกต้อง');
    const out = [];
    b.notes.forEach(n => { const v = str(n, 24); if (v && !out.includes(v)) out.push(v); });
    if (out.length > 20) throw fail('ตัวเลือกหมายเหตุได้ไม่เกิน 20 รายการ');
    st.D.menu.notes = out;
    menuChanged();
    send(res, 200, { ok: true });
  },

  /* ---- พนักงาน: รายงาน ---- */
  'GET /api/report': async (req, res) => {
    requireStaff(req);
    const D = st.D, DAY = C.DAY;
    const today0 = U.dayStart(Date.now());
    const today = D.sales.filter(s => s.at >= today0);
    let total = 0, cash = 0, transfer = 0; const qty = {};
    today.forEach(s => {
      total += s.total;
      if (s.method === 'transfer') transfer += s.total; else cash += s.total;
      s.items.forEach(i => { qty[i.name] = (qty[i.name] || 0) + i.qty; });
    });
    const top = Object.keys(qty).map(n => ({ name: n, qty: qty[n] })).sort((a, b) => b.qty - a.qty).slice(0, 8);
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const start = U.dayStart(today0 - i * DAY + DAY / 2), end = U.dayStart(start + DAY + DAY / 2);
      let sum = 0, cnt = 0;
      D.sales.forEach(s => { if (s.at >= start && s.at < end) { sum += s.total; cnt++; } });
      days.push({ date: start, total: sum, count: cnt });
    }
    let pending = 0; const seen = {};
    D.tickets.forEach(k => { if (!seen[k.table]) { seen[k.table] = 1; pending += store.billOf(k.table).sub; } });
    send(res, 200, {
      count: today.length, total, cash, transfer, avg: today.length ? Math.round(total / today.length) : 0,
      pending, openTables: Object.keys(seen).length, top, days, bills: today.slice().reverse()
    });
  },

  'GET /api/export.csv': async (req, res, url) => {
    requireStaff(req);
    const month = url.searchParams.get('month') || U.monthKey(Date.now());
    if (!/^\d{4}-\d{2}$/.test(month)) throw fail('รูปแบบเดือนต้องเป็น YYYY-MM');
    let lines = [];
    try { lines = fs.readFileSync(path.join(C.SALES_DIR, month + '.jsonl'), 'utf8').split('\n').filter(Boolean); } catch (e) { lines = []; }
    // ใส่ ' นำหน้าค่าที่ขึ้นต้นด้วย = + - @ กัน Excel ตีความเป็นสูตร (CSV injection)
    const q = v => { let s = String(v); if (/^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const rows = [['เลขที่', 'วันที่', 'เวลา', 'โต๊ะ', 'ค่าอาหาร', 'ค่าบริการ', 'VAT', 'รวม', 'ชำระโดย', 'รายการ'].map(q).join(',')];
    lines.forEach(l => {
      let s; try { s = JSON.parse(l); } catch (e) { return; }
      const d = new Date(s.at);
      rows.push([
        s.no, d.getFullYear() + '-' + U.pad(d.getMonth() + 1) + '-' + U.pad(d.getDate()), U.pad(d.getHours()) + ':' + U.pad(d.getMinutes()),
        s.table, s.sub, s.svc, s.vat, s.total, s.method === 'transfer' ? 'โอน/QR' : 'เงินสด',
        (s.items || []).map(i => i.name + ' x' + i.qty).join('; ')
      ].map(q).join(','));
    });
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="sales-' + month + '.csv"' });
    res.end('﻿' + rows.join('\r\n'));     // BOM ให้ Excel อ่านภาษาไทยได้
  },

  /* ---- พนักงาน: สำรองข้อมูล ---- */
  'GET /api/backups': async (req, res) => {
    requireStaff(req);
    send(res, 200, { list: backup.list(), last: st.D.lastBackup || null, copyDir: C.BK_COPY || '', dir: C.BK_DIR });
  },

  'POST /api/backup': async (req, res) => {
    requireStaff(req);
    send(res, 200, { ok: true, backup: await backup.writeBackup('manual') });
  },

  'GET /api/backup/download': async (req, res, url) => {
    requireStaff(req);
    const name = url.searchParams.get('name') || '';
    if (!C.BK_RE.test(name)) throw fail('ชื่อไฟล์ไม่ถูกต้อง');
    const file = path.join(C.BK_DIR, name);
    if (!fs.existsSync(file)) throw fail('ไม่พบไฟล์สำรองนี้', 404);
    res.writeHead(200, {
      'Content-Type': name.endsWith('.gz') ? 'application/gzip' : 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="' + name + '"'
    });
    fs.createReadStream(file).pipe(res);
  },

  'POST /api/backup/restore': async (req, res) => {
    requireStaff(req);
    if (!/^application\/(json|gzip|x-gzip|octet-stream)\b/i.test(req.headers['content-type'] || '')) throw fail('ต้องส่งไฟล์สำรอง (.json.gz หรือ .json)', 415);
    if (st.restoring) throw fail('กำลังกู้คืนข้อมูลอยู่ รอสักครู่', 409);
    const buf = await readRaw(req, C.RESTORE_MAX);
    const r = await backup.restore(buf);
    broadcast();
    // รหัสเข้าระบบผูกกับข้อมูล จึงออก cookie ใหม่ให้เครื่องที่กดกู้คืน (เครื่องอื่นต้องเข้าสู่ระบบใหม่)
    send(res, 200, { ok: true, restoredFrom: r.createdAt, safetyBackup: r.before.name, dropped: r.dropped }, { 'Set-Cookie': staffCookie() });
  }
};

module.exports = { api, clients, requireStaff, lanUrl, lanCandidates };
