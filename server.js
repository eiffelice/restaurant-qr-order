'use strict';
/*
  ออเดอร์ไว · ระบบสั่งอาหารผ่าน QR  (Node 18+, ไม่ต้อง npm install)

  รัน:            node server.js
  ตั้งค่าผ่าน environment:
    STAFF_PIN     PIN ของบัญชีเจ้าของร้าน (ค่าเริ่มต้น 1234 ต้องเปลี่ยน อย่างน้อย 6 หลัก) พนักงานคนอื่นเพิ่มในหน้าตั้งค่า
    PORT          พอร์ต (ค่าเริ่มต้น 3000)
    DATA_DIR      โฟลเดอร์เก็บข้อมูล (ค่าเริ่มต้น โฟลเดอร์นี้)
    BACKUP_DIR    โฟลเดอร์ที่จะคัดลอกไฟล์สำรองไปเก็บอีกที่ เช่น โฟลเดอร์ Google Drive หรือแฟลชไดรฟ์
    TRUST_PROXY=1 ใช้เมื่อเปิดผ่าน Cloudflare Tunnel ที่รันบนเครื่องเดียวกัน (ต้องตั้ง STAFF_PIN อย่างน้อย 6 หลัก)
    ORDER_LIMIT   จำนวนครั้งที่ลูกค้าสั่งได้ต่อนาทีต่อเครื่อง (ค่าเริ่มต้น 8)
    BACKUP_EVERY_MIN, REAUTH_SEC, OWNER_SESSION_MIN  ดูตารางใน AGENTS.md (อ่านค่าทั้งหมดที่ lib/config.js)

  โครงสร้าง
    lib/config.js   ค่าตั้งต้นและ environment
    lib/util.js     ฟังก์ชันช่วย: วันที่ ไฟล์ HTTP
    lib/store.js    ข้อมูลร้าน การบันทึก การตรวจซ่อมข้อมูล การคำนวณบิล
    lib/backup.js   สำรองและกู้คืนข้อมูล
    lib/routes.js   API ทั้งหมด
*/
const http = require('http');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const C = require('./lib/config');
const U = require('./lib/util');
const log = require('./lib/log');

if (C.TRUST_PROXY && (C.PIN === '1234' || C.PIN.length < 6)) {
  U.die('เปิดระบบออกอินเทอร์เน็ต (TRUST_PROXY=1) ต้องตั้งรหัสพนักงานอย่างน้อย 6 หลัก เช่น STAFF_PIN=839274 node server.js');
}

const store = require('./lib/store');
const theme = require('./lib/theme');
const backup = require('./lib/backup');
const { api, clients, requireStaff, lanUrl, lanCandidates } = require('./lib/routes');

/* ข้อมูลชุดเดียวกันเปิดได้ทีละโปรแกรม ถ้าเปิดซ้อน (แม้คนละพอร์ต) สองตัวจะเขียน data.json ทับกันและออกเลขบิลซ้ำ
   ใช้ named pipe (Windows) / abstract socket (Linux) ที่ระบบปฏิบัติการคืนให้เองเมื่อโปรแกรมดับ จึงไม่มีล็อกค้าง */
function lockDataDir(done) {
  const id = crypto.createHash('sha1').update(C.DATA_DIR.toLowerCase()).digest('hex').slice(0, 16);
  const win = process.platform === 'win32', linux = process.platform === 'linux';
  const p = win ? '\\\\.\\pipe\\ordervai-' + id : linux ? '\0ordervai-' + id : path.join(os.tmpdir(), 'ordervai-' + id + '.sock');
  const running = () => U.die('ระบบเปิดอยู่แล้วในอีกหน้าต่างหนึ่ง (ข้อมูลที่ ' + C.DATA_DIR + ')\n' +
    '  ใช้หน้าต่างเดิม หรือปิดหน้าต่างเดิมก่อน ห้ามเปิดซ้อนแม้คนละพอร์ต เพราะข้อมูลจะเขียนทับกันและเลขบิลซ้ำ');
  const listen = retried => {
    const srv = net.createServer(c => c.destroy());
    srv.on('error', e => {
      if (e.code !== 'EADDRINUSE') U.die('ล็อกโฟลเดอร์ข้อมูลไม่ได้: ' + e.message);
      const c = net.connect(p);
      c.on('connect', () => { c.destroy(); running(); });
      c.on('error', () => {               // ไม่มีใครตอบ = ไฟล์ socket ค้างจากครั้งก่อนที่ดับ (macOS)
        if (retried || win || linux) running();
        try { fs.unlinkSync(p); } catch (_) { /* ignore */ }
        listen(true);
      });
    });
    srv.listen(p, () => { srv.unref(); done(); });
  };
  listen(false);
}

