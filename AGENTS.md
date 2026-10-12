# AGENTS.md · คู่มือสำหรับ AI ที่ติดตั้ง ดูแล หรือแก้ไขระบบ "ออเดอร์ไว"

ไฟล์นี้เขียนให้ AI coding agent (Claude Code, Codex, Cursor และอื่นๆ) อ่านก่อนลงมือ
คู่มือผู้ใช้สำหรับเจ้าของร้านอยู่ใน `README.md` ส่วนไฟล์นี้เน้นสิ่งที่ AI ต้องรู้เพื่อไม่ทำระบบพัง

---

## 1. ระบบนี้คืออะไร

ระบบสั่งอาหารของร้านอาหารไทย รันบนคอมเครื่องเดียวในร้าน
- **ลูกค้า** สแกน QR ที่โต๊ะ → หน้า `/order?t=<โต๊ะ>&k=<รหัสลับโต๊ะ>` → เลือกเมนู (มีรูป ราคา) → สั่งเข้าครัว
- **พนักงาน** เปิด `/staff` ใส่ PIN → มี 5 แท็บ: ครัว, โต๊ะ & บิล, เมนู, สรุปยอด, ตั้งค่า
- ไม่มีฐานข้อมูล ไม่มี dependency ไม่มี build step ใช้แค่ Node.js 18+ ข้อมูลเก็บเป็นไฟล์ JSON
- ภาษาในหน้าเว็บ ข้อความ error และคอมเมนต์โค้ด เป็นภาษาไทย ให้คงไว้เป็นภาษาไทย

---

## 2. ติดตั้งและรัน

```bash
node --version                 # ต้อง >= 18 ถ้าไม่มี ให้ติดตั้งจาก https://nodejs.org (LTS)
cd restaurant-qr-order
npm test                       # ควรผ่านทั้งหมด (ใช้เวลาราว 20 วินาที) ก่อนเปิดใช้จริงหรือหลังแก้โค้ดทุกครั้ง
STAFF_PIN=839274 node server.js
```

ไม่ต้อง `npm install` ถ้าเห็นใครเพิ่ม dependency ให้ถือว่าผิดแนวทางของโปรเจกต์

### ตรวจว่าติดตั้งสำเร็จ (รันในอีกหน้าต่างหนึ่ง)

```bash
curl -s http://localhost:3000/api/menu | head -c 200        # ได้ JSON เมนู
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/state   # ได้ 401 (ต้องเข้าสู่ระบบก่อน = ถูกต้อง)
curl -s -c /tmp/ck -H 'Content-Type: application/json' -d '{"pin":"839274"}' http://localhost:3000/api/login   # {"ok":true}
curl -s -b /tmp/ck http://localhost:3000/api/state | head -c 200   # ได้ข้อมูลร้าน
```

ตอนเปิดระบบ console จะพิมพ์ที่อยู่สำหรับลูกค้า เช่น `http://192.168.1.50:3000` ถ้ามีหลาย IP จะพิมพ์ทั้งหมด

### Environment variables (อ่านที่ `lib/config.js` ที่เดียว)

| ตัวแปร | ค่าเริ่มต้น | หมายเหตุ |
|---|---|---|
| `STAFF_PIN` | `1234` | ใช้งานจริงควร ≥ 6 หลัก ถ้า `TRUST_PROXY=1` แต่ PIN สั้น ระบบไม่ยอมเปิด |
| `PORT` | `3000` | |
| `DATA_DIR` | โฟลเดอร์โปรเจกต์ | ที่เก็บ data.json, sales/, images/, backups/ |
| `BACKUP_DIR` | ไม่ตั้ง | คัดลอกไฟล์สำรองไปอีกที่ เช่น โฟลเดอร์ Google Drive |
| `BACKUP_EVERY_MIN` | `240` | สำรองอัตโนมัติทุกกี่นาที เฉพาะเมื่อมีข้อมูลเปลี่ยน |
| `TRUST_PROXY` | ไม่ตั้ง | ตั้ง `1` เมื่อเปิดผ่าน Cloudflare Tunnel ที่รัน**บนเครื่องเดียวกัน** |
| `ORDER_LIMIT` | `8` | ลูกค้าสั่งได้กี่ครั้งต่อนาทีต่อ IP |

### ให้ระบบเปิดเองตอนเปิดเครื่อง

**Windows**: สร้าง `start.bat` ในโฟลเดอร์โปรเจกต์ แล้ววาง shortcut ของไฟล์นี้ใน `shell:startup`
```bat
@echo off
chcp 65001 >nul
cd /d "%~dp0"
set STAFF_PIN=839274
set BACKUP_DIR=G:\My Drive\ordervai-backup
node server.js
pause
```

