'use strict';
/* ค่าตั้งต้นทั้งหมดของระบบ อ่านจาก environment ที่เดียว */
const path = require('path');

const fs = require('fs');

const ROOT = path.join(__dirname, '..');

/* สำเนาข้อมูลไป MySQL / MariaDB (ไม่บังคับ ดู lib/mirror.js)
   MYSQL_URL=mysql://ผู้ใช้:รหัสผ่าน@เครื่อง:3306/ฐานข้อมูล?ssl=1   รหัสผ่านที่มี @ # / ? ใส่แยกใน MYSQL_PASSWORD ได้ (ไม่ต้องแปลงเป็น %xx)
   ssl: ไม่ใส่ = ไม่เข้ารหัส (ใช้ในวง LAN) · 1/true/required = เข้ารหัส + ตรวจใบรับรองและชื่อเครื่อง · verify-ca = ตรวจใบรับรองแต่ไม่ตรวจชื่อเครื่อง
   MYSQL_CA = ไฟล์ CA ของเซิร์ฟเวอร์ (ใส่แล้วเข้ารหัสเสมอ) · MYSQL_SHOP = รหัสสาขา (หลายสาขาใช้ฐานข้อมูลเดียวกันได้ ค่าเริ่มต้น main)
   ห้ามพิมพ์ค่านี้ลง log/หน้าจอ ใช้ target (ไม่มีรหัสผ่าน) */
