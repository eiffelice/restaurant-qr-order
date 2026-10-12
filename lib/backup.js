'use strict';
/* สำรองและกู้คืนข้อมูล
   ไฟล์สำรองเป็น JSON บีบอัด gzip หนึ่งไฟล์ มีครบทุกอย่าง: data, ยอดขายทุกเดือน, รูปอาหาร
   เขียนแบบ stream ทีละส่วน ระบบจึงไม่ค้างระหว่างสำรอง แม้ข้อมูลจะสะสมมาหลายปี */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const C = require('./config');
const U = require('./util');
const store = require('./store');
const { state } = store;

const gunzip = promisify(zlib.gunzip);
let lastAutoSeq = null;          // changeSeq ตอนสำรองอัตโนมัติครั้งก่อน
let queue = Promise.resolve();   // สำรองทีละครั้ง ไม่ซ้อนกัน

/* ---------- เขียนไฟล์สำรอง ---------- */
async function writeBackupFile(target) {
  store.writeNow();
  // snapshot ข้อมูลหลักกับยอดขายเดือนปัจจุบันพร้อมกันแบบ synchronous เพื่อให้เลขบิลตรงกันเสมอ
  // (เดือนที่ปิดแล้วไม่มีใครเขียนเพิ่ม อ่านทีหลังแบบ async ได้)
  const createdAt = Date.now();
  const dataJson = JSON.stringify(state.D);
  const shop = state.D.settings.shop;
  const current = U.monthKey(createdAt) + '.jsonl';
  const months = U.listDir(C.SALES_DIR, C.SALES_RE).sort();
  let currentText = null;
  if (months.includes(current)) currentText = fs.readFileSync(path.join(C.SALES_DIR, current), 'utf8');
  const images = U.listDir(C.IMG_DIR, C.IMG_RE);

  const tmp = target + '.tmp';
  const gz = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(tmp);
  const finished = new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); gz.on('error', reject); });
  gz.pipe(out);
  const write = s => new Promise(resolve => { if (gz.write(s)) resolve(); else gz.once('drain', resolve); });
  try {
    await write('{"app":"ordervai-backup","format":2,"createdAt":' + createdAt + ',"shop":' + JSON.stringify(shop) + ',"data":' + dataJson + ',"sales":{');
    let first = true;
    for (const f of months) {
      const text = f === current ? currentText : await fsp.readFile(path.join(C.SALES_DIR, f), 'utf8');
      await write((first ? '' : ',') + JSON.stringify(f) + ':' + JSON.stringify(text));
      first = false;
    }
    await write('},"images":{');
    first = true;
    for (const f of images) {
      let buf;
      try { buf = await fsp.readFile(path.join(C.IMG_DIR, f)); } catch (e) { continue; }   // รูปถูกลบระหว่างสำรอง
      await write((first ? '' : ',') + JSON.stringify(f) + ':"' + buf.toString('base64') + '"');
      first = false;
    }
    await write('}}');
    gz.end();
    await finished;
    U.retry(() => fs.renameSync(tmp, target));
  } catch (e) {
    gz.destroy(); out.destroy();
    U.rmrf(tmp);
    throw e;
  }
  return createdAt;
}

function pruneBackups(dir) {
  const files = U.listDir(dir, C.BK_RE).sort().reverse();          // ใหม่สุดก่อน (ชื่อไฟล์เรียงตามเวลา)
  const recent = new Set([U.ymd(Date.now()), U.ymd(Date.now() - C.DAY)]);
  const days = new Set();
  files.forEach(f => {
    const day = f.slice(7, 15);
    let keep = recent.has(day);
    if (!keep && !days.has(day) && days.size < C.BK_KEEP_DAYS) { days.add(day); keep = true; }
    if (!keep) U.rmrf(path.join(dir, f));
  });
}

async function doBackup(reason) {
  const seq = state.changeSeq;
  const name = 'backup-' + U.stamp(Date.now()) + '-' + reason + '.json.gz';
  fs.mkdirSync(C.BK_DIR, { recursive: true });
  const at = await writeBackupFile(path.join(C.BK_DIR, name));
  pruneBackups(C.BK_DIR);
  const info = { at, name, reason, size: fs.statSync(path.join(C.BK_DIR, name)).size, copied: null, copyError: '' };
  if (C.BK_COPY) {
    try {
      await fsp.mkdir(C.BK_COPY, { recursive: true });
      await fsp.copyFile(path.join(C.BK_DIR, name), path.join(C.BK_COPY, name));
      pruneBackups(C.BK_COPY);
      info.copied = true;
    } catch (e) {
      info.copied = false; info.copyError = e.message;
      console.error('คัดลอกไฟล์สำรองไป ' + C.BK_COPY + ' ไม่สำเร็จ:', e.message);
    }
  }
  state.D.lastBackup = info;
  if (reason === 'auto') { state.D.lastAutoBackupAt = at; lastAutoSeq = seq; }
  store.writeNow();          // ไม่นับเป็นการเปลี่ยนแปลงข้อมูล จะได้ไม่สำรองซ้ำเพราะตัวเอง
  return info;
}
function writeBackup(reason) {
  const p = queue.then(() => doBackup(reason));
  queue = p.catch(() => {});
  return p;
}

