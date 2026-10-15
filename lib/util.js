'use strict';
/* ฟังก์ชันช่วยทั่วไป: วันที่, ไฟล์, HTTP */
const fs = require('fs');
const crypto = require('crypto');

function die(msg) { console.error('\n[เริ่มระบบไม่ได้] ' + msg + '\n'); process.exit(1); }
function fail(msg, status) { const e = new Error(msg); e.status = status || 400; return e; }

const isNum = v => typeof v === 'number' && isFinite(v);
const isInt = v => Number.isInteger(v);
const isStr = v => typeof v === 'string';
function str(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max); }

function pad(n, w) { return String(n).padStart(w || 2, '0'); }
function dayStart(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function ymd(ts) { const d = new Date(ts); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); }
function stamp(ts) { const d = new Date(ts); return ymd(ts) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()); }
function monthKey(ts) { const d = new Date(ts); return d.getFullYear() + '-' + pad(d.getMonth() + 1); }

/* ---------- ไฟล์ ---------- */
// บน Windows โปรแกรมสำรองไฟล์/แอนตี้ไวรัส/Google Drive อาจล็อกไฟล์ชั่วครู่ จึงลองซ้ำก่อนยอมแพ้
const TRANSIENT = ['EPERM', 'EBUSY', 'EACCES', 'EAGAIN'];
const isTransient = e => !!e && TRANSIENT.includes(e.code);
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
// หยุดรอแบบ sync ทำให้ทั้งระบบค้างระหว่างรอ ใช้ได้เฉพาะตอนปิดโปรแกรม ระหว่างเปิดร้านใช้ retryAsync
function retry(fn) {
  for (let i = 1; ; i++) {
    try { return fn(); }
    catch (e) { if (i >= 5 || !isTransient(e)) throw e; sleepSync(40 * i); }
  }
}
async function retryAsync(fn) {
  for (let i = 1; ; i++) {
    try { return fn(); }
    catch (e) { if (i >= 5 || !isTransient(e)) throw e; await new Promise(r => setTimeout(r, 40 * i)); }
  }
}
/* เขียนไฟล์ชั่วคราว → fsync (สั่งลงดิสก์จริง) → rename ทับ
   ไม่ fsync ก่อน rename แล้วไฟดับ ระบบไฟล์อาจบันทึก rename แต่เนื้อไฟล์ยังไม่ลงดิสก์ ได้ data.json ว่าง */
