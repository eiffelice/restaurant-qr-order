# qa/ · สคริปต์ทดสอบที่ไม่อยู่ใน `npm test`

ระบบหลักไม่ใช้อะไรในโฟลเดอร์นี้ `npm test` ที่โฟลเดอร์หลักรันได้โดยไม่ต้องติดตั้งอะไร
ทุกสคริปต์คัดลอกระบบไปโฟลเดอร์ชั่วคราว ไม่แตะข้อมูลจริงของร้าน

```bash
cd qa && npm install && cd ..        # ครั้งแรก เฉพาะ browser.js (playwright-core ใช้ Microsoft Edge ที่มีในเครื่อง)

node qa/repro.js all       # kill -9 20 รอบ, เลขบิลซ้ำ, ออเดอร์ระหว่างกู้คืน, CSV injection, เดารหัส QR, เปิดซ้อน   ~20 วินาที
node qa/browser.js all     # เบราว์เซอร์จริง: ปิดบิลตอนยอดเปลี่ยน, reqId หลังรีเฟรช, XSS, จำลองหนึ่งวัน 390px light/dark รีสตาร์ท   ~2 นาที
node qa/money.js           # เงินทุกกรณี + PromptPay QR                                               ~5 วินาที
node qa/perf.js            # ข้อมูล 1 ปี: event loop lag, เวลาตอบ, ขนาดไฟล์สำรอง, 200 ออเดอร์จาก 40 IP   ~30 วินาที
node qa/time.js            # ข้ามเที่ยงคืนและข้ามเดือน (นาฬิกาปลอมด้วย fake-time.js)                  ~15 วินาที
node qa/windows.js         # Windows: path ภาษาไทย+ช่องว่าง, start.bat, ลบไฟล์สำรองเก่า, เปิดซ้อน         ~10 วินาที
node qa/soak.js 30         # หน่วยความจำ 30 นาที (ผลใน qa/out/soak-heap.jsonl)
```

- รันกับโค้ดก่อนแก้เพื่อดูว่าบั๊กเกิดจริง: `QA_FROM=<โฟลเดอร์โค้ดเดิม> node qa/repro.js all`
- `QA_BROWSER=chrome` ใช้ Chrome แทน Edge, `QA_HEADED=1` เห็นหน้าต่างเบราว์เซอร์
- ภาพหน้าจอ 390 px อยู่ใน `qa/out/`
- preload ที่ใช้วัดโดยไม่แก้โค้ดระบบ: `lag-probe.js` (event loop lag), `heap-probe.js` (หน่วยความจำ), `fake-time.js` (นาฬิกา)
- ห้ามตั้งชื่อไฟล์ในโฟลเดอร์นี้ให้มีคำว่า `test` เพราะ `node --test` จะหยิบไปรัน
