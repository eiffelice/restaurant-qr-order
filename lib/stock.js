'use strict';
/* สต็อกวัตถุดิบ (เจ้าของร้านตัดสินใจ 14 ต.ค. 2026: ตัดตอนส่งเข้าครัว ยกเลิกแล้วคืน)
   D.stock = { items: [{ id, name, unit, qty, min, cost (ทุนเฉลี่ยต่อหน่วย) }], nextId }
   D.recipes = { [menuId]: [{ s: stock id, q: ปริมาณต่อ 1 จาน }] }
   D.stockLog = รายการเคลื่อนไหวล่าสุด (รับเข้า เบิก ของเสีย ปรับยอด ขาย คืน) เก็บ LOG_KEEP รายการ ประวัติเต็มอยู่ใน audit
   รายการในตั๋วเก็บ use (สูตรตอนสั่ง) และ cost (ทุนต่อจานตอนสั่ง) แก้สูตรทีหลัง ยกเลิกแล้วคืนตามที่ตัดไปจริง
   ของไม่พอไม่บล็อกออเดอร์ (สต็อกติดลบได้ ให้คนตรวจ) ใกล้หมด = qty <= min */
const LOG_KEEP = 1000;
const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;

function find(D, id) { return D.stock.items.find(i => i.id === id) || null; }

// สูตรของเมนูตอนนี้ + ทุนต่อจาน (null = เมนูนี้ไม่มีสูตร)
function useOf(D, menuId) {
  const lines = D.recipes[menuId];
  if (!lines || !lines.length) return null;
  const use = lines.filter(l => find(D, l.s)).map(l => ({ s: l.s, q: l.q }));
  if (!use.length) return null;
  return { use, cost: r2(use.reduce((a, l) => a + l.q * find(D, l.s).cost, 0)) };
}

// ตัด (sign = -1) หรือคืน (+1) ตาม use × จำนวนจาน คืนรายการที่เปลี่ยนไว้ลง log
function apply(D, entries, sign) {
  const sum = new Map();
  entries.forEach(({ use, qty }) => (use || []).forEach(l => sum.set(l.s, (sum.get(l.s) || 0) + l.q * qty)));
  const lines = [];
  sum.forEach((q, s) => {
    const it = find(D, s); if (!it) return;     // วัตถุดิบถูกลบไปแล้ว ข้าม
    it.qty = r3(it.qty + sign * q);
    lines.push({ s, name: it.name, unit: it.unit, qty: r3(sign * q) });
  });
  return lines;
}

function log(D, e) {
  D.stockLog.push(Object.assign({ at: Date.now() }, e));
  if (D.stockLog.length > LOG_KEEP) D.stockLog = D.stockLog.slice(-LOG_KEEP);
}

function low(D) {
  return D.stock.items.filter(i => i.min > 0 && i.qty <= i.min).map(i => ({ id: i.id, name: i.name, unit: i.unit, qty: i.qty, min: i.min }));
}
function value(D) { return r2(D.stock.items.reduce((a, i) => a + Math.max(i.qty, 0) * i.cost, 0)); }

module.exports = { LOG_KEEP, r2, r3, find, useOf, apply, log, low, value };
