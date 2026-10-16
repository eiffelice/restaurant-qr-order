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
const log = require('./log');
const theme = require('./theme');
const stock = require('./stock');
const { state: st } = store;
const { fail, send, str } = U;
// ระหว่างรอ body การกู้คืนอาจเริ่มขึ้น ถ้าแก้ข้อมูลต่อ การแก้นั้นจะหายเงียบๆ ตอนกู้คืนเสร็จทั้งที่ตอบ 200 ไปแล้ว
function notRestoring() { if (st.restoring) throw fail('กำลังกู้คืนข้อมูล กรุณารอสักครู่แล้วลองใหม่', 503); }
async function readBody(req, limit) { const b = await U.readBody(req, limit); notRestoring(); return b; }
async function readRaw(req, limit) { const b = await U.readRaw(req, limit); notRestoring(); return b; }

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

/* ---------- พนักงาน: PIN รายคนและบทบาท ----------
   บัญชี "เจ้าของร้าน" (id owner) ใช้ STAFF_PIN จาก env เสมอ ลบไม่ได้ กันเจ้าของล็อกตัวเองออก
   พนักงานคนอื่นอยู่ใน D.staff เก็บ PIN เป็น HMAC (ไม่เก็บตัว PIN)
   ลายเซ็นใน cookie ผูกกับ PIN และ ver ของคนนั้น: เปลี่ยน PIN/บทบาท/ปิดบัญชี/สั่งออกทุกเครื่อง = เครื่องที่เข้าอยู่หลุดหมด (รูปแบบ cookie ดู sign()/issue() ด้านล่าง) */
const ROLES = { owner: 'เจ้าของ', cashier: 'แคชเชียร์', waiter: 'พนักงานเสิร์ฟ', kitchen: 'ครัว' };
// FRONT = แตะเงินได้ (รับเงิน ยกเลิกออเดอร์ สรุปยอด) · SERVE = ดูแลโต๊ะ (สั่งแทนลูกค้า รับทราบการเรียก เปิดโต๊ะ) พนักงานเสิร์ฟอยู่ในกลุ่มนี้แต่ไม่อยู่ใน FRONT
const ALL = ['owner', 'cashier', 'waiter', 'kitchen'], FRONT = ['owner', 'cashier'], SERVE = ['owner', 'cashier', 'waiter'];
// สิทธิ์ตรวจที่เซิร์ฟเวอร์ใน requireStaff(): endpoint ที่ไม่ได้ระบุ = เจ้าของเท่านั้น (endpoint ใหม่ปลอดภัยไว้ก่อน)
const PERM = {
  'GET /api/events': ALL, 'GET /api/state': ALL, 'POST /api/ticket': ALL, 'POST /api/soldout': ALL,
  'POST /api/ticket/void': FRONT, 'POST /api/ticket/item/void': FRONT, 'POST /api/call/clear': SERVE, 'POST /api/pay': FRONT, 'GET /api/report': FRONT, 'GET /api/report/range': FRONT, 'GET /api/shift': FRONT, 'POST /api/shift/open': FRONT, 'POST /api/shift/close': FRONT,
  'POST /api/table/seat': SERVE, 'POST /api/table/move': SERVE, 'POST /api/table/discount': FRONT, 'POST /api/queue': SERVE, 'GET /api/stock': ALL, 'POST /api/stock/move': FRONT, 'POST /api/queue/cancel': SERVE, 'POST /api/reauth': ALL, 'GET /api/reauth': ALL
};
const hmac = s => crypto.createHmac('sha256', st.D.secret).update(s).digest('hex');
const pinHash = pin => hmac('pin:' + pin);
function ownerAccount() { return { id: 'owner', name: 'เจ้าของร้าน', role: 'owner', active: true, ver: st.D.ownerVer || 0, pinHash: pinHash(C.PIN) }; }
function findAccount(id) { return id === 'owner' ? ownerAccount() : st.D.staff.find(s => s.id === id) || null; }
/* cookie = <id>.<n>.<ลายเซ็น> n = เวลาออก (ฐาน 36) + '-' + สุ่ม แต่ละเครื่องจึงได้ค่าไม่ซ้ำกัน
   (การยืนยัน PIN ซ้ำผูกกับเครื่องที่ยืนยัน ไม่ใช่ทั้งบัญชี) และเจ้าของหมดอายุตาม OWNER_SESSION_MS
   cookie แบบเดิม <id>.<ลายเซ็น> ยังใช้ได้สำหรับทุกบทบาทที่ไม่ใช่เจ้าของ ส่วนเจ้าของต้องเข้าสู่ระบบใหม่ (แบบเดิมไม่มีวันหมดอายุ) */
function sign(a, n) { return hmac('sess|' + a.id + '|' + a.ver + '|' + a.pinHash + (n ? '|' + n : '')); }
function issue(a) {
  const n = Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex'), value = a.id + '.' + n + '.' + sign(a, n);
  const age = a.role === 'owner' ? Math.round(C.OWNER_SESSION_MS / 1000) : 2592000;
  return { value, header: 'st=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + age };
}
function sessionValue(req) { const c = (req.headers.cookie || '').split(/;\s*/).find(x => x.startsWith('st=')); return c ? c.slice(3) : ''; }
// ยืนยัน PIN ล่าสุดของแต่ละเครื่อง (ในหน่วยความจำ เปิดโปรแกรมใหม่ = ต้องยืนยันใหม่)
const fresh = new Map();
function requireFresh(req) {
  const t = fresh.get(sessionValue(req));
  if (!t || Date.now() - t > C.REAUTH_MS) throw codeFail('ใส่ PIN อีกครั้งเพื่อยืนยันว่าเป็นคุณ ก่อนทำรายการนี้', 403, 'reauth');
}
function staffOf(req) {
  if (req._staff !== undefined) return req._staff;
  const c = (req.headers.cookie || '').split(/;\s*/).find(x => x.startsWith('st='));
  let who = null;
  if (c) {
    const p = c.slice(3).split('.'), a = p.length >= 2 ? findAccount(p[0]) : null;
    if (a && a.active && p.length === 3 && U.safeEq(p[2], sign(a, p[1]))) {
      const at = parseInt(p[1].split('-')[0], 36);
      if (a.role !== 'owner' || Date.now() - at < C.OWNER_SESSION_MS) who = a;
    } else if (a && a.active && p.length === 2 && a.role !== 'owner' && U.safeEq(p[1], sign(a))) who = a;
  }
  return (req._staff = who);
}
function isStaff(req) { return !!staffOf(req); }
// สั่งแทนลูกค้า / เปิดหน้าลูกค้าโดยไม่ต้องมีรหัส QR / สั่งได้แม้ร้านปิดรับ QR: คนดูแลโต๊ะทุกคน (ไม่รวมครัว)
function frontStaff(req) { const a = staffOf(req); return !!a && SERVE.includes(a.role); }
function requireStaff(req) {
  const a = staffOf(req), p = String(req.url || '').split('?')[0];
  if (!a) { security(req, 'auth.denied', { path: p }, p); throw fail('ต้องเข้าสู่ระบบพนักงาน', 401); }
  if (!(PERM[req.method + ' ' + p] || ['owner']).includes(a.role)) {
    security(req, 'auth.forbidden', { path: p }, p);
    throw fail('บัญชี' + ROLES[a.role] + 'ไม่มีสิทธิ์ทำรายการนี้', 403);
  }
  return a;
}
const me = a => ({ id: a.id, name: a.name, role: a.role });
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
const LOGIN_FAILS_ALL = 30;          // รหัสพนักงานผิดรวมทุก IP ต่อนาที
const loginFails = [];
// เพดานรวมทุก IP ใช้กับทุกที่ที่รับ PIN (เข้าสู่ระบบ, PIN เจ้าของอนุมัติยกเลิก) ไม่อย่างนั้นเดาผ่านอีกช่องได้ไม่จำกัด
// เครื่องร้านเอง (loopback, ไม่ได้เปิดผ่าน tunnel) ไม่โดนเพดานรวม ผู้โจมตีจึงล็อกพนักงานออกไม่ได้
function pinLocked(req) {
  const now = Date.now();
  while (loginFails.length && now - loginFails[0] > 60000) loginFails.shift();
  const shopPc = !C.TRUST_PROXY && isLoopback(req.socket.remoteAddress);
  return !shopPc && loginFails.length >= LOGIN_FAILS_ALL;
}
const recentOrders = new Map();     // กันสั่งซ้ำเมื่อเน็ตหลุดแล้วลูกค้ากดส่งใหม่
setInterval(() => {
  const now = Date.now();
  hits.forEach((arr, k) => { if (!arr.length || now - arr[arr.length - 1] > 120000) hits.delete(k); });
  recentOrders.forEach((v, k) => { if (now - v.at > 600000) recentOrders.delete(k); });
  fresh.forEach((at, k) => { if (now - at > C.REAUTH_MS) fresh.delete(k); });
  seenSec.forEach((at, k) => { if (now - at > 600000) seenSec.delete(k); });
}, 60000).unref();

// เลขโต๊ะ หรือเลขบิลของคิวกลับบ้านที่ขอไว้แล้ว (QBASE + เลขคิว) คิวไม่มีรหัส QR จึงมีแค่พนักงานที่สั่ง/ดูได้ (checkAccess)
// req (ทางลูกค้า): คนนอกที่ระบุเลขคิว ส่งต่อให้ checkAccess ตอบ 403 แบบรหัส QR ผิด ไม่บอกว่าคิวไหนเปิดอยู่ และนับเป็นการเดารหัส
function tableNo(v, req) {
  const t = Math.floor(+v);
  if (store.isQueue(t)) { if (!st.D.queue.open[t] && !(req && !frontStaff(req))) throw fail('ไม่พบคิวนี้ (ปิดบิลหรือยกเลิกไปแล้ว)'); return t; }
  if (!(t >= 1 && t <= st.D.settings.tables)) throw fail('ไม่พบโต๊ะนี้');
  return t;
}
// โต๊ะจริงเท่านั้น (เปิดโต๊ะ เรียกพนักงาน เปลี่ยนรหัส QR ปลายทางของการย้าย)
function dineNo(v) {
  const t = Math.floor(+v);
  if (store.isQueue(t)) throw fail('ใช้กับคิวกลับบ้านไม่ได้ ใช้ได้เฉพาะโต๊ะ');
  return tableNo(t);
}
const CH = { takeaway: 'กลับบ้าน', delivery: 'เดลิเวอรี' };
function queueLabel(t) { const q = st.D.queue.open[t]; return q ? ['คิว ' + q.q, CH[q.channel], q.name].filter(Boolean).join(' · ') : 'โต๊ะ ' + t; }
const todayKey = () => { const d = new Date(); return d.getFullYear() + '-' + U.pad(d.getMonth() + 1) + '-' + U.pad(d.getDate()); };
// รหัส QR มี 8 hex ถ้าเดาได้ไม่จำกัด จากเครื่องเดียวเดาถูกได้ในไม่กี่วัน จึงจำกัดจำนวนครั้งที่ผิดต่อ IP
// ตรวจก่อนเทียบรหัส ไม่อย่างนั้นถูกจำกัดแล้วก็ยังเดาต่อได้
const QR_FAILS = 30;
function checkAccess(req, t, key) {
  if (frontStaff(req)) return;
  const k = 'qrfail|' + ipOf(req), now = Date.now();
  const fails = (hits.get(k) || []).filter(x => now - x < 60000);
  if (fails.length >= QR_FAILS) { security(req, 'qr.rate_limited', { table: t }, 'rl'); throw fail('ลองบ่อยเกินไป รอสักครู่', 429); }
  if (!key || !st.D.keys[t] || !U.safeEq(key, st.D.keys[t])) {
    fails.push(now); hits.set(k, fails);
    security(req, 'qr.denied', { table: t }, String(t));
    throw fail('QR ของโต๊ะไม่ถูกต้อง กรุณาสแกนใหม่ที่โต๊ะ', 403);
  }
}

/* ---------- live update ไปหน้าพนักงาน (SSE) ---------- */
const clients = new Set();
function broadcast() { clients.forEach(r => { try { r.write('event: change\ndata: {}\n\n'); } catch (e) { clients.delete(r); } }); }
setInterval(() => clients.forEach(r => { try { r.write(': ping\n\n'); } catch (e) { clients.delete(r); } }), 25000).unref();
store.setHealthListener(broadcast);
function changed() { store.save(); broadcast(); }
function menuChanged() { st.D.menu.version++; changed(); }

/* ---------- log (ดู lib/log.js) ----------
   ผู้ทำ = พนักงานคนที่เข้าสู่ระบบ (PIN รายคน) หรือ guest + IP, ชนิดอุปกรณ์ และรหัสคำขอ ใส่ท้ายเหตุการณ์เสมอ (กฎข้อ 36) */
function device(req) {
  const ua = String(req.headers['user-agent'] || '');
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'อื่นๆ';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ua ? 'อื่นๆ' : '-';
  return os + '/' + br;
}
function actor(req) {
  const a = staffOf(req);
  return a ? { by: 'staff', staff: a.id, name: a.name, role: a.role, ip: ipOf(req), dev: device(req), req: req.id }
    : { by: 'guest', ip: ipOf(req), dev: device(req), req: req.id };
}
// ผู้ทำ (staff/name/role/ip/...) ใส่ท้ายสุด field ของเหตุการณ์จึงทับตัวตนไม่ได้ (ชื่อเมนูใช้ itemName ไม่ใช่ name)
function audit(req, action, data, who) { log.audit(Object.assign({ action }, data, who || actor(req))); }
// เหตุการณ์ซ้ำจากที่เดิม (แท็บเล็ตที่หลุดระบบเรียกทุก 10 วินาที, คนเดารหัส) บันทึกครั้งเดียวต่อ 10 นาที
const seenSec = new Map();
function security(req, action, data, dedupeKey) {
  if (dedupeKey) {
    const k = action + '|' + ipOf(req) + '|' + dedupeKey, now = Date.now();
    if (now - (seenSec.get(k) || 0) < 600000) return;
    seenSec.set(k, now);
  }
  log.security(Object.assign({ action }, data, actor(req)));
}
const pick = (o, keys) => keys.reduce((a, k) => { a[k] = o[k]; return a; }, {});
// เฉพาะ field ที่เปลี่ยน ทั้งค่าเดิมและค่าใหม่
function diff(before, after) {
  const b = {}, a = {};
  Object.keys(after).forEach(k => { if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) { b[k] = before[k]; a[k] = after[k]; } });
  return Object.keys(a).length ? { before: b, after: a } : null;
}
const value = items => Math.round(items.reduce((s, i) => s + i.price * i.qty, 0) * 100) / 100;

