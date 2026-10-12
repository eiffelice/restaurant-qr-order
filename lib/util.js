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
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
const TRANSIENT = ['EPERM', 'EBUSY', 'EACCES', 'EAGAIN'];
// บน Windows โปรแกรมสำรองไฟล์/แอนตี้ไวรัส/Google Drive อาจล็อกไฟล์ชั่วครู่ จึงลองซ้ำก่อนยอมแพ้
function retry(fn) {
  let last;
  for (let i = 0; i < 5; i++) {
    try { return fn(); }
    catch (e) { last = e; if (!TRANSIENT.includes(e.code)) break; sleepSync(40 * (i + 1)); }
  }
  throw last;
}
function writeAtomic(file, content) {
  retry(() => fs.writeFileSync(file + '.tmp', content));
  try { retry(() => fs.renameSync(file + '.tmp', file)); }
  catch (e) { try { fs.unlinkSync(file + '.tmp'); } catch (_) { /* ignore */ } throw e; }
}
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

module.exports = {
  die, fail, isNum, isInt, isStr, str, pad, dayStart, ymd, stamp, monthKey,
  retry, writeAtomic, rmrf, listDir, safeEq, sniffImage, send, readRaw, readBody
};
