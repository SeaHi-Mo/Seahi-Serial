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
  vm.runInContext(extractFunction('collectBleState'), sbBle);
  const norm = sbBle.collectBleState({ monitor: 1, monitorWidth: 0, openSvcs: ['A'], filterText: 'x' });
  check(norm.monitor === true && norm.monitorWidth === 380 && norm.advOpen === false
     && norm.filterOpen === false && norm.selected === '' && norm.monitorCfg === null,
    'collectBleState 归一化并补默认值（宽度 0 → 380，缺省字段给安全值）', JSON.stringify(norm));
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
  // 主机 / 从机 左栏宽度必须一致
  check(/\.ble-left, \.ble-pf-left \{/.test(html) && /flex:0 0 400px; min-width:320px; max-width:46%;/.test(html),
    '两种模式的左栏共用同一套宽度（切模式布局不跳）');
  const pfLeftRule = /^\.ble-pf-left \{[^}]*\}/m.exec(html);
  check(!!pfLeftRule && !/width:/.test(pfLeftRule[0]),
    '从机左栏不再自带宽度（否则和主机左栏不一致）', pfLeftRule ? pfLeftRule[0] : '(没有这条规则)');
  // 滚动条：从机模式下所有可滚动区都套上统一样式
  check(/\.ble-pf-left::-webkit-scrollbar,/.test(html) && /\.ble-pf-chars::-webkit-scrollbar \{/.test(html),
    '从机左栏与特征列表都套上统一滚动条样式（默认那条又宽又亮，很丑）');
  check(/\.ble-log::-webkit-scrollbar,\s*\n\.ble-pf-left::-webkit-scrollbar,/.test(html),
    '滚动条规则与日志区共用同一份，风格一致');
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

  console.log(`\n结果: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
