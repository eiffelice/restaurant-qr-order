'use strict';
/* เงินทุกกรณี: ค่าบริการ/VAT เปิดปิด, ราคาทศนิยม, แก้ราคากลางมื้อ, กดรับเงินซ้ำ/พร้อมกันสองเครื่อง, ปิดบิลระหว่างสำรอง
   ยอดต้องตรงกันทุกที่: คำนวณเอง = เซิร์ฟเวอร์ = calc() ในหน้าพนักงาน = สรุปยอด = CSV = sales/*.jsonl, และ PromptPay QR
   node qa/money.js */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT, makeApp, start, sleep, rmrf, salesLines, checker } = require('./lib');

const r2 = x => Math.round(x * 100) / 100;
function expected(lines, svcOn, vatOn) {
  const sub = r2(lines.reduce((a, l) => a + l.price * l.qty, 0));
  const svc = svcOn ? Math.round(sub * 0.10) : 0, vat = vatOn ? Math.round((sub + svc) * 0.07) : 0;
  return { sub, svc, vat, total: r2(sub + svc + vat) };
}
// ดึงฟังก์ชันจากหน้าพนักงานมาใช้ตรงๆ เพื่อเทียบกับเซิร์ฟเวอร์
function pageFns() {
  const html = fs.readFileSync(path.join(process.env.QA_FROM || ROOT, 'public', 'staff.html'), 'utf8');
  const grab = name => html.match(new RegExp('function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}'))[0];
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext([grab('calc'), grab('crc16'), grab('tlv'), grab('ppPayload')].join('\n'), ctx);
  return ctx;
}
// PromptPay ตามมาตรฐาน EMVCo เขียนแยกเอง (CRC-16/CCITT-FALSE)
function crcRef(s) { let c = 0xFFFF; for (const b of Buffer.from(s, 'ascii')) { c ^= b << 8; for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF; } return c.toString(16).toUpperCase().padStart(4, '0'); }
function parseTlv(s) { const o = {}; let i = 0; while (i < s.length) { const id = s.substr(i, 2), n = +s.substr(i + 2, 2); o[id] = s.substr(i + 4, n); i += 4 + n; } return o; }

