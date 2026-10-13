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
   cookie = <id>.<ลายเซ็น> ลายเซ็นผูกกับ PIN และ ver ของคนนั้น: เปลี่ยน PIN/บทบาท/ปิดบัญชี/สั่งออกทุกเครื่อง = เครื่องที่เข้าอยู่หลุดหมด */
const ROLES = { owner: 'เจ้าของ', cashier: 'แคชเชียร์', waiter: 'พนักงานเสิร์ฟ', kitchen: 'ครัว' };
// FRONT = แตะเงินได้ (รับเงิน ยกเลิกออเดอร์ สรุปยอด) · SERVE = ดูแลโต๊ะ (สั่งแทนลูกค้า รับทราบการเรียก เปิดโต๊ะ) พนักงานเสิร์ฟอยู่ในกลุ่มนี้แต่ไม่อยู่ใน FRONT
const ALL = ['owner', 'cashier', 'waiter', 'kitchen'], FRONT = ['owner', 'cashier'], SERVE = ['owner', 'cashier', 'waiter'];
// สิทธิ์ตรวจที่เซิร์ฟเวอร์ใน requireStaff(): endpoint ที่ไม่ได้ระบุ = เจ้าของเท่านั้น (endpoint ใหม่ปลอดภัยไว้ก่อน)
const PERM = {
  'GET /api/events': ALL, 'GET /api/state': ALL, 'POST /api/ticket': ALL, 'POST /api/soldout': ALL,
  'POST /api/ticket/void': FRONT, 'POST /api/call/clear': SERVE, 'POST /api/pay': FRONT, 'GET /api/report': FRONT,
  'POST /api/table/seat': SERVE, 'POST /api/reauth': ALL, 'GET /api/reauth': ALL
};
const hmac = s => crypto.createHmac('sha256', st.D.secret).update(s).digest('hex');
const pinHash = pin => hmac('pin:' + pin);
function ownerAccount() { return { id: 'owner', name: 'เจ้าของร้าน', role: 'owner', active: true, ver: st.D.ownerVer || 0, pinHash: pinHash(C.PIN) }; }
function findAccount(id) { return id === 'owner' ? ownerAccount() : st.D.staff.find(s => s.id === id) || null; }
/* cookie = <id>.<n>.<ลายเซ็น> n = เวลาออก (ฐาน 36) + '-' + สุ่ม แต่ละเครื่องจึงได้ค่าไม่ซ้ำกัน
   (การยืนยัน PIN ซ้ำผูกกับเครื่องที่ยืนยัน ไม่ใช่ทั้งบัญชี) และเจ้าของหมดอายุตาม OWNER_SESSION_MS
   cookie แบบเดิม <id>.<ลายเซ็น> ยังใช้ได้สำหรับแคชเชียร์/ครัว ส่วนเจ้าของต้องเข้าสู่ระบบใหม่ (แบบเดิมไม่มีวันหมดอายุ) */
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
   PIN เดียวทั้งร้าน จึงระบุผู้ทำได้ระดับเครื่อง: staff/guest, IP, ชนิดอุปกรณ์ และรหัสคำขอ */
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
      soldOut: D.settings.soldOut, svc: D.settings.svc, vat: D.settings.vat,
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
    D.tickets.forEach(k => { if (!bills[k.table]) bills[k.table] = store.billOf(k.table); });
    send(res, 200, {
      settings: D.settings, menu: D.menu, stations: D.menu.stations,
      tickets: D.tickets, calls: D.calls, bills, keys: FRONT.includes(who.role) ? D.keys : {},   // รหัส QR ทุกโต๊ะ: เฉพาะเจ้าของ/แคชเชียร์ (พนักงานเสิร์ฟสั่งแทนด้วย cookie ไม่ต้องใช้ ปิดบัญชีแล้วจะได้ไม่มีรหัสติดตัว)
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
    st.D.settings = s;
    // สิ่งที่หน้าลูกค้าแสดง เปลี่ยนแล้ว version เพิ่ม หน้าลูกค้าที่เปิดอยู่โหลดเมนู/สีใหม่เอง (เดิมเฉพาะสี ชื่อร้านใหม่ต้องรีเฟรชเอง)
    if (['shop', 'address', 'phone', 'accent', 'tagline', 'look', 'social', 'shareUrl', 'hours'].some(k => JSON.stringify(was[k]) !== JSON.stringify(s[k]))) st.D.menu.version++;
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
    // ยกเว้นเฉพาะค่าที่เป็นตัวเลขล้วน ("-2+3+cmd|..." ขึ้นต้นด้วยตัวเลขแต่เป็นสูตร)
    const q = v => { let s = String(v); if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
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
