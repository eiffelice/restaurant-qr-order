# qa/ · สคริปต์ทดสอบที่ไม่อยู่ใน `npm test`

ระบบหลักไม่ใช้อะไรในโฟลเดอร์นี้ `npm test` ที่โฟลเดอร์หลักรันได้โดยไม่ต้องติดตั้งอะไร
ทุกสคริปต์คัดลอกระบบไปโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริงของร้าน

```bash
cd qa && npm install && cd ..        # ครั้งแรก เฉพาะ browser.js (playwright-core ใช้ Microsoft Edge ที่มีในเครื่อง)

node qa/repro.js all       # kill -9 20 รอบ, เลขบิลซ้ำ, ออเดอร์ระหว่างกู้คืน, CSV injection, เดารหัส QR, เปิดซ้อน   ~20 วินาที
node qa/shots.js          # ภาพหน้าจอทุกจอ (พนักงาน 1440/1024/390, ลูกค้า 390/768, เมนูหมด, ร้านปิดรับ, ธีมสี) light/dark ใน qa/out/shots/ ไม่มี assert ~3 นาที
node qa/docs-shots.js     # ภาพหน้าจอ 34 ภาพที่ใช้ใน README (docs/screenshots/) ข้อมูลร้านตัวอย่างสมจริง ~1 นาที (SHOTS_ONLY=staff = เฉพาะหน้าพนักงาน)
node qa/staff-shots.js    # หน้าพนักงานทุกแท็บ 1440/1180/768/390 px light/dark + หน้าเข้าสู่ระบบ ค้นหา (Ctrl+K) แก้เมนู รับเงินสด หลังปิดบิล ใน qa/out/staff/ ไม่มี assert ~1 นาที
node qa/browser.js all     # เบราว์เซอร์จริง: ปิดบิลตอนยอดเปลี่ยน, เงินทอน+ประวัติการแก้ไข, reqId หลังรีเฟรช, เลือกไฟล์, XSS, จำลองหนึ่งวัน 390px light/dark รีสตาร์ท, หน้าลูกค้า (รายละเอียด หมายเหตุแยกแถว ปุ่ม back เมนูหมดระหว่างเปิด ตะกร้าแบบเดิม 360/768px), ธีมร้าน (สี โลโก้), เกณฑ์ตรวจรับ (320px ราคาเปลี่ยน เน็ตหลุด ยกเลิกออเดอร์) ~5 นาที
node qa/fuzz.js 40        # fuzz ทุก API ทุกบทบาท ข้อมูลผิดรูปแบบ (ชนิดผิด ค่าสุดโต่ง JSON เสีย content-type ผิด) ไม่มี 5xx ข้อมูลไม่เสีย  ~1 นาที (FUZZ_SEED=… ซ้ำชุดเดิม)
node qa/upgrade.js <โค้ดเก่า>  # อัปเดตร้านที่ใช้อยู่: วางโค้ดใหม่ทับข้อมูลเวอร์ชันเก่า QR/ออเดอร์/เลขบิล/PIN/log/ไฟล์สำรองต้องไม่เสีย (git worktree add ../old main)
node qa/money.js           # เงินทุกกรณี + PromptPay QR                                               ~5 วินาที
node qa/perf.js            # ข้อมูล 1 ปี: event loop lag, เวลาตอบ, ขนาดไฟล์สำรอง, 200 ออเดอร์จาก 40 IP   ~30 วินาที
node qa/time.js            # ข้ามเที่ยงคืนและข้ามเดือน + เวลาเปิดปิดร้านข้ามเที่ยงคืน (นาฬิกาปลอมด้วย fake-time.js)                  ~15 วินาที
node qa/windows.js         # Windows: path ภาษาไทย+ช่องว่าง, start.bat, ลบไฟล์สำรองเก่า, เปิดซ้อน         ~10 วินาที
node qa/soak.js 30         # หน่วยความจำ 30 นาที (ผลใน qa/out/soak-heap.jsonl)
node qa/audit-load.js      # audit log ปลายเดือน 45,000 บรรทัด: เปิดสรุปยอดแล้วระบบต้องไม่ค้าง                     ~10 วินาที
node qa/explore.js         # สำรวจ: ชื่อยาว, พิมพ์ใบเสร็จ/QR, 60 โต๊ะ, ลดโต๊ะตอนลูกค้าเปิดหน้า, แก้เมนูพร้อมกัน, เพิ่มโต๊ะ   ~30 วินาที
node qa/a11y.js            # WCAG 2.2 AA ด้วย axe-core ทุกแท็บ light/dark + ใช้คีย์บอร์ดอย่างเดียว         ~30 วินาที
```

- รันกับโค้ดก่อนแก้เพื่อดูว่าบั๊กเกิดจริง: `QA_FROM=<โฟลเดอร์โค้ดเดิม> node qa/repro.js all`
- `QA_BROWSER=chrome` ใช้ Chrome แทน Edge, `QA_HEADED=1` เห็นหน้าต่างเบราว์เซอร์
- Linux/เครื่องที่ไม่มี Edge: `QA_CHROMIUM=/path/to/chrome` ใช้ Chromium ไฟล์นั้น (เช่น `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`) ภาพหน้าจอภาษาไทยต้องมีฟอนต์ไทยในเครื่อง (Noto Sans Thai) ไม่อย่างนั้นเป็นกล่องสี่เหลี่ยม
  - Chromium บน Linux + playwright-core 1.64: ชื่อไฟล์ที่ดาวน์โหลดจาก blob ได้ `download` แทน `QR-โต๊ะ-5.png` (เคส `qrfiles` ข้อแรกล้มทั้งโค้ดเก่าและใหม่ ไฟล์ข้างในถูกต้อง) บน Windows + Edge ผ่าน
- ภาพหน้าจอ 390 px อยู่ใน `qa/out/`
- preload ที่ใช้วัดโดยไม่แก้โค้ดระบบ: `lag-probe.js` (event loop lag), `heap-probe.js` (หน่วยความจำ), `fake-time.js` (นาฬิกา)
- ห้ามตั้งชื่อไฟล์ในโฟลเดอร์นี้ให้มีคำว่า `test` เพราะ `node --test` จะหยิบไปรัน
