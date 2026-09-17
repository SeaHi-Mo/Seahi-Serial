/**
 * 生成 `src/js/81-ble-uuids.js` —— 前端那两张 UUID 名称表（服务 / 特征）。
 *
 * ## 为什么要生成，而不是手写
 * 手写表曾经只有 **9 条特征**，而 SIG 公报的特征有 **512 条**：不全、也会慢慢过期
 * （用户的追问："这个表足够完整吗？"）。表里的东西是**事实数据**（UUID ↔ 官方名称），
 * 事实就该由数据生成、由一条命令刷新，而不是靠人手敲 —— 手敲既不全，也没法跟进更新。
 *
 * ## 数据来源与为什么**不**把源文件放进仓库
 * 源是 Bluetooth SIG 官方公开仓库（`bluetooth-SIG/public`）的 `assigned_numbers/uuids/*.yaml`：
 *     https://bitbucket.org/bluetooth-SIG/public/src/HEAD/assigned_numbers/uuids/
 * 那份 YAML 的抬头写得很清楚：**"This document is proprietary to Bluetooth SIG … The furnishing
 * of this document does not grant any license"** —— 所以**源文件不进仓库**（不能随产品再分发），
 * 只有"生成物"（我们自己的 JS 表）进仓库，而生成是开发者本地跑一条命令的事。
 * 这一点和 Nordic 的 BSD-3 镜像不同（后者可再分发，但它只是个镜像：实测比 SIG 少 8 个服务、
 * 60 条特征，还留着 23 条已废止的旧编号，用它当源反而更差）。
 *
 * ## 用法
 *     node .walkthrough/gen_ble_uuids.js                 # 联网抓 SIG（默认）
 *     node .walkthrough/gen_ble_uuids.js --from <目录>    # 离线：读目录里已经存好的 yaml
 *     node .walkthrough/gen_ble_uuids.js --check          # 只比对，不写文件（看有没有更新）
 *
 * 目录里需要 `service_uuids.yaml` 与 `characteristic_uuids.yaml` 两个文件。
 * ⚠️ 生成物**必须一起提交**：应用没有构建步骤，跑起来直接加载这个文件；不提交的话
 * 前端就少了这两张表（名字全没了）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'js', '81-ble-uuids.js');
const SIG_BASE = 'https://bitbucket.org/bluetooth-SIG/public/raw/HEAD/assigned_numbers/uuids/';
const SIG_TREE = 'https://bitbucket.org/bluetooth-SIG/public/src/HEAD/assigned_numbers/uuids/';

// ---------------------------------------------------------------------------
// 非 SIG 分配的补遗（**手工维护**，每次生成原样并进表尾）
//
// 这里只放"SIG 的官方 YAML 里没有、但我们现在就想显示名字"的条目，而且必须能说清出处。
// 现状是两条厂商私有 UUID + 一条厂商成员 16 位号：
//   · `FE59` = Nordic Secure DFU（**成员 16 位 UUID**，在 SIG 的 `member_uuids.yaml` 里，
//     但那份表给的是"成员公司名"而不是服务名，与本表的用途不同，所以留在这里手写）；
//   · `6E400001-…` = Nordic UART Service（厂商自定义 128 位 UUID，不是 SIG 分配）。
// 补遗**不影响**"查不到就按原样处理"那条兜底：兜底逻辑在 81-ble.js 里，一行都没动。
// ---------------------------------------------------------------------------
const SVC_EXTRA = {
  FE59: 'Nordic DFU',
  '6E400001-B5A3-F393-E0A9-E50E24DCCA9E': 'Nordic UART',
};

/**
 * 解析 SIG 的 YAML：逐条取 `- uuid: 0xXXXX` 紧跟的 `name:`（不引入 YAML 依赖）。
 *
 * ⚠️ 格式细节别想当然：条目是**缩进过的** ` - uuid: 0x1800`（破折号前面还有空格），
 * 字段缩进 3 个空格。第一版按 `\n- uuid:` 切块，结果整份文件只解析出 1 条
 * （0x1800 有名字、180A 直接 undefined）—— 所以这里用"uuid 与 name 相邻"的全局扫描。
 */