**Linux (systemd)**: `/etc/systemd/system/ordervai.service` แล้ว `systemctl enable --now ordervai`
```ini
[Unit]
Description=ordervai
After=network-online.target

[Service]
WorkingDirectory=/opt/restaurant-qr-order
ExecStart=/usr/bin/node server.js
Environment=STAFF_PIN=839274
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

macOS ใช้ launchd หรือเปิดด้วย Terminal ตอนเปิดร้านก็ได้

### Checklist ติดตั้งให้ร้านจริง

1. ติดตั้ง Node.js LTS, แตกไฟล์, `npm test` ผ่าน
2. ตั้ง `STAFF_PIN` อย่างน้อย 6 หลัก และ `BACKUP_DIR` ไปที่โฟลเดอร์ที่ sync ขึ้นคลาวด์ (อย่าตั้ง `DATA_DIR` ให้อยู่ในโฟลเดอร์ที่ sync เพราะโปรแกรม sync อาจล็อกไฟล์)
3. ตั้ง IP ของเครื่องร้านให้คงที่ในเราเตอร์ (DHCP reservation) ไม่อย่างนั้น QR ที่พิมพ์ไว้จะเสียเมื่อ IP เปลี่ยน
4. เปิด `/staff` → ตั้งค่า: ชื่อร้าน ที่อยู่ เบอร์ PromptPay จำนวนโต๊ะ และ "ที่อยู่เว็บที่ใส่ใน QR" ถ้าตรวจเจอเป็น localhost
5. แท็บเมนู: แก้เมนูตัวอย่างเป็นเมนูจริงของร้าน
6. สแกน QR โต๊ะ 1 ด้วยมือถือที่ต่อ WiFi ร้าน ลองสั่งจริง แล้วค่อยพิมพ์ QR ทุกโต๊ะ
7. ลองจ่าย PromptPay 1 บาทจาก QR บนใบแจ้งยอด เพื่อยืนยันว่าเงินเข้าบัญชีถูก
8. กด "สำรองข้อมูลตอนนี้" แล้วเช็กว่ามีไฟล์ไปโผล่ใน `BACKUP_DIR`

---

## 3. โครงสร้างโค้ด

```
server.js          เปิด HTTP server, ไฟล์ static, /img/*, /api/events (SSE), ส่งต่อไป routes, จัดการ error
lib/config.js      ค่าคงที่และ env ทั้งหมด
lib/util.js        วันที่, writeAtomic, retryAsync/retry (ลองซ้ำเมื่อไฟล์ถูกล็อก), readRaw/readBody (มีจำกัดขนาด), sniffImage, safeEq, send
lib/store.js       state ในหน่วยความจำ, normalize (ตรวจซ่อมข้อมูล), load, save/writeNow (ลองใหม่ด้วย timer), คิวยอดขาย, billOf, totals
lib/backup.js      สร้างไฟล์สำรอง .json.gz แบบ stream, สำรองอัตโนมัติ, กู้คืนแบบ stage-then-swap
lib/routes.js      API ทั้งหมด (object `api` key = "METHOD /path"), สิทธิ์, rate limit, SSE broadcast
public/staff.html  หน้าพนักงาน (vanilla JS ไฟล์เดียว)
public/customer.html หน้าลูกค้า (vanilla JS ไฟล์เดียว)
public/qrcode.js   ไลบรารี qrcode-generator 1.4.4 (MIT) vendored มา ห้ามโหลดจาก CDN เพราะร้านอาจไม่มีเน็ต
menu.json          เมนูตั้งต้น ใช้ครั้งเดียวตอนยังไม่มี data.json หลังจากนั้นเมนูอยู่ใน data.json
test/api.test.js   ชุดทดสอบ node:test
```

### การไหลของข้อมูล

```
มือถือลูกค้า ──POST /api/order──▶ routes ──แก้ state.D──▶ store.save() (เขียน data.json ทันที ก่อนตอบ 200)
                                        └──broadcast()──▶ SSE /api/events ──▶ หน้าพนักงานทุกเครื่องเรียก GET /api/state ใหม่
มือถือลูกค้า ◀──poll GET /api/table ทุก 5 วินาที (สถานะอาหาร, เมนูหมด, menuVersion)
```

- ทุก handler ทำงาน synchronous หลัง `await readBody()` จึงไม่มี race ภายใน process (`readBody`/`readRaw` ใน routes.js ตอบ 503 ถ้าการกู้คืนเริ่มระหว่างรอ body)
- `server.js` ล็อกโฟลเดอร์ข้อมูลด้วย named pipe (Windows) / abstract socket (Linux) ก่อน `store.load()` ข้อมูลชุดเดียวกันเปิดได้ทีละโปรแกรม
- หน้าพนักงานไม่ได้รับข้อมูลผ่าน SSE โดยตรง SSE แค่บอกว่า "มีอะไรเปลี่ยน" แล้วหน้าเว็บดึง `/api/state` ทั้งก้อน
- หน้าลูกค้าเห็น `menuVersion` เปลี่ยนจาก `/api/table` แล้วดึง `/api/menu` ใหม่เอง

---

## 4. โมเดลข้อมูล

ทุกอย่างอยู่ใน `store.state.D` และถูกเขียนลง `data.json` (ห้ามเก็บ reference ของ `D` ไว้ข้าม `await` เพราะการกู้คืนจะเปลี่ยน `state.D` เป็น object ใหม่)

```js
D = {
  settings: { shop, address, phone, taxId, footer, promptpay, tables, svc, vat, baseUrl, soldOut: [menuId], acceptOrders },
  menu: {
    version,                       // เพิ่มทุกครั้งที่แก้เมนู ลูกค้าใช้ตรวจว่าต้องโหลดเมนูใหม่
    categories: [{ id, name }],    // ลำดับใน array = ลำดับที่แสดง
    items: [{ id, name, price, cat /* category id */, station, desc, image /* ชื่อไฟล์ใน images/ หรือ '' */, hidden }],
    stations: { hot: 'ครัวร้อน', bar: 'เครื่องดื่ม', dessert: 'ของหวาน' },
    notes: ['ไม่เผ็ด', ...],       // ตัวเลือกหมายเหตุที่ลูกค้ากดได้ (whitelist)
    nextId, nextCatId              // id ไม่ถูกใช้ซ้ำแม้ลบเมนู
  },
  tickets: [{ id, table, station, createdAt, status /* new|cooking|ready|served */, memo, by /* guest|staff */,
              items: [{ id, name, price, qty, note: [] }] }],   // name/price เป็น snapshot ตอนสั่ง
  calls: { [table]: { kind /* staff|bill */, at } },
  sales: [{ no, at, table, sub, svc, vat, total, method /* cash|transfer */, items: [{ name, qty, price }] }],  // แค่ 8 วันล่าสุด
  keys: { [table]: 'hex8' },       // รหัสลับใน QR ของแต่ละโต๊ะ ห้ามสุ่มใหม่ (QR ที่พิมพ์ไว้จะใช้ไม่ได้)
  secret,                          // ใช้คำนวณ cookie พนักงาน = sha256(PIN + secret)
  nextTicket, nextBill, lastBackup, lastAutoBackupAt
}
```

| ไฟล์บนดิสก์ (ใน `DATA_DIR`) | หมายเหตุ |
|---|---|
| `data.json` | เขียนแบบ atomic (tmp + rename) |
| `data.json.bak` | สำเนาตอนเปิดระบบ ใช้กู้อัตโนมัติถ้า data.json อ่านไม่ได้ |
| `sales/YYYY-MM.jsonl` | ยอดขายถาวร append-only หนึ่งบรรทัดต่อบิล ถ้าเขียนไม่ได้ บิลค้างในคิวและลองใหม่เรื่อยๆ ตอนเปิดระบบและหลังกู้คืน `reconcileSales()` เทียบ `D.sales` กับไฟล์ (ตาม `no`) แล้วเติมบิลที่ขาด |
| `images/m<id>-<hex8>.<jpg\|png\|webp>` | รูปอาหาร ชื่อไฟล์ใหม่ทุกครั้งที่เปลี่ยนรูป (cache ได้ตลอด) |
| `backups/backup-YYYYMMDD-HHMMSS-<reason>.json.gz` | reason = auto, manual, before-restore |

**ตัวเงิน:** `svc = round(sub × 10%)`, `vat = round((sub + svc) × 7%)` (VAT คิดเพิ่มจากราคา ไม่ใช่รวมในราคา) สูตรนี้มีสองที่ คือ `store.totals()` และ `calc()` ใน staff.html ถ้าแก้ต้องแก้ทั้งสองที่

---

## 5. API

สิทธิ์: **public** = ใครก็ได้, **QR** = ต้องส่ง `k` ที่ตรงกับ `D.keys[t]` (หรือเป็นพนักงาน), **staff** = ต้องมี cookie `st`
ทุก POST ต้องเป็น `Content-Type: application/json` (ยกเว้นอัปโหลดรูปและกู้คืน) ไม่อย่างนั้นได้ 415

| Method & path | สิทธิ์ | ทำอะไร |
|---|---|---|
| POST /api/login `{pin}` | public | ได้ cookie `st` (จำกัด 6 ครั้ง/นาที/IP) |
| POST /api/logout | public | ลบ cookie |
| GET /api/menu | public | เมนูที่ไม่ซ่อน + หมวดที่มีเมนู + `version` |
| GET /api/table?t=&k= | QR | ออเดอร์ของโต๊ะ, ยอด, `menuVersion`, `soldOut`, `open` |
| POST /api/order `{table,key,items:[{id,qty,note}],memo,reqId}` | QR | สั่งอาหาร แยกตั๋วตาม station, `reqId` กันสั่งซ้ำ 10 นาที |
| POST /api/call `{table,key,kind}` | QR | เรียกพนักงาน / ขอบิล |
| GET /api/events | staff | SSE ส่ง `event: change` |
| GET /api/state | staff | ทุกอย่างที่หน้าพนักงานใช้ รวม `bills`, `health.saveError` |
| POST /api/ticket `{id,from,status}` | staff | เปลี่ยนสถานะ ถ้า `from` ไม่ตรงได้ 409 |
| POST /api/ticket/void `{id}` | staff | ยกเลิกตั๋วทั้งใบ |
| POST /api/call/clear `{table}` | staff | รับทราบการเรียก |
| POST /api/pay `{table,expectedSub,svc,vat,method}` | staff | ปิดบิล ถ้ายอดเปลี่ยนได้ 409 |
| POST /api/settings `{...}` | staff | แก้ตั้งค่าร้าน (ส่งเฉพาะ field ที่จะแก้) |
| POST /api/soldout `{id,soldOut}` | staff | ตั้ง/ยกเลิกเมนูหมด |
| POST /api/menu/item `{id?,name,price,cat,station,desc,hidden}` | staff | เพิ่ม (ไม่มี id) หรือแก้เมนู |
| POST /api/menu/item/delete `{id}` | staff | ลบเมนูและรูป |
| POST /api/menu/image?id= (body = ไฟล์รูป, Content-Type image/*) | staff | อัปโหลดรูป ≤ 3 MB ตรวจ magic bytes |
| POST /api/menu/image/delete `{id}` | staff | เอารูปออก |
| POST /api/menu/category `{id?,name}` | staff | เพิ่มหรือเปลี่ยนชื่อหมวด |
| POST /api/menu/category/delete `{id}` | staff | ลบหมวด (ต้องไม่มีเมนูเหลือ) |
| POST /api/menu/category/move `{id,dir}` | staff | เลื่อนลำดับหมวด |
| POST /api/menu/notes `{notes:[]}` | staff | แก้ตัวเลือกหมายเหตุ |
| GET /api/report | staff | ยอดวันนี้ เงินสด/โอน เมนูขายดี 7 วัน บิลวันนี้ |
| GET /api/export.csv?month=YYYY-MM | staff | CSV (มี BOM สำหรับ Excel) |
| GET /api/backups | staff | รายการไฟล์สำรอง |
| POST /api/backup | staff | สำรองตอนนี้ |
| GET /api/backup/download?name= | staff | ดาวน์โหลดไฟล์สำรอง |
| POST /api/backup/restore (body = ไฟล์ .json.gz หรือ .json) | staff | กู้คืน ได้ cookie ใหม่กลับมา |

หน้าเว็บ: `GET /staff`, `GET /order`, `GET /qrcode.js`, `GET /img/<ชื่อไฟล์>` (`GET /` redirect ไป `/staff`)
Error ทุกตัวเป็น `{ "error": "ข้อความภาษาไทยที่แสดงให้ผู้ใช้ได้เลย" }`

---

## 6. กฎที่ห้ามทำพัง

แต่ละข้อมีเหตุผลจาก bug จริงที่เคยเกิด และส่วนใหญ่มีเทสต์ครอบอยู่ ถ้าเทสต์ข้อไหนพังหลังแก้ ให้แก้โค้ด ไม่ใช่แก้เทสต์

1. **ราคาคิดฝั่งเซิร์ฟเวอร์เท่านั้น** ห้ามรับ `price` จาก client ตอนสั่งอาหาร
2. **ปิดบิลต้องส่ง `expectedSub`** และเซิร์ฟเวอร์เทียบกับยอดจริง กันลูกค้าสั่งเพิ่มระหว่างพนักงานคิดเงิน
3. **เปลี่ยนสถานะตั๋วต้องส่ง `from`** กันแท็บเล็ตเก่าย้อนสถานะ (ready → cooking)
4. **ห้ามล้างข้อมูลเงียบๆ** ถ้า data.json อ่านไม่ได้ ระบบกู้จาก .bak หรือหยุดทำงาน ห้ามเริ่มใหม่ด้วยข้อมูลว่าง เพราะ `keys` จะถูกสุ่มใหม่ และ QR ที่พิมพ์ไว้จะใช้ไม่ได้ทั้งร้าน
5. **ข้อมูลจากดิสก์หรือไฟล์สำรองต้องผ่าน `normalize()` เสมอ** ระเบียนเสียให้ตัดทิ้งและนับ ไม่ใช่ throw ทั้งระบบ (เคยทำให้หน้าพนักงาน error 500 ถาวร)
6. **ห้ามสุ่ม `D.keys` ใหม่** และห้ามเปลี่ยนรูปแบบ URL `/order?t=&k=` เพราะ QR ถูกพิมพ์ติดโต๊ะไปแล้ว
7. **กู้คืนต้องทำ stage แล้ว swap** และสำรอง `before-restore` ก่อนเสมอ ระหว่างกู้คืนให้ POST อื่นได้ 503
8. **เชื่อ header `CF-Connecting-IP` / `X-Forwarded-For` เฉพาะเมื่อ `TRUST_PROXY=1` และคำขอมาจาก loopback** ไม่อย่างนั้นคนใน WiFi ปลอม header เพื่อเดา PIN ได้ไม่จำกัด
9. **ทุกค่าที่มาจากผู้ใช้ต้องผ่าน `esc()` ก่อนใส่ใน innerHTML** (ชื่อเมนู, memo ลูกค้า, ชื่อร้าน, ชื่อหมวด) ถ้าใช้ `textContent` ได้ให้ใช้
10. **อ่าน body ต้องผ่าน `readBody(req, limit)` / `readRaw(req, limit)`** ห้ามอ่าน stream เอง เกินขนาดแล้วต้องตัดการเชื่อมต่อ
11. **ชื่อไฟล์ทุกชนิดตรวจด้วย regex ใน config** (`IMG_RE`, `BK_RE`, `SALES_RE`) ก่อนแตะดิสก์ กัน path traversal
12. **รูปตรวจจาก magic bytes** (`sniffImage`) ไม่ใช่จาก Content-Type หรือนามสกุล
13. **เขียนไฟล์ข้อมูลผ่าน `writeAtomic`** ถ้าล้ม `state.saveError` ต้องถูกตั้ง และหน้าพนักงานต้องได้ broadcast ป้ายเตือนหายได้เมื่อทั้ง data.json และ sales/ บันทึกได้แล้วเท่านั้น (เคยมีกรณี data.json บันทึกได้แล้วล้างคำเตือนยอดขายทิ้ง บิลจึงหายจาก CSV เงียบๆ)
14. **CSV ต้องผ่าน `q()`** ที่ใส่ `'` นำหน้าค่าที่ขึ้นต้นด้วย `= + - @`
15. **ห้ามเพิ่ม dependency หรือโหลดอะไรจากอินเทอร์เน็ตในหน้าเว็บ** ร้านต้องทำงานได้แม้เน็ตล่ม ใช้แค่ WiFi ภายใน
16. **การกระทำที่ย้อนไม่ได้ในหน้าพนักงานต้องกดสองครั้ง** (`arm()`/`armed()`): ยกเลิกตั๋ว, รับเงิน, ลบเมนู, ลบหมวด, กู้คืน
17. **ห้ามหยุดรอแบบ synchronous ระหว่างระบบเปิดอยู่** (`U.retry`, `sleepSync`, `Atomics.wait`) Node มี thread เดียว ระหว่างรอ ลูกค้าทุกโต๊ะและจอครัวค้างหมด (เคยค้างทั้งระบบ ~0.6 วินาทีทุกครั้งที่บันทึก เมื่อแอนตี้ไวรัสล็อก data.json บน Windows) ให้ใช้ `await U.retryAsync()` หรือตั้ง timer ลองใหม่ `U.retry` ใช้ได้เฉพาะตอนปิดโปรแกรม (`store.writeFinal()`)
18. **ตอบ 200 ได้เมื่อเขียนลงดิสก์แล้วเท่านั้น** `store.save()` เขียนทันที ห้ามกลับไปรวบเขียนทีหลัง (เคย debounce 150 ms: kill -9 20 รอบ ออเดอร์ที่ลูกค้าเห็นว่าส่งแล้วหาย 132 รายการ)
19. **หลังทุก `await` ใน handler ต้องเช็ก `st.restoring`** ใช้ `readBody`/`readRaw` ของ routes.js (ไม่ใช่ของ util) ถ้ามี await อื่นเพิ่ม เรียก `notRestoring()` หลังมัน (เคยตอบ 200 แล้วออเดอร์หายเมื่อกู้คืนเสร็จ)
20. **ข้อมูลชุดเดียวกันเปิดได้ทีละโปรแกรม** ห้ามเอาล็อกใน `lockDataDir()` ออก (เคยเปิดคนละพอร์ตได้ data.json ทับกัน บิลหายและเลขบิลซ้ำ)
21. **เลขบิลห้ามย้อนหรือซ้ำ** กู้คืนใช้ `max(nextBill เดิม, ของไฟล์สำรอง)` และตอนเปิดระบบต้องมากกว่าเลขบิลล่าสุดใน sales/ (ใบเสร็จที่ส่งให้ลูกค้าแล้วย้อนกลับไม่ได้)
22. **ปิดบิลส่ง `expectedSub` ที่จำไว้ตอนกดครั้งแรก** (`S.paySub`) ไม่ใช่ยอดบนปุ่มตอนกดยืนยัน เพราะหน้าจอ re-render ยอดใหม่ใต้นิ้วพนักงานได้ (เคยรับเงิน 132 แต่บันทึก 220)
23. **`reqId` ของลูกค้าเก็บคู่กับตะกร้าใน localStorage** รีเฟรชหน้าแล้วกดใหม่ต้องใช้ reqId เดิม (เคยได้ออเดอร์ซ้ำ)
24. **รหัส QR ผิดเกิน 30 ครั้ง/นาที/IP ได้ 429** ต้องตรวจก่อนเทียบรหัส ไม่อย่างนั้นถูกจำกัดแล้วก็ยังเดาต่อได้
25. **CSV ยกเว้น `'` นำหน้าเฉพาะค่าที่เป็นตัวเลขล้วน** (`-2+3+cmd|...` ขึ้นต้นด้วยตัวเลขแต่เป็นสูตร)
26. **`<input type=file>` ในหน้าพนักงานต้องอยู่นอกส่วนที่ re-render** (`#e-file`, `#rs-file` อยู่ท้าย body, label อ้างด้วย `for`) ไม่อย่างนั้นมีออเดอร์เข้าระหว่างหน้าต่างเลือกไฟล์เปิดอยู่ ไฟล์ที่เลือกหายเงียบๆ
---

