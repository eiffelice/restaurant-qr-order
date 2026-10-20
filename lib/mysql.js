'use strict';
/* ตัวเชื่อม MySQL / MariaDB แบบไม่ต้องติดตั้งอะไรเพิ่ม (ใช้แค่ net, tls, crypto ของ Node)
   ทำเท่าที่ระบบสำเนาข้อมูล (lib/mirror.js) ใช้: เข้าสู่ระบบ (mysql_native_password, caching_sha2_password, sha256_password,
   mysql_clear_password เฉพาะผ่าน TLS) เข้ารหัส TLS ส่งคำสั่ง SQL ทีละคำสั่ง (ไม่เปิด multi statements) และอ่านผลเป็นข้อความ
   ค่าที่ใส่ใน SQL ต้องผ่าน lit() เสมอ ห้ามต่อข้อความจากผู้ใช้ตรงๆ
   ไม่รับคำขอไฟล์จากเซิร์ฟเวอร์ (LOAD DATA LOCAL) และจำกัดขนาดข้อมูลที่รับ กันเซิร์ฟเวอร์ปลอมอ่านไฟล์หรือทำหน่วยความจำเต็ม */
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const CAP = {
  LONG_PASSWORD: 0x1, FOUND_ROWS: 0x2, LONG_FLAG: 0x4, CONNECT_WITH_DB: 0x8, PROTOCOL_41: 0x200, SSL: 0x800, TRANSACTIONS: 0x2000,
  SECURE_CONNECTION: 0x8000, PLUGIN_AUTH: 0x80000, PLUGIN_AUTH_LENENC: 0x200000
};
const CHARSET = 45;                    // utf8mb4_general_ci มีทั้ง MySQL และ MariaDB (ภาษาไทย อีโมจิ)
const MAX_PACKET = 64 * 1024 * 1024;   // ผลลัพธ์ใหญ่กว่านี้ถือว่าผิดปกติ ตัดการเชื่อมต่อ
const sha1 = b => crypto.createHash('sha1').update(b).digest();
const sha256 = b => crypto.createHash('sha256').update(b).digest();
function xor(a, b) { const o = Buffer.alloc(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] ^ b[i % b.length]; return o; }

/* ---------- รหัสผ่าน (ไม่ส่งตัวรหัสผ่านออกไปตรงๆ ยกเว้นผ่าน TLS) ---------- */
function nativeScramble(pw, nonce) {
  if (!pw.length) return Buffer.alloc(0);
  const h1 = sha1(pw);
  return xor(h1, sha1(Buffer.concat([nonce, sha1(h1)])));
}
function sha2Scramble(pw, nonce) {
  if (!pw.length) return Buffer.alloc(0);
  const h1 = sha256(pw);
  return xor(h1, sha256(Buffer.concat([sha256(h1), nonce])));
}
function rsaPassword(pw, nonce, pem) {
  return crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, xor(Buffer.concat([pw, Buffer.from([0])]), nonce));
}

/* ---------- อ่านข้อมูลในแพ็กเก็ต ---------- */
class Reader {
  constructor(b) { this.b = b; this.p = 0; }
  u8() { if (this.p >= this.b.length) throw protoErr(); return this.b[this.p++]; }
  u16() { const v = this.b.readUInt16LE(this.p); this.p += 2; return v; }
  u32() { const v = this.b.readUInt32LE(this.p); this.p += 4; return v; }
  lenc() {
    const f = this.u8();
    if (f < 0xfb) return f;
    if (f === 0xfb) return null;
    if (f === 0xfc) return this.u16();
    if (f === 0xfd) { const v = this.b.readUIntLE(this.p, 3); this.p += 3; return v; }
    if (f === 0xfe) { const lo = this.b.readUInt32LE(this.p), hi = this.b.readUInt32LE(this.p + 4); this.p += 8; return hi * 4294967296 + lo; }
    throw protoErr();
  }
  bytes(n) { if (this.p + n > this.b.length) throw protoErr(); const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
  lstr() { const n = this.lenc(); return n === null ? null : this.bytes(n).toString('utf8'); }
  zstr() { const e = this.b.indexOf(0, this.p), end = e < 0 ? this.b.length : e, s = this.b.toString('utf8', this.p, end); this.p = end + 1; return s; }
  rest() { const v = this.b.subarray(Math.min(this.p, this.b.length)); this.p = this.b.length; return v; }
}
function lencBuf(n) {
  if (n < 0xfb) return Buffer.from([n]);
  if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = 0xfc; b.writeUInt16LE(n, 1); return b; }
  const b = Buffer.alloc(4); b[0] = 0xfd; b.writeUIntLE(n, 1, 3); return b;
}
function protoErr() { return Object.assign(new Error('ข้อมูลจากเซิร์ฟเวอร์ MySQL ผิดรูปแบบ'), { code: 'PROTOCOL' }); }
function serverErr(p) {
  const r = new Reader(p); r.u8();
  const errno = r.u16();
  let sqlState = '';
  if (p[r.p] === 0x23) { r.p++; sqlState = r.bytes(5).toString(); }
  return Object.assign(new Error(r.rest().toString('utf8').slice(0, 300)), { errno, sqlState, code: 'ER_' + errno });
}
const isEOF = p => p[0] === 0xfe && p.length < 9;