async function main() {
  const ok = checker('money');
  const P = pageFns();
  ok(crcRef('123456789') === '29B1' && P.crc16('123456789') === '29B1', 'CRC ของ PromptPay ตรงค่ามาตรฐาน (29B1)');
  for (const [id, amt] of [['0812345678', 1234.5], ['1234567890123', 0.1 + 0.2], ['081-234-5678', 99]]) {
    const p = P.ppPayload(id, amt), t = parseTlv(p), m = parseTlv(t['29']);
    const acct = m['01'] || m['02'];
    ok(t['63'] === crcRef(p.slice(0, -4)) && t['54'] === amt.toFixed(2) && t['53'] === '764' && t['58'] === 'TH' && m['00'] === 'A000000677010111' &&
      acct === (id.replace(/\D/g, '').length === 10 ? '0066' + id.replace(/\D/g, '').slice(1) : id), 'PromptPay QR ' + id + ' ยอด ' + amt.toFixed(2) + ' ถูกต้องทุกช่อง');
  }
  ok(P.ppPayload('12345', 10) === null, 'เบอร์ PromptPay ผิดรูปแบบไม่สร้าง QR');

  const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
  const keys = (await s.call('GET', '/api/state')).json.keys;
  const item = async (name, price) => (await s.call('POST', '/api/menu/item', { name, price, cat: 1, station: 'hot' })).json.item;
  const A = await item('ทศนิยม ก', 45.5), B = await item('ทศนิยม ข', 19.99), C = await item('ทศนิยม ค', 33.33);
  const order = (t, items) => s.call('POST', '/api/order', { table: t, key: keys[t], items }, { staff: false });
  const pay = async (t, svc, vat, method) => { const sub = (await s.call('GET', '/api/state')).json.bills[t].sub; return s.call('POST', '/api/pay', { table: t, expectedSub: sub, svc, vat, method }); };
  const sales = [];
  let t = 0;
  for (const svc of [false, true]) for (const vat of [false, true]) for (const qty of [1, 3, 7]) {
    t = t % 12 + 1;
    const lines = [{ price: A.price, qty }, { price: B.price, qty: qty + 1 }, { price: C.price, qty: 2 }];
    await order(t, [{ id: A.id, qty }, { id: B.id, qty: qty + 1 }, { id: C.id, qty: 2 }]);
    const r = await pay(t, svc, vat, qty % 2 ? 'cash' : 'transfer');
    const e = expected(lines, svc, vat), c = P.calc(e.sub, svc, vat, 1);
    sales.push(r.json.sale);
    ok(r.status === 200 && ['sub', 'svc', 'vat', 'total'].every(k => r.json.sale[k] === e[k] && c[k] === e[k]), 'svc=' + svc + ' vat=' + vat + ' qty=' + qty + ': เซิร์ฟเวอร์ = หน้าพนักงาน = คำนวณเอง', { server: r.json.sale.total, page: c.total, expect: e.total });
  }
  // แก้ราคากลางมื้อ
  t = 11;
  await order(t, [{ id: A.id, qty: 1 }]);
  await s.call('POST', '/api/menu/item', { id: A.id, name: A.name, price: 50, cat: 1, station: 'hot' });
  await order(t, [{ id: A.id, qty: 1 }]);
  const bill = (await s.call('GET', '/api/state')).json.bills[t];
  ok(bill.sub === 95.5 && bill.lines.length === 2, 'แก้ราคากลางมื้อ: บิลคิดราคาตอนสั่ง (45.5 + 50)', bill.lines.map(l => l.price));
  // กดรับเงินซ้ำ และสองเครื่องกดพร้อมกัน
  const [p1, p2] = await Promise.all([pay(t, true, false, 'cash'), pay(t, true, false, 'transfer')]);
  sales.push((p1.status === 200 ? p1 : p2).json.sale);
  ok([p1.status, p2.status].sort().join() === '200,409', 'สองเครื่องกดรับเงินพร้อมกัน: สำเร็จเครื่องเดียว อีกเครื่องได้ 409', [p1.status, p2.status]);
  ok((await s.call('POST', '/api/pay', { table: t, expectedSub: 95.5, method: 'cash' })).status === 409, 'กดรับเงินซ้ำหลังปิดบิลแล้วได้ 409');
  // ปิดบิลระหว่างกำลังสำรอง
  for (let k = 1; k <= 5; k++) await order(k, [{ id: B.id, qty: 1 }]);
  const bk = s.call('POST', '/api/backup', {});
  const during = await Promise.all([1, 2, 3, 4, 5].map(k => pay(k, true, true, 'cash')));
  await bk;
  during.forEach(r => sales.push(r.json.sale));
  ok(during.every(r => r.status === 200), 'ปิดบิลระหว่างสำรองได้ตามปกติ');
  // แยกจ่าย: ปัดขึ้นทีละคน
  const split = [[100, 3], [220.5, 2], [95.5, 4]].map(([tot, n]) => ({ total: tot, n, per: P.calc(tot, false, false, n).per }));
  split.forEach(x => console.log('    แยกจ่าย ยอด ' + x.total + ' / ' + x.n + ' คน = คนละ ' + x.per + ' → เก็บรวม ' + x.per * x.n + ' (เกิน ' + r2(x.per * x.n - x.total) + ')'));

  // ทุกที่ต้องตรงกัน
  const nos = sales.map(x => x.no);
  ok(new Set(nos).size === nos.length, 'เลขบิลไม่ซ้ำ', nos);
  const rep = (await s.call('GET', '/api/report')).json;
  const csv = (await s.call('GET', '/api/export.csv')).text.trim().split('\r\n').slice(1).map(l => l.slice(1, -1).split('","'));
  const jl = salesLines(app.code);
  const sum = a => r2(a.reduce((x, y) => x + y, 0));
  const sTotal = sum(sales.map(x => x.total));
  ok(rep.count === sales.length && r2(rep.total) === sTotal && r2(rep.cash + rep.transfer) === sTotal, 'สรุปยอดวันนี้ = ผลรวมบิลที่ปิด', { report: rep.total, bills: sTotal });
  ok(csv.length === sales.length && sum(csv.map(c => +c[7])) === sTotal, 'CSV = ผลรวมบิล', sum(csv.map(c => +c[7])));
  ok(jl.length === sales.length && sales.every(x => { const l = jl.find(y => y.no === x.no); return l && l.total === x.total && l.sub === x.sub && l.svc === x.svc && l.vat === x.vat && l.method === x.method; }), 'sales/*.jsonl ตรงกับทุกบิลทุกช่อง');
  ok(csv.every(c => { const x = sales.find(y => y.no === +c[0]); return x && +c[4] === x.sub && +c[5] === x.svc && +c[6] === x.vat && +c[7] === x.total; }), 'CSV ตรงกับทุกบิลทุกช่อง');
  console.log('    ผลรวมดิบใน /api/report = ' + rep.total + ' (เศษทศนิยมของ float หน้าจอปัดเหลือ 2 ตำแหน่ง)');
  await s.stop(); rmrf(app.base);
  ok.done();
}
main().catch(e => { console.error(e); process.exit(2); });
