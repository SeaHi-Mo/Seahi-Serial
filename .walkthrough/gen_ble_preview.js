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
  vm.runInContext([extractFunction('bleRssiColor'), extractFunction('applyLiveRssi')].join('\n'), sb2);

  check(sb2.bleRssiColor(-50, false) === 'var(--accent-green)', 'RSSI -50dBm → 绿');
  check(sb2.bleRssiColor(-60, false) === 'var(--accent-orange)', 'RSSI -60dBm → 橙');
  check(sb2.bleRssiColor(-80, false) === 'var(--accent-red)', 'RSSI -80dBm → 红');
  check(sb2.bleRssiColor(-80, true) === '#fff', 'RSSI 选中态 → 白');
  sb2.applyLiveRssi('AA:BB:CC:DD:EE:01', -52);
  check(sb2._bleDevices[0].rssi === -52, 'applyLiveRssi 更新设备对象 rssi', String(sb2._bleDevices[0].rssi));
  check(sb2._txt.textContent === '-52 dBm', 'applyLiveRssi 更新卡片 RSSI 文字', sb2._txt.textContent);
  check(sb2._meta.textContent.indexOf('-52 dBm') >= 0, 'applyLiveRssi 更新详情头部', sb2._meta.textContent);

  // ---- 5b) 订阅状态必须随连接复位（未连接清空；连接仍在则保留）----
  const mkSync = (connAddr) => {
    const s = {
      console, _bleServices: [], _bleSelected: null, _bleConnAddr: 'STALE',
      _bleSubs: { 'AAAA::notify': true }, _cleared: 0,
    };
    s.stopBleNotifyPoll = () => {}; s.stopBleRssiPoll = () => {};
    s.startBleNotifyPoll = () => {}; s.startBleRssiPoll = () => {};
    s.clearBleLog = () => { s._cleared++; };
    s.logBle = () => {};
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

  // ---- 5c) 数据日志：追加 / 清空（切设备、断开时调用 clearBleLog）----
  const sb3 = { console, _bleLog: [], _bleLogMax: 400, _bleSelected: 'AA:BB:CC:DD:EE:01' };
  const logEl = { textContent: '', innerHTML: '', scrollTop: 0, scrollHeight: 10 };
  sb3.document = { getElementById: (id) => (id === 'ble-log' ? logEl : null) };
  vm.createContext(sb3);
  vm.runInContext(['logBle', 'bleLogToHtml', 'escapeHtml', 'renderBleLog', 'clearBleLog'].map(extractFunction).join('\n'), sb3);
  sb3.logBle('[连接中] X');
  sb3.logBle('[连接成功] X · 服务 5 · 特征 8');
  check(sb3._bleLog.length === 2, 'logBle 追加日志', String(sb3._bleLog.length));
  check(logEl.innerHTML.indexOf('[连接成功] X') >= 0, 'renderBleLog 把内容贴到 DOM（innerHTML，已转义）');
  sb3.clearBleLog();
  check(sb3._bleLog.length === 0 && logEl.textContent === '暂无日志',
    'clearBleLog 清空并显示占位', logEl.textContent);
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
  check(/标题区分特征 \/ 描述符/.test(html), '标题按目标区分特征/描述符（UUID 副标题删除后的信息补偿）');
  check(/id="bleWriteTitle">写入特征值</.test(html), '标题默认「写入特征值」');
  check(/bleWriteTitle'\)[\s\S]{0,120}'写入描述符值'/.test(html), '描述符写入时标题变「写入描述符值」');
  check(/inp0\.placeholder = \(kind === 'desc' && shortUuid\(uuid\) === '2902'\)/.test(html),
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
  check(/var leLog = \(hexMode \|\| leVal === 'none'\) \? '' : ' · 行尾 ' \+ leVal\.toUpperCase\(\);/.test(html),
    '日志里标明追加的行尾');
  check((html.match(/\+ leLog \+/g) || []).length === 2, '特征与描述符两条发送日志都带上行尾信息');

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
  check(/logBleDim\(label \+ bleFmtBytes\(bytes\) \+ ' · ', hex\);/.test(html),
    '文本可读时：文本 + 灰色十六进制（用 logBleDim 追加灰显段）');
  check(/\.ble-log-dim \{ color:var\(--text-d\); \}/.test(html), '灰色段有对应样式 .ble-log-dim');
  check(/logBle\(label \+ hex\);/.test(html), '二进制/解析失败时仍直接显示十六进制');
  check(/function logBleDim\(text, dim\)/.test(html) && /_bleLog\.push\(\{ text: text, dim: dim \}\)/.test(html),
    'logBleDim 以结构化条目入缓冲（{text, dim}）');
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

  console.log(`\n结果: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
