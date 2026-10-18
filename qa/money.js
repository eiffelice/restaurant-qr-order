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
  await counter(ok);
  ok.done();
}

/* ขายหน้าร้าน: ตะกร้าสุ่ม (จำนวนทศนิยม ราคามีสตางค์ ราคาส่ง แถวซ้ำ รับซื้อ ค่าบริการ/VAT)
   posTotals() ของหน้าพนักงาน = เซิร์ฟเวอร์ทุกช่อง (ถ้าไม่ตรงแม้สตางค์เดียว ขายไม่ได้เพราะ expectedSub ไม่ตรง) แล้วสรุปยอด = CSV = sales/*.jsonl */
function posFns(items, settings) {
  const html = fs.readFileSync(path.join(process.env.QA_FROM || ROOT, 'public', 'staff.html'), 'utf8');
  const multi = name => html.match(new RegExp('function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\}'))[0];
  const line = name => html.match(new RegExp('^function ' + name + '\\(.*$', 'm'))[0];
  const ctx = { S: { pos: null, d: { menu: { items }, settings, biz: { kind: 'sell' } } } }; vm.createContext(ctx);
  vm.runInContext([multi('calc'), multi('posInit'), multi('posTotals'), line('round2'), line('posKind'), line('posPrice'), line('okLine'), line('itemById'), line('modes')].join('\n'), ctx);
  return ctx;
}
async function counter(ok) {
  const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
  await s.call('POST', '/api/settings', { modes: { counter: true, buy: true } });
  const defs = [['หมูสับ', 89, 0, true], ['กุ้ง', 279.5, 259.25, true], ['สายไฟ', 12.75, 10.5, true], ['น้ำดื่ม', 10, 0, false], ['สมุด', 19.99, 17.5, false], ['ขนม', 33.33, 0, false], ['ทองแดง', 0.35, 0, true]];
  const items = [];
  for (const [name, price, price2, dec] of defs) items.push((await s.call('POST', '/api/menu/item', { name, price, price2: price2 || '', dec, cat: 1, station: 'hot', unit: dec ? 'กก.' : 'ชิ้น' })).json.item);
  const st = (await s.call('GET', '/api/state')).json;
  let seed = 4242; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const sales = []; let bad = 0, sample = null;
  for (let n = 0; n < 60; n++) {
    const P = posFns(st.menu.items, st.settings);
    const kind = n % 5 === 4 ? 'buy' : 'sell', level = rnd() < 0.4 ? 'wholesale' : 'retail', svc = rnd() < 0.5, vat = rnd() < 0.5;
    const lines = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => {
      const m = items[Math.floor(rnd() * items.length)];
      const qty = m.dec ? Math.max(0.001, Math.round(rnd() * 25000) / 1000) : 1 + Math.floor(rnd() * 30);
      return { id: m.id, qty, txt: String(qty), note: [] };
    });
    P.S.pos = { lines, level, kind, svc, vat, memo: '', reqId: null };
    const c = P.posTotals();
    const r = await s.call('POST', '/api/sale', { items: lines.map(l => ({ id: l.id, qty: l.qty })), kind, level, svc, vat, method: rnd() < 0.5 ? 'cash' : 'transfer', expectedSub: c.sub });
    const x = r.json && r.json.sale;
    if (r.status !== 200 || !x || x.sub !== c.sub || x.svc !== c.svc || x.vat !== c.vat || x.total !== c.total) { bad++; sample = sample || { status: r.status, server: x, page: c, lines }; }
    else sales.push(x);
  }
  ok(bad === 0, 'ขายหน้าร้าน 60 ตะกร้าสุ่ม (ทศนิยม ราคาส่ง รับซื้อ ค่าบริการ/VAT): หน้าพนักงาน = เซิร์ฟเวอร์ทุกช่อง', sample);
  const sum = a => r2(a.reduce((p, q) => p + q, 0));
  const sell = sales.filter(x => x.kind !== 'buy'), buy = sales.filter(x => x.kind === 'buy');
  const rep = (await s.call('GET', '/api/report')).json;
  ok(rep.count === sell.length && r2(rep.total) === sum(sell.map(x => x.total)) && rep.buy.count === buy.length && rep.buy.total === sum(buy.map(x => x.total)),
    'สรุปยอด: ยอดขาย = ผลรวมบิลขาย, รับซื้อ = ผลรวมบิลรับซื้อ (ไม่ปนกัน)', { sell: [rep.total, sum(sell.map(x => x.total))], buy: [rep.buy.total, sum(buy.map(x => x.total))] });
  ok(buy.every(x => x.svc === 0 && x.vat === 0), 'รับซื้อไม่มีค่าบริการ/VAT');
  const csv = (await s.call('GET', '/api/export.csv')).text.trim().split('\r\n').slice(1).map(l => l.slice(1, -1).split('","'));
  ok(csv.length === sales.length && csv.every(c => { const x = sales.find(y => y.no === +c[0]); return x && +c[4] === x.sub && +c[7] === x.total && c[9] === (x.kind === 'buy' ? 'รับซื้อ' : 'ขาย'); }), 'CSV ตรงกับทุกบิลทุกช่อง รวมประเภทขาย/รับซื้อ');
  const jl = salesLines(app.code);
  ok(jl.length === sales.length && sales.every(x => { const l = jl.find(y => y.no === x.no); return l && l.total === x.total && JSON.stringify(l.items) === JSON.stringify(x.items); }), 'sales/*.jsonl ตรงกับทุกบิล รวมจำนวนทศนิยม');
  await s.stop(); rmrf(app.base);
}
main().catch(e => { console.error(e); process.exit(2); });
