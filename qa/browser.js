'use strict';
/* ทดสอบหน้าเว็บด้วยเบราว์เซอร์จริง (Microsoft Edge ผ่าน playwright-core)
   ติดตั้งครั้งแรก:  cd qa && npm install
   รัน:            node qa/browser.js <เคส>     เคส: pay-race, reqid-reload, xss, day, customer, theme, acceptance, all
   QA_FROM=<โฟลเดอร์โค้ดเดิม> node qa/browser.js <เคส>   รันกับโค้ดก่อนแก้
   QA_BROWSER=chrome  ใช้ Google Chrome แทน Edge */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { chromium } = require('playwright-core');
const { makeApp, start, sleep, until, rmrf, salesLines, checker, PIN, fakePhoto } = require('./lib');

const CHANNEL = process.env.QA_BROWSER === 'chrome' ? 'chrome' : 'msedge';
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

async function launch() { return chromium.launch({ channel: CHANNEL, headless: process.env.QA_HEADED ? false : true }); }
// เก็บ error จาก console และ JS ทุกหน้า เพื่อสรุปท้ายเคส
// ไม่นับ 4xx ที่เบราว์เซอร์ log เองแต่หน้าเว็บจัดการแล้ว (401 ก่อนกรอก PIN, 409 ยอดเปลี่ยน) นับ 5xx และ JS error ทุกตัว
function watch(page, errors, label) {
  page.on('console', m => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errors.push(label + ' console: ' + m.text()); });
  page.on('pageerror', e => errors.push(label + ' pageerror: ' + e.message));
  page.on('dialog', d => { errors.push(label + ' dialog(' + d.type() + '): ' + d.message()); d.dismiss().catch(() => {}); });
}
async function staffPage(browser, s, opts, errors) {
  const ctx = await browser.newContext(Object.assign({ baseURL: s.B }, opts || {}));
  const page = await ctx.newPage(); watch(page, errors, 'staff');
  await page.goto('/staff');
  await page.fill('#pin', PIN); await page.press('#pin', 'Enter');
  await page.waitForSelector('#tabs .tab');
  return page;
}
async function customerPage(browser, s, t, key, errors, opts) {
  const ctx = await browser.newContext(Object.assign({ baseURL: s.B }, MOBILE, opts || {}));
  const page = await ctx.newPage(); watch(page, errors, 'customer' + t);
  await page.goto('/order?t=' + t + '&k=' + key);
  await page.waitForSelector('.item');
  return page;
}
const tab = (page, v) => page.click('#tabs [data-v="' + v + '"]');
const toastText = page => page.textContent('#toast');
// ไม่มีแถบเลื่อนแนวนอน: หาว่าอะไรล้นขอบจอ
async function overflow(page) {
  return page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth <= w + 1) return null;
    const bad = [];
    document.querySelectorAll('body *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width && r.right > w + 1 && !el.closest('[hidden]') && getComputedStyle(el).position !== 'fixed') bad.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + [...el.classList].join('.')) + ' right=' + Math.round(r.right));
    });
    return { scrollWidth: document.documentElement.scrollWidth, width: w, offenders: bad.slice(0, 6) };
  });
}

