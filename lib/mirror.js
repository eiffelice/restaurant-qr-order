'use strict';
/* สำเนาข้อมูลไป MySQL / MariaDB ทางเดียว ไว้ดูรายงานด้วย Excel, Power BI, Looker Studio หรือ SQL (ตั้ง MYSQL_URL ดู lib/config.js)
   ไฟล์ในเครื่อง (data.json, sales/, journal/) ยังเป็นข้อมูลจริงเสมอ MySQL เป็นแค่สำเนา:
   - MySQL ล่ม เน็ตหลุด รหัสผิด ร้านขายต่อได้ตามปกติ ป้ายเตือนขึ้นที่หน้าเจ้าของ กลับมาแล้วส่งที่ค้างให้เอง
   - ยอดขาย ประวัติสต็อก เอกสาร ส่งจากไฟล์ใน sales/ journal/ (ส่งเฉพาะที่ลงไฟล์แล้ว) สินค้าและรายชื่อลูกค้าส่งจากข้อมูลปัจจุบัน
   - ตำแหน่งที่ส่งถึงแล้วของแต่ละไฟล์ (ov_meta) บันทึกใน transaction เดียวกับข้อมูล ไฟดับหรือเน็ตหลุดกลางทางจึงไม่ซ้ำไม่ตกหล่น
     และจำท้ายส่วนที่ส่งแล้ว (tail) ไว้ด้วย ไฟล์ถูกเขียนใหม่ (กู้คืนข้อมูล) = ส่งไฟล์นั้นใหม่ทั้งไฟล์ แทนที่ของเดิมใน MySQL
   - ทุกอย่าง async ไม่ทำให้หน้าร้านค้าง (กฎข้อ 17) และหยุดรอบนั้นทันทีเมื่อเริ่มกู้คืนข้อมูล
   - หลายสาขาใช้ฐานข้อมูลเดียวกันได้ (MYSQL_SHOP) ทุกตารางมีคอลัมน์ shop ถ้าสาขาเดียวกันถูกส่งจากสองเครื่อง (instance ไม่ตรง)
     หยุดส่งและแจ้งเจ้าของ ไม่เขียนทับกันเงียบๆ
   - ไม่ส่ง PIN, รหัส QR, secret, cookie ไป MySQL และไม่บันทึกรหัสผ่าน MySQL ลง log หรือหน้าจอ */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const C = require('./config');
const U = require('./util');
const store = require('./store');
const log = require('./log');
const mysql = require('./mysql');
const { state: st } = store;
const { isNum, isInt, isStr } = U;

const SCHEMA = 1;
const INSTANCE_FILE = path.join(C.DATA_DIR, 'mysql-sync.json');   // รหัสเครื่องนี้ (ไม่อยู่ในไฟล์สำรอง ย้ายเครื่อง = ต้องกดใช้ฐานข้อมูลกับเครื่องใหม่)
const WINDOW = 8 * 1024 * 1024;   // อ่านไฟล์ทีละไม่เกินเท่านี้ (หนึ่ง transaction)
const STMT_MAX = 512 * 1024;      // ความยาว SQL ต่อคำสั่ง (ต่ำกว่า max_allowed_packet ของทุกรุ่นมาก)
const TAIL = 256;