## 7. วิธีแก้โค้ดที่ทำบ่อย

### เพิ่ม API ใหม่
1. เพิ่ม key `'METHOD /api/...'` ใน `api` ของ `lib/routes.js`
2. พนักงานเท่านั้น: บรรทัดแรก `requireStaff(req)` | ลูกค้า: `tableNo()` + `checkAccess()`
3. อ่าน body: `const b = await readBody(req, C.BODY_LIMIT)` แล้วค่อยอ้าง `st.D` **หลัง** await
4. ตรวจทุก field ด้วยมือ (ไม่มี schema library) ข้อผิดพลาดใช้ `throw fail('ข้อความไทย', status)`
5. แก้ข้อมูลแล้วเรียก `changed()` (หรือ `menuChanged()` ถ้าแก้เมนู) ส่วนเรื่องเงินเรียก `store.writeNow()` ทันที
6. เพิ่มเทสต์ใน `test/api.test.js`

### เพิ่ม field ในตั้งค่าร้าน
`normalize()` ใน store.js (ค่า default + ตรวจชนิด) → `POST /api/settings` ใน routes.js (validate) → `renderSettings()` และ handler `savesettings` ใน staff.html → เทสต์

### เพิ่ม field ในเมนู
`normalize()` (ส่วน menu.items) → `POST /api/menu/item` → `GET /api/menu` ถ้าลูกค้าต้องเห็น → `editorHtml()`/`saveItem()` ใน staff.html → render ใน customer.html

