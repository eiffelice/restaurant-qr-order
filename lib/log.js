'use strict';
/* Log แยก 3 ชนิด ไฟล์ละเดือนใน DATA_DIR/logs/ (append-only, ไม่มี API ให้ลบ)
   audit-YYYY-MM.jsonl     ใครทำอะไรกับข้อมูลธุรกิจ: ยกเลิกออเดอร์ รับเงิน แก้ราคา ตั้งค่า PromptPay กู้คืน ดาวน์โหลดข้อมูล
                           มี before/after และ hash chain (prev/hash) แก้หรือลบบรรทัดกลางไฟล์แล้วตรวจเจอ
   security-YYYY-MM.jsonl  เข้าสู่ระบบ รหัสผิด ถูกจำกัด ถูกปฏิเสธสิทธิ์ รหัส QR ผิด
   app-YYYY-MM.jsonl       ข้อผิดพลาดของระบบ บันทึกไฟล์ไม่สำเร็จ เปิด/ปิดโปรแกรม
   Log ไม่ใช่แหล่งข้อมูลยอดขาย ยอดขายจริงอยู่ใน sales/ เสมอ
   ห้ามบันทึก PIN, cookie, รหัส QR (keys) และ secret: ทุกค่าผ่าน clean() ก่อนเขียน */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./config');
const U = require('./util');

const KEEP_MONTHS = { audit: 25, security: 6, app: 3 };
const SECRET_KEYS = /^(pin|key|keys|secret|cookie|st|token|password)$/i;
const BACKOFF = [50, 200, 500, 1000, 2000, 5000];

const queue = [];              // บรรทัดที่ยังเขียนไม่สำเร็จ เรียงตามลำดับเกิด
let timer = null, fails = 0, lastHash = null;
let onHealth = () => {};
function setHealthListener(fn) { onHealth = fn; }

function fileOf(kind, ts) { return path.join(C.LOG_DIR, kind + '-' + U.monthKey(ts) + '.jsonl'); }
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// ตัดค่าลับทิ้ง และจำกัดขนาด กัน log บวมจากข้อมูลที่ผู้ใช้ส่งมา
function clean(v, depth) {
  depth = depth || 0;
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > 300 ? v.slice(0, 300) + '…' : v;
  if (depth > 4) return '…';
  if (Array.isArray(v)) return v.slice(0, 60).map(x => clean(x, depth + 1));
  if (typeof v === 'object') {
    const o = {};
    Object.keys(v).slice(0, 40).forEach(k => { if (!SECRET_KEYS.test(k)) o[k] = clean(v[k], depth + 1); });
    return o;
  }
  return String(v);
}

