'use strict';
/* ธีมร้าน: เจ้าของเลือกสีปุ่มหลักสีเดียว ระบบคำนวณสีที่เหลือให้ตัวหนังสือผ่าน WCAG AA เสมอ
   - --accent       พื้นปุ่มหลัก (สีที่เลือก โหมดมืดถ้าเข้มจนกลืนพื้นจะสว่างขึ้นให้เอง)
   - --accent-line  ขอบปุ่มหลัก (สีอ่อนอย่างเหลืองยังเห็นขอบบนพื้นขาว)
   - --accent-ink   ตัวหนังสือบนปุ่ม (graphite หรือขาว แล้วแต่ตัวไหนอ่านชัดกว่า ≥ 4.5:1)
   - --accent-soft  พื้นจางสำหรับป้าย/ชิป
   - --accent-text  ตัวหนังสือสีเน้น (ไล่เข้ม/อ่อนจนผ่าน 4.5:1 กับพื้นและพื้นจาง)
   - --focus        กรอบโฟกัส (≥ 3:1 กับพื้น)
   ใช้ที่เดียวทั้งเซิร์ฟเวอร์ (/theme.css) และหน้าตั้งค่า (/api/theme/preview) ไม่มีสูตรซ้ำในหน้าเว็บ */

const HEX_RE = /^#[0-9a-f]{6}$/i;
const INK = '#111827', WHITE = '#ffffff';
const LIGHT = { bg: '#f8fafc', surface: '#ffffff' };
const DARK = { bg: '#0b0f17', surface: '#111827' };

const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const hex = c => '#' + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
function lum(h) {
  const [r, g, b] = rgb(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
// ไล่สีเข้าหา target ทีละ 4% จนผ่านทุกพื้นที่ต้องอ่านบน
function until(color, target, bgs, min) {
  for (let t = 0; t <= 1.0001; t += 0.04) { const c = mix(color, target, t); if (bgs.every(b => contrast(c, b) >= min)) return c; }
  return target;
}
const inkOn = c => { const best = contrast(c, INK) >= contrast(c, WHITE) ? INK : WHITE; return contrast(c, best) >= 4.5 ? best : (best === INK ? '#000000' : WHITE); };

/* คืน { ok, error?, light, dark } light/dark = ค่าของ CSS variable */
function derive(accent) {
  if (!HEX_RE.test(accent || '')) return { ok: false, error: 'สีต้องเป็นรหัสแบบ #RRGGBB' };
  const a = accent.toLowerCase();
  // เกือบขาว (ทุกช่องสี ≥ 225) ปุ่มกลืนกับพื้นสีขาว ไม่รับ สีอ่อนที่มีสีชัด เช่น เหลือง ใช้ได้ (มีขอบเข้มให้)
  if (Math.min(...rgb(a)) >= 225) return { ok: false, error: 'สีนี้อ่อนเกินไป ปุ่มจะกลืนกับพื้นหลังสีขาว เลือกสีที่เข้มขึ้น' };
  const lSoft = mix(a, WHITE, 0.84), lText = until(a, '#000000', [LIGHT.bg, LIGHT.surface, lSoft], 4.5);
  const light = { accent: a, 'accent-line': until(a, '#000000', [LIGHT.bg], 1.6), 'accent-ink': inkOn(a), 'accent-soft': lSoft, 'accent-text': lText, focus: until(a, '#000000', [LIGHT.bg, LIGHT.surface], 3) };
  const dA = until(a, WHITE, [DARK.bg, DARK.surface], 3);       // โหมดมืด: ปุ่มสีเข้มสว่างขึ้นให้ไม่กลืนพื้น
  const dSoft = mix(dA, DARK.surface, 0.8), dText = until(dA, WHITE, [DARK.bg, DARK.surface, dSoft], 4.5);
  const dark = { accent: dA, 'accent-line': dA, 'accent-ink': inkOn(dA), 'accent-soft': dSoft, 'accent-text': dText, focus: until(dA, WHITE, [DARK.bg, DARK.surface], 3) };
  return { ok: true, light, dark };
}

const vars = o => Object.keys(o).map(k => '--' + k + ':' + o[k]).join(';');
/* CSS ที่หน้าเว็บโหลดต่อท้าย <style> ของหน้า ไม่ตั้งสี = ว่าง (ใช้สีตั้งต้น Graphite + Lime ในหน้า) */
function css(accent) {
  const d = accent ? derive(accent) : null;
  if (!d || !d.ok) return '/* ใช้สีตั้งต้น */\n';
  return ':root{' + vars(d.light) + '}\n' +
    '@media (prefers-color-scheme:dark){:root{' + vars(d.dark) + '}}\n';
}

// ชุดสีให้กดเลือกเร็ว (ทุกสีผ่าน derive)
const PRESETS = [
  { name: 'มะนาว (ตั้งต้น)', color: '' }, { name: 'ส้มพริก', color: '#ea580c' }, { name: 'แดงพริก', color: '#dc2626' },
  { name: 'เขียวใบตอง', color: '#15803d' }, { name: 'น้ำเงินคราม', color: '#1d4ed8' }, { name: 'ม่วง', color: '#7c3aed' },
  { name: 'ชมพู', color: '#db2777' }, { name: 'น้ำตาลกาแฟ', color: '#92400e' }, { name: 'ดำ', color: '#111827' }
];

module.exports = { HEX_RE, derive, css, contrast, PRESETS };
