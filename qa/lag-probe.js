'use strict';
// preload (node -r) วัด event loop lag ของเซิร์ฟเวอร์ ทุก 250 ms เขียนค่าสูงสุดของช่วงนั้นลงไฟล์ โดยไม่แก้โค้ดระบบ
const fs = require('fs');
const { monitorEventLoopDelay } = require('perf_hooks');
const out = process.env.LAG_LOG;
if (out) {
  const h = monitorEventLoopDelay({ resolution: 5 }); h.enable();
  setInterval(() => { fs.appendFileSync(out, Date.now() + ' ' + (h.max / 1e6).toFixed(1) + '\n'); h.reset(); }, 250).unref();
}
