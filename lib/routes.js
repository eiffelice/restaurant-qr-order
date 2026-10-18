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
const biz = require('./biz');
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
  'POST /api/ticket/void': FRONT, 'POST /api/call/clear': SERVE, 'POST /api/pay': FRONT, 'GET /api/report': FRONT,
  'POST /api/table/seat': SERVE, 'POST /api/reauth': ALL, 'GET /api/reauth': ALL,
  'POST /api/sale': FRONT,               // ขายหน้าร้าน = รับเงิน (พนักงานเสิร์ฟ/ครัวไม่แตะเงิน กฎข้อ 54)
  // เอกสารขาย (ใบเสนอราคา ใบแจ้งหนี้ รับชำระ) และผู้ติดต่อ: เจ้าของ+แคชเชียร์ · ใบสั่งซื้อ รับสินค้า ยกเลิกเอกสาร ปรับสต็อก: เจ้าของ (ไม่อยู่ในนี้)
  'GET /api/docs': FRONT, 'GET /api/doc': FRONT, 'POST /api/doc': FRONT, 'POST /api/doc/convert': FRONT, 'POST /api/doc/pay': FRONT,
  'GET /api/contacts': FRONT, 'POST /api/contact': FRONT, 'GET /api/stock': FRONT
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
const recentSales = new Map();      // กันขายหน้าร้านซ้ำ (กดรับเงินสองครั้ง เน็ตสะดุดแล้วส่งใหม่)
setInterval(() => {
  const now = Date.now();
  hits.forEach((arr, k) => { if (!arr.length || now - arr[arr.length - 1] > 120000) hits.delete(k); });
  recentOrders.forEach((v, k) => { if (now - v.at > 600000) recentOrders.delete(k); });
  recentSales.forEach((v, k) => { if (now - v.at > 600000) recentSales.delete(k); });
  fresh.forEach((at, k) => { if (now - at > C.REAUTH_MS) fresh.delete(k); });
  seenSec.forEach((at, k) => { if (now - at > 600000) seenSec.delete(k); });
}, 60000).unref();

