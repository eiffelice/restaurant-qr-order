'use strict';
/* Accessibility (WCAG 2.2 AA): สแกนอัตโนมัติด้วย axe-core ทุกแท็บ/หน้า ทั้ง light และ dark + ตรวจใช้คีย์บอร์ดได้
   node qa/a11y.js        ผลละเอียดใน qa/out/a11y.json */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { makeApp, start, sleep, PIN, checker, browserOpts } = require('./lib');
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

async function scan(page, label) {
  await page.addScriptTag({ content: AXE });
  const r = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations
    .map(v => ({ id: v.id, impact: v.impact, help: v.help, n: v.nodes.length, sample: v.nodes.slice(0, 3).map(x => x.target.join(' ') + ' :: ' + (x.failureSummary || '').split('\n').slice(1, 2).join('').trim()) })));
  return r.map(v => Object.assign({ where: label }, v));
}

async function main() {
  const ok = checker('a11y');
  const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
  const keys = (await s.call('GET', '/api/state')).json.keys;
  await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 1 }], memo: 'ไม่ใส่ผัก' }, { staff: false });
  await s.call('POST', '/api/order', { table: 2, key: keys[2], items: [{ id: 2, qty: 1 }] }, { staff: false });
  const b2 = (await s.call('GET', '/api/state')).json.bills[2].sub;
  await s.call('POST', '/api/pay', { table: 2, expectedSub: b2, method: 'cash' });
  await s.call('POST', '/api/call', { table: 1, key: keys[1], kind: 'bill' }, { staff: false });
  // หน้าลูกค้าแบบเต็ม: คำโปรย ลิงก์ติดตาม/แชร์ เมนูแนะนำ
  await s.call('POST', '/api/settings', { tagline: 'อาหารไทยรสชาติต้นตำรับ', address: '88/8 ถ.สุขุมวิท', phone: '02-123-4567', social: { facebook: 'facebook.com/x', instagram: '@x', line: '@x', tiktok: '@x' }, shareUrl: 'https://maps.app.goo.gl/x' });
  const m3 = (await s.call('GET', '/api/state')).json.menu.items.find(i => i.id === 3);
  await s.call('POST', '/api/menu/item', Object.assign({}, m3, { rec: true }));
  // สต็อก: วัตถุดิบหนึ่งตัวใกล้หมด + สูตร ให้ตาราง ป้าย และปุ่มขึ้นครบ
  const egg = (await s.call('POST', '/api/stock/item', { name: 'ไข่ไก่', unit: 'ฟอง', min: 10, cost: 4 })).json.item;
  await s.call('POST', '/api/stock/move', { id: egg.id, type: 'receive', qty: 5 });
  await s.call('POST', '/api/stock/recipe', { menu: 1, lines: [{ s: egg.id, q: 1 }] });
  const browser = await chromium.launch(browserOpts({ headless: true }));
  const all = [];
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ baseURL: s.B, colorScheme: scheme, viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage();
    await p.goto('/staff'); await p.waitForSelector('#pin');
    all.push(...await scan(p, 'staff login ' + scheme));
    await p.fill('#pin', PIN); await p.press('#pin', 'Enter'); await p.waitForSelector('#tabs .tab');
    for (const v of ['kitchen', 'tables', 'menu', 'stock', 'report', 'settings']) {
      await p.click('#tabs [data-v="' + v + '"]'); await sleep(400);
      if (v === 'tables') { await p.click('[data-a="sel"][data-id="1"]'); await sleep(200); }
      if (v === 'menu') { await p.click('[data-a="eopen"][data-id="1"]'); await sleep(200); }
      all.push(...await scan(p, 'staff ' + v + ' ' + scheme));
    }
    await s.call('POST', '/api/settings', { look: scheme });      // หน้าลูกค้าตั้งโทนเองได้: สแกนทั้งโทนสว่างและมืด
    const m = await browser.newContext({ baseURL: s.B, colorScheme: scheme, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const c = await m.newPage();
    await c.goto('/order?t=1&k=' + keys[1]); await c.waitForSelector('.item');
    all.push(...await scan(c, 'customer menu ' + scheme));
    await c.click('.item .open'); await c.waitForSelector('#detail:not([hidden])'); await sleep(400);   // รอ animation เปิดหน้าจบ (ระหว่างนั้นสีจาง axe วัดผิด)
    all.push(...await scan(c, 'customer detail ' + scheme));
    await c.click('[data-a="dtab"][data-t="notes"]'); await sleep(150);
    all.push(...await scan(c, 'customer detail notes ' + scheme));
    await c.click('[data-a="dback"]'); await sleep(150);
    await c.click('.item [data-a="inc"]'); await c.click('[data-a="open"]'); await c.click('[data-a="notes"]'); await sleep(200);
    all.push(...await scan(c, 'customer cart ' + scheme));
    await c.click('[data-a="close"]'); await sleep(200); await c.click('#bnav [data-v="shop"]'); await sleep(400);
    all.push(...await scan(c, 'customer shop ' + scheme));
    await c.click('[data-a="sclose"]'); await sleep(200); await c.fill('#q', 'ผัด'); await sleep(200);
    all.push(...await scan(c, 'customer search ' + scheme));
    await ctx.close(); await m.close();
  }
  // คีย์บอร์ด: เข้าสู่ระบบ สลับแท็บ และสั่งอาหารได้โดยไม่ใช้เมาส์ และเห็นกรอบโฟกัส
  const kctx = await browser.newContext({ baseURL: s.B }); const k = await kctx.newPage();
  await k.goto('/staff'); await k.waitForSelector('#pin'); await k.focus('#pin');
  await k.keyboard.type(PIN); await k.keyboard.press('Enter'); await k.waitForSelector('#tabs .tab');
  let reached = false, outline = '';
  for (let i = 0; i < 15 && !reached; i++) {
    await k.keyboard.press('Tab');
    const f = await k.evaluate(() => { const a = document.activeElement; return { v: a && a.dataset && a.dataset.v, o: a ? getComputedStyle(a).outlineStyle + ' ' + getComputedStyle(a).outlineWidth : '' }; });
    if (f.v === 'menu') { reached = true; outline = f.o; }
  }
  if (reached) await k.keyboard.press('Enter');
  const onMenu = reached && await k.evaluate(() => !document.querySelector('#v-menu').hidden);
  ok(onMenu, 'หน้าพนักงาน: Tab ไปที่แท็บเมนูแล้วกด Enter เปลี่ยนแท็บได้');
  ok(/solid|auto/.test(outline) && !/ 0px/.test(outline), 'หน้าพนักงาน: ปุ่มที่โฟกัสด้วยคีย์บอร์ดมีกรอบให้เห็น', outline);
  const cctx = await browser.newContext({ baseURL: s.B }); const c2 = await cctx.newPage();
  await c2.goto('/order?t=3&k=' + keys[3]); await c2.waitForSelector('.item');
  let added = false;
  let pressed = null;
  for (let i = 0; i < 25 && !added; i++) { await c2.keyboard.press('Tab'); pressed = await c2.evaluate(() => { const a = document.activeElement; return a && a.dataset.a === 'inc' ? a.dataset.id + '|' + (a.dataset.z || '') : null; }); if (pressed) { await c2.keyboard.press('Enter'); added = true; } }
  // กด + แล้วโฟกัสต้องอยู่ที่ปุ่มของจานเดิม (ไม่เด้งไปบนสุด) ปุ่มตะกร้าอยู่ก่อนรายการเมนูในลำดับ Tab จึงย้อน (Shift+Tab) ไปไม่กี่ครั้ง
  // ปุ่มแรกที่ Tab ถึงอาจอยู่บนการ์ดเมนูแนะนำ (.rcard) หรือการ์ดในหมวด (.item) ต้องกลับมาที่ปุ่มเดียวกัน (จานเดิม แถวเดิม)
  const stay = added && await c2.evaluate(p => { const a = document.activeElement; return !!a && (a.dataset.a === 'inc' || a.dataset.a === 'dec') && a.dataset.id + '|' + (a.dataset.z || '') === p; }, pressed);
  ok(stay, 'หน้าลูกค้า: กด + ด้วยคีย์บอร์ดแล้วโฟกัสยังอยู่ที่จานเดิม');
  for (let i = 0; i < 20 && added; i++) { await c2.keyboard.press('Shift+Tab'); if (await c2.evaluate(() => document.activeElement && document.activeElement.dataset.a === 'open')) { await c2.keyboard.press('Enter'); break; } }
  await sleep(200);
  for (let i = 0; i < 30; i++) { await c2.keyboard.press('Tab'); if (await c2.evaluate(() => document.activeElement && document.activeElement.dataset.a === 'send')) { await c2.keyboard.press('Enter'); break; } }
  await sleep(500);
  const t3 = (await s.call('GET', '/api/state')).json.tickets.filter(x => x.table === 3).length;
  ok(t3 === 1, 'หน้าลูกค้า: เพิ่มเมนู เปิดตะกร้า และสั่งอาหารด้วยคีย์บอร์ดอย่างเดียวได้', t3);
  // ตัวควบคุม: ใส่ช่องที่ไม่มี label และข้อความสีจาง ตัวสแกนต้องจับได้ (พิสูจน์ว่าผล 0 ไม่ใช่เพราะสแกนไม่ทำงาน)
  await c2.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<input id="bad-input"><p style="color:#ccc;background:#fff">จาง</p>'));
  const ctrl = (await scan(c2, 'control')).map(v => v.id);
  ok(ctrl.includes('label') && ctrl.includes('color-contrast'), 'ตัวควบคุม: axe-core จับ label และ contrast ที่ใส่ไว้ได้', ctrl);
  await browser.close(); await s.stop();

  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', 'a11y.json'), JSON.stringify(all, null, 1));
  const byRule = {};
  all.forEach(v => { const r = byRule[v.id] = byRule[v.id] || { impact: v.impact, help: v.help, where: [], nodes: 0, sample: v.sample }; r.where.push(v.where); r.nodes += v.n; });
  Object.keys(byRule).forEach(id => { const r = byRule[id]; console.log('  [' + r.impact + '] ' + id + ' — ' + r.help + ' (' + r.nodes + ' จุด ใน ' + r.where.length + ' หน้าจอ)\n      ' + r.sample.join('\n      ')); });
  ok(!all.some(v => v.impact === 'critical' || v.impact === 'serious'), 'axe-core: ไม่มีปัญหาระดับ critical/serious (WCAG 2.2 A/AA)', Object.keys(byRule));
  ok.done();
}
main().catch(e => { console.error(e); process.exit(2); });