const cases = {
  /* ลูกค้าสั่งเพิ่มระหว่างพนักงานกดรับเงิน (กดครั้งแรกแล้ว ยังไม่กดยืนยัน) */
  async 'pay-race'(browser) {
    const ok = checker('pay-race'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 2 }] }, { staff: false });
    const page = await staffPage(browser, s, null, errors);
    await tab(page, 'tables'); await page.click('[data-a="sel"][data-id="1"]');
    const btn = page.locator('[data-a="pay"][data-m="cash"]');
    const shown = (await page.textContent('.receipt .grand .a')).trim();
    await btn.click();                                              // ครั้งแรก: ปุ่มเปลี่ยนเป็น "ยืนยัน ฿..."
    const armedText = (await btn.textContent()).trim();
    await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 2, qty: 1 }] }, { staff: false });   // ลูกค้าสั่งเพิ่ม
    await until(async () => (await page.textContent('.receipt .grand .a')).trim() !== shown, 5000, 'หน้าจอได้ยอดใหม่');
    const newArmed = (await btn.textContent()).trim();
    await btn.click();                                              // ครั้งที่สอง: พนักงานกดยืนยันตามที่ตั้งใจไว้
    await sleep(500);
    const st = (await s.call('GET', '/api/state')).json;
    const sales = salesLines(app.code);
    console.log('  ยอดที่พนักงานเห็นตอนกดครั้งแรก ' + armedText + ' · หลังลูกค้าสั่งเพิ่ม ปุ่มกลายเป็น ' + newArmed + ' · toast: ' + (await toastText(page)));
    ok(sales.length === 0, 'ปิดบิลไม่ได้ถ้ายอดเปลี่ยนหลังกดรับเงินครั้งแรก', sales.map(x => x.total));
    ok(st.bills[1], 'โต๊ะ 1 ยังเปิดอยู่ให้ตรวจยอดใหม่');
    ok(errors.length === 0, 'ไม่มี error ในหน้าเว็บ', errors);
    await page.context().close(); await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* เน็ตลูกค้าหลุดตอนกดสั่ง (คำสั่งถึงครัวแล้วแต่คำตอบไม่กลับ) แล้วกดใหม่ ทั้งแบบไม่รีเฟรชและรีเฟรชหน้า */
  async 'reqid-reload'(browser) {
    const ok = checker('reqid-reload'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const count = async t => (await s.call('GET', '/api/state')).json.tickets.filter(k => k.table === t).length;
    for (const [t, reload] of [[2, false], [3, true]]) {
      const page = await customerPage(browser, s, t, keys[t], []);
      await page.click('.item [data-a="inc"]');
      await page.click('[data-a="open"]');
      let dropped = 0;
      await page.route('**/api/order', async route => {
        if (dropped) return route.continue();
        dropped++; await route.fetch(); await route.abort('failed');   // ถึงเซิร์ฟเวอร์แล้ว แต่คำตอบหาย
      });
      await page.click('[data-a="send"]');
      await page.waitForSelector('#sheet .err');
      if (reload) { await page.reload(); await page.waitForSelector('.item'); await page.click('[data-a="open"]'); }
      await page.click('[data-a="send"]');
      await until(async () => /ส่งออเดอร์เข้าครัวแล้ว/.test(await toastText(page)) || await page.$('#sheet .err') !== null, 5000);
      await sleep(300);
      ok(await count(t) === 1, 'โต๊ะ ' + t + ': เน็ตหลุดตอนสั่ง แล้วกดใหม่' + (reload ? 'หลังรีเฟรชหน้า' : '') + ' ได้ออเดอร์เดียว', await count(t));
      await page.context().close();
    }
    await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* รับเงินสด: กรอกเงินที่รับมา เห็นเงินทอน เงินไม่พอกดยืนยันไม่ได้ ออเดอร์เข้าระหว่างพิมพ์ไม่ทำให้ช่องหาย
     และหน้าสรุปยอดแสดงประวัติการแก้ไข (ยกเลิกออเดอร์) */
  async cash(browser) {
    const ok = checker('cash'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 2 }] }, { staff: false });   // 120 + ค่าบริการ 12 = 132
    const v = await s.call('POST', '/api/order', { table: 2, key: keys[2], items: [{ id: 3, qty: 1 }] }, { staff: false });
    await s.call('POST', '/api/ticket/void', { id: v.json.tickets[0], reason: 'ทดสอบ' });
    const page = await staffPage(browser, s, MOBILE, errors);
    await tab(page, 'tables'); await page.click('[data-a="sel"][data-id="1"]');
    const pay = page.locator('[data-a="pay"][data-m="cash"]');
    await pay.click();
    await page.waitForSelector('#cash-in');
    ok(await page.evaluate(() => document.activeElement.id === 'cash-in'), 'กดรับเงินสดแล้วเคอร์เซอร์อยู่ที่ช่องรับเงินมา');
    await page.keyboard.type('10');
    await s.call('POST', '/api/order', { table: 5, key: keys[5], items: [{ id: 2, qty: 1 }] }, { staff: false });   // ออเดอร์เข้าระหว่างพิมพ์
    await sleep(600);
    await page.keyboard.type('0');
    ok(await page.inputValue('#cash-in') === '100', 'ออเดอร์เข้าระหว่างพิมพ์ ตัวเลขที่พิมพ์ไม่หาย', await page.inputValue('#cash-in'));
    ok(/ขาดอีก ฿32/.test(await page.textContent('#cash-change')) && await pay.isDisabled(), 'รับ 100 จากยอด 132: เตือนเงินไม่พอ และกดยืนยันไม่ได้', await page.textContent('#cash-change'));
    await page.click('[data-a="cashq"][data-v="500"]');
    ok(/ทอน ฿368/.test(await page.textContent('#cash-change')) && !(await pay.isDisabled()), 'กดปุ่มลัด 500: ทอน ฿368');
    await page.screenshot({ path: path.join(__dirname, 'out', 'cash-armed.png'), fullPage: true });
    await pay.click();
    await page.waitForSelector('[data-a="donesale"]');
    ok(/รับมา ฿500 · ทอน ฿368/.test(await page.textContent('#v-tables')) && /เงินทอน/.test(await page.textContent('.receipt')), 'หลังรับเงิน: แสดงรับมา/ทอน และใบเสร็จมีบรรทัดเงินทอน');
    await page.screenshot({ path: path.join(__dirname, 'out', 'cash-done.png'), fullPage: true });
    const paid = (await s.call('GET', '/api/audit')).json.events.find(e => e.action === 'bill.paid');
    ok(paid && paid.received === 500 && paid.change === 368, 'audit log บันทึกรับมา 500 ทอน 368', paid && [paid.received, paid.change]);
    // กด Enter ในช่องรับเงินเพื่อยืนยัน
    await page.click('[data-a="donesale"]'); await page.click('[data-a="sel"][data-id="5"]');
    await pay.click(); await page.waitForSelector('#cash-in');
    await page.keyboard.type('1000'); await page.keyboard.press('Enter');
    await page.waitForSelector('[data-a="donesale"]');
    ok(true, 'พิมพ์จำนวนแล้วกด Enter ยืนยันรับเงินได้');
    // ประวัติการแก้ไขในหน้าสรุปยอด
    await tab(page, 'report'); await page.waitForSelector('.audit-row');
    const rep = await page.textContent('#v-report');
    ok(/ประวัติการแก้ไขวันนี้/.test(rep) && /ยกเลิกออเดอร์ 1 ใบ/.test(rep) && /log ครบถ้วน/.test(rep), 'สรุปยอดแสดงประวัติการแก้ไข ยอดที่ถูกยกเลิก และสถานะ log', rep.match(/ยกเลิกออเดอร์[^฿]*฿[\d.,]+/));
    await page.screenshot({ path: path.join(__dirname, 'out', 'audit-report.png'), fullPage: true });
    const o = await overflow(page);
    ok(!o, 'หน้าสรุปยอดที่มีประวัติการแก้ไข 390px ไม่เลื่อนแนวนอน', o || undefined);
    ok(errors.length === 0, 'ไม่มี error ในหน้าเว็บ', errors);
    await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* พนักงานรายคน: เจ้าของเพิ่มพนักงานจากหน้าเว็บ แต่ละบทบาทเห็นเฉพาะส่วนของตัวเอง เปลี่ยนสิทธิ์แล้วเครื่องที่เข้าอยู่หลุด */
  async roles(browser) {
    const ok = checker('roles'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const owner = await staffPage(browser, s, null, errors);
    await tab(owner, 'settings'); await owner.waitForSelector('[data-a="stnew"]');
    for (const [name, role, pin] of [['สมใจ', 'cashier', '520011'], ['ช่างต้ม', 'kitchen', '520022']]) {
      await owner.click('[data-a="stnew"]');
      await owner.fill('#sf-name', name); await owner.selectOption('#sf-role', role); await owner.fill('#sf-pin', pin);
      await owner.click('[data-a="stsave"]');
      await owner.waitForFunction(n => document.querySelector('#stf').textContent.includes(n), name);
    }
    ok(/สมใจ[\s\S]*แคชเชียร์[\s\S]*ช่างต้ม[\s\S]*ครัว/.test(await owner.textContent('#stf')), 'เจ้าของเพิ่มแคชเชียร์และครัวจากหน้าตั้งค่า');
    await owner.click('#stf [data-a="stedit"][data-id="s1"]');
    await (await owner.$('#stf')).screenshot({ path: path.join(__dirname, 'out', 'staff-panel.png') });
    await owner.click('#stf [data-a="stcancel"]');
    const o1 = await overflow(await (async () => { const p = await staffPage(browser, s, MOBILE, errors); await tab(p, 'settings'); await p.waitForSelector('#stf .status-line'); return p; })());
    ok(!o1, 'ส่วนพนักงานที่ 390px ไม่เลื่อนแนวนอน', o1 || undefined);
    // เข้าสู่ระบบด้วย PIN ของแต่ละคน
    const login = async pin => {
      const ctx = await browser.newContext(Object.assign({ baseURL: s.B }, MOBILE)); const p = await ctx.newPage(); watch(p, errors, 'pin' + pin);
      await p.goto('/staff'); await p.fill('#pin', pin); await p.press('#pin', 'Enter'); await p.waitForSelector('#tabs .tab'); return p;
    };
    const kitchen = await login('520022');
    const kt = (await kitchen.$$eval('#tabs .tab', b => b.map(x => x.dataset.v))).join(',');
    ok(kt === 'kitchen,menu' && /ช่างต้ม \(ครัว\)/.test(await kitchen.textContent('#brand')), 'ครัวเห็นแค่แท็บครัวกับเมนูหมด และหัวจอบอกชื่อ', kt);
    await s.call('POST', '/api/order', { table: 3, key: keys[3], items: [{ id: 1, qty: 1 }] }, { staff: false });
    await kitchen.waitForSelector('#v-kitchen .card');
    ok(!(await kitchen.$('#v-kitchen [data-a="void"]')), 'ครัวไม่มีปุ่มยกเลิกออเดอร์');
    await kitchen.click('#v-kitchen [data-a="adv"]'); await sleep(300);
    await tab(kitchen, 'menu'); await kitchen.waitForSelector('[data-a="sold"]');
    ok(!(await kitchen.$('[data-a="eopen"]')) && !(await kitchen.$('[data-a="enew"]')) && !(await kitchen.$('#c-new')), 'ครัวแก้เมนูไม่ได้ เห็นแค่ปุ่มตั้งเมนูหมด');
    await kitchen.click('[data-a="sold"][data-id="2"]'); await sleep(300);
    ok((await s.call('GET', '/api/state')).json.settings.soldOut.includes(2), 'ครัวตั้งเมนูหมดได้');
    const cashier = await login('520011');
    ok((await cashier.$$eval('#tabs .tab', b => b.map(x => x.dataset.v))).join(',') === 'kitchen,tables,menu,report', 'แคชเชียร์เห็นครัว โต๊ะ เมนูหมด สรุปยอด (ไม่มีตั้งค่า)');
    await tab(cashier, 'tables'); await cashier.click('[data-a="sel"][data-id="3"]');
    await cashier.click('[data-a="pay"][data-m="cash"]'); await cashier.waitForSelector('#cash-in');
    await cashier.keyboard.type('100'); await cashier.keyboard.press('Enter'); await cashier.waitForSelector('[data-a="donesale"]');
    await tab(cashier, 'report'); await cashier.waitForSelector('.kpis');
    ok(!(await cashier.$('a[href^="/api/export.csv"]')) && !/ประวัติการแก้ไข/.test(await cashier.textContent('#v-report')), 'แคชเชียร์ดูสรุปยอดได้ แต่ไม่เห็น CSV และประวัติการแก้ไข');
    // เจ้าของเห็นว่าใครรับเงิน
    const paid = (await s.call('GET', '/api/audit')).json.events.find(e => e.action === 'bill.paid');
    ok(paid && paid.name === 'สมใจ' && paid.role === 'cashier', 'log บอกว่าสมใจ (แคชเชียร์) เป็นคนรับเงิน', paid && paid.name);
    // ปิดบัญชีครัวจากหน้าเว็บ: จอครัวหลุดไปหน้าใส่ PIN
    await owner.click('#stf [data-a="sttoggle"][data-id="s2"]');
    await s.call('POST', '/api/order', { table: 4, key: keys[4], items: [{ id: 1, qty: 1 }] }, { staff: false });   // ให้จอครัวโหลดข้อมูลใหม่
    await kitchen.waitForSelector('#login:not([hidden])', { timeout: 8000 }).catch(() => {});
    ok(await kitchen.isVisible('#login'), 'ปิดบัญชีแล้ว จอครัวที่เปิดอยู่หลุดไปหน้าใส่ PIN');
    ok(errors.filter(e => !/net::ERR/.test(e)).length === 0, 'ไม่มี error ในหน้าเว็บ', errors);
    await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* ระหว่างพนักงานเลือกไฟล์ (หน้าต่างเลือกไฟล์เปิดอยู่) มีออเดอร์เข้า หน้าจอ re-render: ไฟล์ที่เลือกต้องไม่หาย */
  async 'file-picker'(browser) {
    const ok = checker('file-picker'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const name = (await s.call('POST', '/api/backup', {})).json.backup.name;
    const bkFile = path.join(app.code, 'backups', name);
    const pngFile = path.join(app.base, 'p.png');
    fs.writeFileSync(pngFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    const page = await staffPage(browser, s, null, errors);
    let n = 0;
    const orderAndWait = async () => { n++; await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: 1, qty: 1 }], memo: 'ระหว่างเลือกไฟล์ ' + n }, { staff: false }); await sleep(800); };
    // ไฟล์สำรอง
    await tab(page, 'settings'); await page.waitForSelector('label[for="rs-file"]');
    const [fc1] = await Promise.all([page.waitForEvent('filechooser'), page.click('label[for="rs-file"]')]);
    await orderAndWait();
    await fc1.setFiles(bkFile); await sleep(800);
    ok(await page.$('[data-a="rsgo"]') !== null, 'เลือกไฟล์สำรองระหว่างมีออเดอร์เข้า: ไฟล์ไม่หาย ขึ้นปุ่มกู้คืน');
    // รูปเมนู
    await tab(page, 'menu'); await page.click('[data-a="eopen"][data-id="1"]'); await page.waitForSelector('label[for="e-file"]');
    const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.click('label[for="e-file"]')]);
    await orderAndWait();
    await fc2.setFiles(pngFile);
    // ย่อรูปในเบราว์เซอร์ใช้เวลาไม่แน่นอน รอผลแทนการรอเวลาตายตัว
    const shown = await page.waitForSelector('#editor img.thumb', { timeout: 5000 }).then(() => true, () => false);
    ok(shown, 'เลือกรูปเมนูระหว่างมีออเดอร์เข้า: รูปไม่หาย ขึ้นตัวอย่างรูป');
    ok(errors.length === 0, 'ไม่มี error ในหน้าเว็บ', errors);
    await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* ใส่ XSS ในทุกช่องที่ผู้ใช้กรอกได้ (และที่มาจากไฟล์สำรอง) แล้วเปิดทุกหน้า: ต้องไม่มี script ทำงาน */
  async xss(browser) {
    const ok = checker('xss'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    const P = [
      '<img src=x onerror="window.__xss=(window.__xss||0)+1">',
      '"><svg onload="window.__xss=(window.__xss||0)+1">',
      "'><script>window.__xss=(window.__xss||0)+1</script>",
      '</textarea><iframe srcdoc="<script>parent.__xss=1</script>">'
    ];
    const p = i => P[i % P.length];
    const r = [];
    r.push(await s.call('POST', '/api/settings', { shop: p(0), address: p(1), phone: p(2), footer: p(3), baseUrl: 'javascript:window.__xss=1' }));
    r.push(await s.call('POST', '/api/settings', { shop: p(0).slice(0, 60), address: p(1), phone: p(2).slice(0, 40), footer: p(3).slice(0, 80) }));
    const cat = (await s.call('POST', '/api/menu/category', { name: p(1).slice(0, 30) })).json.category;
    const it = (await s.call('POST', '/api/menu/item', { name: p(0).slice(0, 60), price: 45.5, cat: cat.id, station: 'hot', desc: p(2) })).json.item;
    r.push(await s.call('POST', '/api/menu/notes', { notes: [p(0).slice(0, 24), p(1).slice(0, 24), 'ไม่เผ็ด'] }));
    const notes = (await s.call('GET', '/api/menu')).json.notes;
    const keys = (await s.call('GET', '/api/state')).json.keys;
    r.push(await s.call('POST', '/api/order', { table: 1, key: keys[1], items: [{ id: it.id, qty: 1, note: notes }], memo: p(3) }, { staff: false }));
    // ค่าที่แก้ผ่านหน้าเว็บไม่ได้ (ชื่อจุดทำอาหาร ชื่อในบิลเก่า) มาจากไฟล์สำรองที่ถูกแก้
    const name = (await s.call('POST', '/api/backup', {})).json.backup.name;
    const b = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(app.code, 'backups', name))).toString('utf8'));
    b.data.menu.stations = { hot: p(0), bar: p(1) };
    b.data.sales = [{ no: 7, at: Date.now() - 60000, table: 2, sub: 10, svc: 0, vat: 0, total: 10, method: p(2), items: [{ name: p(3), qty: 1, price: p(0) }] }];
    b.data.nextBill = 8;
    const rr = await s.call('POST', '/api/backup/restore', Buffer.from(JSON.stringify(b)), { headers: { 'content-type': 'application/json' } });
    if (rr.headers['set-cookie']) s.cookie = rr.headers['set-cookie'][0].split(';')[0];
    ok(rr.status === 200, 'กู้คืนไฟล์ที่มี payload ได้', rr.json);
    ok(r[0].status === 400, 'baseUrl แบบ javascript: ถูกปฏิเสธ', r[0].json);

    const page = await staffPage(browser, s, null, errors);
    for (const v of ['kitchen', 'tables', 'menu', 'report', 'settings']) {
      await tab(page, v); await sleep(300);
      if (v === 'tables') { await page.click('[data-a="sel"][data-id="1"]'); await sleep(200); }
      if (v === 'menu') { await page.click('[data-a="eopen"][data-id="' + it.id + '"]'); await sleep(200); await page.click('[data-a="catedit"][data-id="' + cat.id + '"]'); await sleep(200); }
      if (v === 'report') { await page.waitForSelector('[data-a="viewsale"]'); await page.click('[data-a="viewsale"]'); await sleep(200); }
    }
    const staffX = await page.evaluate(() => window.__xss || 0);
    const shopShown = await page.evaluate(() => document.body.innerText.includes('<img src=x onerror='));
    const cust = await customerPage(browser, s, 1, keys[1], errors);
    await cust.click('[data-a="cat"][data-id="' + cat.id + '"]');
    await cust.click('[data-a="inc"][data-id="' + it.id + '"]');
    await cust.click('[data-a="open"]'); await cust.click('[data-a="notes"]'); await sleep(300);
    await cust.click('[data-a="close"]'); await cust.click('.item .open[data-id="' + it.id + '"]'); await cust.waitForSelector('#detail:not([hidden])');
    await cust.click('[data-a="dtab"][data-t="notes"]').catch(() => {}); await sleep(200);   // หน้ารายละเอียด: ชื่อ คำอธิบาย หมวด หมายเหตุ
    const custX = await cust.evaluate(() => window.__xss || 0);
    ok(staffX === 0, 'หน้าพนักงานทุกแท็บ: ไม่มี script จาก payload ทำงาน', staffX);
    ok(custX === 0, 'หน้าลูกค้า เมนู ตะกร้า หมายเหตุ หน้ารายละเอียด: ไม่มี script จาก payload ทำงาน', custX);
    ok(shopShown, 'payload แสดงเป็นข้อความธรรมดา');
    ok(!errors.some(e => /dialog/.test(e)), 'ไม่มี alert/dialog', errors.filter(e => /dialog/.test(e)));
    // ตัวควบคุม: ถ้าใส่ payload แบบไม่ escape ตัวตรวจต้องจับได้ (พิสูจน์ว่าเทสต์นี้ไม่ผ่านเพราะตรวจไม่เป็น)
    await page.evaluate(h => document.body.insertAdjacentHTML('beforeend', h), P[0]);
    await sleep(300);
    ok(await page.evaluate(() => window.__xss || 0) > 0, 'ตัวควบคุม: payload ที่ไม่ escape ถูกตรวจจับได้');
    await page.context().close(); await cust.context().close(); await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* จำลองหนึ่งวันทำงาน + 390 px + light/dark + รีสตาร์ทเซิร์ฟเวอร์ระหว่างเปิดหน้าเว็บ */
  async day(browser) {
    const ok = checker('day'); const errors = [];
    const app = makeApp(); let s = start(app.code); await s.ready; await s.login();
    const port = s.port;
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const staff = await staffPage(browser, s, null, errors);
    // ตั้งค่าร้าน
    await tab(staff, 'settings');
    await staff.fill('#s-shop', 'ร้านป้าแดง'); await staff.fill('#s-pp', '0812345678');
    await staff.click('[data-a="savesettings"]'); await sleep(400);
    ok((await s.call('GET', '/api/state')).json.settings.promptpay === '0812345678', 'บันทึกตั้งค่าร้านจากหน้าเว็บ');
    // มือถือ 3 เครื่องสั่งพร้อมกัน
    const custs = await Promise.all([1, 2, 3].map(t => customerPage(browser, s, t, keys[t], errors)));
    await Promise.all(custs.map(async (c, i) => {
      await c.click('.item [data-a="inc"]'); for (let n = 0; n <= i; n++) await c.click('.item [data-a="inc"]');
      await c.click('[data-a="open"]');
    }));
    await Promise.all(custs.map(c => c.click('[data-a="send"]')));
    await Promise.all(custs.map(c => c.waitForFunction(() => /ส่งออเดอร์เข้าครัวแล้ว/.test(document.querySelector('#toast').textContent))));
    await tab(staff, 'kitchen');
    await until(async () => (await staff.$$('#v-kitchen .card')).length >= 3, 5000, 'ครัวเห็นออเดอร์ 3 ใบ');
    ok(true, 'ครัวเห็นออเดอร์จากมือถือ 3 เครื่องที่สั่งพร้อมกัน');
    // ครัวกดสถานะ
    await staff.click('#v-kitchen .card [data-a="adv"][data-st="cooking"]'); await sleep(300);
    await staff.click('#v-kitchen .card [data-a="adv"][data-st="ready"]'); await sleep(300);
    await until(async () => /พร้อมเสิร์ฟ/.test(await custs.map(c => c).reduce(async (a, c) => (await a) + await c.textContent('#status'), Promise.resolve(''))), 8000, 'ลูกค้าเห็นพร้อมเสิร์ฟ');
    ok(true, 'ลูกค้าเห็นสถานะ "พร้อมเสิร์ฟ" เอง');
    // ตั้งเมนูหมด
    await tab(staff, 'menu');
    await staff.click('[data-a="sold"][data-id="2"]'); await sleep(300);
    await until(async () => (await custs[0].$$('.item.out')).length > 0, 8000, 'ลูกค้าเห็นเมนูหมด');
    ok(true, 'ลูกค้าเห็นเมนูหมดภายใน 5 วินาที');
    // แก้เมนูและอัปรูป
    const png = await staff.evaluate(() => { const c = document.createElement('canvas'); c.width = 1600; c.height = 1200; const x = c.getContext('2d'); x.fillStyle = '#c2410c'; x.fillRect(0, 0, 1600, 1200); x.fillStyle = '#fff'; x.fillRect(200, 200, 600, 400); return c.toDataURL('image/png').split(',')[1]; });
    const pngFile = path.join(app.base, 'dish.png'); fs.writeFileSync(pngFile, Buffer.from(png, 'base64'));
    await staff.click('[data-a="eopen"][data-id="1"]');
    await staff.fill('#e-price', '65.5');
    await staff.setInputFiles('#e-file', pngFile);
    await staff.waitForSelector('#editor img.thumb');
    await staff.click('[data-a="esave"]');
    await until(async () => { const m = (await s.call('GET', '/api/menu')).json.items.find(x => x.id === 1); return m.price === 65.5 && m.image; }, 5000, 'บันทึกเมนู');
    const m1 = (await s.call('GET', '/api/menu')).json.items.find(x => x.id === 1);
    const img = await s.call('GET', '/img/' + m1.image);
    ok(img.status === 200 && img.buf.length < 300 * 1024, 'อัปรูป 1600x1200 แล้วย่อเหลือ ' + Math.round(img.buf.length / 1024) + ' KB');
    await until(async () => (await custs[0].$$('.item img')).length > 0, 8000, 'ลูกค้าเห็นรูปใหม่');
    ok(true, 'ลูกค้าเห็นราคาใหม่และรูปใหม่โดยไม่ต้องรีเฟรช');
    // ปิดบิลเงินสดและโอน
    await tab(staff, 'tables');
    const bills = {};
    for (const [t, m] of [[1, 'cash'], [2, 'transfer']]) {
      await staff.click('[data-a="sel"][data-id="' + t + '"]');
      const shown = (await staff.textContent('.receipt .grand .a')).trim();
      await staff.click('[data-a="pay"][data-m="' + m + '"]'); await staff.click('[data-a="pay"][data-m="' + m + '"]');
      await staff.waitForSelector('[data-a="donesale"]');
      bills[t] = shown;
      await staff.click('[data-a="donesale"]');
    }
    const rep = (await s.call('GET', '/api/report')).json;
    ok(rep.count === 2 && rep.cash > 0 && rep.transfer > 0, 'ปิดบิลเงินสดและโอนจากหน้าเว็บ', { cash: rep.cash, transfer: rep.transfer, shown: bills });
    // สรุปยอดและ CSV
    await tab(staff, 'report'); await staff.waitForSelector('.kpis');
    const kpi = (await staff.textContent('.kpis .kpi .v')).replace(/[^\d.]/g, '');
    ok(+kpi === rep.total, 'ยอดในหน้าสรุปตรงกับ API', { page: kpi, api: rep.total });
    const [dl] = await Promise.all([staff.waitForEvent('download'), staff.click('a[href^="/api/export.csv"]')]);
    const csv = fs.readFileSync(await dl.path(), 'utf8');
    const csvTotal = csv.trim().split('\r\n').slice(1).reduce((a, l) => a + +l.split('","')[7], 0);
    ok(Math.abs(csvTotal - rep.total) < 0.001, 'ยอดใน CSV ตรงกับหน้าสรุป', { csv: csvTotal, report: rep.total });
    // สำรองแล้วกู้คืนจากหน้าเว็บ
    await tab(staff, 'settings'); await staff.waitForSelector('[data-a="bknow"]');
    await staff.click('[data-a="bknow"]'); await staff.waitForSelector('#bk table');
    const [bk] = await Promise.all([staff.waitForEvent('download'), staff.click('#bk a[href^="/api/backup/download"]')]);
    const bkFile = path.join(app.base, 'dl-backup.json.gz'); await bk.saveAs(bkFile);
    await s.call('POST', '/api/settings', { shop: 'เปลี่ยนชั่วคราว' });
    await staff.setInputFiles('#rs-file', bkFile);
    await staff.waitForSelector('[data-a="rsgo"]');
    await staff.click('[data-a="rsgo"]'); await staff.click('[data-a="rsgo"]');
    await until(async () => /กู้คืนข้อมูลแล้ว/.test(await toastText(staff)), 10000, 'กู้คืนจากหน้าเว็บ');
    if (staff) { const c = (await staff.context().cookies()).find(x => x.name === 'st'); if (c) s.cookie = 'st=' + c.value; }
    ok((await s.call('GET', '/api/state')).json.settings.shop === 'ร้านป้าแดง', 'สำรองแล้วกู้คืนจากหน้าเว็บ ข้อมูลกลับมา');

    // รีสตาร์ทเซิร์ฟเวอร์ระหว่างหน้าเว็บเปิดอยู่ แล้วมีออเดอร์เข้าทันทีหลังเปิดใหม่ (ก่อนหน้าเว็บต่อกลับ)
    await tab(staff, 'kitchen');
    await s.stop();
    await until(async () => /ขาดการเชื่อมต่อ/.test(await staff.textContent('#conn')), 8000, 'หน้าพนักงานรู้ว่าหลุด');
    s = start(app.code, { PORT: String(port) }); await s.ready; await s.login();
    await s.call('POST', '/api/order', { table: 5, key: keys[5], items: [{ id: 3, qty: 1 }], memo: 'หลังรีสตาร์ท' }, { staff: false });
    await until(async () => /หลังรีสตาร์ท/.test(await staff.textContent('#v-kitchen')), 15000, 'ครัวเห็นออเดอร์ที่เข้ามาช่วงต่อกลับ');
    ok(/ออนไลน์/.test(await staff.textContent('#conn')), 'หน้าพนักงานต่อกลับเองและไม่พลาดออเดอร์ที่เข้ามาช่วงนั้น');
    await custs[2].click('.item [data-a="inc"]'); await custs[2].click('[data-a="open"]'); await custs[2].click('[data-a="send"]');
    await custs[2].waitForFunction(() => /ส่งออเดอร์เข้าครัวแล้ว/.test(document.querySelector('#toast').textContent), null, { timeout: 8000 });
    ok(true, 'หน้าลูกค้าที่เปิดค้างไว้ สั่งต่อได้หลังรีสตาร์ท');

    // 390 px ทุกแท็บ ทั้ง light และ dark
    const mob = await staffPage(browser, s, MOBILE, errors);
    for (const scheme of ['light', 'dark']) {
      await mob.emulateMedia({ colorScheme: scheme });
      for (const v of ['kitchen', 'tables', 'menu', 'report', 'settings']) {
        await tab(mob, v); await sleep(250);
        if (v === 'tables') { await mob.click('[data-a="sel"][data-id="3"]'); await sleep(150); }
        if (v === 'menu') { await mob.click('[data-a="eopen"][data-id="1"]'); await sleep(150); }
        const o = await overflow(mob);
        ok(!o, 'staff 390px ' + scheme + ' แท็บ ' + v + ' ไม่เลื่อนแนวนอน', o || undefined);
        await mob.screenshot({ path: path.join(__dirname, 'out', 'staff-' + v + '-' + scheme + '.png'), fullPage: true });
      }
      await custs[0].emulateMedia({ colorScheme: scheme });
      await custs[0].click('[data-a="open"]').catch(() => {});
      const oc = await overflow(custs[0]);
      ok(!oc, 'customer 390px ' + scheme + ' ไม่เลื่อนแนวนอน', oc || undefined);
      await custs[0].screenshot({ path: path.join(__dirname, 'out', 'customer-' + scheme + '.png'), fullPage: true });
      const colors = await mob.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, ink: getComputedStyle(document.body).color }));
      ok(scheme === 'dark' ? /rgb\((1\d|2\d),/.test(colors.bg) : /rgb\(2[34]\d,/.test(colors.bg), 'staff ใช้สีพื้นของโหมด ' + scheme, colors);
    }
    const real = errors.filter(e => !/ERR_CONNECTION_REFUSED|Failed to load resource|net::ERR/.test(e));
    ok(real.length === 0, 'console ไม่มี error ทั้งวัน (ไม่นับการเชื่อมต่อไม่ได้ช่วงเซิร์ฟเวอร์ดับ)', real);
    await browser.close(); await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* หน้าลูกค้าแบบใหม่: หน้ารายละเอียด, หมายเหตุแยกแถว, ปุ่มย้อนกลับ, เมนูหมดระหว่างเปิด, ไม่มีรูป, XSS, ตะกร้าแบบเดิม, ธีม/โลโก้ */
  async customer(browser) {
    const ok = checker('customer'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    const img = async (id, hue) => s.call('POST', '/api/menu/image?id=' + id, await fakePhoto(browser, hue), { headers: { 'content-type': 'image/png' } });
    await img(1, 20); await img(3, 35);
    const X = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
    const xi = (await s.call('POST', '/api/menu/item', { name: 'ข้าว' + X, price: 49.5, cat: 1, station: 'hot', desc: 'อร่อย' + X })).json.item;
    const c = await customerPage(browser, s, 4, keys[4], errors);
    await c.evaluate(() => { window.__xss = 0; });

    // 0) ทุกหมวดเรียงต่อกัน: เห็นทุกจานโดยไม่ต้องเลือกหมวด (เดิมแสดงทีละหมวด ลูกค้าคิดว่าเมนูหาย)
    const vis = (await s.call('GET', '/api/menu', undefined, { staff: false })).json.items.length;
    ok(await c.$$eval('.item', x => x.length) === vis, 'เห็นทุกจานในหน้าเดียว ' + vis + ' จาน', await c.$$eval('.item', x => x.length));
    const lastCat = await c.$$eval('nav.cats .cat', x => +x[x.length - 1].dataset.id);
    await c.click('nav.cats .cat[data-id="' + lastCat + '"]'); await sleep(1300);
    const secTop = await c.$eval('#sec-' + lastCat, e => e.getBoundingClientRect().top);
    ok(secTop < 200 && await c.getAttribute('nav.cats .cat[data-id="' + lastCat + '"]', 'aria-pressed') === 'true', 'แตะปุ่มหมวดสุดท้าย: เลื่อนไปหมวดนั้น ปุ่มถูกเลือก', secTop);
    await c.evaluate(() => window.scrollTo(0, 0)); await sleep(500);
    ok(await c.$eval('nav.cats .cat', b => b.getAttribute('aria-pressed')) === 'true', 'เลื่อนกลับบนสุด: ปุ่มหมวดแรกถูกเลือกตามตำแหน่ง');

    // 1) แตะการ์ด → หน้ารายละเอียด → เลือกหมายเหตุ → เพิ่มจำนวน → ใส่ตะกร้า
    await c.click('.item .open[data-id="1"]');
    await c.waitForSelector('#detail:not([hidden])');
    ok(await c.evaluate(() => document.activeElement && document.activeElement.dataset.a === 'dback'), 'เปิดหน้ารายละเอียดแล้วโฟกัสอยู่ที่ปุ่มกลับ');
    await c.click('[data-a="dtab"][data-t="notes"]');
    await c.click('[data-a="dnote"][data-n="ไม่เผ็ด"]');
    await c.click('[data-a="dinc"]');
    ok(/฿120/.test(await c.textContent('[data-a="dadd"]')), 'ปุ่มใส่ตะกร้าแสดงราคารวมตามจำนวน (2 × 60)', await c.textContent('[data-a="dadd"]'));
    await c.click('[data-a="dadd"]');
    await c.waitForSelector('#detail', { state: 'hidden' });
    await sleep(200);
    ok(await c.evaluate(() => document.activeElement && document.activeElement.matches('.item .open[data-id="1"]')), 'ปิดแล้วโฟกัสกลับไปที่การ์ดเดิม');
    // ใส่ตะกร้าเร็ว (ปุ่ม + บนการ์ด) = แถวไม่มีหมายเหตุ แยกจากแถว "ไม่เผ็ด"
    await c.click('.item [data-a="inc"][data-id="1"]');
    const st0 = await c.evaluate(t => JSON.parse(localStorage.getItem('cart-' + t)), 4);
    ok(st0.lines.length === 2 && st0.lines.some(l => l.note.join() === 'ไม่เผ็ด' && l.qty === 2) && st0.lines.some(l => !l.note.length && l.qty === 1), 'เมนูเดียวกันหมายเหตุต่างกัน = คนละแถวในตะกร้า', st0.lines);
    // ใส่ "ไม่เผ็ด" อีก 1 จาน: รวมกับแถวเดิม ไม่เพิ่มแถว
    await c.click('.item .open[data-id="1"]'); await c.click('[data-a="dtab"][data-t="notes"]'); await c.click('[data-a="dnote"][data-n="ไม่เผ็ด"]'); await c.click('[data-a="dadd"]');
    const st1 = await c.evaluate(t => JSON.parse(localStorage.getItem('cart-' + t)), 4);
    ok(st1.lines.length === 2 && st1.lines.find(l => l.note.length).qty === 3, 'หมายเหตุเหมือนกัน = รวมแถวเดิม', st1.lines);

    // 1b) คีย์บอร์ด: เปิดหน้ารายละเอียดค้างไว้ข้ามรอบ poll (5 วินาที) โฟกัสต้องไม่หลุด
    await c.click('.item .open[data-id="2"]'); await c.click('[data-a="dtab"][data-t="notes"]');
    await c.focus('[data-a="dnote"][data-n="เผ็ดน้อย"]'); await sleep(6500);
    ok(await c.evaluate(() => document.activeElement && document.activeElement.dataset.n === 'เผ็ดน้อย'), 'เปิดหน้ารายละเอียดค้างข้ามรอบ poll: โฟกัสอยู่ที่ปุ่มเดิม');
    await c.keyboard.press('Enter');
    ok(await c.getAttribute('[data-a="dnote"][data-n="เผ็ดน้อย"]', 'aria-pressed') === 'true' && await c.evaluate(() => document.activeElement.dataset.n === 'เผ็ดน้อย'), 'กด Enter เลือกหมายเหตุ แล้วโฟกัสยังอยู่ที่ปุ่มเดิม');
    await c.keyboard.press('Escape');

    // 2) ปุ่มย้อนกลับของมือถือ (history.back) ปิดหน้ารายละเอียด/ตะกร้า ไม่ออกจากหน้าเว็บ
    const url0 = c.url();
    await c.click('.item .open[data-id="2"]'); await c.waitForSelector('#detail:not([hidden])');
    await c.goBack(); await c.waitForSelector('#detail', { state: 'hidden', timeout: 5000 }).catch(() => {});
    ok(await c.isHidden('#detail') && c.url() === url0, 'ปุ่ม back ปิดหน้ารายละเอียด ยังอยู่หน้าเดิม');
    await c.click('[data-a="open"]'); await c.waitForSelector('#sheetbg:not([hidden])');
    await c.goBack(); await c.waitForSelector('#sheetbg', { state: 'hidden', timeout: 5000 }).catch(() => {});
    ok(await c.isHidden('#sheetbg') && c.url() === url0, 'ปุ่ม back ปิดตะกร้า ยังอยู่หน้าเดิม');
    await c.click('.item .open[data-id="2"]'); await c.keyboard.press('Escape');
    ok(await c.isHidden('#detail'), 'Esc ปิดหน้ารายละเอียด');
    await c.goBack().catch(() => {}); await sleep(300);
    ok(c.url() !== url0 || await c.isVisible('.item'), 'ปิดด้วยปุ่มในหน้าแล้ว history ไม่ค้าง (back ครั้งเดียวออกจากหน้าได้ตามปกติ)');
    if (c.url() !== url0) { await c.goto(url0); await c.waitForSelector('.item'); }

    // 3) ส่งออเดอร์: ครัวได้หมายเหตุแยกจาน
    await c.click('[data-a="open"]'); await c.click('[data-a="send"]');
    await until(async () => (await s.call('GET', '/api/state')).json.tickets.length > 0, 8000);
    const items = (await s.call('GET', '/api/state')).json.tickets.flatMap(k => k.items).filter(i => i.id === 1);
    ok(items.length === 2 && items.some(i => i.qty === 3 && i.note.join() === 'ไม่เผ็ด') && items.some(i => i.qty === 1 && !i.note.length), 'ครัวได้ 2 แถว: ไม่เผ็ด ×3 และปกติ ×1', items);

    // 4) เมนูหมดระหว่างเปิดหน้ารายละเอียด: ปุ่มเปลี่ยนเป็น "หมดแล้ว" เอง
    await c.click('.item .open[data-id="3"]'); await c.waitForSelector('#detail:not([hidden])');
    await s.call('POST', '/api/soldout', { id: 3, soldOut: true });
    await c.waitForFunction(() => { const b = document.querySelector('[data-a="dadd"]'); return b && b.disabled && /หมดแล้ว/.test(b.textContent); }, null, { timeout: 9000 }).catch(() => {});
    const outBtn = await c.$eval('[data-a="dadd"]', b => ({ dis: b.disabled, t: b.textContent }));
    ok(outBtn.dis && /หมดแล้ว/.test(outBtn.t) && await c.$('.hero.out'), 'เมนูหมดระหว่างเปิด: ปุ่ม "หมดแล้ว" กดไม่ได้ รูปเป็นสีเทา', outBtn);
    await c.click('[data-a="dback"]');
    await s.call('POST', '/api/soldout', { id: 3, soldOut: false });

    // 5) เมนูไม่มีรูป: การ์ดและหน้ารายละเอียดใช้พื้นสีจาง + ชื่อหมวด
    // ชื่อหมวดอยู่ที่หัวข้อหมวดเหนือการ์ด (ไม่ซ้ำในทุกใบ) การ์ดใช้พื้นจางตามโทนหมวด + ไอคอนจาน
    const noimg = await c.$eval('.item .open[data-id="2"]', b => ({ ph: !!b.querySelector('.noimg[class*="tn"] svg'), head: b.closest('.sec').querySelector('h2').textContent }));
    ok(noimg.ph && noimg.head.trim().length > 0, 'การ์ดไม่มีรูป: พื้นจางตามหมวด + ไอคอน และมีชื่อหมวดเป็นหัวข้อ', noimg);
    await c.click('.item .open[data-id="2"]'); await c.waitForSelector('.hero.noimg');
    ok(true, 'หน้ารายละเอียดไม่มีรูป: hero แบบพื้นจาง');
    await c.click('[data-a="dback"]');

    // 6) XSS ในชื่อ/คำอธิบายเมนู: การ์ด หน้ารายละเอียด ตะกร้า
    await c.click('[data-a="cat"][data-id="1"]').catch(() => {});
    await c.click('.item .open[data-id="' + xi.id + '"]'); await c.waitForSelector('#detail:not([hidden])'); await sleep(300);
    const shown = await c.textContent('#detail');
    await c.click('[data-a="dadd"]'); await c.click('[data-a="open"]'); await sleep(300);
    const xs = await c.evaluate(() => window.__xss || 0);   // หน้าอาจถูกโหลดใหม่ในขั้นก่อน (ตัวแปรหาย = ไม่มีอะไรทำงาน)
    ok(xs === 0 && shown.includes('<img src=x'), 'ชื่อ/คำอธิบายที่เป็น HTML แสดงเป็นข้อความ ไม่ทำงาน', { xss: xs, shown: shown.slice(0, 120) });
    await c.click('[data-a="close"]');

    // 7) ตะกร้าแบบเดิมที่ลูกค้าเปิดค้างไว้ตอนอัปเดต: แปลงเอง และ reqId เดิมกันสั่งซ้ำ
    const rid = 'abcdef0123456789abcd';
    const first = await s.call('POST', '/api/order', { table: 5, key: keys[5], items: [{ id: 1, qty: 2, note: ['เผ็ดน้อย'] }], reqId: rid }, { staff: false });
    const c5 = await customerPage(browser, s, 5, keys[5], errors);
    await c5.evaluate(r => { localStorage.setItem('cart-5', JSON.stringify({ cart: { 1: { qty: 2, note: ['เผ็ดน้อย'], open: false } }, memo: '', reqId: r })); }, rid);
    await c5.reload(); await c5.waitForSelector('.item');
    ok(/2 รายการ/.test(await c5.textContent('[data-a="open"]')), 'ตะกร้ารูปแบบเดิมแปลงเป็นแบบใหม่ ของไม่หาย');
    await c5.click('[data-a="open"]'); await c5.click('[data-a="send"]'); await sleep(800);
    const t5 = (await s.call('GET', '/api/state')).json.tickets.filter(k => k.table === 5);
    ok(first.status === 200 && t5.length === 1, 'reqId เดิมจากตะกร้าแบบเดิม: ไม่เกิดออเดอร์ซ้ำ', t5.length);

    // 7b) ใส่จานเดียวกันหมายเหตุเดียวกันรวมเกิน 20: ส่วนเกินเป็นแถวใหม่ ไม่หายเงียบๆ / เกินลิมิตต่อครั้งเตือนก่อนกดสั่ง
    await c.evaluate(t => localStorage.removeItem('cart-' + t), 4); await c.reload(); await c.waitForSelector('.item');
    for (const n of [15, 10]) {
      await c.click('.item .open[data-id="2"]'); await c.waitForSelector('#detail:not([hidden])');
      for (let i = 1; i < n; i++) await c.click('[data-a="dinc"]');
      await c.click('[data-a="dadd"]'); await c.waitForSelector('#detail', { state: 'hidden' });
    }
    const st2 = await c.evaluate(t => JSON.parse(localStorage.getItem('cart-' + t)).lines, 4);
    ok(st2.reduce((n, l) => n + l.qty, 0) === 25 && st2.every(l => l.qty <= 20), 'ใส่ 15 + 10 จาน: ได้ครบ 25 (แถวละไม่เกิน 20)', st2);
    for (const n of [20, 20]) {
      await c.click('.item .open[data-id="4"]'); for (let i = 1; i < n; i++) await c.click('[data-a="dinc"]'); await c.click('[data-a="dadd"]'); await c.waitForSelector('#detail', { state: 'hidden' });
    }
    await c.click('[data-a="open"]'); await sleep(200);
    ok(/ไม่เกิน 60 จาน/.test(await c.textContent('#sheet')) && await c.$eval('[data-a="send"]', b => b.disabled), 'เกิน 60 จาน: เตือนในตะกร้าและปุ่มสั่งกดไม่ได้ (ไม่ต้องรอเซิร์ฟเวอร์ปฏิเสธ)');
    await c.click('[data-a="close"]');
    await c.evaluate(t => localStorage.removeItem('cart-' + t), 4); await c.reload(); await c.waitForSelector('.item');

    // 8) ร้านปิดรับ QR: ปุ่มหลักกดไม่ได้ พร้อมข้อความเดิม
    await s.call('POST', '/api/settings', { acceptOrders: false });
    await c.click('.item .open[data-id="1"]').catch(() => {});
    await c.waitForFunction(() => { const b = document.querySelector('[data-a="dadd"]'); return b && b.disabled; }, null, { timeout: 9000 }).catch(() => {});
    ok(await c.$eval('[data-a="dadd"]', b => b.disabled) && /ปิดรับออเดอร์/.test(await c.textContent('#detail')), 'ร้านปิดรับ: ปุ่มใส่ตะกร้ากดไม่ได้ มีข้อความบอก');
    await c.click('[data-a="dback"]');
    await s.call('POST', '/api/settings', { acceptOrders: true });

    // 9) ธีมร้าน: เปลี่ยนสีและโลโก้แล้วหน้าลูกค้าที่เปิดอยู่เปลี่ยนตามเอง
    await s.call('POST', '/api/settings', { accent: '#dc2626' });
    await s.call('POST', '/api/settings/logo', await fakePhoto(browser, 200, 256), { headers: { 'content-type': 'image/png' } });
    await c.waitForSelector('header .logo', { timeout: 9000 }).catch(() => {});
    await sleep(500);
    const capBg = await c.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
    ok(await c.$('header .logo') && capBg === '#dc2626', 'เปลี่ยนสี/โลโก้แล้วหน้าลูกค้าที่เปิดอยู่เปลี่ยนตาม', capBg);
    const lp = await (await browser.newContext({ baseURL: s.B })).newPage();
    await lp.goto('/staff'); await lp.waitForSelector('#login-logo:not([hidden])', { timeout: 5000 }).catch(() => {});
    ok(await lp.isVisible('#login-logo') && (await lp.textContent('#login-shop')).length > 0, 'หน้าใส่รหัสเข้าสู่ระบบแสดงโลโก้และชื่อร้าน');
    await lp.context().close();

    // 10) ไม่มีแถบเลื่อนแนวนอน 360 / 768 px ทุกจอ
    for (const w of [360, 768]) {
      const p = await customerPage(browser, s, 6, keys[6], errors, { viewport: { width: w, height: 800 } });
      const bad = [];
      const chk = async n => { const o = await overflow(p); if (o) bad.push(n + ' ' + JSON.stringify(o)); };
      await chk('เมนู'); await p.click('.item .open[data-id="1"]'); await chk('รายละเอียด');
      await p.click('[data-a="dtab"][data-t="notes"]'); await chk('หมายเหตุ'); await p.click('[data-a="dadd"]');
      await p.click('[data-a="open"]'); await p.click('[data-a="notes"]'); await chk('ตะกร้า');
      ok(!bad.length, w + 'px: เมนู รายละเอียด ตะกร้า ไม่เลื่อนแนวนอน', bad);
      await p.context().close();
    }
    const real = errors.filter(e => !/Failed to load resource|net::ERR/.test(e));
    ok(real.length === 0, 'console ไม่มี error', real);
    await c.context().close(); await c5.context().close(); await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* ธีมร้านจากหน้าตั้งค่า: เลือกสี บันทึก อัปโหลดโลโก้ สีขาวไม่รับ เครื่องอื่นเปลี่ยนสีแล้วหน้านี้ตาม */
  async theme(browser) {
    const ok = checker('theme'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    const p = await staffPage(browser, s, null, errors);
    await tab(p, 'settings'); await p.waitForSelector('[data-a="tpreset"]');
    const accent = () => p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
    const before = await accent();
    await p.click('[data-a="tpreset"][data-c="#dc2626"]'); await sleep(400);
    ok(await p.evaluate(() => getComputedStyle(document.querySelector('#t-prev')).getPropertyValue('--accent').trim()) === '#dc2626' && await accent() === before, 'เลือกสี: ตัวอย่างเปลี่ยน หน้าจริงยังไม่เปลี่ยนจนกดบันทึก');
    await p.click('[data-a="tsave"]');
    await p.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#dc2626', null, { timeout: 8000 }).catch(() => {});
    ok(await accent() === '#dc2626', 'บันทึกสี: หน้าพนักงานใช้สีใหม่ทันที');
    // สีเกือบขาว: ระบบไม่รับ ปุ่มบันทึกกดไม่ได้
    await p.evaluate(() => { const i = document.querySelector('#t-color'); i.value = '#fafafa'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await p.waitForFunction(() => /อ่อนเกินไป/.test(document.querySelector('#theme .err').textContent), null, { timeout: 5000 }).catch(() => {});
    ok(/อ่อนเกินไป/.test(await p.textContent('#theme .err')) && await p.$eval('[data-a="tsave"]', b => b.disabled), 'สีเกือบขาว: แจ้งเหตุผล กดบันทึกไม่ได้');
    await p.click('[data-a="treset"]'); await sleep(300);
    // โลโก้: เลือกไฟล์ (input อยู่นอกส่วนที่วาดใหม่)
    await p.setInputFiles('#logo-file', { name: 'logo.png', mimeType: 'image/png', buffer: await fakePhoto(browser, 140, 300) });
    await p.waitForSelector('#brand-logo:not([hidden])', { timeout: 8000 }).catch(() => {});
    ok(await p.isVisible('#brand-logo'), 'อัปโหลดโลโก้: แสดงที่แถบเมนูหน้าพนักงาน');
    ok(await p.$('.qcard .qlogo'), 'โลโก้อยู่บนแผ่น QR ติดโต๊ะ');
    const keys = (await s.call('GET', '/api/state')).json.keys;
    await s.call('POST', '/api/order', { table: 2, key: keys[2], items: [{ id: 1, qty: 1 }] }, { staff: false });
    await tab(p, 'tables'); await p.click('[data-a="sel"][data-id="2"]'); await sleep(300);
    ok(await p.$('.receipt .rlogo'), 'โลโก้อยู่บนใบแจ้งยอด/ใบเสร็จ');
    // อีกเครื่องเปลี่ยนสี: หน้าที่เปิดค้างไว้ตามเอง ไม่แสดงสีเก่าเหมือนยังไม่บันทึก
    await tab(p, 'settings'); await p.waitForSelector('[data-a="tpreset"]');
    await s.call('POST', '/api/settings', { accent: '#1d4ed8' });
    await p.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#1d4ed8', null, { timeout: 8000 }).catch(() => {});
    await sleep(500);
    ok(await accent() === '#1d4ed8' && await p.getAttribute('[data-a="tpreset"][data-c="#1d4ed8"]', 'aria-pressed') === 'true' && !(await p.$('[data-a="treset"]')), 'อีกเครื่องเปลี่ยนสี: หน้านี้ตาม และไม่ขึ้นว่ายังไม่บันทึก');
    // ตัวควบคุม: เปลี่ยนสีกลับเป็นตั้งต้น
    await s.call('POST', '/api/settings', { accent: '' });
    await p.waitForFunction(b => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === b, before, { timeout: 8000 }).catch(() => {});
    ok(await accent() === before, 'กลับเป็นสีตั้งต้น');
    const real = errors.filter(e => !/Failed to load resource|net::ERR/.test(e));
    ok(real.length === 0, 'console ไม่มี error', real);
    await p.context().close(); await s.stop(); rmrf(app.base);
    return ok.done();
  },

  /* เกณฑ์ตรวจรับ: มือถือจอแคบไม่เลื่อนแนวนอน, ราคาเปลี่ยนระหว่างสั่ง, เน็ตหลุด, ยกเลิกออเดอร์ต้องมีเหตุผลและ PIN เจ้าของ */
  async acceptance(browser) {
    const ok = checker('acceptance'); const errors = [];
    const app = makeApp(); const s = start(app.code); await s.ready; await s.login();
    const keys = (await s.call('GET', '/api/state')).json.keys;
    await s.call('POST', '/api/menu/item', { name: 'ข้าวผัดกระเพราหมูกรอบไข่ดาวไม่สุกพิเศษเพิ่มข้าวราดน้ำปลาพริกมะนาวกระเทียมเจียวหอมๆ', price: 89, cat: 1, station: 'hot', desc: 'เผ็ดมากกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกกก' });

    // 1) จอ 320 px (มือถือเล็กสุดที่ยังใช้กัน) ทุกขั้นตอนสั่งอาหาร
    const c = await customerPage(browser, s, 1, keys[1], errors, { viewport: { width: 320, height: 640 } });
    ok(!(await overflow(c)), '320px หน้าเมนู ไม่เลื่อนแนวนอน', await overflow(c) || undefined);
    await c.click('[data-a="inc"][data-id="1"]'); await c.click('[data-a="inc"][data-id="1"]');
    await c.click('[data-a="open"]'); await c.waitForSelector('#sheet [data-a="send"]');
    await c.click('[data-a="notes"]').catch(() => {});
    ok(!(await overflow(c)), '320px ตะกร้าและหมายเหตุ ไม่เลื่อนแนวนอน', await overflow(c) || undefined);

    // 2) ราคาเปลี่ยนตอนลูกค้าเปิดตะกร้าค้างไว้: ต้องเห็นยอดใหม่ก่อน ไม่ใช่เก็บเงินต่างจากที่เห็นเงียบๆ
    await s.call('POST', '/api/menu/item', { id: 1, name: 'ผัดกะเพราหมูสับ', price: 75, cat: 1, station: 'hot' });
    await c.click('[data-a="send"]');
    await c.waitForFunction(() => /ราคาเมนูเพิ่งเปลี่ยน/.test(document.querySelector('#sheet').textContent), null, { timeout: 8000 });
    await c.waitForFunction(() => /150/.test(document.querySelector('#sheet').textContent), null, { timeout: 8000 });
    ok((await s.call('GET', '/api/state')).json.tickets.length === 0, 'ราคาเปลี่ยน: ยังไม่มีออเดอร์เข้าครัว และตะกร้าแสดงยอดใหม่ 150');
    await c.click('[data-a="send"]');
    await until(async () => (await s.call('GET', '/api/state')).json.tickets.length === 1, 8000);
    const t1 = (await s.call('GET', '/api/state')).json.tickets;
    ok(t1.length === 1 && t1[0].items[0].price === 75, 'กดอีกครั้งหลังเห็นยอดใหม่ สั่งได้ 1 ใบ ราคา 75');

    // 3) เน็ตหลุด: มีป้ายบอก ไม่แสดงข้อมูลเก่าเหมือนเป็นปัจจุบัน และหายเองเมื่อกลับมา
    await c.context().setOffline(true);
    await c.waitForSelector('#offline:not([hidden])', { timeout: 15000 }).catch(() => {});
    ok(await c.isVisible('#offline'), 'เน็ตหลุด: มีป้ายเตือนบนหน้าลูกค้า');
    await c.context().setOffline(false);
    await c.waitForSelector('#offline', { state: 'hidden', timeout: 15000 }).catch(() => {});
    ok(!(await c.isVisible('#offline')), 'เน็ตกลับมา: ป้ายหายเอง');

    // 4) ยกเลิกออเดอร์จากแคชเชียร์
    await s.call('POST', '/api/staff', { name: 'สมใจ', role: 'cashier', pin: '520011' });
    const ctx = await browser.newContext({ baseURL: s.B });
    const p = await ctx.newPage(); watch(p, errors, 'cashier');
    await p.goto('/staff'); await p.fill('#pin', '520011'); await p.press('#pin', 'Enter'); await p.waitForSelector('#tabs .tab');
    const id = t1[0].id;
    await p.click('[data-a="void"][data-id="' + id + '"]');
    await p.waitForSelector('#void-dlg[open]');
    ok(await p.isHidden('#void-pin-row'), 'ออเดอร์ใหม่ ไม่ต้องใช้ PIN เจ้าของ');
    await p.click('#void-ok');
    ok(/เลือกเหตุผล/.test(await p.textContent('#void-err')), 'ไม่เลือกเหตุผล กดยืนยันไม่ได้');
    await p.check('#void-form input[value="อื่นๆ"]'); await p.fill('#void-note', 'ลูกค้าย้ายโต๊ะ');
    await s.call('POST', '/api/order', { table: 2, key: keys[2], items: [{ id: 2, qty: 1 }] }, { staff: false });   // มีออเดอร์ใหม่เข้าระหว่างพิมพ์
    await sleep(800);
    ok(await p.inputValue('#void-note') === 'ลูกค้าย้ายโต๊ะ' && await p.isChecked('#void-form input[value="อื่นๆ"]'), 'ออเดอร์ใหม่เข้าระหว่างพิมพ์ เหตุผลที่พิมพ์ไม่หาย');
    // ระหว่างนั้นครัวเริ่มทำ: เซิร์ฟเวอร์ขอ PIN เจ้าของ หน้าจอเปิดช่อง PIN ให้เอง
    await s.call('POST', '/api/ticket', { id, from: 'new', status: 'cooking' });
    await p.click('#void-ok');
    await p.waitForSelector('#void-pin-row:not([hidden])', { timeout: 5000 }).catch(() => {});
    ok(await p.isVisible('#void-pin-row'), 'ครัวเริ่มทำระหว่างเปิดหน้าต่าง: ขอ PIN เจ้าของ');
    await p.fill('#void-pin', '520011'); await p.click('#void-ok');
    await p.waitForFunction(() => /ไม่ถูกต้อง/.test(document.querySelector('#void-err').textContent), null, { timeout: 5000 }).catch(() => {});
    ok(/ไม่ถูกต้อง/.test(await p.textContent('#void-err')), 'PIN ผิด: แจ้งในหน้าต่าง ไม่ปิดเอง');
    await p.fill('#void-pin', PIN); await p.press('#void-pin', 'Enter');
    await p.waitForSelector('#void-dlg', { state: 'hidden', timeout: 5000 }).catch(() => {});
    const left = (await s.call('GET', '/api/state')).json.tickets.map(t => t.id);
    ok(!left.includes(id), 'PIN เจ้าของถูก: ยกเลิกสำเร็จ หน้าต่างปิด');
    // คีย์บอร์ด: Esc ปิดหน้าต่าง โฟกัสอยู่ในหน้าต่างตอนเปิด
    const id2 = left[0];
    await p.click('[data-a="void"][data-id="' + id2 + '"]'); await p.waitForSelector('#void-dlg[open]');
    ok(await p.evaluate(() => !!document.activeElement.closest('#void-dlg')), 'เปิดหน้าต่างแล้วโฟกัสอยู่ในหน้าต่าง');
    await p.keyboard.press('Escape');
    ok(await p.isHidden('#void-dlg'), 'กด Esc ปิดหน้าต่าง ไม่ยกเลิกออเดอร์');
    ok((await s.call('GET', '/api/state')).json.tickets.some(t => t.id === id2), 'Esc แล้วออเดอร์ยังอยู่');
    const real = errors.filter(e => !/ERR_INTERNET_DISCONNECTED|Failed to load resource|net::ERR/.test(e));
    ok(real.length === 0, 'console ไม่มี error', real);
    await browser.close(); await s.stop(); rmrf(app.base);
    return ok.done();
  }
};

async function main() {
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  const which = process.argv[2] || 'all';
  if (which === 'all') {
    // แยก process ต่อเคส พร้อม timeout เคสใดค้างจะไม่ลากเคสอื่น
    let bad = 0;
    const cp = require('node:child_process');
    for (const n of Object.keys(cases)) {
      const code = await new Promise(resolve => {
        const c = cp.spawn(process.execPath, [__filename, n], { stdio: 'inherit' });
        // หมดเวลา: ปิดทั้งต้นไม้ (เซิร์ฟเวอร์และ Edge ที่เคสเปิดไว้) ไม่ใช่แค่ process ลูก
        const t = setTimeout(() => { console.log('  ✖ ' + n + ': เกิน 5 นาที'); if (process.platform === 'win32') cp.spawnSync('taskkill', ['/pid', String(c.pid), '/t', '/f']); else c.kill('SIGKILL'); }, 300000);
        c.on('exit', s => { clearTimeout(t); resolve(s); });
      });
      if (code !== 0) bad++;
    }
    process.exitCode = bad ? 1 : 0;
    return;
  }
  const names = [which];
  let failed = 0;
  for (const n of names) {
    if (!cases[n]) { console.error('ไม่รู้จักเคส ' + n); process.exit(2); }
    console.log('\n=== ' + n + (process.env.QA_FROM ? '  (โค้ดจาก ' + process.env.QA_FROM + ')' : '') + ' ===');
    const browser = await launch();
    try { if (!(await cases[n](browser))) failed++; }
    catch (e) { failed++; console.log('  ✖ ' + e.message.split('\n')[0] + '  @' + ((e.stack || '').split('\n').find(l => l.includes('browser.js')) || '').trim()); }
    finally { await browser.close().catch(() => {}); }
  }
  process.exitCode = failed ? 1 : 0;
}
main().catch(e => { console.error(e); process.exit(2); });
