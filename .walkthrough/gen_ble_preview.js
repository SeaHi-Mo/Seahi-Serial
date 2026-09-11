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
  const logEl = { textContent: '', scrollTop: 0, scrollHeight: 10 };
  sb3.document = { getElementById: (id) => (id === 'ble-log' ? logEl : null) };
  vm.createContext(sb3);
  vm.runInContext(['logBle', 'renderBleLog', 'clearBleLog'].map(extractFunction).join('\n'), sb3);
  sb3.logBle('[连接中] X');
  sb3.logBle('[连接成功] X · 服务 5 · 特征 8');
  check(sb3._bleLog.length === 2, 'logBle 追加日志', String(sb3._bleLog.length));
  check(logEl.textContent.indexOf('[连接成功] X') >= 0, 'renderBleLog 把内容贴到 DOM');
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
    extractObject('BLE_DESC_NAMES'),
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
  check(sb6._bleLog.length === 1 && sb6._bleLog[0].indexOf('[已断开]') === 0,
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

  console.log(`\n结果: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