### แก้หน้าเว็บ
- ไม่มี framework ไม่มี build แก้ไฟล์ HTML แล้ว refresh ได้เลย
- รูปแบบ: state object `S` → ฟังก์ชัน `renderX()` สร้าง HTML string → ปุ่มใช้ `data-a="action"` และมี click handler ตัวเดียวท้ายไฟล์
- หน้าพนักงาน re-render ทุกครั้งที่มี SSE ถ้ามี input ที่ผู้ใช้กำลังพิมพ์ ต้องกันไม่ให้ถูก render ทับ (ดู `S.dirty`, `menuBusy()`, `syncEditor()`)
- สีทั้งหมดเป็น CSS variable รองรับ dark mode ห้ามใส่สีตรงๆ ใน component
- CSS ที่ใช้ `display` ต้องไม่ทับ attribute `hidden` (มี `[hidden]{display:none!important}` อยู่แล้ว ห้ามลบ)

---

## 8. การทดสอบ

```bash
npm test                                         # ทั้งหมด
node --test --test-name-pattern="กู้คืน"           # เฉพาะเคสที่ชื่อมีคำนี้
node --test --test-reporter=spec                 # ดูชื่อเคสทีละบรรทัด
```

- แต่ละ `start()` คัดลอก `server.js`, `lib/`, `public/`, `menu.json` ไปโฟลเดอร์ชั่วคราว แล้ว spawn เซิร์ฟเวอร์พอร์ต 4100 ขึ้นไป จึงไม่แตะข้อมูลจริงของร้าน
- Helper ที่มี: `s.login()`, `s.call(method, path, body)` (มี cookie พนักงาน), `s.guest(...)` (ไม่มี cookie), `upload()`, `getBackup()`, `restoreRaw()`
- เซิร์ฟเวอร์ทุกตัวถูก kill และโฟลเดอร์ชั่วคราวถูกลบใน `after()` แม้เทสต์จะ fail
- **ทดสอบหน้าเว็บ:** ไม่มีใน `npm test` ใช้ `node qa/browser.js all` (Playwright + Edge ติดตั้งแยกใน `qa/`) ดู `qa/README.md`
- **สคริปต์ QA อื่นใน `qa/`:** kill -9/กู้คืน/เปิดซ้อน (`repro.js`), เงิน (`money.js`), ข้อมูล 1 ปี (`perf.js`), หน่วยความจำ (`soak.js`), ข้ามวัน/เดือน (`time.js`), Windows (`windows.js`) ทุกตัวรันกับโค้ดก่อนแก้ได้ด้วย `QA_FROM=<โฟลเดอร์>`
- ชื่อไฟล์ใน `qa/` ห้ามมีคำว่า `test` เพราะ `node --test` จะหยิบไปรันใน `npm test`
- ตรวจ syntax ของ JS ในไฟล์ HTML: ดึงเนื้อหาใน `<script>` ตัวสุดท้ายออกมาแล้ว `node --check`