function parseSigYaml(text, what) {
  const out = [];
  const re = /\s*-\s*uuid:\s*0x([0-9A-Fa-f]+)\s*\n\s*name:\s*([^\n]+)/g;
  for (const m of text.matchAll(re)) out.push({ uuid: m[1], name: cleanName(m[2]) });
  if (!out.length) throw new Error(`${what}: 一条都没解析出来（YAML 格式变了？）`);
  return out;
}

/**
 * 名称清洗：只做**机械**的去标记，不做逐条手改（手改就等于把"生成"又变回"手写"）。
 * 目前只会命中一条：`CO\textsubscript{2} Concentration` —— 那是规范文档里的排版标记，
 * 直接显示会是一串反斜杠。
 */
function cleanName(raw) {
  return String(raw)
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .replace(/\\{1,2}textsubscript\{(\w+)\}/g, '$1')
    .replace(/\\{1,2}textsuperscript\{(\w+)\}/g, '$1')
    .replace(/\s+/g, ' ');
}

/** 表键：SIG 给的是 16 位码（0x1800）；原样大写。位数异常的直接报错（防解析错） */
function toKey(uuid) {
  const u = uuid.toUpperCase();
  if (!/^[0-9A-F]{4}$/.test(u)) throw new Error(`uuid 不是 16 位码：${uuid}`);
  return u;
}