function mysqlConfig(env) {
  const raw = String(env.MYSQL_URL || '').trim();
  if (!raw) return { MYSQL: null, MYSQL_ERR: null };
  const bad = msg => ({ MYSQL: null, MYSQL_ERR: msg + '\n  ตัวอย่าง MYSQL_URL=mysql://ordervai:รหัสผ่าน@192.168.1.20:3306/ordervai (ดู README หัวข้อ MySQL)' });
  let u;
  try { u = new URL(raw); } catch (e) { return bad('MYSQL_URL รูปแบบไม่ถูกต้อง'); }
  if (u.protocol !== 'mysql:' && u.protocol !== 'mariadb:') return bad('MYSQL_URL ต้องขึ้นต้นด้วย mysql://');
  let user, password, database;
  try { user = decodeURIComponent(u.username); password = decodeURIComponent(u.password); database = decodeURIComponent(u.pathname.replace(/^\//, '')); }
  catch (e) { return bad('MYSQL_URL มีตัวอักษร % ที่แปลงไม่ได้ ใส่รหัสผ่านใน MYSQL_PASSWORD แทน'); }
  if (env.MYSQL_PASSWORD !== undefined) password = String(env.MYSQL_PASSWORD);
  const host = u.hostname.replace(/^\[|\]$/g, ''), port = u.port ? +u.port : 3306;
  if (!host) return bad('MYSQL_URL ไม่มีชื่อเครื่อง');
  if (!user) return bad('MYSQL_URL ไม่มีชื่อผู้ใช้ (mysql://ผู้ใช้:รหัสผ่าน@...)');
  if (!/^[A-Za-z0-9_$-]{1,64}$/.test(database)) return bad('MYSQL_URL ต้องมีชื่อฐานข้อมูลท้ายที่อยู่ (ตัวอังกฤษ ตัวเลข _ - ไม่เกิน 64 ตัว)');
  let verify = null;
  for (const [k, v] of u.searchParams) {
    const val = v.trim().toLowerCase();
    if (k !== 'ssl' && k !== 'ssl-mode' && k !== 'sslmode') return bad('MYSQL_URL มีตัวเลือก "' + k + '" ที่ระบบไม่รู้จัก (ใช้ได้แค่ ?ssl=1 หรือ ?ssl=verify-ca)');
    if (['', '0', 'false', 'off', 'disabled'].includes(val)) verify = null;
    else if (['1', 'true', 'on', 'required', 'verify_identity', 'verify-identity'].includes(val)) verify = 'identity';
    else if (['verify-ca', 'verify_ca'].includes(val)) verify = 'ca';
    else return bad('ค่า ssl ใน MYSQL_URL ต้องเป็น 1 หรือ verify-ca');
  }
  let ca = null;
  if (env.MYSQL_CA) {
    try { ca = fs.readFileSync(path.resolve(env.MYSQL_CA), 'utf8'); } catch (e) { return bad('อ่านไฟล์ MYSQL_CA ไม่ได้ (' + e.code + ')'); }
    if (!/-----BEGIN CERTIFICATE-----/.test(ca)) return bad('ไฟล์ MYSQL_CA ต้องเป็นใบรับรองแบบ PEM (-----BEGIN CERTIFICATE-----)');
    if (!verify) verify = 'identity';
  }
  const shop = String(env.MYSQL_SHOP || 'main').trim();
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(shop)) return { MYSQL: null, MYSQL_ERR: 'MYSQL_SHOP ต้องเป็นตัวอังกฤษ ตัวเลข _ - ไม่เกิน 20 ตัว เช่น main หรือ branch2' };
  return {
    MYSQL: {
      host, port, user, password, database, shop, ssl: verify ? { verify, ca } : null,
      syncMs: Math.min(3600, Math.max(1, +env.MYSQL_SYNC_SEC || 60)) * 1000,
      target: user + '@' + (host.includes(':') ? '[' + host + ']' : host) + ':' + port + '/' + database
    },
    MYSQL_ERR: null
  };
}
const mysqlConf = mysqlConfig(process.env);
const DATA_DIR = path.resolve(process.env.DATA_DIR || ROOT);

module.exports = {
  PORT: +process.env.PORT || 3000,
  // ตัดช่องว่างหัวท้าย: cmd ของ Windows `set STAFF_PIN=123456 && node server.js` เก็บช่องว่างก่อน && ไว้ใน PIN เจ้าของใส่ PIN ถูกแต่เข้าไม่ได้
  PIN: String(process.env.STAFF_PIN || '1234').trim() || '1234',
  ORDER_LIMIT: Math.max(1, Math.floor(+process.env.ORDER_LIMIT) || 8),
  // ยืนยัน PIN ซ้ำก่อนทำเรื่องสำคัญ (เปลี่ยน PromptPay/ลิงก์/รูป QR รับเงิน, จัดการพนักงาน, กู้คืน, ดาวน์โหลดไฟล์สำรอง, เปลี่ยนรหัส QR) มีผลกี่วินาที
  REAUTH_MS: Math.max(1, +process.env.REAUTH_SEC || 300) * 1000,
  // เจ้าของต้องเข้าสู่ระบบใหม่ทุกกี่นาที (ค่าเริ่มต้น 720 = 12 ชั่วโมง) บทบาทอื่นอยู่ได้ 30 วันเหมือนเดิม
  OWNER_SESSION_MS: Math.max(0.01, +process.env.OWNER_SESSION_MIN || 720) * 60000,
  TRUST_PROXY: process.env.TRUST_PROXY === '1',

  ROOT,
  PUB: path.join(ROOT, 'public'),
  MENU_SEED: path.join(ROOT, 'menu.json'),
  DATA_DIR,
  DATA_FILE: path.join(DATA_DIR, 'data.json'),
  SALES_DIR: path.join(DATA_DIR, 'sales'),
  IMG_DIR: path.join(DATA_DIR, 'images'),
  BK_DIR: path.join(DATA_DIR, 'backups'),
  LOG_DIR: path.join(DATA_DIR, 'logs'),
  JOURNAL_DIR: path.join(DATA_DIR, 'journal'),   // ประวัติสต็อกและเอกสาร (ต่อท้ายรายเดือน แบบเดียวกับ sales/)
  BK_COPY: process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : null,

  KEEP_DAYS: 8,                    // ยอดขายกี่วันล่าสุดที่เก็บใน data.json (ทั้งหมดอยู่ใน sales/) เอกสารที่จบแล้วก็เก็บเท่านี้ (ทั้งหมดอยู่ใน journal/)
  // สำรองอัตโนมัติทุกกี่นาที (ค่าเริ่มต้น 240 = 4 ชั่วโมง) เฉพาะเมื่อมีข้อมูลเปลี่ยน
  BK_EVERY: Math.max(0.01, +process.env.BACKUP_EVERY_MIN || 240) * 60000,
  BK_KEEP_DAYS: 30,                // เก็บไฟล์สำรองย้อนหลัง (วันละไฟล์ล่าสุด + ทุกไฟล์ของ 2 วันล่าสุด)
  BODY_LIMIT: 100 * 1024,          // คำขอทั่วไป
  IMG_MAX: 3 * 1024 * 1024,        // รูปอาหารหนึ่งรูป
  RESTORE_MAX: 300 * 1024 * 1024,  // ไฟล์สำรองที่อัปโหลดมากู้คืน
  DAY: 86400000,

  IMG_RE: /^(m\d+|logo|cover|payqr)-[a-f0-9]{8}\.(jpg|png|webp)$/,   // ทุกไฟล์ใน images/ (รูปเมนู + โลโก้ + ภาพพื้นหลัง + รูป QR รับเงิน)
  MENU_IMG_RE: /^m\d+-[a-f0-9]{8}\.(jpg|png|webp)$/,
  LOGO_RE: /^logo-[a-f0-9]{8}\.(jpg|png|webp)$/,
  COVER_RE: /^cover-[a-f0-9]{8}\.(jpg|png|webp)$/,
  PAYQR_RE: /^payqr-[a-f0-9]{8}\.(jpg|png|webp)$/,
  BK_RE: /^backup-\d{8}-\d{6}-[a-z-]+\.json(\.gz)?$/,
  SALES_RE: /^\d{4}-\d{2}\.jsonl$/,
  JOURNAL_RE: /^(stock|docs)-\d{4}-\d{2}\.jsonl$/,
  LOG_RE: /^(audit|security|app)-\d{4}-\d{2}\.jsonl$/,

  MYSQL: mysqlConf.MYSQL,          // null = ไม่ได้ตั้ง MYSQL_URL
  MYSQL_ERR: mysqlConf.MYSQL_ERR,  // ตั้งผิด: server.js ไม่ยอมเปิดระบบ (ข้อความไม่มีรหัสผ่าน)
  mysqlConfig
};