---

## 9. แก้ปัญหาที่พบบ่อย

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| `[เริ่มระบบไม่ได้] ระบบเปิดอยู่แล้วในอีกหน้าต่างหนึ่ง` | เปิดซ้อนบนข้อมูลชุดเดียวกัน ใช้หน้าต่างเดิม ห้ามแก้ด้วยการเปลี่ยน `PORT` |
| `[เริ่มระบบไม่ได้] พอร์ต 3000 ถูกใช้อยู่` | มีโปรแกรมอื่นใช้พอร์ตนี้ ปิดโปรแกรมนั้น หรือใช้ `PORT=3001` (ใช้ได้เพราะข้อมูลถูกล็อกไว้แล้ว เปิดซ้อนบนข้อมูลเดียวกันไม่ได้) |
| โฟลเดอร์ชื่อแปลกๆ เช่น `α╕¬α╕│...` โผล่ใน DATA_DIR/BACKUP_DIR | start.bat มีภาษาไทยแต่ไม่มี `chcp 65001 >nul` บรรทัดที่สอง cmd อ่านชื่อโฟลเดอร์เพี้ยน ไฟล์สำรองจึงไม่ไปถึง Google Drive |
| `[เริ่มระบบไม่ได้] menu.json มีปัญหา` | เกิดเฉพาะตอนยังไม่มี data.json ข้อความบอกว่าผิดที่เมนูไหน |
| `! data.json เสียหาย` แล้วระบบเปิดได้ | กู้จาก .bak แล้ว (ข้อมูล ณ ตอนเปิดครั้งก่อน) ถ้าต้องการใหม่กว่านั้นให้กู้จาก backups/ ผ่านหน้าตั้งค่า |
| `กู้คืนข้อมูลไม่ได้ ระบบหยุด...` | ทั้ง data.json และ .bak เสีย ย้าย data.json ออก เปิดระบบ แล้วกู้คืนจากไฟล์ใน backups/ (ระบบจะสร้างรหัส QR ชั่วคราวใหม่ แต่กู้คืนแล้วรหัสเดิมจะกลับมา) |
| ป้ายแดง "บันทึกข้อมูลลงเครื่องไม่สำเร็จ" | ดิสก์เต็ม หรือมีโปรแกรมล็อกไฟล์ (มักเป็นโปรแกรม sync) ข้อมูลยังอยู่ในหน่วยความจำ ระบบลองบันทึกใหม่เองเรื่อยๆ (สูงสุดทุก 5 วินาที) ป้ายหายเองเมื่อสำเร็จ อย่าปิดโปรแกรม ถ้าจำเป็นต้องปิด บิลที่ยังไม่ลง sales/ จะถูกเติมให้ตอนเปิดครั้งหน้า (ถ้า data.json บันทึกได้) |
| ลูกค้าสแกน QR แล้วเปิดไม่ได้ | QR ชี้ localhost หรือ IP เก่า → แก้ "ที่อยู่เว็บที่ใส่ใน QR" / มือถือไม่ได้ต่อ WiFi ร้าน / ไฟร์วอลล์ของเครื่องบล็อกพอร์ต |
| ลูกค้าเห็น "QR ของโต๊ะไม่ถูกต้อง" | รหัสใน QR ไม่ตรงกับ `D.keys` เช่น data.json ถูกลบแล้วสร้างใหม่ → กู้คืนจากไฟล์สำรอง หรือพิมพ์ QR ใหม่ |
| ไม่มีเสียงแจ้งเตือนในครัว | เบราว์เซอร์ต้องการให้แตะหน้าจอหนึ่งครั้งก่อน มีป้ายเหลืองบอกอยู่ |
| อยากให้ลูกค้าใช้เน็ตมือถือ | ต้องตั้ง Cloudflare Tunnel (cloudflared บนเครื่องเดียวกัน) + `TRUST_PROXY=1` + PIN ≥ 6 หลัก ยังไม่มีโหมดพนักงานยืนยันออเดอร์ ควรทำก่อนเปิดใช้แบบนี้ |