/* ---------- ตาราง (ชื่อขึ้นต้น ov_ ทุกตารางมี shop) ---------- */
const CS = ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
const MONEY = 'DECIMAL(15,2) NOT NULL DEFAULT 0', QTY = 'DECIMAL(15,3) NOT NULL DEFAULT 0', SHOP = 'shop VARCHAR(20) NOT NULL';
const TXT = n => 'VARCHAR(' + n + ") NOT NULL DEFAULT ''";
const TABLES = [
  ['ov_meta', 'CREATE TABLE ov_meta (' + SHOP + ', k VARCHAR(100) NOT NULL, v TEXT NOT NULL, PRIMARY KEY (shop, k))'],
  ['ov_shops', 'CREATE TABLE ov_shops (' + SHOP + ', instance CHAR(16) NOT NULL, name ' + TXT(60) + ', biz ' + TXT(20) + ', tax_id ' + TXT(13) +
    ', branch ' + TXT(30) + ', schema_ver INT NOT NULL DEFAULT 1, synced_at DATETIME NULL, PRIMARY KEY (shop))'],
  ['ov_sales', 'CREATE TABLE ov_sales (' + SHOP + ', `no` INT UNSIGNED NOT NULL, bill_no VARCHAR(20) NOT NULL, sold_at DATETIME NOT NULL, at_ms BIGINT NOT NULL, day DATE NOT NULL, ' +
    'kind VARCHAR(8) NOT NULL, table_no INT NOT NULL DEFAULT 0, queue_no INT NULL, method VARCHAR(10) NOT NULL, price_level ' + TXT(12) +
    ', sub ' + MONEY + ', svc ' + MONEY + ', vat ' + MONEY + ', disc ' + MONEY + ', total ' + MONEY + ', memo ' + TXT(100) + ', doc_no ' + TXT(20) +
    ', item_count INT NOT NULL DEFAULT 0, src VARCHAR(40) NOT NULL, PRIMARY KEY (shop, `no`), KEY k_day (shop, day), KEY k_src (shop, src))'],
  ['ov_sale_items', 'CREATE TABLE ov_sale_items (' + SHOP + ', sale_no INT UNSIGNED NOT NULL, line_no SMALLINT UNSIGNED NOT NULL, day DATE NOT NULL, kind VARCHAR(8) NOT NULL, ' +
    'name ' + TXT(120) + ', qty ' + QTY + ', unit ' + TXT(12) + ', price ' + MONEY + ', amount ' + MONEY + ', PRIMARY KEY (shop, sale_no, line_no), KEY k_day (shop, day))'],
  ['ov_stock_moves', 'CREATE TABLE ov_stock_moves (' + SHOP + ', id VARCHAR(32) NOT NULL, moved_at DATETIME NOT NULL, at_ms BIGINT NOT NULL, day DATE NOT NULL, product_id INT NULL, ' +
    'name ' + TXT(120) + ', unit ' + TXT(12) + ', qty ' + QTY + ', bal ' + QTY + ', kind ' + TXT(12) + ', ref ' + TXT(24) + ', note ' + TXT(120) +
    ', src VARCHAR(40) NOT NULL, PRIMARY KEY (shop, id), KEY k_item (shop, product_id, at_ms), KEY k_src (shop, src))'],
  ['ov_docs', 'CREATE TABLE ov_docs (' + SHOP + ', `no` VARCHAR(20) NOT NULL, type VARCHAR(4) NOT NULL, status VARCHAR(10) NOT NULL, rev INT NOT NULL, doc_date DATE NOT NULL, due_date DATE NULL, ' +
    'party_name ' + TXT(100) + ', party_tax_id ' + TXT(13) + ', party_branch ' + TXT(30) + ', party_address ' + TXT(200) + ', party_phone ' + TXT(40) + ', contact_id ' + TXT(10) +
    ', vat_on TINYINT NOT NULL DEFAULT 0, discount ' + MONEY + ', sub ' + MONEY + ', disc ' + MONEY + ', net ' + MONEY + ', vat_amt ' + MONEY + ', total ' + MONEY +
    ', note ' + TXT(300) + ', ref ' + TXT(20) + ', issuer ' + TXT(30) + ', created_at DATETIME NULL, updated_at DATETIME NULL, paid_at DATETIME NULL, method ' + TXT(10) +
    ', receipt_no INT UNSIGNED NULL, received_at DATETIME NULL, cancel_reason ' + TXT(80) + ', PRIMARY KEY (shop, `no`), KEY k_type (shop, type, status), KEY k_date (shop, doc_date))'],
  ['ov_doc_lines', 'CREATE TABLE ov_doc_lines (' + SHOP + ', doc_no VARCHAR(20) NOT NULL, line_no SMALLINT UNSIGNED NOT NULL, product_id INT NULL, name ' + TXT(120) +
    ', qty ' + QTY + ', unit ' + TXT(12) + ', price ' + MONEY + ', amount ' + MONEY + ', got DECIMAL(15,3) NULL, PRIMARY KEY (shop, doc_no, line_no))'],
  ['ov_products', 'CREATE TABLE ov_products (' + SHOP + ', id INT NOT NULL, sku ' + TXT(32) + ', name ' + TXT(120) + ', category ' + TXT(60) + ', unit ' + TXT(12) +
    ', price ' + MONEY + ', price2 ' + MONEY + ', cost DECIMAL(15,4) NOT NULL DEFAULT 0, track TINYINT NOT NULL DEFAULT 0, stock ' + QTY + ', min_qty ' + QTY +
    ', hidden TINYINT NOT NULL DEFAULT 0, station ' + TXT(30) + ', deleted TINYINT NOT NULL DEFAULT 0, hash CHAR(40) NOT NULL, updated_at DATETIME NOT NULL, PRIMARY KEY (shop, id))'],
  ['ov_contacts', 'CREATE TABLE ov_contacts (' + SHOP + ', id VARCHAR(10) NOT NULL, name ' + TXT(100) + ', kind ' + TXT(10) + ', tax_id ' + TXT(13) + ', branch ' + TXT(30) +
    ', address ' + TXT(200) + ', phone ' + TXT(40) + ', email ' + TXT(80) + ', note ' + TXT(120) + ', deleted TINYINT NOT NULL DEFAULT 0, hash CHAR(40) NOT NULL, updated_at DATETIME NOT NULL, PRIMARY KEY (shop, id))']
].map(([n, ddl]) => [n, ddl + CS]);
const COLS = {
  ov_sales: ['shop', 'no', 'bill_no', 'sold_at', 'at_ms', 'day', 'kind', 'table_no', 'queue_no', 'method', 'price_level', 'sub', 'svc', 'vat', 'disc', 'total', 'memo', 'doc_no', 'item_count', 'src'],
  ov_sale_items: ['shop', 'sale_no', 'line_no', 'day', 'kind', 'name', 'qty', 'unit', 'price', 'amount'],
  ov_stock_moves: ['shop', 'id', 'moved_at', 'at_ms', 'day', 'product_id', 'name', 'unit', 'qty', 'bal', 'kind', 'ref', 'note', 'src'],
  ov_docs: ['shop', 'no', 'type', 'status', 'rev', 'doc_date', 'due_date', 'party_name', 'party_tax_id', 'party_branch', 'party_address', 'party_phone', 'contact_id',
    'vat_on', 'discount', 'sub', 'disc', 'net', 'vat_amt', 'total', 'note', 'ref', 'issuer', 'created_at', 'updated_at', 'paid_at', 'method', 'receipt_no', 'received_at', 'cancel_reason'],
  ov_doc_lines: ['shop', 'doc_no', 'line_no', 'product_id', 'name', 'qty', 'unit', 'price', 'amount', 'got'],
  ov_products: ['shop', 'id', 'sku', 'name', 'category', 'unit', 'price', 'price2', 'cost', 'track', 'stock', 'min_qty', 'hidden', 'station', 'deleted', 'hash', 'updated_at'],
  ov_contacts: ['shop', 'id', 'name', 'kind', 'tax_id', 'branch', 'address', 'phone', 'email', 'note', 'deleted', 'hash', 'updated_at']
};