/* ---------- API ---------- */
// ลำดับสถานะตั๋ว เดินหน้าได้ทีละขั้นเท่านั้น (เดิมส่ง status อะไรก็ได้ เช่น เสิร์ฟแล้ว → ใหม่ ทำให้ครัวทำซ้ำ)
const FLOW = { new: 'cooking', cooking: 'ready', ready: 'served' };
// PIN เจ้าของสำหรับอนุมัติ (บัญชี owner จาก env หรือพนักงานบทบาทเจ้าของ)
function ownerByPin(pin) {
  pin = String(pin || '');
  if (U.safeEq(pin, C.PIN)) return ownerAccount();
  if (!/^\d{6,8}$/.test(pin)) return null;
  const h = pinHash(pin);
  return st.D.staff.find(s => s.active && s.role === 'owner' && U.safeEq(s.pinHash, h)) || null;
}
const codeFail = (msg, status, code) => Object.assign(fail(msg, status), { code });
// ชื่อช่องทางที่แสดง: วิธีเดียว = ชื่อวิธี (อื่นๆ มีชื่อในวงเล็บ) หลายวิธี = หลายช่องทาง
function payLabel(s) {
  const p = store.paymentsOf(s);
  if (p.length > 1) return 'หลายช่องทาง';
  return store.METHODS[p[0].method] + (p[0].note ? ' (' + p[0].note + ')' : '');
}
/* ช่องทางชำระของบิล: payments [{method,amount,note?}] (แบ่งจ่าย) หรือ method เดียว (แบบเดิม = จ่ายทั้งยอด)
   แบ่งจ่ายต้องรวมเท่ายอดพอดี แต่ละวิธีใส่ได้ครั้งเดียว ยอดต้องมากกว่า 0 · method ที่ไม่รู้จัก (แบบเดิม) = เงินสด */
function paymentsFrom(b, total) {
  if (b.payments === undefined) return [{ method: store.METHODS[b.method] ? b.method : 'cash', amount: total }];
  if (!Array.isArray(b.payments) || !b.payments.length || b.payments.length > 4) throw fail('ใส่ช่องทางชำระอย่างน้อยหนึ่งช่องทาง');
  const seen = new Set();
  const out = b.payments.map(p => {
    if (!p || !store.METHODS[p.method]) throw fail('ช่องทางชำระไม่ถูกต้อง');
    if (seen.has(p.method)) throw fail('แต่ละช่องทางใส่ได้ครั้งเดียว');
    seen.add(p.method);
    if (typeof p.amount !== 'number' || !isFinite(p.amount)) throw fail('ยอดชำระไม่ถูกต้อง');
    const amount = Math.round(p.amount * 100) / 100;
    if (!(amount > 0 && amount <= 1000000)) throw fail('ยอดชำระแต่ละช่องทางต้องมากกว่า 0');
    const note = str(p.note, 30);
    return Object.assign({ method: p.method, amount }, note ? { note } : {});
  });
  const sum = Math.round(out.reduce((a, p) => a + p.amount, 0) * 100) / 100;
  if (sum !== total) throw fail('ยอดชำระรวม ' + sum + ' บาท ไม่เท่ากับยอดที่ต้องชำระ ' + total + ' บาท');
  return out;
}
/* ---- คืนเงิน: บิลขายใน D.sales (8 วันล่าสุด) + ใบคืนเงินที่อ้างอิงบิลนั้น ----
   ยอดที่ยังคืนได้ = ยอดบิล + ผลรวมใบคืนเงิน (ติดลบ) · จำนวนที่ยังคืนได้ของแต่ละรายการตามตำแหน่ง i ในบิล */
function refundState(no) {
  const sale = st.D.sales.find(s => s.no === no && !store.isRefund(s));
  if (!sale) return null;
  const refunds = st.D.sales.filter(s => store.isRefund(s) && s.refundOf === no);
  const back = new Map();
  refunds.forEach(f => f.items.forEach(i => { if (Number.isInteger(i.i)) back.set(i.i, (back.get(i.i) || 0) - i.qty); }));
  const lines = sale.items.map((it, i) => ({ i, name: it.name, price: it.price, qty: it.qty, left: it.qty - (back.get(i) || 0) }));
  return { sale, refunds, lines, remaining: r2(sale.total + refunds.reduce((a, f) => a + f.total, 0)), vatLeft: r2((sale.vat || 0) + refunds.reduce((a, f) => a + (f.vat || 0), 0)) };
}
// จำนวนเงินที่พนักงานกรอก (เงินทอนตั้งต้น เงินที่นับได้) 0 ถึง 1,000,000 ทศนิยม 2 ตำแหน่ง
function money(v, label) {
  if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > 1000000) throw fail(label + 'ต้องเป็นตัวเลข 0 ถึง 1,000,000');
  return Math.round(v * 100) / 100;
}
// โต๊ะไม่มีออเดอร์แล้ว: ลบส่วนลด คืนค่าที่ลบไว้ใส่ใน audit
function dropDiscountIfEmpty(t) {
  const d = st.D.discounts[t];
  if (!d || st.D.tickets.some(x => x.table === t)) return null;
  delete st.D.discounts[t];
  return { kind: d.kind, value: d.value };
}
// รายงานช่วงเวลา ----------------------------------------------------------
const r2 = v => Math.round(v * 100) / 100;
const okSale = s => s && Number.isInteger(s.no) && typeof s.at === 'number' && typeof s.total === 'number' && isFinite(s.total);
// เดือน (YYYY-MM) ทั้งหมดที่คาบช่วง [from, to)
function monthsBetween(from, to) {
  const out = [], d = new Date(from); d.setDate(1); d.setHours(0, 0, 0, 0);
  while (d.getTime() < to) { out.push(U.monthKey(d.getTime())); d.setMonth(d.getMonth() + 1); }
  return out;
}
// ยอดขายช่วง [from, to): อ่าน sales/ แบบ async ทีละเดือน (กฎข้อ 60) + บิลใน D.sales ที่ยังเขียนลงไฟล์ไม่สำเร็จ ตัดซ้ำด้วยเลขที่
// ใช้ร่วมกันระหว่างรายงานเดือน/ปี สรุปยอดขายและภาษี และ CSV ช่วงวันที่
async function salesBetween(from, to) {
  const byNo = new Map();
  for (const m of monthsBetween(from, to)) {
    let text = '';
    try { text = await fs.promises.readFile(path.join(C.SALES_DIR, m + '.jsonl'), 'utf8'); } catch (e) { text = ''; }
    text.split('\n').forEach(l => { let x; try { x = JSON.parse(l); } catch (e) { return; } if (okSale(x) && x.at >= from && x.at < to) byNo.set(x.no, x); });
  }
  notRestoring();
  st.D.sales.forEach(x => { if (x.at >= from && x.at < to) byNo.set(x.no, x); });
  return [...byNo.values()].sort((a, b) => a.at - b.at);
}
// วันที่ YYYY-MM-DD → เที่ยงคืนเวลาเครื่องร้าน (วันที่ไม่มีจริง เช่น 30 ก.พ. = null)
function parseDay(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] ? d.getTime() : null;
}
const dayKey = t => { const d = new Date(t); return d.getFullYear() + '-' + U.pad(d.getMonth() + 1) + '-' + U.pad(d.getDate()); };
// ช่วงวันที่จาก query (to รวมวันนั้น) ไม่เกิน 366 วัน คืน { from, to (ไม่รวม), fromKey, toKey }
function dayRange(url) {
  const fromKey = url.searchParams.get('from'), toKey = url.searchParams.get('to');
  const from = parseDay(fromKey), last = parseDay(toKey);
  if (from === null || last === null) throw fail('ใส่วันเริ่มต้นและวันสิ้นสุดเป็น YYYY-MM-DD ที่มีอยู่จริง');
  if (last < from) throw fail('วันสิ้นสุดต้องไม่ก่อนวันเริ่มต้น');
  const to = U.dayStart(last + C.DAY + C.DAY / 2);
  if (Math.round((to - from) / C.DAY) > 366) throw fail('เลือกช่วงได้ไม่เกิน 366 วัน');
  return { from, to, fromKey, toKey };
}
/* สรุปยอดขายและภาษี (ดู tasks/spec-tax-report.md) ใบคืนเงินยอดติดลบจึงหักออกเอง แต่นับแยก
   ใช้ settings.taxId บอกว่าร้านจด VAT (เจ้าของระบบตัดสินใจ 15 ต.ค. 2026) */
