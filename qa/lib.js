'use strict';
// ตัวช่วยร่วมของสคริปต์ QA: เปิดเซิร์ฟเวอร์ในโฟลเดอร์ชั่วคราว (ไม่แตะข้อมูลจริงของร้าน) และเรียก API
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PIN = '246810';
let portSeq = 5200 + Math.floor(Math.random() * 400);
const BAD_PORTS = new Set([5060, 5061, 6000]);
// สคริปต์ล้มกลางทางก็ต้องไม่ทิ้งเซิร์ฟเวอร์และโฟลเดอร์ชั่วคราวไว้ (บน Windows process ลูกไม่ตายตามแม่)
const running = new Set(), temps = new Set();
process.on('exit', () => {
  running.forEach(p => { try { p.kill('SIGKILL'); } catch (e) { /* ignore */ } });
  temps.forEach(d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
});
['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => process.exit(130)));

// สำเนาโค้ดระบบไปโฟลเดอร์ชั่วคราว (code) ส่วนข้อมูลแยกไว้อีกโฟลเดอร์ (data) ได้ เพื่อทดสอบ DATA_DIR
function makeApp(opts) {
  opts = opts || {};
  const base = opts.base || fs.mkdtempSync(path.join(os.tmpdir(), 'ordervai-qa-'));
  temps.add(base);
  const code = opts.codeDir || base;
  fs.mkdirSync(code, { recursive: true });
  const from = opts.from || process.env.QA_FROM || ROOT;   // QA_FROM=โฟลเดอร์โค้ดเดิม เพื่อพิสูจน์ว่าบั๊กมีอยู่จริงก่อนแก้
  fs.copyFileSync(path.join(from, 'server.js'), path.join(code, 'server.js'));
  for (const d of ['lib', 'public']) fs.cpSync(path.join(from, d), path.join(code, d), { recursive: true });
  fs.copyFileSync(path.join(from, 'menu.json'), path.join(code, 'menu.json'));
  return { base, code };
}

function start(code, env, nodeArgs) {
  let port = env && env.PORT ? +env.PORT : portSeq++;
  while (BAD_PORTS.has(port)) port = portSeq++;
  const e = Object.assign({}, process.env, { PORT: String(port), STAFF_PIN: PIN, ORDER_LIMIT: '1000' }, env || {});
  const proc = spawn(process.execPath, (nodeArgs || []).concat(['server.js']), { cwd: code, env: e });
  running.add(proc); proc.on('exit', () => running.delete(proc));
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { out += d; });
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start:\n' + out)), 15000);
    proc.stdout.on('data', () => { if (out.includes('พร้อมใช้งาน')) { clearTimeout(t); resolve(); } });
    proc.on('exit', code2 => { clearTimeout(t); reject(Object.assign(new Error('exited ' + code2 + '\n' + out), { code: code2, out })); });
  });
  ready.catch(() => {});
  const s = { proc, port, B: 'http://127.0.0.1:' + port, cookie: '', ready, get out() { return out; } };
  s.call = (method, p, body, o) => call(s, method, p, body, o);
  s.login = () => s.call('POST', '/api/login', { pin: PIN });
  s.kill9 = () => new Promise(r => { if (proc.exitCode !== null) return r(); proc.on('exit', r); proc.kill('SIGKILL'); });
  s.stop = () => new Promise(r => { if (proc.exitCode !== null) return r(); proc.on('exit', r); proc.kill('SIGTERM'); });
  return s;
}

