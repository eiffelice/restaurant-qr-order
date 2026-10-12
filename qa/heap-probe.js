'use strict';
// preload (node -r) บันทึกหน่วยความจำของเซิร์ฟเวอร์ทุก 10 วินาที โดยไม่แก้โค้ดระบบ
// ต้องรันด้วย --expose-gc เพื่อเก็บค่าหลัง GC ซึ่งบอกการรั่วได้ชัดกว่า
const fs = require('fs');
const out = process.env.HEAP_LOG;
if (out) {
  setInterval(() => {
    if (global.gc) global.gc();
    const m = process.memoryUsage();
    fs.appendFileSync(out, JSON.stringify({ t: Date.now(), rss: m.rss, heap: m.heapUsed, ext: m.external }) + '\n');
  }, 10000).unref();
}