const TAX_ROW = () => ({ bills: 0, refunds: 0, sub: 0, disc: 0, svc: 0, beforeVat: 0, vat: 0, total: 0, refundValue: 0, cash: 0, transfer: 0, card: 0, other: 0 });
function taxSummary(sales, from, to) {
  const days = [], at = new Map();
  for (let t = from; t < to; t = U.dayStart(t + C.DAY + C.DAY / 2)) { const row = Object.assign({ date: dayKey(t) }, TAX_ROW()); days.push(row); at.set(row.date, row); }
  const withVat = { bills: 0, vat: 0, total: 0 }, withoutVat = { bills: 0, total: 0 };
  let firstNo = null, lastNo = null;
  sales.forEach(x => {
    const row = at.get(dayKey(x.at)); if (!row) return;
    if (store.isRefund(x)) { row.refunds++; row.refundValue -= x.total; }
    else {
      row.bills++;
      if (x.vat > 0) { withVat.bills++; withVat.vat += x.vat; withVat.total += x.total; } else { withoutVat.bills++; withoutVat.total += x.total; }
    }
    row.sub += x.sub || 0; row.disc += x.disc || 0; row.svc += x.svc || 0; row.vat += x.vat || 0; row.total += x.total;
    store.paymentsOf(x).forEach(p => { if (row[p.method] !== undefined) row[p.method] += p.amount; });
    if (firstNo === null || x.no < firstNo) firstNo = x.no;
    if (lastNo === null || x.no > lastNo) lastNo = x.no;
  });
  const totals = TAX_ROW();
  days.forEach(row => {
    row.beforeVat = row.total - row.vat;
    Object.keys(totals).forEach(k => { row[k] = r2(row[k]) + 0; totals[k] += row[k]; });
  });
  Object.keys(totals).forEach(k => { totals[k] = r2(totals[k]) + 0; });
  const byMethod = { cash: totals.cash, transfer: totals.transfer, card: totals.card, other: totals.other };
  ['cash', 'transfer', 'card', 'other'].forEach(k => delete totals[k]);
  ['vat', 'total'].forEach(k => { withVat[k] = r2(withVat[k]); });
  withoutVat.total = r2(withoutVat.total);
  // ใช้สวิตช์ "ร้านจด VAT" (tasks/spec-vat.md แทนการเดาจาก taxId)
  const money = n => '฿' + n.toLocaleString('th-TH', { maximumFractionDigits: 2 }), set = st.D.settings, reg = set.vatRegistered;
  const warnings = [];
  if (!reg && withVat.bills) warnings.push('ร้านตั้งค่าว่าไม่ได้จด VAT แต่มี ' + withVat.bills + ' บิลที่คิด VAT รวม ' + money(withVat.vat) + ' ร้านที่ไม่ได้จด VAT ไม่ควรเก็บ VAT จากลูกค้า ตรวจกับนักบัญชี');
  if (reg && !set.taxId) warnings.push('ร้านจด VAT แต่ยังไม่ได้ใส่เลขประจำตัวผู้เสียภาษีในตั้งค่า');
  if (reg && withoutVat.bills) warnings.push('มี ' + withoutVat.bills + ' บิลไม่ได้คิด VAT (ยอด ' + money(withoutVat.total) + ') ร้านที่จด VAT ควรตรวจกับนักบัญชี');
  if (to > Date.now()) warnings.push('ช่วงที่เลือกยังไม่จบ ตัวเลขยังเปลี่ยนได้');
  if (!sales.length) warnings.push('ไม่มีบิลในช่วงนี้');
  return { totals, byMethod, vat: { withVat, withoutVat }, days, firstNo, lastNo, warnings };
}
function rangeReport(sales, voids, period, from, months) {
  let total = 0, dcount = 0, dvalue = 0, cogs = 0, gross = 0, costed = 0, costedRev = 0;
  const byMethod = { cash: 0, transfer: 0, card: 0, other: 0 }, cashier = new Map(), items = new Map();
  // กราฟ: วันนี้ = รายชั่วโมง, เดือน = รายวัน, ปี = รายเดือน
  const series = [];
  if (period === 'today') for (let h = 0; h < 24; h++) series.push({ key: h, total: 0, count: 0 });
  else if (period === 'month') { const n = new Date(new Date(from).getFullYear(), new Date(from).getMonth() + 1, 0).getDate(); for (let i = 1; i <= n; i++) series.push({ key: i, total: 0, count: 0 }); }
  else months.forEach(m => series.push({ key: m, total: 0, count: 0 }));
  const slot = s => { const d = new Date(s.at); return period === 'today' ? d.getHours() : period === 'month' ? d.getDate() - 1 : months.indexOf(U.monthKey(s.at)); };
  const refunds = { count: 0, value: 0 }, rreasons = new Map();
  sales.forEach(s => {
    total += s.total;
    const isRef = store.isRefund(s);
    if (isRef) {
      refunds.count++; refunds.value = r2(refunds.value - s.total);
      const why = s.reason || 'ไม่ระบุ', rr = rreasons.get(why) || { reason: why, count: 0, value: 0 };
      rr.count++; rr.value = r2(rr.value - s.total); rreasons.set(why, rr);
    }
    if (s.disc > 0) { dcount++; dvalue += s.disc; }
    if (typeof s.cogs === 'number') {
      // รายได้เฉพาะรายการที่รู้ทุน หักส่วนลดตามสัดส่วน แล้วลบทุน (รายการที่ไม่มีสูตรไม่ทำให้กำไรดูสูงเกินจริง)
      const rev = (Array.isArray(s.items) ? s.items : []).reduce((a, i) => a + (i && typeof i.cost === 'number' ? i.qty * i.price : 0), 0);
      if (!isRef) costed++;
      cogs += s.cogs; costedRev += rev;
      gross += rev - (s.sub > 0 ? (s.disc || 0) * rev / s.sub : 0) - s.cogs;
    }
    store.paymentsOf(s).forEach(p => { byMethod[p.method] = r2((byMethod[p.method] || 0) + p.amount); });
    const c = s.cashier && s.cashier.name ? s.cashier : { id: '', name: 'ไม่ระบุ' }, ck = c.id + '|' + c.name;
    const cr = cashier.get(ck) || { id: c.id, name: c.name, total: 0, count: 0 };
    cr.total = r2(cr.total + s.total); if (!isRef) cr.count++; cashier.set(ck, cr);
    (Array.isArray(s.items) ? s.items : []).forEach(i => {
      if (!i || typeof i.name !== 'string' || !(isRef ? i.qty < 0 : i.qty > 0)) return;     // ใบคืนเงิน: จำนวนติดลบ หักจากที่ขายได้
      const it = items.get(i.name) || { name: i.name, qty: 0, amount: 0 };
      it.qty += i.qty; it.amount = r2(it.amount + i.qty * (+i.price || 0));
      if (typeof i.cost === 'number') it.cost = r2((it.cost || 0) + i.qty * i.cost);
      items.set(i.name, it);
    });
    const sl = series[slot(s)]; if (sl) { sl.total = r2(sl.total + s.total); if (!isRef) sl.count++; }
  });
  const sold = [...items.values()].filter(x => x.qty !== 0 || x.amount !== 0);
  const nBills = sales.filter(s => !store.isRefund(s)).length;
  const reasons = new Map(), vstaff = new Map();
  let vvalue = 0;
  voids.forEach(v => {
    const val = +v.value || 0; vvalue += val;
    const why = typeof v.reason === 'string' && v.reason ? v.reason : 'ไม่ระบุ';
    const rr = reasons.get(why) || { reason: why, count: 0, value: 0 }; rr.count++; rr.value = r2(rr.value + val); reasons.set(why, rr);
    const who = typeof v.name === 'string' && v.name ? v.name : 'ไม่ระบุ';
    const ws = vstaff.get(who) || { name: who, count: 0, value: 0 }; ws.count++; ws.value = r2(ws.value + val); vstaff.set(who, ws);
  });
  const byCount = (a, b) => b.count - a.count || b.value - a.value;
  return {
    total: r2(total), count: nBills, avg: nBills ? Math.round(total / nBills) : 0, byMethod,
    refunds: Object.assign(refunds, { reasons: [...rreasons.values()].sort((a, b) => b.count - a.count || b.value - a.value) }),
    byCashier: [...cashier.values()].sort((a, b) => b.total - a.total),
    best: sold.slice().sort((a, b) => b.qty - a.qty || b.amount - a.amount).slice(0, 10),
    worst: sold.slice().sort((a, b) => a.qty - b.qty || a.amount - b.amount).slice(0, 10),
    // เมนูที่ยังขายอยู่ (ไม่ซ่อน) แต่ไม่มีใครสั่งเลยในช่วงนี้ เทียบด้วยชื่อ เพราะบิลเก็บชื่อตอนขาย
    notSold: st.D.menu.items.filter(m => !m.hidden && !items.has(m.name)).map(m => m.name),
    series,
    discounts: { count: dcount, value: r2(dvalue) },
    // ต้นทุนวัตถุดิบและกำไรขั้นต้น (ค่าอาหารหลังส่วนลด − ทุน) คิดเฉพาะบิลที่มีสูตร (costed) ไม่รวมค่าบริการ/VAT
    cogs: r2(cogs), gross: r2(gross), costed, costedRevenue: r2(costedRev),
    voids: { count: voids.length, value: r2(vvalue), reasons: [...reasons.values()].sort(byCount), byStaff: [...vstaff.values()].sort(byCount) }
  };
}
// ยอดในกะ: บิลที่ปิดตั้งแต่เปิดกะ แยกตามช่องทาง และเงินสดที่ควรมีในลิ้นชัก
function shiftSummary(sh, until) {
  const sales = { cash: 0, transfer: 0, card: 0, other: 0 };
  let bills = 0, total = 0;
  st.D.sales.forEach(s => {
    if (s.at < sh.openedAt || s.at > until) return;
    if (!store.isRefund(s)) bills++;
    total += s.total;
    store.paymentsOf(s).forEach(p => { sales[p.method] = Math.round(((sales[p.method] || 0) + p.amount) * 100) / 100; });
  });
  return { sales, bills, total: Math.round(total * 100) / 100, expectedCash: Math.round((sh.float + sales.cash) * 100) / 100 };
}
// เหตุผลการยกเลิก (ทั้งใบหรือทีละรายการ) บังคับใส่
function voidReason(b) {
  const reason = str(b.reason, 80);
  if (reason.length < 2) throw fail('ต้องระบุเหตุผลที่ยกเลิก');
  return reason;
}
// ครัวเริ่มทำแล้ว = ของเสียจริง คนที่ไม่ใช่เจ้าของต้องให้เจ้าของใส่ PIN อนุมัติ (นับรวม pinLocked กฎข้อ 46) คืนผู้อนุมัติ หรือ undefined
function approval(req, who, k, b) {
  if (k.status === 'new' || who.role === 'owner') return undefined;
  return ownerApproval(req, b, 'ครัวเริ่มทำแล้ว ต้องให้เจ้าของใส่ PIN อนุมัติการยกเลิก', { ticket: k.id });
}
// PIN เจ้าของอนุมัติ (ยกเลิกของที่ครัวทำแล้ว ให้ส่วนลด) นับรวมเพดานเดารหัส (กฎข้อ 46) ห้ามเก็บ PIN ใน log
function ownerApproval(req, b, need, ctx) {
  if (!b.approvePin) throw codeFail(need, 403, 'need_approval');
  if (limited('approve', ipOf(req), 6, 60000)) { security(req, 'auth.rate_limited', { kind: 'approve' }, 'approve'); throw fail('ลองบ่อยเกินไป รอสักครู่', 429); }
  if (pinLocked(req)) { security(req, 'auth.locked', { kind: 'approve' }, 'all'); throw fail('มีการใส่รหัสผิดหลายครั้ง ระบบพักการใส่ PIN 1 นาที (เครื่องร้านยังใช้ได้)', 429); }
  const o = ownerByPin(b.approvePin);
  if (!o) { loginFails.push(Date.now()); security(req, 'approve.failed', ctx); throw codeFail('PIN เจ้าของไม่ถูกต้อง', 403, 'need_approval'); }
  return { id: o.id, name: o.name };
}
/* รูปของร้าน (โลโก้ / ภาพพื้นหลัง): ตรวจ magic bytes ชื่อไฟล์ใหม่ทุกครั้ง ลบไฟล์เก่า audit แล้วให้หน้าลูกค้าโหลดใหม่ */
const SETTING_KEY = { logo: 'logo', cover: 'cover', payqr: 'payQr' };   // ชื่อใน URL/ชื่อไฟล์ → ชื่อใน settings
// payqr = รูป QR รับเงินของร้าน เปลี่ยนแล้วเงินเข้าบัญชีอื่นได้ ต้องยืนยัน PIN ซ้ำเหมือนเปลี่ยนเบอร์ PromptPay (กฎข้อ 48) หน้าลูกค้าไม่ใช้รูปนี้ จึงไม่ต้องให้โหลดเมนูใหม่
async function brandImage(req, res, kind) {
  requireStaff(req);
  if (kind === 'payqr') requireFresh(req);
  if (!/^image\/(jpeg|png|webp)$/i.test(req.headers['content-type'] || '')) throw fail('รองรับเฉพาะรูป JPG, PNG หรือ WebP', 415);
  const buf = await readRaw(req, C.IMG_MAX);
  const ext = U.sniffImage(buf);
  if (!ext) throw fail('ไฟล์นี้ไม่ใช่รูป JPG, PNG หรือ WebP');
  fs.mkdirSync(C.IMG_DIR, { recursive: true });
  const name = kind + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
  await U.retryAsync(() => U.writeAtomic(path.join(C.IMG_DIR, name), buf));
  try { notRestoring(); } catch (e) { store.removeImageFile(name); throw e; }   // กู้คืนเริ่มระหว่างรอ: ไม่ทิ้งไฟล์ที่ไม่มีใครอ้างถึง
  const s = st.D.settings, key = SETTING_KEY[kind], old = s[key];   // อ่าน settings ใหม่หลัง await (กู้คืนเปลี่ยน D ได้)
  s[key] = name;
  store.removeImageFile(old);
  audit(req, 'settings.' + kind + '.updated', { before: old, after: name });
  if (kind === 'payqr') changed(); else menuChanged();   // หน้าลูกค้าเห็น version เปลี่ยนแล้วโหลดใหม่
  send(res, 200, { ok: true, [kind]: name });
}
async function brandImageDelete(req, res, kind) {
  requireStaff(req);
  if (kind === 'payqr') requireFresh(req);
  await readBody(req, C.BODY_LIMIT);
  const s = st.D.settings, key = SETTING_KEY[kind];
  if (s[key]) { audit(req, 'settings.' + kind + '.removed', { before: s[key] }); store.removeImageFile(s[key]); s[key] = ''; if (kind === 'payqr') changed(); else menuChanged(); }
  send(res, 200, { ok: true });
}
/* เมนูขายดี: 3 เมนูที่ขายมากสุดใน 7 วันล่าสุด (นับจากบิลจริง อย่างน้อย 3 จาน) จับคู่ตามชื่อเพราะบิลเก็บชื่อตอนขาย */
function popularIds(items) {
  const since = Date.now() - 7 * C.DAY, qty = new Map();
  st.D.sales.forEach(b => { if (b.at >= since) b.items.forEach(i => qty.set(i.name, (qty.get(i.name) || 0) + i.qty)); });
  return items.map(m => ({ id: m.id, q: qty.get(m.name) || 0 })).filter(x => x.q >= 3).sort((a, b) => b.q - a.q).slice(0, 3).map(x => x.id);
}
/* รับออเดอร์ผ่าน QR ได้ไหม: null = ได้ หรือเหตุผล 'off' (ปิดเอง) / 'hours' (นอกเวลา) / 'seat' (ยังไม่เปิดโต๊ะ) */
const hm = s => +s.slice(0, 2) * 60 + +s.slice(3);
function withinHours(h, now) {
  if (!h || !h.on) return true;
  const d = new Date(now || Date.now()), m = d.getHours() * 60 + d.getMinutes(), o = hm(h.open), c = hm(h.close);
  if (o === c) return true;
  return o < c ? (m >= o && m < c) : (m >= o || m < c);           // ปิดหลังเที่ยงคืน เช่น 17:00–02:00
}
function isSeated(t) { return !!st.D.seated[t] || st.D.tickets.some(k => k.table === t); }
function qrClosed(t) {
  const s = st.D.settings;
  if (!s.acceptOrders) return 'off';
  if (!withinHours(s.hours)) return 'hours';
  if (t && s.requireSeat && !isSeated(t)) return 'seat';
  return null;
}
const hoursText = h => h.open + '–' + h.close;
const CLOSED_MSG = {
  off: () => 'ร้านปิดรับออเดอร์ผ่าน QR ชั่วคราว กรุณาเรียกพนักงาน',
  hours: () => 'ตอนนี้นอกเวลารับออเดอร์ผ่าน QR (' + hoursText(st.D.settings.hours) + ') กรุณาเรียกพนักงาน',
  seat: () => 'โต๊ะนี้ยังไม่ได้เปิด กรุณาเรียกพนักงานเพื่อเปิดโต๊ะก่อนสั่ง'
};
const api = {
  'POST /api/login': async (req, res) => {
    if (limited('login', ipOf(req), 6, 60000)) { security(req, 'auth.rate_limited', {}, 'ip'); throw fail('ลองบ่อยเกินไป รอสักครู่', 429); }
    const b = await readBody(req, C.BODY_LIMIT);
    // ลิมิตต่อ IP อย่างเดียวไม่พอ คนใน WiFi ร้านตั้ง IP เองได้ทั้งวง จึงจำกัดรหัสผิดรวมทุกเครื่องด้วย
    const now = Date.now();
    if (pinLocked(req)) { security(req, 'auth.locked', {}, 'all'); throw fail('มีการใส่รหัสผิดหลายครั้ง ระบบพักการเข้าสู่ระบบ 1 นาที (เครื่องร้านยังเข้าได้)', 429); }
    const pin = String(b.pin || '');
    let a = U.safeEq(pin, C.PIN) ? ownerAccount() : null;
    if (!a && /^\d{6,8}$/.test(pin)) { const h = pinHash(pin); a = st.D.staff.find(s => s.active && U.safeEq(s.pinHash, h)) || null; }
    if (!a) { loginFails.push(now); security(req, 'auth.login_failed', {}); throw fail('รหัสไม่ถูกต้อง', 401); }
    req._staff = a;
    security(req, 'auth.login', {});
    const ses = issue(a);
    fresh.set(ses.value, Date.now());                    // เพิ่งใส่ PIN = ยืนยันแล้ว
    send(res, 200, { ok: true, me: me(a) }, { 'Set-Cookie': ses.header });
  },

  'POST /api/logout': async (req, res) => {
    if (isStaff(req)) security(req, 'auth.logout', {});
    fresh.delete(sessionValue(req));
    send(res, 200, { ok: true }, { 'Set-Cookie': 'st=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
  },

  /* ---- ยืนยัน PIN ซ้ำก่อนทำเรื่องสำคัญ (PIN ของบัญชีที่เข้าอยู่) ---- */
  'GET /api/reauth': async (req, res) => {
    requireStaff(req);
    const t = fresh.get(sessionValue(req)), ok = !!t && Date.now() - t <= C.REAUTH_MS;
    send(res, 200, { fresh: ok, until: ok ? t + C.REAUTH_MS : null });
  },
  'POST /api/reauth': async (req, res) => {
    const who = requireStaff(req);
    if (limited('reauth', ipOf(req), 6, 60000)) { security(req, 'auth.rate_limited', { kind: 'reauth' }, 'reauth'); throw fail('ลองบ่อยเกินไป รอสักครู่', 429); }
    if (pinLocked(req)) { security(req, 'auth.locked', { kind: 'reauth' }, 'all'); throw fail('มีการใส่รหัสผิดหลายครั้ง ระบบพักการใส่ PIN 1 นาที (เครื่องร้านยังใช้ได้)', 429); }
    const b = await readBody(req, C.BODY_LIMIT);
    const pin = String(b.pin || '');
    const ok = who.id === 'owner' ? U.safeEq(pin, C.PIN) : (/^\d{6,8}$/.test(pin) && U.safeEq(pinHash(pin), who.pinHash));
    if (!ok) {
      if (pin) { loginFails.push(Date.now()); security(req, 'auth.reauth_failed', {}); }
      throw codeFail('PIN ไม่ถูกต้อง', 400, 'bad_pin');
    }
    fresh.set(sessionValue(req), Date.now());
    security(req, 'auth.reauth', {});
    send(res, 200, { ok: true, until: Date.now() + C.REAUTH_MS });
  },

  /* ---- ลูกค้า ---- */
  'GET /api/menu': async (req, res) => {
    const D = st.D;
    const vis = D.menu.items.filter(m => !m.hidden);
    const used = new Set(vis.map(m => m.cat));
    send(res, 200, {
      shop: D.settings.shop, logo: D.settings.logo, cover: D.settings.cover, version: D.menu.version, notes: D.menu.notes,
      address: D.settings.address, phone: D.settings.phone, popular: popularIds(vis),
      tagline: D.settings.tagline, look: D.settings.look, social: D.settings.social, shareUrl: D.settings.shareUrl, hours: D.settings.hours,
      categories: D.menu.categories.filter(c => used.has(c.id)),
      items: vis.map(m => ({ id: m.id, name: m.name, price: m.price, cat: m.cat, desc: m.desc, image: m.image, rec: m.rec, soldOut: D.settings.soldOut.includes(m.id) })),
      svc: D.settings.svc, vatRegistered: D.settings.vatRegistered, vatInclusive: D.settings.vatInclusive, vatRate: D.settings.vatRate, tables: D.settings.tables
    });
  },

  // หน้าเข้าสู่ระบบพนักงานใช้ก่อนเข้าสู่ระบบ: ชื่อร้านกับโลโก้เท่านั้น
  'GET /api/brand': async (req, res) => {
    send(res, 200, { shop: st.D.settings.shop, logo: st.D.settings.logo, cover: st.D.settings.cover });
  },

  'GET /api/table': async (req, res, url) => {
    const D = st.D;
    const t = tableNo(url.searchParams.get('t'), req);
    checkAccess(req, t, url.searchParams.get('k'));
    const b = store.billOf(t);
    send(res, 200, {
      table: t, label: queueLabel(t), staff: frontStaff(req), sub: b.sub, call: D.calls[t] || null, menuVersion: D.menu.version,
      open: !qrClosed(t), closedReason: qrClosed(t), closedText: qrClosed(t) ? CLOSED_MSG[qrClosed(t)]() : '', seated: isSeated(t),
      soldOut: D.settings.soldOut, svc: D.settings.svc, vatRegistered: D.settings.vatRegistered, vatInclusive: D.settings.vatInclusive, vatRate: D.settings.vatRate,
      tickets: D.tickets.filter(k => k.table === t).map(k => ({ id: k.id, status: k.status, createdAt: k.createdAt, items: k.items.map(i => pick(i, ['id', 'name', 'price', 'qty', 'note'])) }))   // ไม่ส่งทุน/สูตรให้ลูกค้า
    });
  },

  'POST /api/order': async (req, res) => {
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D;
    const t = tableNo(b.table, req);
    checkAccess(req, t, b.key);
    const staff = frontStaff(req);
    const reqId = typeof b.reqId === 'string' && /^[a-f0-9]{8,64}$/.test(b.reqId) ? t + ':' + b.reqId : null;
    if (reqId && recentOrders.has(reqId)) return send(res, 200, recentOrders.get(reqId).result);
    const closed = staff ? null : qrClosed(t);
    if (closed) { if (closed !== 'off') security(req, 'order.closed', { table: t, reason: closed }, 'closed' + t); throw codeFail(CLOSED_MSG[closed](), 403, closed); }
    if (!staff && limited('order', ipOf(req), C.ORDER_LIMIT, 60000)) { security(req, 'order.rate_limited', { table: t }, 'rl'); throw fail('สั่งถี่เกินไป กรุณารอสักครู่', 429); }
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
      const u = stock.useOf(D, m.id);
      (groups[station] = groups[station] || []).push(Object.assign({ id: m.id, name: m.name, price: m.price, qty, note }, u ? { use: u.use, cost: u.cost } : {}));
    }
    if (count > 60) throw fail('สั่งครั้งละไม่เกิน 60 รายการ');
    // ลูกค้าส่งยอดที่เห็นบนจอมาด้วย ถ้าราคาเปลี่ยนระหว่างนั้น ต้องให้ลูกค้าเห็นยอดใหม่ก่อน ไม่คิดเงินต่างจากที่เห็นเงียบๆ
    if (b.expect !== undefined && +b.expect !== value([].concat(...Object.values(groups)))) throw codeFail('ราคาเมนูเพิ่งเปลี่ยน กรุณาตรวจยอดใหม่แล้วกดสั่งอีกครั้ง', 409, 'price_changed');
    const memo = str(b.memo, 80);
    const made = [];
    Object.keys(groups).forEach(s => {
      const k = { id: D.nextTicket++, table: t, station: s, createdAt: Date.now(), status: 'new', memo, by: staff ? 'staff' : 'guest', items: groups[s] };
      D.tickets.push(k); made.push(k.id);
    });
    const result = { ok: true, tickets: made };
    if (reqId) recentOrders.set(reqId, { at: Date.now(), result });
    const all = [].concat(...Object.values(groups));
    const used = stock.apply(D, all, -1);           // ตัดวัตถุดิบตอนส่งเข้าครัว
    if (used.length) stock.log(D, { type: 'sale', table: t, tickets: made, lines: used });
    audit(req, 'order.created', Object.assign({ table: t, tickets: made, items: all.map(i => pick(i, ['name', 'qty', 'price'])), value: value(all), memo }, used.length ? { stock: used } : {}));
    changed();
    send(res, 200, result);
  },

  'POST /api/call': async (req, res) => {
    const b = await readBody(req, C.BODY_LIMIT);
    const t = dineNo(b.table);
    checkAccess(req, t, b.key);
    if (limited('call', ipOf(req), 6, 60000)) { security(req, 'call.rate_limited', { table: t }, 'rl'); throw fail('กดถี่เกินไป', 429); }
    st.D.calls[t] = { kind: b.kind === 'bill' ? 'bill' : 'staff', at: Date.now() };
    changed();
    send(res, 200, { ok: true });
  },

  /* ---- พนักงาน: ออเดอร์และบิล ---- */
  'GET /api/state': async (req, res) => {
    const who = requireStaff(req);
    const D = st.D, bills = {};
    D.tickets.forEach(k => { if (!bills[k.table]) bills[k.table] = store.billOf(k.table); });
    Object.keys(bills).forEach(t => { const d = D.discounts[t]; if (d) Object.assign(bills[t], { disc: store.discountOf(+t, bills[t].sub), discount: d }); });
    send(res, 200, {
      settings: D.settings, menu: D.menu, stations: D.menu.stations,
      tickets: who.role === 'owner' ? D.tickets : D.tickets.map(k => Object.assign({}, k, { items: k.items.map(i => pick(i, ['id', 'name', 'price', 'qty', 'note'])) })),   // ทุน/สูตรในรายการ: เจ้าของเท่านั้น
      calls: D.calls, bills, queue: D.queue.open, stockLow: stock.low(D), keys: who.role === 'owner' ? D.keys : {},   // รหัส QR ทุกโต๊ะ: เจ้าของเท่านั้น (ใช้พิมพ์ QR) คนอื่นสั่งแทนด้วย cookie ปิดบัญชีแล้วจึงไม่มีรหัสติดตัวไปสั่งเข้าโต๊ะได้
      nextBill: D.nextBill,
      seated: D.seated, qrClosed: qrClosed(null),
      me: me(who), roles: ROLES,
      // PIN เจ้าของเป็นค่าเริ่มต้น/สั้น: เตือนบนหน้าจอ (เดิมเตือนแค่ใน console ที่เจ้าของร้านไม่ได้ดู)
      weakPin: who.role === 'owner' && (C.PIN === '1234' || C.PIN.length < 6),
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
    if (!b.from) throw fail('ต้องระบุสถานะเดิมของออเดอร์');
    if (b.from !== k.status) throw fail('ออเดอร์นี้ถูกอัปเดตจากอีกเครื่องแล้ว หน้าจอจะรีเฟรชให้', 409);
    if (FLOW[k.status] !== b.status) throw fail('เปลี่ยนสถานะย้อนกลับหรือข้ามขั้นไม่ได้');
    audit(req, 'ticket.status', { ticket: k.id, table: k.table, before: k.status, after: b.status });
    k.status = b.status;
    changed();
    send(res, 200, { ok: true });
  },

  'POST /api/ticket/void': async (req, res) => {
    const who = requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, k = D.tickets.find(x => x.id === +b.id);
    if (!k) throw fail('ไม่พบออเดอร์', 404);
    const reason = voidReason(b);
    const approvedBy = approval(req, who, k, b);
    D.tickets = D.tickets.filter(x => x !== k);
    const dropped = dropDiscountIfEmpty(k.table);   // โต๊ะว่างแล้ว ส่วนลดไม่ค้างให้ลูกค้าคนถัดไป
    const back = stock.apply(D, k.items, +1);        // คืนวัตถุดิบตามสูตรตอนสั่ง
    if (back.length) stock.log(D, { type: 'void', table: k.table, ticket: k.id, lines: back, note: reason, by: { id: who.id, name: who.name } });
    audit(req, 'ticket.voided', Object.assign(dropped ? { discountDropped: dropped } : {}, back.length ? { stock: back } : {}, { ticket: k.id, table: k.table, status: k.status, by_order: k.by, items: k.items.map(i => pick(i, ['name', 'qty', 'price'])), value: value(k.items), reason }, approvedBy ? { approvedBy } : {}));
    changed();
    send(res, 200, { ok: true });
  },

  /* ยกเลิกบางรายการ/บางจำนวนในตั๋ว (ลูกค้าสั่งเกิน ของหมดเฉพาะจาน) กฎเดียวกับยกเลิกทั้งใบ
     index + item + from = ตำแหน่ง เมนู และจำนวนที่เห็นตอนกด อีกเครื่องแก้ไปก่อนแล้วได้ 409 (แบบ from ของสถานะตั๋ว)
     ยอดบิลลดทันที แคชเชียร์ที่กำลังคิดเงินด้วยยอดเดิมได้ 409 จาก expectedSub */
  'POST /api/ticket/item/void': async (req, res) => {
    const who = requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, k = D.tickets.find(x => x.id === +b.id);
    if (!k) throw fail('ไม่พบออเดอร์', 404);
    const reason = voidReason(b);
    const idx = +b.index, it = Number.isInteger(idx) ? k.items[idx] : null, qty = +b.qty;
    if (!it || it.id !== +b.item || it.qty !== +b.from) throw fail('รายการนี้ถูกแก้จากอีกเครื่องไปแล้ว ตรวจรายการใหม่แล้วลองอีกครั้ง', 409);
    if (!Number.isInteger(qty) || qty < 1 || qty > it.qty) throw fail('จำนวนที่จะยกเลิกต้องอยู่ระหว่าง 1 ถึง ' + it.qty);
    const approvedBy = approval(req, who, k, b);
    it.qty -= qty;
    const back = stock.apply(D, [{ use: it.use, qty }], +1);
    if (back.length) stock.log(D, { type: 'void', table: k.table, ticket: k.id, lines: back, note: reason, by: { id: who.id, name: who.name } });
    if (!it.qty) k.items.splice(idx, 1);
    if (!k.items.length) D.tickets = D.tickets.filter(x => x !== k);
    const dropped = dropDiscountIfEmpty(k.table);
    audit(req, 'ticket.item_voided', Object.assign(dropped ? { discountDropped: dropped } : {}, back.length ? { stock: back } : {}, { ticket: k.id, table: k.table, status: k.status, by_order: k.by, item: it.id, itemName: it.name, qty, price: it.price, value: Math.round(qty * it.price * 100) / 100, note: it.note, reason, ticketGone: !k.items.length }, approvedBy ? { approvedBy } : {}));
    changed();
    send(res, 200, { ok: true });
  },

  'POST /api/table/seat': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, t = dineNo(b.table);
    if (b.open) { if (!D.seated[t]) { D.seated[t] = { at: Date.now() }; audit(req, 'table.seated', { table: t }); } }
    else {
      if (D.tickets.some(k => k.table === t)) throw fail('โต๊ะ ' + t + ' ยังมีออเดอร์ ปิดบิลก่อนปิดโต๊ะ', 409);
      if (D.seated[t]) { delete D.seated[t]; audit(req, 'table.unseated', { table: t }); }
    }
    changed();
    send(res, 200, { ok: true });
  },

  /* ย้ายโต๊ะ / รวมโต๊ะ: ออเดอร์ การเรียก และสถานะเปิดโต๊ะของโต๊ะต้นทางไปอยู่โต๊ะปลายทาง
     ปลายทางมีออเดอร์ = รวมบิล ต้องส่ง merge:true (ไม่อย่างนั้น 409 need_merge ให้หน้าเว็บถามยืนยัน)
     expectedSub = ยอดโต๊ะต้นทางที่เห็นตอนกด ลูกค้าสั่งเพิ่มระหว่างนั้น = 409 (กันย้ายของที่ไม่ได้เห็น)
     ไม่ใช่เรื่องเงิน (ยอดรวมไม่เปลี่ยน) พนักงานเสิร์ฟทำได้ */
  'POST /api/table/move': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, from = tableNo(b.from), to = dineNo(b.to);
    if (from === to) throw fail('เลือกโต๊ะปลายทางที่ไม่ใช่โต๊ะเดิม');
    const moving = D.tickets.filter(k => k.table === from);
    if (!moving.length && !D.calls[from] && !D.seated[from]) throw fail('โต๊ะ ' + from + ' ไม่มีออเดอร์ให้ย้าย', 409);
    const sub = store.billOf(from).sub;
    if (b.expectedSub !== sub) throw fail('ยอดของโต๊ะ ' + from + ' เปลี่ยนไปแล้ว (มีการสั่งเพิ่มหรือยกเลิก) ตรวจรายการใหม่ก่อนย้าย', 409);
    const merge = D.tickets.some(k => k.table === to);
    if (merge && b.merge !== true) throw codeFail('โต๊ะ ' + to + ' มีออเดอร์อยู่แล้ว ยืนยันว่าจะรวมเป็นบิลเดียว', 409, 'need_merge');
    // ส่วนลด: ย้ายไปโต๊ะว่างพาไปด้วย · รวมโต๊ะที่ฝั่งใดฝั่งหนึ่งมีส่วนลด ไม่รู้ว่าลดให้ใคร ให้เอาออกก่อน
    if (merge && (D.discounts[from] || D.discounts[to])) throw fail('โต๊ะที่จะรวมมีส่วนลดอยู่ เอาส่วนลดออกก่อน แล้วค่อยให้ส่วนลดใหม่หลังรวมโต๊ะ', 409);
    const dmoved = D.discounts[from] ? { kind: D.discounts[from].kind, value: D.discounts[from].value } : null;
    if (dmoved) { D.discounts[to] = D.discounts[from]; delete D.discounts[from]; }
    moving.forEach(k => { k.table = to; });
    if (D.calls[from]) { if (!D.calls[to]) D.calls[to] = D.calls[from]; delete D.calls[from]; }
    if (D.seated[from]) { if (!D.seated[to]) D.seated[to] = D.seated[from]; delete D.seated[from]; }
    delete D.queue.open[from];             // คิวกลับบ้านย้ายไปนั่งโต๊ะ: คิวหมดหน้าที่
    audit(req, 'table.moved', Object.assign({ from, to, merge, tickets: moving.map(k => k.id), value: sub }, dmoved ? { discountMoved: dmoved } : {}));
    changed();
    send(res, 200, { ok: true, merge });
  },

  /* ส่วนลดท้ายบิล: ลดเป็น % หรือบาท จากค่าอาหาร (ก่อนค่าบริการ/VAT) ต้องมีเหตุผล
     แคชเชียร์ให้ส่วนลดต้องมี PIN เจ้าของ (เงินหายได้เหมือนยกเลิกออเดอร์) เอาส่วนลดออก (kind:none) ไม่ต้อง PIN เพราะราคากลับเป็นเต็ม
     เก็บที่โต๊ะ (D.discounts) ทุกเครื่องเห็นบนใบแจ้งยอด ปิดบิลแล้วลงในบิล */
  'POST /api/table/discount': async (req, res) => {
    const who = requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, t = tableNo(b.table), sub = store.billOf(t).sub, old = D.discounts[t];
    if (b.kind === 'none') {
      if (!old) throw fail('โต๊ะนี้ไม่มีส่วนลด', 409);
      delete D.discounts[t];
      audit(req, 'bill.discount_removed', { table: t, kind: old.kind, value: old.value, reason: old.reason });
      changed();
      return send(res, 200, { ok: true });
    }
    if (!(sub > 0)) throw fail('โต๊ะ ' + t + ' ยังไม่มีรายการ ให้ส่วนลดไม่ได้', 409);
    if (b.kind !== 'pct' && b.kind !== 'amt') throw fail('เลือกส่วนลดเป็น % หรือเป็นบาท');
    if (typeof b.value !== 'number' || !isFinite(b.value) || b.value <= 0) throw fail('ใส่จำนวนส่วนลดมากกว่า 0');
    const value = Math.round(b.value * 100) / 100;
    if (b.kind === 'pct' && value > 100) throw fail('ส่วนลดเป็น % ต้องไม่เกิน 100');
    if (b.kind === 'amt' && value > sub) throw fail('ส่วนลดเกินค่าอาหาร (' + sub + ' บาท)');
    const reason = str(b.reason, 80);
    if (reason.length < 2) throw fail('ต้องระบุเหตุผลที่ให้ส่วนลด');
    const approvedBy = who.role === 'owner' ? undefined : ownerApproval(req, b, 'ให้ส่วนลดต้องให้เจ้าของใส่ PIN อนุมัติ', { table: t });
    D.discounts[t] = Object.assign({ kind: b.kind, value, reason, by: { id: who.id, name: who.name }, at: Date.now() }, b.kind === 'pct' ? { base: sub } : {}, approvedBy ? { approvedBy } : {});
    audit(req, 'bill.discounted', Object.assign({ table: t, kind: b.kind, value, amount: store.discountOf(t, sub), sub, reason, before: old ? { kind: old.kind, value: old.value } : null }, approvedBy ? { approvedBy } : {}));
    changed();
    send(res, 200, { ok: true, disc: store.discountOf(t, sub) });
  },

  /* กลับบ้าน / เดลิเวอรี: ขอเลขคิว (เริ่ม 1 ใหม่ทุกวัน ข้ามเลขที่ยังค้าง) แล้วสั่งแทนลูกค้าเข้าเลขบิล QBASE + คิว
     ราคาเดียวกับหน้าร้าน ไม่มีค่าบริการ (หน้าพนักงานปิดค่าบริการให้เป็นค่าเริ่มต้น) รับเงินช่องทางแอปเดลิเวอรีใช้ "อื่นๆ" */
  'POST /api/queue': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, Q = D.queue;
    if (b.channel !== undefined && b.channel !== 'takeaway' && b.channel !== 'delivery') throw fail('ช่องทางต้องเป็นกลับบ้านหรือเดลิเวอรี');
    if (Q.day !== todayKey()) { Q.day = todayKey(); Q.next = 1; }
    let q = Q.next;
    while (Q.open[store.QBASE + q] && q < store.QBASE) q++;
    if (q >= store.QBASE) throw fail('เลขคิววันนี้เต็มแล้ว ปิดบิลคิวที่ค้างก่อน', 409);
    const t = store.QBASE + q;
    Q.open[t] = { q, name: str(b.name, 40), channel: b.channel === 'delivery' ? 'delivery' : 'takeaway', at: Date.now() };
    Q.next = q + 1;
    audit(req, 'queue.created', { queue: q, channel: Q.open[t].channel, customer: Q.open[t].name });
    changed();
    send(res, 200, { ok: true, queue: q, table: t });
  },
  'POST /api/queue/cancel': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, t = Math.floor(+b.table), q = D.queue.open[t];
    if (!store.isQueue(t) || !q) throw fail('ไม่พบคิวนี้', 404);
    if (D.tickets.some(k => k.table === t)) throw fail('คิว ' + q.q + ' มีออเดอร์อยู่ ยกเลิกออเดอร์ก่อน หรือปิดบิล', 409);
    delete D.queue.open[t]; delete D.discounts[t];
    audit(req, 'queue.cancelled', { queue: q.q });
    changed();
    send(res, 200, { ok: true });
  },

  /* ---- สต็อกวัตถุดิบ (lib/stock.js) ----
     ดู: ทุกบทบาท (ครัวต้องเห็นของใกล้หมด) · รับเข้า/เบิก/ของเสีย/ปรับยอด: เจ้าของ+แคชเชียร์ · วัตถุดิบและสูตร: เจ้าของ */
  'GET /api/stock': async (req, res) => {
    requireStaff(req);
    const D = st.D;
    // ทุน มูลค่า สูตร (= กำไรต่อจาน) เฉพาะเจ้าของ แคชเชียร์/ครัวเห็นคงเหลือและการเคลื่อนไหว
    const own = requireStaff(req).role === 'owner';
    const items = D.stock.items.map(i => { const o = Object.assign({}, i, { low: i.min > 0 && i.qty <= i.min }); if (!own) delete o.cost; return o; });
    const lg = D.stockLog.slice(-200).reverse().map(e => { if (own || e.cost === undefined) return e; const o = Object.assign({}, e); delete o.cost; return o; });
    send(res, 200, Object.assign({ items, recipes: own ? D.recipes : {}, log: lg, low: stock.low(D) }, own ? { value: stock.value(D) } : {}));
  },
  'POST /api/stock/item': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, name = str(b.name, 60), unit = str(b.unit, 20);
    if (!name) throw fail('ใส่ชื่อวัตถุดิบ');
    if (!unit) throw fail('ใส่หน่วย เช่น กก. ฟอง ขวด');
    const old = b.id !== undefined && b.id !== null ? stock.find(D, +b.id) : null;
    if (b.id !== undefined && b.id !== null && !old) throw fail('ไม่พบวัตถุดิบนี้', 404);
    if (D.stock.items.some(i => i.name === name && i !== old)) throw fail('มีวัตถุดิบชื่อ ' + name + ' อยู่แล้ว');
    const min = b.min === undefined || b.min === '' ? (old ? old.min : 0) : money(b.min, 'จุดสั่งซื้อ (ขั้นต่ำ) ');
    if (old) {
      const before = pick(old, ['name', 'unit', 'min']);
      Object.assign(old, { name, unit, min });
      audit(req, 'stock.item.updated', Object.assign({ stockItem: old.id }, diff(before, pick(old, ['name', 'unit', 'min'])) || {}));
      changed();
      return send(res, 200, { ok: true, item: old });
    }
    const cost = b.cost === undefined || b.cost === '' ? 0 : money(b.cost, 'ราคาทุนต่อหน่วย ');
    const item = { id: D.stock.nextId++, name, unit, qty: 0, min, cost };
    D.stock.items.push(item);
    audit(req, 'stock.item.created', { stockItem: item.id, itemName: name, unit, min, cost });
    changed();
    send(res, 200, { ok: true, item });
  },
  'POST /api/stock/item/delete': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, it = stock.find(D, +b.id);
    if (!it) throw fail('ไม่พบวัตถุดิบนี้', 404);
    const usedBy = D.menu.items.filter(m => (D.recipes[m.id] || []).some(l => l.s === it.id)).map(m => m.name);
    if (usedBy.length) throw fail(it.name + ' ใช้อยู่ในสูตร: ' + usedBy.join(', ') + ' เอาออกจากสูตรก่อน', 409);
    D.stock.items = D.stock.items.filter(x => x !== it);
    audit(req, 'stock.item.deleted', { stockItem: it.id, itemName: it.name, qty: it.qty, unit: it.unit });
    changed();
    send(res, 200, { ok: true });
  },
  /* รับเข้า (ราคาทุนใหม่ = ทุนเฉลี่ยถ่วงน้ำหนัก) · เบิกใช้ · ของเสีย (ต้องมีเหตุผล) · ปรับยอดตามที่นับได้จริง
     ปรับยอดต้องส่ง from = ยอดที่เห็นตอนนับ ระหว่างนั้นมีออเดอร์ตัดสต็อก = 409 (แบบ from ของตั๋ว) */
  'POST /api/stock/move': async (req, res) => {
    const who = requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, it = stock.find(D, +b.id);
    if (!it) throw fail('ไม่พบวัตถุดิบนี้', 404);
    const TYPES = { receive: 'รับเข้า', issue: 'เบิกใช้', waste: 'ของเสีย', adjust: 'ปรับยอด' };
    if (!TYPES[b.type]) throw fail('ประเภทรายการไม่ถูกต้อง');
    if (typeof b.qty !== 'number' || !isFinite(b.qty) || b.qty < 0 || b.qty > 1000000 || (b.type !== 'adjust' && b.qty === 0)) throw fail('จำนวนต้องเป็นตัวเลขมากกว่า 0');
    const qty = stock.r3(b.qty), note = str(b.note, 80);
    if (b.type === 'waste' && note.length < 2) throw fail('ของเสียต้องระบุเหตุผล เช่น เน่า หก หมดอายุ');
    let delta, cost;
    if (b.type === 'adjust') {
      if (b.from !== it.qty) throw fail('ยอดคงเหลือของ ' + it.name + ' เปลี่ยนไประหว่างนับ (มีออเดอร์ตัดสต็อก) ตรวจยอดใหม่', 409);
      delta = stock.r3(qty - it.qty);
    } else delta = b.type === 'receive' ? qty : -qty;
    if (b.type === 'receive' && b.cost !== undefined && b.cost !== null && b.cost !== '') {
      cost = money(b.cost, 'ราคาทุนต่อหน่วย ');
      it.cost = it.qty > 0 ? stock.r2((it.qty * it.cost + qty * cost) / (it.qty + qty)) : cost;
    }
    const before = it.qty;
    it.qty = stock.r3(it.qty + delta);
    const e = Object.assign({ type: b.type, s: it.id, name: it.name, unit: it.unit, qty: delta }, cost !== undefined ? { cost } : {}, note ? { note } : {}, { by: { id: who.id, name: who.name } });
    stock.log(D, e);
    audit(req, 'stock.moved', Object.assign({ stockItem: it.id, itemName: it.name, kind: b.type, change: delta, qtyBefore: before, qtyAfter: it.qty, unit: it.unit }, cost !== undefined ? { cost } : {}, note ? { note } : {}));
    changed();
    send(res, 200, { ok: true, item: it });
  },
  'POST /api/stock/recipe': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, m = store.menuItem(+b.menu);
    if (!m) throw fail('ไม่พบเมนูนี้');
    if (!Array.isArray(b.lines) || b.lines.length > 30) throw fail('สูตรต้องเป็นรายการวัตถุดิบ ไม่เกิน 30 อย่าง');
    const seen = new Set();
    const lines = b.lines.map(l => {
      const it = l && stock.find(D, +l.s);
      if (!it) throw fail('มีวัตถุดิบในสูตรที่ไม่มีในสต็อก');
      if (seen.has(it.id)) throw fail(it.name + ' ใส่ในสูตรซ้ำ');
      seen.add(it.id);
      if (typeof l.q !== 'number' || !isFinite(l.q) || l.q <= 0 || l.q > 100000) throw fail('ปริมาณ ' + it.name + ' ต่อจานต้องมากกว่า 0');
      return { s: it.id, q: stock.r3(l.q) };
    });
    const before = D.recipes[m.id] || [];
    if (lines.length) D.recipes[m.id] = lines; else delete D.recipes[m.id];
    audit(req, 'stock.recipe.changed', { menu: m.id, itemName: m.name, before, after: lines });
    changed();
    send(res, 200, { ok: true });
  },

  // เปลี่ยนรหัสใน QR ของโต๊ะเดียว (รูป QR หลุดออกไป / สงสัยมีคนแกล้งสั่ง) QR แผ่นเก่าของโต๊ะนั้นใช้ไม่ได้ทันที
  'POST /api/table/rekey': async (req, res) => {
    requireStaff(req);
    requireFresh(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, t = dineNo(b.table), old = D.keys[t];
    let k; do { k = crypto.randomBytes(4).toString('hex'); } while (k === old);
    D.keys[t] = k;
    audit(req, 'table.rekeyed', { table: t });              // ไม่บันทึกตัวรหัส (กฎข้อ 30)
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
    const who = requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D;
    const t = tableNo(b.table);
    const bill = store.billOf(t);
    if (!bill.lines.length) throw fail('โต๊ะนี้ไม่มีรายการ หรือปิดบิลไปแล้ว', 409);
    if (typeof b.expectedSub !== 'number') throw fail('ไม่มียอดที่ต้องตรวจสอบ');
    if (b.expectedSub !== bill.sub) {
      audit(req, 'bill.pay_rejected', { table: t, expectedSub: b.expectedSub, actualSub: bill.sub });
      throw fail('ยอดของโต๊ะ ' + t + ' เปลี่ยนไปแล้ว (มีการสั่งเพิ่มหรือยกเลิก) ตรวจยอดใหม่ก่อนรับเงิน', 409);
    }
    // ส่วนลดที่เห็นตอนกด (expectedDisc) ต้องตรงกับปัจจุบัน อีกเครื่องเพิ่ม/แก้/เอาออกระหว่างคิดเงิน = 409 (แบบ expectedSub)
    const disc = store.discountOf(t, bill.sub), dsc = D.discounts[t];
    if ((b.expectedDisc === undefined ? 0 : b.expectedDisc) !== disc) {
      audit(req, 'bill.pay_rejected', { table: t, expectedSub: b.expectedSub, actualSub: bill.sub, expectedDisc: b.expectedDisc, actualDisc: disc });
      throw fail('ส่วนลดของโต๊ะ ' + t + ' เปลี่ยนไปแล้ว ตรวจยอดใหม่ก่อนรับเงิน', 409);
    }
    // VAT ตัดสินจากตั้งค่าร้านเท่านั้น (b.vat จากหน้าเว็บเก่าไม่สนใจ) ร้านจด VAT ปิด VAT ทีละบิลไม่ได้ (tasks/spec-vat.md)
    const vc = store.vatCfg(D.settings);
    const x = store.totals(bill.sub, !!b.svc, disc, vc);
    const payments = paymentsFrom(b, x.total);
    const method = payments.length === 1 ? payments[0].method : 'mixed';
    // เงินสด: ถ้าส่งจำนวนที่รับมา ต้องไม่น้อยกว่าส่วนที่จ่ายเป็นเงินสด และบันทึกเงินทอนไว้ตรวจลิ้นชักย้อนหลัง
    const cashPart = payments.find(p => p.method === 'cash');
    let received = null, change = null;
    if (cashPart && b.received !== undefined && b.received !== null) {
      if (typeof b.received !== 'number' || !isFinite(b.received) || b.received > 1000000) throw fail('จำนวนเงินที่รับมาไม่ถูกต้อง');
      if (b.received < cashPart.amount) throw fail('เงินที่รับมาน้อยกว่ายอดที่ต้องชำระเป็นเงินสด');
      received = Math.round(b.received * 100) / 100;
      change = Math.round((received - cashPart.amount) * 100) / 100;
    }
    const sale = {
      no: D.nextBill++, at: Date.now(), table: t, sub: bill.sub, svc: x.svc, vat: x.vat, total: x.total,
      method, payments, cashier: { id: who.id, name: who.name },
      ...(vc.on ? { vatRate: vc.rate, vatIncl: vc.incl } : {}),
      items: bill.lines.map(l => Object.assign({ name: l.name, qty: l.qty, price: l.price }, l.costSum !== undefined ? { cost: stock.r2(l.costSum / l.qty) } : {}))
    };
    // ต้นทุนวัตถุดิบของบิล (เฉพาะเมนูที่มีสูตร) บิลที่ไม่มีสูตรเลยไม่มี cogs = ไม่รู้ทุน ไม่ใช่ทุน 0
    if (bill.lines.some(l => l.costSum !== undefined)) sale.cogs = stock.r2(bill.lines.reduce((a, l) => a + (l.costSum || 0), 0));
    const qd = D.queue.open[t];
    if (qd) Object.assign(sale, { queue: qd.q, channel: qd.channel }, qd.name ? { name: qd.name } : {});
    delete D.queue.open[t];
    if (disc > 0) Object.assign(sale, { disc, discount: Object.assign({ kind: dsc.kind, value: dsc.value, reason: dsc.reason, by: dsc.by }, dsc.approvedBy ? { approvedBy: dsc.approvedBy } : {}) });
    const ticketIds = D.tickets.filter(k => k.table === t).map(k => k.id);
    D.sales.push(sale);
    store.archiveSale(sale);
    store.trimSales();
    D.tickets = D.tickets.filter(k => k.table !== t);
    delete D.calls[t];
    delete D.seated[t];                  // ปิดบิล = ปิดโต๊ะ ลูกค้าโต๊ะถัดไปต้องให้พนักงานเปิดใหม่
    delete D.discounts[t];
    st.changeSeq++;
    store.writeNow(); broadcast();      // ยอดเงินบันทึกทันที
    audit(req, 'bill.paid', { no: sale.no, table: t, method, payments, sub: sale.sub, disc, svc: sale.svc, vat: sale.vat, total: sale.total, received, change, tickets: ticketIds });
    send(res, 200, { ok: true, sale, received, change });
  },

  /* ---- เจ้าของ: คืนเงินบิลที่ปิดแล้ว (ดู tasks/spec-refund.md) ----
     บิลเดิมไม่ถูกแก้ ใบคืนเงินเป็นระเบียนใหม่ยอดติดลบ เลขที่จาก nextBill อ้างอิงบิลเดิมด้วย refundOf */
  'GET /api/bill': async (req, res, url) => {
    requireStaff(req);
    const no = +url.searchParams.get('no');
    const rs = Number.isInteger(no) ? refundState(no) : null;
    if (!rs) throw fail('ไม่พบบิลนี้ หรือเก่ากว่า 8 วัน (คืนเงินในระบบได้ 8 วันล่าสุด)', 404);
    send(res, 200, { sale: rs.sale, refunds: rs.refunds, lines: rs.lines, remaining: rs.remaining });
  },
  'POST /api/refund': async (req, res) => {
    const who = requireStaff(req);
    requireFresh(req);                   // เงินออกจากร้าน: ใส่ PIN ซ้ำ (กฎข้อ 48)
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D;
    const rs = Number.isInteger(b.no) ? refundState(b.no) : null;
    if (!rs) throw fail('ไม่พบบิลนี้ หรือเก่ากว่า 8 วัน (คืนเงินในระบบได้ 8 วันล่าสุด)', 404);
    const reason = str(b.reason, 80);
    if (reason.length < 2) throw fail('ต้องระบุเหตุผลที่คืนเงิน');
    if (!store.METHODS[b.method]) throw fail('เลือกช่องทางที่คืนเงิน');
    if (b.mode !== 'all' && b.mode !== 'items') throw fail('เลือกคืนทั้งบิลหรือบางรายการ');
    // ยอดที่เห็นตอนเปิดหน้าต่าง: อีกเครื่องคืนไปก่อนแล้ว = 409 (แบบ expectedSub) ตรวจก่อน หน้าจอจะได้โหลดยอดใหม่
    if (b.expected !== rs.remaining) throw fail('บิลนี้มีการคืนเงินไปแล้วระหว่างนั้น ตรวจยอดใหม่ก่อนคืน', 409);
    if (rs.remaining <= 0) throw fail('บิลนี้คืนเงินครบแล้ว');
    const sale = rs.sale;
    let picks;
    if (b.mode === 'all') picks = rs.lines.filter(l => l.left > 0).map(l => ({ l, qty: l.left }));
    else {
      if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 100) throw fail('เลือกรายการที่จะคืน');
      const seen = new Set();
      picks = b.lines.map(x => {
        const l = x && Number.isInteger(x.i) ? rs.lines[x.i] : null;
        if (!l || seen.has(x.i)) throw fail('รายการที่จะคืนไม่ถูกต้อง');
        seen.add(x.i);
        if (!Number.isInteger(x.qty) || x.qty < 1) throw fail('จำนวนที่คืนต้องเป็นจำนวนเต็มอย่างน้อย 1');
        if (x.qty > l.left) throw fail(l.name + ' คืนได้อีกไม่เกิน ' + l.left + ' จาน');
        return { l, qty: x.qty };
      });
    }
    // ยอดคืน = (ราคา × จำนวน) × ยอดรวมบิล ÷ ค่าอาหาร (ค่าบริการ VAT ส่วนลดหักตามสัดส่วน) คืนครบทุกจาน = ยอดที่เหลือพอดี (ไม่มีเศษปัด)
    const value = r2(picks.reduce((a, p) => a + p.l.price * p.qty, 0));
    const all = picks.every(p => p.qty === p.l.left) && picks.length === rs.lines.filter(l => l.left > 0).length;
    const f = sale.sub > 0 ? value / sale.sub : 0;
    const amount = all ? rs.remaining : Math.min(r2(value * sale.total / sale.sub), rs.remaining);
    const disc = sale.disc ? r2(sale.disc * f) : 0, svc = r2((sale.svc || 0) * f);
    const refund = {
      type: 'refund', no: D.nextBill++, at: Date.now(), refundOf: sale.no, refundOfAt: sale.at, table: sale.table,
      // VAT ที่คืน = VAT บิลเดิม × ยอดคืน ÷ ยอดบิล (ใช้ได้ทั้งแบบแยกและราคารวม VAT) คืนครบ = VAT ที่เหลือพอดี
      sub: 0 - value, svc: 0 - svc, vat: 0 - (all ? rs.vatLeft : (sale.total > 0 ? Math.min(r2(sale.vat * amount / sale.total), rs.vatLeft) : 0)), total: 0 - amount,
      method: b.method, payments: [{ method: b.method, amount: -amount }], reason, cashier: { id: who.id, name: who.name },
      items: picks.map(p => { const o = sale.items[p.l.i]; return Object.assign({ i: p.l.i, name: o.name, qty: -p.qty, price: o.price }, typeof o.cost === 'number' ? { cost: o.cost } : {}); })
    };
    if (disc) refund.disc = -disc;
    if (sale.vatRate) Object.assign(refund, { vatRate: sale.vatRate, vatIncl: !!sale.vatIncl });   // ใบคืนเงินพิมพ์ VAT แบบเดียวกับบิลเดิม
    if (typeof sale.cogs === 'number') refund.cogs = 0;          // อาหารทำไปแล้ว ไม่คืนสต็อก ทุนยังอยู่ (กำไรขั้นต้นลดตามยอดที่คืน)
    if (sale.queue) Object.assign(refund, { queue: sale.queue, channel: sale.channel }, sale.name ? { name: sale.name } : {});
    D.sales.push(refund);
    store.archiveSale(refund);
    st.changeSeq++;
    store.writeNow(); broadcast();      // บันทึกลงดิสก์ก่อนตอบ (กฎข้อ 18)
    audit(req, 'bill.refunded', { no: refund.no, refundOf: sale.no, table: sale.table, mode: b.mode, items: refund.items.map(i => ({ name: i.name, qty: -i.qty })), total: refund.total, method: b.method, reason });
    send(res, 200, { ok: true, refund, remaining: r2(rs.remaining - amount) });
  },

  /* ---- พนักงาน: ตั้งค่าร้าน ---- */
  'POST /api/settings': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    // แก้บนสำเนา ผ่านการตรวจทุกช่องแล้วค่อยแทนที่ (เดิมแก้ทีละช่อง ช่องหลังผิดแล้วตอบ 400 แต่ชื่อร้านที่แก้ไปก่อนเปลี่ยนในหน่วยความจำแล้ว ไม่มี audit)
    const was = st.D.settings, s = Object.assign({}, was);
    // ลิงก์โซเชียลมีเดีย / ลิงก์แชร์ร้าน: ตรวจโดเมนแพลตฟอร์ม (U.cleanLink) ส่งเฉพาะช่องที่จะแก้ได้
    let social = s.social, shareUrl = s.shareUrl;
    if (b.social !== undefined) {
      if (!b.social || typeof b.social !== 'object' || Array.isArray(b.social)) throw fail('ลิงก์โซเชียลมีเดียไม่ถูกต้อง');
      social = Object.assign({}, s.social);
      ['facebook', 'instagram', 'line', 'tiktok'].forEach(k => {
        if (b.social[k] === undefined) return;
        const r = U.cleanLink(k, b.social[k]);
        if (!r.ok) throw fail(r.error);
        social[k] = r.url;
      });
    }
    if (b.shareUrl !== undefined) {
      const r = U.cleanLink('share', b.shareUrl);
      if (!r.ok) throw fail(r.error);
      shareUrl = r.url;
    }
    if (typeof b.shop === 'string') s.shop = str(b.shop, 60) || s.shop;
    if (typeof b.address === 'string') s.address = str(b.address, 160);
    if (typeof b.phone === 'string') s.phone = str(b.phone, 40);
    if (typeof b.footer === 'string') s.footer = str(b.footer, 80);
    if (typeof b.taxId === 'string') {
      const d = b.taxId.replace(/\D/g, '');
      if (d && d.length !== 13) throw fail('เลขประจำตัวผู้เสียภาษีต้องมี 13 หลัก');
      s.taxId = d;
    }
    // เปลี่ยนเบอร์รับเงิน หรือที่อยู่ที่ QR ชี้ไป = ทางที่เงิน/ลูกค้าถูกพาไปที่อื่นได้ ต้องยืนยัน PIN ซ้ำ
    const ppNew = typeof b.promptpay === 'string' ? b.promptpay.replace(/\D/g, '') : s.promptpay;
    const urlNew = typeof b.baseUrl === 'string' ? b.baseUrl.trim().replace(/\/+$/, '') : s.baseUrl;
    // ลิงก์โซเชียลมีเดีย/แชร์ = พาลูกค้าไปที่อื่น ต้องยืนยัน PIN ซ้ำเหมือนกัน (กฎข้อ 48)
    if (ppNew !== s.promptpay || urlNew !== s.baseUrl || JSON.stringify(social) !== JSON.stringify(s.social) || shareUrl !== s.shareUrl) requireFresh(req);
    s.social = social; s.shareUrl = shareUrl;
    if (typeof b.tagline === 'string') s.tagline = str(b.tagline, 80);
    if (b.look !== undefined) {
      if (!['dark', 'light', 'auto'].includes(b.look)) throw fail('โทนสีหน้าลูกค้าต้องเป็น มืด สว่าง หรือ ตามเครื่องลูกค้า');
      s.look = b.look;
    }
    if (typeof b.requireSeat === 'boolean') s.requireSeat = b.requireSeat;
    if (b.hours !== undefined) {
      const h = b.hours, HM = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (!h || typeof h !== 'object' || typeof h.on !== 'boolean' || !HM.test(h.open) || !HM.test(h.close)) throw fail('เวลารับออเดอร์ต้องเป็นรูปแบบ ชั่วโมง:นาที เช่น 10:00');
      if (h.on && h.open === h.close) throw fail('เวลาเปิดกับเวลาปิดต้องไม่ใช่เวลาเดียวกัน');
      s.hours = { on: h.on, open: h.open, close: h.close };
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
    // VAT: เปลี่ยน = เปลี่ยนเงินที่เก็บจากลูกค้า ต้องใส่ PIN ซ้ำ (ตรวจด้านล่างรวมกับ PromptPay)
    ['vatRegistered', 'vatInclusive'].forEach(k => { if (b[k] !== undefined) { if (typeof b[k] !== 'boolean') throw fail('ค่าตั้ง VAT ไม่ถูกต้อง'); s[k] = b[k]; } });
    if (b.vatRate !== undefined) {
      const r = b.vatRate;
      if (typeof r !== 'number' || !isFinite(r) || r <= 0 || r > 30 || Math.round(r * 100) !== r * 100) throw fail('อัตรา VAT ต้องเป็นตัวเลขมากกว่า 0 ไม่เกิน 30 ทศนิยมไม่เกิน 2 ตำแหน่ง');
      s.vatRate = r;
    }
    if (['vatRegistered', 'vatInclusive', 'vatRate'].some(k => was[k] !== s[k])) requireFresh(req);
    if (typeof b.acceptOrders === 'boolean') s.acceptOrders = b.acceptOrders;
    if (typeof b.accent === 'string') {
      const a = b.accent.trim().toLowerCase();
      if (a) { const d = theme.derive(a); if (!d.ok) throw fail(d.error); }
      s.accent = a;
    }
    if (typeof b.baseUrl === 'string') {
      const u = b.baseUrl.trim().replace(/\/+$/, '');
      if (u && !/^https?:\/\/[^\s"'<>]+$/i.test(u)) throw fail('ที่อยู่เว็บต้องขึ้นต้นด้วย http:// หรือ https://');
      s.baseUrl = u;
    }
    st.D.settings = s;
    // สิ่งที่หน้าลูกค้าแสดง เปลี่ยนแล้ว version เพิ่ม หน้าลูกค้าที่เปิดอยู่โหลดเมนู/สีใหม่เอง (เดิมเฉพาะสี ชื่อร้านใหม่ต้องรีเฟรชเอง)
    if (['shop', 'address', 'phone', 'accent', 'tagline', 'look', 'social', 'shareUrl', 'hours', 'vatRegistered', 'vatInclusive', 'vatRate'].some(k => JSON.stringify(was[k]) !== JSON.stringify(s[k]))) st.D.menu.version++;
    store.ensureKeys();
    const d = diff(was, s);
    if (d) audit(req, 'settings.changed', d);
    changed();
    send(res, 200, { ok: true });
  },

  /* ---- ธีมร้าน: โลโก้และสี (เจ้าของเท่านั้น) ---- */
  'GET /api/theme/preview': async (req, res, url) => {
    requireStaff(req);
    const a = String(url.searchParams.get('accent') || '').toLowerCase();
    send(res, 200, Object.assign(a ? theme.derive(a) : { ok: true }, { presets: theme.PRESETS }));
  },

  'POST /api/settings/logo': (req, res) => brandImage(req, res, 'logo'),
  'POST /api/settings/logo/delete': (req, res) => brandImageDelete(req, res, 'logo'),
  // ภาพพื้นหลังหน้าลูกค้า (หน้าปกด้านบน + พื้นหลังจางทั้งหน้า + พื้นหลังหน้าเข้าสู่ระบบพนักงาน)
  'POST /api/settings/cover': (req, res) => brandImage(req, res, 'cover'),
  'POST /api/settings/cover/delete': (req, res) => brandImageDelete(req, res, 'cover'),
  // รูป QR รับเงินของร้าน (QR จากแอปธนาคาร / QR ร้านค้า) ใบแจ้งยอดใช้รูปนี้แทน QR ที่สร้างจากเบอร์ PromptPay
  'POST /api/settings/payqr': (req, res) => brandImage(req, res, 'payqr'),
  'POST /api/settings/payqr/delete': (req, res) => brandImageDelete(req, res, 'payqr'),

  'POST /api/soldout': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const id = +b.id;
    if (!store.menuItem(id)) throw fail('ไม่พบเมนู', 404);
    const set = new Set(st.D.settings.soldOut), before = set.has(id);
    if (b.soldOut) set.add(id); else set.delete(id);
    if (before !== set.has(id)) audit(req, 'menu.soldout', { item: id, itemName: store.menuItem(id).name, before, after: set.has(id) });
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
    const fields = { name, price: Math.round(price * 100) / 100, cat, station, desc: str(b.desc, 120), hidden: !!b.hidden, rec: !!b.rec };
    let m;
    if (b.id) {
      m = store.menuItem(+b.id);
      if (!m) throw fail('ไม่พบเมนูนี้ อาจถูกลบไปแล้ว', 404);
      // ค่าตอนเปิดหน้าแก้ (was) ต้องตรงกับตอนนี้ ไม่อย่างนั้นอีกเครื่องแก้ไปก่อน ถ้าบันทึกทับ ราคาใหม่จะถูกย้อนเงียบๆ
      if (b.was && typeof b.was === 'object' && ['name', 'price', 'cat', 'station', 'desc', 'hidden', 'rec'].some(k => b.was[k] !== undefined && b.was[k] !== m[k])) {
        throw fail('เมนูนี้ถูกแก้จากอีกเครื่องระหว่างที่คุณแก้อยู่ กดยกเลิกแล้วเปิดแก้ใหม่เพื่อดูข้อมูลล่าสุด', 409);
      }
      const d = diff(Object.assign({}, m), fields);
      Object.assign(m, fields);
      if (d) audit(req, 'menu.item.updated', Object.assign({ item: m.id, itemName: m.name }, d));
    } else {
      m = Object.assign({ id: D.menu.nextId++, image: '' }, fields);
      D.menu.items.push(m);
      audit(req, 'menu.item.created', { item: m.id, after: fields });
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
    delete D.recipes[m.id];
    audit(req, 'menu.item.deleted', { item: m.id, before: pick(m, ['name', 'price', 'cat', 'station', 'image']) });
    store.removeImageFile(m.image);
    menuChanged();
    send(res, 200, { ok: true });
  },

  'POST /api/menu/image': async (req, res, url) => {
    requireStaff(req);
    const id = +url.searchParams.get('id');
    if (!store.menuItem(id)) throw fail('ไม่พบเมนูนี้', 404);
    if (!/^image\/(jpeg|png|webp)$/i.test(req.headers['content-type'] || '')) throw fail('รองรับเฉพาะรูป JPG, PNG หรือ WebP', 415);
    const buf = await readRaw(req, C.IMG_MAX);
    const ext = U.sniffImage(buf);
    if (!ext) throw fail('ไฟล์นี้ไม่ใช่รูป JPG, PNG หรือ WebP');
    fs.mkdirSync(C.IMG_DIR, { recursive: true });
    const name = 'm' + id + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
    await U.retryAsync(() => U.writeAtomic(path.join(C.IMG_DIR, name), buf));
    notRestoring();
    const m = store.menuItem(id);      // หาใหม่หลัง await เมนูอาจถูกลบระหว่างรอ
    if (!m) { store.removeImageFile(name); throw fail('ไม่พบเมนูนี้', 404); }
    const old = m.image;
    m.image = name;
    store.removeImageFile(old);
    audit(req, 'menu.image.updated', { item: m.id, itemName: m.name, before: old, after: name });
    menuChanged();
    send(res, 200, { ok: true, image: name });
  },

  'POST /api/menu/image/delete': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const m = store.menuItem(+b.id);
    if (!m) throw fail('ไม่พบเมนูนี้', 404);
    audit(req, 'menu.image.removed', { item: m.id, itemName: m.name, before: m.image });
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
      if (c.name !== name) audit(req, 'menu.category.renamed', { category: c.id, before: c.name, after: name });
      c.name = name;
    } else {
      c = { id: D.menu.nextCatId++, name };
      D.menu.categories.push(c);
      audit(req, 'menu.category.created', { category: c.id, after: name });
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
    audit(req, 'menu.category.deleted', { category: id, before: D.menu.categories.find(c => c.id === id).name });
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
    if (JSON.stringify(out) !== JSON.stringify(st.D.menu.notes)) audit(req, 'menu.notes.changed', { before: st.D.menu.notes, after: out });
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
    const sold = today.filter(s => !store.isRefund(s)), refunds = today.filter(store.isRefund);
    let total = 0; const qty = {}, by = { cash: 0, transfer: 0, card: 0, other: 0 };
    today.forEach(s => {
      total += s.total;
      store.paymentsOf(s).forEach(p => { by[p.method] = Math.round(((by[p.method] || 0) + p.amount) * 100) / 100; });
      s.items.forEach(i => { qty[i.name] = (qty[i.name] || 0) + i.qty; });
    });
    const top = Object.keys(qty).filter(n => qty[n] > 0).map(n => ({ name: n, qty: qty[n] })).sort((a, b) => b.qty - a.qty).slice(0, 8);
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const start = U.dayStart(today0 - i * DAY + DAY / 2), end = U.dayStart(start + DAY + DAY / 2);
      let sum = 0, cnt = 0;
      D.sales.forEach(s => { if (s.at >= start && s.at < end) { sum += s.total; if (!store.isRefund(s)) cnt++; } });
      days.push({ date: start, total: r2(sum), count: cnt });
    }
    let pending = 0; const seen = {};
    D.tickets.forEach(k => { if (!seen[k.table]) { seen[k.table] = 1; pending += store.billOf(k.table).sub; } });
    send(res, 200, {
      count: sold.length, total: r2(total), cash: by.cash, transfer: by.transfer, card: by.card, other: by.other, avg: sold.length ? Math.round(total / sold.length) : 0,
      refunds: { count: refunds.length, value: r2(-refunds.reduce((a, f) => a + f.total, 0)) },
      pending, openTables: Object.keys(seen).length, top, days, bills: today.slice().reverse()
    });
  },

  /* ---- รายงานช่วงเวลา: วันนี้ (เจ้าของ+แคชเชียร์) / เดือนนี้ / ปีนี้ (เจ้าของ) ----
     ยอด ช่องทาง คนรับเงิน เมนูขายดี/ขายไม่ดี/ไม่มีใครสั่ง จาก sales/ (ยอดจริง) + บิลที่ยังไม่ลงไฟล์ใน D.sales
     รายการยกเลิกมาจาก audit (ticket.voided, ticket.item_voided) เพราะไม่มีที่อื่นเก็บ ไม่ใช่ยอดขาย
     เดือน/ปี อ่านไฟล์แบบ async ทีละเดือน (กฎข้อ 33) */
  'GET /api/report/range': async (req, res, url) => {
    const who = requireStaff(req);
    const period = url.searchParams.get('period') || 'today';
    if (!['today', 'month', 'year'].includes(period)) throw fail('ช่วงเวลาต้องเป็น today, month หรือ year');
    if (period !== 'today' && who.role !== 'owner') throw fail('ยอดทั้งเดือน/ทั้งปี ดูได้เฉพาะเจ้าของร้าน', 403);
    const t = Date.now(), d = new Date(t);
    const from = period === 'today' ? U.dayStart(t) : period === 'month' ? new Date(d.getFullYear(), d.getMonth(), 1).getTime() : new Date(d.getFullYear(), 0, 1).getTime();
    const to = period === 'today' ? U.dayStart(from + C.DAY + C.DAY / 2) : period === 'month' ? new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() : new Date(d.getFullYear() + 1, 0, 1).getTime();
    const months = monthsBetween(from, Math.min(to, t + 1));
    const isVoid = r => (r.action === 'ticket.voided' || r.action === 'ticket.item_voided') && Date.parse(r.at) >= from && Date.parse(r.at) < to;
    let sales, voids;
    if (period === 'today') {
      sales = st.D.sales.filter(s => s.at >= from && s.at < to);
      voids = log.readRange('audit', U.monthKey(from), from, to).filter(isVoid);
    } else {
      voids = [];
      for (const m of months) voids = voids.concat(await log.scan('audit', m, 'voided"', isVoid));
      sales = await salesBetween(from, to);
    }
    send(res, 200, Object.assign({ period, from, to }, rangeReport(sales, voids, period, from, months)));
  },

  /* ---- เจ้าของ: สรุปยอดขายและภาษี ช่วงวันที่ (สัปดาห์/เดือน/กำหนดเอง ไม่เกิน 366 วัน) ---- */
  'GET /api/report/tax': async (req, res, url) => {
    const who = requireStaff(req);
    const r = dayRange(url);
    const sales = await salesBetween(r.from, r.to);
    const set = st.D.settings;
    send(res, 200, Object.assign({ from: r.fromKey, to: r.toKey, generatedAt: Date.now(), by: who.name, shop: { shop: set.shop, address: set.address, phone: set.phone, taxId: set.taxId } }, taxSummary(sales, r.from, r.to)));
  },

  /* ---- กะ: เงินในลิ้นชัก ----
     เงินที่ควรมี = เงินทอนตั้งต้น + ส่วนที่จ่ายเป็นเงินสดของทุกบิลในกะ (เงินทอนหักไปแล้ว: ส่วนเงินสด = รับมา - ทอน)
     ไม่บังคับมีกะ ร้านที่ไม่ใช้ขายได้เหมือนเดิม */
  'GET /api/shift': async (req, res) => {
    requireStaff(req);
    const D = st.D;
    send(res, 200, { open: D.shift ? Object.assign({}, D.shift, shiftSummary(D.shift, Date.now())) : null, history: D.shiftLog.slice(-20).reverse() });
  },
  'POST /api/shift/open': async (req, res) => {
    const who = requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D;
    if (D.shift) throw fail('มีกะเปิดอยู่แล้ว (เปิดโดย ' + D.shift.openedBy.name + ') ปิดกะเดิมก่อน', 409);
    const float = money(b.float, 'เงินทอนตั้งต้น');
    D.shift = { id: D.nextShift++, openedAt: Date.now(), openedBy: { id: who.id, name: who.name }, float };
    audit(req, 'shift.opened', { shift: D.shift.id, float });
    changed();
    send(res, 200, { ok: true, shift: D.shift });
  },
  'POST /api/shift/close': async (req, res) => {
    const who = requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, sh = D.shift;
    // ส่ง id ของกะที่เห็น: อีกเครื่องปิด (แล้วอาจเปิดกะใหม่) ไปก่อน = 409 ไม่ปิดกะของคนอื่น
    if (!sh || sh.id !== +b.id) throw fail('กะนี้ถูกปิดไปแล้ว หรือยังไม่ได้เปิดกะ โหลดหน้าใหม่แล้วตรวจอีกครั้ง', 409);
    const counted = money(b.counted, 'เงินที่นับได้');
    const closedAt = Date.now(), sum = shiftSummary(sh, closedAt);
    const rec = Object.assign({}, sh, sum, { closedAt, closedBy: { id: who.id, name: who.name }, counted, diff: Math.round((counted - sum.expectedCash) * 100) / 100 });
    const note = str(b.note, 80); if (note) rec.note = note;
    D.shiftLog.push(rec); D.shiftLog = D.shiftLog.slice(-120);
    D.shift = null;
    audit(req, 'shift.closed', { shift: rec.id, float: rec.float, expectedCash: rec.expectedCash, counted, diff: rec.diff, bills: rec.bills, note: rec.note });
    store.writeNow(); broadcast();
    send(res, 200, { ok: true, shift: rec });
  },

  'GET /api/export.csv': async (req, res, url) => {
    requireStaff(req);
    // ใส่ ' นำหน้าค่าที่ขึ้นต้นด้วย = + - @ กัน Excel ตีความเป็นสูตร (CSV injection)
    // ยกเว้นเฉพาะค่าที่เป็นตัวเลขล้วน ("-2+3+cmd|..." ขึ้นต้นด้วยตัวเลขแต่เป็นสูตร)
    const q = v => { let s = String(v); if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const ranged = url.searchParams.has('from') || url.searchParams.has('to');
    const kind = url.searchParams.get('kind') || 'bills';
    if (!['bills', 'daily'].includes(kind)) throw fail('ชนิดไฟล์ต้องเป็น bills หรือ daily');
    let sales, name, rows, info;
    if (ranged) {
      const r = dayRange(url);
      sales = await salesBetween(r.from, r.to);
      name = (kind === 'daily' ? 'summary-' : 'sales-') + r.fromKey + '_' + r.toKey;
      info = { from: r.fromKey, to: r.toKey, kind };
      if (kind === 'daily') {
        const t = taxSummary(sales, r.from, r.to);
        const K = ['bills', 'refunds', 'sub', 'disc', 'svc', 'beforeVat', 'vat', 'total', 'refundValue', 'cash', 'transfer', 'card', 'other'];
        rows = [['วันที่', 'จำนวนบิล', 'ใบคืนเงิน', 'ค่าอาหาร', 'ส่วนลด', 'ค่าบริการ', 'มูลค่าก่อน VAT', 'VAT', 'ยอดรวมสุทธิ', 'คืนเงิน', 'เงินสด', 'โอน/QR', 'บัตร', 'อื่นๆ'].map(q).join(',')];
        t.days.forEach(d => rows.push([d.date].concat(K.map(k => d[k])).map(q).join(',')));
        const all = Object.assign({}, t.totals, t.byMethod);
        rows.push(['รวม'].concat(K.map(k => all[k])).map(q).join(','));
      }
    } else {
      // แบบเดิม: ทั้งเดือนจากไฟล์ sales/ (ลิงก์ในหน้าสรุปยอดและไฟล์ที่ร้านเคยดาวน์โหลดยังได้ผลเหมือนเดิม)
      const month = url.searchParams.get('month') || U.monthKey(Date.now());
      if (!/^\d{4}-\d{2}$/.test(month)) throw fail('รูปแบบเดือนต้องเป็น YYYY-MM');
      let lines = [];
      try { lines = fs.readFileSync(path.join(C.SALES_DIR, month + '.jsonl'), 'utf8').split('\n').filter(Boolean); } catch (e) { lines = []; }
      sales = [];
      lines.forEach(l => { try { sales.push(JSON.parse(l)); } catch (e) { /* บรรทัดเสีย */ } });
      name = 'sales-' + month; info = { month };
    }
    if (!rows) {
      // คอลัมน์ใหม่อยู่หลัง "รวม" ก่อน "ชำระโดย" (กฎข้อ 66) "ชำระโดย … รับเงินโดย, รายการ" ท้ายสุดเสมอ
      rows = [['เลขที่', 'วันที่', 'เวลา', 'โต๊ะ', 'ค่าอาหาร', 'ค่าบริการ', 'VAT', 'รวม', 'ส่วนลด', 'เหตุผลส่วนลด', 'ต้นทุนวัตถุดิบ', 'คืนเงินของบิล', 'เหตุผลคืนเงิน', 'มูลค่าก่อน VAT', 'ชำระโดย', 'เงินสด', 'โอน/QR', 'บัตร', 'อื่นๆ', 'รับเงินโดย', 'รายการ'].map(q).join(',')];
      sales.forEach(s => {
        const d = new Date(s.at);
        rows.push([
          s.no, d.getFullYear() + '-' + U.pad(d.getMonth() + 1) + '-' + U.pad(d.getDate()), U.pad(d.getHours()) + ':' + U.pad(d.getMinutes()),
          s.queue ? 'คิว ' + s.queue : s.table, s.sub, s.svc, s.vat, s.total,
          s.disc || 0, s.discount && s.discount.reason ? s.discount.reason : '', typeof s.cogs === 'number' ? s.cogs : '', store.isRefund(s) ? s.refundOf : '', store.isRefund(s) ? s.reason || '' : '',
          r2((+s.total || 0) - (+s.vat || 0)) + 0, payLabel(s),
          ...['cash', 'transfer', 'card', 'other'].map(m => store.paymentsOf(s).filter(p => p.method === m).reduce((a, p) => a + p.amount, 0)),
          s.cashier && s.cashier.name ? s.cashier.name : '',
          (s.items || []).map(i => i.name + ' x' + i.qty).join('; ')
        ].map(q).join(','));
      });
    }
    audit(req, 'report.exported', Object.assign(info, { rows: rows.length - 1 }));
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="' + name + '.csv"' });
    res.end('\uFEFF' + rows.join('\r\n'));     // BOM ให้ Excel อ่านภาษาไทยได้
  },

  /* ---- เจ้าของ: จัดการพนักงาน ---- */
  'GET /api/staff': async (req, res) => {
    requireStaff(req);
    send(res, 200, { roles: ROLES, list: [ownerAccount()].concat(st.D.staff).map(a => Object.assign(me(a), { active: a.active, builtin: a.id === 'owner' })) });
  },

  // เพิ่ม (ไม่มี id) หรือแก้ชื่อ บทบาท PIN เปิด/ปิดบัญชี เปลี่ยน PIN/บทบาท/ปิดบัญชี แล้วเครื่องที่คนนั้นเข้าอยู่หลุดทันที
  'POST /api/staff': async (req, res) => {
    requireStaff(req);
    requireFresh(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D;
    if (b.id === 'owner') throw fail('บัญชีเจ้าของร้านเปลี่ยนรหัสที่ STAFF_PIN ตอนเปิดระบบ');
    const name = str(b.name, 30);
    if (!name) throw fail('ใส่ชื่อพนักงาน');
    if (!ROLES[b.role]) throw fail('เลือกบทบาท');
    let pin = null;
    if (b.pin !== undefined && b.pin !== '') {
      pin = String(b.pin);
      if (!/^\d{6,8}$/.test(pin)) throw fail('PIN ต้องเป็นตัวเลข 6 ถึง 8 หลัก');
      const h = pinHash(pin);
      if (U.safeEq(pin, C.PIN) || D.staff.some(s => s.id !== b.id && s.pinHash === h)) throw fail('PIN นี้มีคนใช้แล้ว ตั้ง PIN อื่น');
    }
    let a;
    if (b.id) {
      a = D.staff.find(s => s.id === b.id);
      if (!a) throw fail('ไม่พบพนักงานนี้', 404);
      const was = { name: a.name, role: a.role, active: a.active };
      a.name = name; a.role = b.role;
      if (typeof b.active === 'boolean') a.active = b.active;
      if (pin) a.pinHash = pinHash(pin);
      const d = diff(was, { name: a.name, role: a.role, active: a.active });
      if (pin || (d && (d.after.role !== undefined || d.after.active !== undefined))) a.ver++;
      if (d || pin) audit(req, 'staff.updated', Object.assign({ target: a.id, targetName: a.name, pinChanged: !!pin }, d || {}));
    } else {
      if (!pin) throw fail('ตั้ง PIN ให้พนักงาน (ตัวเลข 6 ถึง 8 หลัก)');
      if (D.staff.length >= 50) throw fail('เพิ่มพนักงานได้ไม่เกิน 50 คน');
      a = { id: 's' + D.nextStaffId++, name, role: b.role, active: true, ver: 0, pinHash: pinHash(pin) };
      D.staff.push(a);
      audit(req, 'staff.created', { target: a.id, after: { name, role: a.role } });
    }
    changed();
    send(res, 200, { ok: true, staff: Object.assign(me(a), { active: a.active }) });
  },

  // ทำให้ทุกเครื่องที่คนนี้เข้าอยู่หลุด (เช่น ทำมือถือหาย ลืมออกจากระบบที่เครื่องร้าน)
  'POST /api/staff/logout-all': async (req, res) => {
    requireStaff(req);
    requireFresh(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D;
    if (b.id === 'owner') D.ownerVer = (D.ownerVer || 0) + 1;
    else { const a = D.staff.find(s => s.id === b.id); if (!a) throw fail('ไม่พบพนักงานนี้', 404); a.ver++; }
    audit(req, 'staff.sessions_revoked', { target: b.id });
    changed();
    const self = staffOf(req).id === b.id;
    send(res, 200, { ok: true, self }, self ? { 'Set-Cookie': 'st=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' } : {});
  },

  /* ---- พนักงาน: log ---- */
  // เหตุการณ์ของวันหนึ่ง (ค่าเริ่มต้นวันนี้) พร้อมผลตรวจ hash chain ของเดือนนั้น
  'GET /api/audit': async (req, res, url) => {
    requireStaff(req);
    const kind = url.searchParams.get('kind') === 'security' ? 'security' : 'audit';
    const date = url.searchParams.get('date') || '';
    let from = U.dayStart(Date.now());
    if (date) {
      const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) throw fail('รูปแบบวันที่ต้องเป็น YYYY-MM-DD');
      from = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    }
    const to = U.dayStart(from + C.DAY + C.DAY / 2), month = U.monthKey(from);
    const events = log.readRange(kind, month, from, to);
    const chain = kind === 'audit' ? await log.verify(month) : null;
    send(res, 200, { kind, from, events: events.slice(-500), total: events.length, chain });
  },

  'GET /api/logs/download': async (req, res, url) => {
    requireStaff(req);
    const name = url.searchParams.get('name') || '';
    if (!C.LOG_RE.test(name)) throw fail('ชื่อไฟล์ไม่ถูกต้อง');
    const file = path.join(C.LOG_DIR, name);
    if (!fs.existsSync(file)) throw fail('ไม่พบไฟล์ log นี้', 404);
    audit(req, 'log.downloaded', { file: name });
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="' + name + '"' });
    fs.createReadStream(file).pipe(res);
  },

  /* ---- พนักงาน: สำรองข้อมูล ---- */
  'GET /api/backups': async (req, res) => {
    requireStaff(req);
    send(res, 200, { list: backup.list(), last: st.D.lastBackup || null, copyDir: C.BK_COPY || '', dir: C.BK_DIR });
  },

  'POST /api/backup': async (req, res) => {
    requireStaff(req);
    const who = actor(req), bk = await backup.writeBackup('manual');
    audit(req, 'backup.created', { file: bk.name, copied: bk.copied }, who);
    send(res, 200, { ok: true, backup: bk });
  },

  'GET /api/backup/download': async (req, res, url) => {
    requireStaff(req);
    requireFresh(req);                     // ไฟล์สำรองมีรหัส QR ทุกโต๊ะและ PIN hash
    const name = url.searchParams.get('name') || '';
    if (!C.BK_RE.test(name)) throw fail('ชื่อไฟล์ไม่ถูกต้อง');
    const file = path.join(C.BK_DIR, name);
    if (!fs.existsSync(file)) throw fail('ไม่พบไฟล์สำรองนี้', 404);
    audit(req, 'backup.downloaded', { file: name });
    res.writeHead(200, {
      'Content-Type': name.endsWith('.gz') ? 'application/gzip' : 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="' + name + '"'
    });
    fs.createReadStream(file).pipe(res);
  },

  'POST /api/backup/restore': async (req, res) => {
    requireStaff(req);
    requireFresh(req);
    if (!/^application\/(json|gzip|x-gzip|octet-stream)\b/i.test(req.headers['content-type'] || '')) throw fail('ต้องส่งไฟล์สำรอง (.json.gz หรือ .json)', 415);
    if (st.restoring) throw fail('กำลังกู้คืนข้อมูลอยู่ รอสักครู่', 409);
    const who = actor(req);              // คิดก่อนกู้คืน หลังกู้คืน secret เปลี่ยน cookie เดิมจะไม่ใช่พนักงานแล้ว
    const buf = await readRaw(req, C.RESTORE_MAX);
    let r;
    try { r = await backup.restore(buf); }
    catch (e) { audit(req, 'backup.restore_failed', { bytes: buf.length, error: e.message }, who); throw e; }
    audit(req, 'backup.restored', { from: r.createdAt, safetyBackup: r.before.name, dropped: r.dropped, bytes: buf.length }, who);
    broadcast();
    // รหัสเข้าระบบผูกกับข้อมูล จึงออก cookie ใหม่ให้เครื่องที่กดกู้คืน (เครื่องอื่นต้องเข้าสู่ระบบใหม่)
    send(res, 200, { ok: true, restoredFrom: r.createdAt, safetyBackup: r.before.name, dropped: r.dropped }, { 'Set-Cookie': (() => { const ses = issue((who.staff && findAccount(who.staff)) || ownerAccount()); fresh.set(ses.value, Date.now()); return ses.header; })() });
  }
};

module.exports = { api, clients, requireStaff, lanUrl, lanCandidates, PERM, ROLES };