function tableNo(v) {
  const t = Math.floor(+v);
  if (!(t >= 1 && t <= st.D.settings.tables)) throw fail('ไม่พบโต๊ะนี้');
  return t;
}
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
// ช่องใน CSV: ใส่ ' นำหน้าค่าที่ขึ้นต้นด้วย = + - @ กัน Excel ตีความเป็นสูตร (CSV injection)
// ยกเว้นเฉพาะค่าที่เป็นตัวเลขล้วน ("-2+3+cmd|..." ขึ้นต้นด้วยตัวเลขแต่เป็นสูตร)
const csvCell = v => { let s = String(v); if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
const billNo = (no, at) => 'R' + U.ymd(at) + '-' + String(no).padStart(4, '0');      // แบบเดียวกับ billNo() ในหน้าพนักงาน
const r2 = n => Math.round(n * 100) / 100;

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
  st.D.sales.forEach(b => { if (b.at >= since && b.kind !== 'buy') b.items.forEach(i => qty.set(i.name, (qty.get(i.name) || 0) + i.qty)); });
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
  if (!s.acceptOrders || !s.modes.table) return 'off';      // ร้านที่ไม่ใช้โต๊ะ (ขายหน้าร้านอย่างเดียว) = QR โต๊ะสั่งไม่ได้
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
/* ---------- เอกสาร: ใบเสนอราคา (QT) ใบแจ้งหนี้/ใบส่งของ (INV) ใบสั่งซื้อ (PO) ใบรับสินค้า (GR) ใบเบิก/ตัดสต็อก (OUT) ใบตรวจนับ (CNT) ----------
   ราคาในเอกสารพนักงานพิมพ์เองได้ (ต่อรองราคา/ราคาซื้อ) แต่ยอดรวมคิดที่เซิร์ฟเวอร์ (store.docTotals) และทุกการเปลี่ยนแปลงลง audit
   เลขที่เอกสารรันต่อเนื่องต่อประเภทต่อปี ห้ามย้อน (store.nextDocNo) เอกสารที่ออกแล้วเก็บสำเนาชื่อที่อยู่คู่ค้าของตัวเอง */
const DOC_NAME = { QT: 'ใบเสนอราคา', INV: 'ใบแจ้งหนี้', PO: 'ใบสั่งซื้อ', GR: 'ใบรับสินค้า', OUT: 'ใบเบิก/ตัดสต็อก', CNT: 'ใบตรวจนับสต็อก' };
const DOC_GROUP = { sales: ['QT', 'INV'], purchase: ['PO', 'GR'], stock: ['GR', 'OUT', 'CNT'] };
// 'YYYY-MM-DD' (จากช่องวันที่) → เวลาเที่ยงคืนของวันนั้นตามเครื่องร้าน · ไม่ส่ง = def
function dayTs(v, def, label) {
  if (v === undefined || v === null || v === '') return def;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  const t = m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : NaN;
  if (!m || !isFinite(t) || Math.abs(t - Date.now()) > 5 * 366 * C.DAY) throw fail(label + 'ไม่ถูกต้อง');
  return t;
}
function docParty(p, type) {
  p = p && typeof p === 'object' ? p : {};
  const who = type === 'PO' ? 'ผู้ขาย' : 'ลูกค้า';
  const party = { name: str(p.name, 100) };
  if (!party.name) throw fail('ใส่ชื่อ' + who);
  party.address = str(p.address, 200); party.phone = str(p.phone, 40); party.branch = str(p.branch, 30);
  const tax = String(p.taxId == null ? '' : p.taxId).replace(/\D/g, '');
  if (tax && tax.length !== 13) throw fail('เลขประจำตัวผู้เสียภาษีของ' + who + 'ต้องมี 13 หลัก');
  party.taxId = tax;
  if (typeof p.contactId === 'string' && st.D.contacts.some(c => c.id === p.contactId)) party.contactId = p.contactId;
  return party;
}
// รายการในเอกสาร: จากรายการสินค้า (id) หรือพิมพ์เอง (บริการ ค่าขนส่ง) จำนวนทศนิยม 3 ตำแหน่ง ราคา 2 ตำแหน่ง
function docLines(arr, max) {
  if (!Array.isArray(arr) || !arr.length) throw fail('ยังไม่มีรายการ');
  if (arr.length > (max || 200)) throw fail('เอกสารหนึ่งฉบับมีได้ไม่เกิน ' + (max || 200) + ' รายการ');
  return arr.map((l, i) => {
    const w = 'รายการที่ ' + (i + 1) + ': ';
    if (!l || typeof l !== 'object') throw fail(w + 'รูปแบบไม่ถูกต้อง');
    const o = { name: str(l.name, 120) };
    if (l.id !== undefined && l.id !== null && l.id !== '') {
      const m = store.menuItem(+l.id);
      if (!m) throw fail(w + 'ไม่พบสินค้านี้แล้ว');
      o.id = m.id; if (!o.name) o.name = m.name;
    }
    if (!o.name) throw fail(w + 'ใส่ชื่อรายการ');
    const n = Number(l.qty), q = Math.round(n * 1000) / 1000;
    if (l.qty === '' || l.qty === null || !isFinite(n) || !(q > 0) || q > 1000000) throw fail(w + 'จำนวนต้องมากกว่า 0');
    const pr = Number(l.price);
    if (l.price === '' || l.price === null || l.price === undefined || !isFinite(pr) || pr < 0 || pr > 10000000) throw fail(w + 'ราคาต่อหน่วยไม่ถูกต้อง');
    o.qty = q; o.unit = str(l.unit, 12); o.price = Math.round(pr * 100) / 100;
    if (!o.unit && o.id) o.unit = store.menuItem(o.id).unit || '';
    return o;
  });
}
function docInput(b, type) {
  const s = st.D.settings, lines = docLines(b.lines);
  const disc = b.discount === undefined || b.discount === '' || b.discount === null ? 0 : Number(b.discount);
  if (!isFinite(disc) || disc < 0) throw fail('ส่วนลดไม่ถูกต้อง');
  const t = store.docTotals(lines, disc, b.vat === true);
  if (Math.round(disc * 100) / 100 > t.sub) throw fail('ส่วนลดมากกว่ายอดรวม');
  if (t.total > 100000000) throw fail('ยอดเอกสารเกิน 100 ล้านบาท');
  const date = dayTs(b.date, U.dayStart(Date.now()), 'วันที่เอกสาร');
  const defDue = type === 'QT' ? date + s.quoteDays * C.DAY : type === 'INV' ? date + s.creditDays * C.DAY : null;
  const due = dayTs(b.due, defDue, type === 'QT' ? 'วันยืนราคา' : type === 'INV' ? 'วันครบกำหนดชำระ' : 'วันที่ต้องการรับของ');
  if (due !== null && due < date) throw fail((type === 'QT' ? 'วันยืนราคา' : type === 'INV' ? 'วันครบกำหนดชำระ' : 'วันที่ต้องการรับของ') + 'ต้องไม่ก่อนวันที่เอกสาร');
  return Object.assign({ party: docParty(b.party, type), lines, discount: Math.round(disc * 100) / 100, vat: b.vat === true, note: str(b.note, 300), date, due }, t);
}
// เพิ่มผู้ติดต่อจากหัวเอกสาร (ติ๊ก "บันทึกเป็นผู้ติดต่อ" ตอนพิมพ์ชื่อใหม่)
function saveContactFrom(req, party, kind) {
  const D = st.D;
  if (party.contactId || D.contacts.length >= 2000) return;
  const c = { id: 'c' + D.nextContactId++, name: party.name, kind, taxId: party.taxId, branch: party.branch, address: party.address, phone: party.phone, email: '', note: '' };
  D.contacts.push(c);
  party.contactId = c.id;
  audit(req, 'contact.created', { contact: c.id, contactName: c.name, kindOf: kind });
}
// ใบแจ้งหนี้ = ส่งของแล้ว: ตัดสต็อกสินค้าที่นับสต็อก จดจำนวนที่ตัดไว้ที่แถว (got) ยกเลิกแล้วคืนเท่าที่ตัดไปจริง
function invStockOut(d) {
  d.lines.forEach(l => { const m = l.id && store.menuItem(l.id); if (store.tracked(m)) { store.stockMove(m, -l.qty, 'inv', d.no); l.got = l.qty; } });
}
function newDoc(type, who, f, extra) {
  const now = Date.now();
  return Object.assign({ no: store.nextDocNo(type), type, status: { QT: 'open', INV: 'unpaid', PO: 'open' }[type] || 'done', rev: 0, createdAt: now, updatedAt: now, ref: '', issuer: { id: who.id, name: who.name } }, f, extra || {});
}
const docBrief = d => ({ no: d.no, type: d.type, party: d.party.name, total: d.total, lines: d.lines.map(l => pick(l, ['name', 'qty', 'price'])) });
// สรุปให้หน้าพนักงาน: ใบแจ้งหนี้ค้างชำระ (เกินกำหนดกี่ใบ) ใบสั่งซื้อรอรับของ
function docStats() {
  const now = Date.now(), r = { unpaid: 0, unpaidTotal: 0, overdue: 0, po: 0, qt: 0 };
  st.D.docs.forEach(d => {
    if (d.type === 'INV' && d.status === 'unpaid') { r.unpaid++; r.unpaidTotal = Math.round((r.unpaidTotal + d.total) * 100) / 100; if (d.due !== null && d.due + C.DAY <= now) r.overdue++; }
    if (d.type === 'PO' && d.status === 'open') r.po++;
    if (d.type === 'QT' && d.status === 'open') r.qt++;
  });
  return r;
}
function findDoc(no) { return st.D.docs.find(d => d.no === no) || null; }
// เอกสารที่จบไปนานแล้ว (ไม่อยู่ใน data.json) ค้นจาก journal/ ของปีที่ออกและปีก่อน ฉบับล่าสุด = rev สูงสุด
async function findDocAnywhere(no) {
  const d = findDoc(no);
  if (d) return d;
  const m = store.DOC_NO_RE.exec(String(no || ''));
  if (!m) return null;
  const y = +m[2], files = U.listDir(C.JOURNAL_DIR, C.JOURNAL_RE).filter(f => f.startsWith('docs-' + y + '-') || f.startsWith('docs-' + (y - 1) + '-'));
  let best = null;
  for (const f of files) (await store.readJournal(f)).forEach(r => { if (r.no === no && (!best || r.rev > best.rev)) best = r; });
  return best && store.cleanDoc(best) ? best : null;
}
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
    const used = new Set(vis.map(m => m.cat)), out = new Set(store.soldOutIds());
    send(res, 200, {
      shop: D.settings.shop, logo: D.settings.logo, cover: D.settings.cover, version: D.menu.version, notes: D.menu.notes,
      address: D.settings.address, phone: D.settings.phone, popular: popularIds(vis),
      tagline: D.settings.tagline, look: D.settings.look, social: D.settings.social, shareUrl: D.settings.shareUrl, hours: D.settings.hours,
      categories: D.menu.categories.filter(c => used.has(c.id)), terms: biz.info(D.settings.biz).terms,
      items: vis.map(m => ({ id: m.id, name: m.name, price: m.price, cat: m.cat, desc: m.desc, image: m.image, rec: m.rec, unit: m.unit, soldOut: out.has(m.id) })),
      svc: D.settings.svc, vat: D.settings.vat, tables: D.settings.tables
    });
  },

  // หน้าเข้าสู่ระบบพนักงานใช้ก่อนเข้าสู่ระบบ: ชื่อร้านกับโลโก้เท่านั้น
  'GET /api/brand': async (req, res) => {
    send(res, 200, { shop: st.D.settings.shop, logo: st.D.settings.logo, cover: st.D.settings.cover });
  },

  'GET /api/table': async (req, res, url) => {
    const D = st.D;
    const t = tableNo(url.searchParams.get('t'));
    checkAccess(req, t, url.searchParams.get('k'));
    const b = store.billOf(t);
    send(res, 200, {
      table: t, staff: frontStaff(req), sub: b.sub, call: D.calls[t] || null, menuVersion: D.menu.version,
      open: !qrClosed(t), closedReason: qrClosed(t), closedText: qrClosed(t) ? CLOSED_MSG[qrClosed(t)]() : '', seated: isSeated(t),
      soldOut: store.soldOutIds(), svc: D.settings.svc, vat: D.settings.vat,
      tickets: D.tickets.filter(k => k.table === t).map(k => ({ id: k.id, status: k.status, createdAt: k.createdAt, items: k.items }))
    });
  },

  'POST /api/order': async (req, res) => {
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D;
    const t = tableNo(b.table);
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
    const out = new Set(store.soldOutIds());       // หมดเอง + นับสต็อกแล้วหมด
    for (const it of b.items) {
      const m = store.menuItem(it && +it.id);
      if (!m || m.hidden) throw fail('มีเมนูที่ไม่มีขายแล้ว กรุณารีเฟรชหน้าเมนู');
      if (out.has(m.id)) throw fail(m.name + ' หมดแล้ว');
      const qty = Math.floor(+it.qty);
      if (!(qty >= 1 && qty <= 20)) throw fail('จำนวนไม่ถูกต้อง');
      if (store.tracked(m) && qty > m.stock) throw fail(m.name + ' เหลือ ' + m.stock + (m.unit ? ' ' + m.unit : '') + ' สั่งได้ไม่เกินนี้');
      const note = (Array.isArray(it.note) ? it.note : []).filter(n => D.menu.notes.includes(n)).slice(0, 10);
      count += qty;
      const station = D.menu.stations[m.station] ? m.station : Object.keys(D.menu.stations)[0];
      (groups[station] = groups[station] || []).push({ id: m.id, name: m.name, price: m.price, qty, note });
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
    audit(req, 'order.created', { table: t, tickets: made, items: all.map(i => pick(i, ['name', 'qty', 'price'])), value: value(all), memo });
    changed();
    send(res, 200, result);
  },

  'POST /api/call': async (req, res) => {
    const b = await readBody(req, C.BODY_LIMIT);
    const t = tableNo(b.table);
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
    D.tickets.forEach(k => { if (k.table >= 1 && !bills[k.table]) bills[k.table] = store.billOf(k.table); });   // table 0 = คิวขายหน้าร้าน จ่ายแล้ว ไม่มีบิล
    send(res, 200, {
      settings: D.settings, menu: D.menu, stations: D.menu.stations,
      tickets: D.tickets, calls: D.calls, bills, keys: FRONT.includes(who.role) ? D.keys : {},   // รหัส QR ทุกโต๊ะ: เฉพาะเจ้าของ/แคชเชียร์ (พนักงานเสิร์ฟสั่งแทนด้วย cookie ไม่ต้องใช้ ปิดบัญชีแล้วจะได้ไม่มีรหัสติดตัว)
      nextBill: D.nextBill,
      seated: D.seated, qrClosed: qrClosed(null),
      me: me(who), roles: ROLES, biz: biz.info(D.settings.biz),
      docStats: FRONT.includes(who.role) ? docStats() : null,
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
    audit(req, 'ticket.status', Object.assign({ ticket: k.id, table: k.table }, k.q ? { queue: k.q } : {}, { before: k.status, after: b.status }));
    k.status = b.status;
    // คิวขายหน้าร้านจ่ายเงินแล้ว ลูกค้ารับของแล้วไม่มีบิลให้ปิด เอาออกจากจอเลย
    if (k.table === 0 && k.status === 'served') st.D.tickets = st.D.tickets.filter(x => x !== k);
    changed();
    send(res, 200, { ok: true });
  },

  'POST /api/ticket/void': async (req, res) => {
    const who = requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, k = D.tickets.find(x => x.id === +b.id);
    if (!k) throw fail('ไม่พบออเดอร์', 404);
    // คิวขายหน้าร้านรับเงินไปแล้ว ยกเลิกตั๋วอย่างเดียวจะทำให้เงินกับของไม่ตรงกัน
    if (k.table === 0) throw fail('คิว ' + k.q + ' ชำระเงินที่หน้าร้านแล้ว ยกเลิกจากจอไม่ได้ ทำเสร็จแล้วกด "ลูกค้ารับแล้ว"', 409);
    const reason = str(b.reason, 80);
    if (reason.length < 2) throw fail('ต้องระบุเหตุผลที่ยกเลิก');
    // ครัวเริ่มทำแล้ว = ของเสียจริง แคชเชียร์ต้องให้เจ้าของใส่ PIN อนุมัติ
    let approvedBy;
    if (k.status !== 'new' && who.role !== 'owner') {
      if (!b.approvePin) throw codeFail('ครัวเริ่มทำแล้ว ต้องให้เจ้าของใส่ PIN อนุมัติการยกเลิก', 403, 'need_approval');
      if (limited('approve', ipOf(req), 6, 60000)) { security(req, 'auth.rate_limited', { kind: 'approve' }, 'approve'); throw fail('ลองบ่อยเกินไป รอสักครู่', 429); }
      if (pinLocked(req)) { security(req, 'auth.locked', { kind: 'approve' }, 'all'); throw fail('มีการใส่รหัสผิดหลายครั้ง ระบบพักการใส่ PIN 1 นาที (เครื่องร้านยังใช้ได้)', 429); }
      const o = ownerByPin(b.approvePin);
      if (!o) { loginFails.push(Date.now()); security(req, 'approve.failed', { ticket: k.id }); throw codeFail('PIN เจ้าของไม่ถูกต้อง', 403, 'need_approval'); }
      approvedBy = { id: o.id, name: o.name };
    }
    D.tickets = D.tickets.filter(x => x !== k);
    audit(req, 'ticket.voided', Object.assign({ ticket: k.id, table: k.table, status: k.status, by_order: k.by, items: k.items.map(i => pick(i, ['name', 'qty', 'price'])), value: value(k.items), reason }, approvedBy ? { approvedBy } : {}));
    changed();
    send(res, 200, { ok: true });
  },

  'POST /api/table/seat': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, t = tableNo(b.table);
    if (b.open) { if (!D.seated[t]) { D.seated[t] = { at: Date.now() }; audit(req, 'table.seated', { table: t }); } }
    else {
      if (D.tickets.some(k => k.table === t)) throw fail('โต๊ะ ' + t + ' ยังมีออเดอร์ ปิดบิลก่อนปิดโต๊ะ', 409);
      if (D.seated[t]) { delete D.seated[t]; audit(req, 'table.unseated', { table: t }); }
    }
    changed();
    send(res, 200, { ok: true });
  },

  // เปลี่ยนรหัสใน QR ของโต๊ะเดียว (รูป QR หลุดออกไป / สงสัยมีคนแกล้งสั่ง) QR แผ่นเก่าของโต๊ะนั้นใช้ไม่ได้ทันที
  'POST /api/table/rekey': async (req, res) => {
    requireStaff(req);
    requireFresh(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, t = tableNo(b.table), old = D.keys[t];
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
    requireStaff(req);
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
    const x = store.totals(bill.sub, !!b.svc, !!b.vat);
    const method = b.method === 'transfer' ? 'transfer' : 'cash';
    // เงินสด: ถ้าส่งจำนวนที่รับมา ต้องไม่น้อยกว่ายอด และบันทึกเงินทอนไว้ตรวจลิ้นชักย้อนหลัง
    let received = null, change = null;
    if (method === 'cash' && b.received !== undefined && b.received !== null) {
      if (typeof b.received !== 'number' || !isFinite(b.received) || b.received > 1000000) throw fail('จำนวนเงินที่รับมาไม่ถูกต้อง');
      if (b.received < x.total) throw fail('เงินที่รับมาน้อยกว่ายอดที่ต้องชำระ');
      received = Math.round(b.received * 100) / 100;
      change = Math.round((received - x.total) * 100) / 100;
    }
    const sale = {
      no: D.nextBill++, at: Date.now(), table: t, sub: bill.sub, svc: x.svc, vat: x.vat, total: x.total,
      method,
      items: bill.lines.map(l => ({ name: l.name, qty: l.qty, price: l.price }))
    };
    const ticketIds = D.tickets.filter(k => k.table === t).map(k => k.id);
    // สต็อก: ตัดตอนปิดบิล (ยกเลิกออเดอร์ก่อนปิดบิลจึงไม่ต้องคืนสต็อก)
    const byItem = new Map();
    bill.lines.forEach(l => { const m = store.menuItem(l.id); if (store.tracked(m)) byItem.set(m, (byItem.get(m) || 0) + l.qty); });
    byItem.forEach((qty, m) => store.stockMove(m, -qty, 'sale', billNo(sale.no, sale.at)));
    D.sales.push(sale);
    store.archiveSale(sale);
    store.trimSales();
    D.tickets = D.tickets.filter(k => k.table !== t);
    delete D.calls[t];
    delete D.seated[t];                  // ปิดบิล = ปิดโต๊ะ ลูกค้าโต๊ะถัดไปต้องให้พนักงานเปิดใหม่
    st.changeSeq++;
    store.writeNow(); broadcast();      // ยอดเงินบันทึกทันที
    audit(req, 'bill.paid', { no: sale.no, table: t, method, sub: sale.sub, svc: sale.svc, vat: sale.vat, total: sale.total, received, change, tickets: ticketIds });
    send(res, 200, { ok: true, sale, received, change });
  },

  /* ---- ขายหน้าร้าน: ไม่มีโต๊ะ เลือกสินค้าแล้วรับเงินทันที (ร้านค้าปลีก ร้านกาแฟ ขายกลับบ้าน รับซื้อของ) ----
     ราคามาจากเซิร์ฟเวอร์เสมอ (กฎข้อ 1) หน้าจอส่งยอดที่เห็นตอนกดรับเงินครั้งแรก (expectedSub) ไม่ตรง = 409 (กฎข้อ 2, 22, 40)
     reqId กันขายซ้ำเมื่อกดซ้ำหรือเน็ตสะดุดแล้วส่งใหม่ · ส่งเข้าจอครัว/บาร์ได้เป็นคิว (ตั๋ว table 0 จ่ายแล้ว ไม่อยู่ในบิลโต๊ะใด) */
  'POST /api/sale': async (req, res) => {
    const who = requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, s = D.settings;
    if (!s.modes.counter) throw fail('ร้านนี้ยังไม่ได้เปิดขายหน้าร้าน เปิดได้ที่ ตั้งค่า > ประเภทธุรกิจ', 409);
    const kind = b.kind === 'buy' ? 'buy' : 'sell';
    if (kind === 'buy' && !s.modes.buy) throw fail('ร้านนี้ยังไม่ได้เปิดโหมดรับซื้อ', 409);
    const reqId = typeof b.reqId === 'string' && /^[a-f0-9]{8,64}$/.test(b.reqId) ? who.id + ':' + b.reqId : null;
    if (reqId && recentSales.has(reqId)) return send(res, 200, recentSales.get(reqId).result);
    if (!Array.isArray(b.items) || !b.items.length) throw fail('ยังไม่ได้เลือกสินค้า');
    if (b.items.length > 100) throw fail('ขายครั้งละไม่เกิน 100 แถว');
    const wholesale = kind === 'sell' && b.level === 'wholesale';
    const lines = [];
    for (const it of b.items) {
      const m = store.menuItem(it && +it.id);
      if (!m || m.hidden) throw fail('มีสินค้าที่ไม่มีขายแล้ว เอาออกจากตะกร้าแล้วลองใหม่');
      if (kind === 'sell' && s.soldOut.includes(m.id)) throw fail(m.name + ' หมดแล้ว');
      const n = +(it && it.qty);
      let qty;
      if (m.dec) {          // ขายตามน้ำหนัก/ความยาว: ทศนิยม 3 ตำแหน่ง
        qty = Math.round(n * 1000) / 1000;
        if (!(isFinite(n) && qty > 0 && qty <= 100000)) throw fail('จำนวนของ ' + m.name + ' ไม่ถูกต้อง');
      } else {
        if (!(Number.isInteger(n) && n >= 1 && n <= 10000)) throw fail('จำนวนของ ' + m.name + ' ต้องเป็นจำนวนเต็ม 1 ถึง 10,000');
        qty = n;
      }
      const price = wholesale && m.price2 > 0 ? m.price2 : m.price;
      const note = (Array.isArray(it.note) ? it.note : []).filter(x => D.menu.notes.includes(x)).slice(0, 10);
      lines.push({ m, qty, price, note });
    }
    // ใบเสร็จรวมแถวสินค้าเดียวกันราคาเดียวกัน แล้วปัดแต่ละแถวเป็นสตางค์ก่อนรวม (หน้าพนักงานคิดแบบเดียวกันใน posTotals())
    const merged = new Map();
    lines.forEach(l => {
      const k = l.m.id + '|' + l.price, e = merged.get(k);
      if (e) e.qty = Math.round((e.qty + l.qty) * 1000) / 1000;
      else merged.set(k, Object.assign({ name: l.m.name, qty: l.qty, price: l.price }, l.m.unit ? { unit: l.m.unit } : {}));
    });
    const items = Array.from(merged.values());
    const sub = r2(items.reduce((a, i) => a + r2(i.price * i.qty), 0));
    if (sub > 10000000) throw fail('ยอดต่อบิลเกิน 10 ล้านบาท แยกเป็นหลายบิล');
    if (typeof b.expectedSub !== 'number') throw fail('ไม่มียอดที่ต้องตรวจสอบ');
    if (b.expectedSub !== sub) {
      audit(req, 'sale.rejected', { kind, expectedSub: b.expectedSub, actualSub: sub });
      throw codeFail('ราคาสินค้าเพิ่งเปลี่ยน (หรือมีการแก้ราคาจากอีกเครื่อง) ตรวจยอดใหม่แล้วกดอีกครั้ง', 409, 'price_changed');
    }
    // รับซื้อ: ร้านจ่ายเงินตามน้ำหนัก ไม่มีค่าบริการ/VAT
    const x = kind === 'buy' ? { svc: 0, vat: 0, total: sub } : store.totals(sub, !!b.svc, !!b.vat);
    const method = b.method === 'transfer' ? 'transfer' : 'cash';
    let received = null, change = null;
    if (kind === 'sell' && method === 'cash' && b.received !== undefined && b.received !== null) {
      if (typeof b.received !== 'number' || !isFinite(b.received) || b.received > 10000000) throw fail('จำนวนเงินที่รับมาไม่ถูกต้อง');
      if (b.received < x.total) throw fail('เงินที่รับมาน้อยกว่ายอดที่ต้องชำระ');
      received = r2(b.received);
      change = r2(received - x.total);
    }
    const memo = str(b.memo, 80);
    let q = null; const made = [];
    if (kind === 'sell' && s.modes.kitchen && b.kitchen === true) {
      q = store.nextQueue();
      const groups = {};
      lines.forEach(l => {
        const stn = D.menu.stations[l.m.station] ? l.m.station : Object.keys(D.menu.stations)[0];
        (groups[stn] = groups[stn] || []).push({ id: l.m.id, name: l.m.name, price: l.price, qty: l.qty, note: l.note });
      });
      Object.keys(groups).forEach(stn => {
        const k = { id: D.nextTicket++, table: 0, q, station: stn, createdAt: Date.now(), status: 'new', memo, by: 'staff', items: groups[stn] };
        D.tickets.push(k); made.push(k.id);
      });
    }
    const sale = Object.assign({ no: D.nextBill++, at: Date.now(), table: 0, sub, svc: x.svc, vat: x.vat, total: x.total, method, items },
      kind === 'buy' ? { kind: 'buy' } : {}, wholesale ? { level: 'wholesale' } : {}, memo ? { memo } : {}, q ? { q } : {});
    // สต็อก: ขาย = ออก รับซื้อ = เข้า (เฉพาะสินค้าที่นับสต็อก) ขายเกินยอดในระบบได้ (ติดลบ) เพราะของอยู่ในมือแคชเชียร์แล้ว
    const byItem = new Map();
    lines.forEach(l => { if (store.tracked(l.m)) byItem.set(l.m, Math.round(((byItem.get(l.m) || 0) + l.qty) * 1000) / 1000); });
    byItem.forEach((qty, m) => store.stockMove(m, kind === 'buy' ? qty : -qty, kind === 'buy' ? 'buy' : 'sale', billNo(sale.no, sale.at)));
    D.sales.push(sale);
    store.archiveSale(sale);
    store.trimSales();
    st.changeSeq++;
    store.writeNow(); broadcast();      // ยอดเงินบันทึกทันที (กฎข้อ 18)
    audit(req, 'sale.created', { no: sale.no, kind, method, level: wholesale ? 'wholesale' : 'retail', sub, svc: x.svc, vat: x.vat, total: x.total, received, change,
      items: items.map(i => pick(i, ['name', 'qty', 'price'])), queue: q, tickets: made, memo });
    const result = { ok: true, sale, received, change, queue: q };
    if (reqId) recentSales.set(reqId, { at: Date.now(), result });
    send(res, 200, result);
  },

  /* ---- ประเภทธุรกิจ (เจ้าของ) ---- */
  'GET /api/biz': async (req, res) => {
    requireStaff(req);
    send(res, 200, { current: st.D.settings.biz, modes: st.D.settings.modes, list: biz.list() });
  },
  // แทนที่เมนู/สินค้าทั้งหมดด้วยชุดตัวอย่างของประเภทธุรกิจ (หน้าจอยืนยันก่อนเสมอ) ยอดขายและออเดอร์ที่เปิดอยู่ไม่กระทบ (บิลเก็บชื่อและราคาตอนสั่ง)
  // สำรองข้อมูลก่อนเสมอ (before-sample) กดผิดก็กู้เมนูเดิมกลับได้ สำรองไม่สำเร็จ = ไม่แทนที่
  'POST /api/biz/sample': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    if (!biz.KEYS.includes(b.biz)) throw fail('เลือกประเภทธุรกิจ');
    const who = actor(req), bk = await backup.writeBackup('before-sample');
    notRestoring();                      // อ่าน st.D ใหม่หลัง await (กฎข้อ 19)
    const D = st.D, old = D.menu, next = biz.sampleMenu(b.biz, old);   // version เพิ่มแล้ว หน้าลูกค้าโหลดใหม่เอง
    D.menu = next;
    D.settings.soldOut = [];
    old.items.forEach(m => store.removeImageFile(m.image));
    audit(req, 'menu.sample_loaded', { biz: b.biz, safetyBackup: bk.name, before: { items: old.items.length, categories: old.categories.length }, after: { items: next.items.length, categories: next.categories.length } }, who);
    changed();
    send(res, 200, { ok: true, items: next.items.length, safetyBackup: bk.name });
  },

  /* ---- เอกสาร ---- */
  // รายการเอกสาร: ที่อยู่ใน data.json (ค้างอยู่ + จบไม่เกิน 8 วัน) หรือทั้งเดือนจาก journal/ (?month=YYYY-MM) กรองด้วย type (ประเภท/กลุ่ม) status (open = ยังค้าง) q
  'GET /api/docs': async (req, res, url) => {
    requireStaff(req);
    const p = url.searchParams, month = p.get('month') || '', type = p.get('type') || '', status = p.get('status') || '', q = String(p.get('q') || '').trim().toLowerCase();
    let list = st.D.docs.slice();
    if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) throw fail('รูปแบบเดือนต้องเป็น YYYY-MM');
      const latest = new Map();
      (await store.readJournal('docs-' + month + '.jsonl')).forEach(r => { if (r && typeof r.no === 'string' && (!latest.has(r.no) || r.rev > latest.get(r.no).rev)) latest.set(r.no, r); });
      st.D.docs.forEach(d => { if (U.monthKey(d.date) === month && (!latest.has(d.no) || d.rev >= latest.get(d.no).rev)) latest.set(d.no, d); });   // อ่านใหม่หลัง await
      list = Array.from(latest.values()).filter(d => store.cleanDoc(d));
    }
    const types = DOC_GROUP[type] || (DOC_NAME[type] ? [type] : null);
    if (types) list = list.filter(d => types.includes(d.type));
    if (status === 'open') list = list.filter(d => !store.DOC_FINAL.has(d.status));
    if (q) list = list.filter(d => d.no.toLowerCase().includes(q) || d.party.name.toLowerCase().includes(q) || d.lines.some(l => l.name.toLowerCase().includes(q)));
    list.sort((a, b) => b.date - a.date || b.createdAt - a.createdAt);
    send(res, 200, { docs: list.slice(0, 500), total: list.length, stats: docStats() });
  },

  'GET /api/doc': async (req, res, url) => {
    requireStaff(req);
    const d = await findDocAnywhere(url.searchParams.get('no'));
    if (!d) throw fail('ไม่พบเอกสารนี้', 404);
    // บิลที่รับชำระใบแจ้งหนี้นี้ (ใบเสร็จ) ถ้ายังอยู่ใน data.json
    const sale = d.receipt ? st.D.sales.find(s => s.no === d.receipt) || null : null;
    send(res, 200, { doc: d, sale });
  },

  // สร้าง (ไม่ส่ง no) หรือแก้ใบเสนอราคา/ใบสั่งซื้อที่ยังเปิดอยู่ (ส่ง no + rev ที่เปิดแก้) ใบแจ้งหนี้ที่ออกแล้วแก้ไม่ได้ (ตัดสต็อกไปแล้ว) ให้ยกเลิกแล้วออกใหม่
  'POST /api/doc': async (req, res) => {
    const who = requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D;
    if (!D.settings.modes.docs) throw fail('ร้านนี้ยังไม่ได้เปิดใช้เอกสาร เปิดได้ที่ ตั้งค่า > ประเภทธุรกิจ', 409);
    const d = b.no !== undefined ? findDoc(String(b.no)) : null;
    if (b.no !== undefined && !d) throw fail('ไม่พบเอกสารนี้ หรือเอกสารจบไปแล้ว', 404);
    const type = d ? d.type : b.type;
    if (!['QT', 'INV', 'PO'].includes(type)) throw fail('ประเภทเอกสารไม่ถูกต้อง');
    if (type === 'PO' && who.role !== 'owner') throw fail('ใบสั่งซื้อทำได้เฉพาะเจ้าของร้าน', 403);
    if (d) {
      if (d.type === 'INV') throw fail('ใบแจ้งหนี้ที่ออกแล้วแก้ไม่ได้ ให้ยกเลิกแล้วออกใบใหม่', 409);
      if (d.status !== 'open') throw fail('เอกสารนี้จบแล้ว แก้ไม่ได้', 409);
      // เครื่องอื่นแก้ไปก่อน: ห้ามบันทึกทับเงียบๆ (แบบ was ของเมนู กฎข้อ 37)
      if (b.rev !== d.rev) throw fail('เอกสารนี้ถูกแก้จากอีกเครื่องระหว่างที่คุณแก้อยู่ ปิดแล้วเปิดใหม่เพื่อดูฉบับล่าสุด', 409);
    }
    const f = docInput(b, type);
    if (b.saveContact === true) saveContactFrom(req, f.party, type === 'PO' ? 'supplier' : 'customer');
    if (d) {
      const keys = ['party', 'lines', 'discount', 'vat', 'note', 'date', 'due', 'total'];
      const before = pick(d, keys);
      Object.assign(d, f);
      store.docChanged(d);
      const ch = diff(before, pick(d, keys));
      audit(req, 'doc.updated', Object.assign({ no: d.no, docType: d.type }, ch || {}));
      changed();
      return send(res, 200, { ok: true, doc: d });
    }
    const nd = newDoc(type, who, f);
    if (type === 'INV') invStockOut(nd);
    store.docChanged(nd);
    audit(req, 'doc.created', Object.assign(docBrief(nd), { docType: type }));
    changed();
    send(res, 200, { ok: true, doc: nd });
  },

  // ใบเสนอราคาที่ลูกค้าตกลง → ออกใบแจ้งหนี้ (ส่งของ ตัดสต็อก) ใบเสนอราคาเป็น "ตกลงแล้ว" อ้างถึงกัน
  'POST /api/doc/convert': async (req, res) => {
    const who = requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, q = findDoc(String(b.no || ''));
    if (!D.settings.modes.docs) throw fail('ร้านนี้ยังไม่ได้เปิดใช้เอกสาร', 409);
    if (!q || q.type !== 'QT') throw fail('ไม่พบใบเสนอราคานี้', 404);
    if (q.status !== 'open') throw fail('ใบเสนอราคานี้จบแล้ว', 409);
    if (b.rev !== undefined && b.rev !== q.rev) throw fail('ใบเสนอราคานี้ถูกแก้จากอีกเครื่อง เปิดใหม่เพื่อดูฉบับล่าสุดก่อน', 409);
    // รายการที่อ้างถึงสินค้าที่ถูกลบไปแล้ว: ออกเป็นรายการพิมพ์เอง (ไม่ตัดสต็อก)
    const lines = q.lines.map(l => { const o = { name: l.name, qty: l.qty, unit: l.unit, price: l.price }; if (l.id && store.menuItem(l.id)) o.id = l.id; return o; });
    const date = U.dayStart(Date.now());
    const inv = newDoc('INV', who, Object.assign({ party: Object.assign({}, q.party), lines, discount: q.discount, vat: q.vat, note: q.note, date, due: date + D.settings.creditDays * C.DAY },
      store.docTotals(lines, q.discount, q.vat)), { ref: q.no });
    invStockOut(inv);
    store.docChanged(inv);
    q.status = 'accepted'; q.ref = inv.no;
    store.docChanged(q);
    audit(req, 'doc.converted', { no: q.no, to: inv.no, total: inv.total });
    changed();
    send(res, 200, { ok: true, doc: inv });
  },

  // รับชำระใบแจ้งหนี้เต็มจำนวน → บิลขาย (ใบเสร็จ) ลง sales/ เข้าสรุปยอดและ CSV ไม่ตัดสต็อกซ้ำ (ตัดไปแล้วตอนออกใบแจ้งหนี้)
  'POST /api/doc/pay': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, d = findDoc(String(b.no || ''));
    if (!d || d.type !== 'INV') throw fail('ไม่พบใบแจ้งหนี้นี้', 404);
    if (d.status !== 'unpaid') throw fail('ใบแจ้งหนี้นี้' + (d.status === 'paid' ? 'รับชำระไปแล้ว' : 'ถูกยกเลิกแล้ว'), 409);
    if (typeof b.expectedTotal !== 'number') throw fail('ไม่มียอดที่ต้องตรวจสอบ');
    if (b.expectedTotal !== d.total) throw fail('ยอดของใบแจ้งหนี้นี้ไม่ตรงกับที่แสดง เปิดใหม่เพื่อดูยอดล่าสุด', 409);
    const method = b.method === 'transfer' ? 'transfer' : 'cash', now = Date.now();
    const sale = Object.assign({ no: D.nextBill++, at: now, table: 0, sub: d.sub, svc: 0, vat: d.vatAmt, total: d.total, method,
      items: d.lines.map(l => Object.assign({ name: l.name, qty: l.qty, price: l.price }, l.unit ? { unit: l.unit } : {})), doc: d.no, memo: (d.no + ' ' + d.party.name).slice(0, 80) },
      d.disc ? { disc: d.disc } : {});
    D.sales.push(sale);
    store.archiveSale(sale);
    store.trimSales();
    d.status = 'paid'; d.paidAt = now; d.method = method; d.receipt = sale.no;
    store.docChanged(d);
    st.changeSeq++;
    store.writeNow(); broadcast();
    audit(req, 'doc.paid', { no: d.no, bill: sale.no, method, total: d.total, party: d.party.name });
    send(res, 200, { ok: true, doc: d, sale });
  },

  // รับสินค้าตามใบสั่งซื้อ (จำนวนที่ได้จริง ต้นทุนจริง) → ใบรับสินค้า (GR) สต็อกเพิ่ม ต้นทุนล่าสุดเปลี่ยน สินค้าที่ยังไม่นับสต็อกเริ่มนับจากจำนวนที่รับ
  'POST /api/doc/receive': async (req, res) => {
    const who = requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, po = findDoc(String(b.no || ''));
    if (!po || po.type !== 'PO') throw fail('ไม่พบใบสั่งซื้อนี้', 404);
    if (po.status !== 'open') throw fail('ใบสั่งซื้อนี้จบแล้ว', 409);
    if (b.rev !== po.rev) throw fail('ใบสั่งซื้อนี้ถูกแก้จากอีกเครื่อง เปิดใหม่เพื่อดูฉบับล่าสุด', 409);
    if (!Array.isArray(b.lines) || b.lines.length !== po.lines.length) throw fail('ระบุจำนวนที่รับของทุกรายการ');
    const got = b.lines.map((l, i) => {
      const n = Number(l && l.qty), q = Math.round(n * 1000) / 1000;
      if (!isFinite(n) || q < 0 || q > 1000000) throw fail('รายการที่ ' + (i + 1) + ': จำนวนที่รับไม่ถูกต้อง');
      const pr = l.price === undefined || l.price === '' || l.price === null ? po.lines[i].price : Number(l.price);
      if (!isFinite(pr) || pr < 0 || pr > 10000000) throw fail('รายการที่ ' + (i + 1) + ': ราคาไม่ถูกต้อง');
      return { qty: q, price: Math.round(pr * 100) / 100 };
    });
    if (!got.some(g => g.qty > 0)) throw fail('ยังไม่ได้รับของสักรายการ');
    const lines = po.lines.map((l, i) => Object.assign({ name: l.name, qty: got[i].qty, unit: l.unit, price: got[i].price }, l.id ? { id: l.id } : {})).filter(l => l.qty > 0);
    const gr = newDoc('GR', who, Object.assign({ party: Object.assign({}, po.party), lines, discount: 0, vat: po.vat, note: str(b.note, 300), date: U.dayStart(Date.now()), due: null },
      store.docTotals(lines, 0, po.vat)), { ref: po.no });
    lines.forEach(l => {
      const m = l.id && store.menuItem(l.id);
      if (!m) return;
      if (l.price > 0) m.cost = l.price;
      if (!D.settings.modes.stock) return;
      if (!m.track) { m.track = true; m.stock = 0; }
      store.stockMove(m, l.qty, 'gr', gr.no);
    });
    store.docChanged(gr);
    po.lines.forEach((l, i) => { l.got = got[i].qty; });
    po.status = 'received'; po.receivedAt = Date.now(); po.ref = gr.no;
    store.docChanged(po);
    audit(req, 'doc.received', { no: po.no, gr: gr.no, lines: lines.map(l => pick(l, ['name', 'qty', 'price'])), total: gr.total });
    changed();
    send(res, 200, { ok: true, doc: gr, po });
  },

  // ยกเลิกเอกสารที่ยังไม่จบ (เจ้าของ ต้องมีเหตุผล) ใบแจ้งหนี้ยกเลิกแล้วคืนสต็อกที่ตัดไป ใบแจ้งหนี้ที่รับชำระแล้วยกเลิกไม่ได้ (ยังไม่มีคืนเงิน)
  'POST /api/doc/cancel': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const d = findDoc(String(b.no || ''));
    if (!d) throw fail('ไม่พบเอกสารนี้ หรือเอกสารจบไปแล้ว', 404);
    const reason = str(b.reason, 80);
    if (reason.length < 2) throw fail('ต้องระบุเหตุผลที่ยกเลิก');
    if (store.DOC_FINAL.has(d.status)) throw fail(d.status === 'paid' ? 'ใบแจ้งหนี้ที่รับชำระแล้วยกเลิกไม่ได้ (ระบบยังไม่มีคืนเงิน)' : 'เอกสารนี้จบแล้ว ยกเลิกไม่ได้', 409);
    if (d.type === 'INV') d.lines.forEach(l => { const m = l.got && store.menuItem(l.id); if (m) store.stockMove(m, l.got, 'inv-cancel', d.no); });
    d.status = 'cancelled'; d.cancelReason = reason;
    store.docChanged(d);
    audit(req, 'doc.cancelled', { no: d.no, docType: d.type, total: d.total, reason });
    changed();
    send(res, 200, { ok: true, doc: d });
  },

  /* ---- ผู้ติดต่อ (ลูกค้า/ผู้ขาย) ---- */
  'GET /api/contacts': async (req, res) => {
    requireStaff(req);
    send(res, 200, { list: st.D.contacts });
  },
  'POST /api/contact': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, name = str(b.name, 100);
    if (!name) throw fail('ใส่ชื่อ');
    const tax = String(b.taxId == null ? '' : b.taxId).replace(/\D/g, '');
    if (tax && tax.length !== 13) throw fail('เลขประจำตัวผู้เสียภาษีต้องมี 13 หลัก');
    const f = { name, kind: ['customer', 'supplier', 'both'].includes(b.kind) ? b.kind : 'customer', taxId: tax, branch: str(b.branch, 30), address: str(b.address, 200), phone: str(b.phone, 40), email: str(b.email, 80), note: str(b.note, 120) };
    let c;
    if (b.id) {
      c = D.contacts.find(x => x.id === b.id);
      if (!c) throw fail('ไม่พบผู้ติดต่อนี้', 404);
      const d = diff(Object.assign({}, c), f);
      Object.assign(c, f);
      if (d) audit(req, 'contact.updated', Object.assign({ contact: c.id, contactName: c.name }, d));
    } else {
      if (D.contacts.length >= 2000) throw fail('ผู้ติดต่อเกิน 2,000 รายการ');
      c = Object.assign({ id: 'c' + D.nextContactId++ }, f);
      D.contacts.push(c);
      audit(req, 'contact.created', { contact: c.id, contactName: c.name, kindOf: c.kind });
    }
    changed();
    send(res, 200, { ok: true, contact: c });
  },
  'POST /api/contact/delete': async (req, res) => {
    requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D, c = D.contacts.find(x => x.id === b.id);
    if (!c) throw fail('ไม่พบผู้ติดต่อนี้', 404);
    D.contacts = D.contacts.filter(x => x !== c);     // เอกสารที่ออกไปแล้วมีชื่อที่อยู่ของตัวเอง ไม่กระทบ
    audit(req, 'contact.deleted', { contact: c.id, contactName: c.name });
    changed();
    send(res, 200, { ok: true });
  },

  /* ---- สต็อก ---- */
  // บัตรสต็อก: ความเคลื่อนไหวของสินค้าหนึ่งรายการในเดือนนั้น (journal/ + ที่ยังเขียนไม่ทันใน data.json)
  'GET /api/stock': async (req, res, url) => {
    requireStaff(req);
    const id = +url.searchParams.get('id'), month = url.searchParams.get('month') || U.monthKey(Date.now());
    if (!/^\d{4}-\d{2}$/.test(month)) throw fail('รูปแบบเดือนต้องเป็น YYYY-MM');
    if (!store.menuItem(id)) throw fail('ไม่พบสินค้านี้', 404);
    const seen = new Set(), moves = [];
    const add = v => { if (v && v.item === id && typeof v.id === 'string' && !seen.has(v.id)) { seen.add(v.id); moves.push(v); } };
    (await store.readJournal('stock-' + month + '.jsonl')).forEach(add);
    st.D.moves.forEach(v => { if (U.monthKey(v.at) === month) add(v); });
    moves.sort((a, b) => a.at - b.at);
    const m = store.menuItem(id);
    send(res, 200, { item: m ? pick(m, ['id', 'name', 'unit', 'sku', 'stock', 'cost', 'min', 'track']) : null, month, moves });
  },

  /* รับเข้า (GR) / เบิกออก-ตัดของเสีย (OUT) / ตรวจนับ (CNT) หลายรายการในเอกสารเดียว (เจ้าของ)
     ตรวจนับต้องส่ง expect = ยอดที่เห็นตอนเปิดแผ่นนับ ถ้าระหว่างนั้นมีการขาย ยอดเปลี่ยน ได้ 409 (ไม่ทับยอดเงียบๆ แบบ was กฎข้อ 37) */
  'POST /api/stock/adjust': async (req, res) => {
    const who = requireStaff(req);
    const b = await readBody(req, C.BODY_LIMIT);
    const D = st.D;
    if (!D.settings.modes.stock) throw fail('ร้านนี้ยังไม่ได้เปิดใช้สต็อก เปิดได้ที่ ตั้งค่า > ประเภทธุรกิจ', 409);
    const type = { in: 'GR', out: 'OUT', count: 'CNT' }[b.mode];
    if (!type) throw fail('เลือกประเภท: รับเข้า เบิกออก หรือตรวจนับ');
    const reason = str(b.reason, 120);
    if (type === 'OUT' && reason.length < 2) throw fail('ระบุเหตุผลที่เบิกออก เช่น ของเสีย ใช้ในร้าน');
    if (!Array.isArray(b.lines) || !b.lines.length) throw fail('ยังไม่มีรายการ');
    if (b.lines.length > 500) throw fail('ครั้งละไม่เกิน 500 รายการ');
    const ids = new Set();
    const rows = b.lines.map((l, i) => {
      const m = store.menuItem(l && +l.id), w = 'รายการที่ ' + (i + 1) + ': ';
      if (!m) throw fail(w + 'ไม่พบสินค้านี้');
      if (ids.has(m.id)) throw fail(w + m.name + ' ซ้ำ');
      ids.add(m.id);
      const n = Number(l.qty), q = Math.round(n * 1000) / 1000;
      if (l.qty === '' || l.qty === null || !isFinite(n) || q < 0 || q > 1000000 || (type !== 'CNT' && !(q > 0))) throw fail(w + m.name + ' จำนวนไม่ถูกต้อง');
      if (type === 'CNT' && m.track && l.expect !== m.stock) throw fail(m.name + ' ยอดคงเหลือเปลี่ยนระหว่างนับ (มีการขายหรือรับของ) ตอนนี้เหลือ ' + m.stock + ' นับใหม่เฉพาะรายการนี้', 409);
      let price = m.cost;
      if (type === 'GR' && l.price !== undefined && l.price !== '' && l.price !== null) {
        price = Number(l.price);
        if (!isFinite(price) || price < 0 || price > 10000000) throw fail(w + m.name + ' ต้นทุนไม่ถูกต้อง');
        price = Math.round(price * 100) / 100;
      }
      return { m, qty: q, price };
    });
    const party = type === 'GR' && b.party && typeof b.party === 'object' && str(b.party.name, 100) ? docParty(b.party, 'PO') : { name: '', address: '', taxId: '', branch: '', phone: '' };
    const lines = rows.map(r => {
      const before = r.m.track ? r.m.stock : 0;
      const after = type === 'CNT' ? r.qty : Math.round((before + (type === 'GR' ? r.qty : -r.qty)) * 1000) / 1000;
      return Object.assign({ id: r.m.id, name: r.m.name, qty: type === 'CNT' ? Math.round((after - before) * 1000) / 1000 : r.qty, unit: r.m.unit || '', price: r.price, before, after });
    });
    // มูลค่าในเอกสาร = จำนวนที่เปลี่ยน × ต้นทุน (ตรวจนับ: ส่วนต่าง ติดลบ = ของหาย)
    const val = lines.map(l => ({ qty: Math.abs(l.qty), price: l.price }));
    const doc = newDoc(type, who, Object.assign({ party, lines, discount: 0, vat: false, note: reason, date: U.dayStart(Date.now()), due: null }, store.docTotals(val, 0, false)));
    rows.forEach((r, i) => {
      const m = r.m, l = lines[i];
      if (type === 'GR' && r.price > 0) m.cost = r.price;
      if (!m.track) { m.track = true; m.stock = 0; }
      store.stockMove(m, Math.round((l.after - m.stock) * 1000) / 1000, { GR: 'gr', OUT: 'out', CNT: 'count' }[type], doc.no, reason || undefined);
    });
    store.docChanged(doc);
    audit(req, 'stock.adjusted', { no: doc.no, mode: b.mode, reason, lines: lines.map(l => pick(l, ['name', 'qty', 'before', 'after'])) });
    changed();
    send(res, 200, { ok: true, doc });
  },

  // รายงานสินค้าคงเหลือ (สินค้าที่นับสต็อก) เป็น CSV ให้บัญชี
  'GET /api/stock.csv': async (req, res) => {
    requireStaff(req);
    const D = st.D, q = csvCell, cat = id => (D.menu.categories.find(c => c.id === id) || {}).name || '';
    const rows = [['รหัสสินค้า', 'ชื่อสินค้า', 'หมวด', 'หน่วย', 'คงเหลือ', 'ต้นทุนต่อหน่วย', 'มูลค่าคงเหลือ', 'จุดสั่งซื้อ', 'สถานะ'].map(q).join(',')];
    D.menu.items.filter(m => m.track).forEach(m => {
      const st2 = m.stock <= 0 ? 'หมด' : (m.min > 0 && m.stock <= m.min ? 'ใกล้หมด' : '');
      rows.push([m.sku, m.name, cat(m.cat), m.unit, m.stock, m.cost, Math.round(Math.max(0, m.stock) * m.cost * 100) / 100, m.min, st2].map(q).join(','));
    });
    audit(req, 'report.stock_exported', { rows: rows.length - 1 });
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="stock-' + U.ymd(Date.now()) + '.csv"' });
    res.end('﻿' + rows.join('\r\n'));
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
    if (typeof b.vat === 'boolean') s.vat = b.vat;
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
    // ประเภทธุรกิจ (คำในหน้าจอ) และโหมดการขาย ส่งเฉพาะบางโหมดได้
    if (b.biz !== undefined) {
      if (b.biz !== '' && !biz.KEYS.includes(b.biz)) throw fail('ประเภทธุรกิจไม่ถูกต้อง');
      s.biz = b.biz;
    }
    if (b.modes !== undefined) {
      const v = b.modes, K = ['table', 'kitchen', 'counter', 'buy', 'stock', 'docs'];
      if (!v || typeof v !== 'object' || Array.isArray(v) || K.some(k => v[k] !== undefined && typeof v[k] !== 'boolean')) throw fail('โหมดการขายไม่ถูกต้อง');
      const m = Object.assign({}, s.modes);
      K.forEach(k => { if (typeof v[k] === 'boolean') m[k] = v[k]; });
      if (!m.table && !m.counter && !m.docs) throw fail('ต้องเปิดอย่างน้อยหนึ่งทาง: ขายที่โต๊ะ ขายหน้าร้าน หรือเอกสาร (ใบแจ้งหนี้)');
      if (m.buy && !m.counter) throw fail('รับซื้อของทำที่หน้าขายหน้าร้าน ต้องเปิดขายหน้าร้านด้วย');
      // ปิดโหมดที่ยังมีงานค้าง = งานนั้นหายจากหน้าจอ (บิลโต๊ะที่ยังไม่จ่าย / คิวที่ยังไม่ได้ส่งของ)
      if (s.modes.table && !m.table) {
        const busy = store.openTableNumbers().sort((a, c) => a - c);
        if (busy.length) throw fail('โต๊ะ ' + busy.join(', ') + ' ยังเปิดอยู่ ปิดบิลก่อนเลิกใช้โต๊ะ');
      }
      if (s.modes.kitchen && !m.kitchen) {
        const qs = st.D.tickets.filter(k => k.table === 0).map(k => k.q).filter((q, i, a) => a.indexOf(q) === i);
        if (qs.length) throw fail('คิว ' + qs.join(', ') + ' ยังค้างอยู่ในจอ กด "ลูกค้ารับแล้ว" ก่อนเลิกใช้จอ');
      }
      if (s.modes.docs && !m.docs) {
        const open = st.D.docs.filter(d => (d.type === 'INV' && d.status === 'unpaid') || (d.type === 'PO' && d.status === 'open')).map(d => d.no);
        if (open.length) throw fail('ยังมีใบแจ้งหนี้ค้างชำระหรือใบสั่งซื้อรอรับของ (' + open.slice(0, 5).join(', ') + (open.length > 5 ? ' …' : '') + ') ปิดหรือยกเลิกก่อนเลิกใช้เอกสาร');
      }
      s.modes = m;
    }
    // เอกสาร: เครดิตกี่วัน ยืนราคากี่วัน หมายเหตุท้ายเอกสาร สาขา
    if (b.creditDays !== undefined) {
      const n = Math.floor(+b.creditDays);
      if (!(n >= 0 && n <= 365)) throw fail('เครดิตต้องเป็น 0 ถึง 365 วัน');
      s.creditDays = n;
    }
    if (b.quoteDays !== undefined) {
      const n = Math.floor(+b.quoteDays);
      if (!(n >= 1 && n <= 365)) throw fail('ยืนราคาต้องเป็น 1 ถึง 365 วัน');
      s.quoteDays = n;
    }
    if (typeof b.docNote === 'string') s.docNote = str(b.docNote, 300);
    if (typeof b.branch === 'string') s.branch = str(b.branch, 30);
    st.D.settings = s;
    // สิ่งที่หน้าลูกค้าแสดง เปลี่ยนแล้ว version เพิ่ม หน้าลูกค้าที่เปิดอยู่โหลดเมนู/สีใหม่เอง (เดิมเฉพาะสี ชื่อร้านใหม่ต้องรีเฟรชเอง)
    if (['shop', 'address', 'phone', 'accent', 'tagline', 'look', 'social', 'shareUrl', 'hours', 'biz', 'modes'].some(k => JSON.stringify(was[k]) !== JSON.stringify(s[k]))) st.D.menu.version++;
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
    // ขายหน้าร้าน: รหัสสินค้า/บาร์โค้ด หน่วย ขายเป็นทศนิยม ราคาส่ง (หน้าจอรุ่นเก่าไม่ส่งมา = คงค่าเดิมไว้ ไม่ล้างทิ้ง)
    const cur = b.id ? store.menuItem(+b.id) : null;
    const sku = b.sku !== undefined ? str(b.sku, 32) : (cur ? cur.sku : '');
    if (sku && !/^[0-9A-Za-z._\-\/]+$/.test(sku)) throw fail('รหัสสินค้า/บาร์โค้ดใช้ได้เฉพาะตัวเลข ตัวอักษรอังกฤษ และ - _ . /');
    const dup = sku && D.menu.items.find(x => x !== cur && x.sku && x.sku.toLowerCase() === sku.toLowerCase());
    if (dup) throw fail('รหัสสินค้า ' + sku + ' ใช้กับ "' + dup.name + '" อยู่แล้ว');
    let price2 = cur ? cur.price2 : 0;
    if (b.price2 !== undefined) {
      price2 = b.price2 === null || b.price2 === '' ? 0 : Number(b.price2);
      if (!isFinite(price2) || price2 < 0 || price2 > 100000) throw fail('ราคาส่งต้องเป็นตัวเลข 0 ถึง 100,000 (เว้นว่าง = ไม่มีราคาส่ง)');
      price2 = Math.round(price2 * 100) / 100;
    }
    Object.assign(fields, { sku, unit: b.unit !== undefined ? str(b.unit, 12) : (cur ? cur.unit : ''), dec: b.dec !== undefined ? b.dec === true : (cur ? cur.dec : false), price2 });
    // สต็อก: นับไหม ต้นทุน จุดสั่งซื้อ (ยอดคงเหลือแก้ที่นี่ไม่ได้ ต้องผ่านรับเข้า/เบิกออก/ตรวจนับ ให้มีเอกสารและประวัติ)
    const numOr = (k, def, max) => {
      if (b[k] === undefined) return cur ? cur[k] : def;
      if (b[k] === '' || b[k] === null) return 0;
      const n = Number(b[k]);
      if (!isFinite(n) || n < 0 || n > max) throw fail({ cost: 'ต้นทุน', min: 'จุดสั่งซื้อ' }[k] + 'ต้องเป็นตัวเลข 0 ถึง ' + max.toLocaleString('en-US'));
      return Math.round(n * 1000) / 1000;
    };
    Object.assign(fields, { track: b.track !== undefined ? b.track === true : (cur ? cur.track : false), cost: numOr('cost', 0, 10000000), min: numOr('min', 0, 1000000) });
    let m;
    if (b.id) {
      m = cur;
      if (!m) throw fail('ไม่พบเมนูนี้ อาจถูกลบไปแล้ว', 404);
      // ค่าตอนเปิดหน้าแก้ (was) ต้องตรงกับตอนนี้ ไม่อย่างนั้นอีกเครื่องแก้ไปก่อน ถ้าบันทึกทับ ราคาใหม่จะถูกย้อนเงียบๆ
      if (b.was && typeof b.was === 'object' && ['name', 'price', 'cat', 'station', 'desc', 'hidden', 'rec', 'sku', 'unit', 'dec', 'price2', 'track', 'cost', 'min'].some(k => b.was[k] !== undefined && b.was[k] !== m[k])) {
        throw fail('เมนูนี้ถูกแก้จากอีกเครื่องระหว่างที่คุณแก้อยู่ กดยกเลิกแล้วเปิดแก้ใหม่เพื่อดูข้อมูลล่าสุด', 409);
      }
      const d = diff(Object.assign({}, m), fields);
      Object.assign(m, fields);
      if (d) audit(req, 'menu.item.updated', Object.assign({ item: m.id, itemName: m.name }, d));
    } else {
      m = Object.assign({ id: D.menu.nextId++, image: '', stock: 0 }, fields);
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
    // รับซื้อ (ร้านจ่ายเงินให้ลูกค้า) แยกจากยอดขายเสมอ ไม่บวกรวมกัน
    const all = D.sales.filter(s => s.at >= today0), today = all.filter(s => s.kind !== 'buy');
    const bought = all.filter(s => s.kind === 'buy');
    let total = 0, cash = 0, transfer = 0; const qty = {};
    today.forEach(s => {
      total += s.total;
      if (s.method === 'transfer') transfer += s.total; else cash += s.total;
      s.items.forEach(i => { qty[i.name] = Math.round(((qty[i.name] || 0) + i.qty) * 1000) / 1000; });
    });
    const buy = { count: bought.length, total: 0, cash: 0, transfer: 0 };
    bought.forEach(s => { buy.total += s.total; buy[s.method === 'transfer' ? 'transfer' : 'cash'] += s.total; });
    ['total', 'cash', 'transfer'].forEach(k => { buy[k] = r2(buy[k]); });
    const top = Object.keys(qty).map(n => ({ name: n, qty: qty[n] })).sort((a, b) => b.qty - a.qty).slice(0, 8);
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const start = U.dayStart(today0 - i * DAY + DAY / 2), end = U.dayStart(start + DAY + DAY / 2);
      let sum = 0, cnt = 0;
      D.sales.forEach(s => { if (s.at >= start && s.at < end && s.kind !== 'buy') { sum += s.total; cnt++; } });
      days.push({ date: start, total: sum, count: cnt });
    }
    let pending = 0; const seen = {};
    D.tickets.forEach(k => { if (k.table >= 1 && !seen[k.table]) { seen[k.table] = 1; pending += store.billOf(k.table).sub; } });
    send(res, 200, {
      count: today.length, total: r2(total), cash: r2(cash), transfer: r2(transfer), avg: today.length ? Math.round(total / today.length) : 0,
      pending, openTables: Object.keys(seen).length, top, days, buy, bills: all.slice().reverse()
    });
  },

  'GET /api/export.csv': async (req, res, url) => {
    requireStaff(req);
    const month = url.searchParams.get('month') || U.monthKey(Date.now());
    if (!/^\d{4}-\d{2}$/.test(month)) throw fail('รูปแบบเดือนต้องเป็น YYYY-MM');
    let lines = [];
    try { lines = fs.readFileSync(path.join(C.SALES_DIR, month + '.jsonl'), 'utf8').split('\n').filter(Boolean); } catch (e) { lines = []; }
    const q = csvCell;
    // ประเภท/หมายเหตุ/ส่วนลด อยู่ก่อนคอลัมน์รายการ (รายการอยู่ท้ายสุดเหมือนเดิม) · ขายหน้าร้านไม่มีโต๊ะ ใส่ "หน้าร้าน" หรือเลขคิว
    // ส่วนลดมีเฉพาะบิลที่รับชำระจากใบแจ้งหนี้ (รวม = ยอด − ส่วนลด + VAT)
    const rows = [['เลขที่', 'วันที่', 'เวลา', 'โต๊ะ', biz.info(st.D.settings.biz).terms.csv, 'ค่าบริการ', 'VAT', 'รวม', 'ชำระโดย', 'ประเภท', 'หมายเหตุ', 'ส่วนลด', 'รายการ'].map(q).join(',')];
    lines.forEach(l => {
      let s; try { s = JSON.parse(l); } catch (e) { return; }
      const d = new Date(s.at);
      rows.push([
        s.no, d.getFullYear() + '-' + U.pad(d.getMonth() + 1) + '-' + U.pad(d.getDate()), U.pad(d.getHours()) + ':' + U.pad(d.getMinutes()),
        s.table || (s.q ? 'คิว ' + s.q : 'หน้าร้าน'), s.sub, s.svc, s.vat, s.total, s.method === 'transfer' ? 'โอน/QR' : 'เงินสด',
        s.kind === 'buy' ? 'รับซื้อ' : 'ขาย', typeof s.memo === 'string' ? s.memo : '', typeof s.disc === 'number' ? s.disc : 0,
        (s.items || []).map(i => i.name + ' x' + i.qty + (i.unit ? ' ' + i.unit : '')).join('; ')
      ].map(q).join(','));
    });
    audit(req, 'report.exported', { month, rows: rows.length - 1 });
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="sales-' + month + '.csv"' });
    res.end('﻿' + rows.join('\r\n'));     // BOM ให้ Excel อ่านภาษาไทยได้
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