/* ---------- แปลงค่าให้ใส่คอลัมน์ได้เสมอ (ค่าแปลกจากไฟล์เก่าต้องไม่ทำให้ส่งไม่ได้ทั้งรอบ) ---------- */
const L = mysql.lit;
const roundTo = (v, d) => { if (!isNum(v)) return 0; const f = Math.pow(10, d), r = Math.round(v * f) / f; return Math.abs(r) < 1e12 ? r : 0; };
const m2 = v => roundTo(v, 2), q3 = v => roundTo(v, 3);
const txt = (v, n) => isStr(v) ? v.slice(0, n) : '';
const int = v => isInt(v) && Math.abs(v) < 2147483647 ? v : null;
function dt(ms) { if (!isNum(ms)) return null; const d = new Date(ms); return isNaN(d) ? null : d.getFullYear() + '-' + U.pad(d.getMonth() + 1) + '-' + U.pad(d.getDate()) + ' ' + U.pad(d.getHours()) + ':' + U.pad(d.getMinutes()) + ':' + U.pad(d.getSeconds()); }
const day = ms => { const s = dt(ms); return s && s.slice(0, 10); };
const sha = b => crypto.createHash('sha1').update(b).digest('hex');
const billNo = (no, at) => 'R' + U.ymd(at) + '-' + String(no).padStart(4, '0');   // แบบเดียวกับ billNo() ใน routes.js และหน้าพนักงาน

// ยอดขายหนึ่งบรรทัดใน sales/ → แถวบิล + แถวรายการ (ไม่ใช่บิล = null)
function saleRows(shop, s, src) {
  if (!s || typeof s !== 'object' || !isInt(s.no) || s.no < 1 || !isNum(s.at) || !day(s.at)) return null;
  const kind = s.kind === 'buy' ? 'buy' : 'sell', d = day(s.at), items = (Array.isArray(s.items) ? s.items : []).filter(i => i && typeof i === 'object').slice(0, 2000);
  return {
    sale: [shop, s.no, billNo(s.no, s.at), dt(s.at), Math.round(s.at), d, kind, int(s.table) || 0, int(s.q), s.method === 'transfer' ? 'transfer' : 'cash',
      s.level === 'wholesale' ? 'wholesale' : '', m2(s.sub), m2(s.svc), m2(s.vat), m2(s.disc), m2(s.total), txt(s.memo, 100), txt(s.doc, 20), items.length, src],
    items: items.map((i, n) => [shop, s.no, n + 1, d, kind, txt(i.name, 120), q3(i.qty), txt(i.unit, 12), m2(i.price), m2(m2(i.qty * i.price))])
  };
}
function moveRow(shop, v, src) {
  if (!v || !isStr(v.id) || !v.id || v.id.length > 32 || !isNum(v.at) || !day(v.at)) return null;
  return [shop, v.id, dt(v.at), Math.round(v.at), day(v.at), int(v.item), txt(v.name, 120), txt(v.unit, 12), q3(v.qty), q3(v.bal), txt(v.kind, 12), txt(v.ref, 24), txt(v.note, 120), src];
}
function docRows(shop, d) {
  const p = d.party;
  return {
    doc: [shop, d.no, d.type, d.status, d.rev, day(d.date), isNum(d.due) ? day(d.due) : null, p.name, p.taxId, p.branch, p.address, p.phone, p.contactId || '',
      d.vat ? 1 : 0, m2(d.discount), m2(d.sub), m2(d.disc), m2(d.net), m2(d.vatAmt), m2(d.total), d.note, d.ref, d.issuer ? d.issuer.name : '',
      dt(d.createdAt), dt(d.updatedAt), dt(d.paidAt), d.method || '', isInt(d.receipt) && d.receipt > 0 ? d.receipt : null, dt(d.receivedAt), txt(d.cancelReason, 80)],
    lines: d.lines.slice(0, 2000).map((l, n) => [shop, d.no, n + 1, int(l.id), txt(l.name, 120), q3(l.qty), txt(l.unit, 12), m2(l.price), m2(m2(l.qty * l.price)), isNum(l.got) ? q3(l.got) : null])
  };
}
// แถวที่ไม่มี hash/updated_at (คิด hash จากแถวนี้ ไม่เปลี่ยน = ไม่ส่ง)
function productRows(shop) {
  const D = st.D, cats = {}, stn = D.menu.stations || {};
  D.menu.categories.forEach(c => { cats[c.id] = c.name; });
  return D.menu.items.map(m => [shop, m.id, txt(m.sku, 32), txt(m.name, 120), txt(cats[m.cat] || '', 60), txt(m.unit, 12), m2(m.price), m2(m.price2), roundTo(m.cost, 4),
    m.track ? 1 : 0, q3(m.stock), q3(m.min), m.hidden ? 1 : 0, txt(stn[m.station] || m.station || '', 30)]);
}
function contactRows(shop) {
  return st.D.contacts.map(c => [shop, c.id, txt(c.name, 100), txt(c.kind, 10), txt(c.taxId, 13), txt(c.branch, 30), txt(c.address, 200), txt(c.phone, 40), txt(c.email, 80), txt(c.note, 120)]);
}

