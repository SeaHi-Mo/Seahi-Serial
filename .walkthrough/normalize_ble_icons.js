/**
 * 统一四个 BLE 设备类型图标的视觉尺寸
 *
 * 四个源 SVG 的 viewBox 都是 0 0 1024 1024，但各自内容在框内留白不同
 * （蓝牙图标外围套了一圈圆、各图标边距不一），导致同一渲染尺寸下看起来大小不一。
 * 这里解析每条 path 的真实包围盒（含弧线采样），把 viewBox 裁紧到内容边界，
 * 这样在统一高度渲染时四个图标的视觉尺寸就一致了。
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const indexPath = path.join(root, 'src', 'index.html');
const iconDir = path.join(root, 'src', 'icons');

const ICONS = [
  ['ble', '蓝牙.svg'],
  ['apple', '苹果.svg'],
  ['ibeacon', 'Ibeacon.svg'],
  ['pc', '微软.svg'],
  ['mesh', 'mesh.svg'],
];

// ---------- path 解析 ----------
const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/;

function tokenize(d) {
  const re = new RegExp('([MmLlHhVvCcSsQqTtAaZz])|(' + NUM.source + ')', 'g');
  const out = [];
  let m;
  while ((m = re.exec(d)) !== null) {
    if (m[1]) out.push({ cmd: m[1] });
    else out.push({ num: parseFloat(m[2]) });
  }
  return out;
}

/** 圆弧按中心参数化采样（SVG 规范 F.6.5），返回采样点 */
function sampleArc(x1, y1, rx, ry, phiDeg, laf, sf, x2, y2) {
  const pts = [];
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return [[x2, y2]];
  const phi = (phiDeg * Math.PI) / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  rx = Math.abs(rx); ry = Math.abs(ry);
  const dx2 = (x1 - x2) / 2, dy2 = (y1 - y2) / 2;
  const x1p = cosP * dx2 + sinP * dy2;
  const y1p = -sinP * dx2 + cosP * dy2;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (laf === sf) coef = -coef;
  const cxp = (coef * (rx * y1p)) / ry;
  const cyp = (-coef * (ry * x1p)) / rx;
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
  const theta1 = ang(1, 0, ux, uy);
  let dTheta = ang(ux, uy, vx, vy);
  if (!sf && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sf && dTheta < 0) dTheta += 2 * Math.PI;
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const t = theta1 + (dTheta * i) / steps;
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    pts.push([cosP * ex - sinP * ey + cx, sinP * ex + cosP * ey + cy]);
  }
  return pts;
}