function writeDurable(file, content, flag) {
  const fd = fs.openSync(file, flag);
  try { fs.writeSync(fd, content); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function writeAtomic(file, content) {
  try { writeDurable(file + '.tmp', content, 'w'); fs.renameSync(file + '.tmp', file); }
  catch (e) { try { fs.unlinkSync(file + '.tmp'); } catch (_) { /* ignore */ } throw e; }
}
// ต่อท้ายไฟล์แล้ว fsync ก่อนคืนค่า (ยอดขายใน sales/ ที่ตอบว่าบันทึกแล้วต้องไม่หายเมื่อไฟดับ)
function appendDurable(file, content) { writeDurable(file, content, 'a'); }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
function listDir(dir, re) { try { return fs.readdirSync(dir).filter(f => re.test(f)); } catch (e) { return []; } }

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function sniffImage(b) {
  if (b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpg';
  if (b.length > 8 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'png';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/* ---------- HTTP ---------- */
function send(res, code, obj, headers) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
  res.end(JSON.stringify(obj));
}
// อ่าน body ไม่เกิน limit ถ้าเกิน หยุดอ่านทันทีและติดธงให้ตัดการเชื่อมต่อหลังตอบ 413
function tooLarge() { const e = fail('ข้อมูลหรือไฟล์ใหญ่เกินไป', 413); e.closeConnection = true; return e; }
function readRaw(req, limit) {
  const declared = +req.headers['content-length'];
  if (declared > limit) { req.pause(); return Promise.reject(tooLarge()); }
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, done = false;
    function onData(c) {
      size += c.length;
      if (size > limit) {
        done = true;
        req.removeListener('data', onData);
        req.pause();
        reject(tooLarge());
        return;
      }
      chunks.push(c);
    }
    req.on('data', onData);
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', e => { if (!done) { done = true; reject(e); } });
  });
}
async function readBody(req, limit) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw fail('ต้องส่งข้อมูลแบบ JSON', 415);
  const buf = await readRaw(req, limit);
  let v;
  try { v = buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch (e) { throw fail('รูปแบบข้อมูลไม่ถูกต้อง'); }
  return v && typeof v === 'object' ? v : {};
}

/* ลิงก์โซเชียลมีเดียของร้านและลิงก์แชร์ร้าน (แสดงเป็นปุ่มในหน้าลูกค้า)
   รับ URL เต็ม, URL ไม่มี https:// หรือชื่อบัญชี (@ชื่อ) แล้วคืน URL เต็มแบบ https
   ต้องเป็นโดเมนของแพลตฟอร์มนั้นจริง (กันพิมพ์ผิดช่อง และกันลิงก์ javascript: / ไปเว็บอื่น) ลิงก์แชร์เป็นเว็บอะไรก็ได้แต่ต้อง http(s) */
const LINKS = {
  facebook: { name: 'Facebook', hosts: ['facebook.com', 'fb.com', 'fb.me', 'fb.watch'], handle: h => 'https://www.facebook.com/' + h },
  instagram: { name: 'Instagram', hosts: ['instagram.com', 'instagr.am'], handle: h => 'https://www.instagram.com/' + h + '/' },
  line: { name: 'LINE', hosts: ['line.me', 'lin.ee'], handle: h => 'https://line.me/R/ti/p/@' + h },
  tiktok: { name: 'TikTok', hosts: ['tiktok.com'], handle: h => 'https://www.tiktok.com/@' + h },
  share: { name: 'ลิงก์แชร์ร้าน', hosts: null }
};
function cleanLink(kind, v) {
  const L = LINKS[kind];
  v = typeof v === 'string' ? v.trim() : '';
  if (!L || !v) return { ok: true, url: '' };
  const bad = { ok: false, error: L.name + ': ใส่ลิงก์เต็ม เช่น ' + (L.hosts ? 'https://' + L.hosts[0] + '/ชื่อร้าน' : 'https://www.google.com/maps/...') + (L.hosts ? ' หรือชื่อบัญชี เช่น @ชื่อร้าน' : '') };
  // ชื่อบัญชี: ขึ้นต้นด้วย @ หรือไม่มีจุดและ / เลย
  if (L.hosts && (v[0] === '@' || !/[./]/.test(v))) {
    const h = v.replace(/^@/, '');
    return /^[A-Za-z0-9._-]{1,60}$/.test(h) ? { ok: true, url: L.handle(h) } : bad;
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v.replace(/^\/+/, '');
  let u;
  try { u = new URL(v); } catch (e) { return bad; }
  if (!(u.protocol === 'https:' || (!L.hosts && u.protocol === 'http:')) || u.username || u.password || !u.hostname.includes('.')) return bad;
  const host = u.hostname.toLowerCase();
  if (L.hosts && !L.hosts.some(d => host === d || host.endsWith('.' + d))) {
    return { ok: false, error: L.name + ': ลิงก์ต้องเป็นของ ' + L.hosts[0] + ' (ใส่ผิดช่องหรือเปล่า)' };
  }
  if (u.href.length > 300) return { ok: false, error: L.name + ': ลิงก์ยาวเกินไป' };
  return { ok: true, url: u.href };
}

module.exports = {
  LINKS, cleanLink,
  die, fail, isNum, isInt, isStr, str, pad, dayStart, ymd, stamp, monthKey,
  isTransient, retry, retryAsync, writeAtomic, appendDurable, rmrf, listDir, safeEq, sniffImage, send, readRaw, readBody
};