// REPLACE แบบหลายแถว แบ่งเป็นหลายคำสั่งไม่ให้ยาวเกิน STMT_MAX
function replaceInto(table, rows) {
  if (!rows.length) return [];
  const head = 'REPLACE INTO ' + table + ' (' + COLS[table].map(c => '`' + c + '`').join(',') + ') VALUES ', out = [];
  let cur = '';
  rows.forEach(r => {
    const v = '(' + r.map(L).join(',') + ')';
    if (cur && cur.length + v.length > STMT_MAX) { out.push(head + cur); cur = ''; }
    cur += (cur ? ',' : '') + v;
  });
  if (cur) out.push(head + cur);
  return out;
}
const inList = vals => '(' + vals.map(L).join(',') + ')';
function chunks(a, n) { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; }

/* ---------- สถานะ (หน้าตั้งค่าของเจ้าของแสดง) ---------- */
const S = { state: 'off', error: null, since: null, lastOk: null, lastTry: null, server: '', counts: null, fails: 0 };
let conn = null, ses = null, instance = null, running = null, ticker = null;
let nextAt = 0, lastRun = 0, seenSeq = -1, force = false, wantResync = false, wantTakeover = false, needDocsRebuild = false, fullPending = false, countsAt = 0;
let onChange = () => {}, lastLogged = null;
function setListener(fn) { onChange = fn; }
const enabled = () => !!C.MYSQL;
const gap = () => Math.min(5000, C.MYSQL.syncMs);
const alertOf = () => S.state === 'conflict' || (S.state === 'error' && S.fails >= 3);
function status() {
  if (!C.MYSQL) return { on: false };
  return { on: true, target: C.MYSQL.target, shop: C.MYSQL.shop, tls: !!C.MYSQL.ssl, state: S.state, error: S.error, since: S.since, lastOk: S.lastOk, lastTry: S.lastTry,
    server: S.server, counts: S.counts, fails: S.fails, syncing: !!running, alert: alertOf(), syncSec: Math.round(C.MYSQL.syncMs / 1000) };
}
// แจ้งหน้าพนักงานเฉพาะตอนป้ายเตือนขึ้น/หาย (ส่งสำเร็จทุกรอบไม่ต้องแจ้ง ไม่อย่างนั้นทุกเครื่องโหลดข้อมูลซ้ำทุกครั้งที่ขาย)
function setState(state, error) {
  const was = alertOf(), prev = S.state;
  if (state !== 'ok' && prev !== state) S.since = Date.now();
  if (state === 'ok') S.since = null;
  S.state = state; S.error = error;
  if (error && error !== lastLogged) { console.error('สำเนาข้อมูลไป MySQL ไม่สำเร็จ:', error); log.app('warn', 'mysql_failed', { error, fails: S.fails }); lastLogged = error; }
  if (state === 'ok' && lastLogged) { console.error('สำเนาข้อมูลไป MySQL ได้ตามปกติแล้ว'); log.app('info', 'mysql_recovered'); lastLogged = null; }
  if (was !== alertOf() || (prev === 'off') !== (state === 'off')) onChange();
}

/* ---------- เชื่อมต่อ ---------- */
const abortErr = () => Object.assign(new Error('หยุดเพราะกำลังกู้คืนข้อมูล'), { abort: true });
let cycleGen = 0;
function guard() { if (st.restoring || st.restoreGen !== cycleGen) throw abortErr(); }
async function q(sql) { guard(); return conn.query(sql, 120000); }
const conflictErr = () => Object.assign(new Error('อีกเครื่องหนึ่งกดใช้ฐานข้อมูล MySQL นี้กับสาขา "' + C.MYSQL.shop + '" แล้ว เครื่องนี้หยุดส่ง ถ้าเครื่องนี้คือเครื่องหลัก กด "ใช้ฐานข้อมูลนี้กับเครื่องนี้"'), { conflict: true });
// ทุก transaction ล็อกแถวของสาขาก่อนและตรวจว่ายังเป็นเครื่องนี้ (อีกเครื่องกดใช้ฐานข้อมูลนี้ระหว่างทาง = ไม่เขียนทับข้อมูลของเครื่องนั้น)
async function tx(stmts) {
  if (!stmts.length) return;
  await q('START TRANSACTION');
  try {
    const own = (await q('SELECT instance FROM ov_shops WHERE shop=' + L(C.MYSQL.shop) + ' FOR UPDATE')).rows[0];
    if (!own || own.instance !== instance) throw conflictErr();
    for (const s of stmts) await q(s);
    guard(); await conn.query('COMMIT', 120000);
  }
  catch (e) { if (conn && !conn.dead) { try { await conn.query('ROLLBACK', 30000); } catch (_) { /* ตัดการเชื่อมต่อแล้ว เซิร์ฟเวอร์ย้อนให้เอง */ } } throw e; }
}
function dropConn() { if (conn) conn.close(); conn = null; ses = null; }

function loadInstance() {
  try { const j = JSON.parse(fs.readFileSync(INSTANCE_FILE, 'utf8')); if (j && /^[a-f0-9]{16}$/.test(j.instance)) return j.instance; } catch (e) { /* ยังไม่มี หรือเสีย สร้างใหม่ */ }
  const id = crypto.randomBytes(8).toString('hex');
  try { U.writeAtomic(INSTANCE_FILE, JSON.stringify({ instance: id, note: 'รหัสเครื่องที่ส่งสำเนาข้อมูลไป MySQL ห้ามคัดลอกไปเครื่องอื่น' })); } catch (e) { console.error('บันทึก mysql-sync.json ไม่ได้:', e.message); }
  return id;
}