/** 生成一段 `var NAME = {\n  'K': 'V',\n};`（键用引号，结尾 `\n};` 是断言集抽取对象时依赖的形状） */
function emitTable(name, obj, note) {
  // 单引号是前端里的既有风格；名称里若真出现单引号/反斜杠就退回 JSON 转义（不会漏转义）
  const q = (s) => (/['\\]/.test(s) ? JSON.stringify(s) : `'${s}'`);
  const keys = Object.keys(obj).sort();
  const lines = keys.map((k, i) => `    '${k}': ${q(obj[k])}${i === keys.length - 1 ? '' : ','}`);
  return `// ${note}（${keys.length} 条）\nvar ${name} = {\n${lines.join('\n')}\n};\n`;
}

async function load(what, file, fromDir) {
  if (fromDir) {
    const p = path.join(fromDir, file);
    if (!fs.existsSync(p)) throw new Error(`--from 目录里没有 ${file}：${p}`);
    return fs.readFileSync(p, 'utf8');
  }
  const r = await fetch(SIG_BASE + file);
  if (!r.ok) throw new Error(`抓 ${file} 失败：HTTP ${r.status}`);
  return r.text();
}

async function headCommit(fromDir) {
  if (fromDir) return '(离线，未取)';
  for (const url of [
    'https://api.bitbucket.org/2.0/repositories/bluetooth-SIG/public/commits?pagelen=1',
    'https://api.bitbucket.org/2.0/repositories/bluetooth-SIG/public/commits/HEAD',
  ]) {
    try {
      const j = await (await fetch(url)).json();
      const hash = j.hash || (j.values && j.values[0] && j.values[0].hash) || '';
      if (hash) return hash.slice(0, 12);
    } catch (_) { /* 换下一个端点；都取不到就写"(未知)"，不影响生成 */ }
  }
  return '(未知)';
}

/** 自检：这些锚点错了就说明源变了/解析坏了，宁可直接失败也别把错表写出去 */
function selfCheck(svc, chr) {
  const must = [
    [svc, '1800', 'GAP'],
    [svc, '180A', 'Device Information'],
    [chr, '2A00', 'Device Name'],
    [chr, '2A19', 'Battery Level'],
    [chr, '2A24', 'Model Number String'],
    [chr, '2A26', 'Firmware Revision String'],
  ];
  for (const [t, k, want] of must) {
    if (t[k] !== want) throw new Error(`自检失败：${k} 期望 "${want}"，实际 ${JSON.stringify(t[k])}`);
  }
  // CTS 三件套：界面/MCP 的 CTS 解读依赖它们有名字（0x1805 服务 + 3 个特征）
  for (const k of ['2A2B', '2A0F', '2A14']) {
    if (!chr[k]) throw new Error(`自检失败：CTS 特征 ${k} 不在表里（CTS 那条链路要靠它）`);
  }
  // FF00 是"泛化的厂商私有"，**必须继续**落在兜底分支上（断言集里有一条守着）
  if (svc.FF00 || chr.FF00) throw new Error('自检失败：FF00 不该出现在表里');
  if (Object.keys(svc).length < 70) throw new Error(`自检失败：服务只有 ${Object.keys(svc).length} 条，像是源被截断了`);
  if (Object.keys(chr).length < 500) throw new Error(`自检失败：特征只有 ${Object.keys(chr).length} 条，像是源被截断了`);
}

(async () => {
  const fromIdx = process.argv.indexOf('--from');
  const fromDir = fromIdx > 0 ? process.argv[fromIdx + 1] : '';
  const checkOnly = process.argv.includes('--check');

  const svcRaw = parseSigYaml(await load('服务', 'service_uuids.yaml', fromDir), 'service_uuids.yaml');
  const chrRaw = parseSigYaml(await load('特征', 'characteristic_uuids.yaml', fromDir), 'characteristic_uuids.yaml');

  const svc = {};
  const chr = {};
  for (const e of svcRaw) svc[toKey(e.uuid)] = e.name;
  for (const e of chrRaw) chr[toKey(e.uuid)] = e.name;
  for (const [k, v] of Object.entries(SVC_EXTRA)) svc[k] = v;
  selfCheck(svc, chr);

  const body =
    emitTable('BLE_SVC_NAMES', svc, 'GATT 服务名（Bluetooth SIG 官方 assigned numbers；含表尾的非 SIG 补遗）') +
    '\n' +
    emitTable('BLE_CHAR_NAMES', chr, 'GATT 特征名（Bluetooth SIG 官方 assigned numbers）');

  const header = [
    '// ⚠️ 本文件由 `.walkthrough/gen_ble_uuids.js` **生成** —— 别手改（下次生成会覆盖）。',
    '//',
    '// 数据来源：Bluetooth SIG 官方公开仓库的 assigned_numbers/uuids/*.yaml',
    `//   ${SIG_TREE}`,
    `//   HEAD 提交 ${await headCommit(fromDir)} · 生成于 ${new Date().toISOString().slice(0, 10)}`,
    `//   服务 ${Object.keys(svc).length} 条（其中非 SIG 补遗 ${Object.keys(SVC_EXTRA).length} 条）`,
    `//   特征 ${Object.keys(chr).length} 条`,
    '// 重新生成：node .walkthrough/gen_ble_uuids.js',
    '//',
    '// 为什么不是手写：手写表只有 9 条特征，SIG 公报的有 512 条 —— 不全，也没法跟进更新。',
    '// 表里是**事实数据**（UUID ↔ 官方名称），就该由数据生成。',
    '// 用法见 81-ble.js 里那两处引用；"查不到怎么办"的兜底逻辑在 81-ble.js，不在本文件。',
    '',
  ].join('\n');

  if (checkOnly) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    console.log(cur === header + body ? '✅ 已是最新（生成物与 SIG 当前数据一致）' : '⚠️ 生成物与 SIG 当前数据不一致，跑一次不带 --check 的命令即可更新');
    return;
  }
  fs.writeFileSync(OUT, header + body);
  console.log(`已生成 ${path.relative(ROOT, OUT)}：服务 ${Object.keys(svc).length} 条 / 特征 ${Object.keys(chr).length} 条`);
  if (!svc['1800'] || !chr['2A00']) console.log('（自检通过：关键锚点都在）');
})().catch((e) => {
  console.error('生成失败：' + e.message);
  process.exit(1);
});
