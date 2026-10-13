'use strict';
/* ค่าตั้งต้นทั้งหมดของระบบ อ่านจาก environment ที่เดียว */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || ROOT);

module.exports = {
  PORT: +process.env.PORT || 3000,
  PIN: String(process.env.STAFF_PIN || '1234'),
  ORDER_LIMIT: Math.max(1, Math.floor(+process.env.ORDER_LIMIT) || 8),
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
  BK_COPY: process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : null,

  KEEP_DAYS: 8,                    // ยอดขายกี่วันล่าสุดที่เก็บใน data.json (ทั้งหมดอยู่ใน sales/)
  // สำรองอัตโนมัติทุกกี่นาที (ค่าเริ่มต้น 240 = 4 ชั่วโมง) เฉพาะเมื่อมีข้อมูลเปลี่ยน
  BK_EVERY: Math.max(0.01, +process.env.BACKUP_EVERY_MIN || 240) * 60000,
  BK_KEEP_DAYS: 30,                // เก็บไฟล์สำรองย้อนหลัง (วันละไฟล์ล่าสุด + ทุกไฟล์ของ 2 วันล่าสุด)
  BODY_LIMIT: 100 * 1024,          // คำขอทั่วไป
  IMG_MAX: 3 * 1024 * 1024,        // รูปอาหารหนึ่งรูป
  RESTORE_MAX: 300 * 1024 * 1024,  // ไฟล์สำรองที่อัปโหลดมากู้คืน
  DAY: 86400000,

  IMG_RE: /^(m\d+|logo)-[a-f0-9]{8}\.(jpg|png|webp)$/,   // ทุกไฟล์ใน images/ (รูปเมนู + โลโก้ร้าน)
  MENU_IMG_RE: /^m\d+-[a-f0-9]{8}\.(jpg|png|webp)$/,
  LOGO_RE: /^logo-[a-f0-9]{8}\.(jpg|png|webp)$/,
  BK_RE: /^backup-\d{8}-\d{6}-[a-z-]+\.json(\.gz)?$/,
  SALES_RE: /^\d{4}-\d{2}\.jsonl$/,
  LOG_RE: /^(audit|security|app)-\d{4}-\d{2}\.jsonl$/
};