---

## 10. ข้อจำกัดที่รู้อยู่และงานที่ยังไม่ได้ทำ

- ยกเลิกทีละรายการในตั๋ว, ย้าย/รวมโต๊ะ, ส่วนลด, ยกเลิกบิลที่ปิดแล้ว
- ตัวเลือกเสริมที่มีราคา (เพิ่มไข่ +10) และขนาด (ธรรมดา/พิเศษ)
- โหมดราคารวม VAT และใบกำกับภาษีเต็มรูป
- แยกสิทธิ์ครัว/แคชเชียร์/เจ้าของ (ตอนนี้ PIN เดียว)
- โหมดพนักงานยืนยันออเดอร์ก่อนเข้าครัว (ควรมีก่อนเปิดออกอินเทอร์เน็ต)
- เครื่องพิมพ์ใบสั่งในครัว (ตอนนี้พิมพ์ใบเสร็จผ่าน `window.print()` ขนาด 80 mm ได้)
- ชุดทดสอบผ่านบน Windows 11 (Node 24) แล้ว แต่ยังไม่ได้ลองกับแอนตี้ไวรัสหรือโปรแกรม sync ที่ล็อกไฟล์จริง ยังไม่ได้รันบน Linux/macOS (ล็อกโฟลเดอร์ข้อมูลบน macOS ใช้ไฟล์ socket ใน tmp)
- แยกจ่ายปัดขึ้นทีละคน (`Math.ceil`) เก็บรวมเกินยอดได้ไม่เกิน (จำนวนคน − 1) บาท เช่น 100 บาท 3 คน เก็บคนละ 34
- เขียน data.json ไม่ได้ fsync ก่อน rename ไฟดับจริง (ไม่ใช่โปรแกรมดับ) อาจได้ไฟล์ว่าง จะกู้จาก .bak เอง
- ถ้าอัปโหลดไฟล์เกินขนาด เซิร์ฟเวอร์ตอบ 413 แล้วตัดการเชื่อมต่อทันที บน Windows client อาจเห็นแค่ "เชื่อมต่อไม่ได้" แทนข้อความ 413 (หน้าพนักงานย่อรูปเหลือ ≤ 900 px ก่อนส่งจึงแทบไม่เจอ)
- `/api/state` ส่งข้อมูลทั้งก้อนทุกครั้งที่มีการเปลี่ยนแปลง เหมาะกับร้านเล็กถึงกลาง (หลักสิบโต๊ะ) ถ้าใหญ่กว่านี้ควรส่งแบบ diff
