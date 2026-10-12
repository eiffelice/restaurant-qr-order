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

// สำเนาโค้ดระบบไปโฟลเดอร์ชั่วคราว (code) ส่วนข้อมูลแยกไว้อีกโฟลเดอร์ (data) ได้ เพื่อทดสอบ DATA_DIR
function makeApp(opts) {
  opts = opts || {};
  const base = opts.base || fs.mkdtempSync(path.join(os.tmpdir(), 'ordervai-qa-'));
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

module.exports = { ROOT, PIN, makeApp, start, call, sleep, until, rmrf, salesLines, checker };
