'use strict';
// การเขียนไฟล์ข้อมูลให้ทนไฟดับ: ข้อมูลต้องถูกสั่งลงดิสก์จริง (fsync) ก่อนแทนที่ไฟล์เดิม / ก่อนตอบว่าบันทึกแล้ว
// จำลองไฟดับในเทสต์ไม่ได้ จึงตรวจสิ่งที่รับประกันแทน: ลำดับ fsync → rename และ append แล้ว fsync ก่อนคืนค่า
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const U = require('../lib/util');

// บันทึกว่าไฟล์ไหนถูก fsync และ rename ตอนไหน (ใช้ fs ตัวจริงทั้งหมด แค่จดลำดับ)
function recordFs() {
  const events = [], fdPath = new Map(), orig = {};
  const wrap = (name, fn) => { orig[name] = fs[name]; fs[name] = fn; };
  wrap('openSync', function (p, ...a) { const fd = orig.openSync.call(fs, p, ...a); fdPath.set(fd, String(p)); return fd; });
  wrap('fsyncSync', function (fd) { events.push(['fsync', fdPath.get(fd)]); return orig.fsyncSync.call(fs, fd); });
  wrap('renameSync', function (a, b) { events.push(['rename', String(a), String(b)]); return orig.renameSync.call(fs, a, b); });
  return { events, restore: () => Object.assign(fs, orig) };
}

describe('เขียนไฟล์ข้อมูลแบบทนไฟดับ', () => {
  let rec, dir;
  afterEach(() => { if (rec) rec.restore(); rec = null; if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  test('writeAtomic: สั่ง fsync ไฟล์ชั่วคราวก่อน rename ทับ data.json (ไฟดับหลัง rename แล้วไฟล์ต้องไม่ว่าง)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-durable-'));
    const file = path.join(dir, 'data.json');
    fs.writeFileSync(file, '{"old":1}');
    rec = recordFs();
    U.writeAtomic(file, '{"new":2}');
    const ev = rec.events;
    const sync = ev.findIndex(e => e[0] === 'fsync' && e[1] === file + '.tmp');
    const ren = ev.findIndex(e => e[0] === 'rename' && e[2] === file);
    assert.ok(sync >= 0, 'ไม่ได้ fsync ไฟล์ชั่วคราว: ' + JSON.stringify(ev));
    assert.ok(ren > sync, 'rename เกิดก่อน fsync: ' + JSON.stringify(ev));
    assert.equal(fs.readFileSync(file, 'utf8'), '{"new":2}');
    assert.ok(!fs.existsSync(file + '.tmp'), 'ไฟล์ชั่วคราวค้าง');
  });

  test('appendDurable: เพิ่มบรรทัดยอดขายแล้ว fsync ก่อนคืนค่า (บิลที่ตอบว่าบันทึกแล้วต้องอยู่บนดิสก์)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-durable-'));
    const file = path.join(dir, '2026-10.jsonl');
    rec = recordFs();
    U.appendDurable(file, '{"no":1}\n');
    U.appendDurable(file, '{"no":2}\n');
    assert.equal(rec.events.filter(e => e[0] === 'fsync' && e[1] === file).length, 2, JSON.stringify(rec.events));
    assert.equal(fs.readFileSync(file, 'utf8'), '{"no":1}\n{"no":2}\n');
  });

  test('writeAtomic: rename ล้ม ไฟล์เดิมไม่เสีย และไม่มีไฟล์ชั่วคราวค้าง', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-durable-'));
    const file = path.join(dir, 'data.json');
    fs.writeFileSync(file, '{"old":1}');
    const orig = fs.renameSync;
    fs.renameSync = () => { const e = new Error('ถูกล็อก'); e.code = 'EPERM'; throw e; };
    try { assert.throws(() => U.writeAtomic(file, '{"new":2}'), /ถูกล็อก/); }
    finally { fs.renameSync = orig; }
    assert.equal(fs.readFileSync(file, 'utf8'), '{"old":1}');
    assert.ok(!fs.existsSync(file + '.tmp'));
  });
});
