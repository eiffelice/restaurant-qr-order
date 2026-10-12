'use strict';
/* ข้ามเที่ยงคืนและข้ามสิ้นเดือน (นาฬิกาปลอมผ่าน qa/fake-time.js ไม่แก้โค้ดระบบ)
   node qa/time.js     ใช้เวลาเครื่อง (โซนเวลาของ Windows) เริ่ม 31 ต.ค. 23:59:50 */
const fs = require('node:fs');
const path = require('node:path');
const { makeApp, start, sleep, rmrf, salesLines, checker } = require('./lib');

async function main() {
  const ok = checker('time');
  const app = makeApp();
  const startAt = new Date(2026, 9, 31, 23, 59, 50).toISOString();      // เวลาท้องถิ่น 31 ต.ค. 23:59:50
  const s = start(app.code, { FAKE_NOW: startAt }, ['-r', path.join(__dirname, 'fake-time.js')]);
  await s.ready; await s.login();
  const keys = (await s.call('GET', '/api/state')).json.keys;
  const pay = async t => {
    await s.call('POST', '/api/order', { table: t, key: keys[t], items: [{ id: 1, qty: 1 }] });
    const sub = (await s.call('GET', '/api/state')).json.bills[t].sub;
    return (await s.call('POST', '/api/pay', { table: t, expectedSub: sub, method: 'cash' })).json.sale;
  };
  const a = await pay(1);
  const r1 = (await s.call('GET', '/api/report')).json;
  ok(r1.count === 1 && r1.total === a.total, 'ก่อนเที่ยงคืน: สรุปยอดวันนี้มี 1 บิล', { count: r1.count });
  await sleep(11500);                                                  // ข้ามเที่ยงคืน = ข้ามเดือน
  const r2 = (await s.call('GET', '/api/report')).json;
  ok(r2.count === 0 && r2.total === 0, 'หลังเที่ยงคืน: สรุปยอดวันนี้เริ่มใหม่เป็น 0', { count: r2.count, total: r2.total });
  ok(r2.days[5].total === a.total && r2.days[6].total === 0, 'กราฟ 7 วัน: ยอดเมื่อวานอยู่ที่วันก่อนหน้า', r2.days.slice(5).map(d => new Date(d.date).toDateString() + ' ' + d.total));
  ok(r2.pending === 0, 'ไม่มียอดค้าง');
  const b = await pay(2);
  const files = fs.readdirSync(path.join(app.code, 'sales')).sort();
  const lines = salesLines(app.code);
  ok(files.join(',') === '2026-10.jsonl,2026-11.jsonl', 'ยอดขายลงไฟล์เดือนใหม่', files);
  ok(lines.find(l => l.no === a.no)._file === '2026-10.jsonl' && lines.find(l => l.no === b.no)._file === '2026-11.jsonl', 'บิลก่อน/หลังเที่ยงคืนอยู่คนละเดือน');
  const csvOct = (await s.call('GET', '/api/export.csv?month=2026-10')).text, csvNov = (await s.call('GET', '/api/export.csv')).text;
  ok(/2026-10-31/.test(csvOct) && !/2026-11/.test(csvOct) && /2026-11-01/.test(csvNov), 'CSV แยกเดือนถูก และไม่ระบุเดือนได้เดือนปัจจุบัน (พ.ย.)');
  ok(b.no === a.no + 1, 'เลขบิลต่อเนื่องข้ามเดือน', [a.no, b.no]);
  await s.stop(); rmrf(app.base);
  ok.done();
}
main().catch(e => { console.error(e); process.exit(2); });