class Connection {
  constructor(sock) {
    this.queue = []; this.waiting = null; this.err = null; this.seq = 0; this.buf = Buffer.alloc(0); this.parts = []; this.partLen = 0;
    this.busy = false; this.tls = false; this.serverVersion = ''; this.raw = sock;
    this.attach(sock);
  }
  get dead() { return !!this.err; }
  attach(sock) {
    this.sock = sock;
    sock.on('data', d => this.onData(d));
    sock.on('error', e => this.fatal(e));
    sock.on('close', () => this.fatal(Object.assign(new Error('การเชื่อมต่อ MySQL ถูกตัด'), { code: 'CLOSED' })));
  }
  onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 4) {
      const len = this.buf.readUIntLE(0, 3);
      if (this.partLen + len > MAX_PACKET) return this.fatal(Object.assign(new Error('ข้อมูลจาก MySQL ใหญ่ผิดปกติ ตัดการเชื่อมต่อ'), { code: 'PROTOCOL' }));
      if (this.buf.length < 4 + len) break;
      this.seq = this.buf[3];
      this.parts.push(this.buf.subarray(4, 4 + len)); this.partLen += len;
      this.buf = this.buf.subarray(4 + len);
      if (len === 0xffffff) continue;          // แพ็กเก็ตยาวกว่า 16 MB ส่งต่อเป็นหลายชิ้น
      this.queue.push(this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts));
      this.parts = []; this.partLen = 0;
    }
    if (this.waiting && this.queue.length) { const w = this.waiting; this.waiting = null; w.resolve(this.queue.shift()); }
  }
  fatal(e) {
    if (!this.err) this.err = e;
    if (this.waiting) { const w = this.waiting; this.waiting = null; w.reject(this.err); }
    if (this.tlsFail && !this.tls) { const f = this.tlsFail; this.tlsFail = null; f(this.err); }
    this.sock.destroy(); this.raw.destroy();
  }
  read() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.err) return Promise.reject(this.err);
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject }; });
  }
  write(payload) {
    if (this.err) throw this.err;
    for (let off = 0; ;) {
      const n = Math.min(0xffffff, payload.length - off), h = Buffer.alloc(4);
      h.writeUIntLE(n, 0, 3); this.seq = (this.seq + 1) & 0xff; h[3] = this.seq;
      this.sock.write(Buffer.concat([h, payload.subarray(off, off + n)]));
      off += n;
      if (n < 0xffffff) break;
    }
  }
  close() {
    if (this.err) return;
    try { this.seq = -1; this.write(Buffer.from([0x01])); } catch (e) { /* ignore */ }   // COM_QUIT
    this.fatal(Object.assign(new Error('ปิดการเชื่อมต่อแล้ว'), { code: 'CLOSED' }));
  }

  async handshake(o) {
    const p = await this.read();
    if (p[0] === 0xff) throw serverErr(p);
    const r = new Reader(p);
    if (r.u8() !== 10) throw Object.assign(new Error('เซิร์ฟเวอร์นี้ไม่ใช่ MySQL/MariaDB ที่รองรับ'), { code: 'PROTOCOL' });
    this.serverVersion = r.zstr(); r.u32();
    let nonce = Buffer.from(r.bytes(8)); r.u8();
    let caps = r.u16(), plugin = 'mysql_native_password';
    if (r.p < p.length) {
      r.u8(); r.u16(); caps = (caps | (r.u16() << 16)) >>> 0;
      const alen = r.u8(); r.bytes(10);
      if (caps & CAP.SECURE_CONNECTION) nonce = Buffer.concat([nonce, r.bytes(Math.max(13, alen - 8)).subarray(0, 12)]);
      if (caps & CAP.PLUGIN_AUTH) plugin = r.zstr();
    }
    if (!(caps & CAP.PROTOCOL_41) || !(caps & CAP.SECURE_CONNECTION)) throw Object.assign(new Error('MySQL รุ่นนี้เก่าเกินไป (ต้องเป็น MySQL 5.7 / MariaDB 10.2 ขึ้นไป)'), { code: 'PROTOCOL' });
    let flags = CAP.LONG_PASSWORD | CAP.FOUND_ROWS | CAP.LONG_FLAG | CAP.PROTOCOL_41 | CAP.TRANSACTIONS | CAP.SECURE_CONNECTION | CAP.PLUGIN_AUTH | CAP.PLUGIN_AUTH_LENENC;
    if (o.database) flags |= CAP.CONNECT_WITH_DB;
    if (o.ssl) flags |= CAP.SSL;
    flags = (flags & caps) >>> 0;
    const head = Buffer.alloc(32);
    head.writeUInt32LE(flags, 0); head.writeUInt32LE(16 * 1024 * 1024, 4); head[8] = CHARSET;
    if (o.ssl) {
      if (!(caps & CAP.SSL)) throw Object.assign(new Error('เซิร์ฟเวอร์ MySQL นี้ไม่ได้เปิดการเข้ารหัส (SSL/TLS) แต่ MYSQL_URL ตั้ง ssl ไว้'), { code: 'NO_SSL' });
      this.write(head);
      await this.startTls(o);
    }
    const pw = Buffer.from(o.password || '', 'utf8');
    const answer = (name, n) => {
      if (name === 'mysql_native_password') return nativeScramble(pw, n);
      if (name === 'caching_sha2_password') return sha2Scramble(pw, n);
      if (name === 'sha256_password') return this.tls ? Buffer.concat([pw, Buffer.from([0])]) : pw.length ? Buffer.from([1]) : Buffer.alloc(0);
      if (name === 'mysql_clear_password' && this.tls) return Buffer.concat([pw, Buffer.from([0])]);
      throw Object.assign(new Error('MySQL ขอวิธียืนยันตัวตนแบบ ' + name + ' ซึ่งระบบยังไม่รองรับ ให้สร้างผู้ใช้ด้วย caching_sha2_password หรือ mysql_native_password' +
        (name === 'mysql_clear_password' ? ' (หรือเปิด ssl ก่อน)' : '')), { code: 'AUTH_PLUGIN' });
    };
    const auth = answer(plugin, nonce);
    const parts = [head, Buffer.from((o.user || '') + '\0', 'utf8')];
    parts.push(flags & CAP.PLUGIN_AUTH_LENENC ? lencBuf(auth.length) : Buffer.from([auth.length]), auth);
    if (flags & CAP.CONNECT_WITH_DB) parts.push(Buffer.from(o.database + '\0', 'utf8'));
    if (flags & CAP.PLUGIN_AUTH) parts.push(Buffer.from(plugin + '\0'));
    this.write(Buffer.concat(parts));
    for (let rounds = 0; rounds < 6; rounds++) {
      const q = await this.read();
      if (q[0] === 0x00) return;
      if (q[0] === 0xff) throw serverErr(q);
      if (q[0] === 0xfe) {                     // เซิร์ฟเวอร์ขอเปลี่ยนวิธียืนยันตัวตน
        const s = new Reader(q); s.u8();
        plugin = s.zstr(); nonce = Buffer.from(s.rest().subarray(0, 20));
        this.write(answer(plugin, nonce));
        continue;
      }
      if (q[0] === 0x01) {                     // caching_sha2 / sha256: ขั้นต่อไป
        const d = q.subarray(1);
        if (d.length === 1 && d[0] === 0x03) continue;                 // จำรหัสไว้แล้ว รอ OK
        if (d.length === 1 && d[0] === 0x04) {                         // ต้องยืนยันเต็ม: ผ่าน TLS ส่งรหัสได้ ไม่มี TLS ขอกุญแจ RSA
          this.write(this.tls ? Buffer.concat([pw, Buffer.from([0])]) : Buffer.from([0x02]));
          continue;
        }
        if (d.toString('latin1', 0, 10) === '-----BEGIN') { this.write(rsaPassword(pw, nonce, d.toString('latin1'))); continue; }
      }
      throw protoErr();
    }
    throw protoErr();
  }
  startTls(o) {
    return new Promise((resolve, reject) => {
      const raw = this.sock;
      raw.removeAllListeners('data'); raw.removeAllListeners('close');
      const t = tls.connect({
        socket: raw, host: o.host, servername: net.isIP(o.host) ? undefined : o.host, ca: o.ssl.ca || undefined, minVersion: 'TLSv1.2',
        rejectUnauthorized: true, checkServerIdentity: o.ssl.verify === 'ca' ? () => undefined : tls.checkServerIdentity
      });
      const fail = e => { t.removeAllListeners('secureConnect'); reject(e || Object.assign(new Error('การเชื่อมต่อ MySQL ถูกตัดระหว่างเริ่มเข้ารหัส'), { code: 'CLOSED' })); };
      t.once('secureConnect', () => { this.tls = true; t.removeListener('error', fail); t.removeListener('close', fail); this.attach(t); resolve(); });
      t.once('error', fail); t.once('close', () => fail());
      this.tlsFail = fail;                     // หมดเวลาระหว่างเริ่มเข้ารหัส: fatal() เรียกตัวนี้ ไม่ค้างรอ
    });
  }

  // ส่ง SQL หนึ่งคำสั่ง ได้ { rows: [{คอลัมน์: ข้อความ|null}], affected } (affected = แถวที่ตรงเงื่อนไข ไม่ใช่แค่แถวที่ค่าเปลี่ยน) ค้างเกิน timeout = ตัดการเชื่อมต่อ (ต่อใหม่รอบหน้า)
  async query(sql, timeout) {
    if (this.busy) throw new Error('query ซ้อนกัน');
    this.busy = true;
    const timer = setTimeout(() => this.fatal(Object.assign(new Error('MySQL ไม่ตอบภายใน ' + Math.round((timeout || 60000) / 1000) + ' วินาที'), { code: 'ETIMEDOUT' })), timeout || 60000);
    try {
      this.seq = -1;
      this.write(Buffer.concat([Buffer.from([0x03]), Buffer.from(sql, 'utf8')]));
      const first = await this.read();
      if (first[0] === 0x00) { const r = new Reader(first); r.u8(); return { rows: [], affected: r.lenc() }; }
      if (first[0] === 0xff) throw serverErr(first);
      if (first[0] === 0xfb) {               // เซิร์ฟเวอร์ขอไฟล์จากเครื่องนี้: ส่งว่างกลับ ไม่ให้อะไรออกไป
        this.write(Buffer.alloc(0));
        await this.read();
        throw Object.assign(new Error('เซิร์ฟเวอร์ MySQL ขออ่านไฟล์จากเครื่องนี้ ระบบไม่อนุญาต'), { code: 'PROTOCOL' });
      }
      const n = new Reader(first).lenc(), cols = [];
      for (let i = 0; i < n; i++) { const r = new Reader(await this.read()); r.lstr(); r.lstr(); r.lstr(); r.lstr(); cols.push(r.lstr()); }
      if (!isEOF(await this.read())) throw protoErr();
      const rows = [];
      for (;;) {
        const p = await this.read();
        if (isEOF(p)) break;
        if (p[0] === 0xff) throw serverErr(p);
        const r = new Reader(p), row = {};
        for (let i = 0; i < n; i++) row[cols[i]] = r.lstr();
        rows.push(row);
      }
      return { rows, affected: 0 };
    } finally { clearTimeout(timer); this.busy = false; }
  }
}