/** 计算 path 的包围盒 [minX, minY, maxX, maxY] */
function pathBBox(d) {
  const toks = tokenize(d);
  let i = 0;
  let cur = [0, 0], sub = [0, 0];
  let lastCubic = null, lastQuad = null, prevCmd = '';
  const xs = [], ys = [];
  const add = (x, y) => { xs.push(x); ys.push(y); };

  const num = () => toks[i++].num;
  const isNum = () => i < toks.length && toks[i].num !== undefined;

  while (i < toks.length) {
    const cmd = toks[i++].cmd;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    // 每组参数个数
    const arity = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }[C];
    if (arity === undefined) throw new Error('unsupported command ' + cmd);

    if (C === 'Z') { cur = sub.slice(); continue; }

    let first = true;
    while (isNum()) {
      if (C === 'M' && first) {
        const x = num(), y = num();
        cur = rel ? [cur[0] + x, cur[1] + y] : [x, y];
        sub = cur.slice();
        add(cur[0], cur[1]);
      } else if (C === 'M' || C === 'L') {
        const x = num(), y = num();
        cur = rel ? [cur[0] + x, cur[1] + y] : [x, y];
        add(cur[0], cur[1]);
      } else if (C === 'H') {
        const x = num();
        cur = [rel ? cur[0] + x : x, cur[1]];
        add(cur[0], cur[1]);
      } else if (C === 'V') {
        const y = num();
        cur = [cur[0], rel ? cur[1] + y : y];
        add(cur[0], cur[1]);
      } else if (C === 'C') {
        let [x1, y1, x2, y2, x, y] = [num(), num(), num(), num(), num(), num()];
        if (rel) { x1 += cur[0]; y1 += cur[1]; x2 += cur[0]; y2 += cur[1]; x += cur[0]; y += cur[1]; }
        add(x1, y1); add(x2, y2); add(x, y);          // 控制点包住曲线
        lastCubic = [x2, y2]; cur = [x, y];
      } else if (C === 'S') {
        let [x2, y2, x, y] = [num(), num(), num(), num()];
        if (rel) { x2 += cur[0]; y2 += cur[1]; x += cur[0]; y += cur[1]; }
        const rx1 = lastCubic ? 2 * cur[0] - lastCubic[0] : cur[0];
        const ry1 = lastCubic ? 2 * cur[1] - lastCubic[1] : cur[1];
        add(rx1, ry1); add(x2, y2); add(x, y);
        lastCubic = [x2, y2]; cur = [x, y];
      } else if (C === 'Q') {
        let [x1, y1, x, y] = [num(), num(), num(), num()];
        if (rel) { x1 += cur[0]; y1 += cur[1]; x += cur[0]; y += cur[1]; }
        add(x1, y1); add(x, y);
        lastQuad = [x1, y1]; cur = [x, y];
      } else if (C === 'T') {
        let [x, y] = [num(), num()];
        if (rel) { x += cur[0]; y += cur[1]; }
        const rx1 = lastQuad ? 2 * cur[0] - lastQuad[0] : cur[0];
        const ry1 = lastQuad ? 2 * cur[1] - lastQuad[1] : cur[1];
        add(rx1, ry1); add(x, y);
        lastQuad = [rx1, ry1]; cur = [x, y];
      } else if (C === 'A') {
        const rx = num(), ry = num(), rot = num(), laf = num(), sf = num();
        let x = num(), y = num();
        if (rel) { x += cur[0]; y += cur[1]; }
        for (const [px, py] of sampleArc(cur[0], cur[1], rx, ry, rot, laf, sf, x, y)) add(px, py);
        cur = [x, y];
      }
      if (C !== 'C' && C !== 'S') lastCubic = null;
      if (C !== 'Q' && C !== 'T') lastQuad = null;
      first = false;
      if (arity === 0) break;
    }
    prevCmd = C;
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// ---------- 生成 ----------
const html = fs.readFileSync(indexPath, 'utf8');
const entries = [];
for (const [key, file] of ICONS) {
  const raw = fs.readFileSync(path.join(iconDir, file), 'utf8');
  const ds = [...raw.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]);
  if (!ds.length) throw new Error('no path data in ' + file);
  // 单 path 图标为主；多 path 时取各 path 包围盒的并集
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const d of ds) {
    const b = pathBBox(d);
    x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]);
    x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
  }
  const srcBox = /viewBox="([^"]+)"/.exec(raw)[1];
  const [sw, sh] = srcBox.split(/\s+/).slice(2).map(Number);
  const w = x1 - x0, h = y1 - y0;
  const pad = Math.max(w, h) * 0.01;                    // 1% 余量，避免抗锯齿被裁
  const vb = [x0 - pad, y0 - pad, w + pad * 2, h + pad * 2]
    .map((v) => Math.round(v * 100) / 100).join(' ');
  entries.push({ key, ds, vb, box: [x0, y0, w, h] });
  console.log(
    `${key.padEnd(8)} path=${ds.length} 原框 ${srcBox} 内实际内容: x=${x0.toFixed(0)} y=${y0.toFixed(0)} ` +
    `w=${w.toFixed(0)} h=${h.toFixed(0)}  占比 ${((w / sw) * 100).toFixed(0)}%x${((h / sh) * 100).toFixed(0)}%` +
    `  长宽比 ${(w / h).toFixed(3)}  -> viewBox="${vb}"`
  );
}

const EOL = html.includes('\r\n') ? '\r\n' : '\n';
const block = [
  '// BLE 设备类型 icon（依据后端 device_type 判定结果；currentColor 随主题与选中态变色）',
  '// viewBox 已按各图标内容包围盒裁紧，使各图标渲染高度一致时视觉尺寸相同',
  'var BLE_DEV_ICONS = {',
  ...entries.map((e, idx) =>
    `    ${e.key}:${' '.repeat(Math.max(1, 8 - e.key.length))}'<svg viewBox="${e.vb}" fill="currentColor" preserveAspectRatio="xMidYMid meet">${e.ds.map((d) => '<path d="' + d + '"/>').join('')}</svg>'${idx < entries.length - 1 ? ',' : ''}`
  ),
  '};',
  '',
].join(EOL);

const DRY = process.argv.includes('--dry');

const start = html.indexOf('var BLE_DEV_ICONS = {');
if (start < 0) throw new Error('BLE_DEV_ICONS not found');
// 连同其上方的注释行一起替换
const commentStart = html.lastIndexOf('// BLE 设备类型 icon', start);
const blockStart = commentStart >= 0 ? commentStart : start;
const m = /\r?\n\};\r?\n/.exec(html.slice(start));   // 兼容 CRLF
if (!m) throw new Error('BLE_DEV_ICONS end not found');
const end = start + m.index + m[0].length;
const next = html.slice(0, blockStart) + block + html.slice(end);
if (DRY) {
  console.log('\n[dry-run] 未写入。新 viewBox 如上。');
} else {
  fs.writeFileSync(indexPath, next, 'utf8');
  console.log('\nBLE_DEV_ICONS 已重写（viewBox 裁紧）');
}