// hash ของบรรทัดสุดท้ายใน audit ล่าสุด เพื่อต่อ chain ข้ามการปิดเปิดโปรแกรมและข้ามเดือน
function readLastHash() {
  const files = U.listDir(C.LOG_DIR, /^audit-\d{4}-\d{2}\.jsonl$/).sort();
  // อ่านแค่ท้ายไฟล์ ไฟล์ปลายเดือนใหญ่หลายสิบ MB อ่านทั้งไฟล์แล้วทั้งระบบค้าง
  for (let i = files.length - 1; i >= 0; i--) {
    let fd;
    try {
      fd = fs.openSync(path.join(C.LOG_DIR, files[i]), 'r');
      const size = fs.fstatSync(fd).size, n = Math.min(size, 64 * 1024), buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, size - n);
      const lines = buf.toString('utf8').split('\n');
      for (let j = lines.length - 1; j >= (n < size ? 1 : 0); j--) { try { const r = JSON.parse(lines[j]); if (r.hash) return r.hash; } catch (e) { /* บรรทัดเสียหรือขาด */ } }
    } catch (e) { return 'unreadable'; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return '';
}

function write(kind, ev) {
  const ts = Date.now();
  const rec = Object.assign({ at: new Date(ts).toISOString() }, clean(ev));
  if (kind === 'audit') {
    if (lastHash === null) lastHash = readLastHash();
    rec.prev = lastHash;
    rec.hash = sha(lastHash + JSON.stringify(rec));
    lastHash = rec.hash;
  }
  queue.push({ file: fileOf(kind, ts), line: JSON.stringify(rec) + '\n' });
  flush();
  return rec;
}

function flush() {
  clearTimeout(timer); timer = null;
  try {
    while (queue.length) {
      fs.mkdirSync(C.LOG_DIR, { recursive: true });
      fs.appendFileSync(queue[0].file, queue[0].line);
      queue.shift();
    }
    fails = 0; onHealth(null);
  } catch (e) {
    // ห้ามหยุดรอแบบ sync (กฎข้อ 17) และห้ามทิ้ง: เก็บในคิว ลองใหม่เรื่อยๆ และขึ้นป้ายเตือนเหมือนไฟล์ข้อมูล
    if (fails || !U.isTransient(e)) onHealth(e);
    timer = setTimeout(flush, BACKOFF[Math.min(fails++, BACKOFF.length - 1)]);
  }
}
// ปิดโปรแกรม: ลองซ้ำแบบหยุดรอได้
function flushFinal() {
  clearTimeout(timer);
  try { while (queue.length) { const q = queue[0]; U.retry(() => fs.appendFileSync(q.file, q.line)); queue.shift(); } }
  catch (e) { console.error('บันทึก log ไม่สำเร็จ:', e.message); }
}

function prune() {
  const now = new Date();
  U.listDir(C.LOG_DIR, C.LOG_RE).forEach(f => {
    const m = f.match(/^(\w+)-(\d{4})-(\d{2})\.jsonl$/);
    const age = (now.getFullYear() - +m[2]) * 12 + (now.getMonth() + 1 - +m[3]);
    if (age >= KEEP_MONTHS[m[1]]) U.rmrf(path.join(C.LOG_DIR, f));
  });
}

/* ตรวจ hash chain ของไฟล์ audit หนึ่งเดือน: บอกบรรทัดแรกที่ถูกแก้ ลบ หรือแทรก
   ไฟล์ปลายเดือนของร้านที่ขายดีใหญ่ราว 20 MB ถ้าอ่านทั้งไฟล์ทีเดียว ทั้งระบบค้างครึ่งวินาที จึง:
   - ตรวจเต็มไฟล์แบบ stream (ทยอยอ่าน คำขออื่นแทรกได้) ทุก 10 นาที และตอนสำรองข้อมูล
   - ระหว่างนั้น ตรวจเฉพาะส่วนที่ต่อท้ายมาใหม่ต่อจาก hash ล่าสุดที่ตรวจแล้ว (เล็ก ทำแบบ sync ได้) */
const auditFile = month => path.join(C.LOG_DIR, 'audit-' + month + '.jsonl');
function checker() {
  let prev = null, n = 0, bad = null;
  return {
    line(l, prevOverride) {
      if (bad || !l) return;
      n++;
      let r;
      try { r = JSON.parse(l); } catch (e) { bad = { brokenAt: n, reason: 'บรรทัดเสีย' }; return; }
      const h = r.hash; delete r.hash;
      if (sha(r.prev + JSON.stringify(r)) !== h) { bad = { brokenAt: n, reason: 'เนื้อหาถูกแก้' }; return; }
      const expect = prev !== null ? prev : prevOverride;
      if (expect != null && r.prev !== expect) { bad = { brokenAt: n, reason: 'มีบรรทัดถูกลบหรือแทรก' }; return; }
      prev = h;
    },
    result(offsetLines) { return bad ? { ok: false, lines: (offsetLines || 0) + n, brokenAt: (offsetLines || 0) + bad.brokenAt, reason: bad.reason } : { ok: true, lines: (offsetLines || 0) + n }; },
    get last() { return prev; }
  };
}
const vcache = {};            // month -> { size, last, result, at }
const running = {};
function verifyFull(month) {
  if (running[month]) return running[month];
  const f = auditFile(month);
  running[month] = new Promise(resolve => {
    let size = 0, mtime = 0;
    try { const s = fs.statSync(f); size = s.size; mtime = s.mtimeMs; } catch (e) { vcache[month] = { size: 0, mtime: 0, last: null, result: { ok: true, lines: 0 }, at: Date.now() }; return resolve(vcache[month].result); }
    const ck = checker();
    // อ่านทีละชิ้นเล็ก (16 KB) ระหว่างชิ้นคำขออื่นแทรกได้
    const rl = require('readline').createInterface({ input: fs.createReadStream(f, { start: 0, end: size - 1, highWaterMark: 16 * 1024 }), crlfDelay: Infinity });
    rl.on('line', l => ck.line(l));
    rl.on('close', () => { vcache[month] = { size, mtime, last: ck.last, result: ck.result(), at: Date.now() }; resolve(vcache[month].result); });
    rl.on('error', e => resolve({ ok: false, lines: 0, brokenAt: 0, reason: 'อ่านไฟล์ไม่ได้: ' + e.message }));
  }).finally(() => { delete running[month]; });
  return running[month];
}
// สำหรับหน้าสรุปยอด: ตอบทันทีจากผลที่ตรวจไว้ ต่อด้วยตรวจเฉพาะบรรทัดใหม่
function verifyQuick(month) {
  const f = auditFile(month), c = vcache[month];
  let size = 0, mtime = 0;
  try { const s = fs.statSync(f); size = s.size; mtime = s.mtimeMs; } catch (e) { return { ok: true, lines: 0 }; }
  // ขนาดเท่าเดิมแต่ไฟล์ถูกแก้ (เช่น เปลี่ยนตัวเลขความยาวเท่าเดิม) ต้องตรวจใหม่ทั้งไฟล์
  if (!c || Date.now() - c.at > 600000 || size < c.size || (size === c.size && mtime !== c.mtime)) {
    verifyFull(month);
    return c && size >= c.size ? Object.assign({}, c.result, { checking: true }) : { ok: null, checking: true };
  }
  if (size === c.size || !c.result.ok) return c.result;   // ตรวจเจอว่าเสียแล้ว คงผลไว้จนตรวจเต็มรอบถัดไป
  let fd;
  try {
    fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(size - c.size);
    fs.readSync(fd, buf, 0, buf.length, c.size);
    const ck = checker();
    buf.toString('utf8').split('\n').forEach(l => ck.line(l, c.last));
    const r = ck.result(c.result.lines);
    vcache[month] = { size, mtime, last: ck.last || c.last, result: r, at: c.at };
    return r;
  } catch (e) { return c.result; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/* เหตุการณ์ในช่วงเวลา [from, to) อ่านจากท้ายไฟล์ย้อนขึ้นไป หยุดเมื่อเลยช่วง
   (log เรียงตามเวลา ดูของวันนี้จึงอ่านแค่ส่วนของวันนี้ ไม่ใช่ทั้งเดือน) ตัดเป็น Buffer ที่ \n กันตัวอักษรไทยขาดกลางตัว */
function readRange(kind, month, from, to) {
  let fd;
  try { fd = fs.openSync(path.join(C.LOG_DIR, kind + '-' + month + '.jsonl'), 'r'); } catch (e) { return []; }
  try {
    const out = [], CH = 256 * 1024;
    let pos = fs.fstatSync(fd).size, carry = Buffer.alloc(0), done = false;
    const take = b => {
      if (!b.length) return;
      let r; try { r = JSON.parse(b.toString('utf8')); } catch (e) { return; }
      const ts = Date.parse(r.at);
      if (ts < from) done = true; else if (ts < to) out.push(r);
    };
    while (pos > 0 && !done) {
      const n = Math.min(CH, pos); pos -= n;
      const chunk = Buffer.alloc(n); fs.readSync(fd, chunk, 0, n, pos);
      const buf = Buffer.concat([chunk, carry]);
      let end = buf.length;
      for (let i = buf.length - 1; i >= 0 && !done; i--) if (buf[i] === 0x0a) { take(buf.subarray(i + 1, end)); end = i; }
      carry = buf.subarray(0, end);
    }
    if (!done) take(carry);
    return out.reverse();
  } finally { fs.closeSync(fd); }
}
/* อ่านทั้งเดือนแบบ stream ทีละ 16 KB (ไม่ทำให้ระบบค้าง กฎข้อ 33) เก็บเฉพาะบรรทัดที่มีคำว่า has และ keep(rec) ตอบ true
   ใช้กับรายงานเดือน/ปี (รายการยกเลิก) ไฟล์ไม่มีหรืออ่านไม่ได้ = เท่าที่อ่านได้ */
function scan(kind, month, has, keep) {
  return new Promise(resolve => {
    const out = [];
    const input = fs.createReadStream(path.join(C.LOG_DIR, kind + '-' + month + '.jsonl'), { highWaterMark: 16 * 1024 });
    input.on('error', () => resolve(out));
    const rl = require('readline').createInterface({ input, crlfDelay: Infinity });
    rl.on('line', l => { if (has && !l.includes(has)) return; let r; try { r = JSON.parse(l); } catch (e) { return; } if (keep(r)) out.push(r); });
    rl.on('error', () => resolve(out));      // readline ส่ง error ของไฟล์ต่อมาที่นี่ (ไม่มีตัวรับ = โปรแกรมล้ม)
    rl.on('close', () => resolve(out));
  });
}
// ผลที่แน่นอนเสมอ: ปกติตอบทันที ถ้ายังไม่เคยตรวจหรือผลเก่าเกิน 10 นาที รอการตรวจแบบ stream (ไม่ทำให้ระบบค้าง)
async function verify(month) {
  const q = verifyQuick(month);
  return q.checking ? verifyFull(month) : q;
}
function startVerifier() {
  setInterval(() => verifyFull(U.monthKey(Date.now())), 600000).unref();
  setTimeout(() => verifyFull(U.monthKey(Date.now())), 2000).unref();
}

const audit = ev => write('audit', ev);
const security = ev => write('security', ev);
function app(level, msg, data) {
  if (level === 'error') console.error(msg, data && data.error ? data.error : '');
  return write('app', Object.assign({ level, msg }, data || {}));
}

module.exports = { audit, security, app, flush, flushFinal, prune, verify, verifyFull, verifyQuick, readRange, scan, startVerifier, clean, setHealthListener, KEEP_MONTHS };
