'use strict';
// preload (node -r) ให้นาฬิกาของเซิร์ฟเวอร์เริ่มที่ FAKE_NOW แล้วเดินต่อตามจริง โดยไม่แก้โค้ดระบบ
if (process.env.FAKE_NOW) {
  const Real = Date, off = Real.parse(process.env.FAKE_NOW) - Real.now();
  class FakeDate extends Real {
    constructor(...a) { if (a.length) super(...a); else super(Real.now() + off); }
    static now() { return Real.now() + off; }
  }
  global.Date = FakeDate;
}