async function openSession() {
  dropConn();
  conn = await mysql.connect(Object.assign({ timeout: 15000 }, C.MYSQL));
  S.server = conn.serverVersion.replace(/^5\.5\.5-/, '');
  const shop = C.MYSQL.shop, sh = L(shop);
  await q('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');
  // ไม่ strict (ค่าเกินคอลัมน์ = ตัด ไม่ใช่ส่งไม่ได้ตลอดไป) และไม่มี NO_BACKSLASH_ESCAPES / ANSI_QUOTES ที่ lit() ต้องการ
  await q("SET SESSION sql_mode='NO_ENGINE_SUBSTITUTION'");
  const have = new Set((await q('SHOW TABLES')).rows.map(r => String(Object.values(r)[0]).toLowerCase()));
  for (const [name, ddl] of TABLES) if (!have.has(name)) await q(ddl);
  const ver = (await q("SELECT v FROM ov_meta WHERE shop='' AND k='schema'")).rows[0];
  if (ver && +ver.v > SCHEMA) throw new Error('ฐานข้อมูล MySQL นี้ถูกใช้กับออเดอร์ไวรุ่นใหม่กว่า อัปเดตโปรแกรมก่อน');
  if (!ver) await q("REPLACE INTO ov_meta (shop,k,v) VALUES ('','schema'," + L(String(SCHEMA)) + ')');
  const own = (await q('SELECT instance, name, biz, tax_id, branch FROM ov_shops WHERE shop=' + sh)).rows[0];
  if (!own) await q('INSERT INTO ov_shops (shop, instance, schema_ver) VALUES (' + sh + ',' + L(instance) + ',' + SCHEMA + ')');
  else if (own.instance !== instance) {
    if (!wantTakeover) throw Object.assign(new Error('ฐานข้อมูลนี้มีข้อมูลสาขา "' + shop + '" ที่ส่งมาจากเครื่องอื่นอยู่แล้ว ถ้าย้ายมาใช้เครื่องนี้แทน กด "ใช้ฐานข้อมูลนี้กับเครื่องนี้" ถ้าเป็นอีกสาขา ตั้ง MYSQL_SHOP ให้ต่างกัน'), { conflict: true });
    await q('UPDATE ov_shops SET instance=' + L(instance) + ' WHERE shop=' + sh);
    wantResync = true;
  }
  wantTakeover = false;
  const s = { cursors: new Map(), docRev: new Map(), products: new Map(), contacts: new Map(), src: { sales: new Set(), stock: new Set() },
    shopInfo: own && own.instance === instance ? JSON.stringify([own.name, own.biz, own.tax_id, own.branch]) : '' };
  (await q("SELECT k, v FROM ov_meta WHERE shop=" + sh + " AND k LIKE 'f:%'")).rows.forEach(r => { try { s.cursors.set(r.k.slice(2), JSON.parse(r.v)); } catch (e) { /* ส่งไฟล์นั้นใหม่ */ } });
  (await q('SELECT `no`, rev FROM ov_docs WHERE shop=' + sh)).rows.forEach(r => s.docRev.set(r.no, +r.rev));
  (await q('SELECT id, hash, deleted FROM ov_products WHERE shop=' + sh)).rows.forEach(r => s.products.set(r.id, { hash: r.hash, deleted: r.deleted === '1' }));
  (await q('SELECT id, hash, deleted FROM ov_contacts WHERE shop=' + sh)).rows.forEach(r => s.contacts.set(r.id, { hash: r.hash, deleted: r.deleted === '1' }));
  (await q('SELECT DISTINCT src FROM ov_sales WHERE shop=' + sh)).rows.forEach(r => s.src.sales.add(r.src));
  (await q('SELECT DISTINCT src FROM ov_stock_moves WHERE shop=' + sh)).rows.forEach(r => s.src.stock.add(r.src));
  ses = s;
  countsAt = 0;
}

