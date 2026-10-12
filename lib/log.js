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
  for (let i = files.length - 1; i >= 0; i--) {
    let text = '';
    try { text = fs.readFileSync(path.join(C.LOG_DIR, files[i]), 'utf8'); } catch (e) { return 'unreadable'; }
    const lines = text.split('\n').filter(Boolean);
    for (let j = lines.length - 1; j >= 0; j--) { try { const r = JSON.parse(lines[j]); if (r.hash) return r.hash; } catch (e) { /* บรรทัดเสีย */ } }
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

// ตรวจ hash chain ของไฟล์ audit หนึ่งเดือน: บอกบรรทัดแรกที่ถูกแก้ ลบ หรือแทรก
function verify(month) {
  const f = path.join(C.LOG_DIR, 'audit-' + month + '.jsonl');
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch (e) { return { ok: true, lines: 0 }; }
  const lines = text.split('\n').filter(Boolean);
  let prev = null;
  for (let i = 0; i < lines.length; i++) {
    let r;
    try { r = JSON.parse(lines[i]); } catch (e) { return { ok: false, lines: lines.length, brokenAt: i + 1, reason: 'บรรทัดเสีย' }; }
    const h = r.hash; delete r.hash;
    if (sha(r.prev + JSON.stringify(r)) !== h) return { ok: false, lines: lines.length, brokenAt: i + 1, reason: 'เนื้อหาถูกแก้' };
    if (prev !== null && r.prev !== prev) return { ok: false, lines: lines.length, brokenAt: i + 1, reason: 'มีบรรทัดถูกลบหรือแทรก' };
    prev = h;
  }
  return { ok: true, lines: lines.length };
}

function read(kind, month) {
  try {
    return fs.readFileSync(path.join(C.LOG_DIR, kind + '-' + month + '.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

const audit = ev => write('audit', ev);
const security = ev => write('security', ev);
function app(level, msg, data) {
  if (level === 'error') console.error(msg, data && data.error ? data.error : '');
  return write('app', Object.assign({ level, msg }, data || {}));
}

module.exports = { audit, security, app, flush, flushFinal, prune, verify, read, clean, setHealthListener, KEEP_MONTHS };
