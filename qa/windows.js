'use strict';
/* Windows: DATA_DIR/BACKUP_DIR ที่มีช่องว่างและภาษาไทย, start.bat ตามตัวอย่างใน AGENTS.md, การลบไฟล์สำรองเก่า, เปิดซ้อนสองหน้าต่าง
   node qa/windows.js */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { makeApp, start, sleep, until, rmrf, checker, PIN } = require('./lib');

async function main() {
  const ok = checker('windows');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordervai-win-'));
  const dataDir = path.join(root, 'ข้อมูล ร้าน ป้าแดง'), bkDir = path.join(root, 'Google Drive', 'สำรอง ออเดอร์ไว');
  const app = makeApp({ codeDir: path.join(root, 'โปรแกรม สั่งอาหาร') });
  // 1) DATA_DIR / BACKUP_DIR มีช่องว่างและภาษาไทย
  let s = start(app.code, { DATA_DIR: dataDir, BACKUP_DIR: bkDir }); await s.ready; await s.login();
  const keys = (await s.call('GET', '/api/state')).json.keys;
  await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 1 }] });
  const sub = (await s.call('GET', '/api/state')).json.bills[1].sub;
  await s.call('POST', '/api/pay', { table: 1, expectedSub: sub, method: 'cash' });
  const bk = (await s.call('POST', '/api/backup', {})).json.backup;
  ok(fs.existsSync(path.join(dataDir, 'data.json')) && fs.readdirSync(path.join(dataDir, 'sales')).length === 1, 'DATA_DIR ภาษาไทย+ช่องว่าง: data.json และ sales/ อยู่ถูกที่');
  ok(bk.copied === true && fs.existsSync(path.join(bkDir, bk.name)), 'BACKUP_DIR ภาษาไทย+ช่องว่าง: คัดลอกไฟล์สำรองไปได้', bk.copyError || bk.name);
  // 2) rename ทับไฟล์เดิม (data.json ถูกเขียนทับหลายร้อยครั้ง)
  for (let i = 0; i < 200; i++) await s.call('POST', '/api/call', { table: 2, key: keys[2], kind: 'staff' });
  ok(!(await s.call('GET', '/api/state')).json.health.saveError && !fs.existsSync(path.join(dataDir, 'data.json.tmp')), 'rename ทับ data.json 200 ครั้งติดกันไม่มี error และไม่มี .tmp ค้าง');
  // 3) เปิดซ้อนสองหน้าต่าง: พอร์ตเดียวกัน และคนละพอร์ต
  for (const env of [{ PORT: String(s.port) }, {}]) {
    const b = start(app.code, Object.assign({ DATA_DIR: dataDir }, env));
    const msg = await b.ready.then(() => 'เปิดได้', e => e.out.split('\n').find(l => /เริ่มระบบไม่ได้/.test(l)) || e.message);
    ok(/เปิดอยู่แล้ว/.test(msg), 'เปิดหน้าต่างที่สอง' + (env.PORT ? 'พอร์ตเดิม' : 'คนละพอร์ต') + ': ไม่ยอมเปิด', msg.trim());
    if (msg === 'เปิดได้') await b.stop();
  }
  // 4) ลบไฟล์สำรองเก่า: เก็บทุกไฟล์ของวันนี้กับเมื่อวาน + วันละไฟล์ย้อนหลัง 30 วัน
  const pad = n => String(n).padStart(2, '0');
  const stamp = d => d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  for (const dir of [path.join(dataDir, 'backups'), bkDir]) for (let d = 0; d < 45; d++) for (const h of ['09', '13', '17']) {
    const day = new Date(Date.now() - d * 86400000);
    fs.writeFileSync(path.join(dir, 'backup-' + stamp(day) + '-' + h + '0000-auto.json.gz'), 'x');
  }
  fs.writeFileSync(path.join(bkDir, 'งานอื่น.xlsx'), 'ไฟล์อื่นในโฟลเดอร์เดียวกัน');
  await sleep(1100);
  await s.call('POST', '/api/backup', {});
  for (const dir of [path.join(dataDir, 'backups'), bkDir]) {
    const files = fs.readdirSync(dir).filter(f => /^backup-/.test(f));
    const days = new Set(files.map(f => f.slice(7, 15)));
    const today = files.filter(f => f.slice(7, 15) === stamp(new Date())).length, yday = files.filter(f => f.slice(7, 15) === stamp(new Date(Date.now() - 86400000))).length;
    const oldest = Math.round((Date.now() - new Date(...[...days].sort()[0].match(/(\d{4})(\d\d)(\d\d)/).slice(1).map((v, i) => i === 1 ? v - 1 : +v))) / 86400000);
    ok(today >= 3 && yday === 3 && days.size === 32 && files.length === today + 3 + 30, path.basename(dir) + ': เก็บ ' + files.length + ' ไฟล์ ' + days.size + ' วัน ย้อนหลังสุด ' + oldest + ' วัน', { today, yday });
  }
  ok(fs.existsSync(path.join(bkDir, 'งานอื่น.xlsx')), 'ไฟล์อื่นใน BACKUP_DIR ไม่ถูกลบ');
  await s.stop();
  // 5) start.bat ตามตัวอย่างใน AGENTS.md (บันทึกเป็น UTF-8 แบบที่ Notepad สมัยนี้บันทึก) ใส่ BACKUP_DIR ภาษาไทย
  const bat = path.join(app.code, 'start.bat'), bk2 = path.join(root, 'สำรอง จาก bat');
  const port = 5900 + Math.floor(Math.random() * 90);
  const docBat = fs.readFileSync(path.join(__dirname, '..', 'AGENTS.md'), 'utf8').match(/```bat\n([\s\S]*?)```/)[1];
  fs.writeFileSync(bat, docBat.replace(/set STAFF_PIN=\d+/, 'set STAFF_PIN=' + PIN + '\r\nset PORT=' + port + '\r\nset DATA_DIR=' + dataDir).replace(/set BACKUP_DIR=.*/, 'set BACKUP_DIR=' + bk2).replace(/\r?\n/g, '\r\n'));
  const p = spawn('cmd.exe', ['/c', bat], { cwd: root, windowsHide: true });
  let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  let started = false;
  try { await until(() => out.includes('พร้อมใช้งาน') || p.exitCode !== null, 15000, 'start.bat'); started = out.includes('พร้อมใช้งาน'); } catch (e) { /* ดูผลด้านล่าง */ }
  ok(started, 'start.bat ในโฟลเดอร์ภาษาไทย+ช่องว่าง เปิดระบบได้', started ? undefined : out.slice(-300));
  if (started) {
    const t = { B: 'http://127.0.0.1:' + port, cookie: '' }; t.call = (m, q, b, o) => require('./lib').call(t, m, q, b, o);
    await t.call('POST', '/api/login', { pin: PIN });
    const r = (await t.call('POST', '/api/backup', {})).json.backup;
    ok(r.copied && fs.existsSync(path.join(bk2, r.name)), 'start.bat: BACKUP_DIR ภาษาไทยในไฟล์ .bat ใช้ได้', { copied: r.copied, copyError: r.copyError, foldersInRoot: fs.readdirSync(root) });
  }
  spawn('taskkill', ['/pid', String(p.pid), '/t', '/f']);
  await sleep(800);
  rmrf(root);
  ok.done();
}
main().catch(e => { console.error(e); process.exit(2); });