function autoBackup() {
  const D = state.D;
  if (state.restoring) return;
  if (Date.now() - (D.lastAutoBackupAt || 0) < C.BK_EVERY) return;
  if (lastAutoSeq !== null && lastAutoSeq === state.changeSeq) return;   // ไม่มีอะไรเปลี่ยนตั้งแต่ครั้งก่อน
  writeBackup('auto').catch(e => console.error('สำรองข้อมูลอัตโนมัติไม่สำเร็จ:', e.message));
}
function startAuto() {
  setTimeout(autoBackup, 3000).unref();
  setInterval(autoBackup, Math.min(10 * 60000, C.BK_EVERY)).unref();
}

function list() {
  return U.listDir(C.BK_DIR, C.BK_RE).sort().reverse().map(f => {
    const st = fs.statSync(path.join(C.BK_DIR, f));
    return { name: f, size: st.size, at: st.mtimeMs, reason: f.replace(/^backup-\d{8}-\d{6}-/, '').replace(/\.json(\.gz)?$/, '') };
  });
}

/* ---------- กู้คืน ----------
   ลำดับ: อ่านและตรวจไฟล์ → สำรองข้อมูลปัจจุบัน → เตรียมยอดขาย/รูปในโฟลเดอร์ชั่วคราว → สลับโฟลเดอร์ → ใช้ข้อมูลใหม่
   ถ้าพังก่อนขั้นสลับ ข้อมูลเดิมไม่ถูกแตะเลย */
function validateBackup(b) {
  if (!b || b.app !== 'ordervai-backup' || !b.data || typeof b.data !== 'object') throw U.fail('ไฟล์นี้ไม่ใช่ไฟล์สำรองของออเดอร์ไว');
  if (!b.data.keys || !b.data.settings || !b.data.secret) throw U.fail('ไฟล์สำรองไม่สมบูรณ์');
  const sales = b.sales || {}, images = b.images || {};
  Object.keys(sales).forEach(n => { if (!C.SALES_RE.test(n) || !U.isStr(sales[n])) throw U.fail('ไฟล์สำรองมีข้อมูลยอดขายที่ไม่ถูกต้อง'); });
  Object.keys(images).forEach(n => { if (!C.IMG_RE.test(n) || !U.isStr(images[n])) throw U.fail('ไฟล์สำรองมีรูปภาพที่ไม่ถูกต้อง'); });
}
async function parseBackup(buf) {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { buf = await gunzip(buf, { maxOutputLength: 1024 * 1024 * 1024 }); }
    catch (e) { throw U.fail('ไฟล์สำรองเสียหาย แตกไฟล์ไม่ได้'); }
  }
  try { return JSON.parse(buf.toString('utf8')); }
  catch (e) { throw U.fail('ไฟล์สำรองเสียหาย หรือไม่ใช่ไฟล์สำรองของออเดอร์ไว'); }
}
function swapDir(live, staged) {
  const old = live + '.old-' + Date.now();
  if (fs.existsSync(live)) U.retry(() => fs.renameSync(live, old));
  try { U.retry(() => fs.renameSync(staged, live)); }
  catch (e) { if (fs.existsSync(old)) fs.renameSync(old, live); throw e; }
  return old;
}
async function restore(buf) {
  const b = await parseBackup(buf);
  validateBackup(b);
  const rep = { dropped: 0 };
  const next = store.normalize(b.data, rep);     // ยังไม่แตะ state.D

  state.restoring = true;                        // ระหว่างนี้ห้ามสั่งอาหาร/แก้ข้อมูล กันข้อมูลหาย
  try {
    const before = await writeBackup('before-restore');
    const sTmp = C.SALES_DIR + '.restore-tmp', iTmp = C.IMG_DIR + '.restore-tmp';
    U.rmrf(sTmp); U.rmrf(iTmp);
    const imgs = new Set();
    try {
      fs.mkdirSync(sTmp, { recursive: true }); fs.mkdirSync(iTmp, { recursive: true });
      for (const n of Object.keys(b.sales || {})) await fsp.writeFile(path.join(sTmp, n), b.sales[n]);
      for (const n of Object.keys(b.images || {})) {
        const img = Buffer.from(b.images[n], 'base64');
        if (U.sniffImage(img)) { await fsp.writeFile(path.join(iTmp, n), img); imgs.add(n); }
      }
    } catch (e) {
      U.rmrf(sTmp); U.rmrf(iTmp);
      throw U.fail('กู้คืนไม่สำเร็จ ข้อมูลเดิมไม่ถูกแตะต้อง (' + e.message + ')', 500);
    }
    const oldSales = swapDir(C.SALES_DIR, sTmp);
    let oldImgs;
    try { oldImgs = swapDir(C.IMG_DIR, iTmp); }
    catch (e) {                                   // สลับรูปไม่ได้ → คืนโฟลเดอร์ยอดขายเดิม
      U.rmrf(C.SALES_DIR); fs.renameSync(oldSales, C.SALES_DIR); U.rmrf(iTmp);
      throw U.fail('กู้คืนไม่สำเร็จ ข้อมูลเดิมไม่ถูกแตะต้อง (' + e.message + ')', 500);
    }
    U.rmrf(oldSales); U.rmrf(oldImgs);

    next.salesArchived = true;
    next.menu.items.forEach(m => { if (m.image && !imgs.has(m.image)) m.image = ''; });
    next.lastBackup = before;
    state.D = next;
    store.ensureKeys(); store.trimSales(); store.writeNow();
    state.changeSeq++;
    return { before, dropped: rep.dropped, createdAt: b.createdAt };
  } finally {
    state.restoring = false;
  }
}

module.exports = { writeBackup, startAuto, list, restore };
