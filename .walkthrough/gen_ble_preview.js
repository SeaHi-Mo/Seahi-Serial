/**
 * BLE 面板 —— headless 逻辑验证 + 浏览器预览页生成
 *
 * 直接从 src/index.html 抽取真实函数源码运行，确保验证的是线上同一份代码：
 *   设备列表：BLE_DEV_ICONS / BLE_DEV_TYPE_META / escapeHtml / renderBleDeviceList
 *   广播内容：shortUuid / advRow / hexToLe / bleDataVal / parseBleAdv / advTypeLabel / renderBleAdv
 *
 * 产物：.walkthrough/preview_ble_icons.html（浏览器可直接打开，含设备列表 + 广播内容两段）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');

function sliceBlock(startMarker) {
  const i = html.indexOf(startMarker);
  if (i < 0) throw new Error('marker not found: ' + startMarker);
  return { start: i, body: html.slice(i) };
}

/** 抽取 `var NAME = { ... };` 整个字面量 */
function extractObject(name) {
  const marker = 'var ' + name + ' = {';
  const i = html.indexOf(marker);
  if (i < 0) throw new Error('object not found: ' + name);
  const end = html.indexOf('\n};', i);
  return html.slice(i, end + 3);
}

/** 抽取顶层 function 定义（兼容单行函数与列首 `}` 收尾两种写法） */
function extractFunction(name) {
  const src = sliceBlock('function ' + name + '(');
  const nl = src.body.indexOf('\n');
  const firstLine = src.body.slice(0, nl < 0 ? src.body.length : nl);
  const opens = (firstLine.match(/\{/g) || []).length;
  const closes = (firstLine.match(/\}/g) || []).length;
  if (opens > 0 && opens === closes) return firstLine.replace(/\r$/, '');  // 单行函数
  const m = /\r?\n\}\r?\n/.exec(src.body);      // 列首的收尾 `}`（兼容 CRLF）
  if (!m) throw new Error('function end not found: ' + name);
  return src.body.slice(0, m.index + m[0].length);
}

/** 抽取 main.rs 里一个顶层 fn 的完整定义体（按大括号配平；Rust 函数之间不保证有空行） */
function extractRustFn(sig) {
  const i = mainRs.indexOf(sig);
  if (i < 0) throw new Error('rust fn not found: ' + sig);
  let depth = 0, started = false;
  for (let j = i; j < mainRs.length; j++) {
    const c = mainRs[j];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) return mainRs.slice(i, j + 1); }
  }
  throw new Error('rust fn end not found: ' + sig);
}

const ICONS = extractObject('BLE_DEV_ICONS');
const META = extractObject('BLE_DEV_TYPE_META');
const ESCAPE = extractFunction('escapeHtml');
const RENDER = extractFunction('renderBleDeviceList');
const ADV_FNS = ['shortUuid', 'advRow', 'hexToLe', 'bleDataVal', 'parseBleAdv', 'advTypeLabel', 'renderBleAdv']
  .map(extractFunction).join('\n');

// ---------- 1) 设备列表逻辑验证 ----------
function fakeEl() {
  return {
    innerHTML: '', className: '', textContent: '', style: {}, dataset: {}, attrs: {},
    children: [], title: '',
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {},
    appendChild(c) { this.children.push(c); },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    querySelector() { return null; },
  };
}

const byId = {};
const sandbox = {
  console,
  document: {
    getElementById(id) { return (byId[id] = byId[id] || fakeEl()); },
    createElement() { return fakeEl(); },
  },
};
vm.createContext(sandbox);
vm.runInContext([ICONS, META, ESCAPE, extractFunction('bleRssiColor'), RENDER, ADV_FNS].join('\n'), sandbox);

sandbox._bleDevices = [
  { address: 'A4:C1:38:A5:1A:B7', name: 'iPhone 15 Pro', rssi: -48, connected: true, deviceType: 'apple' },
  { address: 'B0:BE:76:11:22:33', name: 'iBeacon 入口信标', rssi: -55, connected: false, deviceType: 'ibeacon' },
  { address: '00:1A:7D:DA:71:13', name: 'DESKTOP-SS49V6F', rssi: -62, connected: false, deviceType: 'pc' },
  { address: 'C8:47:8C:00:11:22', name: 'Mesh Light <b>', rssi: -71, connected: false, deviceType: 'mesh' },
  { address: 'E7:2A:4C:9F:00:01', name: '标准 BLE 外设', rssi: -83, connected: false, deviceType: 'ble' },
  { address: 'FF:FF:FF:FF:FF:01', name: '未知类型设备', rssi: -90, connected: false },  // 无 deviceType → 应回退 ble
  { address: 'FF:FF:FF:FF:FF:02', name: '<img src=x onerror=alert(1)>', rssi: -40, connected: false, deviceType: 'apple' },
];
sandbox._bleSelected = 'A4:C1:38:A5:1A:B7';
sandbox._bleFilterText = '';

vm.runInContext('renderBleDeviceList()', sandbox);

let pass = 0, fail = 0;
const check = (ok, label, extra) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined && !ok ? '   -> ' + extra : ''}`);
};

const cards = byId['ble-devList'].children;
const typeOf = (cardHtml) => {
  // 通过各类型图标的 path 首段特征定位（互不相同）
  if (cardHtml.includes('M792.576 348.672')) return 'ble';
  if (cardHtml.includes('M791.488 544.095')) return 'apple';
  if (cardHtml.includes('M687.870362 574.278394')) return 'ibeacon';
  if (cardHtml.includes('M454.656 863.232')) return 'pc';
  if (cardHtml.includes('M847.39 603.78')) return 'mesh';
  return 'none';
};
const titles = {
  apple: 'Apple 设备（iPhone / iPad / Mac）',
  ibeacon: 'iBeacon 信标（Apple 厂商数据 02 15 结构）',
  pc: '个人电脑',
  mesh: 'BLE Mesh 设备',
  ble: '标准 BLE 设备',
};
// 注意：renderBleDeviceList 会按 RSSI 降序排序，故按 MAC 地址而非输入顺序断言
const wantByAddr = {
  'A4:C1:38:A5:1A:B7': 'apple',
  'B0:BE:76:11:22:33': 'ibeacon',
  '00:1A:7D:DA:71:13': 'pc',
  'C8:47:8C:00:11:22': 'mesh',
  'E7:2A:4C:9F:00:01': 'ble',
  'FF:FF:FF:FF:FF:01': 'ble',   // 无 deviceType → 回退
  'FF:FF:FF:FF:FF:02': 'apple',
};
console.log(`【设备列表】共 ${cards.length} 张卡片（RSSI 降序）`);
cards.forEach((c) => {
  const addr = (c.innerHTML.match(/(?:[0-9A-F]{2}:){5}[0-9A-F]{2}/) || ['<无地址>'])[0];
  const want = wantByAddr[addr];
  const got = typeOf(c.innerHTML);
  check(got === want && c.innerHTML.includes(titles[want]),
    `${addr}  expect=${want} got=${got}`, c.innerHTML.slice(0, 60));
});
const xssCard = cards.find((c) => c.innerHTML.includes('FF:FF:FF:FF:FF:02'));
check(!!xssCard && !xssCard.innerHTML.includes('<img src=x')
  && xssCard.innerHTML.includes('&lt;img src=x onerror=alert(1)&gt;'), '设备名 HTML 转义');
const activeCard = cards.find((c) => c.innerHTML.includes('A4:C1:38:A5:1A:B7'));
check(!!activeCard && activeCard.className.includes('active'), '选中设备卡片带 active 类');
check(!cards.some((c) => c.innerHTML.includes('ble-dot')), '状态圆点已移除');
check(!!activeCard && activeCard.className.includes('connected'), '已连接设备卡片带 connected 类');

// 名称后缀提示：仅 iBeacon / Mesh 在设备名后带灰色 tag
const cardByAddr = (addr) => cards.find((c) => c.innerHTML.includes(addr));
const tagOf = (addr) => {
  const c = cardByAddr(addr);
  const m = c && /<span class="ble-dev-tag">\(([^)]+)\)<\/span>/.exec(c.innerHTML);
  return m ? m[1] : '';
};
check(tagOf('B0:BE:76:11:22:33') === 'iBeacon',
  'iBeacon 设备名后带 (iBeacon) 灰色后缀', tagOf('B0:BE:76:11:22:33'));
check(tagOf('C8:47:8C:00:11:22') === 'Mesh',
  'Mesh 设备名后带 (Mesh) 灰色后缀', tagOf('C8:47:8C:00:11:22'));
check(['A4:C1:38:A5:1A:B7', '00:1A:7D:DA:71:13', 'E7:2A:4C:9F:00:01', 'FF:FF:FF:FF:FF:01']
  .every((a) => tagOf(a) === ''), 'Apple / PC / 标准 BLE 不带后缀');

// 已连接提示：只有已连接设备带绿色「已连接」文字
const connOf = (addr) => {
  const c = cardByAddr(addr);
  return !!(c && c.innerHTML.includes('ble-dev-conn') && c.innerHTML.includes('已连接'));
};
check(connOf('A4:C1:38:A5:1A:B7'), '已连接设备带「已连接」提示');
check(['B0:BE:76:11:22:33', '00:1A:7D:DA:71:13', 'C8:47:8C:00:11:22', 'E7:2A:4C:9F:00:01']
  .every((a) => !connOf(a)), '未连接设备不带「已连接」提示');

// 跨层一致性：前端图标表 / 标题表 / 后端 ble_device_type 返回值的 key 必须完全一致
// （缺一个就会出现「后端返回了新类型但前端回退成默认图标」）
const mainRs = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'main.rs'), 'utf8');
const fnBody = mainRs.slice(mainRs.indexOf('fn ble_device_type('), mainRs.indexOf('fn ble_props_json('));
const backendKeys = [...new Set([
  ...[...fnBody.matchAll(/return "([a-z]+)";/g)].map((m) => m[1]),
  ...[...fnBody.matchAll(/^\s*"([a-z]+)"\s*$/gm)].map((m) => m[1]),
])].sort();
const iconKeys = [...ICONS.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]).sort();
const metaKeys = [...META.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]).sort();
check(JSON.stringify(iconKeys) === JSON.stringify(backendKeys),
  `BLE_DEV_ICONS key 与后端一致 [${backendKeys.join(',')}]`, iconKeys.join(','));
check(JSON.stringify(metaKeys) === JSON.stringify(backendKeys),
  'BLE_DEV_TYPE_META key 与后端一致', metaKeys.join(','));

// ---------- 2) 广播内容逻辑验证 ----------
console.log('\n【广播内容】');
check(sandbox.shortUuid('0000fe3c-0000-1000-8000-00805f9b34fb') === 'FE3C',
  "shortUuid 16 位 → 'FE3C'", sandbox.shortUuid('0000fe3c-0000-1000-8000-00805f9b34fb'));
check(sandbox.shortUuid('6e400001-b5a3-f393-e0a9-e50e24dcca9e') === '6E400001-B5A3-F393-E0A9-E50E24DCCA9E',
  'shortUuid 自定义 128 位 → 原样（大写）', sandbox.shortUuid('6e400001-b5a3-f393-e0a9-e50e24dcca9e'));
check(sandbox.hexToLe('0F 10 08') === '0x08100F', "hexToLe('0F 10 08') = 0x08100F", sandbox.hexToLe('0F 10 08'));
// 回归：4 字节最高位为 1 时，旧实现用 << 会溢出成负数并输出 '0x-80000000'
check(sandbox.hexToLe('00 00 00 80') === '0x80000000', 'hexToLe 4 字节高位为 1 不出现负号', sandbox.hexToLe('00 00 00 80'));
check(sandbox.bleDataVal('01 02 03 04') === '0x04030201', 'bleDataVal ≤4 字节小端合并', sandbox.bleDataVal('01 02 03 04'));
check(sandbox.advRow('<b>x</b>', '<i>y</i>').includes('&lt;b&gt;'), 'advRow 标签/值均转义');

// 用户实际遇到的数据样本（服务数据 UUID 0xFDEE + 厂商数据 0x0100）
const RAW = [
  '02 01 16',
  '17 FF 00 01 85 00 03 16 ED B1 F1 00 00 00 EB 5A 51 A9 FE 01 10 00 00 00',
  '14 16 EE FD 00 10 00 01 21 A6 D5 87 A4 24 02 5A 41 41 4F 03 02',
  '03 03 3C FE',
].join(' ');
const SAMPLE_ADV = {
  adName: 'EDIFIER BLE',
  txPower: 0,
  appearance: null,
  manufacturerData: [{ id: 256, hex: '00 01 85 00 03 16 ED B1 F1 00 00 00 EB 5A 51 A9 FE 01 10 00 00 00' }],
  serviceData: [{ uuid: '0000fdee-0000-1000-8000-00805f9b34fb', hex: '00 10 00 01 21 A6 D5 87 A4 24 02 5A 41 41 4F 03 02' }],
  svcs: ['0000fe3c-0000-1000-8000-00805f9b34fb'],
  raw: RAW,
};
const segs = sandbox.parseBleAdv(RAW);
check(segs.length === 4, `parseBleAdv 解析出 ${segs.length} 段（应为 4）`, JSON.stringify(segs.map(s => s.label)));
const advHtml = sandbox.renderBleAdv({ adv: SAMPLE_ADV });
check(advHtml.includes('服务数据(0xFDEE)'), '服务数据标签使用短 UUID（0xFDEE）');
check(!advHtml.includes('0000fdee'), '摘要中不再出现完整 128 位 UUID');
check(advHtml.includes('0x0010000121A6D587A424025A41414F0302'), '服务数据值 = 0x00100001…4F0302');
check(advHtml.includes('广播服务') && advHtml.includes('0xFE3C'), '广播服务显示为 0xFE3C');
check(advHtml.includes('厂商数据(0x100)'), '厂商数据标签 = 厂商数据(0x100)');
// 布局回归防护：摘要必须保持「分栏」（每行两对标签+值），不要被改成单列
check(/\.ble-adv-brief\s*\{[^}]*grid-template-columns:\s*repeat\(2,/.test(html),
  '摘要保持分栏布局（每行两对）');
check(/\.ble-adv-k\s*\{[^}]*text-overflow:\s*ellipsis/.test(html),
  '标签列有省略号保护（长标签不会压住值）');

// ---------- 3) 生成预览页 ----------
const cssRoot = (html.match(/:root\s*\{[^}]*\}/) || [''])[0];
const cssBody = (html.match(/\nbody\s*\{[^}]*\}/) || [''])[0];
const cssBle = (html.match(/^\.ble-[^{]*\{[^}]*\}/gm) || []).join('\n');

const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>BLE 面板 — 渲染预览</title>
<style>
${cssRoot}
${cssBody}
${cssBle}
body { background: var(--bg, #1c1e22); padding: 28px; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
.note { color: var(--text-d, #8b949e); font-size: 12px; margin: 0 0 14px; }
h3 { color: var(--text, #c9d1d9); font-size: 14px; margin: 22px 0 6px; }
.wrap { width: 430px; }
.detail { width: 620px; border: 1px solid var(--border, #30363d); border-radius: 10px; padding: 10px; }
#ble-devList { height: auto; display: flex; flex-direction: column; gap: 8px;
               border: 1px solid var(--border, #30363d); border-radius: 10px; padding: 10px; }
</style>
</head>
<body>
<h3>① BLE 设备列表 — 设备类型图标</h3>
<p class="note">使用 index.html 中真实的 BLE_DEV_ICONS / BLE_DEV_TYPE_META / renderBleDeviceList 渲染，非手工绘制。第 1 行为选中态。</p>
<div class="wrap"><div class="ble-devList" id="ble-devList"></div></div>

<h3>② 广播内容 — 分段原始字节 + 解析摘要</h3>
<p class="note">使用真实 renderBleAdv 渲染；样本取自实际抓到的报文（服务数据 UUID 0xFDEE、厂商数据 0x0100）。</p>
<div class="detail"><div class="ble-detail-sec ble-adv-sec">
  <div class="ble-sec-title ble-adv-toggle"><span class="ble-svc-caret">&#9654;</span>广播内容 <span class="ble-adv-count">${RAW.split(' ').length} B</span></div>
  <div class="ble-adv-body" id="ble-adv-body"></div>
</div></div>

<script>
${ICONS}
${META}
${ESCAPE}
${extractFunction('bleRssiColor')}
${RENDER}
${ADV_FNS}
_bleDevices = [
  { address: 'A4:C1:38:A5:1A:B7', name: 'iPhone 15 Pro',      rssi: -48, connected: true,  deviceType: 'apple' },
  { address: 'B0:BE:76:11:22:33', name: 'iBeacon 入口信标',    rssi: -55, connected: false, deviceType: 'ibeacon' },
  { address: '00:1A:7D:DA:71:13', name: 'DESKTOP-SS49V6F',    rssi: -62, connected: false, deviceType: 'pc' },
  { address: 'C8:47:8C:00:11:22', name: 'Mesh Light',          rssi: -71, connected: false, deviceType: 'mesh' },
  { address: 'E7:2A:4C:9F:00:01', name: '标准 BLE 外设',        rssi: -83, connected: false, deviceType: 'ble' },
  { address: 'FF:FF:FF:FF:FF:01', name: '未知类型设备',         rssi: -90, connected: false }
];
_bleSelected = 'A4:C1:38:A5:1A:B7';
renderBleDeviceList();
var SAMPLE_ADV = ${JSON.stringify(SAMPLE_ADV)};
document.getElementById('ble-adv-body').innerHTML = renderBleAdv({ adv: SAMPLE_ADV });
</script>
</body>
</html>
`;
const out = path.join(root, '.walkthrough', 'preview_ble_icons.html');
fs.writeFileSync(out, page, 'utf8');
console.log('preview ->', out);

// ---------- 4) 切页恢复回归防护 ----------
// 回归点：refreshBleDevices 原先把 connected 硬编码为 false，
// 导致「BLE 实际连着，切到别的页面再回来却显示未连接」。现在连接态以后端为准。
(async function () {
  // ---- 5a) RSSI 定点刷新（颜色阈值 + 只更新不重建）----
  const sb2 = { console };
  sb2._txt = { textContent: '', style: {} };
  sb2._bar = { style: {} };
  sb2._meta = { textContent: '' };
  sb2._card = { querySelector: (s) => (s.indexOf('rssi-bar') >= 0 ? sb2._bar : sb2._txt) };
  sb2.document = {
    querySelector(sel) {
      if (sel.indexOf('ble-dev-card') >= 0) return sb2._card;
      if (sel.indexOf('ble-detail-meta') >= 0) return sb2._meta;
      return null;
    },
  };
  sb2._bleDevices = [{ address: 'AA:BB:CC:DD:EE:01', addressType: 'Public', rssi: -80 }];
  sb2._bleSelected = 'AA:BB:CC:DD:EE:01';
  vm.createContext(sb2);
  vm.runInContext([
    extractFunction('bleRssiColor'),
    extractFunction('bleDetailMetaText'),
    'var _bleMtu = 0;',
    extractFunction('applyLiveRssi'),
  ].join('\n'), sb2);

  check(sb2.bleRssiColor(-50, false) === 'var(--accent-green)', 'RSSI -50dBm → 绿');
  check(sb2.bleRssiColor(-60, false) === 'var(--accent-orange)', 'RSSI -60dBm → 橙');
  check(sb2.bleRssiColor(-80, false) === 'var(--accent-red)', 'RSSI -80dBm → 红');
  check(sb2.bleRssiColor(-80, true) === '#fff', 'RSSI 选中态 → 白');
  sb2.applyLiveRssi('AA:BB:CC:DD:EE:01', -52);
  check(sb2._bleDevices[0].rssi === -52, 'applyLiveRssi 更新设备对象 rssi', String(sb2._bleDevices[0].rssi));
  check(sb2._txt.textContent === '-52 dBm', 'applyLiveRssi 更新卡片 RSSI 文字', sb2._txt.textContent);
  check(sb2._meta.textContent.indexOf('-52 dBm') >= 0, 'applyLiveRssi 更新详情头部', sb2._meta.textContent);

  // 详情头元信息（纯函数）：地址 · 类型 · RSSI [· MTU]
  check(sb2.bleDetailMetaText({ address: 'AA:BB:CC:DD:EE:01', addressType: 'Public' }, -52, 0)
    === 'AA:BB:CC:DD:EE:01 · Public · -52 dBm',
    '未连接/无 MTU 时不显示 MTU 段', sb2.bleDetailMetaText({ address: 'AA:BB:CC:DD:EE:01', addressType: 'Public' }, -52, 0));
  check(sb2.bleDetailMetaText({ address: 'AA:BB:CC:DD:EE:01', addressType: 'Public', connected: true }, -52, 185)
    === 'AA:BB:CC:DD:EE:01 · Public · -52 dBm · MTU 185（载荷 182）',
    '已连接且有 MTU 时显示 MTU 与有效载荷', sb2.bleDetailMetaText({ address: 'AA:BB:CC:DD:EE:01', addressType: 'Public', connected: true }, -52, 185));
  check(sb2.bleDetailMetaText({ address: 'AA:BB:CC:DD:EE:01', connected: true }, null, 23)
    === 'AA:BB:CC:DD:EE:01 · — · — · MTU 23（载荷 20）',
    '默认 MTU 23 → 载荷 20（BLE 默认值）', sb2.bleDetailMetaText({ address: 'AA:BB:CC:DD:EE:01', connected: true }, null, 23));
  // 关键回归：RSSI 轮询重写这一行时不能把 MTU 刷掉
  sb2._bleMtu = 185;
  sb2._bleDevices[0].connected = true;
  sb2.applyLiveRssi('AA:BB:CC:DD:EE:01', -53);
  check(sb2._meta.textContent.indexOf('MTU 185') > 0,
    'RSSI 刷新后 MTU 仍在（两处共用同一个纯函数）', sb2._meta.textContent);

  // ---- 5b) 订阅状态必须随连接复位（未连接清空；连接仍在则保留）----
  const mkSync = (connAddr) => {
    const s = {
      console, _bleServices: [], _bleSelected: null, _bleConnAddr: 'STALE',
      _bleSubs: { 'AAAA::notify': true }, _cleared: 0, _started: 0, _mtu: 0,
    };
    s.stopBleNotifyPoll = () => {}; s.stopBleRssiPoll = () => {};
    s.startBleNotifyPoll = () => { s._started++; }; s.startBleRssiPoll = () => {};
    s.clearBleLog = () => { s._cleared++; };
    s.logBle = () => {};
    // refreshBleMtu 是 syncBleConnection 成功分支里的真实依赖：
    // 不打桩的话整条 then 会被 catch 吞掉，下面"启动轮询"的断言就形同虚设
    s.refreshBleMtu = () => { s._mtu++; return Promise.resolve(); };
    s.invoke = (cmd) => Promise.resolve(cmd === 'ble_get_connection' ? connAddr : []);
    vm.createContext(s);
    vm.runInContext(extractFunction('syncBleConnection'), s);
    return s;
  };
  const s1 = mkSync(null);
  s1.syncBleConnection();
  await new Promise((r) => setTimeout(r, 20));
  check(Object.keys(s1._bleSubs).length === 0,
    '未连接时清空订阅状态（不再显示「启用」）', JSON.stringify(s1._bleSubs));
  check(s1._cleared === 1, '连接不在时清空日志', String(s1._cleared));
  const s2 = mkSync('AA:BB:CC:DD:EE:01');
  s2.syncBleConnection();
  await new Promise((r) => setTimeout(r, 20));
  check(s2._bleConnAddr === 'AA:BB:CC:DD:EE:01' && s2._bleSelected === 'AA:BB:CC:DD:EE:01',
    '连接仍在时恢复选中项');
  check(Object.keys(s2._bleSubs).length === 1, '连接仍在时保留订阅状态（切页不丢）');
  check(s2._started === 1, '连接仍在时启动通知轮询（成功分支真的走到了）', String(s2._started));
  check(s2._mtu === 1, '连接仍在时回读一次 MTU', String(s2._mtu));
  check(s1._started === 0, '未连接时不启动通知轮询');

  // ---- 5c) 数据日志：追加 / 清空（切设备、断开时调用 clearBleLog）----
  const sb3 = { console, _bleLog: [], _bleLogMax: 400, _bleSelected: 'AA:BB:CC:DD:EE:01' };
  const logEl = { textContent: '', innerHTML: '', scrollTop: 0, scrollHeight: 10 };
  sb3.document = { getElementById: (id) => (id === 'ble-log' ? logEl : null) };
  vm.createContext(sb3);
  vm.runInContext(['logBle', 'logBleDim', 'bleLogToHtml', 'escapeHtml', 'renderBleLog', 'clearBleLog'].map(extractFunction).join('\n'), sb3);
  sb3.logBle('[连接中] X');
  sb3.logBle('[连接成功] X · 服务 5 · 特征 8');
  check(sb3._bleLog.length === 2, 'logBle 追加日志', String(sb3._bleLog.length));
  check(logEl.innerHTML.indexOf('[连接成功] X') >= 0, 'renderBleLog 把内容贴到 DOM（innerHTML，已转义）');
  sb3.clearBleLog();
  check(sb3._bleLog.length === 0 && logEl.textContent === '暂无日志',
    'clearBleLog 清空并显示占位', logEl.textContent);
  // 本次 bug 回归：notify 的调法是 logBleDim(前缀+文本+' · ', hex)，也就是 dim 只作为"后半段"传入。
  // 早期实现假定 dim 已经是 text 的后缀 → text.length-dim.length 变负 → 前缀被整段吞掉，只剩灰色 hex。
  sb3.logBleDim('[通知] 0x180A Device Information · 0x2A19: 你叫什么名字\\r\\n · ', 'E4 BD A0');
  check(logEl.innerHTML.indexOf('[通知] 0x180A Device Information') === 0,
    'logBleDim：前半段不会被吞掉（回归：只剩 hex 的那个 bug）', logEl.innerHTML);
  check(logEl.innerHTML.indexOf('<span class="ble-log-dim">E4 BD A0</span>') > 0,
    'logBleDim：后半段灰显', logEl.innerHTML);
  check(sb3._bleLog[0].text === '[通知] 0x180A Device Information · 0x2A19: 你叫什么名字\\r\\n · E4 BD A0',
    'logBleDim 保证 dim 一定是整条 text 的后缀（复制出来的文本是完整的）', sb3._bleLog[0].text);
  const srcHasClear = /clearBleLog\(\); closeBleWriteModal\(\); \}/.test(html)
    && /clearBleLog\(\);\s*\/\/ 断开即清空/.test(html);
  check(srcHasClear, '切设备与断开两处都接上了 clearBleLog');

  // ---- 5d) BLE 写入（发送）弹窗 ----
  check(/id="bleWriteModal"/.test(html) && /function openBleWriteModal/.test(html)
    && /function closeBleWriteModal/.test(html), '写入弹窗（HTML + 开关函数）存在');
  check(!/ble-sendInput/.test(html) && !/ble-sendTarget/.test(html),
    '底部发送栏已移除（不再有 ble-sendInput / ble-sendTarget）');
  check(/if \(inp\) \{ inp\.value = ''; inp\.focus\(\); \}\s*\/\/ 发完一条即清空/.test(html),
    '发送成功后清空 Value 输入框');
  check(/showToast\('发送成功：0x' \+ hex, 'success'\)/.test(html)
    && /showToast\('发送失败: ' \+ e, 'error'\)/.test(html), '成功/失败都有 toast 提示');
  check(/logBle\('\[发送\] 0x'/.test(html) && /logBle\('\[发送成功\] 0x'/.test(html)
    && /logBle\('\[发送失败\] ' \+ e\)/.test(html), '日志记录 [发送]/[发送成功]/[发送失败]');
  check(/_bleDevices\.forEach\(function\(d\) \{ if \(d\.address !== address\) d\.connected = false; \}\)/.test(html),
    '连接成功后清除其它设备的「已连接」标记（按地址比较，兼容列表刷新后的孤儿对象）');
  check(/var _bleConnecting = false/.test(html) && /invokeTimeout\('ble_connect'/.test(html),
    'BLE 连接有门闩（防连点双连）与显式超时');

  // ---- 5e) 写入属性去重：write 与 write_without_response 只出一个「发送」图标 ----
  const sb5 = { console, _bleSubs: {}, _bleSelected: '', getSelectedBleDev: () => ({ connected: true }) };
  vm.createContext(sb5);
  vm.runInContext([
    extractObject('BLE_PROP_META'), extractObject('BLE_ICONS'), extractObject('BLE_CHAR_NAMES'),
    extractObject('BLE_DESC_META'),
    extractFunction('shortUuid'), extractFunction('renderCharRow'), extractFunction('renderCharDescriptors'),
  ].join('\n'), sb5);
  vm.createContext(sb5);
  vm.runInContext(extractFunction('renderCharRow'), sb5);
  const countActions = (props) => (sb5.renderCharRow({ uuid: 'AAAA', name: 'X', props }).match(/ble-ch-action/g) || []).length;
  check(countActions(['write', 'write_without_response']) === 1,
    '同时支持两种写入时只渲染 1 个发送图标', String(countActions(['write', 'write_without_response'])));
  check(countActions(['write_without_response']) === 1,
    '只支持无响应写时仍渲染 1 个发送图标', String(countActions(['write_without_response'])));
  check(countActions(['read', 'write', 'write_without_response', 'notify']) === 3,
    'read+write(2种)+notify 共 3 个图标', String(countActions(['read', 'write', 'write_without_response', 'notify'])));
  check(/data-modes="write,write_without_response"/.test(sb5.renderCharRow({ uuid: 'AAAA', name: 'X', props: ['write', 'write_without_response'] })),
    '发送图标带上 data-modes 供弹窗选择写入方式');

  // ---- 5e-2) 特征描述符渲染（0x2902 CCCD / 0x2901 User Description）----
  // 真实设备回报的 128 位描述符 UUID（这里用 Bluetooth SIG 基础 UUID 形态，shortUuid 会缩成 2902）
  const chWithDesc = {
    uuid: '00010203-0405-0607-0809-0a0b0c0d2b12', name: '', props: ['read', 'write', 'notify'],
    descriptors: [
      { uuid: '00002902-0000-1000-8000-00805f9b34fb' },
      { uuid: '00002901-0000-1000-8000-00805f9b34fb' },
    ],
  };
  const descHtml = sb5.renderCharRow(chWithDesc);
  check(descHtml.indexOf('0x2902') > 0 && descHtml.indexOf('CCCD') > 0,
    '描述符 0x2902 渲染为 CCCD 胶囊', (descHtml.match(/ble-desc[^>]*>0x29[^<]*/g) || []).join(' | '));
  check(descHtml.indexOf('0x2901') > 0 && descHtml.indexOf('User Description') > 0,
    '描述符 0x2901 渲染为 User Description');
  check((descHtml.match(/class="ble-desc"/g) || []).length === 2, '两个描述符各渲染一个胶囊');
  const noDesc = sb5.renderCharRow({ uuid: 'AAAA', name: 'X', props: ['read'] });
  check(noDesc.indexOf('ble-char-descs') < 0, '无描述符时不渲染描述符行（不占位）');
  check(/if \(!descs\.length\) return ''/.test(html), '描述符为空时提前返回（避免空行）');

  // ---- 5e-2b) 描述符可点击读写：操作图标 + 取值人性化 ----
  check((descHtml.match(/class="ble-desc-act"/g) || []).length === 3,
    '描述符操作图标数：0x2902 读+写、0x2901 读 = 3', String((descHtml.match(/class="ble-desc-act"/g) || []).length));
  check(/bleDescAction\(event,'00010203-0405-0607-0809-0a0b0c0d2b12','00002902-0000-1000-8000-00805f9b34fb','read'\)/.test(descHtml),
    '0x2902 的读取图标带正确参数（特征 UUID + 描述符 UUID）');
  check(/bleDescAction\(event,'00010203-0405-0607-0809-0a0b0c0d2b12','00002902-0000-1000-8000-00805f9b34fb','write'\)/.test(descHtml),
    '0x2902 有写入图标（CCCD 可写）');
  check(descHtml.indexOf("'write'") > 0 && (descHtml.match(/'write'/g) || []).length === 1,
    '0x2901 只读：没有写入图标');
  const sbDesc = { console, TextDecoder };
  vm.createContext(sbDesc);
  vm.runInContext([extractFunction('shortUuid'), extractFunction('bleBytesToHex'), extractFunction('formatDescValue')].join('\n'), sbDesc);
  check(sbDesc.formatDescValue('00002901-0000-1000-8000-00805f9b34fb', [66, 97, 116]) === '0x426174（"Bat"）',
    '0x2901 取值按 UTF-8 文本展示', sbDesc.formatDescValue('00002901-0000-1000-8000-00805f9b34fb', [66, 97, 116]));
  check(sbDesc.formatDescValue('00002902-0000-1000-8000-00805f9b34fb', [1, 0]).indexOf('通知已启用') > 0,
    '0x2902 = 0x0100 → 通知已启用', sbDesc.formatDescValue('00002902-0000-1000-8000-00805f9b34fb', [1, 0]));
  check(sbDesc.formatDescValue('00002902-0000-1000-8000-00805f9b34fb', [0, 0]).indexOf('均已关闭') > 0,
    '0x2902 = 0x0000 → 通知与指示均已关闭');
  check(sbDesc.formatDescValue('00002902-0000-1000-8000-00805f9b34fb', [2, 0]).indexOf('指示已启用') > 0,
    '0x2902 = 0x0200 → 指示已启用');
  check(sbDesc.formatDescValue('0000abcd-0000-1000-8000-00805f9b34fb', [0xde, 0xad]) === '0xDEAD',
    '未知描述符只显示原始 hex', sbDesc.formatDescValue('0000abcd-0000-1000-8000-00805f9b34fb', [0xde, 0xad]));
  check(sbDesc.formatDescValue('00002901-0000-1000-8000-00805f9b34fb', []) === '0x',
    '空值不抛错（退化为 0x）');
  check(!/BLE_DESC_NAMES/.test(html), '旧的 BLE_DESC_NAMES 已完全被 BLE_DESC_META 取代');
  check(/invoke\('ble_write_descriptor', \{ charUuid: _bleWriteTarget\.charUuid,/.test(html),
    '描述符写入走 ble_write_descriptor（不误用 ble_write）');
  check(/\.ble-dev-conn \{ flex-shrink:0; margin-left:10px;/.test(html),
    '「已连接」与设备名的间距已加大到 10px');
  // 回归：图标 SVG 只带 viewBox、不自带宽高 —— 必须由 CSS 给出尺寸，否则不可见
  // （此前的 bug：.ble-desc-act 没有任何样式，描述符胶囊里看不到读写图标）
  check(/\.ble-desc-act svg \{ width:13px; height:13px;/.test(html),
    '描述符操作图标有明确的 CSS 尺寸（否则 SVG 不显示）');
  check(/\.ble-ch-action svg \{ width:18px; height:18px; \}/.test(html),
    '特征行操作图标仍有尺寸（对照，防误删）');
  // 服务类型名称统一右对齐（识别到用标准名、识别不到用 Custom Service，同一元素同一位置）
  check(/\.ble-svc-type \{ margin-left:auto;/.test(html),
    '服务类型名称右对齐（margin-left:auto 推到最右）');

  check(!/ble-svc-name|ble-svc-tag/.test(html),
    '旧的「左侧名称 / 右侧标签」已移除（名称只有一个位置）');
  check(/\.ble-char-uuid \{[^}]*flex:0 0 auto; width:38ch;/.test(html),
    '特征 UUID 仍固定列宽（特征名内联对齐，未受影响）');
  // ---- 5h) GATT 区只展示「正在查看的设备」的服务（用户反馈：未连接设备显示了已连接设备的 GATT）----
  const sb10 = { console };
  vm.createContext(sb10);
  vm.runInContext([extractFunction('isViewingConnectedDevice'), extractFunction('pickBleSvcList')].join('\n'), sb10);
  const connDev = { address: 'AA:BB:CC:DD:EE:01', services: ['0000180f-0000-1000-8000-00805f9b34fb'] };
  const otherDev = { address: '00:11:22:33:44:55', services: ['0000180d-0000-1000-8000-00805f9b34fb'] };
  const realSvcs = [{ uuid: 'REAL-SVC-1', primary: true, characteristics: [{ uuid: 'C1' }] }];
  const svcA = sb10.pickBleSvcList(connDev, realSvcs, 'AA:BB:CC:DD:EE:01');
  check(svcA.length === 1 && svcA[0].uuid === 'REAL-SVC-1' && svcA[0].chars.length === 1,
    '查看「已连接设备」→ 用真实 GATT 服务树');
  const svcB = sb10.pickBleSvcList(otherDev, realSvcs, 'AA:BB:CC:DD:EE:01');
  check(svcB.length === 1 && svcB[0].uuid === '0000180d-0000-1000-8000-00805f9b34fb' && svcB[0].chars.length === 0,
    '查看「未连接的其它设备」→ 用该设备广播里的服务', JSON.stringify(svcB.map((x) => x.uuid)));
  check(svcB.every((x) => x.uuid !== 'REAL-SVC-1'),
    '修复回归：未连接设备下不再出现已连接设备的服务（本次用户反馈的 bug）');
  check(sb10.pickBleSvcList(otherDev, realSvcs, null)[0].uuid.indexOf('180d') > 0,
    '完全没有连接 → 用广播里的服务');
  check(sb10.pickBleSvcList({ address: '00:11:22:33:44:55' }, realSvcs, 'AA:BB:CC:DD:EE:01').length === 0,
    '该设备广播里没有服务 → 空列表（而不是拿别人的）');
  check(sb10.isViewingConnectedDevice(connDev, 'AA:BB:CC:DD:EE:01') === true
     && sb10.isViewingConnectedDevice(otherDev, 'AA:BB:CC:DD:EE:01') === false
     && sb10.isViewingConnectedDevice(null, 'AA:BB:CC:DD:EE:01') === false,
    'isViewingConnectedDevice 判定正确（含空设备）');
  check(/var viewingConnected = isViewingConnectedDevice\(dev, _bleConnAddr\);[\s\S]{0,120}if \(viewingConnected\) \{/.test(html),
    '展开服务取特征时同样做了守卫（不会把别人的特征挂过来）');
  // 空状态文案必须区分「没连」「只是广播里有」「连着但该服务确实没特征」——
  // 原先三种情况共用「连接设备后查看特征」，已连接时提示去连接设备会误导排查（用户反馈）
  check(/var hint = !viewingConnected \? '连接设备后查看特征'/.test(html),
    '空状态：未连接 → 提示先连接');
  check(/: \(!svc \? '该服务只出现在广播里，设备上未发现它'/.test(html),
    '空状态：连着但服务不在设备实际服务里 → 说明只出现在广播');
  check(/: '该服务下没有特征（设备可能未启用）'\);/.test(html),
    '空状态：连着且服务存在但无特征 → 如实说明');
  check(!/'<div class="ble-char-empty">连接设备后查看特征<\/div>'\s*;/.test(html),
    '不再把三种情况写成同一句误导文案');

  // ---- 5i) 蓝牙页内嵌串口监视器（最多一个）----
  check(/id="ble-monitorArea"/.test(html), '蓝牙页里有内嵌监视器区 #ble-monitorArea');
  check(/\.ble-monArea \{ display:none;/.test(html) && /\.ble-monArea\.active \{ display:flex; \}/.test(html),
    '监视器区默认隐藏、active 时才显示（不挤压详情面板）');
  check(/if \(blePane && blePane\.style\.display !== 'none' && blePane\._initialized\) \{\s*toggleBleMonitor\(\);/.test(html),
    'addMonitor 在蓝牙页路由到 toggleBleMonitor（开关语义）');
  check(/function toggleBleMonitor\(\)/.test(html), 'toggleBleMonitor 已实现');
  check(/if \(_bleExtraMon && monitors\[_bleExtraMon\]\) \{\s*closeMonitor\(_bleExtraMon\);\s*return;/.test(html),
    '已打开时再点即关闭（走与窗口 ✕ 相同的释放路径）');
  check(!/蓝牙页最多只能打开一个监视器/.test(html),
    '不再需要"最多一个"的提示：开关语义下不存在开第二个的路径');
  check(/function updateBleMonBtn\(\)/.test(html)
     && /btn\.classList\.toggle\('active', open\);/.test(html)
     && /btn\.title = open \? '关闭右侧串口监视器' : '打开右侧串口监视器';/.test(html),
    '顶栏按钮状态跟随开关（高亮 + 标题在"打开/关闭右侧串口监视器"间切换）');
  check(/if \(mid === _bleExtraMon\) \{[\s\S]{0,240}updateBleMonBtn\(\)/.test(html),
    '关闭后按钮状态复位');
  check(/顶栏「打开额外监视器」在蓝牙页是开关[\s\S]{0,80}updateBleMonBtn\(\);/.test(html),
    '进入蓝牙页时同步按钮状态');
  check(/addBtn\.classList\.remove\('active'\);/.test(html), '离开页面时清掉按钮高亮');  check(/createMonitorPane\(mid, '监视器 · 蓝牙日志', false\);/.test(html),
    '内嵌监视器以 closable=false 创建 → 不再生成多余的 ✕（由顶栏开关负责关闭）');
  check(/closable=false：不生成薄标题栏上的 ✕/.test(html), '该决定已在代码里写明理由');
  // 问题2：ADB/WSL 页禁用该按钮后，直接切到蓝牙页会残留禁用态（按钮点不动）
  check(/function updateBleMonBtn\(\) \{[\s\S]{0,200}btn\.style\.opacity = '';[\s\S]{0,80}btn\.style\.pointerEvents = '';/.test(html),
    '进入蓝牙页时把按钮重置为可用（清掉别页残留的禁用态）');
  check(/禁用态会残留 → 蓝牙页点不动（用户反馈的问题2）/.test(html), '修复理由已写在代码里');
  check(/addBtn\.style\.opacity = '0.4';[\s\S]{0,120}addBtn\.classList\.remove\('active'\);/.test(html),
    'ADB 页禁用时同时清掉蓝牙页可能留下的高亮');
  check(/addBtn\.style\.opacity = _wslRunning \? '' : '0\.4';[\s\S]{0,120}addBtn\.classList\.remove\('active'\);/.test(html),
    'WSL 页同样清掉高亮');
  check(/copyMonitorConfig\('main', mid, \{ skipPort: true \}\)/.test(html),
    '内嵌监视器继承主监视器设置但跳过端口（避免抢同一个串口）');
  check(/if \(opts && opts\.skipPort\) \{ delete cfg\.port; \}/.test(html), 'copyMonitorConfig 支持 skipPort');
  check(/monitors\[mid\]\.bleEmbedded = true/.test(html), '内嵌监视器打了 bleEmbedded 标记');
  check(/if \(mid === _bleExtraMon\) \{[\s\S]{0,240}bleArea\.classList\.remove\('active'\)/.test(html),
    'closeMonitor 收尾时清 _bleExtraMon 并收起监视器区（关闭后可再开）');
  check(/if \(m && m\.bleEmbedded\) return;/.test(html), 'collectConfig 不把内嵌监视器写进配置（不持久化）');
  check(!/蓝牙界面不可用/.test(html), '蓝牙页不再禁用「打开额外监视器」按钮');
  check(/var _bleExtraMon = null;/.test(html), '_bleExtraMon 已声明');

  // ---- 5k) 写入弹窗精简（用户要求：删 UUID 副标题 / Value 标签 / 独立提示行）----
  check(!/bleWriteChar/.test(html), '弹窗不再显示特征 UUID 副标题');
  check(!/bleWriteHint/.test(html) && !/ble-modal-hint/.test(html), '弹窗不再有独立提示行');
  check(!/ble-modal-label/.test(html), '弹窗不再有 Value 标签');
  check(!/ble-modal-sub/.test(html), '已清掉随之变成孤儿的 .ble-modal-sub 样式');
  check(/id="bleWriteModeWrap"/.test(html), 'HEX/文本（写响应/无响应）选择器保留');
  check(/标题区分四种用途/.test(html), '标题按目标区分特征/描述符（UUID 副标题删除后的信息补偿）');
  check(/id="bleWriteTitle">写入特征值</.test(html), '标题默认「写入特征值」');
  check(/bleWriteTitle'\)[\s\S]{0,120}'写入描述符值'/.test(html), '描述符写入时标题变「写入描述符值」');
  check(/else if \(kind === 'desc' && shortUuid\(uuid\) === '2902'\) inp0\.placeholder =/.test(html),
    'placeholder 按目标动态设置（CCCD 给取值提示）');
  check(/支持 \\\\r \\\\n \\\\t 转义，HEX 形如 01 A0 FF/.test(html),
    '转义/HEX 提示已并入 placeholder');
  check(/CCCD：0100 开启通知，0200 开启指示，0000 关闭/.test(html), 'CCCD 的取值提示也在 placeholder 里');
  // 输入框由单行 input 改为多行 textarea：默认更高（可调大小的是弹窗本身，见下）
  check(/<textarea class="ble-modal-inp" id="bleWriteValue" rows="3"/.test(html),
    '写入输入框是 textarea 且默认 3 行（比原单行 input 高）');
  check(/\.ble-modal-inp \{[^}]*min-height:64px;/.test(html), '输入框有最小高度');
  check(/\.ble-modal-inp \{[^}]*resize:none;/.test(html),
    '输入框自身不可拖动调整（用户要的是整个弹窗可调，不是输入框）');
  check(!/resize:vertical/.test(html), '已移除输入框的 resize:vertical');
  check(/if \(e\.key === 'Enter' && !e\.shiftKey\) \{ e\.preventDefault\(\); sendBleWrite\(\); \}/.test(html),
    'Enter 仍发送；Shift+Enter 交给 textarea 插入换行（多行值可用）');

  // ---- 5l) 整个发送弹窗可拖动调整大小 + 去掉多余 ✕ ----
  check(/\.ble-modal \{[^}]*resize:both;/.test(html), '弹窗本体可拖动调整大小（原生 resize:both）');
  check(/\.ble-modal \{[^}]*overflow:hidden;/.test(html), 'resize 需 overflow 非 visible，弹窗已满足');
  check(/\.ble-modal \{[^}]*min-width:320px; min-height:180px;/.test(html), '弹窗有最小尺寸（拖不没）');
  check(/\.ble-modal \{[^}]*max-height:calc\(100vh - 40px\)/.test(html), '弹窗有最大高度（不超出屏幕）');
  check(/\.ble-modal-body \{ padding:14px; flex:1; min-height:0; display:flex; \}/.test(html),
    '内容随窗口伸缩：body 吃掉剩余高度');
  check(/\.ble-modal-row \{ display:flex; align-items:stretch; gap:8px; flex:1; min-height:0; \}/.test(html),
    '行也拉伸，输入框填满可用空间');
  check(/\.ble-modal-row \.ble-write-opts \{ align-self:flex-start; \}/.test(html),
    '右侧选项列顶部对齐（不随输入框高度拉伸）');
  check(/\.ble-modal-grip \{ position:absolute; right:2px; bottom:2px;/.test(html) && /pointer-events:none/.test(html),
    '右下角有手柄提示且不拦截拖动（pointer-events:none，事件交给原生 resize）');
  check(!/ble-modal-close/.test(html), '多余的 ✕ 关闭按钮已删除（底部已有「关闭」）');  check(/bleWriteMaskPress\(event\)[\s\S]{0,80}bleWriteMaskClick\(event\)/.test(html),
    '遮罩改为按下点判定：拖弹窗时松手落到遮罩上不会误关');
  check(/if \(pressedOnMask && e\.target && e\.target\.id === 'bleWriteModal'\) closeBleWriteModal\(\);/.test(html),
    '只有「按下点就在遮罩上」才关闭弹窗');

  // ---- 5m) 弹窗新增「行尾」选项（与串口监视器一致）----
  check(/id="bleWriteLineEnd"/.test(html), '弹窗里有行尾下拉 #bleWriteLineEnd');
  check(html.indexOf('id="bleWriteAsText"') < html.indexOf('id="bleWriteLineEnd"'),
    '「行尾」位于「文本」格式设置下方（DOM 顺序）');
  check(/<span class="ble-write-label">行尾<\/span>/.test(html), '行尾控件带「行尾」标签（同串口监视器）');
  // 三行统一：每行「标签 + 下拉」，标签同款同宽、下拉同款同宽
  check(/<span class="ble-write-label">方式<\/span>/.test(html)
     && /<span class="ble-write-label">格式<\/span>/.test(html)
     && /<span class="ble-write-label">行尾<\/span>/.test(html),
    '方式/格式/行尾 三行都有标签（外观统一）');
  check((html.match(/class="ble-write-row"/g) || []).length === 3, '三行结构一致（.ble-write-row）',
    String((html.match(/class="ble-write-row"/g) || []).length));
  check(/\.ble-write-label \{[^}]*width:22px; text-align:right;/.test(html), '标签定宽右对齐 → 三个下拉左边缘对齐');
  check(/\.ble-write-opts \.send-as,\s*\.ble-write-opts \.sel \{ width:68px;[^}]*background:var\(--input-bg\);/.test(html),
    '弹窗内 .send-as 与 .sel 用同款盒子与同宽（原先一个是透明无边框、一个是盒子）');
  check(!/ble-write-le-label/.test(html), '旧的 .ble-write-le 结构已清理');
  check(/var wrap = document\.getElementById\('bleWriteModeRow'\);[\s\S]{0,90}modes\.length > 1/.test(html),
    '单写入方式时隐藏整行（含标签），不留孤立标签');
  const mLe = html.slice(html.indexOf('id="bleWriteLineEnd"'), html.indexOf('id="bleWriteLineEnd"') + 1000);
  check(['crlf', 'lf', 'cr', 'none'].every((v) => mLe.indexOf('data-val="' + v + '"') > 0),
    '行尾取值与串口监视器一致：CRLF / LF / CR / 无');
  check(/\.ble-write-opts \{ display:flex; flex-direction:column;/.test(html),
    '右侧选项列改为纵向排列（文本下方就是行尾）');
  const sb12 = { console };
  vm.createContext(sb12);
  vm.runInContext(extractFunction('leEscOf'), sb12);
  check(sb12.leEscOf('crlf') === '\\r\\n' && sb12.leEscOf('lf') === '\\n'
     && sb12.leEscOf('cr') === '\\r' && sb12.leEscOf('none') === '',
    'leEscOf 映射与串口 leStr 语义一致', JSON.stringify([sb12.leEscOf('crlf'), sb12.leEscOf('lf'), sb12.leEscOf('cr'), sb12.leEscOf('none')]));
  check(sb12.leEscOf(undefined) === '' && sb12.leEscOf('bogus') === '',
    '未取到值时不追加（不会写入垃圾字节）');
  check(/var payload = hexMode \? text : \(text \+ leEscOf\(leVal\)\);/.test(html),
    '发送时按行尾拼接：仅文本模式追加（HEX 不追加，与串口一致）');
  check(/var leVal = leEl \? \(leEl\.getAttribute\('data-val'\) \|\| 'crlf'\) : 'crlf';/.test(html),
    '读不到控件时回退 crlf（与串口默认一致）');
  check(/leLog: \(hexMode \|\| leVal === 'none'\) \? '' : ' · 行尾 ' \+ leVal\.toUpperCase\(\)/.test(html),
    '日志里标明追加的行尾');
  check((html.match(/\+ leLog \+/g) || []).length === 2, '特征与描述符两条发送日志都带上行尾信息');
  // 四种用途（主机特征 / 描述符 / 从机设值 / 从机下发）共用同一份弹窗内容解析
  check(/function bleReadWriteModalInput\(\)/.test(html), '弹窗内容解析已抽成共用函数');
  check(/var r = bleReadWriteModalInput\(\);/.test(html) && /bleReadWriteModalInput\(\)/.test(html),
    '主机发送走共用解析');

  // ---- 5j) 内嵌监视器的宽度拖拽（用户反馈「向左拖动失效」：原来根本没做拖拽）----
  check(/id="ble-monResize"/.test(html) && /title="拖动调节宽度"/.test(html), '监视器区有宽度拖拽手柄');
  check(/\.ble-mon-resize \{ width:5px; cursor:col-resize;/.test(html),
    '手柄是 5px 宽的 col-resize 手柄（与 WSL 页 .wsl-mon-resize 同风格）');
  check(/\.ble-mon-resize:hover, \.ble-mon-resize\.dragging \{ background:var\(--split-line\); \}/.test(html),
    '悬停/拖拽时手柄高亮为主题分割线色');
  check(/function initBleMonResize\(\)/.test(html) && /initBleMonResize\(\);/.test(html),
    'initBleMonResize 已实现并在蓝牙页初始化时绑定');
  check(/document\.removeEventListener\('mousemove', onMouseMove\)/.test(html),
    '松手时移除 document 级监听（不泄漏）');
  check(/area\.style\.flex = '0 0 ' \+ finalW \+ 'px';/.test(html),
    '松手后宽度转 flex-basis（窗口缩小时仍能自动收窄）');
  const sb11 = { console };
  vm.createContext(sb11);
  vm.runInContext(extractFunction('clampBleMonWidth'), sb11);
  check(sb11.clampBleMonWidth(380, 1000, 900, 1367) === 480, '向左拖 100px → 变宽 100px',
    String(sb11.clampBleMonWidth(380, 1000, 900, 1367)));
  check(sb11.clampBleMonWidth(380, 1000, 1300, 1367) === 280, '向右拖过头 → 收窄到下限 280',
    String(sb11.clampBleMonWidth(380, 1000, 1300, 1367)));
  check(sb11.clampBleMonWidth(380, 1000, 0, 1367) === Math.round(1367 * 0.46),
    '向左拖过头 → 卡在上限 46% 视口', String(sb11.clampBleMonWidth(380, 1000, 0, 1367)));
  check(sb11.clampBleMonWidth(380, 1000, 900, 0) === 280, '视口宽度为 0 时不炸：夹到下限 280',
    String(sb11.clampBleMonWidth(380, 1000, 900, 0)));
  check(sb11.clampBleMonWidth(280, 1000, 1000, 1367) === 280, '已经在下限时向右拖不再变窄');
  check(sb11.clampBleMonWidth(380, 1000, 1000, 1367) === 380, '原地不拖保持原宽');

  // ---- 5e-3) 服务行右侧标签：识别到类型不标，识别不到统一 Custom Service ----
  const sb9 = { console };
  vm.createContext(sb9);
  vm.runInContext([
    extractObject('BLE_SVC_NAMES'), extractFunction('shortUuid'), extractFunction('renderBleServiceRow'),
  ].join('\n'), sb9);
  const rowStd = sb9.renderBleServiceRow({ uuid: '00001800-0000-1000-8000-00805f9b34fb', primary: true });
  check(rowStd.indexOf('Generic Access') > 0, '标准服务 0x1800 显示名称 Generic Access');
  check(rowStd.indexOf('Custom Service') < 0, '标准服务不打 Custom Service 标签');
  check(rowStd.indexOf('>Service</span>') < 0, '不再出现无信息量的固定 "Service" 标签');
  const rowCustom = sb9.renderBleServiceRow({ uuid: '00010203-0405-0607-0809-0a0b0c0d1912', primary: true });
  check(rowCustom.indexOf('Custom Service') > 0, '自定义 128 位服务标 Custom Service', 'HEPPYd 服务');
  check(rowCustom.indexOf('ble-svc-name') < 0, '自定义服务左侧不显示名称');
  check(!!sb9.BLE_SVC_NAMES['1809'] && !!sb9.BLE_SVC_NAMES['1812'],
    '名称表覆盖常见标准服务（0x1809 体温计 / 0x1812 HID）');
  check(!sb9.BLE_SVC_NAMES['FF00'], '已移除泛化的 FF00=Vendor（按厂商私有处理，标 Custom Service）');
  check(/class="ble-svc-type" title="Generic Access">Generic Access</.test(rowStd),
    '标准服务的名称落在最右的类型位上（同一元素）');
  check(/class="ble-svc-type" title="Custom Service">Custom Service</.test(rowCustom),
    '未识别服务在最右显示 Custom Service（同一元素、同一位置）');  const rowVendor = sb9.renderBleServiceRow({ uuid: '0000ff00-0000-1000-8000-00805f9b34fb', primary: true });
  check(rowVendor.indexOf('Custom Service') > 0, '0xFF00 归为 Custom Service（不是标准 SIG 服务）');
  check(sb9.renderBleServiceRow({ uuid: '00001800-0000-1000-8000-00805f9b34fb', primary: false })
        .indexOf('>S</span>') > 0, '从服务标记为 S');

  // ---- 5f) 已连接设备不在扫描列表里时，仍要补进列表 ----
  // （复现路径：经「保留外设对象」重连的设备不在适配器表内 → ble_get_devices 不含它
  //   → 切页回来 refreshBleDevices 后列表里没有它 → 右侧详情空掉）
  const mkRefresh = (devs, connAddr, connInfo) => {
    const s = { console, _bleDevices: [], _bleConnInfo: connInfo || null, _bleConnAddr: null, _bleSelected: null };
    s.renderBleDeviceList = () => {}; s.renderBleDetail = () => {};
    s.invoke = (cmd) => Promise.resolve(cmd === 'ble_get_devices' ? devs : connAddr);
    vm.createContext(s);
    vm.runInContext(extractFunction('refreshBleDevices'), s);
    return s;
  };
  const sr = mkRefresh([{ address: 'AA:BB:CC:DD:EE:01', local_name: '其它设备', rssi: -70 }],
    'CC:DD:EE:FF:00:11', { address: 'CC:DD:EE:FF:00:11', name: '我的设备', rssi: -55, deviceType: 'apple' });
  sr.refreshBleDevices();
  await new Promise((r) => setTimeout(r, 20));
  const stub = sr._bleDevices.filter((d) => d.address === 'CC:DD:EE:FF:00:11')[0];
  check(!!stub, '已连接但不在扫描结果里的设备被补进列表');
  check(!!stub && stub.connected === true && stub.name === '我的设备',
    '补进的条目带 connected 与已知名称', stub && (stub.name + '/' + stub.connected));
  check(sr._bleSelected === 'CC:DD:EE:FF:00:11', '补进后选中项落在已连接设备');
  const sr2 = mkRefresh([{ address: 'AA:BB:CC:DD:EE:01', local_name: '设备A', rssi: -70 }], null, null);
  sr2.refreshBleDevices();
  await new Promise((r) => setTimeout(r, 20));
  check(sr2._bleDevices.length === 1 && sr2._bleDevices[0].address === 'AA:BB:CC:DD:EE:01',
    '未连接时不额外补条目（不污染列表）', String(sr2._bleDevices.length));

  // ---- 5g) 设备主动断开：界面要立刻切成未连接（靠 RSSI 轮询回报 connected=false）----
  check(/if \(info\.connected === false\) \{ onBleLinkLost\(\); return; \}/.test(html),
    'RSSI 轮询检测到链路断开时调用 onBleLinkLost');
  const sb6 = {
    console, _bleConnAddr: 'CC:DD:EE:FF:00:11', _bleConnInfo: { address: 'CC:DD:EE:FF:00:11' },
    _bleServices: [{ uuid: 'AAAA' }], _bleSubs: { 'AAAA::notify': true }, _bleSelected: 'CC:DD:EE:FF:00:11',
    _bleDevices: [{ address: 'CC:DD:EE:FF:00:11', connected: true }],
    _bleLog: [], _bleLogMax: 400, _toasts: [], _stopped: 0,
    document: { getElementById: () => null },
  };
  sb6.stopBleNotifyPoll = () => {};
  sb6.stopBleRssiPoll = () => { sb6._stopped++; };
  sb6.closeBleWriteModal = () => {};
  sb6.showToast = (m, t) => sb6._toasts.push(t);
  sb6.renderBleDeviceList = () => {};
  sb6.renderBleDetail = () => {};
  vm.createContext(sb6);
  vm.runInContext(['logBle', 'renderBleLog', 'clearBleLog', 'onBleLinkLost'].map(extractFunction).join('\n'), sb6);
  sb6.onBleLinkLost();
  check(sb6._bleConnAddr === null && sb6._bleServices.length === 0 && Object.keys(sb6._bleSubs).length === 0,
    '链路断开：清空连接态/服务/订阅');
  check(sb6._bleDevices.every((d) => !d.connected), '链路断开：清掉列表里的「已连接」标记');
  check(sb6._stopped === 1, '链路断开：停止轮询', String(sb6._stopped));
  check(sb6._bleLog.length === 1 && (sb6._bleLog[0].text || '').indexOf('[已断开]') === 0,
    '链路断开：日志留一行原因（已清空后只此一行）', JSON.stringify(sb6._bleLog));
  check(sb6._toasts[0] === 'error', '链路断开：弹出提示');
  const sb4 = { console, TextEncoder };
  vm.createContext(sb4);
  vm.runInContext([extractFunction('hexToBytes'), extractFunction('parseEscapes'), extractFunction('bleSendBytes')].join('\n'), sb4);
  check(JSON.stringify(sb4.bleSendBytes('01 02 FF', true)) === '[1,2,255]',
    'HEX 模式：\'01 02 FF\' → [1,2,255]', JSON.stringify(sb4.bleSendBytes('01 02 FF', true)));
  check(JSON.stringify(sb4.bleSendBytes('AT', false)) === '[65,84]',
    '文本模式：\'AT\' → [65,84]', JSON.stringify(sb4.bleSendBytes('AT', false)));
  check(JSON.stringify(sb4.bleSendBytes('A\\r\\n', false)) === '[65,13,10]',
    '文本模式支持 \\r\\n 转义 → [65,13,10]', JSON.stringify(sb4.bleSendBytes('A\\r\\n', false)));
  let threw = false;
  try { sb4.bleSendBytes('zz', true); } catch (e) { threw = true; }
  check(threw, 'HEX 模式非法输入会抛错（由调用处提示格式错误）');

  const sb = { console, setTimeout };
  sb._bleSelected = null;
  sb._bleConnAddr = null;
  sb._bleDevices = [];
  sb.renderBleDeviceList = () => {};
  sb.renderBleDetail = () => {};
  sb.invoke = (cmd) => {
    if (cmd === 'ble_get_devices') {
      return Promise.resolve([
        { address: 'AA:BB:CC:DD:EE:01', local_name: '已连接设备', rssi: -50, adv_raw: null, services: [] },
        { address: 'AA:BB:CC:DD:EE:02', local_name: '其它设备', rssi: -60, adv_raw: null, services: [] },
      ]);
    }
    if (cmd === 'ble_get_connection') return Promise.resolve('AA:BB:CC:DD:EE:01');
    return Promise.resolve(null);
  };
  vm.createContext(sb);
  vm.runInContext(extractFunction('refreshBleDevices'), sb);
  sb.refreshBleDevices();
  await new Promise((r) => setTimeout(r, 30));

  const c1 = sb._bleDevices.find((d) => d.address === 'AA:BB:CC:DD:EE:01');
  const c2 = sb._bleDevices.find((d) => d.address === 'AA:BB:CC:DD:EE:02');
  check(!!c1 && c1.connected === true,
    '切页刷新后：已连接设备保持 connected=true',
    JSON.stringify(sb._bleDevices.map((d) => [d.address, d.connected])));
  check(!!c2 && c2.connected === false, '切页刷新后：未连接设备 connected=false');
  check(sb._bleSelected === 'AA:BB:CC:DD:EE:01', '切页刷新后：选中项落在已连接设备');

  // ---- 6) 本轮新增：ADB 串号回填 + parseAnsi 不再吞掉分块剩余文本 ----
  const sb7 = { console };
  vm.createContext(sb7);
  vm.runInContext([extractFunction('pickAdbSerials')].join('\n'), sb7);
  check(JSON.stringify(sb7.pickAdbSerials([{ serial: 'ABC123' }, { serial: 'XYZ' }])) === '["ABC123","XYZ"]',
    'pickAdbSerials 从设备列表取出串号', JSON.stringify(sb7.pickAdbSerials([{ serial: 'ABC123' }, { serial: 'XYZ' }])));
  check(JSON.stringify(sb7.pickAdbSerials([{ serial: 'A' }, { serial: 'A' }, {}, null])) === '["A"]',
    'pickAdbSerials 去重并跳过空/非法项', JSON.stringify(sb7.pickAdbSerials([{ serial: 'A' }, { serial: 'A' }, {}, null])));
  check(JSON.stringify(sb7.pickAdbSerials(null)) === '[]' && JSON.stringify(sb7.pickAdbSerials('x')) === '[]',
    'pickAdbSerials 对非数组输入返回空数组（不抛错）');

  const sb8 = { console };
  vm.createContext(sb8);
  vm.runInContext([extractFunction('escapeHtml'), extractFunction('consumeAnsi'), extractFunction('parseAnsi')].join('\n'), sb8);
  const truncated = sb8.parseAnsi('before\u001b[3');
  check(truncated.indexOf('before') === 0, 'parseAnsi 保留被截断序列之前的文本', JSON.stringify(truncated));
  check(truncated.length > 'before'.length,
    'parseAnsi 不再丢弃截断序列之后的剩余文本（改为按字面输出）', JSON.stringify(truncated));
  const colored = sb8.parseAnsi('a\u001b[31mred\u001b[0m');
  check(colored.indexOf('red') > 0 && colored.indexOf('\u001b') < 0,
    'parseAnsi 对完整序列仍正常解析为 span（不含裸 ESC）', JSON.stringify(colored.slice(0, 40)));

  // ---- 7) BLE 配对（WinRT）：后端命令 + 前端弹窗与连接编排 ----
  // 后端：两个命令必须注册、状态必须 manage、事件名必须与前端一致
  check(/async fn ble_pair\(app: tauri::AppHandle, address: String\)/.test(mainRs), '后端有 ble_pair 命令');
  check(/fn ble_pair_respond\(state: tauri::State<'_, BlePairState>, accept: bool, pin: Option<String>\)/.test(mainRs),
    '后端有 ble_pair_respond 命令（接收前端答复）');
  check(/^\s*ble_pair,\s*$/m.test(mainRs) && /^\s*ble_pair_respond,\s*$/m.test(mainRs),
    '两个命令已注册进 generate_handler!（漏注册会静默不可用）');
  check(/\.manage\(BlePairState \{ responder: Mutex::new\(None\) \}\)/.test(mainRs), 'BlePairState 已 manage');
  check(/app\.emit\("ble-pair-request"/.test(mainRs), '后端通过 ble-pair-request 事件询问前端');
  check(/rx\.recv_timeout\(std::time::Duration::from_secs\(60\)\)/.test(mainRs),
    '后端等用户确认有 60 秒超时（超时按取消处理，不会永久挂住）');
  check(/args\.GetDeferral\(\)\?/.test(mainRs) && /deferral\.Complete\(\)\?/.test(mainRs),
    'WinRT 配对请求里有 deferral（等用户答复期间不让系统提前收走请求）');
  check(/args\.AcceptWithPin\(&HSTRING::from\(user_pin\.as_str\(\)\)\)/.test(mainRs)
     && /args\.Accept\(\)/.test(mainRs),
    '按配对类型分别用 AcceptWithPin / Accept');
  check(/DevicePairingKinds::ConfirmOnly[\s\S]{0,120}DevicePairingKinds::DisplayPin[\s\S]{0,120}DevicePairingKinds::ProvidePin[\s\S]{0,120}DevicePairingKinds::ConfirmPinMatch/.test(mainRs),
    '四种配对类型都申请（确认/显示配对码/输入配对码/比对配对码）');
  check(/fn bt_addr_to_u64\(/.test(mainRs) && /bt_addr_to_u64_parses_mac/.test(mainRs),
    '地址解析有实现且有单测（cargo test 覆盖）');

  // 前端：弹窗结构
  check(/id="blePairModal"/.test(html), '前端有配对弹窗 #blePairModal');
  check(/id="blePairPin"/.test(html) && /id="blePairInput"/.test(html) && /id="blePairDev"/.test(html),
    '弹窗含配对码大字区 / PIN 输入框 / 设备信息区');
  check(/onclick="submitBlePair\(false\)"/.test(html) && /onclick="submitBlePair\(true\)"/.test(html),
    '弹窗有取消与确认两个按钮');
  check(/60 秒内未确认将自动取消/.test(html), '弹窗提示超时（与后端 60 秒对齐）');
  check(/\.ble-pair-modal \{ width:380px; min-width:320px; resize:none; \}/.test(html),
    '配对弹窗固定尺寸（不继承写入弹窗的 resize:both）');

  // 前端：纯函数文案映射（四种配对类型）
  const sbPair = { console };
  vm.createContext(sbPair);
  vm.runInContext(extractFunction('blePairPrompt'), sbPair);
  check(sbPair.blePairPrompt('display').indexOf('在蓝牙设备上输入') > 0, 'display：提示到设备上输入配对码');
  check(sbPair.blePairPrompt('match').indexOf('核对') > 0, 'match：提示核对两端配对码');
  check(sbPair.blePairPrompt('provide').indexOf('输入设备上显示的配对码') > 0, 'provide：提示输入设备显示的配对码');
  check(sbPair.blePairPrompt('confirm').indexOf('确认') > 0, 'confirm：提示在设备上确认');
  check(sbPair.blePairPrompt(undefined) === sbPair.blePairPrompt('confirm'), '未知类型按 confirm 处理（不抛错）');

  // 前端：事件监听与答复回传
  check(/listen\('ble-pair-request', function\(ev\) \{\s*showBlePairDialog\(ev && ev\.payload\);/.test(html),
    '前端监听 ble-pair-request 并弹出配对窗');
  check(/invoke\('ble_pair_respond', \{ accept: !!accept, pin: pin \}\)/.test(html),
    '确认/取消把 accept + pin 回传后端');
  check(/var showPin = \(p\.kind === 'display' \|\| p\.kind === 'match'\) && !!p\.pin;/.test(html),
    'display/match 显示配对码大字');
  check(/inp\.style\.display = \(p\.kind === 'provide'\) \? '' : 'none';/.test(html),
    'provide 才显示 PIN 输入框');

  // 前端：连接编排（失败 → 配对 → 重试一次，成功路径复用）
  check(/function tryBlePairThenReconnect\(address, label, origErr\)/.test(html), '有"配对后重连"流程');
  check(/invokeTimeout\('ble_pair', \{ address: address \}, BLE_PAIR_TIMEOUT_MS\)/.test(html),
    '按 75 秒超时发起配对（后端 60 秒 + 余量）');
  check(/var BLE_PAIR_TIMEOUT_MS = 75000;/.test(html), '配对超时常量已定义');
  check(/if \(!paired\) throw \('配对未完成（被取消或失败）· 原连接错误: ' \+ origErr\);/.test(html),
    '用户取消配对时保留原始连接错误（不会只剩一句"配对失败"）');
  check(/\.catch\(function\(pe\) \{\s*throw \('配对失败: ' \+ pe \+ ' · 原连接错误: ' \+ origErr\);/.test(html),
    '配对本身失败时同样带上原始连接错误');
  check(/tryBlePairThenReconnect\(address, label, e\)\.catch\(fail\);/.test(html),
    '确认需要配对时，catch 分支接入配对重试，最终仍失败才报错');
  const onConnCount = (html.match(/bleOnConnected\(address, label\)/g) || []).length;
  check(onConnCount >= 3, '成功路径复用同一个 bleOnConnected（含配对后重连）', String(onConnCount));

  // ---- 8) 通知/接收数据默认按文本显示（用户反馈：文本 payload 被显示成十六进制）----
  // 文本 case：文本在前、十六进制灰显跟在后面（用户选 A）：走 logBleDim + .ble-log-dim
  check(/logBleDim\(label \+ '  ' \+ bleFmtBytes\(bytes\) \+ ' · ', hex\);/.test(html),
    '文本可读时：文本 + 灰色十六进制（用 logBleDim 追加灰显段）');
  check(/\.ble-log-dim \{ color:var\(--text-d\); \}/.test(html), '灰色段有对应样式 .ble-log-dim');
  check(/logBle\(label \+ '  ' \+ hex\);/.test(html), '二进制/解析失败时仍直接显示十六进制');
  check(/function logBleDim\(text, dim\)/.test(html) && /_bleLog\.push\(\{ text: \(text \|\| ''\) \+ \(dim \|\| ''\), dim: dim \|\| '' \}\)/.test(html),
    'logBleDim 以结构化条目入缓冲，并把 dim 追加成 text 的后缀');
  // 日志渲染改成 innerHTML → 必须全部转义（设备数据是注入面）
  check(/log\.innerHTML = bleLogToHtml\(_bleLog, escapeHtml\) \+ '\\n';/.test(html),
    '日志渲染经 bleLogToHtml + escapeHtml（内容全部转义后才插入）');
  const sbLog = { console };
  vm.createContext(sbLog);
  vm.runInContext([extractFunction('bleLogToHtml'), extractFunction('escapeHtml')].join('\n'), sbLog);
  const esc = function(s) { return sbLog.escapeHtml(s); };
  check(sbLog.bleLogToHtml([{ text: '[通知] X: 你是谁\\r\\n · E4 BD A0' }], esc) === '[通知] X: 你是谁\\r\\n · E4 BD A0',
    '纯文本条目原样输出');
  const dimHtml = sbLog.bleLogToHtml([{ text: 'a · E4 BD', dim: 'E4 BD' }], esc);
  check(dimHtml === 'a · <span class="ble-log-dim">E4 BD</span>',
    'dim 段被包进 .ble-log-dim（前半段仍正常显示）', dimHtml);
  const inj = sbLog.bleLogToHtml([{ text: '<img src=x onerror=alert(1)>', dim: 'x>' }], esc);
  check(inj.indexOf('<img') < 0 && inj.indexOf('&lt;img') === 0,
    '日志内容里的 HTML 被转义（设备数据不能当 HTML 插入）', inj);
  check(sbLog.bleLogToHtml([], esc) === '' && sbLog.bleLogToHtml(null, esc) === '', '空缓冲安全返回');
  check(sbLog.bleLogToHtml(['旧格式字符串'], esc) === '旧格式字符串', '兼容历史字符串条目');

  // ---- 9) 配对只在"确实需要配对"时才发起（用户反馈：普通失败也去配对，干扰了连接）----
  const sbPairErr = { console };
  vm.createContext(sbPairErr);
  vm.runInContext(extractFunction('bleErrNeedsPairing'), sbPairErr);
  const needs = function(s) { return sbPairErr.bleErrNeedsPairing(s); };
  // 截图里的真实失败信息：普通连接失败，绝不能触发配对
  check(needs('connect: Not connected') === false, '「connect: Not connected」不触发配对（本次回归）');
  check(needs('connect: 连到系统上的设备没有发挥作用') === false, '设备异常类错误不触发配对');
  check(needs('连接超时') === false && needs('未找到该蓝牙设备') === false, '超时/未找到都不触发配对');
  check(needs('') === false && needs(undefined) === false && needs(null) === false,
    '空错误不触发配对（不抛错）');
  check(needs('E_BLUETOOTH_ATT_INSUFFICIENT_AUTHENTICATION') === true, '认证不足 → 触发配对');
  check(needs('insufficient_encryption') === true, '加密不足 → 触发配对');
  check(needs('0x80650005') === true && needs('0x8065000C') === true, 'HRESULT 形式也能识别');
  check(needs('device not paired') === true, 'not paired 文案能识别');
  check(needs('设备未配对') === true, '中文未配对能识别');
  // 接线：catch 里必须先判定，普通失败直接走失败处理
  check(/if \(!bleErrNeedsPairing\(e\)\) \{\s*fail\(e\);\s*return;\s*\}/.test(html),
    '连接失败先判定是否需要配对，不需要则直接失败（不发起配对、不打乱链路）');
  check(/配对仪式会占用设备\/打断链路/.test(html), '该约束的理由已写在代码注释里');

  // ---- 10) 通知/读取日志标明来源服务（用户反馈：看不到是哪个服务收到的）----
  check(/var from = bleSvcLabel\(it\.service_uuid\) \+ ' · 0x' \+ shortUuid\(it\.uuid \|\| ''\);/.test(html),
    '通知日志带来源服务（用后端给的 service_uuid）');
  check(/'\[读取\] ' \+ \(svc \? bleSvcLabel\(svc\) \+ ' · ' : ''\)/.test(html),
    '读取日志也标明来源服务（反查服务树）');
  const sbSvc = { console };
  vm.createContext(sbSvc);
  vm.runInContext([extractObject('BLE_SVC_NAMES'), extractFunction('shortUuid'),
                   extractFunction('bleSvcLabel'), extractFunction('bleFindSvcOfChar')].join('\n'), sbSvc);
  check(sbSvc.bleSvcLabel('0000180a-0000-1000-8000-00805f9b34fb') === '0x180A Device Information',
    '已知服务 → 短 UUID + 名称', sbSvc.bleSvcLabel('0000180a-0000-1000-8000-00805f9b34fb'));
  check(sbSvc.bleSvcLabel('00010203-0405-0607-0809-0a0b0c0d1912') === '0x00010203-0405-0607-0809-0A0B0C0D1912',
    '自定义服务 → 只给短 UUID', sbSvc.bleSvcLabel('00010203-0405-0607-0809-0a0b0c0d1912'));
  check(sbSvc.bleSvcLabel('') === '?' && sbSvc.bleSvcLabel(undefined) === '?', '拿不到服务 → 显示 ?');
  const svcTree = [
    { uuid: 'A-SVC', characteristics: [{ uuid: 'A1' }, { uuid: 'A2' }] },
    { uuid: 'B-SVC', characteristics: [{ uuid: 'B1' }] },
  ];
  check(sbSvc.bleFindSvcOfChar(svcTree, 'B1') === 'B-SVC', '反查到特征所属服务');
  check(sbSvc.bleFindSvcOfChar(svcTree, 'NOPE') === '', '找不到时返回空串');
  check(sbSvc.bleFindSvcOfChar(null, 'A1') === '' && sbSvc.bleFindSvcOfChar([{ uuid: 'S' }], 'A1') === '',
    '服务树为空/缺 characteristics 时不抛错');

  // ---- 11) 扫描中提示 + 通知换行 + 蓝牙页状态按用户配置文件保留 ----
  // 扫描态占位：扫描中与未扫描要分开
  check(/_bleScanning\s*\n?\s*\? '<div class="ble-empty scanning"><b>正在扫描…<\/b>/.test(html),
    '空列表在扫描时提示「正在扫描…」');
  check(/list\.innerHTML = _bleScanning[\s\S]{0,200}未发现蓝牙设备/.test(html),
    '未扫描时仍提示「未发现蓝牙设备 / 点击开始扫描」');
  check(/if \(!_bleDevices\.length\) renderBleDeviceList\(\);   \/\/ 空列表时立刻显示「正在扫描…」/.test(html),
    '开始扫描时立即刷新占位（不等第一次轮询回调）');
  check(/if \(!_bleDevices\.length\) renderBleDeviceList\(\);   \/\/ 空列表时把「正在扫描…」换回未发现提示/.test(html),
    '停止扫描（含 5 秒自动停止）时刷新占位');
  check(/\.ble-empty\.scanning b \{ color:var\(--accent-focus\); \}/.test(html), '扫描中提示有高亮样式');

  // 通知换行：来源单独一行，payload 另起一行
  check(/var label = '\[通知\] ' \+ from \+ ':\\n';/.test(html),
    '通知日志在冒号后换行（来源单独一行）');
  check(/logBleDim\(label \+ '  ' \+ bleFmtBytes\(bytes\) \+ ' · ', hex\);/.test(html),
    '换行后 payload 缩进两格，十六进制仍灰显跟在文本后');
  check(/logBle\(label \+ '  ' \+ hex\);/.test(html), '二进制 case 同样换行缩进');

  // 状态保留：纯数据采集函数 + 恢复 + 消费
  const sbBle = { console };
  vm.createContext(sbBle);
  // collectBleState 现在会读左栏宽度默认值 → 沙箱里也得有这个常量
  vm.runInContext([/var BLE_LEFT_DEFAULT = \d+, BLE_LEFT_MIN = \d+;/.exec(html)[0],
    extractFunction('collectBleState')].join('\n'), sbBle);
  const norm = sbBle.collectBleState({ monitor: 1, monitorWidth: 0, openSvcs: ['A'], filterText: 'x' });
  check(norm.monitor === true && norm.monitorWidth === 380 && norm.advOpen === false
     && norm.filterOpen === false && norm.selected === '' && norm.monitorCfg === null,
    'collectBleState 归一化并补默认值（宽度 0 → 380，缺省字段给安全值）', JSON.stringify(norm));
  check(norm.leftWidth === 288 && sbBle.collectBleState({ leftWidth: 320 }).leftWidth === 320,
    '左栏宽度进配置：缺省 288，给了就照用', JSON.stringify([norm.leftWidth, sbBle.collectBleState({ leftWidth: 320 }).leftWidth]));
  check(Array.isArray(norm.openSvcs) && norm.openSvcs[0] === 'A' && norm.filterText === 'x',
    'collectBleState 保留展开服务与过滤词');
  check(JSON.stringify(sbBle.collectBleState()) === JSON.stringify(sbBle.collectBleState({})),
    'collectBleState 空参不抛错');
  check(/cfg\.ble = collectBleState\(\{/.test(html) && /monitor: !!\(_bleExtraMon && monitors\[_bleExtraMon\]\)/.test(html),
    '保存时写入 cfg.ble（含监视器是否打开）');
  check(/monitorCfg: \(_bleExtraMon && monitors\[_bleExtraMon\]\) \? collectConfigForMonitor\(_bleExtraMon\) : null/.test(html),
    '内嵌监视器的端口/波特率等单独存进 monitorCfg');
  check(/if \(m && m\.bleEmbedded\) return;/.test(html),
    'monitors 里仍排除 bleEmbedded（避免被当成普通 extra-N 恢复）');
  check(/if \(cfg\.ble\) restoreBleState\(cfg\.ble\);/.test(html), '启动时恢复蓝牙页状态');
  check(/function restoreBleState\(b\) \{[\s\S]{0,400}_bleRestoreMon = b\.monitor \? \{ width: _bleMonWidth, cfg: b\.monitorCfg \|\| null \} : null;/.test(html),
    'restoreBleState 记录监视器意图（DOM 懒加载，不能在此直接开）');
  check(/if \(_bleRestoreMon\) \{[\s\S]{0,420}toggleBleMonitor\(\);[\s\S]{0,200}applyMonitorConfig\('ble-mon', want\.cfg\);/.test(html),
    '蓝牙页 DOM 就绪后消费：打开监视器并套用它的设置');
  check(/if \(area && want\.width\) area\.style\.flex = '0 0 ' \+ want\.width \+ 'px';/.test(html),
    '恢复内嵌监视器宽度');
  check(/_bleMonWidth = finalW;[\s\S]{0,400}scheduleConfigSave\(\);/.test(html),
    '拖动结束后记录宽度并保存');
  check(/if \(filterInp\) filterInp\.value = _bleFilterText \|\| '';/.test(html)
     && /if \(filterBody\) filterBody\.style\.display = _bleFilterOpen \? '' : 'none';/.test(html),
    '恢复过滤框内容与展开态（DOM 就绪后）');
  // 各处状态变更都要触发保存，否则只在退出时写盘
  const saveSites = [
    [/toggleBleFilter\(el\) \{[\s\S]{0,260}scheduleConfigSave\(\)/, '过滤区展开态'],
    [/function applyBleFilter\(\)[\s\S]{0,220}scheduleConfigSave\(\)/, '过滤关键字'],
    [/function toggleBleAdv\(el\)[\s\S]{0,300}scheduleConfigSave\(\)/, '广播内容展开态'],
    [/_bleSelected = dev\.address;\s*\n\s*scheduleConfigSave\(\)/, '选中设备'],
  ];
  saveSites.forEach(function(pair) {
    check(pair[0].test(html), '状态变更即保存：' + pair[1]);
  });
  const svcSave = (html.match(/scheduleConfigSave\(\);   \/\/ 展开状态随用户配置保留/g) || []).length;
  check(svcSave >= 2, '服务展开/收起两条路径都会保存', String(svcSave));

  // ---- 12) 读取轮询：可见时实时、隐藏时降频（A）+ 缓冲超限丢弃要提示（B）----
  const sbPoll = { console };
  vm.createContext(sbPoll);
  const msVis = parseInt((html.match(/var MON_READ_MS_VISIBLE = (\d+);/) || [])[1], 10);
  const msHid = parseInt((html.match(/var MON_READ_MS_HIDDEN = (\d+);/) || [])[1], 10);
  vm.runInContext([
    'var MON_READ_MS_VISIBLE = ' + msVis + ';',
    'var MON_READ_MS_HIDDEN = ' + msHid + ';',
    extractFunction('monitorHostId'), extractFunction('monitorVisible'), extractFunction('monitorPollMs'),
  ].join('\n'), sbPoll);
  check(sbPoll.monitorHostId('ble-mon') === 'ble-pane', '蓝牙页内嵌监视器 → ble-pane');
  check(sbPoll.monitorHostId('wsl') === 'wsl-pane' && sbPoll.monitorHostId('wsl-x2') === 'wsl-pane',
    'WSL 监视器（含额外）→ wsl-pane');
  check(sbPoll.monitorHostId('main') === 'paneContainer' && sbPoll.monitorHostId('extra-3') === 'paneContainer',
    '串口监视器（含额外）→ paneContainer');
  const mkDoc = function(hidden, disp) {
    return { hidden: hidden, getElementById: function() { return disp === null ? null : { style: { display: disp } }; } };
  };
  check(sbPoll.monitorVisible('main', mkDoc(false, 'flex')) === true, '页面可见 → true');
  check(sbPoll.monitorVisible('main', mkDoc(false, 'none')) === false, '所在页面 display:none → false');
  check(sbPoll.monitorVisible('main', mkDoc(true, 'flex')) === false, '窗口最小化/切走（document.hidden）→ false');
  check(sbPoll.monitorVisible('main', mkDoc(false, null)) === false, '容器不存在时不抛错、按不可见处理');
  check(sbPoll.monitorPollMs('main', mkDoc(false, 'flex')) === msVis
     && sbPoll.monitorPollMs('main', mkDoc(false, 'none')) === msHid,
    '可见用实时频率 / 隐藏用降频频率', msVis + ' / ' + msHid);
  check(msVis === 25 && msHid === 500, '两个频率常量已定义且符合预期（25 / 500）', msVis + ' / ' + msHid);
  const pollUse = (html.match(/\}, monitors\[mid\]\._pollMs \|\| MON_READ_MS_VISIBLE\);/g) || []).length;
  check(pollUse === 2, '串口与 WSL 两个读循环都按 _pollMs 起定时器', String(pollUse));
  const pollSet = (html.match(/monitors\[mid\]\._pollMs = monitorPollMs\(mid\);/g) || []).length;
  check(pollSet === 2, '两个启动函数都记录本次频率', String(pollSet));
  check(/if \(m\.isWsl\) startWslReading\(mid\); else startReading\(mid\);/.test(html),
    '重设频率时按 WSL/串口分别调对应启动函数');
  const pollHook = (html.match(/refreshMonitorPollRates\(\);   \/\/ 页面切换/g) || []).length;
  check(pollHook === 6, '6 个页面切换点都重设频率（进入/离开 WSL、蓝牙、ADB）', String(pollHook));
  check(/document\.addEventListener\('visibilitychange', function\(\) \{ refreshMonitorPollRates\(\); \}\);/.test(html),
    '窗口最小化/恢复时也重设');
  // B：缓冲超限丢弃要记账并提示
  check(/dropped: std::sync::Arc<std::sync::atomic::AtomicU64>/.test(mainRs), '后端有丢弃计数');
  check(/let prev = dropped_clone\.fetch_add\(drain as u64/.test(mainRs), '缓冲裁剪时累计丢弃字节');
  check(/fn take_dropped\(&self\) -> u64 \{[\s\S]{0,120}swap\(0,/.test(mainRs), 'take_dropped 取走并清零');
  check(/struct ReadDataResult \{[\s\S]{0,80}bytes: Vec<u8>,[\s\S]{0,40}dropped: u64,/.test(mainRs),
    'read_data 返回字节 + 丢弃数');
  check(/Ok\(ReadDataResult \{ bytes: reader\.read_all\(\), dropped: reader\.take_dropped\(\) \}\)/.test(mainRs),
    'read_data 组装两者返回');
  check(/if \(res && res\.dropped > 0\) \{[\s\S]{0,200}已丢弃 /.test(html),
    '前端在丢弃时输出一行提示（不再让用户误以为日志就这些）');
  check(/var data = \(res && res\.bytes\) \? res\.bytes : res;/.test(html),
    '前端兼容新的对象返回与旧的纯数组返回');
  const sbFmt = { console, TextDecoder };
  vm.createContext(sbFmt);
  vm.runInContext([
    extractFunction('bleBytesToHex'), extractFunction('hexToBytes'),
    extractFunction('bleCanShowAsText'), extractFunction('bleFmtBytes'), extractFunction('bleFmtHex'),
  ].join('\n'), sbFmt);
  // 用户截图里的真实 payload：E4 BD A0 E6 98 AF E8 B0 81 0D 0A = "你是谁\r\n"
  check(sbFmt.bleFmtBytes([0xE4, 0xBD, 0xA0, 0xE6, 0x98, 0xAF, 0xE8, 0xB0, 0x81, 0x0D, 0x0A]) === '你是谁\\r\\n',
    'UTF-8 文本按文本显示，CRLF 转义为可见形式',
    JSON.stringify(sbFmt.bleFmtBytes([0xE4, 0xBD, 0xA0, 0xE6, 0x98, 0xAF, 0xE8, 0xB0, 0x81, 0x0D, 0x0A])));
  check(sbFmt.bleFmtHex('E4 BD A0 E6 98 AF E8 B0 81 0D 0A') === '你是谁\\r\\n',
    'bleFmtHex 对同样的十六进制串给出同样的文本');
  check(sbFmt.bleFmtBytes([0x01, 0xA0, 0xFF]) === '01 A0 FF', '非法 UTF-8 → 仍显示十六进制',
    sbFmt.bleFmtBytes([0x01, 0xA0, 0xFF]));
  check(sbFmt.bleFmtBytes([0x41, 0x00, 0x42]) === '41 00 42', '含 NUL 等控制字符 → 退回十六进制',
    sbFmt.bleFmtBytes([0x41, 0x00, 0x42]));
  check(sbFmt.bleFmtBytes([0x41, 0x09, 0x42]) === 'A\\tB', '制表符转义为 \\t（不破坏单行日志）');
  check(sbFmt.bleFmtBytes([]) === '' && sbFmt.bleFmtHex('') === '', '空数据返回空串（不抛错）');
  check(sbFmt.bleFmtHex('ZZ') !== undefined, '非法十六进制串不抛错（原样返回）', JSON.stringify(sbFmt.bleFmtHex('ZZ')));
  check(sbFmt.bleFmtBytes([0x5C, 0x6E]) === '\\\\n', '反斜杠本身被转义（不会与 \\n 混淆）',
    JSON.stringify(sbFmt.bleFmtBytes([0x5C, 0x6E])));

  // ---------- 9) BLE 从机（外设）模式 ----------
  // 本机作为从机对外广播：预设表 / HEX 解析 / 事件文案 / 配置往返 / 与后端属性表一致
  console.log('\n【BLE 从机模式】');

  // 抽取 `var NAME = <标量|数组|对象>;`
  // 注意单行字面量（`var X = { a: 1 };`）：必须按本行收尾，否则会一路吞到文件后面某个 `};`
  function extractVar(name) {
    const i = html.indexOf('var ' + name + ' = ');
    if (i < 0) throw new Error('var not found: ' + name);
    const rest = html.slice(i);
    const nl = rest.indexOf('\n');
    const firstLine = nl < 0 ? rest : rest.slice(0, nl);
    const body = rest.slice(rest.indexOf('= ') + 2).replace(/^[ \t]+/, '');
    if (body.charAt(0) === '[') {
      if (firstLine.indexOf('];') > 0) return firstLine;
      const m = /\r?\n\];/.exec(rest);
      if (!m) throw new Error('array end not found: ' + name);
      return rest.slice(0, m.index + m[0].length);
    }
    if (body.charAt(0) === '{') {
      if (firstLine.indexOf('};') > 0) return firstLine;
      const m = /\r?\n\};/.exec(rest);
      if (!m) throw new Error('object end not found: ' + name);
      return rest.slice(0, m.index + m[0].length);
    }
    return firstLine;
  }

  const PF_PRESETS = extractVar('BLE_PERIPH_PRESETS');
  const PF_ORDER = extractVar('BLE_PERIPH_PROP_ORDER');
  const PF_LABEL = extractVar('BLE_PERIPH_PROP_LABEL');
  const PF_MAX = extractVar('BLE_PERIPH_CHAR_MAX');
  const PF_FORM = extractVar('_blePeriphForm');
  const PF_FMT_DEPS = ['bleBytesToHex', 'hexToBytes', 'bleCanShowAsText', 'bleFmtBytes', 'bleFmtHex']
    .map(extractFunction).join('\n');

  const sbPf = { console, document: { getElementById() { return null; } } };
  vm.createContext(sbPf);
  vm.runInContext([
    PF_PRESETS, PF_ORDER, PF_LABEL, PF_MAX, PF_FORM, PF_FMT_DEPS,
    extractFunction('shortUuid'),
    extractFunction('blePeriphPreset'),
    extractFunction('blePeriphHexBytes'),
    extractFunction('blePeriphFmtEvent'),
    extractFunction('restoreBlePeriphForm'),
    extractFunction('blePfCollectOptions'),
    extractFunction('blePfCollectForm'),
  ].join('\n'), sbPf);

  // --- 9a) 预设表自洽 ---
  check(sbPf.BLE_PERIPH_PRESETS.length >= 3, '至少内置 3 套从机预设', String(sbPf.BLE_PERIPH_PRESETS.length));
  let presetOk = true, presetBad = '';
  sbPf.BLE_PERIPH_PRESETS.forEach((p) => {
    if (!p.id || !p.name || !p.service) { presetOk = false; presetBad = p.id + ' 缺 id/name/service'; }
    if (!p.chars || !p.chars.length) { presetOk = false; presetBad = p.id + ' 没有特征'; }
    if (!p.hint) { presetOk = false; presetBad = p.id + ' 缺 hint'; }
    (p.chars || []).forEach((c) => {
      if (!c.uuid) { presetOk = false; presetBad = p.id + ' 有特征缺 UUID'; }
      if (!c.props || !c.props.length) { presetOk = false; presetBad = p.id + ' 有特征没属性'; }
      (c.props || []).forEach((pr) => {
        if (sbPf.BLE_PERIPH_PROP_ORDER.indexOf(pr) < 0) { presetOk = false; presetBad = p.id + ' 未知属性 ' + pr; }
      });
    });
  });
  check(presetOk, '每套预设都自洽（服务/特征/属性/提示齐全）', presetBad);
  check(sbPf.blePeriphPreset('nus') !== null
    && sbPf.blePeriphPreset('nus').service === '6E400001-B5A3-F393-E0A9-E50E24DCCA9E',
    'Nordic UART 预设的服务 UUID 正确');
  check(sbPf.blePeriphPreset('不存在') === null, '未知预设 id 返回 null（不静默换成别的服务）');
  check(sbPf.BLE_PERIPH_PRESETS.map((p) => p.id).filter((v, i, a) => a.indexOf(v) === i).length
    === sbPf.BLE_PERIPH_PRESETS.length, '预设 id 不重复');

  // --- 9b) 属性表必须与后端一致 ---
  // 少一个 → 前端能勾但后端报"不支持的属性"；多一个 → 勾了静默不生效
  const pfFn = mainRs.slice(mainRs.indexOf('fn ble_periph_props_from_names('),
                            mainRs.indexOf('fn ble_periph_props_to_names('));
  const backendProps = [...pfFn.matchAll(/"([a-z_]+)"\s*=>/g)].map((m) => m[1]);
  const pfMissing = sbPf.BLE_PERIPH_PROP_ORDER.filter((p) => backendProps.indexOf(p) < 0);
  check(pfMissing.length === 0, '前端每个属性后端都认 [' + backendProps.join(',') + ']', pfMissing.join(','));
  check(sbPf.BLE_PERIPH_PROP_ORDER.every((p) => !!sbPf.BLE_PERIPH_PROP_LABEL[p]),
    '每个属性都有中文标签（界面不出现英文 key）');
  check(backendProps.indexOf('broadcast') >= 0 && sbPf.BLE_PERIPH_PROP_ORDER.indexOf('broadcast') < 0,
    'broadcast 仅后端支持（WinRT 本地特征不支持无连接广播，界面不给以免勾了不生效）');
  check(/const BLE_PERIPH_CHAR_MAX: usize = 16;/.test(mainRs) && sbPf.BLE_PERIPH_CHAR_MAX === 16,
    '前端/后端特征数量上限一致（16）');

  // --- 9c) HEX 解析（初值 / 广播服务数据）---
  const hexOf = (s) => sbPf.blePeriphHexBytes('x', s);
  check(JSON.stringify(hexOf('48656C6C6F').bytes) === JSON.stringify([0x48, 0x65, 0x6C, 0x6C, 0x6F]),
    'HEX 文本解析成字节');
  check(JSON.stringify(hexOf('01 A0 FF').bytes) === JSON.stringify([1, 0xA0, 0xFF]), '带空格的 HEX 也认');
  check(JSON.stringify(hexOf('01:a0-ff').bytes) === JSON.stringify([1, 0xA0, 0xFF]),
    '冒号 / 连字符分隔也认（从手册粘贴常见）');
  check(!hexOf('').error && hexOf('').bytes.length === 0, '留空表示不填初值（合法，不是错误）');
  check(!!hexOf('ABC').error, '奇数长度报错（不能静默当空值）');
  check(!!hexOf('ZZ').error, '非十六进制字符报错');
  check(hexOf('ZZ').error.indexOf('ZZ') > 0, '报错信息带上原值，便于定位是哪个字段', hexOf('ZZ').error);
  check(JSON.stringify(hexOf('0x01 02').bytes) === JSON.stringify([0x01, 0x02]),
    '容忍 0x 前缀（粘贴十六进制时常见）');

  // --- 9d) 事件 → 日志文案 ---
  const eWrite = sbPf.blePeriphFmtEvent({
    kind: 'write', uuid: '0000ffe1-0000-1000-8000-00805f9b34fb',
    value_hex: '01 A0', peer: 'AA:BB:CC:DD:EE:FF', note: '写响应',
  });
  check(eWrite.text.indexOf('[收到写入]') === 0 && eWrite.text.indexOf('0xFFE1') > 0,
    '写入事件带方向前缀与短 UUID', eWrite.text);
  check(eWrite.text.indexOf('AA:BB:CC:DD:EE:FF') > 0, '写入事件带上来连的主机地址');
  check(eWrite.text.indexOf('写响应') > 0, '写入事件标明是否带响应');
  check(eWrite.dim.indexOf('01 A0') > 0 && eWrite.dim.indexOf('0x01A0') > 0, '十六进制部分灰显展示', eWrite.dim);
  const eRead = sbPf.blePeriphFmtEvent({ kind: 'read', uuid: '0000ffe1-0000-1000-8000-00805f9b34fb', value_hex: '41' });
  check(eRead.text.indexOf('[主机读取]') === 0, '读取事件用「主机读取」措辞', eRead.text);
  check(sbPf.blePeriphFmtEvent({ kind: 'subscribe', uuid: '0000fff2-0000-1000-8000-00805f9b34fb', subscribed: 2 })
    .text.indexOf('2 台主机') > 0, '订阅事件带上订阅主机数');
  check(sbPf.blePeriphFmtEvent({ kind: 'subscribe', uuid: '0000fff2-0000-1000-8000-00805f9b34fb', subscribed: 0 })
    .text.indexOf('取消') > 0, '取消订阅单独成句');
  const eAbort = sbPf.blePeriphFmtEvent({ kind: 'adv', status: 'Aborted' });
  check(eAbort.text.indexOf('Aborted') > 0 && eAbort.text.indexOf('蓝牙') > 0,
    '广播被中止时给出排查方向（不只丢一个状态码）', eAbort.text);
  check(sbPf.blePeriphFmtEvent({ kind: 'start', uuid: '0000ffe0-0000-1000-8000-00805f9b34fb', note: '1 个特征' })
    .text.indexOf('1 个特征') > 0, '启动事件带特征数');
  check(sbPf.blePeriphFmtEvent({}).text.indexOf('[事件]') === 0, '未知/空事件不抛错');

  // --- 9e) 配置往返与坏配置容错 ---
  check(sbPf._blePeriphForm.presetId === 'nus' && sbPf._blePeriphForm.chars.length === 2,
    '默认表单 = NUS 两个特征（打开就能用）');
  sbPf.restoreBlePeriphForm(null);
  check(sbPf._blePeriphForm.chars.length === 2, '配置缺失时保持默认预设');
  sbPf.restoreBlePeriphForm({ presetId: '不存在', service: '', chars: 'bad', discoverable: 'yes' });
  check(sbPf._blePeriphForm.presetId === 'nus', '未知预设 id 不改动当前选择');
  check(sbPf._blePeriphForm.service === '6E400001-B5A3-F393-E0A9-E50E24DCCA9E', '空服务 UUID 不覆盖默认值');
  check(sbPf._blePeriphForm.chars.length === 2, '非法 chars 不破坏特征列表');
  check(sbPf._blePeriphForm.discoverable === true, 'discoverable 缺省即为 true（默认可被发现）');
  const round = sbPf.blePfCollectForm();
  sbPf.restoreBlePeriphForm(JSON.parse(JSON.stringify(round)));
  check(JSON.stringify(sbPf.blePfCollectForm()) === JSON.stringify(round),
    'collect → restore 往返一致（配置不会自己漂移）', JSON.stringify(sbPf.blePfCollectForm()));
  sbPf.restoreBlePeriphForm({ chars: Array.from({ length: 40 }, (_, i) => ({
    uuid: '0000000' + i + '-0000-1000-8000-00805f9b34fb', props: ['read', 'bogus'], value: '' })) });
  check(sbPf._blePeriphForm.chars.length === 16, '配置里的特征数被夹到上限 16（不让坏配置撑爆界面）',
    String(sbPf._blePeriphForm.chars.length));
  check(sbPf._blePeriphForm.chars[0].props.indexOf('bogus') < 0
    && sbPf._blePeriphForm.chars[0].props.indexOf('read') >= 0,
    '配置里的未知属性被丢弃、已知属性保留');

  // --- 9f) 前后端命令契约 ---
  const PF_CMDS = ['ble_periph_start', 'ble_periph_stop', 'ble_periph_status',
                   'ble_periph_set_value', 'ble_periph_notify', 'ble_periph_poll_events'];
  PF_CMDS.forEach((cmd) => {
    check(new RegExp('async fn ' + cmd + '\\(').test(mainRs), '后端实现 ' + cmd);
    check(new RegExp('^\\s*' + cmd + ',\\s*$', 'm').test(mainRs), '后端已注册 ' + cmd);
    check(html.indexOf("invoke('" + cmd + "'") > 0, '前端调用 ' + cmd);
  });

  // --- 9g) 关键不变量（源码层）---
  // 图标引用必须存在：BLE_ICONS 少一个键 → 界面上会直接渲染出字面 "undefined"
  const BLE_ICON_SET = extractObject('BLE_ICONS');
  const iconKeysAll = [...BLE_ICON_SET.matchAll(/^ {4}(\w+)\s*:/gm)].map((m) => m[1]);
  const iconRefs = [...new Set([...html.matchAll(/BLE_ICONS\.(\w+)/g)].map((m) => m[1]))];
  const badRefs = iconRefs.filter((k) => iconKeysAll.indexOf(k) < 0);
  check(iconKeysAll.length >= 6, 'BLE_ICONS 抽到 ' + iconKeysAll.length + ' 个图标键', iconKeysAll.join(','));
  check(badRefs.length === 0, 'BLE_ICONS.<key> 引用都存在 [' + iconRefs.join(',') + ']', badRefs.join(','));
  const metaBlocks = extractObject('BLE_DESC_META') + '\n' + extractObject('BLE_PROP_META');
  const metaIcons = [...new Set([...metaBlocks.matchAll(/icon(?:On|Off)?:'(\w+)'/g)].map((m) => m[1]))];
  check(metaIcons.length > 0 && metaIcons.every((k) => iconKeysAll.indexOf(k) >= 0),
    'BLE_PROP_META / BLE_DESC_META 的图标名都存在', metaIcons.filter((k) => iconKeysAll.indexOf(k) < 0).join(','));

  // --- 9h) 从机特征运行态渲染：行为断言（这部分代码要等广播通了才会跑，更该在这里守住）---
  const sbChars = { console, _byId: {} };
  sbChars.document = {
    getElementById(id) { return (sbChars._byId[id] = sbChars._byId[id] || fakeEl()); },
  };
  vm.createContext(sbChars);
  vm.runInContext([
    PF_LABEL, PF_FMT_DEPS, extractObject('BLE_ICONS'), extractFunction('escapeHtml'),
    extractFunction('shortUuid'), extractFunction('renderBlePeriphStatusChars'),
  ].join('\n'), sbChars);
  sbChars._blePeriphRunning = true;
  sbChars._blePeriphStatusChars = [
    { uuid: '0000ffe1-0000-1000-8000-00805f9b34fb', props: ['read', 'write'], value_hex: '48 69', subscribed: 1 },
    { uuid: '0000ffe2-0000-1000-8000-00805f9b34fb', props: ['write'], value_hex: 'AB', subscribed: 0 },
    { uuid: '0000ffe3-0000-1000-8000-00805f9b34fb', props: ['notify'], value_hex: '', subscribed: 0 },
  ];
  sbChars.renderBlePeriphStatusChars();
  const chRows = sbChars._byId['blePfChars'].innerHTML.split('<div class="ble-char">').slice(1);
  check(chRows.length === 3, '特征运行态渲染出 3 行', String(chRows.length));
  check(/data-act="set"/.test(chRows[0]) && !/data-act="notify"/.test(chRows[0]),
    '可读可写特征：有「设值」、无「下发」（该特征没有 notify 属性）');
  check(!/data-act="set"/.test(chRows[1]),
    '只写特征：不显示「设值」（主机根本读不到，设了纯属误导）');
  check(/主机写入 /.test(chRows[1]), '只写特征的值标为「主机写入」');
  check(/data-act="notify"/.test(chRows[2]) && !/data-act="set"/.test(chRows[2]),
    'notify 特征：有「下发」、无「设值」');
  check(/已订阅 1/.test(chRows[0]) && /未订阅/.test(chRows[1]), '订阅数按特征分别渲染');
  check(/主机读到 /.test(chRows[0]), '可读特征的值标为「主机读到」');
  check(/（空）/.test(chRows[2]), '空值显示为（空）而不是留白');
  check(/0xFFE1/.test(chRows[0]) && /0xFFE3/.test(chRows[2]), '每行显示短 UUID');
  sbChars._blePeriphRunning = false;
  sbChars._blePeriphStatusChars = [];
  sbChars.renderBlePeriphStatusChars();
  check(/还未启动广播/.test(sbChars._byId['blePfChars'].innerHTML), '未启动时给出明确空态');

  // 失败后回读真实状态：否则界面会停在"上一次是运行中"的假象里
  check(/return refreshBlePeriphStatus\(\);\s*\n\s*\}\)\.then\(function\(\) \{\s*\n\s*if \(btn\) btn\.disabled = false;/.test(html),
    '启动失败后回读一次真实状态');
  check(/if \(\(c\.props \|\| \[\]\)\.indexOf\('read'\) < 0\) \{ showToast\('该特征不可读，设值无效'/.test(html),
    '设值前再校验一次可读性（兜住过期 DOM）');
  check(/max_notify/.test(mainRs) && /MaxNotificationSize\(\)/.test(mainRs),
    '订阅事件带上单次通知最大字节数（下发长数据失败时最需要它）');
  check(/单次最多 ' \+ ev\.max_notify \+ ' 字节'/.test(html), '日志里显示单次通知上限');
  check(/var _bleMode = 'host';/.test(html)
    && /_bleMode = \(BLE_PERIPH_MODE_ENABLED && b\.mode === 'periph'\) \? 'periph' : 'host';/.test(html),
    '主机/从机模式随用户配置持久化与恢复（入口关闭时强制回主机）');
  check(/mode: _bleMode,[\s\S]{0,60}periph: blePfCollectForm\(\),/.test(html), '从机表单随配置一起保存');
  check(/if \(st && st\.advertising\) \{/.test(html),
    '启动后按 advertising 判定，不把「服务建好但广播被中止」报成成功');
  check(/showToast\('服务已建好，但' \+ why, 'error'\)/.test(html),
    '广播未生效时明确提示，且优先用后端 warning（真实原因）而不是状态码');
  check(/var why = \(st && st\.warning\) \? st\.warning :/.test(html), 'warning 优先于 advertising_status');
  check(/id="blePfAdapter"/.test(html) && /外设角色 ' \+ \(a\.peripheral_role \? '驱动已声明'/.test(html),
    '面板只说"驱动已声明"，不把能力位写成"支持"（本机实测：声明了也广播不了）');
  check(/adapterEl\.title = '「驱动已声明」只是适配器驱动程序上报的能力位/.test(html),
    '悬停解释"声明 ≠ 能用"');
  check(/a\.radio_access === 'DeniedByUser'/.test(html) && /无线电访问权异常/.test(html),
    '面板单独提示无线电访问权异常（扫描能用但广播起不来，易被忽略）');
  check(/if \(st\.warning && warn\.firstChild\) warn\.firstChild\.textContent = st\.warning;/.test(html),
    '后端 warning 走 textContent 渲染（不给自己留注入口）');
  check(/charsBox\.addEventListener\('click', function\(e\) \{[\s\S]{0,260}data-act/.test(html),
    '从机特征行操作按钮走事件委托');
  check(!/onclick="blePeriphCharAction/.test(html), '没有把 UUID 拼进内联 onclick');
  check(/stopBlePeriphPoll\(\);\s*\n\}/.test(html), '离开蓝牙页停止从机轮询（广播留在后端继续）');
  // 模式切换：代码结构保留（两套左栏共用同一个生成函数），但**入口默认关闭** ——
  // 本机实测无法广播，摆一个点不亮的入口只会让后来者再踩一遍（见 doc/BLE_PERIPHERAL.md 第 5 节）
  check(/var BLE_PERIPH_MODE_ENABLED = false;/.test(html),
    '从机模式入口的开关默认关闭，且有一个显式常量（不是散落的硬编码）');
  check(/function bleModeSegHtml\(\)/.test(html) && /if \(!BLE_PERIPH_MODE_ENABLED\) return '';/.test(html),
    '模式切换器由 bleModeSegHtml() 生成：关掉入口就不渲染按钮');
  check(/data-ble-mode="host"[^>]*>主机模式</.test(html) && /data-ble-mode="periph"[^>]*>从机模式</.test(html),
    '切换文案仍是「主机模式 / 从机模式」');
  check((html.match(/bleModeSegHtml\(\)/g) || []).length === 3,
    '两处左栏各调一次 bleModeSegHtml()（外加函数定义本身）',
    String((html.match(/bleModeSegHtml\(\)/g) || []).length));
  check(!/class="ble-mode-bar"/.test(html), '已删除横贯顶部的模式栏');
  check(!/id="bleModeHost"/.test(html) && !/id="bleModePeriph"/.test(html),
    '不再用重复 id（两处同 id 会让 getElementById 取错）');
  check(/document\.querySelectorAll\('#ble-pane \.ble-mode-btn'\)/.test(html),
    '用 querySelectorAll 同步切换器（入口关闭时是空集合，天然安全）');
  // 关掉入口时，配置里残留的 "periph" 必须折回主机 —— 否则启动就落进一个没有出口的隐藏模式
  check(/if \(mode === 'periph' && !BLE_PERIPH_MODE_ENABLED\) \{/.test(html),
    'setBleMode 把被关掉的 periph 折回 host');
  check(/_bleMode = \(BLE_PERIPH_MODE_ENABLED && b\.mode === 'periph'\) \? 'periph' : 'host';/.test(html),
    '恢复配置时同样折回，不会落进隐藏模式');
  // "保留"的验证：面板、命令、表格导入导出都还在（只是从界面进不去）
  check(/<div class="ble-periph" id="blePeriph">/.test(html) && /function startBlePeriph\(\)/.test(html)
    && /function blePfImportTable\(\)/.test(html),
    '从机面板与逻辑整体保留（隐藏入口 ≠ 删功能）');
  check(/async fn ble_periph_start\(/.test(mainRs) && /ble_periph_start,/.test(mainRs),
    '后端从机命令仍然注册着（换机器时改一个常量即可启用）');
  // 主机 / 从机 左栏宽度必须一致（宽度值本身由上面的 BLE 左栏那一组断言守着）
  check(/\.ble-left, \.ble-pf-left \{/.test(html) && /flex:0 0 288px; min-width:240px; max-width:38%;/.test(html),
    '两种模式的左栏共用同一套宽度（切模式布局不跳）');
  const pfLeftRule = /^\.ble-pf-left \{[^}]*\}/m.exec(html);
  check(!!pfLeftRule && !/width:/.test(pfLeftRule[0]),
    '从机左栏不再自带宽度（否则和主机左栏不一致）', pfLeftRule ? pfLeftRule[0] : '(没有这条规则)');
  // 滚动条：从机模式下所有可滚动区都套上统一样式（MCP 弹窗后来也并进了同一份规则）。
  // 断言按"成员是否在这条规则的选择器列表里"来查，而不是钉死整段文本 —— 以后往里加
  // 选择器（这次就加了 MCP 弹窗主体）不必再改断言。
  const sbRuleSel = (/([^\n]*(?:,\s*\n[^\n]*)*) \{ width:10px; height:10px; \}/.exec(html) || [, ''])[1];
  const inSbRule = (s) => sbRuleSel.indexOf(s + '::-webkit-scrollbar') >= 0;
  check(sbRuleSel !== '' && inSbRule('.ble-log') && inSbRule('.ble-pf-left') && inSbRule('.ble-pf-chars'),
    '从机左栏与特征列表都套上统一滚动条样式（默认那条又宽又亮，很丑）');
  check(/\.ble-pf-left \.ble-mode-seg \{ position:sticky; top:0; z-index:3; \}/.test(html),
    '从机左栏滚动时模式切换钉在顶部（不会滚走）');

  check(/function sendBlePeriphWrite\(\)/.test(html)
    && /_bleWriteTarget\.kind === 'periph_set' \|\| _bleWriteTarget\.kind === 'periph_notify'/.test(html),
    '从机设值/下发复用主机写入弹窗');
  check(/function openBleWriteModal\(uuid, name, modes, target\)/.test(html)
    && (html.match(/id="bleWriteModal"/g) || []).length === 1,
    '从机与主机共用一个写入弹窗（不重复造一个）');

  // 界面去噪：说明文字不再占版面，改到 placeholder / title / 下拉 tooltip 里
  check(!/id="blePfPresetHint"/.test(html), '预设说明不再单独占一行');
  check(/sel\.title = p\.name \+ '：' \+ p\.hint;/.test(html), '预设说明改挂在下拉框 title 上');
  check(!/初值按 HEX 填（可留空）；主机读取时返回的就是它/.test(html), '特征区的说明段已删');
  check(!/勾上后，主机的每次写入都会挂起等你点/.test(html), '手动应答的说明段已删（改挂 title）');
  check(/title="勾上后主机的每次写入都会挂起/.test(html), '手动应答说明移到 checkbox 的 title');
  check(!/设备名由 Windows 决定（= 本机蓝牙名称），这里改不了/.test(html), '设备名说明段已删（移到模式按钮 title）');
  check(/手机看到的设备名是电脑名，由 Windows 决定/.test(html), '设备名限制信息仍在（放进从机模式按钮 title）');
  check(/placeholder="6E400001-B5A3-F393-E0A9-E50E24DCCA9E 或 0xFFE0"/.test(html),
    '短写提示并进服务 UUID 的 placeholder');
  check(/只能广播一个服务/.test(html), '「只能广播一个服务」仍在（挪到标签上，不再是下方提示段）');
  check(/class="ble-pf-warnline" id="blePfAdvLen"/.test(html),
    '广播数据长度改用只在异常时出现的告警行');
  check(/el\.textContent = \(w && w\.indexOf\('偏长'\) >= 0\) \? w : '';/.test(html),
    '长度正常时不留任何提示（不占版面）');

  check(/function updateBleModeHint\(\)/.test(html)
    && /从机广播仍在后台运行/.test(html),
    '切回主机模式时提示「从机广播仍在后台运行」（不会让人忘了还开着广播）');
  check(/refreshBlePeriphStatus\(\)\.then\(updateBleModeHint\)/.test(html),
    '切模式后刷新一次真实状态再更新提示（不靠可能过期的内存标志）');
  check(/广播被系统中止：本机实测\*\*能\*\*发广播/.test(mainRs),
    'Aborted 的文案指向"能发广播、但带服务 UUID 的广播被拒"这个实测现象');
  check(/平台限制（缺应用标识）/.test(mainRs), '文案给出"非打包应用平台限制"这条并列可能');
  check(/详见 doc\/BLE_PERIPHERAL\.md 第 5 节/.test(mainRs), '文案指向文档里的排查清单');
  check(/ConsentStore/.test(mainRs) === false || /不该断言是隐私设置导致/.test(mainRs),
    '不把 DeniedByUser 说死成"隐私设置拒绝"（本机 ConsentStore 是 Allow）');
  check(/fn ble_periph_probe_warning\(/.test(mainRs) && /IsPeripheralRoleSupported/.test(mainRs),
    '后端启动前探测适配器能力（否则只会得到一个 Aborted）');
  check(/本机没有蓝牙适配器/.test(mainRs) && /外设角色/.test(mainRs),
    '探测结论覆盖"没适配器"与"不支持外设角色"两种硬件原因');
  check(/ble_periph_probe_warning\(&adapter\)[\s\S]{0,120}or_else\(\|\| ble_periph_adv_warning/.test(mainRs),
    '告警优先级：适配器能力 > 广播状态码（方向别指错）');
  check(/Radio::RequestAccessAsync\(\)/.test(mainRs) && /radio_access/.test(mainRs),
    '后端探测无线电访问权（被拒时广播恒 Aborted，而扫描仍可用）');
  check(/fn ble_periph_diagnose\(/.test(mainRs), '有一条环境诊断测试可一键打全排查信息');

  // ---------- 10) 主机方向缺口修复（G1/G2/G3/G5/G6/G8） ----------
  console.log('\n【主机方向修复】');

  const sbH = { console, _bleScanSecs: 15, document: { getElementById: () => null } };
  vm.createContext(sbH);
  vm.runInContext([
    extractVar('BLE_SCAN_SECS_CHOICES'),
    extractFunction('bleMacLooksValid'),
    extractFunction('bleScanSecs'),
    extractFunction('bleScanSecsLabel'),
  ].join('\n'), sbH);

  // G2：扫描时长
  check(sbH.BLE_SCAN_SECS_CHOICES.join(',') === '5,15,30,60,0',
    'G2 扫描时长选项含 5/15/30/60/持续', sbH.BLE_SCAN_SECS_CHOICES.join(','));
  check(sbH.bleScanSecs() === 15, 'G2 DOM 不存在时回落到状态里的时长（不是写死 15）');
  sbH._bleScanSecs = 60;
  check(sbH.bleScanSecs() === 60, 'G2 回落到配置恢复出来的值');
  check(sbH.bleScanSecsLabel() === '60 秒', 'G2 时长标签', sbH.bleScanSecsLabel());
  sbH._bleScanSecs = 0;
  check(sbH.bleScanSecsLabel() === '持续', 'G2 0 秒显示为「持续」', sbH.bleScanSecsLabel());

  // G1：MAC 粗校验
  check(sbH.bleMacLooksValid('a4:c1:38:11:14:2b'), 'G1 MAC 大小写都认');
  check(sbH.bleMacLooksValid('AA:BB:CC:DD:EE:FF'), 'G1 标准大写 MAC 认');
  check(!sbH.bleMacLooksValid('a4:c1:38:11:14'), 'G1 少一段不认');
  check(!sbH.bleMacLooksValid('a4-c1-38-11-14-2b'), 'G1 连字符分隔不认（后端只吃冒号）');
  check(!sbH.bleMacLooksValid('zz:bb:cc:dd:ee:ff'), 'G1 非法字符不认');
  check(!sbH.bleMacLooksValid(''), 'G1 空串不认');
  check(!sbH.bleMacLooksValid(null), 'G1 null 不抛错');

  check(/async fn ble_connect_direct\(/.test(mainRs), 'G1 后端有 ble_connect_direct');
  check(/\.add_peripheral\(&pid\)/.test(mainRs),
    'G1 用了 btleplug add_peripheral —— 不依赖广播，这正是"设备不广播就永远连不上"的正解');
  check(/ble_connect_direct,/.test(mainRs), 'G1 命令已注册');
  check(/id="bleDirectAddr"/.test(html) && /function connectBleDirect\(\)/.test(html),
    'G1 界面有按 MAC 直连入口');
  check(/invokeTimeout\('ble_connect_direct'/.test(html), 'G1 直连也带超时调用');
  check(/解析失败|蓝牙地址格式不正确/.test(mainRs), 'G1 后端对坏地址给明确报错');

  check(/id="bleScanSecs"/.test(html), 'G2 界面有扫描时长选择');
  check(/if \(secs <= 0\) return;   \/\/ 选「持续」就不自动停/.test(html), 'G2 选「持续」时不自动停止');
  check(/logBle\('\[扫描\] 已按设定时长/.test(html) && /扫描已自动停止/.test(html),
    'G2 自动停止时明确告知（不再静默停止）');
  check(/scanSecs: _bleScanSecs,/.test(html)
    && /_bleScanSecs = \(typeof b\.scanSecs === 'number'\) \? b\.scanSecs : 15;/.test(html),
    'G2 扫描时长随配置持久化与恢复');

  check(/adapters: Mutex<Vec<BtAdapter>>/.test(mainRs), 'G3 state 保存适配器列表而不是单个');
  check(/let adapters = ble_load_adapters\(&state\)\.await\?;/.test(mainRs), 'G3 开始扫描时加载全部适配器');
  check(/for a in &adapters \{[\s\S]{0,120}start_scan/.test(mainRs), 'G3 每个适配器都开扫描');
  check(/async fn ble_find_peripheral\(adapters: &\[BtAdapter\]/.test(mainRs),
    'G3 按地址查找覆盖全部适配器');
  check(/let adapters = ble_cached_adapters\(&state\);/.test(mainRs), 'G3 设备列表/RSSI 也用全部适配器');
  check(/seen\.insert\(/.test(mainRs), 'G3 多适配器结果按 MAC 去重（同一台设备可能被两个适配器听到）');

  check(/async fn ble_get_mtu\(/.test(mainRs) && /p\.mtu\(\)/.test(mainRs),
    'G5 后端暴露协商后的 MTU');
  check(/ble_get_mtu,/.test(mainRs), 'G5 命令已注册');
  check(/function refreshBleMtu\(\)/.test(html) && /'MTU ' \+ mtu/.test(html),
    'G5 界面显示 MTU 与有效载荷');

  check(/const BLE_CONNECT_TIMEOUT_MS: u64 = 10_000;/.test(mainRs), 'G6 后端有显式连接超时');
  check(/tokio::time::timeout\(/.test(mainRs), 'G6 用 tokio timeout 包住 connect');
  check(/超时后主动断开/.test(mainRs) && /连接超时（\{BLE_CONNECT_TIMEOUT_MS\}ms）/.test(mainRs),
    'G6 超时后主动断开并把状态收敛掉');

  check(/notify_dropped: std::sync::Arc<std::sync::atomic::AtomicU64>/.test(mainRs), 'G8 后端有丢弃计数');
  check(/dropped\.fetch_add\(1,/.test(mainRs), 'G8 缓冲裁剪时累计丢弃');
  check(/"dropped": dropped/.test(mainRs), 'G8 轮询返回丢弃数');
  check(/res\.dropped > 0/.test(html) && /缓冲溢出丢弃了/.test(html), 'G8 前端在丢弃时明确提示');
  check(/\}, 250\);/.test(html), 'G8 通知轮询加密到 250ms');
  check(/var items = \(res && res\.items\) \? res\.items : res;/.test(html),
    'G8 前端兼容新的 {items,dropped} 与旧的纯数组');

  // ---------- 11) 从机侧缺口修复 ----------
  console.log('\n【从机侧修复】');

  const sbP2 = { console, TextEncoder, TextDecoder };
  vm.createContext(sbP2);
  vm.runInContext([
    extractFunction('blePeriphHexBytes'),
    extractFunction('blePeriphParseDescriptors'),
    extractFunction('blePeriphAdvDataWarnText'),
  ].join('\n'), sbP2);

  // 描述符解析：默认 HEX，T: 前缀按 UTF-8 文本
  check(sbP2.blePeriphParseDescriptors('').descs.length === 0, '描述符留空 → 空列表（合法）');
  const d1 = sbP2.blePeriphParseDescriptors('0000FFF1-0000-1000-8000-00805F9B34FB=0102').descs;
  check(d1.length === 1 && JSON.stringify(d1[0].value) === '[1,2]', '描述符默认按 HEX 解析', JSON.stringify(d1));
  const d2 = sbP2.blePeriphParseDescriptors('2901=T:温度计').descs;
  check(d2.length === 1 && d2[0].value.length === 9, 'T: 前缀按 UTF-8 文本编码', JSON.stringify(d2[0].value));
  check(new TextDecoder().decode(new Uint8Array(d2[0].value)) === '温度计',
    'T: 文本内容按 UTF-8 正确编码', JSON.stringify(d2[0].value));
  const d3 = sbP2.blePeriphParseDescriptors('0000FFF1-0000-1000-8000-00805F9B34FB=01; 0000FFF2-0000-1000-8000-00805F9B34FB=02\n0000FFF3-0000-1000-8000-00805F9B34FB=T:x').descs;
  check(d3.length === 3, '分号与换行都能分隔多个描述符', String(d3.length));
  check(!!sbP2.blePeriphParseDescriptors('没有等号').error, '缺 = 报错');
  check(!!sbP2.blePeriphParseDescriptors('=0102').error, '缺 UUID 报错');
  check(!!sbP2.blePeriphParseDescriptors('0000FFF1-0000-1000-8000-00805F9B34FB=ZZ').error,
    '值是非法 HEX 时报错（不静默当空）');

  // 广播数据长度提示
  check(sbP2.blePeriphAdvDataWarnText(0) === '', '没填广播数据时不显示长度提示');
  check(/够用/.test(sbP2.blePeriphAdvDataWarnText(4)), '短数据提示"够用"');
  check(/偏长/.test(sbP2.blePeriphAdvDataWarnText(25)) && /31 字节/.test(sbP2.blePeriphAdvDataWarnText(25)),
    '超 24 字节提示偏长并说明 31 字节总额', sbP2.blePeriphAdvDataWarnText(25));

  // 手动写入应答
  check(/id="blePfManualReply"/.test(html), '界面有「写入需手动应答」开关');
  check(/manualReply: p\.manualReply/.test(html), '手动应答开关随启动参数下发');
  check(/async fn ble_periph_respond_write\(/.test(mainRs) && /ble_periph_respond_write,/.test(mainRs),
    '后端有并注册了 ble_periph_respond_write');
  check(/invoke\('ble_periph_respond_write'/.test(html), '前端调用应答命令');
  check(/RespondWithProtocolError\(code\)/.test(mainRs), '拒绝时回协议错误码');
  check(/BLE_PERIPH_REPLY_TIMEOUT_MS/.test(mainRs) && /超时未应答，已按协议错误/.test(mainRs),
    '无人应答时有兜底超时，不让主机一直挂着');
  check(/id="blePfPending"/.test(html) && /function renderBlePfPending\(\)/.test(html),
    '右列有待应答区（接受 / 拒绝）');
  check(/"pending_id": id/.test(mainRs) && /"pending_id": pending_id/.test(mainRs),
    '事件里带 pending_id，前端才能对上号');
  check(/for \(_, w\) in pending\.drain\(\)/.test(mainRs),
    '停止广播时把待应答请求全部回掉（不留挂起的主机）');

  // 长写 Offset
  check(/req\.Offset\(\)/.test(mainRs), '后端读写请求的 Offset');
  check(/fn ble_periph_apply_write\(value: &mut Vec<u8>, offset: usize, data: &\[u8\]\)/.test(mainRs),
    '长写按 offset 落值（不再当成互相覆盖的独立写入）');
  check(/ble_periph_apply_write\(&mut v, offset, &bytes\)/.test(mainRs), '写回调里真的用了它');

  // 自定义描述符
  check(/CreateDescriptorAsync\(dguid, &dparams\)/.test(mainRs), '后端支持创建自定义描述符');
  check(/fn ble_periph_desc_reserved\(/.test(mainRs) && /不能手工创建/.test(mainRs),
    '标准描述符（0x2900~0x290F）在本地就挡住并说明原因（真机实测 0x2901 会被拒）');
  check(/descriptors: vec!\[BlePeriphDescSpec/.test(mainRs), '真机冒烟覆盖了描述符创建路径');
  check(/描字符?|描述符（可选）/.test(html), '特征行有描述符输入框');

  // 前后端一致性：设值必须校验可读
  check(/fn ble_periph_props_readable\(/.test(mainRs) && /没有 read 属性/.test(mainRs),
    '后端 set_value 校验特征可读（与前端隐藏入口一致）');
  check(/data-act="set"[\s\S]{0,200}canRead/.test(html) || /\(canRead \? '<span class="ble-ch-action ready" data-act="set"/.test(html),
    '前端只对可读特征显示「设值」');

  // 一个服务提供者只能广播一个服务：必须在**界面上**说，而不只是注释里
  check(/只能广播一个服务/.test(html), '界面说明了「一个服务提供者只能广播一个服务」');
  const svcLabelZone = html.slice(html.indexOf('id="blePfService"') - 300, html.indexOf('id="blePfService"'));
  check(/只能广播一个服务/.test(svcLabelZone), '说明就贴在服务 UUID 输入框的标签上（就地提示）');

  // 多套从机配置保存
  check(/function blePfSaveAs\(\)/.test(html) && /function blePfLoadSaved\(/.test(html)
    && /function blePfDeleteSaved\(\)/.test(html), '有保存 / 载入 / 删除三件套');
  check(/periphSaved: _blePeriphSaved,/.test(html) && /restoreBlePeriphSaved\(b\.periphSaved\)/.test(html),
    '保存的配置随用户配置持久化与恢复');
  check(/function restoreBlePeriphSaved\(/.test(html), '恢复时校验形状（坏配置不让面板变空白）');
  check(/desc: c\.desc \|\| ''/.test(html) && /desc: typeof c\.desc === 'string'/.test(html),
    '描述符文本随表单一起保存与恢复');

  // ---------- 12) 广播配置的表格文件（导入 / 导出） ----------
  console.log('\n【广播配置表格】');
  const sbT = { console, _blePeriphForm: { presetId: 'nus', service: '', chars: [], discoverable: true,
                 connectable: true, advData: false, advDataHex: '', manualReply: false },
                document: { getElementById() { return null; } } };
  vm.createContext(sbT);
  vm.runInContext([
    extractVar('BLE_PF_TABLE_HEADER'),
    extractFunction('blePfTableCells'),
    extractFunction('blePfParseTable'),
    extractFunction('blePfBuildTable'),
    extractFunction('blePfCollectOptions'),
    extractFunction('blePfCollectForm'),
    'var BLE_PERIPH_CHAR_MAX = 16;',
  ].join('\n'), sbT);

  check(sbT.BLE_PF_TABLE_HEADER.join(',') === '服务UUID,特征UUID,属性,初值HEX,描述符',
    '表头固定 5 列', sbT.BLE_PF_TABLE_HEADER.join(','));

  // CSV
  const csv = [
    '服务UUID,特征UUID,属性,初值HEX,描述符',
    '6E400001-B5A3-F393-E0A9-E50E24DCCA9E,6E400002-B5A3-F393-E0A9-E50E24DCCA9E,write;write_without_response,,',
    '6E400001-B5A3-F393-E0A9-E50E24DCCA9E,6E400003-B5A3-F393-E0A9-E50E24DCCA9E,notify,41,2901=T:温度计',
  ].join('\n');
  const rc = sbT.blePfParseTable(csv);
  check(!rc.error && rc.chars.length === 2, 'CSV 解析出 2 个特征', rc.error || String(rc.chars && rc.chars.length));
  check(rc.service === '6E400001-B5A3-F393-E0A9-E50E24DCCA9E', '服务 UUID 取第一列', rc.service);
  check(JSON.stringify(rc.chars[0].props) === '["write","write_without_response"]',
    '属性按 ; 拆开', JSON.stringify(rc.chars[0].props));
  check(rc.chars[1].value === '41' && rc.chars[1].desc === '2901=T:温度计',
    '初值与描述符逐列取到', rc.chars[1].value + ' / ' + rc.chars[1].desc);

  // Markdown 表格
  const md = [
    '| 服务UUID | 特征UUID | 属性 | 初值HEX | 描述符 |',
    '|---|---|---|---|---|',
    '| 6E400001-B5A3-F393-E0A9-E50E24DCCA9E | 0000FFF1-0000-1000-8000-00805F9B34FB | read;write | 48656C6C6F | 2901=T:含\\|竖线 |',
  ].join('\n');
  const rm = sbT.blePfParseTable(md);
  check(!rm.error && rm.chars.length === 1, 'Markdown 表格也能解析（自动跳过分隔行）', rm.error || '');
  check(JSON.stringify(rm.chars[0].props) === '["read","write"]',
    'Markdown 里属性用 ; 分隔', JSON.stringify(rm.chars[0].props));
  check(rm.chars[0].desc === '2901=T:含|竖线',
    'Markdown 单元格里的 \\| 按规范还原成竖线', rm.chars[0].desc);
  check(rm.chars[0].value === '48656C6C6F', 'Markdown 表格的初值列取对', rm.chars[0].value);

  // 注释与空行
  const rc2 = sbT.blePfParseTable('# 我的透传模块\n\n6E400001-B5A3-F393-E0A9-E50E24DCCA9E,6E400002-B5A3-F393-E0A9-E50E24DCCA9E,write,,');
  check(!rc2.error && rc2.chars.length === 1, '空行与 # 注释行被忽略');

  // 出错情形：报错必须说明是哪一行/为什么
  check(/只有 1 列/.test(sbT.blePfParseTable('6E400001-B5A3-F393-E0A9-E50E24DCCA9E').error || ''),
    '列数不足报错');
  check(/特征 UUID 为空/.test(sbT.blePfParseTable('6E400001-B5A3-F393-E0A9-E50E24DCCA9E,').error || ''),
    '特征 UUID 为空报错');
  check(/只能广播一个服务/.test(sbT.blePfParseTable(
    '6E400001-B5A3-F393-E0A9-E50E24DCCA9E,6E400002-B5A3-F393-E0A9-E50E24DCCA9E,write,,\n' +
    '0000FFF0-0000-1000-8000-00805F9B34FB,0000FFF1-0000-1000-8000-00805F9B34FB,read,,').error || ''),
    '文件里出现第二个服务 UUID 时明确报错（平台只支持一个）');
  check(/没有解析到任何特征行/.test(sbT.blePfParseTable('服务UUID,特征UUID,属性,初值HEX,描述符').error || ''),
    '只有表头时给出可理解的报错');
  check(/没有解析到任何特征行/.test(sbT.blePfParseTable('').error || ''), '空文件报错');
  check(/特征数量超过上限/.test(sbT.blePfParseTable(
    Array.from({ length: 20 }, (_, i) => '6E400001-B5A3-F393-E0A9-E50E24DCCA9E,6E40000' + i + '-B5A3-F393-E0A9-E50E24DCCA9E,read,,').join('\n')).error || ''),
    '超过特征数量上限时报错');

  // 导出 → 再导入，必须等价（往返一致）
  sbT._blePeriphForm.service = '6E400001-B5A3-F393-E0A9-E50E24DCCA9E';
  sbT._blePeriphForm.chars = [
    { uuid: '6E400002-B5A3-F393-E0A9-E50E24DCCA9E', props: ['write', 'write_without_response'], value: '', desc: '' },
    { uuid: '6E400003-B5A3-F393-E0A9-E50E24DCCA9E', props: ['read', 'notify'], value: '41 42', desc: '2901=T:温度计' },
  ];
  const outCsv = sbT.blePfBuildTable();
  const back = sbT.blePfParseTable(outCsv);
  check(!back.error, '导出的 CSV 能被自己解析回来', back.error || '');
  check(back.service === sbT._blePeriphForm.service && back.chars.length === 2, '往返后服务与特征数一致');
  check(JSON.stringify(back.chars[1].props) === '["read","notify"]' && back.chars[1].value === '41 42'
    && back.chars[1].desc === '2901=T:温度计', '往返后属性/初值/描述符都不丢', JSON.stringify(back.chars[1]));
  check(outCsv.split('\r\n')[0] === '服务UUID,特征UUID,属性,初值HEX,描述符', '导出第一行是表头');
  check(/","|"/.test(sbT.blePfBuildTable({ service: 'S', chars: [{ uuid: 'U', props: ['read'], value: '', desc: 'T:含,逗号' }] })),
    '值里有逗号时按 CSV 规范加引号（Excel 才不会拆错列）');

  // 前后端契约
  check(/fn ble_periph_pick_config_file\(/.test(mainRs) && /ble_periph_pick_config_file,/.test(mainRs),
    '后端有并注册了"选表格文件"命令');
  check(/fn ble_periph_save_config_file\(/.test(mainRs) && /ble_periph_save_config_file,/.test(mainRs),
    '后端有并注册了"导出表格"命令');
  check(/invoke\('ble_periph_pick_config_file'\)/.test(html) && /invoke\('ble_periph_save_config_file'/.test(html),
    '前端两个命令都接了');
  check(/add_filter\("表格文件", &\["csv", "md", "markdown", "txt"\]\)/.test(mainRs),
    '文件框限定表格类扩展名');
  check(/id="blePfImportBtn"/.test(html) && /id="blePfExportBtn"/.test(html),
    '广播配置区有「导入表格 / 导出表格」两个按钮');

  console.log('\n【内存与磁盘上限（L3a / M28 / M29）】');

  // ---------- 源码级防回退 ----------
  check(!/_textCount > 1000000/.test(html), '旧的"100 万行才裁剪"逻辑已移除');
  check(!/var softLimit/.test(html), 'DOM 裁剪不再各写一份软上限变量');
  check(/_textDataMaxBytes: 8 \* 1024 \* 1024/.test(html), '紧凑缓冲有字节预算');
  const trimCalls = (html.match(/trimOutputDom\(mid, el/g) || []).length;
  check(trimCalls >= 4, '三处 DOM 裁剪入口都收敛到 trimOutputDom', trimCalls);
  check(/function bufferTrimToBytes/.test(html) && /function bufferCompactCapacity/.test(html),
    '有按字节裁剪 + 容量收缩两个函数');

  check(/DEBUG_LOG_MAX_BYTES/.test(mainRs) && /fn debug_log_rotate/.test(mainRs) && /SEAHI_DEBUG_LOG/.test(mainRs),
    'L3a：调试日志有上限 / 轮转 / 开关');
  check(/const LOG_CACHE_MAX_BYTES: u64 = 8 \* 1024 \* 1024;/.test(mainRs)
     && /const LOG_CACHE_MAX_TOTAL_BYTES: u64 = 64 \* 1024 \* 1024;/.test(mainRs),
    'M28：会话缓存有单文件与目录总预算');
  check(/app\.emit\(\s*"log-cache-capped"/.test(mainRs), 'M28：后端触顶时通知前端（不静默）');
  check(/listen\('log-cache-capped'/.test(html), 'M28：前端接了这个事件');
  check(/fn enforce_log_cache_limit_in\(/.test(mainRs) && /active\.contains\(p\)/.test(mainRs),
    'M28：清理时跳过正在写入的文件');

  // ---------- 行为级：紧凑缓冲按字节裁剪 ----------
  const sbM = {
    console,
    TextEncoder,
    monitors: {},
    _typeMap: { recv: 0, send: 1, sys: 2, err: 3 },
    logCacheScheduleFlush() {},
    // bufferPush 现在还会回灌日志（S7）；这一段只测紧凑缓冲，给个桩即可
    mcpLogPush() {},
    // 通道名规则（bufferPush 会用它，实际值无所谓 —— mcpLogPush 是桩）
    mcpSerialLogChannels() { return { rx: 'serial:x:rx', tx: 'serial:x:tx' }; },
    document: { getElementById() { return null; }, addEventListener() {} },
  };
  vm.createContext(sbM);
  const bufConsts = ['TEXT_BUF_INIT', 'TEXT_IDX_INIT']
    .map((n) => (new RegExp('var ' + n + ' = ([^;]+);').exec(html) || [])[0])
    .filter(Boolean).join('\n');
  vm.runInContext([
    bufConsts,
    extractFunction('bufferPush'),
    extractFunction('bufferTrimOld'),
    extractFunction('bufferTrimToBytes'),
    extractFunction('bufferCompactCapacity'),
    extractFunction('bufferEnforceBudget'),
  ].join('\n'), sbM);

  const makeMon = (initCap, budget) => ({
    isConnected: false, _bufferStart: 0,
    _textData: new Uint8Array(initCap), _textDataLen: 0,
    _textDataMaxBytes: budget,
    _textOffsets: new Uint32Array(64), _textTypes: new Uint8Array(64),
    _textTsLens: new Uint16Array(64), _textCount: 0,
  });
  const pushLines = (mid, n) => {
    for (let i = 0; i < n; i++) sbM.bufferPush(mid, 'recv', '', 'LINE-' + String(i).padStart(3, '0') + '\n');
  };

  sbM.monitors.small = makeMon(1024, 4096);
  pushLines('small', 2000);   // 每行 9~10 字节 ⇒ 约 19KB，远超 4096 预算
  const small = sbM.monitors.small;
  check(small._textDataLen <= 4096, '超出字节预算后被裁剪', small._textDataLen);
  check(small._textCount > 0 && small._textCount < 2000, '裁剪后仍保留尾部数据（不是清空）', small._textCount);

  const tail = new TextDecoder().decode(small._textData.subarray(0, small._textDataLen));
  check(tail.includes('LINE-1999'), '保留的是最新数据：最后一行还在', tail.slice(-24));
  check(!tail.includes('LINE-000'), '最旧的行已被裁掉');

  // 容量收缩：初始给 4 MiB，裁剪后应回落到 1 MiB 下限（不再单调增长）
  sbM.monitors.big = makeMon(4 * 1024 * 1024, 4096);
  pushLines('big', 2000);
  const big = sbM.monitors.big;
  check(big._textData.length === sbM.TEXT_BUF_INIT,
    '裁剪后容量收缩到起步值（64 KB）而不单调增长', big._textData.length);

  // 预算极小时也不能把缓冲清空
  sbM.monitors.tiny = makeMon(1024, 8);
  pushLines('tiny', 5);
  const tiny = sbM.monitors.tiny;
  check(tiny._textCount >= 1 && tiny._textDataLen > 0, '预算极小时仍保留最后一行（不清空）', tiny._textCount);

  // ---------- M29-d：容量起步值 + 扩容正确性 ----------
  check(/new Uint8Array\(TEXT_BUF_INIT\)/.test(html) && /var TEXT_BUF_INIT = 64 \* 1024;/.test(html),
    'M29-d：紧凑存储改为小容量起步（不再每个监视器预分配 1.7 MB）');
  check(/nOffsets\.set\(m\._textOffsets\)/.test(html), '索引数组扩容时拷贝旧数据');
  check(/bufferCompactCapacity\(monitors\[mid\]\);/.test(html), '「清空输出」时回收紧凑存储容量');
  // 三条监视器创建路径（createMonitorPane / addWslMonitor / initWslMonitor）都必须设字节预算，
  // 否则 bufferEnforceBudget 里 `len <= undefined` 恒为 false、`undefined >> 1` 为 0，
  // 会把该监视器的紧凑缓冲裁成只剩一行（保存/复制全废）—— 这个 bug 真实发生过。
  const bufDeclSites = (html.match(/_textData: new Uint8Array\(/g) || []).length;
  const budgetSites = (html.match(/_textDataMaxBytes:/g) || []).length;
  check(bufDeclSites > 0 && bufDeclSites === budgetSites,
    '每条监视器创建路径都设了字节预算', bufDeclSites + ' vs ' + budgetSites);
  check(!/_textData: new Uint8Array\(1024 \* 1024\)/.test(html), '没有遗留的 1 MB 预分配创建路径');

  // 跨扩容边界的回归防护：曾经只 new 更大的数组就替换 ⇒ 已积累的偏移表被清零，
  // 保存/复制/历史加载会读到错乱数据。原来要 10 万行才踩到，容量调小后 4096 行就会触发。
  sbM.monitors.grow = makeMon(64 * 1024, 64 * 1024 * 1024);   // 预算放大，确保只扩容不裁剪
  pushLines('grow', 5000);
  const grow = sbM.monitors.grow;
  check(grow._textCount === 5000, '写完 5000 行（跨过 4096 的扩容边界）', grow._textCount);
  check(grow._textOffsets[4095] > 0 && grow._textOffsets[4095] < grow._textOffsets[4096],
    '跨扩容边界后旧偏移仍有效（没被清零）',
    grow._textOffsets[4095] + ' / ' + grow._textOffsets[4096]);
  check(grow._textOffsets[4999] === grow._textDataLen, '最后一个偏移等于数据总长',
    grow._textOffsets[4999] + ' / ' + grow._textDataLen);

  // 空闲监视器（比如从没打开过的 WSL 分栏、加过又没用的额外监视器）容量能收回到起步值
  const idle = makeMon(4 * 1024 * 1024, 8 * 1024 * 1024);
  idle._textOffsets = new Uint32Array(200000);
  idle._textTypes = new Uint8Array(200000);
  idle._textTsLens = new Uint16Array(200000);
  sbM.monitors.idle = idle;
  vm.runInContext('bufferCompactCapacity(monitors.idle)', sbM);
  check(idle._textData.length === sbM.TEXT_BUF_INIT && idle._textOffsets.length === sbM.TEXT_IDX_INIT,
    '空闲监视器容量可回收到底线', idle._textData.length + ' / ' + idle._textOffsets.length);

  // 防御：漏设 _textDataMaxBytes 时回退到默认预算，而不是把缓冲裁空
  sbM.monitors.nofield = makeMon(64 * 1024, 8 * 1024 * 1024);
  delete sbM.monitors.nofield._textDataMaxBytes;
  pushLines('nofield', 200);
  check(sbM.monitors.nofield._textCount === 200,
    '漏设字节预算时回退到默认值（不会把缓冲裁成一行）', sbM.monitors.nofield._textCount);

  // ---------- 行为级：DOM 裁剪（延后，而不是永久跳过）----------
  const listeners = {};
  let selection = '';
  const sbD = {
    console,
    monitors: {},
    window: { getSelection() { return { toString() { return selection; } }; } },
    _els: {},
    document: {
      addEventListener(type, fn) { listeners[type] = fn; },
      getElementById(id) { return sbD._els[id] || null; },
    },
  };
  vm.createContext(sbD);
  const domConsts = ['OUT_DOM_MAX_LINES', 'OUT_DOM_SOFT_LIMIT', 'OUT_DOM_HARD_LIMIT']
    .map((n) => (new RegExp('var ' + n + ' = (\\d+);').exec(html) || [])[0])
    .filter(Boolean).join('\n');
  vm.runInContext([
    domConsts,
    extractFunction('hasTextSelection'),
    extractFunction('trimOutputDom'),
  ].join('\n'), sbD);
  check(sbD.OUT_DOM_MAX_LINES === 10000 && sbD.OUT_DOM_SOFT_LIMIT === 15000 && sbD.OUT_DOM_HARD_LIMIT === 60000,
    'DOM 三档上限齐备（10000 / 15000 / 60000）',
    [sbD.OUT_DOM_MAX_LINES, sbD.OUT_DOM_SOFT_LIMIT, sbD.OUT_DOM_HARD_LIMIT].join('/'));

  const fakeOut = (n) => {
    const el = {
      children: [], _lineCount: n, scrollTop: 0, scrollHeight: n * 10,
      get firstChild() { return this.children[0] || null; },
      removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) { this.children.splice(i, 1); this.scrollHeight -= 10; }
        return c;
      },
    };
    for (let i = 0; i < n; i++) el.children.push({ classList: { contains() { return false; } } });
    return el;
  };

  // A. 正常情况：与旧行为一致
  const elA = fakeOut(20000);
  elA.scrollTop = 5000;
  sbD.monitors.main = { _bufferStart: 0 };
  sbD._els['main-output'] = elA;
  const removedA = sbD.trimOutputDom('main', elA);
  check(elA.children.length === 10000, '正常：超过 15000 行裁到 10000', elA.children.length);
  check(removedA === 10000 && sbD.monitors.main._bufferStart === 10000, '返回并累计移除的非空行数', removedA);
  check(elA.scrollTop === 0, '移除高度远超滚动位置时 scrollTop 收敛到 0', elA.scrollTop);

  // B. 用户在顶部看历史：只裁到硬上限，不再无限跳过
  const elB = fakeOut(70000);
  sbD.monitors.main = { _bufferStart: 0 };
  const removedB = sbD.trimOutputDom('main', elB);
  check(elB.children.length === 60000, '在顶部时只裁到硬上限 60000（不再无限增长）', elB.children.length);
  check(removedB === 10000, '只移除超出部分，最小干预', removedB);

  // C. 有选区：仍受硬上限约束 + 标记待补裁，选区消失后补裁
  selection = 'selected text';
  const elC = fakeOut(70000);
  elC.scrollTop = 400000;
  const monC = { _bufferStart: 0 };
  sbD.monitors.main = monC;
  sbD._els['main-output'] = elC;   // 补裁监听要靠 id 找到同一个元素
  sbD.trimOutputDom('main', elC);
  check(elC.children.length === 60000, '有选区时仍受硬上限约束', elC.children.length);
  check(monC._domTrimPending === true, '有选区且仍超标 → 标记待补裁（不是永久跳过）');
  check(elC.scrollTop === 300000, '滚动被补偿：视觉位置保持不动', elC.scrollTop);

  const scMarker = "document.addEventListener('selectionchange', function() {";
  const scStart = html.indexOf(scMarker);
  const scEnd = html.indexOf('\n});', scStart);
  check(scStart > 0 && scEnd > scStart, 'index.html 注册了 selectionchange 补裁监听');
  vm.runInContext('var onSelectionChange = function() {'
    + html.slice(scStart + scMarker.length, scEnd + 1) + '};', sbD);
  selection = '';
  sbD.onSelectionChange();
  check(elC.children.length === 10000, '选区消失后补裁到正常上限 10000', elC.children.length);
  check(monC._domTrimPending === false, '补裁完成后清掉待裁标记');

  // D. force：用户已滚回底部，忽略保护
  const elD = fakeOut(20000);
  sbD.monitors.main = { _bufferStart: 0 };
  sbD.trimOutputDom('main', elD, true);
  check(elD.children.length === 10000, 'force=true（滚回底部）时忽略保护直接裁到 10000', elD.children.length);

  console.log('\n【MCP 服务器（入口 / 协议 / 配置隔离）】');

  const mcpBtnIdx = html.indexOf('id="mcpBtn"');
  const themeIdx = html.indexOf('id="themeStyleWrap"');
  check(mcpBtnIdx > 0, '标题栏有 MCP 图标');
  check(mcpBtnIdx > 0 && themeIdx > 0 && mcpBtnIdx < themeIdx,
    'MCP 图标在「风格」下拉的左边', mcpBtnIdx + ' vs ' + themeIdx);
  // 顶栏间距：以前各控件自带 margin（图标按钮 12 / 提交issue·更新 8 / 主题开关 10 /
  // 加监视器 0+app-info 10），相邻间距在 8·10·12 之间跳，肉眼看着不齐。现在统一成容器的 gap。
  // 取 8px：先试过 12px（三种里的最大值），整条栏比原先松，用户反馈不符合原先的审美。
  check(/\.global-bar \{[\s\S]{0,1200}?gap:8px;/.test(html), '顶栏用容器 gap 统一定义间距（8px）');
  check(!/\.global-bar \{[\s\S]{0,1200}?gap:12px;/.test(html), '没有留下 12px 那版（太松）');
  {
    // 结束标记必须带 `<div class=`：只写 `win-ctrl` 会命中**前面的 CSS 规则**（位置比顶栏还靠前），
    // 切片直接成空串 —— 那种"空切片恒真/恒假"的断言最会骗人，所以这里还断言了长度。
    const barFrom = html.indexOf('<div class="global-bar"');
    const barTo = html.indexOf('<div class="win-ctrl"');
    const bar = (barFrom >= 0 && barTo > barFrom) ? html.slice(barFrom, barTo) : '';
    check(bar.length > 500, '取到了顶栏标记片段（否则下面的检查都是空转）', bar.length);
    check(!/style="margin-(left|right)/.test(bar) && !/margin-left:12px/.test(bar),
      '顶栏控件不再各自内联 margin（那是间距不齐的根源）');
    const ruleOf = (sel) => {
      const re = new RegExp('^' + sel.replace(/[.#]/g, '\\$&') + ' \\{[^}]*\\}', 'm');
      return (re.exec(html) || [''])[0];
    };
    ['.app-info', '.issue-btn', '.update-btn', '.theme-switch', '#mcpBtn'].forEach((sel) => {
      const r = ruleOf(sel);
      check(r !== '' && !/margin-(left|right)/.test(r), '顶栏 ' + sel + ' 不再自带左右 margin');
    });
  }
  check(/id="mcpBtn"[\s\S]{0,1400}?fill="currentColor"/.test(html),
    '图标是内联 SVG 且用 currentColor（能跟主题换色）');
  check(!/id="mcpBtn"[\s\S]{0,1400}?#bfbfbf/.test(html),
    '没有把图形源里写死的 #bfbfbf 抄进来');
  // 2026-09 换过一版图标（用户给的 MCP.svg）：钉住新图形的起点，防止回退成旧的那份
  check(/id="mcpBtn"[\s\S]{0,400}?<path d="M895\.67 256\.204/.test(html),
    '图标是新版 MCP.svg 的那份（viewBox 1024、单条 path）');
  // 图形源**不留在仓库里**：图标本体就是 index.html 里那段内联 SVG，那才是唯一真源。
  // 留着一份 .svg 只会让人以为改它能生效（它其实不会被任何地方引用）。
  check(!fs.existsSync(path.join(root, 'mcp.svg'))
    && !fs.existsSync(path.join(root, 'doc', 'IMG', 'mcp.svg')),
    '仓库里不再留图形源 svg（避免出现"改了不生效"的第二份真源）');
  check(/<span class="mcp-dot" id="mcpDot">/.test(html), '图标上有状态点');
  // 图标颜色与「风格」下拉里的图标同一个 token（用户要求"和风格那个图标一个色"）
  check(/#mcpBtn \{[^}]*color:var\(--text\)/.test(html),
    'MCP 图标显式用 var(--text)（与 .sel 的「风格」控件同色）');
  check(/^\.sel \{[^}]*color:var\(--text\)/m.test(html),
    '「风格」下拉确实也是 var(--text)（两边同 token，才不会一边亮一边暗）');
  // 同色 ≠ 同观感：螺旋形墨量比调色板大，看着更亮，所以要单独压一点亮度
  check(/#mcpBtn > svg \{ opacity:\.8; \}/.test(html),
    '图形本身压到 0.8 亮度（用户实测反馈"显得更亮、不是灰的"）');
  check(!/#mcpBtn \{[^}]*opacity/.test(html),
    '亮度只能压在 svg 上：挂在 #mcpBtn 会把右下角状态点一起压暗（那是状态指示，不能失真）');

  // 用户改主意了：**一个切换按钮**（原来并排的"启用/关闭"两个按钮已删）
  check(/id="mcpToggleBtn"[^>]*onclick="mcpToggleEnabled\(\)"/.test(html), '有且只有一个切换按钮');
  check(!/id="mcpEnableBtn"|id="mcpDisableBtn"/.test(html), '两个并列按钮已删除');
  check(/function mcpToggleEnabled\(\)/.test(html), '切换函数存在');
  check(/var running = !!\(_mcpStatus && _mcpStatus\.running\);\s*\n\s*mcpSetEnabled\(!running\);/.test(html),
    '切换以最近一次真实状态为准（不靠界面猜）');
  check(/tg\.textContent = running \? '关闭 MCP 服务器' : '启用 MCP 服务器'/.test(html),
    '按钮文案写的是"点了会发生什么"（关着→启用 / 开着→关闭）');
  check(/_mcpBusy = true;/.test(html) && /tg\.disabled = !!_mcpBusy;/.test(html),
    '命令发出期间按钮禁用（连点会陆续发两条相反的 IPC）');
  check(/id="mcpUrl"/.test(html) && /id="mcpClientCfg"/.test(html) && /id="mcpPrompt"/.test(html),
    '弹窗有 连接 URL / 客户端配置 / 安装提示词 三块');
  const copyBtns = (html.match(/onclick="mcpCopy\(/g) || []).length;
  check(copyBtns === 3, '三块各有一个复制按钮', copyBtns);
  // 用户要求删掉底部那行"版本 · 工具 · 请求 · 丢弃 · 发现文件"
  check(!/id="mcpMeta"/.test(html), '底部那行元信息已删除（界面不再占一行）');
  check(/stText\.title = parts\.join\(' · '\)/.test(html),
    '这些数字挪进状态文案的悬停提示（排查"丢了多少条"时还查得到）');
  check(/class="ble-modal-mask" id="mcpModal"/.test(html), '弹窗复用现有模态框外观');
  // 滚动条：同一个弹窗里不能一半是细灰条、一半是 Chromium 默认的白宽条
  check(inSbRule('.mcp-url') && inSbRule('.mcp-code') && inSbRule('#mcpModal .ble-modal-body'),
    '连接 URL / 客户端配置 / 安装提示词 / 弹窗主体（窗口太矮时滚动）都套上同一份滚动条规则');
  check(/\.mcp-url::-webkit-scrollbar-thumb,[\s\S]{0,220}?background-clip:content-box/.test(html),
    'MCP 弹窗的滚动条滑块与从机面板同一套配色（半透明中性灰）');
  // 横竖交汇处（corner）：只改 track/thumb 不够，漏了这块就留一个白色方块（用户截图指出来了）
  check(/\.mcp-code::-webkit-scrollbar-corner,[\s\S]{0,120}?\{ background:transparent; \}/.test(html),
    '滚动条交汇处不再是默认白方块（MCP 弹窗）');
  check(/\.ble-log::-webkit-scrollbar-corner,[\s\S]{0,400}?background:transparent/.test(html),
    '滚动条交汇处一并覆盖从机面板（同一个毛病，别只修看得见的那一处）');
  check((html.match(/::-webkit-scrollbar-corner/g) || []).length === 6,
    '六个可滚动区都写了 corner（3 从机 + 2 MCP 内容框 + 弹窗主体）',
    (html.match(/::-webkit-scrollbar-corner/g) || []).length);
  // 标题在上、内容占满整行；复制按钮压在**内容框内的右上角**（用户指定的两轮调整结果）
  check(/\.mcp-label \{ display:block; font-size:12px; color:var\(--text-d\); margin-bottom:5px; \}/.test(html),
    '标题单独一行（不再和内容左右并排）');
  check(/\.mcp-box \{ position:relative; \}/.test(html)
    && /\.mcp-copy-btn \{ position:absolute; top:3px; right:4px;/.test(html),
    '复制按钮绝对定位在内容框右上角');
  check(/class="ble-modal-btn mcp-copy-btn"/.test(html)
    && (html.match(/class="ble-modal-btn mcp-copy-btn"/g) || []).length === 3,
    '三块内容各有且只有一个复制按钮',
    (html.match(/class="ble-modal-btn mcp-copy-btn"/g) || []).length);
  check(/<div class="mcp-box">\s*\n\s*<span class="mcp-url" id="mcpUrl"><\/span>\s*\n\s*<button class="ble-modal-btn mcp-copy-btn"/.test(html),
    '按钮和 URL 在同一个定位容器里（用户举的例子：URL 框的右上角）');
  check(/padding:26px 64px 5px 8px;/.test(html) && /padding:8px 64px 8px 8px;/.test(html),
    '内容右侧留出按钮的位置（按点击后变宽的"已复制"算，否则会盖住内容）');
  // 单行内容必须**整体下移一行**给按钮让位 —— 用几何关系断言，避免只改数字改出重叠
  {
    const urlRule = (/\.mcp-url \{[^}]*\}/.exec(html) || [''])[0];
    const btnRule = (/\.mcp-copy-btn \{[^}]*\}/.exec(html) || [''])[0];
    const padTop = +((/padding:(\d+)px 64px/.exec(urlRule) || [, 0])[1]);
    const btnTop = +((/top:(\d+)px/.exec(btnRule) || [, 0])[1]);
    const btnH = +((/height:(\d+)px/.exec(btnRule) || [, 0])[1]);
    check(padTop >= btnTop + btnH,
      'URL 内容下移一整行避开按钮（上内边距 ' + padTop + 'px ≥ 按钮底边 ' + (btnTop + btnH) + 'px）');
    const lh = +((/line-height:(\d+)px/.exec(urlRule) || [, 0])[1]);
    const padBottom = +((/padding:\d+px 64px (\d+)px/.exec(urlRule) || [, 0])[1]);
    const minH = +((/min-height:(\d+)px/.exec(urlRule) || [, 0])[1]);
    check(minH === padTop + lh + padBottom,
      'min-height 与内边距 + 行高一致（' + minH + ' = ' + padTop + '+' + lh + '+' + padBottom + '）');
  }
  check(/\.mcp-url \{ display:block; box-sizing:border-box; min-height:49px; line-height:18px;/.test(html),
    'URL 框：块级 + border-box + 与内边距对齐的最小高度');
  check(/\.mcp-url \{ display:block;/.test(html),
    'URL 是 span，必须 display:block —— 以前靠"是 flex 子项"被块级化，现在不在 flex 里了');
  check(!/mcp-field-head/.test(html), '标题行容器已删除（上下结构后不再需要）');
  check(/overflow-y:auto;/.test(html.split('id="mcpModal"')[1] || ''),
    '弹窗主体可滚动（窗口太矮时不会把内容裁掉）');
  check(/listen\('mcp-status-changed'/.test(html), '前端监听后端的状态变化事件');
  // 会话增减现在会推状态（后端 transport 里调 core.emit_status）。钉住两端：
  // 后端"连上/断开各推一次"由 Rust 测试 session_add_and_remove_push_status_to_the_ui 守着；
  // 这里守前端——事件来了必须用 payload 重画，而不是拿旧缓存重画（那样等于没更新）。
  check(/listen\('mcp-status-changed', function\(ev\) \{[\s\S]{0,160}?_mcpStatus = ev && ev\.payload;/.test(html),
    '状态事件必须用 ev.payload 更新缓存再重画（不能用旧 _mcpStatus 重画，那样界面永远不变）');
  check(/function openMcpModal\(\)[\s\S]{0,200}?refreshMcpStatus\(\);/.test(html),
    '打开弹窗时主动拉一次状态（推送漏了也能纠正）');

  // ---- MCP 模块源码（命令实现与隔离性都在这里，不在 main.rs）----
  const mcpDir = path.join(root, 'src-tauri', 'src', 'mcp');
  const mcpFiles = ['mod.rs', 'protocol.rs', 'transport.rs', 'aiconfig.rs', 'bridge.rs', 'loghub.rs', 'calllog.rs', 'registry.rs', 'report.rs'];
  const mcpSrc = mcpFiles
    .map((f) => fs.readFileSync(path.join(mcpDir, f), 'utf8'))
    .join('\n');
  // 生产代码部分（去掉测试模块）：
  // "绝不碰 config.json" 这类断言针对生产代码 —— 测试里为了验证隔离会故意造一个 config.json。
  //
  // ⚠️ 切点必须是**真正的测试模块**（`#[cfg(test)]` 紧跟 `mod tests`），不能是"第一个
  // `#[cfg(test)]`"：条目级的 cfg(test) 会让切片过早截断。这个坑踩过两次 ——
  // 一次是 `protocol.rs` 里的 `test_panic` 工具，一次是 `mod.rs` 里单测专用的 `test_ui` 字段
  // （它出现在 `serve()` 之前，于是"停机标志只有一处复位"这类断言看到的是一片空白，直接误报失败）。
  const mcpProd = mcpFiles
    .map((f) => {
      const s = fs.readFileSync(path.join(mcpDir, f), 'utf8');
      const m = /#\[cfg\(test\)\]\s*\nmod tests\b/.exec(s);
      return m ? s.slice(0, m.index) : s;
    })
    .join('\n');

  // ---- 前后端契约 ----
  const mcpCmds = ['mcp_status', 'mcp_set_enabled', 'mcp_reset_token', 'mcp_client_config'];
  mcpCmds.forEach((c) => {
    check(new RegExp("invoke\\('" + c + "'").test(html), '前端调用 ' + c);
    check(new RegExp('fn ' + c + '\\(').test(mcpSrc), '后端实现 ' + c);
    check(new RegExp('^\\s*mcp::' + c + ',\\s*$', 'm').test(mainRs), '后端已注册 ' + c);
  });
  check(/AI_CONFIG_FILE: &str = "ai-config\.json"/.test(mcpSrc), 'AI 配置写独立文件 ai-config.json');
  check(!/save_config|load_config|backup_config/.test(mcpSrc),
    'MCP 模块绝不调用用户配置的读写命令（R5 的硬约束）');
  // 只查"当字面量用"的 config.json；注释里说明"绝不碰 config.json"是允许的
  check(!/["']config\.json["']/.test(mcpProd), 'MCP 生产代码里根本不把 config.json 当文件名用');
  check(/fn write_atomic/.test(mcpSrc) && /std::fs::rename\(&tmp, path\)/.test(mcpSrc),
    'AI 配置用临时文件 + rename 原子写（不重犯 M7）');
  check(/enabled: true/.test(mcpSrc) && /host: "127\.0\.0\.1"/.test(mcpSrc),
    '默认随程序启动，且只监听回环');
  // 要拦的是"真的绑 0.0.0.0"；测试数据里出现 "0.0.0.0" 是为了验证它会被拒，属正常
  check(!/bind\([^)]*0\.0\.0\.0/.test(mcpSrc) && !/host:\s*"0\.0\.0\.0"/.test(mcpSrc),
    '绝不把 0.0.0.0 当监听地址用（只监听回环）');
  check(/"\/healthz"/.test(mcpSrc) && /"\/sse"/.test(mcpSrc) && /"\/messages"/.test(mcpSrc),
    '有 /healthz、/sse、/messages 三个端点');
  check(/constant_time_eq/.test(mcpSrc), 'token 用定长比较');
  check(/event: endpoint/.test(mcpSrc), 'SSE 首帧下发 endpoint');
  check(/: ping/.test(mcpSrc), '有 SSE 心跳（防中间层断流）');
  check(/fn limits_json/.test(mcpSrc) && /maxSessions/.test(mcpSrc), '硬性上限可被 AI 查询');
  check(/E_USER_DENIED/.test(mcpSrc) && /E_UI_TIMEOUT/.test(mcpSrc),
    '自定义错误码已定义（供后续危险工具确认/前端桥超时使用）');
  check(/jsonrpc/.test(mcpSrc) && /"isError"/.test(mcpSrc),
    '工具失败返回 isError 而不是 JSON-RPC error（规范要求）');
  // 前提：不能开 panic=abort，否则工具里一次 panic 会杀掉整个进程
  check(!/panic\s*=\s*"abort"/.test(fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8')),
    'Cargo.toml 没有 panic=abort（工具 panic 不能杀进程）');
  // release 不带 DevTools（用户要求）。真正的开关是 tauri 的 cargo feature：
  //   tauri-runtime-wry 里 `with_devtools(...)` 整块被 `#[cfg(any(debug_assertions, feature = "devtools"))]` 门控，
  //   所以 release（debug_assertions 关闭）只要不开这个 feature，那段代码根本不编译 —— wry 的默认值 false 生效。
  // 注意 tauri.conf.json 里的 `"devtools": true` 是**死配置**：tauri 2.11.2/codegen/build 里没有任何代码读它
  //   （已逐个 crate 搜过），留着只会让人以为 release 开了 devtools。已删除，这里一并钉住别再回来。
  {
    const cargoToml = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
    check(!/^tauri\s*=\s*\{[^}]*"devtools"/m.test(cargoToml) && !/^tauri\s*=\s*\{[^}]*\bdevtools\b/m.test(cargoToml),
      'tauri 没开 devtools feature（release 构建里 DevTools 会被编译掉）',
      (/^tauri\s*=.*$/m.exec(cargoToml) || [''])[0].trim());
    const conf = fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8');
    check(!/"devtools"/.test(conf), 'tauri.conf.json 里不再写 devtools（那行没人读，只会误导）');
  }

  // ---- 行为：状态点与按钮禁用 ----
  const mcpEls = {};
  const mcpEl = (id) => {
    if (!mcpEls[id]) {
      mcpEls[id] = { id: id, className: '', textContent: '', title: '', disabled: false, style: {} };
    }
    return mcpEls[id];
  };
  const sbMcp = {
    console,
    document: { getElementById: (id) => mcpEl(id) },
    showToast() {},
    invoke() { return Promise.resolve({}); },
    setTimeout() {},
    navigator: {},
    window: {},
    _mcpStatus: null,
    _mcpBusy: false,
  };
  vm.createContext(sbMcp);
  vm.runInContext([
    'var _mcpBusy = false;',
    extractFunction('_mcpDotClass'),
    extractFunction('renderMcpStatus'),
  ].join('\n'), sbMcp);

  check(sbMcp._mcpDotClass(null) === 'mcp-dot', '状态未知时点是灰的');
  check(sbMcp._mcpDotClass({ running: false }) === 'mcp-dot', '未启用是灰的');
  check(sbMcp._mcpDotClass({ running: false, lastError: 'x' }) === 'mcp-dot err', '启动失败是红的');
  check(sbMcp._mcpDotClass({ running: true, sessions: 0 }) === 'mcp-dot on', '监听中无会话是绿的');
  check(sbMcp._mcpDotClass({ running: true, sessions: 2 }) === 'mcp-dot live', '有会话是蓝的');

  sbMcp.renderMcpStatus({
    running: false, enabled: true, host: '127.0.0.1', port: 7777, sessions: 0,
    version: '0.9.9', toolCount: 4, requests: 0, dropped: 0,
  });
  check(mcpEl('mcpToggleBtn').disabled === false, '未运行时切换按钮可点');
  check(mcpEl('mcpToggleBtn').textContent === '启用 MCP 服务器', '未运行时按钮说"启用"',
    mcpEl('mcpToggleBtn').textContent);
  check(mcpEl('mcpToggleHint').textContent === '', '未运行时按钮旁边没有多余的灰字');
  check(mcpEl('mcpOnBox').style.display === 'none', '未运行时隐藏 URL / 提示词区块');
  check(mcpEl('mcpStateText').textContent === '已关闭', '未运行时状态文案正确');
  check(mcpEl('mcpBtn').title.indexOf('MCP 服务器：已关闭') === 0
    && mcpEl('mcpBtn').title.indexOf('AI 客户端') > 0,
    '未运行时图标提示：状态 + 一句"这个是干什么的"', mcpEl('mcpBtn').title);
  check(mcpEl('mcpStateText').title.indexOf('工具 4 个') > 0,
    '删掉的那行数字挪进了状态文案的悬停提示', mcpEl('mcpStateText').title);

  sbMcp.renderMcpStatus({
    running: true, host: '127.0.0.1', port: 7777, sessions: 1,
    version: '0.9.9', toolCount: 4, requests: 3, dropped: 0,
  });
  check(mcpEl('mcpToggleBtn').disabled === false, '运行中切换按钮仍可点（它就是用来关的）');
  check(mcpEl('mcpToggleBtn').textContent === '关闭 MCP 服务器', '运行中按钮说"关闭"',
    mcpEl('mcpToggleBtn').textContent);
  check(mcpEl('mcpToggleHint').textContent === '点按钮可停止', '运行中旁边给出下一步提示');
  check(mcpEl('mcpToggleBtn').title.indexOf('释放端口') > 0, '运行中按钮提示写的是"停止并释放端口"');
  // 悬停说明要"说明主要作用"，不能只是换个名字
  check(mcpEl('mcpToggleBtn').title.indexOf('关闭 MCP 服务器：') === 0
    && mcpEl('mcpToggleBtn').title.indexOf('日志中心') > 0,
    '运行中：说明关掉会发生什么（释放端口 + 清日志中心内存）', mcpEl('mcpToggleBtn').title);
  {
    const titles = (html.match(/title="[^"]{12,}"/g) || []).join('\n');
    [['连接 URL', '访问令牌'], ['客户端配置', 'mcpServers'], ['安装提示词', '发给 AI 客户端']]
      .forEach(([label, must]) => {
        const re = new RegExp('title="([^"]*)"[^>]*>' + label + '<');
        const m = re.exec(html);
        check(!!m && m[1].indexOf(must) > 0,
          '「' + label + '」的悬停说明讲了它的作用（含"' + must + '"）', m ? m[1] : '(没有 title)');
      });
    check(/title="复制完整连接地址（含访问令牌）"/.test(titles), '复制 URL 的悬停说明');
    check(/title="复制客户端配置 JSON：粘进 Claude \/ Cursor 的 mcpServers"/.test(titles),
      '复制客户端配置的悬停说明');
    check(/title="复制这段提示词发给 AI，让它自己完成客户端配置"/.test(titles),
      '复制安装提示词的悬停说明');
    check(/onclick="closeMcpModal\(\)" title="只关闭这个窗口，不影响 MCP 服务器运行"/.test(html),
      '底部「关闭」说清它只关窗口、不关服务器（最容易被误解的一处）');
    check(/id="appInfoWrap"[^>]*title="加载中\.\.\."/.test(html)
      && /点击回到串口主界面/.test(html),
      '左上角图标悬停：版本号 + 点击会做什么');
  }
  check(!/en\.style\.opacity|dis\.style\.opacity/.test(html),
    '变暗只由 CSS 的 :disabled 负责（JS 再写一份内联 opacity 就是两处口径，迟早漂移）');
  check(/\.ble-modal-btn:disabled \{ cursor:default; opacity:\.45; \}/.test(html),
    '有统一的按钮禁用态样式（压暗 + 不再是手型光标）');
  check(/\.ble-modal-btn:disabled:hover \{ border-color:var\(--border\); filter:none; \}/.test(html),
    '禁用态悬停不再有"可点"的反馈（边框不变亮、primary 不提亮）');
  check(mcpEl('mcpOnBox').style.display === 'block', '运行中显示 URL / 提示词区块');
  check(mcpEl('mcpDot').className === 'mcp-dot live', '有 1 个会话时状态点为蓝');
  check(mcpEl('mcpBtn').title.indexOf('1 个会话') > 0, '图标提示带会话数');
  check(mcpEl('mcpDot').className === mcpEl('mcpModalDot').className, '图标与弹窗的状态点一致');

  // 处理中：按钮禁用 + 提示"处理中…"（挡住连点发两条相反的 IPC）
  sbMcp._mcpBusy = true;
  sbMcp.renderMcpStatus({ running: true, host: '127.0.0.1', port: 7777, sessions: 0, version: '0.9.9', toolCount: 4, requests: 0, dropped: 0 });
  check(mcpEl('mcpToggleBtn').disabled === true, '命令进行中按钮禁用');
  check(mcpEl('mcpToggleHint').textContent === '处理中…', '命令进行中提示"处理中…"');
  sbMcp._mcpBusy = false;

  // 启动失败要把原因显示出来（否则用户只看到一个红点不知道怎么修）
  sbMcp.renderMcpStatus({ running: false, lastError: '端口全被占用' });
  check(mcpEl('mcpError').style.display === 'block' && mcpEl('mcpError').textContent.indexOf('端口全被占用') > 0,
    '启动失败原因可见');

  console.log('\n【MCP 控件注册表与界面桥（S4 / S5）】');

  // 选择器必须覆盖所有"可交互载体"，否则会漏掉控件
  check(/button, input, select, textarea, \[onclick\], \[role="tab"\]/.test(html),
    'MCP_SELECTOR 覆盖 button/input/select/textarea/[onclick]/[role=tab]');

  function extractVarObject(name) {
    const marker = 'var ' + name + ' = {';
    const i = html.indexOf(marker);
    if (i < 0) throw new Error('not found: ' + name);
    const j = html.indexOf('\n};', i);
    return html.slice(i, j + 3);
  }

  // ---- 假 DOM：够跑注册表与读写 ----
  const mcpFakeEl = (tag, attrs) => {
    attrs = attrs || {};
    const el = {
      tagName: String(tag).toUpperCase(),
      id: attrs.id || '',
      className: attrs.class || '',
      parentNode: null,
      children: [],
      attrs: Object.assign({}, attrs),
      style: {},
      disabled: !!attrs.disabled,
      checked: !!attrs.checked,
      value: attrs.value === undefined ? '' : attrs.value,
      _opts: [],
      _clicks: 0,
      onclick: null,
      getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
      setAttribute(k, v) { this.attrs[k] = v; },
      classList: (() => {
        const s = new Set(String(attrs.class || '').split(/\s+/).filter(Boolean));
        return {
          contains: (c) => s.has(c),
          add: (c) => s.add(c),
          remove: (c) => s.delete(c),
          toggle: (c) => { if (s.has(c)) s.delete(c); else s.add(c); },
          _s: s,
        };
      })(),
      querySelectorAll(sel) { return sel === '.sel-opt' ? this._opts : []; },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      dispatchEvent() { return true; },
      // 模拟真实 DOM：checkbox/radio 被点击时自己翻转（否则测不出"值没变就不重复点"）
      click() {
        this._clicks++;
        if (this.tagName === 'INPUT' && (this.attrs.type === 'checkbox' || this.attrs.type === 'radio')) {
          this.checked = !this.checked;
        }
        if (this.onclick) this.onclick();
      },
    };
    return el;
  };

  const pane = mcpFakeEl('div', { id: 'paneContainer' });
  // 自定义下拉：#main-portSelect，内部两个选项；点选项时模拟真实行为（更新 data-val）
  const portSel = mcpFakeEl('div', { id: 'main-portSelect', class: 'sel', 'data-val': 'COM1' });
  const optCOM3 = mcpFakeEl('div', { class: 'sel-opt', 'data-val': 'COM3' });
  optCOM3.onclick = () => { portSel.setAttribute('data-val', 'COM3'); };
  portSel._opts = [optCOM3];
  const btnStart = mcpFakeEl('button', { id: 'main-btnStart', title: '开始/停止' });
  const baud = mcpFakeEl('input', { id: 'main-baudRate', type: 'number', value: '115200' });
  const chk = mcpFakeEl('input', { id: 'main-chkDTR', type: 'checkbox', checked: false });
  const iBtn = mcpFakeEl('button', { id: 'main-btnTs', class: 'ibtn' });
  // 模拟真实的 toggleIbtn(this)：点击就是翻转 on 类
  iBtn.onclick = () => { iBtn.classList.toggle('on'); };
  const globalBar = mcpFakeEl('div', { id: 'globalBar' });
  const themeSwitch = mcpFakeEl('span', { id: 'themeSwitch', onclick: 'toggleTheme()' });
  const noIdBtn = mcpFakeEl('button', { onclick: 'clearLog("main")' });
  const nativeSel = mcpFakeEl('select', { id: 'extra-1-viewMode' });
  [portSel, btnStart, baud, chk, iBtn].forEach((e) => pane.appendChild(e));
  [themeSwitch, noIdBtn].forEach((e) => globalBar.appendChild(e));
  const mcpNodes = [portSel, btnStart, baud, chk, iBtn, themeSwitch, noIdBtn, nativeSel];

  const sbReg = {
    console,
    document: { querySelectorAll: () => mcpNodes },
    scheduleConfigSave() {},
    invoke() { return Promise.resolve({}); },
    showToast() {},
  };
  vm.createContext(sbReg);
  vm.runInContext([
    "var MCP_REGISTRY = {}; var MCP_REGISTRY_LIST = []; var _mcpRegistrySig = -1; var _mcpUiOrigin = 0;",
    extractVarObject('MCP_GROUP_BY_FIELD'),
    /var MCP_SELECTOR = '[^']+';/.exec(html)[0],
    ...['mcpSlug', 'mcpPanelOfMid', 'mcpPanelOfNode', 'mcpGroupOfField', 'mcpJoinPath',
        'mcpKindOf', 'mcpReadEl', '_mcpDispatch', '_mcpFindOption', 'mcpWriteEl',
        'mcpElEnabled', 'mcpDisabledReason', 'mcpEntryFor', 'mcpBuildRegistry',
        'mcpEnsureRegistry', 'mcpInputSchemaFor', 'mcpEntryPublic', 'mcpHandleUiCmd',
        'mcpNotifyState'].map(extractFunction),
  ].join('\n'), sbReg);

  // ---- 纯函数：路径派生 ----
  check(sbReg.mcpSlug('port-Select!') === 'port_Select', 'mcpSlug 清洗非字母数字', sbReg.mcpSlug('port-Select!'));
  check(sbReg.mcpSlug('') === 'x', 'mcpSlug 空串有兜底');
  check(sbReg.mcpPanelOfMid('main') === 'serial' && sbReg.mcpPanelOfMid('extra-3') === 'serial',
    'main/extra-N 归串口面板');
  check(sbReg.mcpPanelOfMid('wsl') === 'wsl' && sbReg.mcpPanelOfMid('wsl-x2') === 'wsl', 'wsl/wsl-xN 归 WSL');
  check(sbReg.mcpPanelOfMid('ble-mon') === 'ble', 'ble-mon 归蓝牙');
  check(sbReg.mcpPanelOfMid('') === 'global', '空 mid 归全局');
  check(sbReg.mcpGroupOfField('portSelect') === 'conn' && sbReg.mcpGroupOfField('btnStart') === 'conn',
    '连接类字段归 conn');
  check(sbReg.mcpGroupOfField('btnSend') === 'send', 'btnSend 归 send');
  check(sbReg.mcpGroupOfField('btnTs') === 'toolbar', '其余 btn* 归 toolbar');
  check(sbReg.mcpGroupOfField('qcmd3') === 'adv', 'qcmd* 归 adv');
  check(sbReg.mcpGroupOfField('whatever') === 'misc', '认不出的归 misc');
  check(sbReg.mcpJoinPath('serial', 'conn', 'portSelect') === 'serial.conn.portSelect', '路径拼接');

  // ---- 控件类型识别 ----
  check(sbReg.mcpKindOf(portSel) === 'select', '带 .sel 类的 div 视为 select');
  check(sbReg.mcpKindOf(nativeSel) === 'select', '原生 select');
  check(sbReg.mcpKindOf(chk) === 'checkbox', 'checkbox');
  check(sbReg.mcpKindOf(baud) === 'number', 'number');
  check(sbReg.mcpKindOf(iBtn) === 'toggle', '.ibtn 视为 toggle');
  check(sbReg.mcpKindOf(btnStart) === 'button', '普通 button');

  // ---- 读写往返：写回的必须是"写后的真实值" ----
  sbReg.mcpWriteEl(portSel, 'select', 'COM3');
  check(portSel.getAttribute('data-val') === 'COM3', '自定义下拉：写值点中了对应选项');
  check(sbReg.mcpReadEl(portSel, 'select') === 'COM3', '读回写入的值');
  sbReg.mcpWriteEl(baud, 'number', 9600);
  check(sbReg.mcpReadEl(baud, 'number') === '9600', '数字输入写后读回字符串形式的真实值');
  sbReg.mcpWriteEl(chk, 'checkbox', true);
  check(chk.checked === true, 'checkbox 由合成 click 打开');
  sbReg.mcpWriteEl(chk, 'checkbox', true);
  check(chk._clicks === 1, '值没变就不重复点（避免无意义的状态抖动）');
  sbReg.mcpWriteEl(iBtn, 'toggle', true);
  check(iBtn.classList.contains('on'), 'toggle 写 true 后加上 on 类');
  sbReg.mcpWriteEl(btnStart, 'button', true);
  check(btnStart._clicks === 1, '按钮写值 = 点一次');

  // ---- 注册表构建：路径 + data-mcp 注入 + 唯一性 ----
  const total = sbReg.mcpBuildRegistry();
  check(total === mcpNodes.length, '每个可交互元素都进了注册表', total);
  check(!!sbReg.MCP_REGISTRY['serial.conn.portSelect'], 'main-portSelect → serial.conn.portSelect');
  check(!!sbReg.MCP_REGISTRY['serial.conn.btnStart'], 'main-btnStart → serial.conn.btnStart');
  check(!!sbReg.MCP_REGISTRY['serial.conn.baudRate'], 'main-baudRate → serial.conn.baudRate');
  check(!!sbReg.MCP_REGISTRY['serial.conn.chkDTR'], 'main-chkDTR → serial.conn.chkDTR');
  check(!!sbReg.MCP_REGISTRY['serial.toolbar.btnTs'], 'main-btnTs → serial.toolbar.btnTs');
  check(!!sbReg.MCP_REGISTRY['global.ui.themeSwitch'], 'themeSwitch → global.ui.themeSwitch');
  check(!!sbReg.MCP_REGISTRY['serial.conn.viewMode'], 'extra-N 是串口监视器 → serial.conn.viewMode');
  const uniq = Object.keys(sbReg.MCP_REGISTRY).length;
  check(uniq === mcpNodes.length, '路径唯一（撞了就加序号）', uniq);
  check(portSel.getAttribute('data-mcp') === 'serial.conn.portSelect',
    'data-mcp 属性已注入（这是唯一锚点）', portSel.getAttribute('data-mcp'));
  const noIdPath = noIdBtn.getAttribute('data-mcp');
  check(!!noIdPath && noIdPath.indexOf('global.') === 0,
    '没有 id 的控件也有稳定路径（靠面板+标签+文档序兜底）', noIdPath);

  // ---- 禁用原因要能说清楚（AI 最需要这个）----
  const disBtn = mcpFakeEl('button', { id: 'main-btnX', disabled: true });
  sbReg.MCP_REGISTRY['serial.misc.btnX'] = sbReg.mcpEntryFor(
    Object.assign(disBtn, { getAttribute: disBtn.getAttribute.bind(disBtn) }), 99);
  check(sbReg.mcpDisabledReason(disBtn) !== null, '被禁用的控件能给出原因');

  // ---- ui 命令处理 ----
  const all = sbReg.mcpHandleUiCmd('list', {});
  check(all.ok === true && all.value.total === mcpNodes.length, 'ui_list 返回全部', JSON.stringify(all.value && all.value.total));
  const onlySerial = sbReg.mcpHandleUiCmd('list', { panel: 'serial' });
  check(onlySerial.value.controls.every((c) => c.panel === 'serial'), 'ui_list 能按面板过滤');
  const q = sbReg.mcpHandleUiCmd('list', { query: 'baud' });
  check(q.value.total === 1 && q.value.controls[0].path.indexOf('baudRate') > 0,
    'ui_list 能按关键字过滤', JSON.stringify(q.value.controls.map((c) => c.path)));
  const page1 = sbReg.mcpHandleUiCmd('list', { limit: 2 });
  check(page1.value.controls.length === 2 && !!page1.value.nextCursor, 'ui_list 分页给出 nextCursor');
  const page2 = sbReg.mcpHandleUiCmd('list', { limit: 2, cursor: page1.value.nextCursor });
  check(page2.value.controls[0].path !== page1.value.controls[0].path, '第二页与第一页不重复');

  const desc = sbReg.mcpHandleUiCmd('describe', { path: 'serial.conn.portSelect' });
  check(desc.ok === true && desc.value.inputSchema, 'ui_describe 返回输入格式');
  check(Array.isArray(desc.value.inputSchema.properties.value.enum)
     && desc.value.inputSchema.properties.value.enum.indexOf('COM3') >= 0,
    '下拉的可选值作为 enum 暴露（AI 不用猜）',
    JSON.stringify(desc.value.inputSchema.properties.value));

  const g = sbReg.mcpHandleUiCmd('get', { path: 'serial.conn.baudRate' });
  check(g.ok === true && g.value.value === '9600', 'ui_get 读实时值', JSON.stringify(g.value));

  const nf = sbReg.mcpHandleUiCmd('get', { path: 'no.such.control' });
  check(nf.ok === false && nf.notFound === true,
    '找不到控件时带 notFound 标记（后端据此返回协议级 -32602）', JSON.stringify(nf));

  // 先把值改回去，确保这次 set 真的产生差异（前面"读写往返"把夹具改成了 COM3）
  portSel.setAttribute('data-val', 'COM1');
  const setRes = sbReg.mcpHandleUiCmd('set', { path: 'serial.conn.portSelect', value: 'COM3' });
  check(setRes.ok === true && setRes.value.effects.length === 1, 'ui_set 记录前后值差异',
    JSON.stringify(setRes.value.effects));
  check(setRes.value.results[0].ok === true && setRes.value.results[0].value === 'COM3',
    'ui_set 返回写后的真实值', JSON.stringify(setRes.value.results[0]));

  // 单目标失败 = **整次调用失败**：只给一个 path 却回 ok:true，调用方会以为点成功了
  const disSet = sbReg.mcpHandleUiCmd('set', { path: 'serial.misc.btnX', value: 'x' });
  check(disSet.ok === false && !!disSet.disabledReason,
    '单目标操作被禁用 → 整次调用失败并给出原因（而不是顶层 ok:true）',
    JSON.stringify(disSet));

  const singleNf = sbReg.mcpHandleUiCmd('click', { path: 'no.such.control' });
  check(singleNf.ok === false && singleNf.notFound === true,
    '单目标点了不存在的控件 → ok:false + notFound（→ 协议级 -32602，而不是 -32006）',
    JSON.stringify(singleNf));

  const batch = sbReg.mcpHandleUiCmd('set', { items: [
    { path: 'serial.conn.baudRate', value: 57600 },
    { path: 'no.such.control', value: 1 },
  ] });
  check(batch.ok === true && batch.value.results.length === 2 && batch.value.results[0].ok === true && batch.value.results[1].ok === false,
    '多目标才是批量语义：调用本身成功、逐条返回成败（一条失败不影响其它）', JSON.stringify(batch.value.results));

  // 回执管道：两端各自的单测都绿过，中间这段没人管 —— 于是 notFound 在真机上一次都没传到后端
  // （2026-09 独立一致性检查发现：所有"路径/取值不存在"都退化成了 -32006）。
  check(/notFound: !!\(res && res\.notFound\)/.test(html) && /invalidParams: !!\(res && res\.invalidParams\)/.test(html),
    'mcp_ui_ack 回执必须回传 notFound / invalidParams（丢了它们，-32602 那条映射就是死代码）');
  check(/fn ui_ack_payload\(/.test(mcpSrc) && /"notFound": not_found/.test(mcpSrc) && /"invalidParams": invalid_params/.test(mcpSrc),
    '后端 ack 侧确实有这两个字段，且与前端字段名一致');

  check(sbReg.mcpHandleUiCmd('bogus', {}).ok === false, '未知 ui 操作明确失败');

  console.log('\n【MCP 日志中心（S7）】');

  // 源码：生产端旁路点（设计原则是"在生产处复制"，而不是去抢前端轮询的队列）
  check(/loghub::hub\(\)\s*\.push\(\s*"app"/.test(mainRs), 'dbg_log 旁路进 app 通道');
  check(/loghub::hub\(\)\s*\.push\(\s*"error"/.test(mainRs), 'report_error 旁路进 error 通道');
  check(/"ble:rx"/.test(mainRs), 'BLE 通知循环旁路进 ble:rx（生产端复制，不抢队列）');
  check(/fn log_push_batch\(/.test(mcpSrc) && /mcp::log_push_batch,/.test(mainRs),
    '后端有并注册了 log_push_batch');
  check(/invoke\('log_push_batch'/.test(html), '前端回灌调用后端');
  // 「MCP 不能影响主程序」落到代码上 = 外部输入必须有界，且校验必须在**碰主程序之前**。
  // 用 mcpSrc 而不是 mcpProd：protocol.rs 的 cfg(test) 截断点落在**常量声明之后、分派之前**，
  // 所以"常量 + 分派"跨不过去（这不是要测测试代码，是截断点的限制）。
  check(/pub const MAX_UI_SET_ITEMS: usize = 200;/.test(mcpSrc)
    && /n > MAX_UI_SET_ITEMS[\s\S]{0,900}?core\.ui_call\("set", payload\)/.test(mcpSrc),
    'ui_set.items 有上限，且在**下发到界面之前**就被挡住（那条链路跑在 WebView 主线程上）');
  check(/pub const MAX_SEND_CHARS: usize = 64 \* 1024;/.test(mcpSrc)
    && /chars\(\)\.count\(\) > MAX_SEND_CHARS/.test(mcpSrc),
    'serial_send.data 有上限（串口写队列不能被一次灌满）');
  check(/maxUiSetItems/.test(mcpSrc) && /maxSendChars/.test(mcpSrc),
    '两条上限都在 mcp_limits 里对客户端公开（不让人靠撞墙发现）');
  check(/mcpLogPush\(mcpCh/.test(html), 'bufferPush 里接了回灌（所有输出行的唯一漏斗）');
  // 通道名规则**只允许有一处**（mcpSerialLogChannels）：写侧（bufferPush）与读侧
  // （serial_get_output 拿 mcpSerialState 里的 logChannels）必须用同一套名字。
  check(/function mcpSerialLogChannels\(mid\)[\s\S]{0,220}?\(m\.isWsl \? 'wsl:' : 'serial:'\) \+ mid/.test(html),
    '通道名按 WSL/串口 + 收发方向区分，且只在这一处拼');
  check(/'ui:err' : 'ui:sys'/.test(html), '界面系统提示进 ui:sys / ui:err 通道');
  check(/var _mcpLogBatchMax = 200;/.test(html) && /var _mcpLogQueueMax = 2000;/.test(html),
    '回灌有"单批 + 队列"双上限');
  check(/_mcpLogFlushMs = 200/.test(html), '回灌节流 200ms（避免高频串口把 IPC 打爆）');

  // 源码：日志工具与硬约束
  ['log_channels', 'log_tail', 'log_search', 'log_stats', 'log_clear', 'log_export'].forEach((t) => {
    check(new RegExp('"name": "' + t + '"').test(mcpSrc), '日志工具已定义 ' + t);
  });
  check(/fn drop_all/.test(mcpSrc), '停用时真正释放通道，而不是只清空内容');
  // 全局内存兜底必须**被执行**，不能只是报告值（`log_stats` 里的 totalCapBytes 曾是空头承诺）
  check(/pub const TOTAL_CAP_BYTES/.test(mcpSrc) && /pub const MAX_CHANNELS/.test(mcpSrc),
    '有全局字节上限与通道数上限两个常量');
  check(/fn reclaim\(/.test(mcpSrc) && /if self\.total_bytes\.load\(Ordering::Relaxed\) > TOTAL_CAP_BYTES/.test(mcpSrc),
    'push 超全局预算时真的触发回收（不是只把数字报出去）');
  check(/fn handle_capped\(/.test(mcpSrc) && /if map\.len\(\) >= MAX_CHANNELS/.test(mcpSrc),
    '通道表本身也有上限（通道名是动态的，开多个监视器就多几个通道）');
  check(/try_lock\(\)[\s\S]{0,600}?MAX_RECLAIM_PER_CALL/.test(mcpSrc),
    '回收用 try_lock 且单次只动固定几个通道（有界代价，不拖累生产者）');
  check(/channel_skips/.test(mcpSrc) && /reclaims/.test(mcpSrc),
    '两种新的丢弃/回收计数都被暴露出来（丢了多少要能查）');
  check(/fn global_budget_is_enforced_across_channels/.test(mcpSrc)
    && /fn channel_count_is_capped_and_skips_are_counted/.test(mcpSrc)
    && /fn reclaim_never_blocks_the_producer/.test(mcpSrc),
    '三条内存兜底单测都在（全局预算 / 通道封顶 / 回收不阻塞）');
  check(/fn cap_for\(/.test(mcpSrc) && /512 \* 1024/.test(mcpSrc), '每通道有字节上限表');
  check(/try_lock\(\)/.test(mcpSrc) && /lock_skips/.test(mcpSrc),
    '写入用 try_lock：拿不到锁就丢弃并计数（绝不阻塞生产者）');
  check(/MAX_LINE_BYTES/.test(mcpSrc) && /被截断/.test(mcpSrc), '单条日志会截断并留标记');
  check(/OVERHEAD_PER_LINE/.test(mcpSrc), '字节统计含每行固定开销（否则上限形同虚设）');
  check(/enabled: AtomicBool::new\(false\)/.test(mcpSrc), '默认关闭：MCP 停用时零成本');
  check(/since_seq/.test(mcpSrc), '支持按 seq 增量拉取日志');

  // 行为：批量与上限
  const logCalls = [];
  const logTimers = [];
  const sbHub = {
    console,
    invoke(cmd, args) { logCalls.push({ cmd: cmd, args: args }); return Promise.resolve(0); },
    setTimeout(fn) { logTimers.push(fn); return logTimers.length; },
    clearTimeout() {},
  };
  vm.createContext(sbHub);
  vm.runInContext([
    'var _mcpLogPending = []; var _mcpLogTimer = null; var _mcpLogFlushMs = 200;',
    'var _mcpLogBatchMax = 200; var _mcpLogQueueMax = 2000;',
    extractFunction('mcpLogSchedule'),
    extractFunction('mcpLogFlush'),
    extractFunction('mcpLogPush'),
  ].join('\n'), sbHub);

  sbHub.mcpLogPush('serial:main:rx', 'info', 'rx', 'AT', 2);
  sbHub.mcpLogPush('serial:main:rx', 'info', 'rx', 'OK', 2);
  check(logCalls.length === 0, '未到冲刷窗口时不发送（批量而不是逐行）');
  logTimers[0]();
  check(logCalls.length === 1 && logCalls[0].cmd === 'log_push_batch', '到点后一次性发出');
  check(logCalls[0].args.lines.length === 2, '一批带走两行', logCalls[0].args.lines.length);
  check(logCalls[0].args.lines[0].channel === 'serial:main:rx' && logCalls[0].args.lines[0].dir === 'rx',
    '通道与方向确实带上了');

  logCalls.length = 0;
  for (let i = 0; i < 2500; i++) sbHub.mcpLogPush('ui:sys', 'info', 'none', 'l' + i, 1);
  check(sbHub._mcpLogPending.length === 2000, '待发队列有硬上限（防无界堆积）', sbHub._mcpLogPending.length);
  sbHub.mcpLogFlush();
  check(logCalls[0].args.lines.length === 200, '单批上限 200', logCalls[0].args.lines.length);
  check(logCalls[0].args.lines[199].text === 'l2499', '超限时丢最旧、保留最新',
    logCalls[0].args.lines[199].text);

  console.log('\n【MCP AI 调用记录与配置（S8）】');

  check(/CALL_LOG_FILE: &str = "ai-calls\.jsonl"/.test(mcpSrc), '调用记录写独立文件 ai-calls.jsonl');
  // 只看非注释的代码行：注释里写"与用户配置 config.json 严格隔离"正是我们想要的说明，
  // 要拦的是**代码里真的去碰它**。
  const mcpProdCode = mcpProd
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join('\n');
  // 注意不能写成 /config\.json/ —— 那会命中我们自己的 `ai-config.json`。
  // 真正要拦的是"独立的 config.json"（前面不是 - 或标识符字符）。
  check(!/(^|[^a-zA-Z0-9_-])config\.json/.test(mcpProdCode),
    'MCP 生产代码里不出现独立的 config.json（S8 的核心约束）');
  check(/fn rotate\(/.test(mcpSrc) && /rotate_keep/.test(mcpSrc), '记录文件按大小轮转且保留份数有界');
  check(/READ_TAIL_BYTES/.test(mcpSrc), '查询只读文件尾部窗口（不把整个文件读进内存）');
  check(/#\[serde\(rename_all = "camelCase"\)\]/.test(mcpSrc),
    '记录设置用 camelCase（与工具入参一致）');
  check(/#\[serde\(rename = "maxFileMiB"\)\]/.test(mcpSrc),
    'maxFileMiB 显式重命名（serde 的 camelCase 会写成 maxFileMib，导致"写出去的名字读不回来"）');
  check(/fn fit\(/.test(mcpSrc) && /_truncated/.test(mcpSrc), '超长入参截断并留标记');
  check(/include_results: false/.test(mcpSrc), '默认不记返回值（可能很大或含敏感内容）');

  // 记录器的挂载点：每一次工具调用（含协议级失败）
  check(/core\.calllog\.record\(/.test(mcpSrc), '工具调用漏斗里调用了记录');
  check(/\(missing-name\)/.test(mcpSrc), '连"缺少 name"这种协议级失败也要记');
  check(/let effects = result_val/.test(mcpSrc), '把 ui_set 的 effects 单独提出来（事后能查 AI 改了什么）');
  check(/fn handle_raw_with_session/.test(mcpSrc), '协议层带会话 id（记录要能查明是谁调的）');
  check(/handle_raw_(with_session|guarded)\(core, &text, &sid\)/.test(mcpSrc), '传输层把真实 sessionId 传下去');
  check(/fn apply_config_patch_with\(/.test(mcpSrc), '写盘动作可注入（单测不碰用户真实配置）');
  check(/不接受通过工具修改 token/.test(mcpSrc), '工具不能改 token（必须走界面重置）');
  check(/只允许监听回环地址/.test(mcpSrc), '不允许通过工具把服务器暴露到局域网');
  check(/need_restart/.test(mcpSrc) && /重新启用 MCP 服务器/.test(mcpSrc),
    '改 server.* 只保存不重启（否则会掐断正在回话的这次调用）');
  check(/tokenMasked/.test(mcpSrc) && /config_summary/.test(mcpSrc),
    '配置摘要里 token 只回打码值');

  ['mcp_calls', 'mcp_stats', 'mcp_config_get', 'mcp_config_set'].forEach((t) => {
    check(new RegExp('"name": "' + t + '"').test(mcpSrc), '工具已定义 ' + t);
  });
  check(/"callLog": self\.calllog\.stats\(\)/.test(mcpSrc), '状态里带调用记录概览（界面/工具都能看）');

  // 配置文件的名字必须与"用户配置"彻底分开
  check(/pub struct AiConfig/.test(mcpSrc) && /pub call_log/.test(mcpSrc), 'AI 配置含 callLog 段');
  check(/serde\(default, rename = "callLog"\)/.test(mcpSrc),
    'callLog 段缺省可升级（老 ai-config.json 不会因为少字段而失效）');

  console.log('\n【MCP 全量控件工具（S6）】');

  // 前后端契约：前端上报注册表
  check(/fn mcp_report_registry\(/.test(mcpSrc) && /mcp::mcp_report_registry,/.test(mainRs),
    '后端有并注册了 mcp_report_registry');
  check(/invoke\('mcp_report_registry'/.test(html), '前端会调用上报');
  check(/function mcpReportRegistry\(/.test(html) && /_mcpRegistryReported/.test(html),
    '上报带签名去重（面板渲染会反复重建注册表，不能每次都发）');
  check(/_mcpReportTimer\) return/.test(html) && /\}, 300\)/.test(html), '上报 300ms 合并');
  check(/mcpBuildRegistry\(\);\s*mcpReportRegistry\(\)/.test(html),
    '重建注册表后紧接着上报');
  check(/mcpEnsureRegistry\(true\)/.test(html), '启动时强制采集并上报一次');
  check(/function mcpEnumValuesFor\(/.test(html) && /options: mcpEnumValuesFor\(e\)/.test(html),
    '下拉的可选值随注册表一起上报（AI 才不用猜）');

  // 后端：命名 / schema / 上限 / 门控
  check(/pub fn tool_name_for\(/.test(mcpSrc) && /"ctl_"/.test(mcpSrc),
    '控件工具名以 ctl_ 开头（客户端不允许工具名带点号）');
  check(/MAX_TOOL_NAME_LEN: usize = 64/.test(mcpSrc) && /NAME_BUDGET/.test(mcpSrc),
    '工具名有 64 字符上限并留出加序号的余量');
  check(/while used\.contains\(&n\)/.test(mcpSrc), '清洗后撞名要加序号保证唯一');
  check(/pub fn schema_for\(/.test(mcpSrc) && /"enum": options/.test(mcpSrc),
    '入参 schema 按控件类型派生（下拉给 enum）');
  check(/pub const MAX_CTL_TOOLS: usize = 400/.test(mcpSrc),
    '生成数量有上限（工具列表要进模型上下文，不能无限）');
  check(/pub fn exposed_tools\(/.test(mcpSrc), '有统一的 exposed_tools（三处口径一致）');
  check(/let all = exposed_tools\(core\)/.test(mcpSrc), 'tools/list 用 exposed_tools');
  check(/n if n\.starts_with\("ctl_"\)/.test(mcpSrc), 'ctl_* 调用解析回控件路径走同一条界面桥');
  check(/path_for_tool\(n\)/.test(mcpSrc) && /界面可能已经变了/.test(mcpSrc),
    '未知控件工具要给可执行的下一步');
  // Rust 里字段是 snake_case、默认 false；JSON 表面（rename_all=camelCase）才是 autoControlTools
  check(/auto_control_tools: false/.test(mcpSrc) && /autoControlTools/.test(mcpSrc),
    '全量控件工具默认关闭（§5.6 D2 的取舍）');
  check(/未知面板名/.test(mcpSrc), '命名空间打错字要报错（否则"工具全没了"却查不出原因）');

  // ui_get_state
  check(/"name": "ui_get_state"/.test(mcpSrc), '有 ui_get_state 工具');
  check(/op === 'getState'/.test(html) && /collectConfig\(\)/.test(html),
    'ui_get_state 复用 collectConfig（与持久化同一份真源）');
  check(/sec === 'serial' \|\| sec === 'wsl'/.test(html), 'section 能按面板切出子树');

  // 行为：签名去重与 enum 采集
  const repCalls = [];
  const repTimers = [];
  const regEl = {
    kind: 'select', el: null,
  };
  const sbRep = {
    console,
    invoke(cmd, args) { repCalls.push({ cmd: cmd, args: args }); return Promise.resolve({}); },
    setTimeout(fn) { repTimers.push(fn); return repTimers.length; },
    _mcpRegistryReported: '', _mcpReportTimer: null,
    MCP_REGISTRY_LIST: [],
  };
  vm.createContext(sbRep);
  // 造两个假条目：一个下拉（有选项）、一个按钮
  const optEl = {
    _opts: [
      { getAttribute: (k) => (k === 'data-val' ? 'COM1' : null) },
      { getAttribute: (k) => (k === 'data-val' ? 'COM3' : null) },
    ],
    querySelectorAll(sel) { return sel === '.sel-opt' ? this._opts : []; },
  };
  sbRep.MCP_REGISTRY_LIST = [
    { path: 'serial.conn.portSelect', kind: 'select', label: '端口', panel: 'serial', group: 'conn',
      el: optEl, enabled: () => true, disabledReason: () => null },
    { path: 'serial.toolbar.btnSend', kind: 'button', label: '发送', panel: 'serial', group: 'toolbar',
      el: null, enabled: () => false, disabledReason: () => '串口未连接' },
  ];
  vm.runInContext([
    extractFunction('mcpEnumValuesFor'),
    extractFunction('mcpReportRegistry'),
  ].join('\n'), sbRep);

  sbRep.mcpReportRegistry();
  check(repCalls.length === 0, '上报也走合并窗口（不立刻发）');
  repTimers[0]();
  check(repCalls.length === 1 && repCalls[0].cmd === 'mcp_report_registry', '合并到点后发一次');
  const sent = repCalls[0].args.entries;
  check(sent.length === 2, '两条都上报', sent.length);
  check(JSON.stringify(sent[0].options) === '["COM1","COM3"]',
    '下拉选项被采成 enum', JSON.stringify(sent[0].options));
  check(sent[1].enabled === false && sent[1].disabledReason === '串口未连接',
    '不可用状态与原因一起上报（AI 才不会盲试）');
  check(sent[1].options.length === 0, '非下拉控件不带 options');

  // 同样内容再报一次：应被签名挡掉
  repTimers.length = 0;
  sbRep.mcpReportRegistry();
  repTimers[0]();
  check(repCalls.length === 1, '内容没变就不重复上报（省 IPC）');

  // 内容变了要重报
  sbRep.MCP_REGISTRY_LIST[1].enabled = () => true;
  repTimers.length = 0;
  sbRep.mcpReportRegistry();
  repTimers[0]();
  check(repCalls.length === 2, '可用状态变了要重报（工具列表会跟着变）');

  console.log('\n【MCP 运行期错误 → 错误上报（S11）】');

  // 以前 MCP 出问题只写本地日志，用户报障时我们既看不到、也不知道发生过多少次。
  // 现在接进程序既有的 report_error（LogHub + 本地日志 + Sentry + 自建服务/SQLite）。
  check(/pub mod report;/.test(mcpSrc), '有 report 模块');
  check(/fn report\(kind: &str, detail: &str\)/.test(mcpSrc) && /crate::report_error\(/.test(mcpSrc),
    'MCP 错误走的是程序既有的 report_error（换新通道就是两套上报，迟早分叉）');
  check(/fn report_with\(/.test(mcpSrc), '上报入口可注入（单测不碰网络/文件）');
  check(/DEDUP_WINDOW_SECS: u64 = 300/.test(mcpSrc) && /fn should_report\(/.test(mcpSrc),
    '同类错误 5 分钟内只上报一次（服务端去重是最后一道闸，不能靠它兜客户端刷屏）');
  check(/MAX_TRACKED: usize = 64/.test(mcpSrc), '去重表有上限（错误消息带变量时不会无限增长）');
  check(/fn sanitize\(/ && /token=\*\*\*\*/.test(mcpSrc), '上报前把 token=… 打码');
  check(/fn remember_secret\(/ && /report::remember_secret\(&token\)/.test(mcpSrc),
    '启动时把当前令牌登记为敏感串（连裸 token 也不会漏进错误库）');
  check(/fn panic_message\(/ && /fn guard</.test(mcpSrc), '有 panic 兜底工具函数');
  // 关键：文档一直写着"分派边界有 catch_unwind 兜底"，但 2026-09 核对时**全 crate 都没有**。
  // 现在真的有了，断言把它钉住，别让文档再次变成空话。
  check(/std::panic::catch_unwind\(f\)/.test(mcpSrc), 'catch_unwind 真的存在（不是只写在文档里）');
  check(/pub async fn handle_raw_guarded\(/.test(mcpSrc)
    && /futures::FutureExt::catch_unwind\(fut\)/.test(mcpSrc),
    '分派入口有 panic 兜底：panic → JSON-RPC 错误 + 上报，而不是把连接静默打死');
  check(/handle_raw_guarded\(core, &text, &sid\)/.test(mcpSrc),
    '传输层走的是带兜底的入口（别再退回不兜底的那个）');
  check(/E_INTERNAL, format!\("服务器内部错误（已上报）/.test(mcpSrc),
    'panic 转成的错误里告诉调用方"已上报"（否则用户不知道该不该反馈）');
  // 会话回收：客户端断开必须**立刻**回收，不能干等 30 分钟空闲超时 ——
  // 否则客户端重启/重连 4 次就把 MAX_SESSIONS 占满，之后所有连接吃 429
  // （官方 Python SDK 一致性检查在真机上抓到的真问题，见 §17 最新记录）
  check(/struct SseBody/.test(mcpSrc) && /impl Drop for SseBody/.test(mcpSrc),
    'SSE 响应体带 Drop 守卫：流被丢弃（= 客户端断开）时回收会话');
  check(/fn sse_response\(core: Arc<McpCore>, sid: String/.test(mcpSrc),
    'sse_response 拿得到 core 与 sid（否则守卫无从回收）');
  check(/sse_response\(core\.clone\(\), id\.clone\(\), rx\)/.test(mcpSrc), '调用点把两个都传进去了');
  check(/fn session_is_reclaimed_as_soon_as_the_client_disconnects/.test(mcpSrc),
    '有"连断 6 次、每次都要立刻回收"的回归测试');

  // 用户可读的工具参考文档必须与源码同步：doc/MCP_TOOLS.md 里得列出**全部**内置工具名。
  // （文档由 .walkthrough/gen_mcp_tools_doc.js 从 protocol.rs 生成，这里只防"加了工具忘了重跑"）
  {
    const toolsDoc = fs.readFileSync(path.join(root, 'doc', 'MCP_TOOLS.md'), 'utf8');
    const srcTools = [...new Set(
      // 用带捕获组的 matchAll 一次拿干净；上一版先 match 再 exec，每次都抓到 "name" 这个键名
      // 只扫 tool_defs() 函数体（到第一个 "    ]" 为止）。上一版扫到 limits_json()，
      // 把中间的 call_tool 函数体也包含进来了 —— 那里的 {"name": "port"} 会被误当成工具名。
      [...mcpSrc.slice(mcpSrc.indexOf('pub fn tool_defs()'),
                       mcpSrc.indexOf('\n    ]', mcpSrc.indexOf('pub fn tool_defs()')))
        .matchAll(/"name":\s*"([a-z][a-z0-9_]*)"/g)].map((m) => m[1])
    )];
    check(srcTools.length === 33, '源码里是 33 个内置工具（20 通用 + 13 串口语义）', srcTools.length);
    const missing = srcTools.filter((n) => toolsDoc.indexOf('#### `' + n + '`') < 0);
    check(missing.length === 0, '工具参考文档 doc/MCP_TOOLS.md 列出了全部内置工具', '缺：' + missing.join(','));
    check((toolsDoc.match(/^#### `/gm) || []).length === srcTools.length,
      '文档里的工具小节数 == 工具数（没有多余/重复）');
    check(/只有 SSE/.test(toolsDoc) && /-32602/.test(toolsDoc),
      '文档写清了传输（只有 SSE）与错误码语义');

    // ---- 跨边界：**后端会发的每个 op/action，前端都必须有分支** ----
    // 这类不一致最阴：后端发出去了、前端回一句"未知的 serial 操作"，工具就静默失败，
    // 而两边各自的单测都是绿的（各自测自己那一半）。
    const uiOps = [...new Set([...mcpProd.matchAll(/core\.ui_call\("([a-zA-Z]+)"/g)].map((m) => m[1]))];
    check(uiOps.length >= 5, '扫到了后端的 ui 操作（不是空扫）', uiOps.join(','));
    uiOps.forEach((op) => {
      check(html.includes("op === '" + op + "'"), '前端实现了后端会发的 ui 操作「' + op + '」');
    });
    const serialActions = [...new Set([
      ...[...mcpProd.matchAll(/\{ "action": "([a-zA-Z]+)"/g)].map((m) => m[1]),
      ...[...mcpProd.matchAll(/serial_call\(core, "([a-zA-Z]+)"/g)].map((m) => m[1]),
    ])];
    check(serialActions.length >= 6, '扫到了后端的 serial 动作（不是空扫）', serialActions.join(','));
    serialActions.forEach((a) => {
      check(html.includes("action === '" + a + "'"), '前端实现了后端会发的 serial 动作「' + a + '」');
    });

    // ---- 文本摘要不能把数据藏起来（用户就是被这个误导的）----
    check(/fn summarize_for_text/.test(mcpProd) && /fn render_brief/.test(mcpProd)
      && !/Value::Array\(a\) => format!\("\{\} 项", a\.len\(\)\)/.test(mcpProd),
      '文本摘要会真的展开数组内容（曾经只写「N 项」，`serial_list_ports` 的端口名就此消失）');
    check(/TEXT_SUMMARY_MAX_CHARS/.test(mcpProd), '文本摘要仍有长度上限（它是重复信息，不能撑爆上下文）');

    // ---- Agent 调用效率：三处"让它第一次就做对 / 别白等"的机制 ----
    // （必须放在 mcpProd/mcpSrc 定义之后 —— 上面那处曾把它们引在定义前，直接 ReferenceError 崩掉。）
    check(/pub const SERVER_INSTRUCTIONS/.test(mcpProd) && /"instructions": SERVER_INSTRUCTIONS/.test(mcpProd),
      'initialize 下发工作指引（Agent 靠它一次做对，而不是靠失败去猜）');
    check(/fn no_serial_port_hint\(/.test(mcpProd)
      && /"serial_open" => \{[\s\S]{0,260}?no_serial_port_hint/.test(mcpSrc),
      '没有串口设备时 serial_open 立刻失败，不去白等 6 秒轮询超时');
    check(/"id": req_id/.test(mcpProd) && !/"id": serde_json::Value::Null/.test(mcpProd),
      '限流回包带上本次请求的 id（用 null 的话客户端配不上号、那次调用会挂到超时）');

    // ---- 只读（沙箱）模式：AI 能自由探索，但一个字都改不到用户的东西 ----
    check(/pub const E_POLICY_DENIED: i64 = -32007;/.test(mcpProd), '被策略拒绝有独立错误码 -32007');
    check(/pub const WRITE_TOOLS: &\[&str\] = &\[/.test(mcpProd) && /fn is_write_call\(/.test(mcpProd),
      '写操作有唯一定义（WRITE_TOOLS + is_write_call）');
    check(/pub async fn call_tool\([\s\S]{0,900}?core\.read_only\(\) && is_write_call\(name, args\)/.test(mcpProd),
      '只读模式在 call_tool **最前面**拦截（不是改完再回滚）');
    check(/pub fn read_only\(&self\)/.test(mcpProd) && /"readOnly": cfg\.expose\.read_only/.test(mcpProd),
      'mcp_status 里带 readOnly（Agent 必须先看它，才不会一路撞墙）');
    check(/read_only: bool/.test(mcpProd) && /read_only: false/.test(mcpProd),
      'expose.readOnly 默认关（默认拒绝一切写会让「开箱即用」变成「怎么都改不动」）');

    // 界面开关：只读模式下 AI 连 mcp_config_set 都会被拒（故意的），所以**关它的唯一入口是界面**
    check(/id="mcpReadOnlyBtn"[^>]*onclick="mcpToggleReadOnly\(\)"/.test(html),
      '弹窗里有只读模式开关（否则打开后 AI 关不掉、用户也只能手改配置文件）');
    check(/function mcpToggleReadOnly\(\)[\s\S]{0,400}?invoke\('mcp_set_read_only'/.test(html),
      '开关调用 mcp_set_read_only');
    check(/id="mcpReadOnlyBtn"[\s\S]{0,120}?readOnly/.test(html) || /ro\.textContent = on \?/.test(html),
      '开关文案跟着 readOnly 状态更新');

    // 文档的「读/写」列必须与 Rust 的 WRITE_TOOLS 一致（那列以前是手写的，没人核过）
    const genMeta = fs.readFileSync(path.join(root, '.walkthrough', 'gen_mcp_tools_doc.js'), 'utf8');
    const rustWrites = [...(/pub const WRITE_TOOLS: &\[&str\] = &\[([\s\S]*?)\];/.exec(mcpProd) || ['', ''])[1]
      .matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    const docWrites = [...genMeta.matchAll(/^\s{2}([a-z_]+): \['写'/gm)].map((m) => m[1]).sort();
    check(rustWrites.length >= 10, '扫到了 Rust 的写工具表（不是空扫）', rustWrites.join(','));
    check(JSON.stringify(rustWrites.filter((n) => n !== 'serial_quick_cmd'))
        === JSON.stringify(docWrites.filter((n) => n !== 'serial_quick_cmd')),
      '文档「读/写」列与 Rust 的 WRITE_TOOLS 一致',
      'Rust=' + rustWrites.join(',') + ' / 文档=' + docWrites.join(','));
    check(/if name == "serial_quick_cmd"[\s\S]{0,120}?args\.get\("index"\)\.is_some\(\)/.test(mcpProd),
      'serial_quick_cmd 按**调用**判定（不带 index 是只读列举，带 index 才是真的发出去）');

    // ---- 「报得出来的开关，就必须设得了」----
    // 真机发现过的不对称：serial_get_state 报了 advOpen（更多设置栏展开），但 serial_set_display
    // 的字段名单里没有它 → 设它会回「至少要给一个：…」（连提示都没提它）。这类漏项以前只能靠人眼比对。
    const toggleKeys = [...(/var MCP_SERIAL_TOGGLES = \{([\s\S]*?)\n\};/.exec(html) || ['', ''])[1]
      .matchAll(/([a-zA-Z]+):\s*'/g)].map((m) => m[1]);
    const setDisplayList = (/for k in \[([\s\S]{0,400}?)\]\s*\{[\s\S]{0,200}?"serial_set_display"/.exec(mcpProd)
      || /"serial_set_display" => \{[\s\S]{0,400}?for k in \[([\s\S]{0,400}?)\]/.exec(mcpProd) || ['', ''])[1];
    check(toggleKeys.length >= 6, '扫到了前端的开关表（不是空扫）', toggleKeys.join(','));
    const missingToggles = toggleKeys.filter((k) => !new RegExp('"' + k + '"').test(setDisplayList));
    check(missingToggles.length === 0,
      'serial_get_state 报出来的每个开关，serial_set_display 都能设（否则"看得到改不了"）',
      '少：' + missingToggles.join(',') + ' / set_display 名单=' + setDisplayList.replace(/\s+/g, ' ').trim());
  }

  // 每个运行期错误点都要真的调用上报（漏一个就是一个盲区）
  const reportSites = [
    ['start_failed', 'MCP 起不来（端口被占是最常见的用户故障）'],
    ['start_timeout', '绑定超时'],
    ['config_save_failed', 'ai-config.json 写盘失败'],
    ['endpoint_write_failed', '端点发现文件写盘失败'],
    ['accept_failed', 'accept 循环出错'],
    ['unauthorized', 'token 不匹配（客户端配置过期）'],
    ['sse_endpoint_queue_full', '会话队列刚建就满'],
    ['session_slow_consumer_dropped', '慢消费者被断开'],
    ['rate_limited', '被限流'],
    ['ui_bridge_timeout', '前端 5 秒没回执'],
    ['calllog_write_failed', '调用记录写不进去'],
    ['dispatch_panic', '请求处理 panic'],
    ['registry_entry_invalid', '控件注册项解析失败（前后端结构漂移）'],
  ];
  reportSites.forEach(([kind, why]) => {
    check(new RegExp('report(::report)?\\(\\s*"' + kind + '"').test(mcpSrc)
      || new RegExp('"' + kind + '"').test(mcpSrc),
      '上报点存在：' + kind + '（' + why + '）');
  });
  check(/report::report\(\s*"accept_failed", &e\.to_string\(\)\)/.test(mcpSrc)
    && /report::report\(\s*"unauthorized"/.test(mcpSrc),
    'accept 失败与鉴权失败都带上了具体信息');
  // 上报线程必须真的被初始化，否则所有 report 都进黑洞
  check(/init_error_reporter\(\);/.test(mainRs), 'main.rs 里初始化了上报线程（否则上报全进黑洞）');
  check(/"errorReports": \{/.test(mcpSrc) && /"deduped": report::stats\(\)\.1/.test(mcpSrc),
    '状态里能看到报了多少条、被去重挡了多少次');

  console.log('\n【MCP 加固（S10：状态端点 / 工具变更通知 / 安装包约束）】');

  // ---- /status：必须验 token，且回显里绝不含 token 与完整 URL ----
  check(/\(Method::GET, "\/status"\)/.test(mcpSrc), '有 /status 详情端点');
  check(/"\/status"[\s\S]{0,320}?constant_time_eq\(&given, &core\.token\(\)\)/.test(mcpSrc),
    '/status 先验 token 才回详情（未授权只回 401）');
  check(/if !constant_time_eq\(&given, &core\.token\(\)\) \{[\s\S]{0,120}?unauthorized\(\)[\s\S]{0,120}?status_json_public\(\)/
    .test(mcpSrc), '/status 的未授权分支与授权分支分得很清楚');
  check(/pub fn status_json_public\(/.test(mcpSrc), '有「对外可见」的状态序列化函数');
  check(/o\.remove\("token"\)/.test(mcpSrc), '对外状态里 token 被摘掉');
  check(/o\.remove\("url"\)/.test(mcpSrc) && /o\.insert\("urlMasked"\.into\(\)/.test(mcpSrc),
    '对外状态里完整 url 被换成 urlMasked');
  check(/pub fn mask_url\(url: &str\) -> String/.test(mcpSrc), 'mask_url 在配置模块里（与写盘口径一致）');
  // /healthz 仍然只回 {"ok":true}（唯一免鉴权端点不能变成信息泄露点）
  check(/\(Method::GET, "\/healthz"\) => json_resp\(StatusCode::OK, serde_json::json!\(\{ "ok": true \}\)\)/.test(mcpSrc),
    '/healthz 仍只回 {"ok":true}（未因新增 /status 而放宽）');

  // ---- 工具名集合变化 → 主动广播 notifications/tools/list_changed ----
  check(/pub fn replace_and_diff\(/.test(mcpSrc), '注册表能算出「工具名集合是否变了」');
  check(/let \(n, tools_changed\) = core\.registry\.replace_and_diff\(parsed\)/.test(mcpSrc),
    '上报注册表时拿到 tools_changed');
  check(/if tools_changed && core\.running\.load\(Ordering::Relaxed\)/.test(mcpSrc),
    '只在服务器运行中且真的变了才通知（不打扰客户端）');
  check(/"method": "notifications\/tools\/list_changed"/.test(mcpSrc),
    '发的是规范里的 notifications/tools/list_changed（没有 id 的通知报文）');
  check(/transport::broadcast\(/.test(mcpSrc), '通知走 broadcast（非阻塞，不给任何人添堵）');
  check(/"toolsChanged": tools_changed/.test(mcpSrc), '返回值里也带上 toolsChanged（界面/测试可断言）');
  check(/notified/.test(mcpSrc), '广播了几个会话是可见的（便于排查"客户端没刷新"）');

  // ---- 启停幂等：停机标志只能有一个复位点，且必须在绑端口之前 ----
  check(/pub async fn serve\([\s\S]{0,900}?core\.shutdown\.store\(false, Ordering::Relaxed\)[\s\S]{0,200}?transport::bind\(/
    .test(mcpSrc), 'serve() 在绑端口前清掉停机标志（否则重启会"启动成功但第一圈就退出"）');
  check((mcpProdCode.match(/shutdown\.store\(false/g) || []).length === 1,
    '停机标志只有 serve() 一个复位点（两处口径会漂移）',
    (mcpProdCode.match(/shutdown\.store\(false/g) || []).length);
  check(/fn start_stop_is_idempotent_over_many_cycles/.test(mcpSrc),
    '有「启停 50 次幂等」的真机单测（S10 的验收门）');
  check(/for i in 0\.\.50/.test(mcpSrc) && /第 \{\} 次停止后端口/.test(mcpSrc),
    '单测真的跑 50 圈并逐圈检查端口释放');

  // ---- npm 包只是「客户端配置安装器」，不能偷偷装东西 ----
  const npmPkg = JSON.parse(fs.readFileSync(path.join(root, 'npm', 'seahi-serial-mcp', 'package.json'), 'utf8'));
  check(npmPkg.bin && npmPkg.bin['seahi-serial-mcp'] === 'cli.js', 'npm 包有 bin 入口');
  check(npmPkg.version === '0.1.0', 'npm 包版本独立于应用版本', npmPkg.version);
  check(!npmPkg.dependencies && !npmPkg.optionalDependencies && !npmPkg.peerDependencies,
    'npm 包零依赖（不下载任何东西）');
  check(!npmPkg.scripts || !npmPkg.scripts.install && !npmPkg.scripts.postinstall,
    'npm 包没有 install / postinstall 钩子（安装即改配置是不可接受的）');
  check(Array.isArray(npmPkg.os) && npmPkg.os.indexOf('win32') >= 0, 'npm 包声明仅 Windows');
  check((npmPkg.files || []).indexOf('cli.js') >= 0, 'npm 包只发布必要文件');
  const npmCli = fs.readFileSync(path.join(root, 'npm', 'seahi-serial-mcp', 'cli.js'), 'utf8');
  check(/--dry-run/.test(npmCli), '安装器支持 --dry-run 预览');
  check(/mcp-endpoint\.json/.test(npmCli), '安装器读应用的端点文件自动探测');
  check(/\.seahi-bak/.test(npmCli), '改客户端配置前先备份');
  check(!/child_process|execSync|spawnSync/.test(npmCli),
    '安装器不调用任何子进程（只读写 JSON 配置）');
  check(/function installFor/.test(npmCli) && /function uninstallFor/.test(npmCli),
    '有 install / uninstall 两条路径');

  console.log('\n【MCP 串口语义工具（S12：选口 / 波特率 / 开监控 / 发数据…）】');

  // ---- 源码：13 个工具齐全，且"开监控"必须确认状态而不是点完就返回 ----
  const serialTools = ['serial_get_state', 'serial_select_port', 'serial_set_baud', 'serial_set_frame',
    'serial_set_lines', 'serial_set_display', 'serial_open', 'serial_close', 'serial_send',
    'serial_clear', 'serial_get_history', 'serial_quick_cmd', 'serial_get_output'];
  serialTools.forEach((n) => {
    check(new RegExp('"name": "' + n + '"').test(mcpSrc), '串口语义工具已定义 ' + n);
  });
  check(/async fn serial_set_connected\(/.test(mcpSrc) && /tokio::time::sleep\(std::time::Duration::from_millis\(150\)\)/.test(mcpSrc),
    'serial_open/close 会轮询确认状态（点完不代表连上）');
  check(/E_DEVICE_NOT_READY,[\s\S]{0,200}?常见原因：端口被占用/.test(mcpSrc),
    '连接失败给出可操作的原因，并用 -32006（→ isError:true 而不是 JSON-RPC 错误）');
  check(/async fn serial_apply\(/.test(mcpSrc) && /core\.ui_call\("serial", payload\)/.test(mcpSrc),
    '串口工具最终仍走前端 ui_call("serial")（不是后端另开一条控制路径）');
  check(/action === 'apply'/.test(html) && /mcpWriteEl\(el, spec\[1\], value\)/.test(html),
    '前端 apply 用 mcpWriteEl（与 ui_set 同一个写值函数）');
  check(/for \(var i = 0; i < items.length; i\+\+\)/.test(html) && /tel\.click\(\)/.test(html),
    '开关类走 el.click()（复用 toggleIbtn 等既有 handler）');

  // ---- 行为：把真实函数丢进 vm，用假 DOM 跑 ----
  {
    const sfx = (id, opts) => {
      opts = opts || {};
      const s = new Set(String(opts.class || '').split(/\s+/).filter(Boolean));
      const el = {
        id: id, tagName: String(opts.tag || 'div').toUpperCase(),
        attrs: Object.assign({}, opts.attrs || {}),
        value: opts.value === undefined ? '' : opts.value,
        textContent: opts.text || '',
        disabled: !!opts.disabled, _clicks: 0, _opts: opts.opts || [],
        getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
        setAttribute(k, v) { this.attrs[k] = v; },
        classList: { contains: (c) => s.has(c), add: (c) => s.add(c), remove: (c) => s.delete(c), toggle: (c) => (s.has(c) ? s.delete(c) : s.add(c)) },
        querySelectorAll(sel) { return sel === '.sel-opt' || sel === '.send-as-opt' ? this._opts : []; },
        dispatchEvent() { return true; },
        click() { this._clicks++; if (this.tagName === 'INPUT' && this.attrs.type === 'checkbox') this.checked = !this.checked; },
      };
      return el;
    };
    const opt = (val, text) => ({ getAttribute: (k) => (k === 'data-val' ? val : null), textContent: text || val, _clicks: 0, click() { this._clicks++; } });

    const els = {
      'main-portSelect': sfx('main-portSelect', { attrs: { 'data-val': 'COM1' }, opts: [opt('COM1'), opt('COM3')] }),
      'main-baudRate': sfx('main-baudRate', { tag: 'input', attrs: { type: 'number' }, value: '115200' }),
      'main-lineEnding': sfx('main-lineEnding', { attrs: { 'data-val': 'crlf' }, opts: [opt('crlf'), opt('lf'), opt('none')] }),
      'main-viewMode': sfx('main-viewMode', { attrs: { 'data-val': 'text' }, opts: [opt('text'), opt('hex')] }),
      'main-dataBits': sfx('main-dataBits', { attrs: { 'data-val': '8' }, opts: [opt('8'), opt('7')] }),
      'main-stopBits': sfx('main-stopBits', { attrs: { 'data-val': '1' }, opts: [opt('1'), opt('2')] }),
      'main-parity': sfx('main-parity', { attrs: { 'data-val': 'none' }, opts: [opt('none'), opt('odd')] }),
      'main-chkDTR': sfx('main-chkDTR', { tag: 'input', attrs: { type: 'checkbox' }, checked: false }),
      'main-chkRTS': sfx('main-chkRTS', { tag: 'input', attrs: { type: 'checkbox' }, checked: true }),
      'main-advRow': sfx('main-advRow'),
      'main-sendAsText': sfx('main-sendAsText', { text: '文本' }),
      'main-sendAsDrop': sfx('main-sendAsDrop', { opts: [opt('text', '文本'), opt('hex', 'HEX')] }),
      'main-btnScroll': sfx('main-btnScroll', { class: 'ibtn on' }),
      'main-btnLineNum': sfx('main-btnLineNum', { class: 'ibtn' }),
      'main-btnStart': sfx('main-btnStart', { tag: 'button' }),
      'main-btnSend': sfx('main-btnSend', { tag: 'button', disabled: true }),
      'main-sendInput': sfx('main-sendInput', { tag: 'input' }),
      'main-btnEcho': sfx('main-btnEcho', { class: 'ibtn' }),
    };
    const monitorMap = {
      main: { isConnected: false, portName: '', sendHistory: ['AT', 'AT+GMR'], quickCmds: [{ label: '查版本', value: 'AT+GMR' }, { label: '空', value: '' }], _textCount: 12, _textDataLen: 345 },
      'extra-1': { isConnected: true, portName: 'COM5', sendHistory: [], quickCmds: [], _textCount: 0, _textDataLen: 0 },
      'ble-mon': { isConnected: false, bleEmbedded: true, sendHistory: [], quickCmds: [] },
    };
    const calls = { qcmd: [], cleared: 0, refreshed: 0 };
    // 假 DOM 要模拟真实下拉的行为：点选项 → 应用自己的 setSel() 会把 data-val/sel-text 改掉。
    // 不接这一步，"写入后读回"就会失败（那是测试替身的缺口，不是被测代码的问题）。
    ['main-portSelect', 'main-lineEnding', 'main-viewMode', 'main-dataBits', 'main-stopBits', 'main-parity']
      .forEach((selId) => {
        const sel = els[selId];
        sel._opts.forEach((o) => {
          o.click = function () {
            this._clicks++;
            sel.attrs['data-val'] = this.getAttribute('data-val');
          };
        });
      });
    els['main-sendAsDrop']._opts.forEach((o) => {
      o.click = function () {
        this._clicks++;
        els['main-sendAsText'].textContent = this.getAttribute('data-val') === 'hex' ? 'HEX' : '文本';
      };
    });
    const sbSer = {
      console,
      document: { getElementById: (id) => els[id] || null },
      monitors: monitorMap,
      _mcpUiOrigin: 0,
      scheduleConfigSave() {},
      mcpNotifyState() {},
      clearLog() { calls.cleared++; },
      refreshPorts() { calls.refreshed++; },
      copyOutput() {},
      sendQcmdItem(mid, gid, idx) { calls.qcmd.push([mid, gid, idx]); },
    };
    vm.createContext(sbSer);
    vm.runInContext([
      'var _mcpUiOrigin = 0;',
      // 三个映射表是模块级 var（不在函数里），必须单独抠出来注入，否则沙箱里 undefined
      /var MCP_SERIAL_FIELDS = \{[\s\S]*?\n\};/.exec(html)[0],
      /var MCP_SERIAL_TOGGLES = \{[\s\S]*?\n\};/.exec(html)[0],
      /var MCP_SERIAL_FUNCS = \{[\s\S]*?\n\};/.exec(html)[0],
      extractFunction('mcpReadEl'), extractFunction('mcpWriteEl'), extractFunction('_mcpDispatch'),
      extractFunction('_mcpFindOption'), extractFunction('mcpKindOf'),
      // collectConfigForMonitor 现在会读分栏宽度 → 沙箱也得有 qcmdSideWidth 和它的上下限常量
      /var QCMD_SIDE_DEFAULT[^\n]*/.exec(html)[0],
      extractFunction('qcmdSideWidth'),
      // quickList 现在带出每条的发送参数（顺序号/延时/HEX）→ 三个读法与它们的上下限常量
      /var QCMD_SEQ_MAX[\s\S]*?var QCMD_DELAY_MAX = \d+;/.exec(html)[0],
      extractFunction('qcmdItemSeq'), extractFunction('qcmdItemDelay'), extractFunction('qcmdItemHex'),
      // 快速指令现在是组：quickList/quickRun 靠 qcmdAllItems 摊平（组序 = 循环行走顺序）
      /var QCMD_GROUP_DEFAULT_NAME[^\n]*/.exec(html)[0],
      extractFunction('qcmdNewGroupId'), extractFunction('qcmdGroups'), extractFunction('qcmdGroupById'),
      extractFunction('qcmdGroupIndex'), extractFunction('qcmdAllItems'), extractFunction('qcmdGroupOn'),
      extractFunction('collectConfigForMonitor'),
      extractFunction('mcpSerialPanes'), extractFunction('mcpSerialResolvePane'),
      extractFunction('mcpSerialEl'), extractFunction('mcpSerialOptions'),
      extractFunction('mcpSerialState'), extractFunction('mcpSerialApply'), extractFunction('mcpSerialOp'),
      extractFunction('mcpSerialLogChannels'),
      // mcpSerialOp 的 quick* 分支会调这些面板函数。本节只验证"发出去的 op/参数"与"回执形状"，
      // 所以按最小语义打桩；**真实行为**（改真的落到模型上）由下面侧栏那一节用真函数 + 假 DOM 测，
      // 两节各管一半、不重复。
      'function qcmdItemElId(mid, gid, idx, s) { return mid + "-qcmdi-" + gid + "-" + idx + (s ? "-" + s : ""); }',
      'function qcmdLoopRefusal() { return null; }',
      'function qcmdLoopRunning(mid) { return !!(monitors[mid] && monitors[mid].qcmdLoop); }',
      'function qcmdLoopPlan(mid) { return qcmdAllItems(mid).filter(function (x) { return qcmdItemSeq(x.it) > 0; }); }',
      'function qcmdLoopSyncPlan() {}',
      'function stopQcmdLoop(mid) { if (monitors[mid]) monitors[mid].qcmdLoop = false; }',
      'function syncQcmdLoopBtn() {}',
      'function setQcmdLoop(mid, on) { if (monitors[mid]) monitors[mid].qcmdLoop = !!on; return !!on; }',
      'function qcmdItemAt(mid, gid, idx) { var g = qcmdGroupById(mid, gid); return (g && g.items[idx]) || null; }',
      'function qcmdResolveGroup(mid, ref) { var l = qcmdGroups(mid); ' +
        'if (typeof ref === "number") return l[ref] || null; ' +
        'for (var i = 0; i < l.length; i++) if (l[i].name === ref || l[i].id === ref) return l[i]; return null; }',
      'function qcmdResolveItem(mid, index) { var f = qcmdAllItems(mid); return f[index] || null; }',
      'function qcmdApplyItemPatch(mid, gid, idx, p) { var out = []; ' +
        'if (p.value !== undefined) out.push("value"); if (p.seq !== undefined) out.push("seq"); ' +
        'if (p.delayMs !== undefined) out.push("delayMs"); if (p.hex !== undefined) out.push("hex"); ' +
        'var it = qcmdItemAt(mid, gid, idx); if (it) { if (p.value !== undefined) it.value = String(p.value); ' +
        'if (p.seq !== undefined) it.seq = parseInt(p.seq, 10) || 0; ' +
        'if (p.delayMs !== undefined) it.delay = parseInt(p.delayMs, 10); if (p.hex !== undefined) it.hex = !!p.hex; } ' +
        'return out; }',
      'function addQcmdItem(mid, gid) { var g = qcmdGroupById(mid, gid); if (g) g.items.push({ label: "", value: "", seq: 0, delay: 1000, hex: false }); }',
      'function removeQcmdItem(mid, gid, idx) { var g = qcmdGroupById(mid, gid); if (g) g.items.splice(idx, 1); }',
      'function addQcmdGroup(mid) { qcmdGroups(mid).push({ id: qcmdNewGroupId(), name: "循环 " + (qcmdGroups(mid).length + 1), items: [{}] }); }',
      'function removeQcmdGroup(mid, gid) { var l = qcmdGroups(mid); var i = qcmdGroupIndex(mid, gid); if (i >= 0 && l.length > 1) l.splice(i, 1); }',
      'function renameQcmdGroup(mid, gid, name) { var g = qcmdGroupById(mid, gid); if (g) g.name = String(name); }',
      'function setQcmdGroupOn(mid, gid, on) { var g = qcmdGroupById(mid, gid); if (g) g.on = !!on; }',
      'function setQcmdGroupFold(mid, gid, on) { var g = qcmdGroupById(mid, gid); if (g) g.folded = !!on; return true; }',
      'function qcmdMoveGroup(mid, gid, to) { var l = qcmdGroups(mid); var i = qcmdGroupIndex(mid, gid); ' +
        'if (i < 0) return false; l.splice(to, 0, l.splice(i, 1)[0]); return true; }',
      'function scheduleConfigSave() {}', 'function scheduleQcmdFileSave() {}',
    ].join('\n'), sbSer);

    check(JSON.stringify(sbSer.mcpSerialPanes()) === '["main","extra-1"]',
      '分栏列表排除了蓝牙页内嵌的临时监视器', JSON.stringify(sbSer.mcpSerialPanes()));
    check(sbSer.mcpSerialResolvePane(undefined) === 'main', '省略 pane 默认 main');
    check(sbSer.mcpSerialResolvePane('extra-9') === null, '未知分栏返回 null（上层转成"没有这个分栏"）');

    const st = sbSer.mcpSerialOp({ action: 'state', pane: 'main' });
    check(st.ok && st.value.port === 'COM1' && st.value.baud === 115200, '状态读出端口与波特率（数字）',
      JSON.stringify({ port: st.value.port, baud: st.value.baud }));
    check(st.value.isConnected === false && st.value.outputLines === 12 && st.value.historyCount === 2,
      '状态带运行时信息：是否在监控 / 输出行数 / 历史条数');
    check(st.value.autoScroll === true && st.value.lineNum === false, '状态里的开关取自 on class');
    // 让 AI 知道"收发内容去哪读"：通道名由前端一处定义，serial_get_output 直接读它
    check(st.value.logChannels && st.value.logChannels.rx === 'serial:main:rx'
      && st.value.logChannels.tx === 'serial:main:tx',
      '状态里带出日志通道名（AI 不用猜 serial:<分栏>:rx 怎么拼）',
      JSON.stringify(st.value.logChannels));
    check(!/\(m\.isWsl \? 'wsl:' : 'serial:'\) \+ mid \+ \(type === 'send'/.test(html)
      && /mcpCh = type === 'send' \? chans\.tx : chans\.rx;/.test(html),
      '通道名规则只有一处定义（bufferPush 与 mcpSerialState 共用 mcpSerialLogChannels，不各写一遍）');

    const okPort = sbSer.mcpSerialOp({ action: 'apply', items: [{ name: 'port', value: 'COM3' }] });
    check(okPort.ok && okPort.value && okPort.value.applied[0].ok
      && okPort.value.applied[0].from === 'COM1' && okPort.value.applied[0].to === 'COM3',
      '选端口：写值并回报 from/to', JSON.stringify(okPort));

    const badPort = sbSer.mcpSerialOp({ action: 'apply', items: [{ name: 'port', value: 'COM99' }] });
    check(!badPort.ok && /可选值只有: COM1 \/ COM3/.test(badPort.error),
      '端口给错要**回列真实可选值**（AI 最需要这个）', badPort.error);

    const badBaud = sbSer.mcpSerialOp({ action: 'apply', items: [{ name: 'baud', value: 99999999 }] });
    check(!badBaud.ok && /110\.\.4000000/.test(badBaud.error), '波特率越界被拒', badBaud.error);

    const badField = sbSer.mcpSerialOp({ action: 'apply', items: [{ name: 'nope', value: 1 }] });
    check(!badField.ok && /不认识的字段/.test(badField.error) && /autoScroll/.test(badField.error),
      '未知字段要列出可用字段名', badField.error);

    // 整批是逐项校验的：前面的项可能已经改掉了，只说"失败"会让 AI 以为界面没变
    const partial = sbSer.mcpSerialOp({ action: 'apply', items: [
      { name: 'port', value: 'COM3' },
      { name: 'port', value: 'COM99' },
    ] });
    check(!partial.ok && /可选值只有/.test(partial.error) && /已经生效/.test(partial.error),
      '部分成功要在错误里点名"已生效"的字段（否则 AI 会重复下发或错判当前状态）',
      partial.error);

    // 错误码分流（决定了 AI 下一步该做什么）：
    //   参数取值非法 → invalidParams → 协议级 -32602 → "改参数重试"
    //   界面结构不对/前置状态没满足 → 不带标记 → isError + -32006 → "先做前置操作/检查界面"
    check(badPort.invalidParams === true && badBaud.invalidParams === true && badField.invalidParams === true,
      '取值非法（端口不在下拉里/波特率越界/字段名不认识）带 invalidParams → -32602',
      JSON.stringify([badPort.invalidParams, badBaud.invalidParams, badField.invalidParams]));
    const noBtn = sbSer.mcpSerialOp({ action: 'click', name: 'nope' });
    check(!noBtn.ok && !noBtn.invalidParams && /找不到按钮/.test(noBtn.error),
      '"界面里找不到控件"不是参数问题 → 不带标记（否则会误导 AI 去改参数，而它该做的是检查界面）',
      JSON.stringify(noBtn));

    els['main-btnScroll']._clicks = 0;
    sbSer.mcpSerialOp({ action: 'apply', items: [{ name: 'autoScroll', value: true }] });
    check(els['main-btnScroll']._clicks === 0, '开关本来就是 on → 不重复点击（幂等）');
    sbSer.mcpSerialOp({ action: 'apply', items: [{ name: 'autoScroll', value: false }] });
    check(els['main-btnScroll']._clicks === 1, '开关需要变 → 点一次（走它自己的 onclick）');

    const dis = sbSer.mcpSerialOp({ action: 'click', name: 'send' });
    check(!dis.ok && /不可点/.test(dis.error), '按钮 disabled 时拒绝点击（和用户一样点不动）', dis.error);

    const sendOff = sbSer.mcpSerialOp({ action: 'send', data: 'AT' });
    check(!sendOff.ok && !sendOff.invalidParams,
      '"还没开监控"是前置状态问题 → 不带 invalidParams（-32006，并提示先 serial_open）',
      JSON.stringify(sendOff));
    check(!sendOff.ok && /还没打开监控/.test(sendOff.error), '未开监控时拒绝发数据', sendOff.error);

    monitorMap.main.isConnected = true;
    els['main-btnSend'].disabled = false;
    els['main-btnSend']._clicks = 0;
    const sent = sbSer.mcpSerialOp({ action: 'send', data: 'AT+GMR' });
    check(sent.ok && sent.value.sent === true && els['main-sendInput'].value === 'AT+GMR' && els['main-btnSend']._clicks === 1,
      '发数据：写发送框 + 点发送按钮（与用户操作同一条路）');

    const hist = sbSer.mcpSerialOp({ action: 'history', limit: 5 });
    check(hist.ok && hist.value.items[0] === 'AT+GMR' && hist.value.total === 2, '发送历史最新在前');

    const ql = sbSer.mcpSerialOp({ action: 'quickList' });
    check(ql.ok && ql.value.items.length === 2 && ql.value.usable === 1, '快速指令：列出全部并标出哪条可用', JSON.stringify(ql.value));
    const qr = sbSer.mcpSerialOp({ action: 'quickRun', index: 1 });
    check(!qr.ok && /还没配内容/.test(qr.error), '执行空内容的快速指令要拒绝', qr.error);
    const qr2 = sbSer.mcpSerialOp({ action: 'quickRun', index: 0 });
    check(qr2.ok && calls.qcmd.length === 1 && calls.qcmd[0][2] === 0, '执行快速指令走 sendQcmdItem（既有函数，带组号）');

    sbSer.mcpSerialOp({ action: 'clear' });
    check(calls.cleared === 1, '清空走 clearLog（那个按钮没有 id，只能调它 onclick 里的函数）');

    const same = sbSer.mcpSerialOp({ action: 'setSendAs', mode: 'text' });
    check(same.ok && same.value.note === '本来就是' && els['main-sendAsText'].textContent === '文本',
      '发送模式本来就是 text → 不点下拉项');
    sbSer.mcpSerialOp({ action: 'setSendAs', mode: 'hex' });
    check(els['main-sendAsDrop']._opts[1]._clicks === 1, '切 HEX：点是真实下拉项（触发它自己的 onclick）');
  }

  // ---------- 快速指令侧栏（监控区最右侧、可折叠、默认折叠） ----------
  {
    // ICONS 是 `const ICONS = {`（不是 var），extractObject 不适用，这里单独切
    const ICON_SRC = (() => {
      const i = html.indexOf('const ICONS = {');
      const end = html.indexOf('\n};', i);
      if (i < 0 || end < 0) throw new Error('ICONS 未找到');
      return html.slice(i, end + 3);
    })();
    function stubEl(id) {
      const cls = new Set();
      const props = {};
      const el = {
        id: id || '', innerHTML: '', className: '', textContent: '', value: '', disabled: false,
        offsetWidth: 0, offsetHeight: 0, clientWidth: 0,
        style: {
          setProperty: (k, v) => { props[k] = v; },
          getPropertyValue: k => props[k] || '',
        },
        dataset: {}, attrs: {}, children: [], title: '',
        // 记下 addEventListener 的回调：快指令每条自己那几个输入框（顺序号/延时/HEX）
        // 只有真触发一次它的处理器，才能证明"改了会进模型"，光看源码正则证明不了
        _handlers: {},
        classList: {
          add: c => cls.add(c),
          remove: c => cls.delete(c),
          contains: c => cls.has(c),
          toggle: (c, on) => {
            const want = on === undefined ? !cls.has(c) : !!on;
            want ? cls.add(c) : cls.delete(c);
            return want;
          },
        },
        addEventListener(t, fn) { (el._handlers[t] = el._handlers[t] || []).push(fn); },
        appendChild(c) { el.children.push(c); },
        // 浏览器里点一下会跑它自己的 click 处理器；假 DOM 也照做（MCP 的点击路径靠它验证）
        click() {
          el._clicks = (el._clicks || 0) + 1;
          ((el._handlers && el._handlers.click) || []).forEach(fn =>
            fn.call(el, { stopPropagation() {}, preventDefault() {} }));
        },
        // dispatchEvent：把事件按 type 送到该元素登记的处理器上（_mcpDispatch 靠它 ——
        // 少了它，MCP 写的值进不了模型，只会改到一个空壳元素的 value 上）
        dispatchEvent(ev) {
          const type = ev && ev.type;
          ((el._handlers && el._handlers[type]) || []).forEach(fn => fn.call(el, ev));
          return true;
        },
        setAttribute(k, v) { el.attrs[k] = v; },
        getAttribute(k) { return el.attrs[k]; },
        querySelector: () => null,
        querySelectorAll: () => [],
      };
      return el;
    }
    const sideById = {};
    const created = [];   // createMonitorPane 用 createElement 造窗格，按顺序留痕（[0] 就是窗格）
    const docListeners = {};   // 拖动用的 document 级监听，登记下来好模拟鼠标事件
    // 触发某个元素上登记过的处理器（this 绑到元素上，和浏览器一致）
    const fire = (el, type, ev) => ((el && el._handlers && el._handlers[type]) || [])
      .forEach(fn => fn.call(el, Object.assign({ stopPropagation() {}, preventDefault() {} }, ev || {})));
    const numConst = name => ((new RegExp('(?:var|const) ' + name + ' = ([0-9*\\s]+);')).exec(html) || [])[1];
    const srcLine = re => { const m = re.exec(html); return m ? m[0] : ''; };
    const sbSide = {
      console,
      // 浏览器里有 Event；沙箱里给个最小实现（_mcpDispatch 会 new Event(type, {bubbles:true})，
      // 没有它 dispatchEvent 那一步在 try/catch 里被吞掉 —— 于是 MCP 写的值进不了模型）
      Event: function Event(type) {
        this.type = type; this.bubbles = true;
        this.stopPropagation = function () {};
        this.preventDefault = function () {};
      },
      document: {
        getElementById: id => (sideById[id] = sideById[id] || stubEl(id)),
        createElement: () => {
          const el = stubEl();
          created.push(el);
          // 浏览器里"设了 id 的元素"用 getElementById 找得到；假 DOM 也得这样，
          // 否则面板里 `getElementById(mid + '-qcmdi-…')` 会拿到一个新建的空壳（断言全废）
          Object.defineProperty(el, 'id', {
            configurable: true,
            get() { return el._id || ''; },
            set(v) { el._id = String(v); sideById[el._id] = el; },
          });
          return el;
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
        removeEventListener: (t, fn) => {
          if (docListeners[t]) docListeners[t] = docListeners[t].filter(f => f !== fn);
        },
      },
    };
    vm.createContext(sbSide);
    vm.runInContext([
      ICON_SRC,
      'var monitors = {};',
      'var TEXT_BUF_INIT = ' + numConst('TEXT_BUF_INIT') + ';',
      'var TEXT_IDX_INIT = ' + numConst('TEXT_IDX_INIT') + ';',
      'var _terminalBuffers = {};',
      // 宽度上下限与拖动状态：直接从源码取那几行，改动值也会被这些断言看到
      srcLine(/var QCMD_SIDE_DEFAULT[^\n]*/),
      srcLine(/var QCMD_SIDE_MAX_RATIO[^\n]*/),
      srcLine(/var QCMD_SIDE_RESERVE[^\n]*/),
      srcLine(/var _qcmdDrag = null[^\n]*/),
      // 外部文件的上限与写回去抖表同样是模块级 var
      /var QCMD_FILE_MAX_ITEMS[\s\S]*?var QCMD_FILE_MAX_VALUE = \d+;/.exec(html)[0],
      srcLine(/var QCMD_FRONT_UNSUPPORTED[^\n]*/),
      srcLine(/var _qcmdFileSaveTimers[^\n]*/),
      // 每条的发送参数（顺序号/延时/HEX）与循环发送的上下限、开关文案、定时器表
      /var QCMD_SEQ_MAX[\s\S]*?var QCMD_DELAY_MAX = \d+;/.exec(html)[0],
      srcLine(/var QCMD_LOOP_TITLE_OFF[^\n]*/),
      srcLine(/var QCMD_LOOP_TITLE_ON[^\n]*/),
      srcLine(/var _qcmdLoopTimers = \{\}[^\n]*/),
      srcLine(/var QCMD_GROUP_DEFAULT_NAME[^\n]*/),
      // 表头驱动列：别名表是模块级 var，HEX 真值表是一行数组
      extractObject('QCMD_COL_ALIASES'),
      srcLine(/var QCMD_HEX_TRUE[^\n]*/),
      // createMonitorPane 后段会调这几个命令；本次只验证它拼出来的 HTML，命令本身不执行
      'function scheduleConfigSave() {}', 'function showToast() {}', 'function mcpNotifyState() {}', 'function refreshPorts() {}', 'function initTerminalMode() {}',
      ['qcmdSideHtml', 'qcmdColsHtml', 'qcmdColsInnerHtml', 'qcmdSideOpen', 'setQcmdSideOpen', 'toggleQcmdSide',
       'qcmdSideWidth', 'setQcmdSideWidth', 'startQcmdSideDrag', 'onQcmdSideDragMove', 'endQcmdSideDrag',
       'qcmdMdCells', 'qcmdColKey', 'qcmdHeaderMap', 'qcmdIsSeparatorRow', 'qcmdIsStructureRow',
       'qcmdCellInt', 'qcmdCellHex', 'qcmdParamCell', 'qcmdParseText', 'qcmdJoinRow', 'qcmdItemCells', 'qcmdBuildText', 'qcmdBaseName',
       'qcmdApplyParsed', 'qcmdCarryItemPrefs', 'renderQcmdSource', 'qcmdImportFile', 'qcmdReloadFile', 'qcmdUnmountFile',
       'qcmdExportCols', 'qcmdExportPrep', 'qcmdItemHasParams', 'qcmdExportFile',
       'qcmdCurrentText', 'scheduleQcmdFileSave', 'qcmdFileSaveNow',
       'qcmdFlushPendingFileSaves', 'qcmdFileMountedBy', 'collectConfigForMonitor',
       'qcmdNewGroupId', 'qcmdGroups', 'qcmdGroupById', 'qcmdGroupIndex', 'qcmdAllItems', 'qcmdItemAt',
       'qcmdGroupOn', 'setQcmdGroupOn', 'qcmdItemElId', 'qcmdLoopRefusal', 'qcmdResolveGroup',
       'qcmdResolveItem', 'qcmdApplyItemPatch', 'qcmdMoveGroup', 'setQcmdGroupFold',
       'mcpWriteEl', 'mcpKindOf', '_mcpDispatch',
       'makeQcmdItem', 'makeQcmdGroupBand', 'addQcmdItem', 'removeQcmdItem', 'rebuildQcmdList',
       'addQcmdGroup', 'removeQcmdGroup', 'renameQcmdGroup', 'toggleQcmdGroupFold',
       'startQcmdGroupDrag', 'onQcmdGroupDragMove', 'endQcmdGroupDrag', 'qcmdReorderBoxes',
       'qcmdBlockIndexOf', 'qcmdInsertItemBlock', 'qcmdRemoveItemBlock',
       'qcmdGroupBlocksRange', 'qcmdGroupSectionBlocks', 'qcmdRemoveGroupBlocks', 'qcmdMoveGroupBlocks', 'qcmdRenameGroupBlock',
       'qcmdDigits', 'qcmdItemSeq', 'qcmdItemDelay', 'qcmdItemHex', 'qcmdLoopPlan', 'qcmdItemText',
       'qcmdLoopRunning', 'qcmdSideTabTitle', 'syncQcmdLoopBtn', 'stopQcmdLoop', 'qcmdLoopStep', 'setQcmdLoop', 'toggleQcmdLoop', 'qcmdLoopSyncPlan',
       'createMonitorPane', 'getWslMonitorHtml'].map(extractFunction).join('\n'),
    ].join('\n'), sbSide);
    // 用 try 兜住：真正的 HTML 在函数前段就赋好了，后段的命令不在验证范围
    let paneCreateErr = null;
    try { sbSide.createMonitorPane('main', '监视器', false); } catch (e) { paneCreateErr = e.message; }
    const mainPaneHtml = created.length ? created[0].innerHTML : '';
    // ---- 兼容层：本节断言大量按"扁平列表"写（m.quickCmds[i]），而模型现在是"组" ----
    // 把 main 的 quickCmds 定义成**第 0 组 items 的存取器**，老断言因此继续有效。
    // （index.html 那边不再读写这个老字段 —— 见 qcmdApplyParsed 里"迁移"那段注释）
    Object.defineProperty(sbSide.monitors.main, 'quickCmds', {
      configurable: true,
      get() { const gs = sbSide.monitors.main.quickGroups; return (gs && gs[0] && gs[0].items) || []; },
      set(v) { sbSide.monitors.main.quickGroups = [{ id: 'g0', name: '循环 1', items: v }]; },
    });
    const g0 = () => sbSide.monitors.main.quickGroups[0];
    const g0id = () => g0().id;
    // 一行指令 = 组盒子的第 2 个孩子（第 1 个是抬头）里的第 1 条
    const firstItemEl = () => sideById['main-qcmdList'].children[0].children[2].children[0];

    const sideHtml = sbSide.qcmdSideHtml('main');
    check(sideHtml.includes('id="main-qcmdSide"') && sideHtml.includes('class="qcmd-side"'),
      '侧栏容器 id/类名契约（main-qcmdSide / .qcmd-side）', sideHtml.slice(0, 80));
    // 折叠态只有一根 CSS 画的握把：按钮里不放图标、文字，也不放小三角
    const tabTag = (/<button class="qcmd-side-tab"[\s\S]*?<\/button>/).exec(sideHtml);
    const tabInner = tabTag ? tabTag[0].replace(/^[^>]*>/, '').replace(/<\/button>$/, '') : 'x';
    check(tabTag && tabInner.trim() === '',
      '折叠条里没有任何图标/文字/三角字符（整条只有 CSS 画的那根握把）', JSON.stringify(tabInner));
    check(sideHtml.includes('id="main-btnQcmdSide"') && sideHtml.includes('title="展开快速指令"'),
      '折叠条带 title 提示（无文字时唯一的可发现性来源）');
    // 折叠条的视觉：折叠态=居中细握把；展开态=**一条收窄的贯穿竖色条**（用户定的方向）
    {
      const i = html.indexOf('/* ===== 快速指令分栏');
      const j = html.indexOf('.qcmd-side.open .qcmd-side-body', i);
      const sideCss = i < 0 || j < 0 ? '' : html.slice(i, j + 40);
      check(/\.qcmd-side-tab::before\s*\{[^}]*var\(--link\)/.test(sideCss),
        '握把用主题强调色 --link（默认主题即主题蓝；浅色主题也看得见）');
      check(/\.qcmd-side\s*\{[^}]*border-left:1px solid var\(--split-line\)/.test(sideCss),
        '分栏线用 --split-line（与窗格分隔线、拖拽手柄同一套语义）');
      check(/\.qcmd-side-tab:hover::before\s*\{[^}]*opacity:1/.test(sideCss),
        '悬停：握把点亮（折叠态的可发现性就靠它）');
      // 展开态：贯穿整栏的竖色条，但**收窄到 6px**（14px 整条刷蓝是被否掉的第一版）
      check(/\.qcmd-side-tab\.on::before\s*\{[^}]*top:0[^}]*bottom:0[^}]*height:auto/.test(sideCss),
        '展开态色条**贯穿整高**（不是一颗浮在中间的小珠子）');
      check(/\.qcmd-side-tab\.on::before\s*\{[^}]*left:0[^}]*margin:0/.test(sideCss) &&
            /\.qcmd-side\.open\s*\{[^}]*border-left-width:0/.test(sideCss),
        '色条**顶到面板左缘** + 展开态收掉那条 1px 分栏线：全栏只留一条竖线'
        + '（逐像素量过：两条蓝竖线并排 5px = "看着脏"的根因）');
      check(/\.qcmd-side-tab\.on::before\s*\{[^}]*width:6px/.test(sideCss) &&
            /\.qcmd-side-tab\.on::before\s*\{[^}]*background-color:var\(--btn-p\)/.test(sideCss),
        '色条宽 6px + 主题色（收窄后的"竖色条"：既贯穿整栏，又不是一堵墙）');
      check(!/\.qcmd-side-tab\.on::before\s*\{[^}]*background-image/.test(sideCss),
        '色条上不叠花纹（试过条心画浅色握把：浅色主题下白线压在浅蓝条上像"这根条断了"）');
      check(/\.qcmd-side-tab\.on:hover::before\s*\{[^}]*background-color:var\(--btn-ph\)/.test(sideCss),
        '展开态悬停再亮一档（--btn-p → --btn-ph，与 .btn-send 同一套语义）');
      check(/\.qcmd-side-tab\s*\{[^}]*width:14px/.test(sideCss),
        '折叠条自身仍是 14px —— 那是点击/拖动热区，只收窄视觉、不缩热区');
      check(!/repeating-linear-gradient/.test(sideCss) && !/background-size:1px 100%/.test(sideCss),
        '**没有**贯穿整高的虚线轨（"像沿虚线剪开"，被否掉的第三版）');
      check(!/\.qcmd-side-tab\.on::before\s*\{[^}]*opacity:0/.test(sideCss),
        '展开态不再"默认隐身"（那一版用户也不认）');
      check(/\.qcmd-side-tab\.on\.loop::after\s*\{[^}]*display:none/.test(sideCss),
        '循环指示灯只在折叠态出现（展开时标题行的循环开关本身就亮着，再点一颗就是重复装饰）');
      check(/\.qcmd-side-hd\s*\{[^}]*background:transparent/.test(html) &&
            !/\.qcmd-side-hd\s*\{[^}]*background:var\(--surface-3\)/.test(html),
        '标题行不自带底色（浅一档的色带只能从 x=14 开始，会把标题栏与面板左缘切成两截 —— 用户反馈的"割裂"）');
      check(/\.qcmd-side-src\s*\{[^}]*background:transparent/.test(html),
        '来源行同理：整块面板一个面，只用细线分隔');
      check(/\.qcmd-side\.dragging \.qcmd-side-tab::before\s*\{[^}]*var\(--btn-ph\)/.test(sideCss),
        '拖动调宽时色条再亮一档');
      check(!/accent-green/.test(sideCss),
        '折叠条不用别的语义色（绿/红等），只用主题强调色');
      check(/\.qcmd-side\.open\s*\{[^}]*width:var\(--qcmd-side-w,\s*300px\)/.test(sideCss),
        '展开态宽度走 --qcmd-side-w（缺省 300px：一条六格要放得下）：拖动只改这个变量，不写死内联宽度');
      check(/\.qcmd-side\.dragging\s*\{[^}]*transition:none/.test(sideCss),
        '拖动时去掉宽度过渡（跟手，而不是追着动画跑）');
      check(/\.qcmd-side-tab\s*\{[^}]*cursor:pointer/.test(sideCss) &&
            /\.qcmd-side-tab\.on\s*\{[^}]*cursor:col-resize/.test(sideCss),
        '光标跟着可用性走：折叠态 pointer（点击展开），展开态才是 col-resize（拖宽只在展开后启用）');
      check(/cubic-bezier/.test(sideCss), '展开/收起用缓动曲线，不是生硬的 linear');
      // 蓝色把手与中性灰悬停特异性相同，必须让 .on 写在后面才压得住
      const iOn = sideCss.indexOf('.qcmd-side-tab.on {');
      const iHover = sideCss.indexOf('.qcmd-side-tab:hover {');
      check(iOn >= 0 && iHover >= 0 && iOn > iHover,
        '展开态的把手必须写在 :hover 之后（同特异性靠顺序取胜，写反了悬停会盖掉它）');
      check(!/qcmd-side-tab-arrow/.test(html), '小三角箭头已彻底删除（HTML/CSS/JS 都不再有它）');
    }
    check(sideHtml.includes('id="main-qcmdList"') && sideHtml.includes('id="main-btnQcmdGroupAdd"'),
      '侧栏内含指令列表容器与「＋ 新建循环组」（「＋ 添加」在每组自己的表头行最右）');
    // 列标题行：值有名字才读得成一张表；轨道必须与 .qcmd-item 完全一致，否则列会错位
    {
      check(/qcmd-col-seq[^>]*>顺序</.test(html) && /qcmd-col-val[^>]*>指令</.test(html)
        && /qcmd-col-delay[^>]*>延时/.test(html) && /qcmd-col-hex[^>]*>HEX</.test(html),
      '每组一张表的表头：顺序 / 指令 / 延时(ms) / HEX');
      const itemCols = /\.qcmd-item\s*\{[^}]*grid-template-columns:([^;]+);/.exec(html);
      const colsRow = /\.qcmd-cols\s*\{[^}]*grid-template-columns:([^;]+);/.exec(html);
      check(itemCols && colsRow && itemCols[1].trim() === colsRow[1].trim(),
        '列标题与数据行用同一套 grid 轨道（写歪一个值就会全线错位）',
        (itemCols && itemCols[1]) + ' vs ' + (colsRow && colsRow[1]));
      // 列标题**每组一份**，跟文件里"一组一张表"完全对应（共用一份会夹在组抬头与数据行之间，读起来是断的）
      check(/cols\.id = mid \+ '-qcmdCols-' \+ g\.id/.test(html) && /cols\.innerHTML = qcmdColsInnerHtml\(\)/.test(html),
        '列标题每组一份（rebuildQcmdList 里按组生成，组盒子自带表头）');
      check(/function rebuildQcmdList\(mid\)\s*\{[\s\S]{0,900}cols\.innerHTML = qcmdColsInnerHtml\(\)/.test(html),
        'rebuildQcmdList 每组重建时都补上自己那张表的表头');
      // 面板里所有横向分隔线必须等长：滚动条宽 8px，列表出滚动条时内容区窄 8px，
      // 滚动容器**外面**的标题行/来源行不让出这 8px 就会长出 8px（用户圈出来的那条线）
      check(/\.qcmd-list\s*\{[^}]*scrollbar-gutter:stable/.test(html),
        '列表预留滚动条槽（行宽恒定，不会因为出滚动条而跳 8px）');
      check(/\.qcmd-side-hd\s*\{[^}]*margin-right:8px/.test(html) &&
            /\.qcmd-side-src\s*\{[^}]*margin-right:8px/.test(html),
        '标题行/来源行也让出那 8px 滚动条槽（否则它们的边线比行线长 8px）');
      check(/\.qcmd-side-hd\s*\{[^}]*justify-content:space-between/.test(html),
        '标题行分两端：左=状态（循环发送开关），右=动作（新建循环组/导入/导出）—— 用户要求按钮在右侧');
      check(/\.qcmd-list::\-webkit-scrollbar\s*\{\s*width:8px/.test(html),
        '滚动条宽 8px —— 上面两个 margin-right:8px 就是跟它对账的（改一个必须改另一个）');
      // 左端：分隔线必须从**面板左缘**拉起，而不是折叠条右边 14px 处（用户："左侧没有触及到折叠条"）
      check(/\.qcmd-side\.open \.qcmd-side-tab\s*\{[^}]*position:absolute[^}]*left:0/.test(html),
        '展开态折叠条脱离文档流：面板内容因此拿到整宽，分隔线才能从面板左缘拉起');
      check(/\.qcmd-item\s*\{[^}]*padding:5px 8px 5px 22px/.test(html) &&
            /\.qcmd-cols\s*\{[^}]*padding:3px 8px 5px 22px/.test(html),
        '数据行/列标题同款左边距 22px（= 14 折叠条 + 8 视觉留白）：线满宽、内容让开折叠条');
      check(/\.qcmd-side-tab\s*\{[^}]*z-index:3/.test(html),
        '折叠条在最上层（色条不会被任何内容盖断）');
    }
    check(!/qcmd-dropdown|qcmd-trigger|qcmd-wrap/.test(sideHtml), '侧栏里不出现旧下拉的三个类名');
    // <div> 开闭与嵌套：只数个数抓不到"重复一整块但自身平衡"这类错误（本轮真踩过），
    // 所以按出现顺序做深度扫描 —— 深度不得为负、末尾必须归零。
    // 变量注入的 HTML（closeBtn / ICONS 的 svg）自身平衡、且不含 div，不影响结果。
    function divDepth(src) {
      const re = /<div\b|<\/div>/g;
      let depth = 0, min = 0, m;
      while ((m = re.exec(src))) {
        if (m[0] === '</div>') depth--; else depth++;
        if (depth < min) min = depth;
      }
      return { depth, min };
    }
    {
      const d = divDepth(sideHtml);
      check(d.depth === 0 && d.min === 0, '侧栏 HTML 的 <div> 嵌套闭合正确', JSON.stringify(d));
    }

    check(sbSide.qcmdSideOpen('main') === false, '侧栏默认折叠');
    sbSide.toggleQcmdSide('main');
    check(sbSide.qcmdSideOpen('main') === true, '点标签展开');
    check(sideById['main-btnQcmdSide'].classList.contains('on') &&
          sideById['main-btnQcmdSide'].title === '收起快速指令（左右拖动可调宽）',
      '展开后：折叠条进入蓝色填充态（.on）+ 提示写明「拖动可调宽」', sideById['main-btnQcmdSide'].title);
    sbSide.toggleQcmdSide('main');
    check(sbSide.qcmdSideOpen('main') === false &&
          !sideById['main-btnQcmdSide'].classList.contains('on') &&
          sideById['main-btnQcmdSide'].title === '展开快速指令',
      '再点收起：蓝色填充取消、提示改回「展开」');
    sbSide.setQcmdSideOpen('main', true);
    check(sbSide.qcmdSideOpen('main') === true, 'setQcmdSideOpen(mid, true) 是可编程入口（AI/测试可直接展开）');

    // ---------- 拖折叠条调宽（分栏贴在右边缘：往左拖 = 变宽） ----------
    {
      const side = sideById['main-qcmdSide'];
      const tab = sideById['main-btnQcmdSide'];
      side.offsetWidth = 240;
      side.parentElement = { clientWidth: 900 };     // .mon-body 宽度 → 上限受 MAX 与"留 160px"约束
      check(sbSide.qcmdSideWidth('main') === 300, '分栏缺省宽度 300px', String(sbSide.qcmdSideWidth('main')));
      sbSide.startQcmdSideDrag({ button: 0, clientX: 500, preventDefault() {} }, 'main');
      check(side.classList.contains('dragging') && (docListeners.mousemove || []).length === 1,
        '按下折叠条进入拖动（加 dragging 样式 + 挂 document 监听）');
      (docListeners.mousemove || []).forEach(fn => fn({ clientX: 400 }));      // 往左拖 100px
      check(side.style.getPropertyValue('--qcmd-side-w') === '340px' && sbSide.qcmdSideWidth('main') === 340,
        '往左拖 100px → 240 变 340px（宽度跟手）', side.style.getPropertyValue('--qcmd-side-w'));
      (docListeners.mousemove || []).forEach(fn => fn({ clientX: 9000 }));     // 拖到最右
      check(sbSide.qcmdSideWidth('main') === 300,
        '拖过头：收到下限 **300px = 缺省宽度**（用户要求「最小宽度以当前的宽度为准」；六格再窄就挤成一团）',
        String(sbSide.qcmdSideWidth('main')));
      (docListeners.mousemove || []).forEach(fn => fn({ clientX: -9000 }));    // 拖到最左
      check(sbSide.qcmdSideWidth('main') === 540,
        '上限**跟着窗格走**：900px 窗格 → 最多 540px（60%），不再是写死的 640',
        String(sbSide.qcmdSideWidth('main')));
      side.parentElement = { clientWidth: 2000 };                              // 大窗口
      (docListeners.mousemove || []).forEach(fn => fn({ clientX: -9000 }));
      check(sbSide.qcmdSideWidth('main') === 1200,
        '窗格 2000px → 上限跟着涨到 1200px（固定上限在大窗口上根本拖不开）',
        String(sbSide.qcmdSideWidth('main')));
      side.parentElement = { clientWidth: 500 };                               // 窄窗格
      (docListeners.mousemove || []).forEach(fn => fn({ clientX: -9000 }));
      check(sbSide.qcmdSideWidth('main') === 300,
        '窗格只有 500px 时最多 300px（60%，且给输出区留了 200px）', String(sbSide.qcmdSideWidth('main')));
      check(sbSide.QCMD_SIDE_MAX_RATIO === 0.6 && sbSide.QCMD_SIDE_RESERVE === 160
        && sbSide.QCMD_SIDE_MIN === 300 && sbSide.QCMD_SIDE_DEFAULT === 300,
        '三个口径值都是常量，且**最小宽度 = 缺省宽度**（300px）',
        [sbSide.QCMD_SIDE_MIN, sbSide.QCMD_SIDE_DEFAULT, sbSide.QCMD_SIDE_MAX_RATIO, sbSide.QCMD_SIDE_RESERVE].join(' / '));
      check(/\.qcmd-side\.open\s*\{[^}]*min-width:300px/.test(html)
        && /\.qcmd-side\.open\s*\{[^}]*max-width:min\(60%, calc\(100% - 160px\)\)/.test(html),
        'CSS 的 min-width / max-width 兜底与 JS 同口径（300px / 60% / 160px —— 改一处必须改另一处）');
      (docListeners.mouseup || []).forEach(fn => fn({}));
      check(!side.classList.contains('dragging') &&
            (docListeners.mousemove || []).length === 0 && (docListeners.mouseup || []).length === 0,
        '松手：去掉 dragging 样式并卸掉 document 监听（不泄漏）');
      // 拖完松手浏览器会补一个 click —— 不能把刚调好宽度的分栏又收起来
      sbSide.toggleQcmdSide('main');
      check(sbSide.qcmdSideOpen('main') === true, '刚拖完那一次 click 不算点击（不会顺手收起）');
      // 折叠态按下不进入拖动（那一下的语义是"展开"）
      sbSide.setQcmdSideOpen('main', false);
      sbSide.startQcmdSideDrag({ button: 0, clientX: 100, preventDefault() {} }, 'main');
      check(!side.classList.contains('dragging') && (docListeners.mousemove || []).length === 0,
        '折叠态按下不进入拖动');
      // 再次展开：套回用户调过的宽度（宽度跨折叠/展开保留）
      sbSide.setQcmdSideOpen('main', true);
      check(side.style.getPropertyValue('--qcmd-side-w') === '300px',
        '重新展开仍用用户调过的宽度（窗格还是 500px，钳制后仍是 300px）',
        side.style.getPropertyValue('--qcmd-side-w'));
      check(tab.title.indexOf('拖动可调宽') >= 0, '展开态提示里写明可以拖动调宽', tab.title);
    }

    // 宽度随配置持久化：collectConfig / collectConfigForMonitor / applyMonitorConfig 三处都要接上
    check((html.match(/qcmdSideWidth/g) || []).length >= 4,
      '宽度进了配置链路（采集两处 + 应用一处 + 状态字段）',
      String((html.match(/qcmdSideWidth/g) || []).length));
    check(/if \(mc\.qcmdSideWidth\) setQcmdSideWidth\(mid, mc\.qcmdSideWidth\);/.test(html),
      '恢复配置时套回分栏宽度');

    // 两个生成器都真的跑一遍，直接检查"生成出来的 HTML"（而不是只扫源码文本）
    const wslHtml = sbSide.getWslMonitorHtml('wsl');
    [['createMonitorPane', mainPaneHtml, 'main'], ['getWslMonitorHtml', wslHtml, 'wsl']].forEach(([name, src, mid]) => {
      check(src.length > 1000, name + ' 真的拼出了 HTML',
        src.length + (paneCreateErr ? ' / 后段报错: ' + paneCreateErr : ''));
      // 分栏范围：只占输出区那一行 —— 工具栏 → mon-body(输出 + 侧栏) → 发送栏
      check(src.includes('class="mon-body"') && !/class="pane-body"|class="pane-main"/.test(src),
        name + ' 用 mon-body 把输出区与侧栏包成一行（不再整窗格分栏）');
      {
        const iTb = src.indexOf('class="toolbar-wrap"'), iOut = src.indexOf('class="output"');
        const iSide = src.indexOf('class="qcmd-side"'), iSend = src.indexOf('class="send-bar"');
        check(iTb >= 0 && iTb < iOut && iOut < iSide && iSide < iSend,
          name + ' 顺序为 工具栏 < 输出 < 侧栏 < 发送栏（侧栏不跨越上下两栏）',
          [iTb, iOut, iSide, iSend].join(','));
      }
      check(src.includes('id="' + mid + '-qcmdSide"') && src.includes('id="' + mid + '-qcmdList"'),
        name + ' 挂上了带列表容器的快速指令侧栏');
      check(!/qcmd-wrap|qcmd-dropdown|btnQcmd"/.test(src),
        name + ' 里没有旧下拉、也没有第二个入口（发送栏那个图标已删）');
      // 结构写坏（少一个 </div>、整块粘重）在界面上只表现为错位，很难一眼看出，这里直接卡住
      const d = divDepth(src);
      check(d.depth === 0 && d.min === 0, name + ' 生成的真实 HTML 嵌套闭合正确', JSON.stringify(d));
    });
    check(sideById['main-qcmdList'].children.length === 1
      && sideById['main-qcmdList'].children[0].className === 'qcmd-group'
      && sideById['main-qcmdList'].children[0].children[2].children.length === 1,
      '首次启动：默认 1 组，组里 1 条空指令（用户 2026-09 定的默认）',
      String(sideById['main-qcmdList'].children.length));
    check(!/qcmd-dropdown|qcmd-trigger/.test(html), '整个前端已无旧下拉的类名/引用残留');
    // 组盒子里的顺序：抬头 → **列标题（每组一份）** → 数据行。
    // 共用一份列标题会夹在"组抬头"与"数据行"之间，读起来是断的（用户 2026-09 指出的正是这里）
    {
      const box = sideById['main-qcmdList'].children[0];
      const cls = box.children.map(c => c.className);
      check(cls.length === 3 && cls[0] === 'qcmd-group-hd' && cls[1] === 'qcmd-cols' && cls[2] === 'qcmd-group-items',
        '组盒子里依次是：抬头 → 列标题 → 数据行（跟文件里"一组一张表"同形）', JSON.stringify(cls));
      const hdCls = box.children[0].children.map(c => c.className);
      check(JSON.stringify(hdCls) === JSON.stringify(['qcmd-group-grip', 'qcmd-group-sw on', 'qcmd-group-name',
        'qcmd-group-fold', 'qcmd-group-count', 'qcmd-dep-del']),
        '抬头里依次是：拖动握把（最左） · **参与开关（握把与组名之间）** · 组名(可改) · **折叠（紧挨条数左边）** · 条数 · 删组',
        JSON.stringify(hdCls));
      // 参与循环的滑动开关：在握把与组名之间，默认开（class 带 on），是 role=switch
      const swEl = box.children[0].children[1];
      check(swEl.id === 'main-qcmdSw-' + g0id() && swEl.attrs['role'] === 'switch' && swEl.attrs['aria-checked'] === 'true',
        '参与开关带 id 与 aria（默认开）', swEl.id + ' / ' + JSON.stringify(swEl.attrs));
      check(/\.qcmd-group-sw\s*\{[^}]*width:32px; height:16px[^}]*background:#525a64/.test(html)
        && /\.qcmd-group-sw::after\s*\{[^}]*width:10px; height:10px[^}]*background:#fff/.test(html)
        && /\.qcmd-group-sw\.on\s*\{[^}]*background:var\(--btn-p\)/.test(html)
        && /\.qcmd-group-sw\.on::after\s*\{[^}]*left:19px/.test(html),
        '参与开关：32×16 轨道 + **10px 白圆钮**；关闭态轨道用中性灰（浅色主题下白点才看得见）、开启态填主题色');
      check(/\.qcmd-group\.off \.qcmd-group-items/.test(html),
        '关掉的组：内容压暗（一眼看出这组不参与循环）');
      // 「＋ 添加」挂在**本组表头行的最右**（用户 2026-09 要求："应该放在 顺序、指令那一栏最右侧"）
      // 跨"发送/删除"两条轨道 + 右对齐 → 正好落在数据行那两个图标的上方
      check(box.children[1].children.length === 1
        && box.children[1].children[0].className === 'qcmd-col-add'
        && box.children[1].children[0].id === 'main-qcmdAdd-' + g0id(),
        '每组表头行最右有一个「＋ 添加」（id 带组号，作用于这一组）',
        JSON.stringify(box.children[1].children.map(c => c.className + '#' + c.id)));
      check(/\.qcmd-cols \.qcmd-col-add\s*\{[^}]*grid-column:send-start \/ del-end[^}]*justify-self:end/.test(html),
        '「＋ 添加」跨发送/删除两条轨道并右对齐（表头行最右一格）');
      // 折叠箭头与拖动握把：**CSS 画的**（字形 ▾/⠿ 在 10–12px 下几乎不可见，用户 2026-09 反馈过）
      check(/\.qcmd-group-fold\s*\{[^}]*width:18px[^}]*height:18px/.test(html)
        && /\.qcmd-group-fold::before\s*\{[^}]*border-right:1\.6px solid currentColor[^}]*transform:rotate\(45deg\)/.test(html)
        && /\.qcmd-group\.folded \.qcmd-group-fold::before\s*\{[^}]*rotate\(-45deg\)/.test(html),
        '折叠箭头是 CSS 画的 18px 按钮 + 5×5 折角（展开 ▾ / 折叠 ▸），不是小字号字形');
      const bandSrc = extractFunction('makeQcmdGroupBand') + extractFunction('toggleQcmdGroupFold');
      check(!/fold\.textContent|grip\.textContent/.test(html) && !/[⠿▾▸]/.test(bandSrc),
        '组装抬头的代码不再依赖 ▾/▸/⠿ 字形（箭头与握把都是 CSS 画的）');
      check(/\.qcmd-group-grip\s*\{[^}]*radial-gradient\(currentColor/.test(html)
        && /\.qcmd-group-grip\s*\{[^}]*width:12px[^}]*height:16px/.test(html),
        '拖动握把是 2×3 点阵（radial-gradient 平铺），可发现性不靠一个灰字');      // 折叠必须把**列标题与数据行一起**收掉（只藏数据行的话，表头会孤零零留在那儿 —— 用户 2026-09 实测发现）
      check(/\.qcmd-group\.folded \.qcmd-cols,\s*\r?\n\.qcmd-group\.folded \.qcmd-group-items\s*\{[^}]*display:none/.test(html),
        '折叠一组：列标题与数据行一起隐藏（只留抬头）');
      check(/\.qcmd-group\.folded \.qcmd-group-hd\s*\{[^}]*opacity/.test(html),
        '折叠后的抬头压暗一档（一眼看出这组是折着的）');
      // 真折一次：盒子挂上 folded、箭头旋转由 CSS 决定、标题与数据行都被 CSS 藏掉
      sbSide.toggleQcmdGroupFold('main', g0id());
      check(sbSide.qcmdGroupById('main', g0id()).folded === true, '点折叠箭头：组的 folded 状态翻成 true（CSS 据此连列标题一起藏）');
      sbSide.toggleQcmdGroupFold('main', g0id());
      check(sbSide.qcmdGroupById('main', g0id()).folded === false, '再点一下展开');
      check(box.children[0].children[2].value === '循环 1' && box.children[1].id === 'main-qcmdCols-' + g0id(),
        '组名填进输入框（抬头第 2 个孩子）、列标题 id 带组号（两组时不会撞）',
        box.children[0].children[1].value + ' / ' + box.children[1].id);
      // 「＋ 添加」用主题色（与工具栏那三个动作按钮同一套语义色），不是一个灰字
      check(/\.qcmd-cols \.qcmd-col-add\s*\{[^}]*color:var\(--link\)/.test(html)
        && /\.qcmd-cols \.qcmd-col-add:hover\s*\{[^}]*background:/.test(html),
        '「＋ 添加」用主题强调色（--link），悬停再加一层淡底 —— 与工具栏动作按钮一致');
    }

    // ---------- 标题文字 / 循环发送开关 ----------
    {
      check(!/qcmd-hd-title/.test(html) && !/>快速指令</.test(sideHtml),
        '标题文字「快速指令」已删掉（HTML 与 CSS 都不再有它）');
      check(!/qcmd-item-label/.test(html),
        '名称输入框（.qcmd-item-label）已彻底删除：HTML / CSS / 主题覆盖里都没有残留');
      const iLoop = sideHtml.indexOf('id="main-btnQcmdLoop"');
      const iAdd = sideHtml.indexOf('main-btnQcmdGroupAdd');
      check(iLoop >= 0 && iAdd > iLoop, '「循环发送」开关在动作按钮左侧（组抬头里各自带「＋ 添加」）', [iLoop, iAdd].join(','));
      check(/onclick="toggleQcmdLoop\('main'\)"/.test(sideHtml) && sideHtml.indexOf('循环发送</button>') > 0,
        '开关点一下走 toggleQcmdLoop（点一次开、再点一次关）');
      check(/title="循环发送已关闭/.test(sideHtml), '开关初态是「关闭」（文案与 QCMD_LOOP_TITLE_OFF 一致）');
      check(/\.qcmd-dh-loop\.on\s*\{[^}]*background:var\(--btn-p\)/.test(html),
        '开启态填主题色（循环发送是持续有副作用的状态，必须一眼看出来）');
      check(/\.qcmd-side-tab\.loop::after\s*\{[^}]*var\(--link\)/.test(html) && /animation:blink/.test(html),
        '折叠条在循环发送时也有可见信号（同主题色 + 一闪一闪的小点，不引入新的语义色）');
    }

    // ---------- 每条指令自己那一行：顺序号 · 内容 · 延时 · HEX · 发送 · 删除 ----------
    {
      const first = firstItemEl();
      const cls = first.children.map(c => c.className);
      check(JSON.stringify(cls) === JSON.stringify([
        'qcmd-item-seq', 'qcmd-item-val', 'qcmd-item-delay', 'qcmd-item-hex', 'qcmd-item-send', 'qcmd-item-del',
      ]), '每条的排列固定为：顺序号 · 内容 · 延时 · HEX · 发送 · 删除', JSON.stringify(cls));
      const [seqInp, valInp, delayInp, hexBtn] = first.children;
      check(seqInp.value === '0' && !seqInp.classList.contains('on'),
        '顺序号默认 0 且不高亮（0 = 不参与循环发送）', seqInp.value);
      check(delayInp.value === '1000', '延时默认 1000ms', delayInp.value);
      check(hexBtn.textContent === 'HEX' && !hexBtn.classList.contains('on'), 'HEX 使能默认关闭');
      check(seqInp.id === 'main-qcmdi-' + g0id() + '-0-seq' && delayInp.id === 'main-qcmdi-' + g0id() + '-0-delay'
        && hexBtn.id === 'main-qcmdi-' + g0id() + '-0-hex',
        '三个新控件都带 id（MCP 控件注册表按 id 枚举，少了 AI 就摸不到）');
      check(/grid-template-areas:'seq val delay hex send del'/.test(html),
        'CSS 的九宫格区域与上面的排列一一对应（列名对不上就会错位）');
      check(/\.qcmd-item\s*\{[^}]*grid-template-columns:24px minmax\(0,1fr\) 48px 34px 20px 20px/.test(html),
        '六列**全是固定宽**：内容列 minmax(0,1fr) 是唯一会缩的列。'
        + 'HEX 那列早先用 auto —— auto 是每个 grid 各按自己内容算的，表头里是文字、行里是按钮，'
        + '两边列边界都不一样，标题自然对不上格');
      // 表头现在是"每组一份"，由 qcmdColsHtml 现场拼 → 断言就跑那个函数（源码里是跨行拼接的）
      const colsHtmlOne = sbSide.qcmdColsHtml('main', 'g0');
      check(/qcmd-col-delay[^>]*>延时\s*<span class="qcmd-col-unit">\(ms\)<\/span>/.test(colsHtmlOne)
        && /id="main-qcmdCols-g0"/.test(colsHtmlOne)
        && /\.qcmd-cols \.qcmd-col-unit\s*\{[^}]*font-size:9px/.test(html),
        '延时列名带单位 `(ms)`，单位缩一号（次要信息，也让 48px 的列宽放得下）；表头 id 带组号',
        colsHtmlOne);
      check(/\.qcmd-item-hex\s*\{[^}]*width:100%/.test(html),
        'HEX 按钮撑满 34px 轨道（列标题的 HEX 照这条轨道居中，两者才重合）');
      check(/\.qcmd-cols \.qcmd-col-val\s*\{[^}]*padding-left:5px/.test(html) &&
            /\.qcmd-cols \.qcmd-col-delay\s*\{[^}]*padding-right:3px/.test(html),
        '表头单元格的盒模型照抄输入框（左/右内边距 5px / 3px）—— 字才真的对着格');
      // ---- 观感（日本排版那一套：面只留两个、数字右揃え、右缘一条线） ----
      check(/\.qcmd-item-delay\s*\{[^}]*text-align:right/.test(html) &&
            /\.qcmd-item-delay\s*\{[^}]*font-variant-numeric:tabular-nums/.test(html),
        '延时是右对齐的等宽数字（1000 / 500 / 80 的个位对齐成一条竖线）');
      check(/\.qcmd-item-seq\s*\{[^}]*font-variant-numeric:tabular-nums/.test(html) &&
            /\.qcmd-item-val\s*\{[^}]*font-variant-numeric:tabular-nums/.test(html),
        '顺序号与指令内容也用等宽数字口径');
      check(/\.qcmd-item-seq\s*\{[^}]*background:var\(--input-bg\)/.test(html),
        '顺序号的方框留着（用户点名要的顺序标识，底色常驻）');
      check(/\.qcmd-item-delay\s*\{[^}]*background:transparent/.test(html) &&
            /\.qcmd-item-delay:hover\s*\{[^}]*background:var\(--input-bg\)/.test(html) &&
            /\.qcmd-item-delay:focus\s*\{[^}]*background:var\(--input-bg\)/.test(html),
        '延时平时没有面，hover/focus 才浮出面（一行里少一个框就安静一档）');
      check(/\.qcmd-item\s*\{[^}]*border-bottom:1px solid rgba\(60,60,60,\.3\)/.test(html),
        '行分隔线压淡（.5 → .3），不再抢内容');
      check(/\.qcmd-item-send\s*\{[^}]*width:20px/.test(html) && /\.qcmd-item-del\s*\{[^}]*width:20px/.test(html),
        '发送与删除同宽（两个图标成了一对，不再一大一小）');
      check(/\.qcmd-side-hd\s*\{[^}]*padding:6px 8px/.test(html) &&
            /\.qcmd-side-src\s*\{[^}]*padding:3px 8px/.test(html),
        '标题行/来源行与数据行同为 8px 边距：右缘连成一条竖线');

      // 行为：真触发一次处理器，证明"改了会进模型"
      const m = sbSide.monitors.main;
      fire(seqInp, 'input');
      check(seqInp.value === '0' && !seqInp.classList.contains('on'), '顺序号 0 时输入处理器不改动它');
      seqInp.value = 'a01b2';
      fire(seqInp, 'input');
      check(seqInp.value === '12' && m.quickCmds[0].seq === 12 && seqInp.classList.contains('on'),
        '顺序号只收数字（去前导零），>0 时点亮并写进模型', seqInp.value + '/' + m.quickCmds[0].seq);
      seqInp.value = '';
      fire(seqInp, 'input');
      check(m.quickCmds[0].seq === 0 && !seqInp.classList.contains('on'), '清空顺序号 = 退出循环发送列表');

      delayInp.value = '2500';
      fire(delayInp, 'input');
      fire(delayInp, 'change');
      check(m.quickCmds[0].delay === 2500 && delayInp.value === '2500', '延时改动落到模型（毫秒）',
        String(m.quickCmds[0].delay));
      delayInp.value = '';
      fire(delayInp, 'change');
      check(m.quickCmds[0].delay === 1000 && delayInp.value === '1000',
        '延时被清空 → 回到缺省 1000（不是 0 毫秒疯跑）', delayInp.value);
      delayInp.value = '99999999';
      fire(delayInp, 'change');
      check(m.quickCmds[0].delay === 600000 && delayInp.value === '600000', '延时被夹到上限 10 分钟',
        delayInp.value);

      fire(hexBtn, 'click');
      check(m.quickCmds[0].hex === true && hexBtn.classList.contains('on'), '点一下 HEX：本条按 HEX 发送');
      fire(hexBtn, 'click');
      check(m.quickCmds[0].hex === false && !hexBtn.classList.contains('on'), '再点一下关闭');
      // 格式只看本条自己的开关：sendQcmdItem 里不许再出现主发送栏的 sendAsText
      const sqSrc = extractFunction('sendQcmdItem');
      check(sqSrc.indexOf('sendAsText') < 0 && /qcmdItemHex\(qcmdItemAt\(/.test(sqSrc),
        '快速指令的格式由**本条自己的 HEX 开关**决定，不再看主发送栏的文本/HEX', sqSrc);
    }

    // ---------- 循环组：新建 / 改名 / 拖动排序 / 链式计划 ----------
    {
      const gToasts = [];
      sbSide.showToast = msg => gToasts.push(String(msg));
      const before = sbSide.monitors.main.quickGroups.length;
      sbSide.addQcmdGroup('main');
      let gs = sbSide.monitors.main.quickGroups;
      check(gs.length === before + 1 && gs[gs.length - 1].items.length === 1,
        '「＋ 新建循环组」追加到最下面 + 默认带 1 条空指令（用户 2026-09 的要求）',
        JSON.stringify(gs.map(g => g.name + ':' + g.items.length)));
      check(gs[1].name === '循环 2', '新组默认名按序号走（可改）', gs[1].name);
      sbSide.renameQcmdGroup('main', gs[1].id, '初始化');
      check(sbSide.qcmdGroupById('main', gs[1].id).name === '初始化', '组名可重命名');
      // 至少留一组：删到只剩一组时拒绝
      const keepToast = gToasts.length;
      sbSide.removeQcmdGroup('main', gs[0].id);
      gs = sbSide.monitors.main.quickGroups;
      check(gs.length === 1 && gs[0].name === '初始化', '删组：删掉那一组（连同它的指令）', JSON.stringify(gs.map(g => g.name)));
      gToasts.length = keepToast;
      sbSide.removeQcmdGroup('main', gs[0].id);
      check(sbSide.monitors.main.quickGroups.length === 1 && /至少要留一组/.test(gToasts.join('|')),
        '最后一组删不掉，并说明原因（面板不能没有组）', gToasts.join('|'));
      // 链式计划：组从上到下 → 组内按顺序号（组内 0 的不参与）
      sbSide.monitors.main.quickGroups = [
        { id: 'gA', name: '第一组', items: [{ value: 'A1', seq: 2 }, { value: 'A2', seq: 0 }, { value: 'A3', seq: 1 }] },
        { id: 'gB', name: '第二组', items: [{ value: 'B1', seq: 1 }, { value: 'B2', seq: 2 }] },
      ];
      const plan = sbSide.qcmdLoopPlan('main');
      check(JSON.stringify(plan.map(s => s.gi + ':' + s.ii)) === '["0:2","0:0","1:0","1:1"]',
        '循环计划 = **组从上到下** → 组内按顺序号从小到大（那个 0 的不参与）',
        JSON.stringify(plan.map(s => s.gi + ':' + s.ii)));
      // 参与开关：关掉的组**整组不进循环计划**（顺序号原样留着，只是不发了）
      sbSide.setQcmdGroupOn('main', 'gA', false);
      check(sbSide.qcmdGroupOn(sbSide.qcmdGroupById('main', 'gA')) === false, '点开关：这一组标记为"不参与"');
      check(JSON.stringify(sbSide.qcmdLoopPlan('main').map(s => s.gi)) === '[1,1]',
        '关掉的组整组跳过 —— 计划里只剩第二组的两条',
        JSON.stringify(sbSide.qcmdLoopPlan('main').map(s => s.gi)));
      const cfgOn = sbSide.collectConfigForMonitor('main');
      check(cfgOn.quickGroups[0].on === false && cfgOn.quickGroups[1].on === true,
        '参与开关进配置（组级开关跟 folded 一样存 config.json —— 用户文件里没有这一列）',
        JSON.stringify(cfgOn.quickGroups.map(g => g.on)));
      sbSide.setQcmdGroupOn('main', 'gA', true);
      check(sbSide.qcmdLoopPlan('main').length === 4, '再点回来：整条链又完整了');      // 拖动排序：指针越过邻组中线 → 两组换位（组序就是循环顺序）
      const list = sideById['main-qcmdList'];
      // rebuild 之后才拿得到新组盒子的抬头；这里先手动重建一次
      sbSide.rebuildQcmdList('main');
      const boxA = list.children[0], boxB = list.children[1];
      const bandA = boxA.children[0], bandB = boxB.children[0];
      bandA.getBoundingClientRect = () => ({ top: 0, height: 30, bottom: 30 });
      bandB.getBoundingClientRect = () => ({ top: 30, height: 30, bottom: 60 });
      sideById['main-qcmdG-gA'] = bandA;          // 假 DOM 不会按 id 自动登记 createElement 出来的元素
      sideById['main-qcmdG-gB'] = bandB;
      sbSide.startQcmdGroupDrag({ button: 0, clientY: 40, preventDefault() {} }, 'main', 'gA');
      check(bandA.classList.contains('dragging'), '按住握把：这一组高亮（一眼看出在搬哪一组）');
      (docListeners.mousemove || []).forEach(fn => fn({ clientY: 55 }));   // 指针进到第二组下半区
      check(sbSide.monitors.main.quickGroups[0].id === 'gB' && sbSide.monitors.main.quickGroups[1].id === 'gA',
        '拖过邻组中线 → 两组换位（**拖动决定的顺序就是循环顺序**）',
        JSON.stringify(sbSide.monitors.main.quickGroups.map(g => g.id)));
      check(JSON.stringify(sbSide.qcmdLoopPlan('main').map(s => s.gi)) === '[0,0,1,1]',
        '换位后循环计划跟着变（先走新的第一组）',
        JSON.stringify(sbSide.qcmdLoopPlan('main').map(s => s.gi)));
      // 换位时**只挪节点 + FLIP 动画**，绝不 rebuildQcmdList（重建会整块替换 DOM：
      // 既没有过渡动画 —— 用户 2026-09 反馈"拖动的时候怎么没有动画" —— 又把正在拖的元素换掉）
      check(/function qcmdReorderBoxes\(mid, reorder\)/.test(html)
        && /translateY\(' \+ dy \+ 'px\)/.test(html)
        && /transition = 'transform \.18s ease'/.test(html)
        && /requestAnimationFrame/.test(html),
        '拖动换位走 FLIP：先记位置 → 重排 → 用 transform 抵掉位移 → 下一帧放开过渡（有滑动动画）');
      check(!/if \(target < 0 \|\| target === gi\) return;[\s\S]{0,600}rebuildQcmdList\(mid\)/.test(html),
        '拖动过程中不再 rebuildQcmdList（重建 = 没有动画 + 丢焦点/监听）');
      check(/\.qcmd-group\.dragging\s*\{[^}]*box-shadow/.test(html),
        '正在搬的那一组浮一档（拖动中有明确的"拿起来了"反馈）');      sbSide.endQcmdGroupDrag();
      check((docListeners.mousemove || []).length === 0 && (docListeners.mouseup || []).length === 0,
        '松手：卸掉 document 监听（不泄漏）');
      // 配置持久化：组（含组名/折叠/条目）都进 config.json
      const cfg = sbSide.collectConfigForMonitor('main');
      check(cfg && Array.isArray(cfg.quickGroups) && cfg.quickGroups.length === 2
        && cfg.quickGroups[0].name === '第二组' && cfg.quickGroups[0].items.length === 2,
        '组进了配置（组名 + 组序 + 每组的条目）', JSON.stringify((cfg && cfg.quickGroups || []).map(g => g.name)));
    }

    // ---------- MCP 侧要复用的那几个帮手（quick* 动作全走它们，别另写一套） ----------
    {
      sbSide.monitors.main.isConnected = true;   // 上面的循环用例把它设成过 false，这里复位
      // 组引用：序号 / 组名 / 组 id 都认；认不出来返回 null（**不猜** —— 猜错就是删错组）
      check(sbSide.qcmdResolveGroup('main', 0).id === sbSide.monitors.main.quickGroups[0].id,
        'qcmdResolveGroup：认组序号');
      check(sbSide.qcmdResolveGroup('main', '第二组').id === 'gB', 'qcmdResolveGroup：认组名');
      check(sbSide.qcmdResolveGroup('main', 'gB').id === 'gB', 'qcmdResolveGroup：认组 id');
      check(sbSide.qcmdResolveGroup('main', 99) === null && sbSide.qcmdResolveGroup('main', '不存在') === null
        && sbSide.qcmdResolveGroup('main', undefined) === null,
        'qcmdResolveGroup：越界/认不出来一律 null（不猜）');
      // 摊平下标 → 条目
      check(sbSide.qcmdResolveItem('main', 0).gid === 'gB' && sbSide.qcmdResolveItem('main', 9) === null,
        'qcmdResolveItem：按摊平下标取条目，越界 null');
      // 改一条：走 mcpWriteEl（写真实输入框 + 派发 input/change）→ 模型、配置文件一起更新
      sbSide.monitors.main.quickGroups = [{ id: 'gA', name: '第一组',
        items: [{ label: '', value: 'AT', seq: 0, delay: 1000, hex: false }] }];
      sbSide.rebuildQcmdList('main');
      const applied = sbSide.qcmdApplyItemPatch('main', 'gA', 0, { value: 'AT+GMR', seq: 3, delayMs: 500, hex: true });
      const patched = sbSide.monitors.main.quickGroups[0].items[0];
      check(JSON.stringify(applied) === '["value","seq","delayMs","hex"]',
        'qcmdApplyItemPatch：返回真正改动的字段名', JSON.stringify(applied));
      check(patched.value === 'AT+GMR' && patched.seq === 3 && patched.delay === 500 && patched.hex === true,
        '改动落到模型（值/顺序号/延时/HEX 四项）', JSON.stringify(patched));
      check(sideById['main-qcmdi-gA-0-val'].value === 'AT+GMR'
        && sideById['main-qcmdi-gA-0-seq'].value === '3'
        && sideById['main-qcmdi-gA-0-delay'].value === '500'
        && sideById['main-qcmdi-gA-0-hex'].classList.contains('on'),
        '四格控件都跟着变了（走的是用户手点那条路：input/change 事件）');
      check(sbSide.qcmdApplyItemPatch('main', 'gA', 0, {}).length === 0,
        '没给字段时什么都不动（返回空数组，MCP 据此报 invalidParams）');
      // 组开关 / 折叠 / 移动（MCP 的 quickGroup 用的就是这几个）
      sbSide.setQcmdGroupFold('main', 'gA', true);
      check(sbSide.qcmdGroupById('main', 'gA').folded === true, 'setQcmdGroupFold(mid, gid, true) 折起来');
      sbSide.setQcmdGroupFold('main', 'gA', false);
      check(sbSide.qcmdGroupById('main', 'gA').folded === false, 'setQcmdGroupFold(mid, gid, false) 展开');
      sbSide.monitors.main.quickGroups = [
        { id: 'g1', name: '一', items: [{}] }, { id: 'g2', name: '二', items: [{}] },
        { id: 'g3', name: '三', items: [{}] }];
      sbSide.rebuildQcmdList('main');
      sbSide.qcmdMoveGroup('main', 'g3', 0);
      check(JSON.stringify(sbSide.monitors.main.quickGroups.map(g => g.id)) === '["g3","g1","g2"]',
        'qcmdMoveGroup：把第三组挪到最前（拖动与 MCP 共用这一条路）',
        JSON.stringify(sbSide.monitors.main.quickGroups.map(g => g.id)));
      check(sbSide.qcmdMoveGroup('main', 'g2', 1) === true && sbSide.monitors.main.quickGroups[1].id === 'g2',
        '挪到自己当前位置 = 无操作但仍返回 true');
      // 循环开关的前置检查（面板开关与 MCP 共用一份文案）
      sbSide.monitors.main.quickGroups = [{ id: 'gA', name: '第一组', items: [{ label: '', value: 'AT', seq: 0 }] }];
      sbSide.rebuildQcmdList('main');
      check(/没有顺序号大于 0 的指令/.test(sbSide.qcmdLoopRefusal('main') || ''),
        'qcmdLoopRefusal：没有任何 >0 的顺序号时给出原因', String(sbSide.qcmdLoopRefusal('main')));
      sbSide.monitors.main.quickGroups[0].items[0].seq = 1;
      check(sbSide.qcmdLoopRefusal('main') === null, '有条目可发时不再拒绝');
      sbSide.monitors.main.isConnected = false;
      check(/还没打开监控/.test(sbSide.qcmdLoopRefusal('main') || ''),
        '未连接时先报"还没打开监控"（与面板那颗开关同一句话）', String(sbSide.qcmdLoopRefusal('main')));
      sbSide.monitors.main.isConnected = true;
    }
    // ---------- 辅助读法（脏配置不许把循环带崩） ----------
    {
      check(sbSide.qcmdItemSeq({}) === 0 && sbSide.qcmdItemSeq({ seq: -5 }) === 0 && sbSide.qcmdItemSeq({ seq: '7' }) === 7,
        '顺序号读法：缺省/负数 = 0，字符串也认');
      check(sbSide.qcmdItemSeq({ seq: 999999 }) === 9999, '顺序号越界夹到上限');
      check(sbSide.qcmdItemDelay({}) === 1000 && sbSide.qcmdItemDelay({ delay: 0 }) === 0
        && sbSide.qcmdItemDelay({ delay: 99999999 }) === 600000 && sbSide.qcmdItemDelay({ delay: 'abc' }) === 1000,
        '延时读法：缺省 1000 / 0 合法 / 超限夹住 / 非数字回缺省');
      check(sbSide.qcmdItemHex({}) === false && sbSide.qcmdItemHex({ hex: 1 }) === true, 'HEX 读法：非真值一律当关');
      check(sbSide.qcmdDigits('a01b2', 4) === '12' && sbSide.qcmdDigits('000') === '0' && sbSide.qcmdDigits(null) === '',
        '输入框只留数字（并去掉多余前导零，全 0 收敛成一个 0）');
    }

    // ---------- 循环发送：一条链 —— 组从上到下，组内按顺序号，发完一条等它自己的延时 ----------
    {
      const sent = [];
      const sentGroups = [];
      const loopToasts = [];
      const loopTimers = {};
      let loopTimerSeq = 0;
      sbSide.showToast = msg => loopToasts.push(String(msg));
      // 组模型：发一条 = (mid, gid, 组内下标)。记 gid 是为了能证明"按组的上下顺序走"
      sbSide.sendQcmdItem = (mid, gid, idx) => { sent.push(idx); sentGroups.push(gid); return { then() {} }; };
      sbSide.setTimeout = (fn, ms) => { const id = ++loopTimerSeq; loopTimers[id] = { fn, ms }; return id; };
      sbSide.clearTimeout = id => { delete loopTimers[id]; };
      const pendingCount = () => Object.keys(loopTimers).length;
      const runNextTimer = () => {
        const id = Object.keys(loopTimers)[0];
        if (id === undefined) return null;
        const t = loopTimers[id];
        delete loopTimers[id];
        t.fn();
        return t.ms;
      };
      const m = sbSide.monitors.main;

      m.quickCmds = [
        { label: '', value: 'AT+A', seq: 3 },
        { label: '', value: 'AT+B', seq: 0 },
        { label: '', value: 'AT+C', seq: 1 },
        { label: '', value: 'AT+D', seq: 2, delay: 500 },
      ];
      check(JSON.stringify(sbSide.qcmdLoopPlan('main').map(s => s.ii)) === '[2,3,0]',
        '计划 = 顺序号 > 0 的条目，按顺序号从小到大（顺序号 0 的不进列表）',
        JSON.stringify(sbSide.qcmdLoopPlan('main').map(s => s.ii)));

      // 前置条件不满足 → 当场拒绝，且开关留在关闭态
      m.isConnected = false;
      check(sbSide.toggleQcmdLoop('main') === false && !sbSide.qcmdLoopRunning('main')
        && /还没打开监控/.test(loopToasts[0] || ''),
        '没开监控时拒绝开循环发送，并说明原因', loopToasts.join('|'));
      m.isConnected = true;
      m.quickCmds.forEach(q => { q.seq = 0; });
      loopToasts.length = 0;
      check(sbSide.toggleQcmdLoop('main') === false && /顺序号大于 0/.test(loopToasts[0] || ''),
        '一条顺序号 > 0 的都没有时拒绝开启（不是"开着但什么都不发"）', loopToasts.join('|'));
      check(pendingCount() === 0, '被拒绝时不留定时器');

      // 正常跑：按 1 → 2 → 3 发，顺序号 0 那条永远不参与
      m.quickCmds[2].seq = 1; m.quickCmds[3].seq = 2; m.quickCmds[0].seq = 3;
      loopToasts.length = 0;
      check(sbSide.toggleQcmdLoop('main') === true && sbSide.qcmdLoopRunning('main'), '点一下打开循环发送');
      check(sideById['main-btnQcmdLoop'].classList.contains('on')
        && sideById['main-btnQcmdLoop'].title === sbSide.QCMD_LOOP_TITLE_ON,
        '开启后开关填色，提示改成「进行中：点击停止」');
      check(sideById['main-btnQcmdSide'].classList.contains('loop')
        && sideById['main-btnQcmdSide'].title.indexOf('循环发送进行中') >= 0,
        '折叠条也挂上运行标记与提示（分栏折起来时循环不会停，得有可见信号）',
        sideById['main-btnQcmdSide'].title);
      check(JSON.stringify(sent) === '[2]', '开启后立刻发顺序号最小的那条', JSON.stringify(sent));
      check(runNextTimer() === 1000, '按**本条自己的**延时排下一步（没配过 → 缺省 1000ms）');
      check(JSON.stringify(sent) === '[2,3]', '第二发 = 顺序号 2 的那条', JSON.stringify(sent));
      check(runNextTimer() === 500, '延时逐条读（这条配了 500ms）');
      check(JSON.stringify(sent) === '[2,3,0]', '第三发 = 顺序号 3 的那条（顺序号 0 的始终不参与）', JSON.stringify(sent));
      check(m.quickCmds[1].seq === 0 && sent.indexOf(1) < 0, '顺序号 0 的那条从头到尾没被发过');
      runNextTimer();
      check(JSON.stringify(sent) === '[2,3,0,2]', '一轮发完从头再来（是循环，不是只跑一遍）', JSON.stringify(sent));
      check(sentGroups.every(g => g === g0id()), '发出去的每条都带着**它所属组**的 id（组模型下不能只按下标发）', JSON.stringify(sentGroups));

      // 用户主动关：定时器立刻清掉，不再有下一发
      check(sbSide.toggleQcmdLoop('main') === false && !sbSide.qcmdLoopRunning('main') && pendingCount() === 0,
        '再点一下关闭：定时器立刻清掉');
      check(!sideById['main-btnQcmdLoop'].classList.contains('on')
        && sideById['main-btnQcmdLoop'].title === sbSide.QCMD_LOOP_TITLE_OFF,
        '关闭后开关恢复常态，提示改回「已关闭」');
      check(!sideById['main-btnQcmdSide'].classList.contains('loop')
        && sideById['main-btnQcmdSide'].title.indexOf('循环发送进行中') < 0,
        '停止后折叠条标记与提示都清掉', sideById['main-btnQcmdSide'].title);
      sent.length = 0;
      check(runNextTimer() === null && sent.length === 0, '关掉之后不会再冒出下一发');

      // 跑着的时候掉线：自愈停止（不留还在倒计时的定时器）
      sbSide.setQcmdLoop('main', true);
      sent.length = 0; loopToasts.length = 0;
      m.isConnected = false;
      runNextTimer();
      check(!sbSide.qcmdLoopRunning('main') && pendingCount() === 0 && /已断开/.test(loopToasts[0] || ''),
        '跑着的时候掉线 → 立刻自愈停止并说明（不留一个还在倒计时的定时器）', loopToasts.join('|'));

      // 跑到一半，用户把顺序号全改回 0 → 下一拍自愈停止
      m.isConnected = true;
      m.quickCmds[0].seq = 1;
      sbSide.setQcmdLoop('main', true);
      check(sbSide.qcmdLoopRunning('main') && pendingCount() === 1, '（前置）有可发的条目就能开起来');
      m.quickCmds.forEach(q => { q.seq = 0; });
      loopToasts.length = 0;
      runNextTimer();
      check(!sbSide.qcmdLoopRunning('main') && pendingCount() === 0
        && /已经没有顺序号大于 0/.test(loopToasts[0] || ''),
        '跑到一半列表里再没有可发的条目 → 自愈停止并说明', loopToasts.join('|'));

      // 从文件重载：三条发送参数按"指令内容"带回来（外部文件里没有这三列）
      m.quickCmds = [{ label: '', value: 'AT+GMR', seq: 2, delay: 250, hex: true }, { label: '', value: 'AT+RST' }];
      const parsed = sbSide.qcmdParseText('| AT+GMR |\r\n| AT+RST |\r\n| AT+NEW |');
      sbSide.qcmdCarryItemPrefs('main', parsed.items);
      check(parsed.items[0].seq === 2 && parsed.items[0].delay === 250 && parsed.items[0].hex === true,
        '重载时按指令内容带回顺序号/延时/HEX（三项只存在 config.json，不污染用户文件）',
        JSON.stringify(parsed.items[0]));
      check(parsed.items[1].seq === undefined && parsed.items[1].hex === undefined,
        '没配过的条目保持干净（不写脏字段进模型）');
      check(parsed.items[2].seq === undefined, '文件里新出现的指令没有历史设置，回到默认');

      // 反过来：这三项绝不能混进写回用户文件的内容里（文件里只有名称/指令 + 原本的额外列）
      m.quickCmds = [{ label: '查版本', value: 'AT+GMR', seq: 2, delay: 250, hex: true }];
      m._qcmdBlocks = null;
      const fileText = sbSide.qcmdCurrentText('main');
      check(fileText.indexOf('250') < 0 && fileText.indexOf('hex') < 0 && fileText.indexOf('| 2 |') < 0,
        '顺序号/延时/HEX 不会写进用户的指令文件（改文件格式会毁掉手写的备注列）', fileText);

      // 收尾：恢复成"默认 5 条"，后面的导入/写回断言依赖它
      m.quickCmds = [];
      for (let i = 0; i < 5; i++) m.quickCmds.push({ label: '', value: '', seq: 0, delay: 1000, hex: false });
      m._qcmdBlocks = null;
      m.isConnected = false;
    }

  // ---------- 快速指令外部文件：导入 / 导出 / 写回（文件即存储） ----------
  {
    // 复用上面的沙箱（同一个 monitors / DOM / 函数实例），把缺的东西补齐。
    // invoke 用"同步 thenable"替身：真 Promise 的微任务会让断言跑在回调之前，测不到结果。
    const invokeCalls = [];
    let invokeHandler = () => null;
    const okThen = v => ({ then: f => okThen(f ? f(v) : v), catch: () => okThen(v) });
    const errThen = e => ({ then: () => errThen(e), catch: f => { f(e); return okThen(undefined); } });
    const toasts = [];
    const timers = {};
    let timerSeq = 0;
    sbSide.invoke = (cmd, args) => {
      invokeCalls.push({ cmd: cmd, args: args });
      const r = invokeHandler(cmd, args);
      return (r && r.__err) ? errThen(r.__err) : okThen(r);
    };
    sbSide.showToast = (msg, type) => { toasts.push({ msg: String(msg), type: type }); };
    sbSide.setTimeout = fn => { const id = ++timerSeq; timers[id] = fn; return id; };
    sbSide.clearTimeout = id => { delete timers[id]; };
    const runTimers = () => Object.keys(timers).forEach(id => { const fn = timers[id]; delete timers[id]; fn(); });
    const pendingTimers = () => Object.keys(timers).length;
    const lastInvoke = cmd => {
      for (let i = invokeCalls.length - 1; i >= 0; i--) if (invokeCalls[i].cmd === cmd) return invokeCalls[i];
      return null;
    };

    // ---- 解析：Markdown 表格（注释/空行/表头/分隔行都要原样留着） ----
    const mdText = [
      '# Ai-WB2 出厂检查（固件 2.3.1）',
      '',
      '| 名称 | 指令 |',
      '|---|---|',
      '| 查版本 | AT+GMR |',
      '| 连接 AP | AT+CWJAP="ssid","pass" |',
      '',
      '# 只发指令的一列写法',
      '| AT+RST |',
    ].join('\r\n');
    const md = sbSide.qcmdParseText(mdText);
    check(md.style === 'md', 'Markdown 表格识别为 md 载体', md.style);
    check(md.items.length === 3 && md.items[0].label === '查版本' && md.items[0].value === 'AT+GMR',
      '表格行解析成 名称/指令', JSON.stringify(md.items[0]));
    check(md.items[1].value === 'AT+CWJAP="ssid","pass"',
      '⚠️ 逗号不当分隔符：AT+CWJAP="ssid","pass" 保持完整一条', md.items[1].value);
    check(md.items[2].label === 'AT+RST' && md.items[2].value === 'AT+RST',
      '只有一列时名称取指令本身', JSON.stringify(md.items[2]));
    check(md.skipped.length === 0, '正常文件不该有跳过行', JSON.stringify(md.skipped));
    check(sbSide.qcmdBuildText(md.blocks, md.style) === mdText,
      '往返保真：build(parse(x)) === x（注释/空行/表头/分隔行都在原位）');
    const md2 = sbSide.qcmdParseText('| 重启 | AT+RST | 备注甲 |\r\n| 竖线 | A\\|B |');
    const md2Items = md2.blocks.filter(b => b.kind === 'item');
    check(md2Items[0].cells[2] === '备注甲' && sbSide.qcmdBuildText(md2.blocks, 'md').indexOf('备注甲') >= 0,
      '第三个列（备注等额外列）原样保留并写回');
    check(md2.items[1].value === 'A|B' && sbSide.qcmdBuildText(md2.blocks, 'md').indexOf('A\\|B') >= 0,
      '单元格内的竖线按 Markdown 规范转义（读回来是 A|B）');
    check(sbSide.qcmdBuildText(md2.blocks, 'md').indexOf('| AT+RST | AT+RST |') < 0,
      '原本只写了一列的行不会被写回时复制成两列');

    // ---- 表头驱动：顺序号 / 延时 / HEX 三列（**表头写了列名才认**，绝不按列号硬塞） ----
    {
      const pText = [
        '| 名称 | 指令 | 备注 | 顺序号 | 延时(ms) | HEX |',
        '|---|---|---|---|---|---|',
        '| 查版本 | AT+GMR | 甲的备注 | 2 | 500 | hex |',
        '| 重启 | AT+RST | 乙 | 1 |  | 0 |',
      ].join('\r\n');
      const p = sbSide.qcmdParseText(pText);
      check(p.cols && p.cols.seq === 3 && p.cols.delay === 4 && p.cols.hex === 5,
        '表头认出了三列（顺序号 / 延时(ms) / HEX）', JSON.stringify(p.cols));
      check(p.items[0].seq === 2 && p.items[0].delay === 500 && p.items[0].hex === true,
        '第一行三项都读进模型', JSON.stringify(p.items[0]));
      check(p.items[1].seq === 1 && sbSide.qcmdItemDelay(p.items[1]) === 1000 && p.items[1].hex === false,
        '延时格留空 → 有效值缺省 1000；HEX 写 0 → 关', JSON.stringify(p.items[1]));
      check(p.items[1].delay === undefined,
        '留空的格子**不往模型里塞值**（写回时那一格还是空的，不硬写 1000 进用户的表）',
        String(p.items[1].delay));
      check(p.items[0].value === 'AT+GMR' && p.items[1].value === 'AT+RST', '指令列照旧');
      check(sbSide.qcmdBuildText(p.blocks, 'md') === pText, '三列表格往返保真（备注列也在原位）');
      // 改参数 → 写回只动对应那几格，备注一字不动
      p.items[0].seq = 7; p.items[0].hex = false; p.items[1].delay = 250;
      const pOut = sbSide.qcmdBuildText(p.blocks, 'md');
      check(/\| 查版本 \| AT\+GMR \| 甲的备注 \| 7 \| 500 \| false \|/.test(pOut),
        '写回按列原位更新（顺序号 7、HEX→false），备注列一字不动', pOut.split('\r\n')[2]);
      check(/\| 重启 \| AT\+RST \| 乙 \| 1 \| 250 \| 0 \|/.test(pOut),
        '延时改 250 只动那一格；没碰的 HEX 格保持用户写的 `0`（不被规范化成 text）',
        pOut.split('\r\n')[3]);
      // 列名别名
      const alias = sbSide.qcmdParseText('| 指令 | 序号 | 延迟 | 十六进制 |\r\n| AT+GMR | 3 | 800 | 是 |');
      check(alias.cols && alias.cols.value === 0 && alias.cols.seq === 1 && alias.cols.delay === 2 && alias.cols.hex === 3,
        '列名别名（序号/延迟/十六进制）也认', JSON.stringify(alias.cols));
      check(alias.items[0].seq === 3 && alias.items[0].delay === 800 && alias.items[0].hex === true
        && alias.items[0].label === 'AT+GMR',
        '别名表头下的值照读；没有名称列时名称取指令本身', JSON.stringify(alias.items[0]));
      // 危险列名：`编号`/`no` 这种很可能是用户自己的 ID 列 —— 认错就会把 A1 改写成 0
      const risky = sbSide.qcmdParseText('| 指令 | 编号 |\r\n| AT+GMR | A1 |');
      check(risky.items.length === 1 && risky.items[0].seq === undefined && risky.items[0].hex === undefined,
        '「编号」不当顺序号认（认错会把 A1 改写成 0）', JSON.stringify(risky.items));
      check(/^\| AT\+GMR \| A1 \|$/m.test(sbSide.qcmdBuildText(risky.blocks, 'md')),
        '那一列（用户的 ID/备注）原样保留', sbSide.qcmdBuildText(risky.blocks, 'md'));
      // 写回**不擅自补列**：表头没写这三列，写回就一字不多
      const noParam = sbSide.qcmdParseText('| 名称 | 指令 |\r\n| 查版本 | AT+GMR |');
      noParam.items[0].seq = 3; noParam.items[0].hex = true; noParam.items[0].delay = 50;
      check(sbSide.qcmdBuildText(noParam.blocks, 'md') === '| 名称 | 指令 |\r\n| 查版本 | AT+GMR |',
        '挂载文件表头没这三列 → 写回绝不擅自加列（用户的表结构由用户定）',
        sbSide.qcmdBuildText(noParam.blocks, 'md'));
      // 新增条目：沿用表头声明的列（不然写回会把表格撑歪）
      const parsedIns = sbSide.qcmdParseText('| 指令 | 顺序号 | 延时(ms) | HEX |\r\n|---|---|---|---|\r\n| AT+GMR | 1 | 500 | hex |');
      sbSide.monitors['t-x'] = { _qcmdBlocks: parsedIns.blocks, _qcmdCols: parsedIns.cols, quickCmds: [] };
      sbSide.qcmdInsertItemBlock('t-x', 0, { label: '', value: 'AT+NEW' });   // 组键 0 = 文件里第一张表
      const insOut = sbSide.qcmdBuildText(sbSide.monitors['t-x']._qcmdBlocks, 'md');
      check(/\| AT\+NEW \| 0 \| 1000 \| false \|/.test(insOut),
        '新条目按表头的列补齐（0 / 1000 / false），表格不会被撑歪', insOut.split('\r\n').pop());
      delete sbSide.monitors['t-x'];
    }

    // ---- 导出：**一组一张表**（自包含快照；导出→导入不丢循环配置） ----
    {
      const items = [
        { label: '', value: 'AT+GMR', seq: 2, delay: 500, hex: true },
        { label: '', value: 'AT+RST', seq: 1 },
      ];
      const groups = [{ name: '循环 1', items: items }];
      const prep = sbSide.qcmdExportPrep(groups, 'md');
      const txt = sbSide.qcmdBuildText(prep.blocks, prep.style);
      const txtLines = txt.split('\r\n');
      check(/^## 循环 1$/.test(txtLines[0]) && /^\| 顺序号 \| 指令 \| 延时\(ms\) \| HEX \|$/.test(txtLines[1]),
        '导出**一组一段**：先写 `## 组名` 抬头，再写这张表的表头（用户 2026-09 的要求）', txtLines.slice(0, 2).join(' / '));
      check(/\| 2 \| AT\+GMR \| 500 \| true \|/.test(txt) && /\| 1 \| AT\+RST \| 1000 \| false \|/.test(txt),
        '每一行的三列都是真值（缺省也写全 1000 / false；HEX 是布尔字面 true/false）', txt);
      const back = sbSide.qcmdParseText(txt);
      check(back.items.length === 2 && back.items[0].seq === 2 && back.items[0].delay === 500 && back.items[0].hex === true
        && back.items[1].seq === 1 && back.items[1].delay === 1000 && back.items[1].hex === false,
        '导出的文件回读 = 原样（导出→导入往返，循环配置不丢）', JSON.stringify(back.items));
      check(back.groups.length === 1 && back.groups[0].name === '循环 1',
        '回读时 `## 抬头` 认成组名（文件里的表 = 面板里的组）', JSON.stringify(back.groups.map(g => g.name)));
      check(back.cols && back.cols.seq !== undefined && back.cols.delay !== undefined && back.cols.hex !== undefined,
        '回读时三列都被认出来（不用再靠"按内容带回来"兜）', JSON.stringify(back.cols));
      // 导出的副本**不带「名称」列**：面板里没有名称入口，文件就该与面板一一对应
      // （用户 2026-09 报的"指令文件的内容没有和前端对应上"：文件里冒出一列 指令4/5/6/7，
      //  面板上根本没有这一栏）。挂载文件自己的名称列由**写回**路径保留，不受影响
      const withLabel = sbSide.qcmdBuildText(
        sbSide.qcmdExportPrep([{ name: '循环 1', items: [{ label: '查版本', value: 'AT+GMR', seq: 1 }] }], 'md').blocks, 'md');
      check(/^\| 顺序号 \| 指令 \| 延时\(ms\) \| HEX \|$/.test(withLabel.split('\r\n')[1]),
        '即使条目里还留着名称（从老文件读进来的），导出也不带名称列',
        withLabel.split('\r\n')[1]);
      check(!/查版本/.test(withLabel), '那个名称不会出现在导出物里');
      // 行数必须与面板对得上：**空条目也占一行**（用户报的正是"面板 7 行、文件只有 4 行"）
      const blankItems = [{ label: '指令1', value: '' }, { label: '', value: '' }, { label: '', value: 'AT+RST' }];
      const blankTxt = sbSide.qcmdBuildText(
        sbSide.qcmdExportPrep([{ name: '循环 1', items: blankItems }], 'md').blocks, 'md');
      check(blankTxt.split('\r\n').length === 3 + 3,
        '导出的行数 = 抬头 + 表头 + 分隔行 + **每条一行**（空条目也占一行，不跳）',
        String(blankTxt.split('\r\n').length));
      check(/^\| 0 \|  \| 1000 \| false \|$/m.test(blankTxt),
        '空条目的那一行写全缺省值（0 / 1000 / false），回来还是"一条"', blankTxt);
      // 导出→导入：连空条目一起原样回来（否则又是"对不上"）
      const backBlank = sbSide.qcmdParseText(blankTxt);
      check(backBlank.items.length === 3 && backBlank.items[1].value === '' && backBlank.items[1].seq === 0,
        '导出→导入：条数不变（参数格有值的空条目行不会被丢掉）',
        JSON.stringify(backBlank.items.map(i => i.value)));
      const tsv = sbSide.qcmdBuildText(sbSide.qcmdExportPrep(groups, 'tsv').blocks, 'tsv');
      check(/^## 循环 1$/.test(tsv.split('\r\n')[0]) && /^顺序号\t指令\t延时\(ms\)\tHEX$/.test(tsv.split('\r\n')[1]),
        'TSV 导出同样带抬头与三列（且没有多余的 Markdown 分隔行）', tsv.split('\r\n').slice(0, 2).join(' / '));
      check(!/\|---/.test(tsv), 'TSV 里不掺 Markdown 分隔行');
      // 多组：两组 → 两张表，中间空一行；回读要认回两个组
      const two = sbSide.qcmdBuildText(sbSide.qcmdExportPrep(
        [{ name: '初始化', items: [{ label: '', value: 'AT' }] },
         { name: '轮询', items: [{ label: '', value: 'AT+CIFSR' }] }], 'md').blocks, 'md');
      check(/## 初始化/.test(two) && /## 轮询/.test(two) && two.indexOf('## 初始化') < two.indexOf('## 轮询'),
        '多组导出：按组的上下顺序写出多张表', two);
      const twoBack = sbSide.qcmdParseText(two);
      check(twoBack.groups.length === 2 && twoBack.groups[0].name === '初始化' && twoBack.groups[1].name === '轮询'
        && twoBack.groups[0].items.length === 1 && twoBack.groups[1].items[0].value === 'AT+CIFSR',
        '多组往返：组序、组名、各组的内容都对得上',
        JSON.stringify(twoBack.groups.map(g => g.name + ':' + g.items.length)));
      // 纯指令行载体：没有非默认参数就保持原样，有参数才升级成表格
      const plainItems = [{ label: '', value: 'AT' }, { label: '', value: 'AT+GMR' }];
      check(sbSide.qcmdItemHasParams(plainItems[0]) === false && sbSide.qcmdItemHasParams(items[0]) === true,
        'qcmdItemHasParams 认得出"有没有非默认参数"');
    }

    // ---- 格式文档：doc/QUICK_CMDS.md 必须把关键规则写清楚（写文档最容易漏的就是这几条） ----
    {
      const docPath = path.join(__dirname, '..', 'doc', 'QUICK_CMDS.md');
      const doc = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';
      check(doc.length > 2000, 'doc/QUICK_CMDS.md 存在（面向使用者的文件格式说明）', String(doc.length));
      // 别名表：文档里得真的列出认得的列名（否则用户只能猜）
      const aliases = ['顺序号', '延时', 'HEX', 'cmd', 'command', 'delay', 'interval', 'order', 'seq'];
      check(aliases.every(a => doc.indexOf(a) >= 0), '文档列出了认得的列名/别名',
        aliases.filter(a => doc.indexOf(a) < 0).join(',') || '(全都有)');
      // 三件最容易踩的事：不认 ID 列、表头驱动、写回不擅自补列
      check(/编号/.test(doc) && /(不认|不识别|刻意)/.test(doc),
        '文档写明 `编号`/`no`/`num`/`index` 这类列**不认**（认错就丢数据）');
      check(/两个及以上 `#`/.test(doc) && /单个 `#`/.test(doc),
        '文档写明分组规则：≥2 个 `#` 是组抬头、单个 `#` 仍是注释');
      check(/不擅自补列/.test(doc) && /只保存在本机配置里/.test(doc),
        '文档写明"写回不擅自补列、这三项只存本机配置"');
      check(/256 KB/.test(doc) && /500/.test(doc) && /4096/.test(doc),
        '文档写明上限（256 KB / 500 条 / 4096 字符）');
      check(/true/.test(doc) && /false/.test(doc) && /宽容/.test(doc),
        '文档写明 HEX 列读写口径（读宽容、写回 true/false）');
    }
    // ---- YAML / TOML 文件头（front matter）：原样保留，且**不能**被当成指令 ----
    const fmText = [
      '---',
      'title: Ai-WB2 出厂检查',
      'baud: 115200',
      '---',
      '| 名称 | 指令 |',
      '|---|---|',
      '| 查版本 | AT+GMR |',
    ].join('\r\n');
    const fm = sbSide.qcmdParseText(fmText);
    check(fm.items.length === 1 && fm.items[0].value === 'AT+GMR',
      'YAML front matter 不会被误读成指令（曾经会多出 "baud: 115200" 这种假指令）',
      fm.items.length + ' 条: ' + fm.items.map(i => i.value).join(' | '));
    check(fm.frontKeys.join(',') === 'title,baud', '文件头的 key 被读出来（用于"暂不生效"提示）', fm.frontKeys.join(','));
    check(sbSide.qcmdBuildText(fm.blocks, fm.style) === fmText, '文件头往返保真（写回时一字不动）');
    const fmT = sbSide.qcmdParseText('+++\r\ntitle = "x"\r\n+++\r\nAT+GMR');
    check(fmT.items.length === 1 && fmT.items[0].value === 'AT+GMR' && fmT.frontKeys.indexOf('title') >= 0,
      'TOML 风格 +++ 文件头同样支持（key 也认 = 号）', fmT.frontKeys.join(','));
    const fmOpen = sbSide.qcmdParseText('---\r\nAT+GMR');
    check(fmOpen.frontUnclosed === true && fmOpen.items.length === 1 && fmOpen.items[0].value === 'AT+GMR',
      '文件头没收尾时只吃掉第一行（不能把整份文件当头部吞掉）',
      JSON.stringify({ unclosed: fmOpen.frontUnclosed, items: fmOpen.items.length }));

    // ---- 解析：TSV 与纯指令行 ----
    const tsv = sbSide.qcmdParseText('名称\t指令\r\n查版本\tAT+GMR');
    check(tsv.style === 'tsv' && tsv.items.length === 1 && tsv.items[0].label === '查版本',
      'TSV 识别为 tsv 载体（表头行跳过）', tsv.style);
    const linesText = 'AT\r\nAT+GMR\r\n# 注释\r\nAT+RST';
    const lines = sbSide.qcmdParseText(linesText);
    check(lines.style === 'lines' && lines.items.length === 3 && lines.items[1].label === 'AT+GMR',
      '纯指令行识别为 lines 载体，名称取指令本身', lines.style);
    check(sbSide.qcmdBuildText(lines.blocks, 'lines') === linesText, '纯指令行文件往返保真');

    // ---- 上限：条目数、名称、指令长度都要"跳过并说清楚" ----
    const many = [];
    for (let i = 0; i < sbSide.QCMD_FILE_MAX_ITEMS + 3; i++) many.push('AT+' + i);
    const bigParsed = sbSide.qcmdParseText(many.join('\r\n'));
    check(bigParsed.items.length === sbSide.QCMD_FILE_MAX_ITEMS && bigParsed.skipped.length === 3,
      '超过条目上限的部分被跳过并计数（不静默丢弃）',
      bigParsed.items.length + '/' + bigParsed.skipped.length);
    const longParsed = sbSide.qcmdParseText(
      '| ' + 'L'.repeat(sbSide.QCMD_FILE_MAX_LABEL + 10) + ' | ' + 'V'.repeat(sbSide.QCMD_FILE_MAX_VALUE + 10) + ' |');
    check(longParsed.items[0].label.length === sbSide.QCMD_FILE_MAX_LABEL &&
          longParsed.items[0].value.length === sbSide.QCMD_FILE_MAX_VALUE && longParsed.skipped.length === 2,
      '超长名称/指令被截断，并各记一条跳过原因', JSON.stringify(longParsed.skipped));

    // ---- 跨端一致：quick* 的每个 action，Rust 发的 op 名与前端的分支必须一一对上 ----
    // （"后端发了、前端没有"会静默失败，而两边各自测自己那一半时全是绿的）
    {
      const proto = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'mcp', 'protocol.rs'), 'utf8');
      const ops = ['quickList', 'quickRun', 'quickLoop', 'quickAdd', 'quickUpdate', 'quickRemove', 'quickGroup'];
      const missingRust = ops.filter(op => proto.indexOf('"' + op + '"') < 0);
      const missingFe = ops.filter(op => html.indexOf("action === '" + op + "'") < 0);
      check(missingRust.length === 0, 'Rust 侧认得全部 quick* op', missingRust.join(',') || '(全都有)');
      check(missingFe.length === 0, '前端 mcpSerialOp 对每个 quick* op 都有分支', missingFe.join(',') || '(全都有)');
      check(/serial_quick_cmd[\s\S]{0,1200}Some\("add"\)/.test(proto) && /Some\("group"\)/.test(proto),
        'Rust 的 action → op 映射在（add/group/loop/update/remove）');
    }
    // ---- 跨端一致：前端上限必须与 Rust 侧常量一致 ----
    const protoSrc = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'mcp', 'protocol.rs'), 'utf8');
    const usizeOf = name => {
      const m = new RegExp(name + '\\s*:\\s*usize\\s*=\\s*([0-9_]+)').exec(protoSrc);
      return m ? Number(m[1].replace(/_/g, '')) : -1;
    };
    check(sbSide.QCMD_FILE_MAX_ITEMS === usizeOf('MAX_QUICK_CMD_ITEMS') &&
          sbSide.QCMD_FILE_MAX_LABEL === usizeOf('MAX_QUICK_CMD_LABEL_CHARS') &&
          sbSide.QCMD_FILE_MAX_VALUE === usizeOf('MAX_QUICK_CMD_VALUE_CHARS'),
      '前端 QCMD_FILE_* 与 mcp 侧 MAX_QUICK_CMD_* 数值一致（跨端漂移当场红）',
      [sbSide.QCMD_FILE_MAX_ITEMS, sbSide.QCMD_FILE_MAX_LABEL, sbSide.QCMD_FILE_MAX_VALUE].join(','));

    // ---- 导入：走真实 qcmdImportFile ----
    const baseHandler = cmd => {
      if (cmd === 'quick_cmds_pick_file') return { path: 'C:\\cmds\\wb2.md', text: mdText, encoding: 'gbk', hash: 'h1' };
      if (cmd === 'quick_cmds_write_file') return { path: 'C:\\cmds\\wb2.md', hash: 'h2', encoding: 'gbk' };
      if (cmd === 'quick_cmds_read_file') {
        return { path: 'C:\\cmds\\wb2.md', text: mdText + '\r\n# 外部新增注释\r\n| 查 IP | AT+CIFSR |', encoding: 'gbk', hash: 'h3' };
      }
      if (cmd === 'quick_cmds_export_file') return { path: 'C:\\cmds\\out.md', hash: 'h4', encoding: 'utf-8' };
      return null;
    };
    invokeHandler = baseHandler;
    sbSide.qcmdImportFile('main');
    const m = sbSide.monitors['main'];
    check(m.quickCmdsFile === 'C:\\cmds\\wb2.md' && m.quickCmdsFileEnc === 'gbk' && m.quickCmdsFileStyle === 'md',
      '导入后记住 路径/编码/载体（编码沿用读入时的，写回不会把 GBK 变乱码）',
      [m.quickCmdsFile, m.quickCmdsFileEnc, m.quickCmdsFileStyle].join('|'));
    check(m.quickCmds.length === 3 && m.quickCmds[0].label === '查版本', '导入后列表来自文件');
    check(sideById['main-qcmdSrc'].children.length === 3 && sideById['main-qcmdSrc'].style.display === 'flex',
      '来源行显示 文件名 + 重载 + 断开', String(sideById['main-qcmdSrc'].children.length));
    // 来源行是 DOM API 造的，不在 sideById 里 —— 从 created 里按 id 找
    const createdIds = created.map(el => el.id).filter(Boolean);
    check(createdIds.indexOf('main-btnQcmdReload') >= 0 && createdIds.indexOf('main-btnQcmdUnmount') >= 0,
      '重载/断开按钮带 id（MCP 控件注册表按 id 枚举，少了 AI 就点不到）', createdIds.join(','));

    // ---- 核心需求：点「＋ 添加」，新条目必须写进目标文件 ----
    invokeCalls.length = 0;
    sbSide.addQcmdItem('main', g0id());
    check(pendingTimers() === 1, '添加后登记了一次"写回文件"（带 600ms 去抖）', String(pendingTimers()));
    runTimers();
    const w = lastInvoke('quick_cmds_write_file');
    check(!!w && w.args.path === 'C:\\cmds\\wb2.md', '写回的目标就是挂载的那个文件', w && w.args.path);
    // 名称已退出界面 → 刚加的空条目没有名称也没有内容：不许往用户文件里写一行空行
    check(!!w && !/\|\s*\|\s*\|/.test(w.args.text) && w.args.text.indexOf('|  |') < 0,
      '刚添加的空条目不会往用户文件里塞空行（写进去也活不过一次重载）', w && w.args.text);
    check(!!w && w.args.expectHash === 'h1', '写回带上读入时的哈希（供后端做冲突检测）', w && w.args.expectHash);
    check(!!w && w.args.text.indexOf('# Ai-WB2 出厂检查') >= 0,
      '写回保留原文件的注释（不是拿列表重新生成一份）');
    check(m.quickCmdsFileHash === 'h2', '写回成功后更新哈希（下一次写回用新哈希）', m.quickCmdsFileHash);

    // 填上内容之后，这一行才真的落进文件（"文件即存储"对**有内容**的条目依然成立）
    {
      const list = sideById['main-qcmdList'];
      // 列表 → 组盒子 → 组内指令容器（抬头/列标题之后的那个）→ 最后一条 → 内容输入框
      const box = list.children[list.children.length - 1];
      const items = box.children[2];
      const newVal = items.children[items.children.length - 1].children[1];
      newVal.value = 'AT+NEW';
      fire(newVal, 'input');
      runTimers();
      const w2 = lastInvoke('quick_cmds_write_file');
      check(!!w2 && w2.args.text.indexOf('AT+NEW') >= 0,
        '新条目填上内容后立刻写进文件（不是只改内存/配置）', w2 && w2.args.text);
    }

    // ---- 冲突：后端拒绝时只提示，不动列表 ----
    invokeHandler = cmd => (cmd === 'quick_cmds_write_file'
      ? { __err: '冲突：文件已被其它程序修改（请先「重载」再改，或「另存」到新文件）' }
      : baseHandler(cmd));
    toasts.length = 0;
    const beforeCount = m.quickCmds.length;
    sbSide.addQcmdItem('main', g0id());
    runTimers();
    check(toasts.length === 1 && toasts[0].msg.indexOf('冲突') >= 0,
      '写回冲突要提示用户（而不是静默失败）', toasts.length ? toasts[0].msg : '(无提示)');
    check(m.quickCmds.length === beforeCount + 1, '冲突不影响界面里的列表（用户改的东西还在）');
    invokeHandler = baseHandler;

    // ---- 重载：按文件为准，外部新增的行与注释都要进来 ----
    sbSide.qcmdReloadFile('main', true);
    check(m.quickCmds.length === 4 && m.quickCmds[3].value === 'AT+CIFSR', '重载后列表来自文件（含外部新增行）');
    check(sbSide.qcmdCurrentText('main').indexOf('# 外部新增注释') >= 0, '重载后新注释也会被保留');

    // ---- 导出：另存副本（不改当前目标），按挂载载体给扩展名 ----
    invokeCalls.length = 0;
    sbSide.qcmdExportFile('main');
    const ex = lastInvoke('quick_cmds_export_file');
    check(!!ex && /\.md$/.test(ex.args.defaultName) && ex.args.encoding === 'gbk' &&
          ex.args.text.indexOf('AT+CIFSR') >= 0,
      '导出：Markdown 扩展名 + 沿用挂载编码 + 内容是当前列表', ex && ex.args.defaultName);

    // ---- 断开：不再写文件（核心安全阀） ----
    sbSide.qcmdUnmountFile('main');
    check(m.quickCmdsFile === '' && sideById['main-qcmdSrc'].style.display === 'none',
      '断开后清掉路径并隐藏来源行');
    invokeCalls.length = 0;
    sbSide.addQcmdItem('main', g0id());
    check(pendingTimers() === 0 && lastInvoke('quick_cmds_write_file') === null,
      '断开后新增只写配置，不再碰文件');

    // ---- 没成功读过就不许写回（否则会拿内存列表把用户文件重写一遍、丢注释） ----
    m.quickCmdsFile = 'C:\\cmds\\wb2.md';
    m.quickCmdsFileEnc = 'gbk';
    m.quickCmdsFileStyle = 'md';
    m.quickCmdsFileHash = '';
    m.quickCmdsFileVerified = false;      // 模拟"启动时读不到文件、退回配置缓存"
    invokeCalls.length = 0;
    toasts.length = 0;
    sbSide.addQcmdItem('main', g0id());
    runTimers();
    check(lastInvoke('quick_cmds_write_file') === null && toasts.length === 1 &&
          toasts[0].msg.indexOf('还没成功读过') >= 0,
      '文件没成功读过时拒绝写回（没有内容基线，写了就丢注释）',
      toasts.length ? toasts[0].msg : '(无提示)');
    invokeHandler = cmd => (cmd === 'quick_cmds_read_file' ? { __err: '读取失败: 文件不存在' } : baseHandler(cmd));
    const keepCount = m.quickCmds.length;
    toasts.length = 0;
    sbSide.qcmdReloadFile('main', true);
    check(m.quickCmds.length === keepCount && m.quickCmdsFileVerified === false &&
          toasts.length === 1 && toasts[0].msg.indexOf('重载失败') >= 0,
      '重载失败保留现有列表并提示（绝不清空）', toasts.length ? toasts[0].msg : '(无提示)');
    invokeHandler = baseHandler;
    check(/if expect_hash\.is_empty\(\)\s*\{[\s\S]{0,160}拒绝写入/.test(
      fs.readFileSync(path.join(root, 'src-tauri', 'src', 'main.rs'), 'utf8')),
      '后端也拦一道：没有内容基线就拒绝写入（前端漏判也不至于毁用户文件）');

    // ---- 同一个文件不能被两个监视器挂载（否则互相写回打架） ----
    sbSide.monitors['extra-1'] = { quickCmds: [], quickCmdsFile: 'D:\\share\\x.md' };
    check(sbSide.qcmdFileMountedBy('D:\\share\\x.md', 'main') === 'extra-1' &&
          sbSide.qcmdFileMountedBy('D:\\share\\x.md', 'extra-1') === null,
      '挂载冲突检查能定位"另一个监视器"（排除自己）');
    delete sbSide.monitors['extra-1'];

    // ---- 配置链路：三个字段要进采集，且复制配置时必须剔除（否则两个监视器共用一份文件） ----
    const mcfg = sbSide.collectConfigForMonitor('main');
    check(mcfg && 'quickCmdsFile' in mcfg && 'quickCmdsFileEnc' in mcfg && 'quickCmdsFileStyle' in mcfg,
      'collectConfigForMonitor 带上外部文件三字段', Object.keys(mcfg || {}).filter(k => k.indexOf('quickCmdsFile') === 0).join(','));
    check(/delete cfg\.quickCmdsFile;\s*\r?\n\s*delete cfg\.quickCmdsFileEnc;\s*\r?\n\s*delete cfg\.quickCmdsFileStyle;/.test(html),
      'copyMonitorConfig 会剔除外部文件字段（两个监视器不能共用一个文件）');
    check(/if \(mc\.quickCmdsFile && monitors\[mid\]\)/.test(html) &&
          /qcmdReloadFile\(mid, true\)/.test(html),
      'applyMonitorConfig 恢复挂载并按文件重读（读不到就保留配置里的缓存）');
    check(/function qcmdFlushPendingFileSaves\(\)/.test(html) && /qcmdFlushPendingFileSaves\(\);\s*\/\/ 去抖中的/.test(html),
      '关闭窗口前会把去抖中的写回刷掉');

    // ---- 按钮位置：＋新建循环组 / 导入 / 导出 依次排在标题行右侧（「＋添加」在每组抬头里） ----
    const iAdd = sideHtml.indexOf('＋ 新建循环组'), iImp = sideHtml.indexOf('>导入<'), iExp = sideHtml.indexOf('>导出<');
    check(iAdd >= 0 && iImp > iAdd && iExp > iImp,
      '「＋新建循环组 → 导入 → 导出」按顺序排在标题行右侧（「＋添加」在每组表头行最右）', [iAdd, iImp, iExp].join(','));
    check(sideHtml.includes("qcmdImportFile('main')") && sideHtml.includes("qcmdExportFile('main')"),
      '两个按钮各自接到 qcmdImportFile / qcmdExportFile');

    // ---- 文件头里"看起来该生效"的字段要明说暂不生效（静默 no-op 比报错更坑） ----
    toasts.length = 0;
    invokeHandler = cmd => (cmd === 'quick_cmds_pick_file'
      ? { path: 'C:\\cmds\\fm.md', text: fmText, encoding: 'utf-8', hash: 'hf' } : baseHandler(cmd));
    sbSide.qcmdImportFile('main');
    check(toasts.some(t => t.msg.indexOf('baud') >= 0 && t.msg.indexOf('暂不生效') >= 0),
      '文件头里的 baud 明确提示"暂不生效"', toasts.map(t => t.msg).join(' / '));
    toasts.length = 0;
    invokeHandler = cmd => (cmd === 'quick_cmds_pick_file'
      ? { path: 'C:\\cmds\\fm2.md', text: '---\r\ntitle: x\r\nnote: y\r\n---\r\nAT+GMR', encoding: 'utf-8', hash: 'hg' }
      : baseHandler(cmd));
    sbSide.qcmdImportFile('main');
    check(!toasts.some(t => t.msg.indexOf('暂不生效') >= 0),
      '纯描述性文件头（title/note）不瞎提示', toasts.map(t => t.msg).join(' / ') || '(无提示)');
    check(/QCMD_FRONT_UNSUPPORTED/.test(html), '不可解释的 key 清单是常量（改口径只改一处）');
    invokeHandler = baseHandler;

    // ---- 端到端：**真的导出一份文件到磁盘，再把这份文件导入回来** ----
    // （用户要求"通过导出文件验证是否成功"：不能只在内存里 build/parse 自证，得让导出物落盘、回读）
    {
      const exportPath = path.join(os.tmpdir(), 'seahi-qcmd-export-verify.md');
      try { fs.unlinkSync(exportPath); } catch (e) { /* 首次运行没有这个文件 */ }
      m.quickCmds = [
        { label: '', value: 'AT+GMR', seq: 2, delay: 500, hex: true },
        { label: '', value: '01 02 03 04', seq: 1, delay: 250, hex: true },
        { label: '', value: 'AT+RST', seq: 0, delay: 1000, hex: false },
      ];
      m.quickCmdsFileStyle = 'md';
      m.quickCmdsFileEnc = 'utf-8';
      invokeCalls.length = 0;
      toasts.length = 0;
      invokeHandler = (cmd, args) => {
        if (cmd === 'quick_cmds_export_file') {
          fs.writeFileSync(exportPath, args.text, 'utf8');        // ← 真的落盘
          return { path: exportPath };
        }
        return baseHandler(cmd);
      };
      sbSide.qcmdExportFile('main');
      check(fs.existsSync(exportPath), '① 导出真的写了文件', exportPath);
      const onDisk = fs.readFileSync(exportPath, 'utf8');         // ← 从磁盘读回来
      const diskLines = onDisk.split('\r\n');
      check(/^## 循环 1$/.test(diskLines[0]) && /^\| 顺序号 \| 指令 \| 延时\(ms\) \| HEX \|$/.test(diskLines[1]),
        '① 第 1 行是组抬头，第 2 行是这张表的表头（一组一张表）', diskLines.slice(0, 2).join(' / '));
      check(diskLines.length === 6 && /^\|\s*---/.test(diskLines[2]),
        '① 抬头 + 表头 + Markdown 分隔行 + 3 条数据行', diskLines.length + ' 行 / ' + diskLines[2]);
      check(/\| 2 \| AT\+GMR \| 500 \| true \|/.test(onDisk)
        && /\| 1 \| 01 02 03 04 \| 250 \| true \|/.test(onDisk)
        && /\| 0 \| AT\+RST \| 1000 \| false \|/.test(onDisk),
        '① 每行的三列都是真值（HEX 写成布尔字面 true/false）', onDisk);
      // 手动看一眼导出物长什么样：QCMD_SHOW_EXPORT=1 node .walkthrough/gen_ble_preview.js
      if (process.env.QCMD_SHOW_EXPORT === '1') console.log('--- 导出文件实际内容 ---\n' + onDisk + '\n--- 结束 ---');

      // ② 把磁盘上这份文件当作用户选中的文件导入（走真实的 qcmdImportFile → qcmdParseText）
      invokeHandler = (cmd) => (cmd === 'quick_cmds_pick_file'
        ? { path: exportPath, text: fs.readFileSync(exportPath, 'utf8'), encoding: 'utf-8', hash: 'hx' }
        : baseHandler(cmd));
      sbSide.qcmdImportFile('main');
      // 导入成功必须只报"已加载 N 条"：**成功路径里抛异常会被 catch 变成"导入失败: TypeError..."**
      // —— 2026-09 真踩过（组模型上线后 `monitors[mid].quickCmds` 变成 null，
      // 成功提示里那句 `.length` 直接抛，于是"导入明明成功却报失败"）
      {
        const importToasts = toasts.map(t => String(t.msg));
        // 成功**一条提示都不弹**（用户要求：面板已经显示了列表，再报"已加载"只是噪音）；
        // 但也**绝不能出现「导入失败」** —— 成功路径里抛异常会被 catch 吞成失败，那种问题必须看得见
        check(!importToasts.some(t => /导入失败/.test(t)),
          '② 导入成功后不能出现「导入失败」（成功路径里抛异常会被 catch 吞成失败）',
          importToasts.join(' | '));
        check(!/showToast\('已加载 |showToast\('已重载 /.test(html),
          '成功不再弹提示（导入/重载）；失败提示保留');
        check(!/monitors\[[^\]]+\]\.quickCmds\.length/.test(html),
          '面板里不再从监视器对象上读 `quickCmds.length`（迁移后它是 null，读了就抛 —— 那个 bug 就是这么来的）');
      }
      const back = sbSide.monitors['main'].quickCmds;
      check(back.length === 3, '② 导入回来的条数对得上', String(back.length));
      check(back[0].value === 'AT+GMR' && back[0].seq === 2 && back[0].delay === 500 && back[0].hex === true,
        '② 第 1 条：指令 + 顺序号 2 + 延时 500 + HEX 开 —— 一项不丢', JSON.stringify(back[0]));
      check(back[1].value === '01 02 03 04' && back[1].seq === 1 && back[1].delay === 250 && back[1].hex === true,
        '② 第 2 条：含空格的 HEX 串原样，参数也原样', JSON.stringify(back[1]));
      check(back[2].value === 'AT+RST' && back[2].seq === 0 && back[2].delay === 1000 && back[2].hex === false,
        '② 第 3 条：顺序号 0（不参与循环）+ 延时 1000 + HEX 关', JSON.stringify(back[2]));
      check(sbSide.monitors['main']._qcmdCols && sbSide.monitors['main']._qcmdCols.seq === 0
        && sbSide.monitors['main']._qcmdCols.value === 1,
        '② 导入后列映射还在（顺序号第 0 列、指令第 1 列 —— 导出列序与面板一致）',
        JSON.stringify(sbSide.monitors['main']._qcmdCols));
      // ③ 不改任何东西，直接写回（走真实 qcmdCurrentText）→ 与磁盘上的那份**逐字节一致**
      check(sbSide.qcmdCurrentText('main') === onDisk,
        '③ 挂载后原样写回 = 导出文件逐字节一致（往返保真，不擅自改用户的表）');
      // ④ 改一个参数再写回：只有那一格变
      sbSide.monitors['main'].quickCmds[1].delay = 800;
      sbSide.monitors['main'].quickCmds[0].hex = false;
      const afterEdit = sbSide.qcmdCurrentText('main');
      check(/\| 2 \| AT\+GMR \| 500 \| false \|/.test(afterEdit) && /\| 1 \| 01 02 03 04 \| 800 \| true \|/.test(afterEdit),
        '④ 改延时/HEX 后写回只有那两格变，其余一字不动', afterEdit);
      try { fs.unlinkSync(exportPath); } catch (e) { /* 清理 */ }
      invokeHandler = baseHandler;
    }
  }
  }   // 外部文件这一段与上面的分栏断言共用同一个沙箱（sbSide 是块内 const）

  // ---------- BLE 页左栏（设备列表 / 从机配置）宽度：改窄 + 可拖 ----------
  {
    const sbBle = { console };
    vm.createContext(sbBle);
    vm.runInContext([
      /var BLE_LEFT_DEFAULT = \d+, BLE_LEFT_MIN = \d+;/.exec(html)[0],
      extractFunction('clampBleLeftWidth'),
      extractFunction('applyBleLeftWidth'),
    ].join('\n'), sbBle);
    check(sbBle.BLE_LEFT_DEFAULT === 288 && sbBle.BLE_LEFT_MIN === 240,
      '左栏默认 288px / 下限 240px（原来固定 400px，占默认窗口 38%，详情被挤太窄）',
      sbBle.BLE_LEFT_DEFAULT + '/' + sbBle.BLE_LEFT_MIN);
    check(sbBle.clampBleLeftWidth(288, 100, 200, 1047) === 388, '向右拖 = 变宽', String(sbBle.clampBleLeftWidth(288, 100, 200, 1047)));
    check(sbBle.clampBleLeftWidth(288, 100, -900, 1047) === 240, '拖到最左收到下限 240px', String(sbBle.clampBleLeftWidth(288, 100, -900, 1047)));
    check(sbBle.clampBleLeftWidth(288, 100, 5000, 1200) === 456, '上限 = 视口 38%（1200×0.38=456）', String(sbBle.clampBleLeftWidth(288, 100, 5000, 1200)));
    check(sbBle.clampBleLeftWidth(288, 0, 9999, 400) === 240, '窄视口下上限不会低于下限（Math.min/max 不打架）', String(sbBle.clampBleLeftWidth(288, 0, 9999, 400)));

    // CSS：默认宽度改了、手柄样式在、旧值不留
    check(/\.ble-left, \.ble-pf-left \{[^}]*flex:0 0 288px;[^}]*min-width:240px;[^}]*max-width:38%/.test(html),
      '主机/从机左栏共用同一条宽度规则（切模式不横向跳动）且已收窄');
    check(!/flex:0 0 400px/.test(html), '旧的 400px 固定宽度已不存在');
    check(/\.ble-left-resize \{[^}]*cursor:col-resize/.test(html) &&
          /\.ble-left-resize:hover, \.ble-left-resize\.dragging \{ background:var\(--split-line\)/.test(html),
      '左栏拖拽手柄的样式与既有两个手柄一致（col-resize + --split-line）');
    // 手柄必须是**行容器里的兄弟节点**：左栏是纵向 flex，塞进去会变成一条横线
    check(/class="ble-left-resize" id="ble-leftResize"[\s\S]{0,60}class="ble-right"/.test(html) &&
          /class="ble-left-resize" id="ble-pfResize"[\s\S]{0,60}class="ble-pf-right"/.test(html),
      '两个模式各有一个手柄，且都紧贴在左栏右边（是行容器的兄弟，不是列内子元素）');
    check(/col = handle\.previousElementSibling;/.test(html) &&
          /document\.removeEventListener\('mousemove', onMouseMove\)/.test(html) &&
          /document\.removeEventListener\('mouseup', onMouseUp\)/.test(html),
      '拖动时取左栏、松手卸掉 document 监听（不泄漏）');
    check(/applyBleLeftWidth\(\);\s*\r?\n\s*initBleLeftResize\(\);/.test(html),
      'openBle 里先套宽度再绑手柄');
    check(/leftWidth: s\.leftWidth \|\| BLE_LEFT_DEFAULT/.test(html) &&
          /_bleLeftWidth = \(typeof b\.leftWidth === 'number'/.test(html),
      '宽度进配置链路（采集 + 恢复），重启沿用');

    // MAC 直连输入框的占位符（用户要求改成这九个字）
    check(html.indexOf('placeholder="输入目标设备 MAC 直接连接"') >= 0,
      'MAC 直连输入框占位符已改为「输入目标设备 MAC 直接连接」');
    check(html.indexOf('按 MAC 直连（如 A4:C1:38:11:14:2B）') < 0, '旧的占位符文案已不存在');
  }

  // ---------- 主窗口几何记忆（PR #20）----------
  // 来龙去脉：窗口几何原来由前端存进 config.json（windowWidth/windowHeight），恢复走
  // invoke('set_window_size')，位置与最大化状态全丢。现在改成 Rust 端 window.json 统一管，
  // 并且主窗口在 tauri.conf.json 里 visible:false —— 恢复完几何再由前端 reveal。
  // 这条链路任何一环掉了都是"应用启动了但窗口不出现"，所以从后端一路断言到前端。
  {
    console.log('\n【主窗口几何记忆（PR #20）】');

    // --- 后端：window.json 的读写、事件接线、恢复保护 ---
    const winState = extractRustFn('fn window_state_file()');
    check(/d\.join\("window\.json"\)/.test(winState),
      '窗口状态落在 %APPDATA%\\seahi-serial\\window.json（不放 config.json，避免与用户配置互相覆盖）', winState);
    const loadFn = extractRustFn('fn load_window_state()');
    check(/read_to_string\(f\)[\s\S]{0,60}from_str/.test(loadFn),
      '读 window.json；解析失败当作"没有记录"（不 panic —— 这是启动路径）', loadFn);
    check(/struct SavedWindowState[\s\S]{0,220}maximized: bool/.test(mainRs),
      '保存了最大化状态（只存尺寸会让最大化用户下次起来变成小窗）');
    check(/if maximized \{\s*\r?\n\s*state\.maximized = true;/.test(mainRs) &&
          /state\.maximized = false;[\s\S]{0,80}if !minimized \{/.test(mainRs),
      '最大化时只翻标志、保留最近一次普通几何；最小化时不改写（系统会给 -32000 哨兵坐标）');
    check(/window\.outer_position\(\)/.test(mainRs) && /window\.inner_size\(\)/.test(mainRs),
      '位置存外框坐标、尺寸存内尺寸（存错一个就会每次开关窗口都往右下漂移）');
    check(/if !force && !window\.is_visible\(\)\.unwrap_or\(false\) \{\s*\r?\n\s*return;/.test(mainRs),
      '非强制自动保存只在窗口可见时执行（隐藏期恢复几何的瞬时态不能写盘）');
    check(/prev\.elapsed\(\) < std::time::Duration::from_millis\(400\)/.test(mainRs),
      '拖动/缩放去抖 400ms（不能每帧写盘）');
    check(/tauri::WindowEvent::Moved\(_\) \| tauri::WindowEvent::Resized\(_\)[\s\S]{0,120}window_auto_save\(window, false\)/.test(mainRs) &&
          /tauri::WindowEvent::CloseRequested \{ \.\. \}[\s\S]{0,120}window_auto_save\(window, true\)/.test(mainRs),
      'Moved/Resized 去抖保存，CloseRequested 强制保存最终几何（退出前最后一下也要留住）');
    check(/ow >= 60 && oh >= 40/.test(mainRs) && /fn rect_on_screen/.test(mainRs),
      '恢复位置前先判"至少露出 60×40 可操作区"，否则拔掉外接屏后窗口落在不可见的虚拟屏上');
    check(/if restore_pos && rect_on_screen\(window\.app_handle\(\), state\.x, state\.y, width, height\)/.test(mainRs),
      '位置只有"有 window.json 记录且落在屏内"才恢复');
    check(/fn apply_window_state\(window: &tauri::WebviewWindow\)/.test(mainRs) &&
          /apply_window_state\(&win\);/.test(mainRs),
      'setup 里（设完最小尺寸之后）恢复一次几何');
    check(/fn reveal_main_window\(/.test(mainRs) && /\n\s+reveal_main_window,\r?\n/.test(mainRs),
      'reveal_main_window 命令实现且已注册进 invoke_handler（漏注册 = 窗口永远不显示）');
    check(/fn set_window_size\(/.test(mainRs) && /\n\s+set_window_size,\r?\n/.test(mainRs),
      'set_window_size 命令本身留着（BLE 页仍在用它做最小尺寸兜底）');
    check(/std::thread::sleep\(std::time::Duration::from_millis\(4000\)\)[\s\S]{0,320}w\.is_visible\(\)/.test(mainRs),
      '后端 4 秒兜底：前端没能调 reveal 时也要把窗口显示出来');

    // 迁移兜底：老用户只在 config.json 里有尺寸，读不到 window.json 时别把尺寸重置掉
    check(/fn legacy_window_state_from_config_json/.test(mainRs) &&
          /legacy_window_state_from_config\(\)/.test(mainRs),
      '旧版本 config.json 的 windowWidth/windowHeight 作为迁移兜底（升级后第一次启动不改尺寸）');
    check(/let \(state, restore_pos\) = match load_window_state\(\) \{\s*\r?\n\s*Some\(s\) => \(s, true\),/.test(mainRs),
      'window.json 命中才恢复位置；旧字段没有位置，用 (0,0) 会把窗口顶到左上角');

    // --- 前端：reveal 时机 + 旧恢复路径确实删掉了 ---
    const revealFn = extractFunction('revealMainWindow');
    check(/invoke\('reveal_main_window'\)/.test(revealFn),
      'revealMainWindow() 走 reveal_main_window 命令（不是 window.show —— 权限只开了 core:*）', revealFn);
    const revealCalls = (html.match(/revealMainWindow\(\);/g) || []).length;
    check(revealCalls >= 3,
      '启动成功、初始化异常、以及兜底页三条路径都调 revealMainWindow（少一条 = 那种情况下窗口不出现，'
      + '用户看到"启动了但没窗口"）', '调用点 ' + revealCalls + ' 处');
    check(/function showFatalError\(title, detail\) \{[\s\S]{0,420}revealMainWindow\(\)/.test(html),
      'showFatalError 内部自己兜一道（8 秒看门狗那条路不经过 DOMContentLoaded 的 catch）');
    check(/loadAndApplyConfig\(\);[\s\S]{0,400}?revealMainWindow\(\);/.test(html),
      '配置恢复（含 Rust 端几何恢复）之后才 reveal，避免"先显示再跳变"');
    check(!/cfg\.windowWidth && cfg\.windowHeight/.test(html),
      '前端旧的 set_window_size 恢复已删除（两处都设尺寸就会二次跳变）');
    check(/if \(_cachedWindowSize\) \{\s*\r?\n\s*cfg\.windowWidth = _cachedWindowSize\[0\];/.test(html) &&
          /out = \{ width: snap\.windowWidth, height: snap\.windowHeight \};/.test(html),
      'windowWidth/windowHeight 仍在采集（别删：MCP 的 ui_get_state(window) 读它，迁移兜底也读它）');
  }

  console.log(`\n结果: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