/* ---------- ไฟล์ ---------- */
async function readSpan(file, from, to) {
  const fh = await fsp.open(file, 'r');
  try {
    const b = Buffer.alloc(Math.max(0, to - from));
    let off = 0;
    while (off < b.length) { const { bytesRead } = await fh.read(b, off, b.length - off, from + off); if (!bytesRead) break; off += bytesRead; }
    return b.subarray(0, off);
  } finally { await fh.close(); }
}
const tailOf = async (file, size) => size ? sha(await readSpan(file, Math.max(0, size - TAIL), size)) : '';
// รายชื่อไฟล์ที่ตรง regex (null = โฟลเดอร์ยังไม่มี) อ่านไม่ได้ด้วยเหตุอื่นให้ throw ห้ามถือว่าว่าง ไม่อย่างนั้นจะลบข้อมูลใน MySQL ทิ้ง
async function listFiles(dir, re) {
  try { return (await fsp.readdir(dir)).filter(f => re.test(f)).sort(); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
// ต้องส่งอะไรของไฟล์นี้: null = ไม่มีอะไรใหม่ · from = ส่งต่อจากตรงนี้ · from 0 + replace = ไฟล์ถูกเขียนใหม่/ยังไม่เคยส่ง
async function plan(key, file) {
  let stat;
  try { stat = await fsp.stat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const cur = ses.cursors.get(key);
  if (cur && cur.size === stat.size && cur.mtime === stat.mtimeMs) return null;
  if (cur && stat.size >= cur.size && (await tailOf(file, cur.size)) === cur.tail) {
    if (stat.size === cur.size) { cur.mtime = stat.mtimeMs; return null; }
    return { from: cur.size, size: stat.size, mtime: stat.mtimeMs, replace: false, had: true };
  }
  return { from: 0, size: stat.size, mtime: stat.mtimeMs, replace: true, had: !!cur };
}
const cursorStmt = (key, c) => 'REPLACE INTO ov_meta (shop,k,v) VALUES (' + L(C.MYSQL.shop) + ',' + L('f:' + key) + ',' + L(JSON.stringify(c)) + ')';
function parseLines(buf) {
  const out = [];
  buf.toString('utf8').split('\n').forEach(l => { if (!l) return; try { const r = JSON.parse(l); if (r && typeof r === 'object') out.push(r); } catch (e) { /* บรรทัดเสีย ข้ามเหมือนตอนเปิดดูในระบบ */ } });
  return out;
}
const delSrc = {
  sales: (sh, f) => ['DELETE i FROM ov_sale_items i JOIN ov_sales s ON s.shop=i.shop AND s.`no`=i.sale_no WHERE s.shop=' + sh + ' AND s.src=' + L(f), 'DELETE FROM ov_sales WHERE shop=' + sh + ' AND src=' + L(f)],
  stock: (sh, f) => ['DELETE FROM ov_stock_moves WHERE shop=' + sh + ' AND src=' + L(f)]
};

// ยอดขาย (sales/) หรือประวัติสต็อก (journal/stock-) หนึ่งไฟล์ ทีละช่วงไม่เกิน WINDOW ช่วงละหนึ่ง transaction
async function syncRowsFile(kind, dir, f, sent) {
  const key = (kind === 'sales' ? 'sales/' : 'journal/') + f, file = path.join(dir, f), shop = C.MYSQL.shop, sh = L(shop);
  const p = await plan(key, file);
  if (!p) return;
  let from = p.from, replace = p.replace;
  while (from < p.size || replace) {
    const to = Math.min(p.size, from + WINDOW), buf = from < to ? await readSpan(file, from, to) : Buffer.alloc(0);
    let end = buf.lastIndexOf(10) + 1;
    if (!end && to < p.size) end = buf.length;      // บรรทัดยาวผิดปกติ ข้ามไป
    if (!end && !replace) break;                    // มีแต่บรรทัดที่ยังเขียนไม่จบ รอรอบหน้า
    const stmts = replace ? delSrc[kind](sh, f) : [];
    const recs = parseLines(buf.subarray(0, end));
    if (kind === 'sales') {
      const sales = [], items = [];
      recs.forEach(r => { const x = saleRows(shop, r, f); if (x) { sales.push(x.sale); items.push(...x.items); } });
      stmts.push(...replaceInto('ov_sales', sales), ...replaceInto('ov_sale_items', items));
      sent.sales += sales.length;
    } else {
      const rows = recs.map(r => moveRow(shop, r, f)).filter(Boolean);
      stmts.push(...replaceInto('ov_stock_moves', rows));
      sent.moves += rows.length;
    }
    const pos = from + end, c = { size: pos, tail: await tailOf(file, pos), mtime: pos === p.size ? p.mtime : 0 };
    stmts.push(cursorStmt(key, c));
    await tx(stmts);
    ses.cursors.set(key, c); ses.src[kind].add(f);
    from = pos; replace = false;
    if (!end) break;
  }
}
// ไฟล์ที่เคยส่งแต่ไม่มีในเครื่องแล้ว (กู้คืนจากไฟล์สำรองที่เก่ากว่า) เอาออกจาก MySQL ให้ตรงกับในเครื่อง
async function dropMissing(kind, files, full) {
  if (!files) { if (!full) return; files = []; }   // โฟลเดอร์ไม่มี: ปกติไม่ลบอะไร (ระวังไว้ก่อน) ส่งใหม่ทั้งหมด = ในเครื่องว่างจริง
  const sh = L(C.MYSQL.shop), local = new Set(files), prefix = kind === 'sales' ? 'sales/' : 'journal/';
  for (const f of Array.from(ses.src[kind])) {
    if (local.has(f)) continue;
    await tx(delSrc[kind](sh, f).concat(['DELETE FROM ov_meta WHERE shop=' + sh + ' AND k=' + L('f:' + prefix + f)]));
    ses.src[kind].delete(f); ses.cursors.delete(prefix + f);
  }
}

/* ---------- เอกสาร: ทุกบรรทัดใน journal/docs- คือเอกสารหนึ่งฉบับ ณ rev หนึ่ง ใน MySQL เก็บฉบับล่าสุด (rev สูงสุด) ---------- */
function docStmts(list) {
  if (!list.length) return [];
  const shop = C.MYSQL.shop, docs = [], lines = [];
  list.forEach(d => { const x = docRows(shop, d); docs.push(x.doc); lines.push(...x.lines); });
  const out = replaceInto('ov_docs', docs);
  chunks(list.map(d => d.no), 500).forEach(nos => out.push('DELETE FROM ov_doc_lines WHERE shop=' + L(shop) + ' AND doc_no IN ' + inList(nos)));
  return out.concat(replaceInto('ov_doc_lines', lines));
}
function latestDocs(recs, known, into) {
  recs.forEach(d => {
    if (!store.cleanDoc(d) || d.rev <= (known.get(d.no) || 0)) return;
    const o = into.get(d.no);
    if (!o || d.rev > o.rev) into.set(d.no, d);
  });
  return into;
}
async function syncDocs(files, sent) {
  const sh = L(C.MYSQL.shop), names = files || [], plans = [];
  let rebuild = needDocsRebuild;
  for (const f of names) {
    const p = await plan('journal/' + f, path.join(C.JOURNAL_DIR, f));
    if (!p) continue;
    if (p.replace && p.had) rebuild = true;        // ไฟล์ถูกเขียนใหม่ (กู้คืน): rev ใน MySQL อาจสูงกว่าในเครื่อง ต้องสร้างใหม่ทั้งหมด
    plans.push([f, p]);
  }
  if (files) { const local = new Set(names); ses.cursors.forEach((c, k) => { if (k.startsWith('journal/docs-') && !local.has(k.slice(8))) rebuild = true; }); }
  if (rebuild) {
    // เอกสารมีไม่มาก อ่านทุกไฟล์แล้วแทนที่ทั้งหมดใน transaction เดียว (รายงานไม่เห็นช่วงที่เอกสารหายไป)
    const latest = new Map(), cursors = [];
    for (const f of names) {
      const file = path.join(C.JOURNAL_DIR, f);
      let stat; try { stat = await fsp.stat(file); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      const buf = await readSpan(file, 0, stat.size), end = buf.lastIndexOf(10) + 1;
      latestDocs(parseLines(buf.subarray(0, end)), new Map(), latest);
      cursors.push(['journal/' + f, { size: end, tail: await tailOf(file, end), mtime: end === stat.size ? stat.mtimeMs : 0 }]);
    }
    const list = Array.from(latest.values());
    await tx(['DELETE FROM ov_doc_lines WHERE shop=' + sh, 'DELETE FROM ov_docs WHERE shop=' + sh, "DELETE FROM ov_meta WHERE shop=" + sh + " AND k LIKE 'f:journal/docs-%'"]
      .concat(docStmts(list), cursors.map(([k, c]) => cursorStmt(k, c))));
    Array.from(ses.cursors.keys()).forEach(k => { if (k.startsWith('journal/docs-')) ses.cursors.delete(k); });
    cursors.forEach(([k, c]) => ses.cursors.set(k, c));
    ses.docRev = new Map(list.map(d => [d.no, d.rev]));
    needDocsRebuild = false; sent.docs += list.length;
    return;
  }
  for (const [f, p] of plans) {
    const file = path.join(C.JOURNAL_DIR, f), buf = await readSpan(file, p.from, p.size), end = buf.lastIndexOf(10) + 1;
    const list = Array.from(latestDocs(parseLines(buf.subarray(0, end)), ses.docRev, new Map()).values());
    const pos = p.from + end, c = { size: pos, tail: await tailOf(file, pos), mtime: pos === p.size ? p.mtime : 0 };
    await tx(docStmts(list).concat([cursorStmt('journal/' + f, c)]));
    ses.cursors.set('journal/' + f, c);
    list.forEach(d => ses.docRev.set(d.no, d.rev));
    sent.docs += list.length;
  }
}

/* ---------- สินค้า รายชื่อ ข้อมูลร้าน: เทียบกับที่ส่งไปแล้ว ส่งเฉพาะที่เปลี่ยน ลบแล้ว = deleted 1 (บิลเก่ายังอ้างชื่อได้) ---------- */
async function syncSnapshot(table, rows, cache, sent) {
  const now = dt(Date.now()), present = new Set(), changed = [];
  rows.forEach(r => {
    const id = String(r[1]), hash = sha(JSON.stringify(r)), c = cache.get(id);
    present.add(id);
    if (!c || c.hash !== hash || c.deleted) changed.push(r.concat([0, hash, now]));
  });
  const gone = Array.from(cache.keys()).filter(id => !present.has(id) && !cache.get(id).deleted);
  const stmts = replaceInto(table, changed);
  chunks(gone, 500).forEach(ids => stmts.push('UPDATE ' + table + ' SET deleted=1, updated_at=' + L(now) + ' WHERE shop=' + L(C.MYSQL.shop) + ' AND id IN ' + inList(ids)));
  if (!stmts.length) return;
  await tx(stmts);
  changed.forEach(r => cache.set(String(r[1]), { hash: r[r.length - 2], deleted: false }));
  gone.forEach(id => { cache.get(id).deleted = true; });
  sent.other += changed.length + gone.length;
}

async function cycle(manual) {
  cycleGen = st.restoreGen;
  guard();
  if (wantTakeover || !conn || conn.dead || !ses) await openSession();
  const shop = C.MYSQL.shop, sh = L(shop), sent = { sales: 0, moves: 0, docs: 0, other: 0 };
  if (wantResync) {
    // ส่งใหม่ทั้งหมด: ลืมตำแหน่งที่ส่งแล้ว ทุกไฟล์ถูกส่งแบบแทนที่ ไฟล์ที่ไม่มีในเครื่องถูกลบ เอกสารสร้างใหม่ สินค้า/รายชื่อส่งทุกแถว
    await tx(["DELETE FROM ov_meta WHERE shop=" + sh + " AND k LIKE 'f:%'"]);
    ses.cursors.clear(); needDocsRebuild = true; fullPending = true; wantResync = false;
    ses.products.forEach(c => { c.hash = ''; }); ses.contacts.forEach(c => { c.hash = ''; });
  }
  const sales = await listFiles(C.SALES_DIR, C.SALES_RE);
  for (const f of sales || []) await syncRowsFile('sales', C.SALES_DIR, f, sent);
  await dropMissing('sales', sales, fullPending);
  const jr = await listFiles(C.JOURNAL_DIR, C.JOURNAL_RE);
  const stock = jr && jr.filter(f => f.startsWith('stock-')), docs = jr && jr.filter(f => f.startsWith('docs-'));
  for (const f of stock || []) await syncRowsFile('stock', C.JOURNAL_DIR, f, sent);
  await dropMissing('stock', stock, fullPending);
  await syncDocs(docs, sent);
  guard();                                  // อ่าน st.D ตอนนี้ทีเดียว (ไม่มี await คั่น)
  const products = productRows(shop), contacts = contactRows(shop), s = st.D.settings;
  const info = [txt(s.shop, 60), txt(s.biz, 20), txt(s.taxId, 13), txt(s.branch, 30)];
  await syncSnapshot('ov_products', products, ses.products, sent);
  await syncSnapshot('ov_contacts', contacts, ses.contacts, sent);
  const wrote = sent.sales + sent.moves + sent.docs + sent.other > 0, infoKey = JSON.stringify(info);
  if (wrote || infoKey !== ses.shopInfo) {
    // instance ไม่ตรง (อีกเครื่องกดใช้ฐานข้อมูลนี้ไปแล้ว) = ไม่มีแถวที่ตรง หยุดส่งจากเครื่องนี้
    const r = await q('UPDATE ov_shops SET name=' + L(info[0]) + ', biz=' + L(info[1]) + ', tax_id=' + L(info[2]) + ', branch=' + L(info[3]) + ', schema_ver=' + SCHEMA +
      ', synced_at=' + L(dt(Date.now())) + ' WHERE shop=' + sh + ' AND instance=' + L(instance));
    if (!r.affected) throw conflictErr();
    ses.shopInfo = infoKey;
  }
  if (!S.counts || manual || (wrote && Date.now() - countsAt > 300000)) {
    const r = (await q('SELECT (SELECT COUNT(*) FROM ov_sales WHERE shop=' + sh + ') sales, (SELECT COUNT(*) FROM ov_docs WHERE shop=' + sh + ') docs, ' +
      '(SELECT COUNT(*) FROM ov_stock_moves WHERE shop=' + sh + ') moves, (SELECT COUNT(*) FROM ov_products WHERE shop=' + sh + ' AND deleted=0) products, ' +
      '(SELECT COUNT(*) FROM ov_contacts WHERE shop=' + sh + ' AND deleted=0) contacts')).rows[0];
    S.counts = {}; Object.keys(r || {}).forEach(k => { S.counts[k] = +r[k]; });
    countsAt = Date.now();
  } else if (wrote && S.counts) { S.counts.sales += sent.sales; S.counts.moves += sent.moves; }   // ประมาณไว้ก่อน นับจริงทุก 5 นาที
  fullPending = false;
  return sent;
}

/* ---------- ตารางเวลา: มีอะไรเปลี่ยนส่งภายในไม่กี่วินาที ไม่มีอะไรเปลี่ยนตรวจทุก MYSQL_SYNC_SEC ล้มเหลวรอนานขึ้นเรื่อยๆ (สูงสุด 5 นาที) ---------- */
function run(manual) {
  if (running) return running;
  const seq = st.changeSeq;
  lastRun = S.lastTry = Date.now();
  if (S.state === 'off') setState('connecting', null);
  running = (async () => {
    try {
      await cycle(manual);
      S.fails = 0; nextAt = 0; seenSeq = seq; S.lastOk = Date.now();
      setState('ok', null);
    } catch (e) {
      if (e.abort) { nextAt = Date.now() + 1000; return; }   // กู้คืนข้อมูลอยู่ รอบหน้าค่อยส่ง
      dropConn();
      if (e.conflict) { S.fails++; nextAt = Date.now() + 300000; setState('conflict', e.message); return; }
      S.fails++;
      nextAt = Date.now() + Math.min(300000, gap() * Math.pow(2, Math.min(S.fails - 1, 10)));
      if (!e.code && !e.errno && S.fails === 1) log.app('error', 'mysql_bug', { error: String(e && e.stack || e) });   // ไม่ใช่ปัญหาเครือข่าย/MySQL
      setState('error', mysql.explain(e, C.MYSQL));
    } finally {
      running = null;
      if (wantResync || wantTakeover) force = true;
    }
  })();
  return running;
}
function tick() {
  if (running || st.restoring) return;
  const now = Date.now();
  if (!force && now < nextAt) return;
  if (force || now - lastRun >= C.MYSQL.syncMs || (st.changeSeq !== seenSeq && now - lastRun >= gap())) { const m = force; force = false; run(m); }
}
function start() {
  if (!C.MYSQL || ticker) return;
  instance = loadInstance();
  setState('connecting', null);
  force = true;
  ticker = setInterval(tick, Math.min(1000, gap())); ticker.unref();
  setImmediate(tick);
}
function stop() { clearInterval(ticker); ticker = null; dropConn(); }
// ปุ่ม "ส่งตอนนี้" / "ส่งใหม่ทั้งหมด" / "ใช้ฐานข้อมูลนี้กับเครื่องนี้" รอผลไม่เกิน wait ms (ข้อมูลหลายปีส่งนานกว่านั้น ส่งต่อเบื้องหลัง)
async function syncNow(o) {
  o = o || {};
  const wait = new Promise(r => setTimeout(r, o.wait || 20000));
  if (o.resync) wantResync = true;
  if (o.takeover) wantTakeover = true;
  if (running) await Promise.race([running, wait]);
  if (!running) { nextAt = 0; force = false; await Promise.race([run(true), wait]); }
  else force = true;
  return status();
}

module.exports = { start, stop, status, syncNow, enabled, setListener, TABLES, COLS, saleRows };