// เรียก API ด้วย http ตรงๆ (กำหนด IP ต้นทางได้ด้วย localAddress เช่น 127.0.0.7)
function call(s, method, p, body, o) {
  o = o || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, o.headers || {});
    if (o.staff !== false && s.cookie) headers.cookie = s.cookie;
    let data = null;
    if (body !== undefined) {
      data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      if (!headers['content-type']) headers['content-type'] = 'application/json';
      headers['content-length'] = data.length;
    }
    const req = http.request(s.B + p, { method, headers, localAddress: o.ip, agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks), text = buf.toString('utf8');
        const sc = res.headers['set-cookie'];
        if (sc && sc[0].startsWith('st=')) s.cookie = sc[0].split(';')[0];
        let json = null; try { json = JSON.parse(text); } catch (e) { /* csv/html */ }
        resolve({ status: res.statusCode, json, text, buf, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (o.timeout) req.setTimeout(o.timeout, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (!(await fn())) { if (Date.now() > end) throw new Error('รอเกิน ' + ms + ' ms: ' + (what || '')); await sleep(50); }
}
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
function salesLines(dir) {
  const sd = path.join(dir, 'sales');
  if (!fs.existsSync(sd) || !fs.statSync(sd).isDirectory()) return [];
  const out = [];
  for (const f of fs.readdirSync(sd).sort()) {
    for (const l of fs.readFileSync(path.join(sd, f), 'utf8').split('\n')) {
      if (!l) continue;
      try { out.push(Object.assign(JSON.parse(l), { _file: f })); } catch (e) { out.push({ _bad: l, _file: f }); }
    }
  }
  return out;
}

// ผลตรวจแบบสั้น: ok(เงื่อนไข, ข้อความ) เก็บผลไว้พิมพ์สรุปท้ายสคริปต์
function checker(title) {
  const res = [];
  const ok = (cond, msg, extra) => { res.push({ pass: !!cond, msg, extra }); console.log((cond ? '  ✔ ' : '  ✖ ') + msg + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); return !!cond; };
  ok.done = () => {
    const f = res.filter(r => !r.pass);
    console.log('\n' + title + ': ผ่าน ' + (res.length - f.length) + '/' + res.length);
    if (f.length) process.exitCode = 1;
    return f.length === 0;
  };
  return ok;
}

// รูปอาหารจำลอง (วาดด้วย canvas ในเบราว์เซอร์ ไม่โหลดจากเน็ต) สำหรับอัปโหลดเป็นรูปเมนูหรือโลโก้
async function fakePhoto(browser, hue, size) {
  const p = await (await browser.newContext()).newPage();
  const b64 = await p.evaluate(([h, n]) => {
    const c = document.createElement('canvas'); c.width = c.height = n; const x = c.getContext('2d');
    const g = x.createRadialGradient(n * .45, n * .4, n * .05, n / 2, n / 2, n * .7);
    g.addColorStop(0, 'hsl(' + h + ',85%,72%)'); g.addColorStop(.55, 'hsl(' + (h + 15) + ',70%,45%)'); g.addColorStop(1, 'hsl(' + (h + 25) + ',40%,18%)');
    x.fillStyle = g; x.fillRect(0, 0, n, n);
    x.fillStyle = 'rgba(255,255,255,.85)'; x.beginPath(); x.arc(n * .5, n * .55, n * .28, 0, 7); x.fill();
    x.fillStyle = 'hsl(' + h + ',80%,40%)'; x.beginPath(); x.arc(n * .5, n * .55, n * .2, 0, 7); x.fill();
    for (let i = 0; i < 14; i++) { x.fillStyle = 'hsl(' + (90 + i * 7) + ',60%,' + (30 + i % 3 * 8) + '%)'; x.beginPath(); x.arc(n * (.38 + (i * 37 % 25) / 100), n * (.45 + (i * 53 % 22) / 100), n * .025, 0, 7); x.fill(); }
    return c.toDataURL('image/png').split(',')[1];
  }, [hue, size || 600]);
  await p.context().close();
  return Buffer.from(b64, 'base64');
}

// ภาพพื้นหลังจำลองแนวนอน (แสงโบเก้โทนร้านอาหารยามเย็น) สำหรับทดสอบ/ถ่ายภาพหน้าจอ
async function fakeCover(browser, hue) {
  const p = await (await browser.newContext()).newPage();
  const b64 = await p.evaluate(h => {
    const W = 1600, H = 900, c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, 'hsl(' + h + ',55%,22%)'); g.addColorStop(1, 'hsl(' + (h + 30) + ',70%,45%)');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    let s = 7; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < 70; i++) { const rad = 20 + r() * 110; x.fillStyle = 'hsla(' + (h + 20 + r() * 40) + ',90%,' + (60 + r() * 25) + '%,' + (0.08 + r() * 0.25) + ')'; x.beginPath(); x.arc(r() * W, r() * H * 0.8, rad, 0, 7); x.fill(); }
    x.fillStyle = 'rgba(40,20,10,.55)'; x.fillRect(0, H * 0.72, W, H * 0.28);
    return c.toDataURL('image/jpeg', 0.85).split(',')[1];
  }, hue || 25);
  await p.context().close();
  return Buffer.from(b64, 'base64');
}
// เบราว์เซอร์ที่ใช้ทดสอบ: Edge (ค่าเริ่มต้น) / QA_BROWSER=chrome / QA_BROWSER_PATH=<ไฟล์โปรแกรม> ใช้ Chromium ที่ติดตั้งไว้แล้ว (เช่น เครื่อง Linux)
function browserOpt() { return process.env.QA_BROWSER_PATH ? { executablePath: process.env.QA_BROWSER_PATH } : { channel: process.env.QA_BROWSER === 'chrome' ? 'chrome' : 'msedge' }; }

module.exports = { ROOT, PIN, makeApp, start, call, sleep, until, rmrf, salesLines, checker, fakePhoto, fakeCover, browserOpt };