const FILES = { '/staff': 'staff.html', '/order': 'customer.html', '/qrcode.js': 'qrcode.js' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const SEC = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };
// ระหว่างกู้คืนข้อมูล ยังอ่านได้ แต่ห้ามเขียน เพื่อไม่ให้ออเดอร์ที่เข้ามาช่วงนั้นหายไปเงียบๆ
const ALWAYS_ALLOWED = new Set(['/api/login', '/api/logout', '/api/backup/restore']);

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
  // ทุกคำขอมีรหัสอ้างอิง ใส่ใน log และใน error ที่หน้าจอแสดง ไล่จากหน้าร้านไปถึง log ได้
  req.id = crypto.randomBytes(6).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  try {
    if (req.method === 'GET' && url.pathname === '/api/events') {
      requireStaff(req);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    const handler = api[req.method + ' ' + url.pathname];
    if (handler) {
      if (store.state.restoring && req.method === 'POST' && !ALWAYS_ALLOWED.has(url.pathname)) {
        throw U.fail('กำลังกู้คืนข้อมูล กรุณารอสักครู่แล้วลองใหม่', 503);
      }
      return await handler(req, res, url);
    }
    if (req.method === 'GET') {
      if (url.pathname === '/') { res.writeHead(302, { Location: '/staff' }); return res.end(); }
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      // สีร้านที่เจ้าของตั้ง (สร้างจาก settings.accent ที่ตรวจแล้วเท่านั้น) หน้าเว็บโหลดต่อท้าย <style> ของหน้า
      if (url.pathname === '/theme.css') {
        res.writeHead(200, Object.assign({ 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-cache' }, SEC));
        return res.end(theme.css(store.state.D.settings.accent));
      }
      if (url.pathname.startsWith('/img/')) {
        const name = url.pathname.slice(5);
        const file = path.join(C.IMG_DIR, name);
        if (C.IMG_RE.test(name) && fs.existsSync(file)) {
          res.writeHead(200, Object.assign({ 'Content-Type': MIME[path.extname(name)], 'Cache-Control': 'public, max-age=31536000, immutable' }, SEC));
          return fs.createReadStream(file).pipe(res);
        }
      }
      const f = FILES[url.pathname];
      if (f) {
        const body = fs.readFileSync(path.join(C.PUB, f));
        res.writeHead(200, Object.assign({ 'Content-Type': MIME[path.extname(f)], 'Cache-Control': 'no-cache' }, SEC));
        return res.end(body);
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ไม่พบหน้านี้');
  } catch (e) {
    if (!e.status) log.app('error', 'request_failed', { req: req.id, method: req.method, path: url.pathname, error: String(e && e.stack || e) });
    if (!res.headersSent) {
      // ส่งข้อมูลเกินขนาด: ตอบแล้วตัดการเชื่อมต่อทันที ไม่อ่านส่วนที่เหลือต่อ
      const extra = e.closeConnection ? { Connection: 'close' } : {};
      if (e.closeConnection) res.on('finish', () => req.socket.destroy());
      U.send(res, e.status || 500, Object.assign({ error: e.status ? e.message : 'เกิดข้อผิดพลาดในระบบ (รหัสอ้างอิง ' + req.id + ')', requestId: req.id }, e.status && e.code ? { code: e.code } : {}), extra);
    } else res.end();
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') U.die('พอร์ต ' + C.PORT + ' ถูกใช้อยู่ อาจเปิดระบบซ้อนไว้แล้ว\n  ปิดหน้าต่างเดิม หรือรันพอร์ตอื่น: PORT=3001 node server.js');
  throw e;
});

lockDataDir(() => {
  store.load();
  log.prune(); setInterval(log.prune, C.DAY).unref();
  ['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => { store.writeFinal(); process.exit(0); }));
  server.listen(C.PORT, '0.0.0.0', () => {
    const all = lanCandidates();
    console.log('\nออเดอร์ไว พร้อมใช้งาน\n');
    console.log('  หน้าพนักงาน/ครัว :  http://localhost:' + C.PORT + '/staff');
    console.log('  ที่อยู่สำหรับลูกค้า :  ' + lanUrl() + '   (มือถือต้องต่อ WiFi เดียวกับเครื่องนี้)');
    if (all.length > 1) console.log('  ที่อยู่อื่นของเครื่องนี้: ' + all.slice(1).map(a => 'http://' + a + ':' + C.PORT).join(', '));
    console.log('  เก็บข้อมูลที่ :  ' + C.DATA_DIR);
    console.log('  ไฟล์สำรอง :  ' + C.BK_DIR + (C.BK_COPY ? '  และคัดลอกไป ' + C.BK_COPY : '  (ตั้ง BACKUP_DIR เพื่อคัดลอกไปเก็บอีกที่)'));
    if (C.PIN === '1234' || C.PIN.length < 6) console.log('\n  ! รหัสพนักงานสั้นหรือเป็นค่าเริ่มต้น ควรตั้งอย่างน้อย 6 หลัก:  STAFF_PIN=รหัสใหม่ node server.js');
    console.log('');
    log.app('info', 'start', { port: C.PORT, trustProxy: C.TRUST_PROXY });
    log.startVerifier();
    backup.startAuto();
  });
});