// o = { host, port, user, password, database, ssl: null | { ca, verify: 'identity'|'ca' }, timeout }
function connect(o) {
  const sock = net.connect({ host: o.host, port: o.port || 3306 });
  sock.setNoDelay(true); sock.setKeepAlive(true, 30000);
  const c = new Connection(sock);
  const timer = setTimeout(() => c.fatal(Object.assign(new Error('เชื่อมต่อ MySQL ไม่ได้ภายใน ' + Math.round((o.timeout || 15000) / 1000) + ' วินาที'), { code: 'ETIMEDOUT' })), o.timeout || 15000);
  return c.handshake(o).then(() => { clearTimeout(timer); return c; }, e => { clearTimeout(timer); c.fatal(e); throw e; });
}

// ค่าใน SQL: ตัวเลข/NULL/ข้อความ ข้อความใส่ ' ซ้อน (ใช้ได้ทั้งสองโหมด backslash) และ escape \ กับ NUL
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return isFinite(v) ? String(v) : 'NULL';
  return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\0/g, '\\0') + "'";
}

// ข้อความ error ที่เจ้าของร้านอ่านเข้าใจและรู้ว่าต้องแก้ตรงไหน (ไม่มีรหัสผ่าน)
function explain(e, o) {
  const at = o.host + ':' + o.port;
  const c = e && e.code, m = String(e && e.message || e);
  if (c === 'ECONNREFUSED') return 'เชื่อมต่อ MySQL ที่ ' + at + ' ไม่ได้ (เครื่องนั้นไม่ได้เปิด MySQL หรือพอร์ตผิด)';
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return 'ไม่พบเครื่อง ' + o.host + ' (ตรวจชื่อเครื่องใน MYSQL_URL หรืออินเทอร์เน็ต)';
  if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH' || c === 'ETIMEDOUT') return 'ติดต่อ MySQL ที่ ' + at + ' ไม่ได้ (อินเทอร์เน็ต ไฟร์วอลล์ หรือเครื่องปิดอยู่) ' + (c === 'ETIMEDOUT' ? m : '');
  if (c === 'ECONNRESET' || c === 'CLOSED' || c === 'EPIPE') return 'การเชื่อมต่อ MySQL ถูกตัดกลางทาง จะลองใหม่เอง';
  if (e && e.errno === 1045) return 'ชื่อผู้ใช้หรือรหัสผ่าน MySQL ไม่ถูกต้อง (' + m + ')';
  if (e && e.errno === 1049) return 'ไม่พบฐานข้อมูล ' + o.database + ' ใน MySQL สร้างก่อนด้วย CREATE DATABASE (ดู README)';
  if (e && (e.errno === 1044 || e.errno === 1142 || e.errno === 1227)) return 'ผู้ใช้ MySQL ไม่มีสิทธิ์พอ ให้ GRANT ตามคำสั่งใน README (' + m + ')';
  if (e && e.errno === 1130) return 'MySQL ไม่อนุญาตให้เครื่องนี้เชื่อมต่อ (' + m + ')';
  if (e && e.errno === 3159) return 'MySQL ต้องใช้การเชื่อมต่อแบบเข้ารหัส เพิ่ม ?ssl=1 ท้าย MYSQL_URL';
  if (c && /CERT|SELF_SIGNED|UNABLE_TO|ALTNAME|ERR_TLS/.test(c)) return 'ตรวจใบรับรอง (certificate) ของ MySQL ไม่ผ่าน: ' + m + ' · ตั้ง MYSQL_CA เป็นไฟล์ CA ของเซิร์ฟเวอร์ หรือใช้ ?ssl=verify-ca ถ้าชื่อในใบรับรองไม่ตรงกับชื่อเครื่อง';
  if (e && e.errno) return 'MySQL ตอบว่า: ' + m + ' (รหัส ' + e.errno + ')';
  return m;
}

module.exports = { connect, lit, explain, nativeScramble, sha2Scramble };
