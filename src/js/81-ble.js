/* 81-ble.js —— 前端第 11 块，拆自原单文件 src/index.html（**纯搬家**；行号映射见 doc/FRONTEND_LAYOUT.md）。
   ⚠️ **普通脚本**（不是 ESM）：按 index.html 里的 <script src> 顺序加载、共享同一个全局作用域 —— 行内 onclick
   与现有函数互相调用照旧；**别改成 type="module"**（模块作用域会让它们全部失效）。 */
/* ===== 蓝牙(BLE) 调试面板（前端壳） ===== */
var _bleDevices = [];     // 当前扫描到的设备
// 已连接设备的展示信息（名称/类型等）。连接后设备常常停止广播，
// 之后重新扫描列表里就没有它了 —— 详情面板靠 _bleDevices 定位，会因此空掉，
// 所以这里留一份记录，刷新时把它补回列表。
var _bleConnInfo = null;
var _bleSelected = null;  // 选中设备的 address
var _bleScanning = false;
var _bleSubs = {};  // 订阅/功能启用状态：key = uuid::prop -> true/false（notify/indicate 布尔开关）
var _bleOpenSvcs = {};  // 已展开的 GATT 服务 uuid（连接/断开重建后恢复展开）
var _bleAdvOpen = false;  // 广播内容是否展开（重建后恢复）
var _bleFilterText = '';  // 设备过滤关键字（名称或 MAC）
var _bleFilterOpen = false;  // 过滤区是否展开
var _bleServices = [];     // 当前连接设备的 GATT 服务树（ble_get_services）
var _bleConnAddr = null;   // 后端真实已连接设备地址（ble_get_connection），切页回来恢复用
var _bleConnecting = false; // 连接进行中门闩：防止连点对同一设备重复 connect
var _bleLog = [];          // 数据日志缓冲（只反映「当前设备本次会话」，切设备/断开都会清空）
var _bleLogMax = 400;      // 日志上限，避免长时间运行无限增长
var _bleLogSeq = 0;        // 条目的**稳定编号**：缓冲满会丢最旧，数组下标会整体前移，
                           // 所以 seq 必须在**写入时**发号（ble_get_output 的 sinceSeq 认它）
var _bleDevTimer = null;   // 扫描期间设备列表刷新定时器
var _bleNotifyTimer = null;  // 通知轮询定时器
var _bleRssiTimer = null;    // 已连接设备的 RSSI 刷新定时器
// 系统里的蓝牙适配器数量（多适配器时后端会把扫描开到每一个上）
var _bleAdapterCount = 0;
// 协商后的 ATT MTU（后端 ble_get_mtu）。默认 23 → 有效载荷 20 字节，
// 写长数据失败时靠它分辨"是 MTU 还是特征的问题"
var _bleMtu = 0;
// 扫描自动停止时长（秒），0 = 持续。从 DOM 读，DOM 还没建时用配置里的值。
var _bleScanSecs = 15;
var BLE_RSSI_INTERVAL = 3000;  // RSSI 刷新间隔（ms）：后端每次会做一次约 800ms 的短扫描脉冲
// 连接显式超时（ms）：WinRT 的 connect 在设备无响应时可能长时间不返回，
// 靠这个超时给出明确失败提示，而不是让界面一直停在「连接中」
var BLE_CONNECT_TIMEOUT_MS = 15000;
// 配对超时（ms）：后端等用户确认配对码的上限是 60 秒，前端给它留出余量
var BLE_PAIR_TIMEOUT_MS = 75000;
var _bleScanStopTimer = null;  // 扫描 5 秒自动停止定时器
var BLE_CHAR_NAMES = { '2A00':'Device Name','2A01':'Appearance','2A05':'Service Changed','2A19':'Battery Level','2A37':'Heart Rate Measurement','2A29':'Manufacturer Name' };

// GATT 服务名（Bluetooth SIG Assigned Numbers）。
// 用途：服务行左侧显示名称；**表里查不到**的服务在右侧统一标 "Custom Service"
// （即自定义/厂商私有的 128 位 UUID 服务）。因此这张表要尽量覆盖标准服务，
// 否则像 0x1809 体温计、0x1812 HID 这类标准服务会被误标为 Custom Service。
var BLE_SVC_NAMES = {
    '1800':'Generic Access','1801':'Generic Attribute','1802':'Immediate Alert','1803':'Link Loss',
    '1804':'Tx Power','1805':'Current Time','1806':'Reference Time Update','1807':'Next DST Change',
    '1808':'Glucose','1809':'Health Thermometer','180A':'Device Information','180D':'Heart Rate',
    '180E':'Phone Alert Status','180F':'Battery','1810':'Blood Pressure','1811':'Alert Notification',
    '1812':'Human Interface Device','1813':'Scan Parameters','1814':'Running Speed and Cadence',
    '1815':'Automation IO','1816':'Cycling Speed and Cadence','1818':'Cycling Power',
    '1819':'Location and Navigation','181A':'Environmental Sensing','181B':'Body Composition',
    '181C':'User Data','181D':'Weight Scale','181E':'Bond Management',
    '181F':'Continuous Glucose Monitoring','1820':'Internet Protocol Support','1821':'Indoor Positioning',
    '1822':'Pulse Oximeter','1823':'HTTP Proxy','1824':'Transport Discovery','1825':'Object Transfer',
    '1826':'Fitness Machine','1827':'Mesh Provisioning','1828':'Mesh Proxy',
    '1829':'Reconnection Configuration','183A':'Insulin Delivery','183B':'Binary Sensor',
    '183C':'Emergency Configuration','183D':'Authorization Control','183E':'Physical Activity Monitor',
    '183F':'Elapsed Time','1840':'Generic Health Sensor','1843':'Audio Input Control',
    '1844':'Volume Control','1845':'Volume Offset Control','1846':'Coordinated Set Identification',
    '1847':'Device Time','1848':'Media Control','1849':'Generic Media Control',
    '184A':'Constant Tone Extension','184B':'Telephone Bearer','184C':'Generic Telephone Bearer',
    '184D':'Microphone Control','184E':'Audio Stream Control','184F':'Broadcast Audio Scan',
    '1850':'Published Audio Capabilities','1851':'Basic Audio Announcement',
    '1852':'Broadcast Audio Announcement','1853':'Common Audio','1854':'Hearing Access',
    '1855':'Telephony and Media Audio','1856':'Public Broadcast Announcement','1857':'Electronic Shelf Label',
    // 常见厂商私有服务（非 SIG 标准名，但业界通用叫法，保留以便识别）
    'FE59':'Nordic DFU','6E400001-B5A3-F393-E0A9-E50E24DCCA9E':'Nordic UART'
};

// GATT 描述符：名称 + 可执行的操作。
// 权限按规范固定（btleplug 不暴露描述符属性，只能按 UUID 推断）：
//   0x2901 User Description 只读；0x2902 CCCD / 0x2903 SCCD 可读可写；
//   0x2900/0x2904/0x2905/0x2906~0x2909 只读；0x290A~0x290E 可读可写。
// **未知描述符（厂商自定义）按只读处理** —— 宁可少一个写入按钮，也不要误写设备。
var BLE_DESC_META = {
    '2900':{ name:'Extended Properties', ops:['read'] },
    '2901':{ name:'User Description',    ops:['read'] },
    '2902':{ name:'CCCD（通知/指示配置）', ops:['read','write'] },
    '2903':{ name:'SCCD（广播配置）',     ops:['read','write'] },
    '2904':{ name:'Presentation Format', ops:['read'] },
    '2905':{ name:'Aggregate Format',    ops:['read'] },
    '2906':{ name:'Valid Range',         ops:['read'] },
    '2907':{ name:'External Report Reference', ops:['read'] },
    '2908':{ name:'Report Reference',    ops:['read'] },
    '2909':{ name:'Number of Digitals',  ops:['read'] },
    '290A':{ name:'Value Trigger Setting', ops:['read','write'] },
    '290B':{ name:'ES Configuration',    ops:['read','write'] },
    '290C':{ name:'ES Measurement',      ops:['read'] },
    '290D':{ name:'ES Trigger Setting',  ops:['read','write'] },
    '290E':{ name:'Time Trigger Setting',ops:['read','write'] }
};

// 128 位 UUID → 短格式（仅当命中 Bluetooth SIG 基础 UUID 时），返回大写十六进制串。
// 例：'0000fe3c-0000-1000-8000-00805f9b34fb' → 'FE3C'；自定义 128 位 UUID 原样返回。
// 注意：只用于显示；data-uuid 与 invoke 参数必须继续使用原始完整 UUID。
function shortUuid(u) {
    if (!u) return '';
    var s = String(u).toUpperCase();
    var m16 = /^0000([0-9A-F]{4})-0000-1000-8000-00805F9B34FB$/.exec(s);
    if (m16) return m16[1];
    var m32 = /^([0-9A-F]{8})-0000-1000-8000-00805F9B34FB$/.exec(s);
    if (m32) return m32[1];
    return s;
}

// BLE 属性 icon（取自 BluetoothIcons，转为 currentColor 以便按连接状态点亮）
var BLE_ICONS = {
    read:     '<svg viewBox="0 0 36 30" fill="currentColor" fill-rule="evenodd"><path d="M0.00 25.75 L0.00 29.75 L35.75 29.75 L35.75 25.75 Z M14.50 0.00 L14.50 10.50 L13.50 11.00 L9.75 11.00 L9.50 11.50 L17.25 22.25 L18.50 22.50 L26.50 11.25 L22.25 11.00 L21.50 10.25 L21.75 0.00 Z"/></svg>',
    write:    '<svg viewBox="0 0 36 28" fill="currentColor" fill-rule="evenodd"><path d="M0.00 23.75 L0.00 27.75 L35.75 27.75 L35.75 23.75 Z M16.00 0.00 L10.00 8.25 L9.00 10.50 L13.50 10.75 L14.25 11.50 L14.25 20.75 L20.50 21.00 L21.25 20.50 L21.25 11.25 L21.75 10.75 L25.75 10.75 L26.25 10.00 L24.75 7.25 L21.75 4.00 L21.75 3.25 L19.75 1.00 L19.50 0.00 Z"/></svg>',
    notify_enable:   '<svg viewBox="0 0 36 31" fill="currentColor" fill-rule="evenodd"><path d="M0.00 26.75 L0.00 30.75 L35.75 30.75 L35.75 26.75 Z M31.25 0.25 L27.50 0.00 L26.25 0.75 L26.00 8.50 L25.50 9.00 L23.50 9.00 L22.75 10.75 L22.00 10.50 L22.00 2.00 L21.25 1.25 L16.00 1.50 L15.75 10.50 L13.50 11.25 L12.75 10.50 L12.75 3.25 L6.00 3.00 L5.75 13.50 L1.25 13.75 L0.75 14.50 L8.75 25.50 L9.50 25.75 L10.00 25.25 L10.00 24.25 L12.75 21.50 L12.75 20.50 L15.25 18.00 L18.50 22.00 L19.50 22.00 L25.25 13.75 L26.00 14.25 L26.00 15.50 L28.00 18.25 L29.00 19.00 L29.75 18.75 L33.75 12.75 L35.75 10.75 L35.75 9.00 L32.50 9.25 L32.00 8.75 L32.00 1.25 Z"/></svg>',
    notify_disable:  '<svg viewBox="0 0 35 30" fill="currentColor" fill-rule="evenodd"><path d="M7.00 29.50 L27.00 29.75 L26.50 28.75 L23.00 25.75 L11.25 25.75 Z M5.00 7.50 L4.75 12.50 L0.00 12.75 L0.00 14.50 L0.75 14.75 L5.00 20.75 L6.25 21.00 L12.00 15.25 L12.00 14.50 L5.50 7.50 Z M30.75 6.00 L30.00 6.00 L24.00 12.75 L24.00 13.75 L28.00 18.00 L28.75 17.75 L32.75 11.75 L34.75 9.75 L34.75 8.00 L31.50 8.25 Z M11.00 4.00 L11.00 4.75 L11.75 5.00 L11.75 4.00 Z M4.25 1.00 L2.75 3.25 L14.00 15.00 L2.75 26.50 L2.75 27.25 L4.25 28.75 L5.25 29.00 L17.00 17.75 L28.50 29.00 L29.25 29.00 L30.75 27.50 L31.00 26.50 L19.75 14.75 L30.75 3.75 L30.75 2.25 L28.50 0.75 L16.75 12.00 L5.25 0.75 Z M20.25 0.00 L15.25 0.00 L14.75 1.00 L14.75 8.25 L16.50 10.00 L20.00 7.50 L21.00 5.75 L21.25 1.75 Z"/></svg>',
    indicate_enable: '<svg viewBox="0 0 36 29" fill="currentColor" fill-rule="evenodd"><path d="M0.00 24.75 L0.00 28.75 L35.75 28.75 L35.75 24.75 Z M26.00 0.00 L26.00 0.75 L23.00 4.25 L22.75 5.25 L18.75 10.00 L18.75 11.00 L19.50 11.75 L22.75 11.75 L23.50 12.50 L23.25 21.25 L24.00 22.00 L29.75 22.00 L30.50 21.25 L30.25 12.50 L31.00 11.75 L35.75 11.75 L35.75 10.25 L33.75 8.25 L28.25 0.25 Z M6.00 0.00 L6.00 10.25 L5.25 11.00 L1.00 11.00 L0.75 12.00 L8.00 22.25 L9.50 23.25 L18.00 11.25 L17.25 10.75 L13.50 11.00 L12.75 10.50 L12.75 0.00 Z"/></svg>',
    indicate_disable:'<svg viewBox="0 0 35 29" fill="currentColor" fill-rule="evenodd"><path d="M8.00 27.75 L8.00 28.75 L25.75 28.75 L26.00 28.25 L23.25 24.75 L11.50 24.75 Z M5.00 6.50 L5.00 10.25 L4.25 11.00 L0.00 11.00 L0.00 12.75 L5.00 19.50 L6.25 20.00 L11.50 15.00 L12.00 13.50 L8.25 10.00 L5.75 6.75 Z M31.00 5.75 L29.25 6.25 L27.25 8.75 L24.00 11.25 L22.25 13.75 L22.50 15.25 L25.25 17.75 L26.25 18.00 L26.75 19.25 L29.00 21.25 L29.50 21.25 L29.25 12.50 L30.00 11.75 L34.75 11.75 L34.75 10.25 Z M7.75 0.00 L11.00 3.75 L11.75 3.75 L11.75 0.00 Z M4.00 0.00 L2.75 2.25 L14.00 14.00 L2.75 25.50 L3.00 26.50 L5.25 28.00 L16.50 16.75 L17.25 16.75 L28.50 28.00 L29.50 27.75 L31.00 25.50 L19.75 13.75 L31.00 2.25 L29.75 0.00 L28.00 0.00 L17.25 11.00 L16.50 11.00 L5.75 0.00 Z"/></svg>'
};

// BLE 设备类型 icon（依据后端 device_type 判定结果；currentColor 随主题与选中态变色）
// viewBox 已按各图标内容包围盒裁紧，使各图标渲染高度一致时视觉尺寸相同
var BLE_DEV_ICONS = {
    ble:     '<svg viewBox="210.11 104.13 604.79 815.74" fill="currentColor" preserveAspectRatio="xMidYMid meet"><path d="M792.576 348.672c9.728 46.592 14.336 100.864 14.336 163.328 0 61.952-4.608 116.736-14.336 163.328s-22.528 84.992-38.912 114.688c-16.384 29.696-37.376 54.272-62.464 72.704s-52.224 31.232-80.896 38.4c-28.672 7.168-61.44 10.752-97.792 10.752-36.352 0-69.12-3.584-97.792-10.752-28.672-7.168-55.808-19.968-80.896-38.4s-46.08-42.496-62.464-72.704c-16.384-29.696-29.696-68.096-38.912-114.688-9.728-46.592-14.336-100.864-14.336-163.328 0-61.952 4.608-116.736 14.336-163.328s22.528-84.992 38.912-114.688c15.36-29.696 36.352-53.76 61.44-72.192 25.6-18.432 52.736-31.744 81.408-38.912 28.672-7.168 61.44-10.752 97.792-10.752 36.352 0 69.12 3.584 97.792 10.752 28.672 7.168 55.808 19.968 80.896 38.4s46.08 42.496 62.464 72.704 30.208 68.096 39.424 114.688z m-306.688 506.88l206.848-207.36L556.544 512l136.704-136.704-207.36-207.36v272.896L372.224 327.168l-41.472 41.472L473.6 512 330.752 655.36l41.472 41.472 113.664-113.664v272.384z m58.368-546.304l66.56 66.56-66.048 66.048-0.512-132.608z m0.512 272.896l66.048 66.048-66.56 66.56 0.512-132.608z"/></svg>',
    apple:   '<svg viewBox="37.38 -10.26 901.78 1046.96" fill="currentColor" preserveAspectRatio="xMidYMid meet"><path d="M791.488 544.095c-1.28-129.695 105.76-191.871 110.528-194.975-60.16-88.032-153.856-100.064-187.232-101.472-79.744-8.064-155.584 46.944-196.064 46.944-40.352 0-102.816-45.76-168.96-44.544-86.912 1.28-167.072 50.528-211.808 128.384-90.304 156.703-23.136 388.831 64.896 515.935 43.008 62.208 94.304 132.064 161.632 129.568 64.832-2.592 89.376-41.952 167.744-41.952s100.416 41.952 169.056 40.672c69.76-1.312 113.984-63.392 156.704-125.792 49.376-72.16 69.728-142.048 70.912-145.632-1.536-0.704-136.064-52.224-137.408-207.136zM662.56 163.52C698.304 120.16 722.432 60 715.84 0c-51.488 2.112-113.888 34.304-150.816 77.536-33.152 38.368-62.144 99.616-54.368 158.432 57.472 4.48 116.128-29.216 151.904-72.448z"/></svg>',
    ibeacon: '<svg viewBox="104.44 104.44 933.36 933.39" fill="currentColor" preserveAspectRatio="xMidYMid meet"><path d="M687.870362 574.278394c0-63.114537-50.477431-113.591968-113.591968-113.591968s-113.591968 50.477431-113.591968 113.591968 50.477431 113.591968 113.591968 113.591968c56.795984 6.318553 113.591968-44.158878 113.591968-113.591968z m302.900083-176.706506c-31.557269-82.034699-94.671806-157.750846-170.387953-201.94522C744.666346 145.149237 656.313093 113.591968 567.959841 113.591968c-63.114537 0-119.910521 12.637106-176.706506 31.557269-82.034699 31.557269-151.46779 94.671806-201.945221 170.387952C145.149237 391.253335 113.591968 479.606588 113.591968 574.278394c0 50.477431 6.318553 100.954862 25.238716 151.46779 44.158878 145.149237 164.069399 252.422652 302.900082 296.617027 18.920162 6.318553 37.875822-6.318553 44.158878-25.238716 6.318553-25.238715-6.318553-37.875822-25.238716-44.158877-82.034699-25.238715-151.46779-75.716146-195.626667-138.830684-25.238715-31.557269-44.158878-69.433091-56.795984-107.273415s-25.238715-82.034699-25.238716-126.229074c0-50.477431 12.637106-100.954862 31.557269-151.46779 31.557269-69.433091 75.716146-126.229075 138.830683-170.387953 63.114537-37.875822 132.51213-63.114537 214.54683-63.114537 50.477431 0 100.954862 12.637106 151.46779 31.557269 69.433091 31.557269 126.229075 82.034699 170.387952 138.830683 37.875822 63.114537 63.114537 138.830684 63.114538 214.54683 0 44.158878-6.318553 88.353253-25.238716 126.229075-37.875822 113.591968-132.51213 208.263774-252.422651 246.104098-18.920162 6.318553-31.557269 31.557269-25.238716 44.158878 6.318553 18.920162 31.557269 31.557269 44.158878 25.238715a528.806109 528.806109 0 0 0 239.821043-164.069399c31.557269-37.875822 50.477431-82.034699 69.43309-126.229074s25.238715-100.954862 25.238715-151.46779c0-69.433091-12.637106-126.229075-37.875821-183.025059z m-296.58153 435.447711c44.158878-25.238715 88.353253-56.795984 113.591968-100.954862 31.557269-44.158878 44.158878-100.954862 44.158878-157.750846 0-37.875822-6.318553-75.716146-25.238715-107.273415-25.238715-50.477431-56.795984-94.671806-100.954862-126.229074s-100.954862-44.158878-157.750846-44.158878c-37.875822 0-75.716146 6.318553-107.273415 25.238716-50.477431 25.238715-94.671806 56.795984-119.910521 100.954861-31.557269 44.158878-44.158878 100.954862-44.158878 164.069399 0 56.795984 18.920162 107.273415 44.158878 157.750846s69.433091 82.034699 113.591968 100.954862c18.920162 6.318553 31.557269 0 44.158878-18.920162 6.318553-18.920162 0-37.875822-18.920163-44.158878-31.557269-18.920162-69.433091-44.158878-88.353252-82.034699-25.238715-31.557269-31.557269-75.716146-31.557269-113.591969 0-31.557269 6.318553-56.795984 18.920162-88.353252 18.920162-37.875822 37.875822-75.716146 75.716147-100.954862 31.557269-25.238715 75.716146-31.557269 119.910521-31.557269 31.557269 0 56.795984 6.318553 82.034699 18.920163 37.875822 18.920162 69.433091 44.158878 94.671806 82.034699 25.238715 31.557269 31.557269 75.716146 31.557269 119.910521s-12.637106 88.353253-31.557269 113.591969c-25.238715 31.557269-50.477431 63.114537-88.353252 82.034699-18.920162 6.318553-25.238715 31.557269-18.920163 44.158878 6.318553 6.318553 31.557269 18.920162 50.477431 6.318553z"/></svg>',
    pc:      '<svg viewBox="56.97 66.18 860.92 874.23" fill="currentColor" preserveAspectRatio="xMidYMid meet"><path d="M454.656 863.232l-1.024-343.04 455.68 2.048 0 409.6zM453.632 143.36l455.68-68.608 0 378.88-455.68 0 0-310.272zM65.536 519.168l325.632 1.024 0 336.896-325.632-52.224 0-285.696zM65.536 453.632l0-251.904 325.632-52.224 0 304.128-325.632 0z"/></svg>',
    mesh:    '<svg viewBox="121.66 113.37 773.68 784.96" fill="currentColor" preserveAspectRatio="xMidYMid meet"><path d="M847.39 603.78V399a50.38 50.38 0 0 0 32-63.18l-0.22-0.6a50.41 50.41 0 0 0-80-22.82L647.91 191.74a50.43 50.43 0 0 0-35.74-69.55l-0.59-0.12a51.08 51.08 0 0 0-9.88-1 50.41 50.41 0 0 0-50.3 47.62l-198.15 45.25a50.26 50.26 0 0 0-55.64-25.1l-0.5 0.13a50.5 50.5 0 0 0-32.76 25.34l-0.37-0.08 0.3 0.24a50.34 50.34 0 0 0 11.92 61.88l-87 180.6a50.21 50.21 0 0 0-55.2 28.48l-0.58-0.14 0.47 0.38a50 50 0 0 0 0 41.63l0.11 0.24A50.22 50.22 0 0 0 189.23 556l87.7 182.12a50.41 50.41 0 1 0 77 61.06l197.41 45.06A50.29 50.29 0 0 0 611 889.73l1.15-0.22A50.43 50.43 0 0 0 648.23 821l159.3-127a50.43 50.43 0 1 0 39.86-90.15z m-401-325.64L412.66 305l-57.88-46.17c0.22-0.48 0.46-0.94 0.67-1.43zM340 738.11c-0.24-0.19-0.48-0.35-0.72-0.53L370 673.91l25.28 20.16z m39.62-84.29l39.06-81.13 44.55 10.17L483.06 624l-70.4 56.15z m-60.77-168.47l87.78-20 19.83 41.16-19.83 41.17-87.78-20z m-21.74 37.3l-66.9-15.27v-0.9-0.9l66.9-15.26z m44.61-246.43l53.51 42.68L370 339.06l-29.68-61.64c0.44-0.42 0.92-0.79 1.4-1.2z m70.94 56.58l70.4 56.14-19.82 41.17-44.55 10.16-39.07-81.13z m368.42 21.74c0.07 1 0.15 2 0.28 3L712 373.32l-18.69-38.81z m-59.39 265l14-29.13 54.79 43.7c-0.14 0.35-0.25 0.71-0.38 1.06z m81.31-3.3l-57.56-45.9 18.69-38.81L804.29 615c-0.46 0.42-0.9 0.83-1.29 1.24z m-75-59.81l-62.64-49.95 62.64-50 24 50z m-115.83-92.34v-45.68l87.78-20 18.34 38.07-70.4 56.14z m18.28 42.39l-18.28 14.59V491.9z m-40-59.72l-22.8-18.19 22.8-5.2z m0 27.8v63.84l-49.91 39.8-62.26-14.2-27.7-57.52 27.7-57.48 62.24-14.21z m0 91.64v23.39l-22.8-5.2z m21.74-17.33l35.72-28.49 70.4 56.14L700 614.59l-87.78-20z m177.46-169.34l-53.93 43-14-29.13 67.07-15.31c0.27 0.48 0.55 0.97 0.86 1.44z m-44.26 63.1l60.31-48.1 0.18 0.11-41.8 86.79z m-55.11-64.34l-78.11 17.82V316l54.05 12.34z m-78.11-84.59v-72.82c0.69-0.15 1.37-0.36 2.05-0.53l39.94 82.93z m-21.74-73v68.07l-31.53-7.2 29.56-61.38c0.66 0.15 1.31 0.33 1.97 0.48z m0 90.36v90.05l-44.54 10.16-35.72-28.49 39.06-81.12z m-71.64 106.4l-28.45 6.49 10.15-21.08z m-67.61 37.72l-12.66 26.29-10.15-21.08z m-12.66 76.38l12.65 26.28-22.8-5.2z m51.82 57.52l28.44 6.49-18.29 14.58z m55.55 12.68l44.54 10.16v90l-41.2 9.41-39.06-81.13z m44.54 122.5V791c-0.84 0.19-1.68 0.41-2.5 0.64l-29-60.26z m21.74 66.65v-71.64l42-9.59-39.42 81.86c-0.87-0.23-1.75-0.47-2.58-0.66z m0-93.91v-80.15l78.11 17.83-24.06 50zM712 639.64l74.93 17.1v0.34l-93.63 21.37z m111.44-34.94l-47.3-98.22 49.51-102.81v200.46c-0.74 0.18-1.48 0.36-2.21 0.57zM784.34 333l-103.08-23.53-47.62-98.9c0.49-0.4 1-0.85 1.43-1.28l150.77 120.24c-0.54 1.14-1.05 2.29-1.5 3.47zM568 209c0.41 0.37 0.81 0.77 1.24 1.13l-32 66.5-42-9.58z m-40.5 87.66l-34.76 72.19-62.65-50 43.35-34.57z m-208.65-9.24c0.64-0.13 1.25-0.31 1.89-0.46l31.78 66-33.67 26.85zM362.2 373l34.8 72.23-78.11 17.83v-55.45z m-65.09 95l-72 16.43c-0.25-0.5-0.47-1-0.73-1.52l72.7-58z m-72 60.5l72 16.42V588l-72.71-58c0.27-0.46 0.49-1 0.74-1.48z m93.71 21.38L397 567.73l-34.8 72.19-43.35-34.57zM352.52 660l-32.88 68.28c-0.27-0.06-0.52-0.15-0.79-0.2v-94.93z m1.11 95l59-47.08 33.67 26.85-92.3 21.12c-0.1-0.28-0.23-0.56-0.37-0.84z m76.47-61l62.64-50 34.76 72.3-54.06 12.34z m107.07 42.31L568.75 802c-0.53 0.47-1 0.95-1.57 1.43l-72-57.42zM634 801.58l47.24-98.09 111.28-25.39-156.79 125c-0.56-0.49-1.12-1.02-1.73-1.52z m-79.13-611.37c0.14 0.35 0.25 0.71 0.4 1.06l-87.2 69.54L359.23 236c0-0.37 0-0.73-0.05-1.1z m-259.45 96.33c0.56 0.15 1.12 0.3 1.69 0.43v110.18l-86.8 69.22c-0.36-0.28-0.72-0.55-1.1-0.82z m-86.21 260.87c0.37-0.26 0.74-0.54 1.1-0.82l86.8 69.23v112.53l-0.68 0.17z m149.7 229.66l109.16-24.92 86.77 69.19c-0.18 0.43-0.32 0.87-0.48 1.3L358.89 778v-0.58c0-0.2 0.02-0.22 0.02-0.35z"/></svg>'
};

// 设备类型标题（tooltip）与名称后缀提示；key 与后端 ble_device_type 返回值一致
// tag 只在需要显式点明类型时给出（iBeacon / Mesh），其余类型不加后缀
var BLE_DEV_TYPE_META = {
    ble:     { title: '标准 BLE 设备' },
    apple:   { title: 'Apple 设备（iPhone / iPad / Mac）' },
    ibeacon: { title: 'iBeacon 信标（Apple 厂商数据 02 15 结构）', tag: 'iBeacon' },
    pc:      { title: '个人电脑' },
    mesh:    { title: 'BLE Mesh 设备', tag: 'Mesh' }
};

var BLE_PROP_META = {
    read:     { label:'Read',     title:'读取特征值',        icon:'read' },
    write:    { label:'Write',    title:'写入特征值 (发送)', icon:'write' },
    notify:   { label:'Notify',   titleOn:'启用通知', titleOff:'禁用通知', iconOn:'notify_enable',   iconOff:'notify_disable' },
    indicate: { label:'Indicate', titleOn:'启用指示', titleOff:'禁用指示', iconOn:'indicate_enable', iconOff:'indicate_disable' }
};

function getSelectedBleDev() {
    if (!_bleSelected) return null;
    for (var i = 0; i < _bleDevices.length; i++) {
        if (_bleDevices[i].address === _bleSelected) return _bleDevices[i];
    }
    return null;
}

// 演示特征（接后端后由 ble_services 返回真实特征及其属性）
// 说明：早期的演示特征表 getDemoChars() 已删除 —— 现在特征全部来自后端 ble_get_services，
// 它只剩零调用（保留会误导后来者以为还有 demo 分支）。

// 当前查看的设备是否就是「已连接设备」
function isViewingConnectedDevice(dev, connAddr) {
    return !!(dev && connAddr && dev.address === connAddr);
}

// GATT 区该展示谁的服务（纯函数，便于无头断言）：
//   - 正在查看的设备 == 已连接设备 → 用真实 GATT 服务树（ble_get_services 的结果）
//   - 否则（未连接，或看的是另一台设备）→ 用该设备广播里的服务 UUID 列表
// 之前的 bug：无条件使用 _bleServices（那是「已连接设备」的全局缓存），
// 于是选中一台**未连接**的设备时，右侧却显示着另一台已连接设备的 GATT 服务。
function pickBleSvcList(dev, bleServices, connAddr) {
    if (isViewingConnectedDevice(dev, connAddr) && bleServices && bleServices.length) {
        return bleServices.map(function(s) {
            return { uuid: s.uuid, primary: !!s.primary, chars: s.characteristics || [] };
        });
    }
    // 广播里没有主/从信息，沿用既有的展示方式
    return ((dev && dev.services) || []).map(function(uuid, idx) {
        return { uuid: uuid, primary: (idx % 2 === 0), chars: [] };
    });
}

// 服务行（GATT 服务/特征树的顶层条目）
// 左侧：主/从标记 P/S、展开箭头、服务 UUID、标准服务名（BLE_SVC_NAMES 查得到时）
// 右侧：查不到类型的服务统一标 "Custom Service"（原先一律标 "Service"，没有信息量）
function renderBleServiceRow(s) {
    var su = shortUuid(s.uuid);
    var svcAttr = s.primary ? 'P' : 'S';
    // 服务类型名称：识别到的用标准名，识别不到的统一 Custom Service
    var typeName = BLE_SVC_NAMES[su] || 'Custom Service';
    return '<div class="ble-svc" data-uuid="' + s.uuid + '" onclick="toggleBleService(this)">' +
                '<span class="ble-svc-attr" title="' + (s.primary ? '主服务 Primary' : '从服务 Secondary') + '">' + svcAttr + '</span>' +
                '<span class="ble-svc-caret">&#9654;</span>' +
                '<span class="ble-svc-uuid" title="' + s.uuid + '">0x' + su + '</span>' +
                // 类型名称统一右对齐（margin-left:auto 推到最右）
                '<span class="ble-svc-type" title="' + typeName + '">' + typeName + '</span>' +
            '</div>';
}

function renderCharRow(ch) {
    var dev = getSelectedBleDev();
    var conn = !!(dev && dev.connected);
    // 两种写入属性合并成一个「发送」图标：
    //   write（带响应）与 write_without_response（无响应）是 BLE 的两个独立属性，
    //   但只差「要不要外设回执」，分开渲染会出现两个一模一样的图标（用户反馈的困惑点）。
    //   具体用哪种方式，放到写入弹窗里选。
    var writeModes = [];
    if (ch.props.indexOf('write') >= 0) writeModes.push('write');
    if (ch.props.indexOf('write_without_response') >= 0) writeModes.push('write_without_response');
    var hasWrite = writeModes.indexOf('write') >= 0;
    var actions = ch.props.map(function(p0) {
        // 已有 write 时，write_without_response 由 write 图标统一承载，不再单独出图标
        if (p0 === 'write_without_response' && hasWrite) return '';
        var p = (p0 === 'write_without_response') ? 'write' : p0;
        var m = BLE_PROP_META[p];
        if (!m) return '';
        var key = ch.uuid + '::' + p;
        var toggle = (p === 'notify' || p === 'indicate');
        var enabled = toggle ? !!_bleSubs[key] : false;
        var iconKey = toggle ? (enabled ? m.iconOff : m.iconOn) : m.icon;
        var title = toggle ? (enabled ? m.titleOff : m.titleOn) : m.title;
        var extra = '';
        if (p === 'write' && writeModes.length) {
            extra = ' data-modes="' + writeModes.join(',') + '"';
            if (writeModes.length > 1) title = '写入特征值（可在窗口里选写响应/无响应）';
        }
        var cls = 'ble-ch-action' + (enabled ? ' on' : (conn ? ' ready' : ''));
        return '<span class="' + cls + '"' + extra + ' title="' + title + '" onclick="bleCharAction(this,\'' + key + '\')">' + BLE_ICONS[iconKey] + '</span>';
    }).join('');
    return '<div class="ble-char">' +
                '<span class="ble-char-uuid" title="' + ch.uuid + '">0x' + shortUuid(ch.uuid) + '</span>' +
                '<span class="ble-char-name">' + ch.name + '</span>' +
                '<span class="ble-char-actions">' + actions + '</span>' +
            '</div>' +
            renderCharDescriptors(ch);
}

// 特征描述符行（0x2902 CCCD、0x2901 User Description 等）
// 放在特征行下方、同属 .ble-charGroup（flex column），无描述符时返回空串不占位。
// 每个描述符按 BLE_DESC_META 渲染可执行的操作图标（读取 / 写入）—— 与特征一样可点击。
function renderCharDescriptors(ch) {
    var descs = ch.descriptors || [];
    if (!descs.length) return '';
    return '<div class="ble-char-descs">' + descs.map(function(d) {
        var su = shortUuid(d.uuid);
        var meta = BLE_DESC_META[su] || { name: '', ops: ['read'] };
        var acts = (meta.ops || []).map(function(op) {
            var m = BLE_PROP_META[op];
            if (!m) return '';
            return '<span class="ble-desc-act" title="' + m.title + '" ' +
                   'onclick="bleDescAction(event,\'' + ch.uuid + '\',\'' + d.uuid + '\',\'' + op + '\')">' +
                   BLE_ICONS[m.icon] + '</span>';
        }).join('');
        return '<span class="ble-desc" title="' + d.uuid + '">0x' + su +
               (meta.name ? '<em>' + meta.name + '</em>' : '') + acts + '</span>';
    }).join('') + '</div>';
}

// 描述符操作：读取（0x2901 文字、0x2902 通知开关状态…）或写入（0x2902 手动开关通知）
function bleDescAction(ev, charUuid, descUuid, op) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    var dev = getSelectedBleDev();
    if (!dev || !dev.connected) { showToast('请先连接设备', 'error'); return; }
    var su = shortUuid(descUuid);
    var meta = BLE_DESC_META[su] || { name: '' };
    if (op === 'write') {
        // 描述符按规范用带响应写：只传一种模式 → 弹窗里不显示「写响应/无响应」选择器
        openBleWriteModal(descUuid, meta.name || '', ['write'], { kind: 'desc', charUuid: charUuid });
        return;
    }
    invoke('ble_read_descriptor', { charUuid: charUuid, descUuid: descUuid }).then(function(bytes) {
        logBle('[读取描述符] 0x' + su + ' = ' + formatDescValue(descUuid, bytes));
    }).catch(function(e) {
        logBle('[读取描述符失败] 0x' + su + ' · ' + e);
        showToast('读取描述符失败: ' + e, 'error');
    });
}

// 描述符取值的人性化显示（纯函数，便于无头断言）
//   0x2901 User Description → UTF-8 文本；0x2902/0x2903 → 通知/指示开关状态；其余 → 原始 hex
function formatDescValue(uuid, bytes) {
    var su = shortUuid(uuid);
    var arr = bytes || [];
    var hex = '0x' + bleBytesToHex(arr).replace(/ /g, '');
    if (su === '2902' || su === '2903') {
        var v = (arr.length >= 2) ? (arr[0] | (arr[1] << 8)) : -1;
        var meaning = v === 0 ? '通知与指示均已关闭' : v === 1 ? '通知已启用' : v === 2 ? '指示已启用' : '未知取值';
        return hex + '（' + meaning + '）';
    }
    if (su === '2901') {
        var s = '';
        try {
            s = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(arr));
        } catch (e) { s = ''; }
        s = s.replace(/[\u0000-\u001f\u007f]/g, '').trim();
        return hex + (s ? '（"' + s + '"）' : '');
    }
    return hex;
}

function bleCharAction(el, key) {
    var dev = getSelectedBleDev();
    if (!dev || !dev.connected) { console.warn('[BLE] 请先连接设备再操作'); return; }
    var parts = key.split('::');
    var charUuid = parts[0], prop0 = parts[1];
    var prop = (prop0 === 'write_without_response') ? 'write' : prop0;
    var m = BLE_PROP_META[prop];
    if (!m) return;
    if (prop === 'notify' || prop === 'indicate') {
        var on = !_bleSubs[key];
        invoke(on ? 'ble_subscribe' : 'ble_unsubscribe', { charUuid: charUuid }).then(function() {
            _bleSubs[key] = on;
            el.classList.toggle('on', on);
            el.classList.add('ready');
            el.innerHTML = BLE_ICONS[ on ? m.iconOff : m.iconOn ];
            el.title = on ? m.titleOff : m.titleOn;
            console.log('[BLE] ' + prop + ' 订阅 ' + (on ? '启用' : '关闭') + ' 特征 ' + charUuid);
            logBle('[' + (on ? '订阅' : '取消订阅') + '] ' + prop + ' · ' + charUuid);
        }).catch(function(e) { console.warn('[BLE] 订阅失败:', e); showToast('订阅失败: ' + e, 'error'); });
    } else if (prop === 'read') {
        invoke('ble_read', { charUuid: charUuid }).then(function(data) {
            // 标明来源服务（反查服务树）；可读文本时同样按「文本 + 灰色十六进制」显示
            var svc = bleFindSvcOfChar(_bleServices, charUuid);
            var label = '[读取] ' + (svc ? bleSvcLabel(svc) + ' · ' : '') + '0x' + shortUuid(charUuid) + ': ';
            var arr = Array.from(data || []);
            if (arr.length && bleCanShowAsText(arr)) {
                logBleDim(label + bleFmtBytes(arr) + ' · ', bleBytesToHex(arr));
            } else {
                logBle(label + bleBytesToHex(arr));
            }
        }).catch(function(e) { console.warn('[BLE] 读取失败:', e); showToast('读取失败: ' + e, 'error'); });
    } else if (prop === 'write') {
        // 点写入图标 → 弹出写入窗口（不再写死演示值 0x01）
        // data-modes 给出该特征支持的写入方式（write / write_without_response）
        var modes = ((el && el.getAttribute('data-modes')) || 'write').split(',');
        openBleWriteModal(charUuid, BLE_CHAR_NAMES[shortUuid(charUuid)] || '', modes);
    }
}

// 数据日志：内容存在 _bleLog 缓冲里，DOM 只负责显示。
// 定位是「当前设备本次连接会话」的记录 ——
//   切换设备时清空、断开连接时清空（见 renderBleDeviceList 的点击与 toggleBleConnect），
//   切页/重渲染不清空（所以缓冲放在 JS 层，不依赖 DOM）。
// 条目形态：字符串，或 { text, dim }（dim 是 text 的结尾部分，显示为灰色，
// 目前用于「文本 + 灰色十六进制」）。
function logBle(text) {
    _bleLog.push({ text: text, seq: _bleLogSeq++ });
    if (_bleLog.length > _bleLogMax) _bleLog.splice(0, _bleLog.length - _bleLogMax);
    renderBleLog();
}
// 末尾灰显的日志：dim 会**追加**在 text 之后（保证 dim 一定是整条 text 的后缀 ——
// 渲染时靠这个不变式切分；调用方只需传"前半段"和"后半段"，不必自己拼）。
function logBleDim(text, dim) {
    _bleLog.push({ text: (text || '') + (dim || ''), dim: dim || '', seq: _bleLogSeq++ });
    if (_bleLog.length > _bleLogMax) _bleLog.splice(0, _bleLog.length - _bleLogMax);
    renderBleLog();
}
// 日志缓冲 → HTML（纯函数，便于无头断言）。
// **所有内容都经 esc 转义**：日志里既有设备名/广播数据也有通知原始字节，
// 绝不能当 HTML 插入（否则设备侧数据就成了注入面）。
function bleLogToHtml(entries, esc) {
    return (entries || []).map(function(e) {
        var t = (typeof e === 'string') ? { text: e } : e;
        var text = t.text || '';
        if (!t.dim) return esc(text);
        var head = text.slice(0, Math.max(0, text.length - t.dim.length));
        return esc(head) + '<span class="ble-log-dim">' + esc(t.dim) + '</span>';
    }).join('\n');
}
function renderBleLog() {
    var log = document.getElementById('ble-log');
    if (!log) return;                      // 面板尚未渲染/未展开：缓冲照常保留
    if (!_bleLog.length) { log.textContent = '暂无日志'; return; }
    log.innerHTML = bleLogToHtml(_bleLog, escapeHtml) + '\n';   // 内容已全部转义
    log.scrollTop = log.scrollHeight;
}
function clearBleLog() {
    _bleLog = [];
    _bleLogSeq = 0;          // 新会话的编号从头开始（seq 只保证"同一次会话内单调"）
    renderBleLog();
}
function bleBytesToHex(arr) {
    if (!arr) return '';
    return arr.map(function(b){ return ('0' + b.toString(16)).slice(-2).toUpperCase(); }).join(' ');
}
// 能否当文本读：整体是合法 UTF-8，且除 \r \n \t 外不含控制字符（\x00-\x08 \x0b \x0c \x0e-\x1f \x7f）
function bleCanShowAsText(bytes) {
    var arr = bytes || [];
    if (!arr.length) return false;
    var s;
    try {
        s = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(arr));
    } catch (e) {
        return false;
    }
    return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);
}
// 接收数据的默认显示：**能当文本读就显示文本**，否则退回十六进制。
// 文本里的回车/换行/制表符转成可见转义，避免一条通知把日志撑成多行。
// 例：E4 BD A0 E6 98 AF E8 B0 81 0D 0A → 你是谁\r\n
function bleFmtBytes(bytes) {
    var arr = bytes || [];
    if (!arr.length) return '';
    if (!bleCanShowAsText(arr)) return bleBytesToHex(arr);
    var s = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(arr));
    return s.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}
// 后端通知给的是十六进制串（value_hex）→ 解析后按上面的规则显示
function bleFmtHex(hexStr) {
    if (!hexStr) return '';
    var arr;
    try { arr = Array.from(hexToBytes(hexStr)); } catch (e) { return hexStr; }
    return bleFmtBytes(arr);
}
// 服务来源标签：短 UUID + 已知服务名（如 "0x180A Device Information"）；拿不到时给 "?"
function bleSvcLabel(svcUuid) {
    var su = shortUuid(svcUuid || '');
    if (!su) return '?';
    var nm = BLE_SVC_NAMES[su];
    return '0x' + su + (nm ? ' ' + nm : '');
}
// 从已发现的服务树里反查某特征所属的服务（用于只拿到特征 UUID 的日志，如 [读取]）。
// 取 services 作参数而不是直接读全局，便于无头断言。
function bleFindSvcOfChar(services, charUuid) {
    var list = services || [];
    for (var i = 0; i < list.length; i++) {
        var chars = list[i].characteristics || [];
        for (var j = 0; j < chars.length; j++) {
            if (chars[j].uuid === charUuid) return list[i].uuid || '';
        }
    }
    return '';
}
function startBleNotifyPoll() {
    if (_bleNotifyTimer) return;
    // 250ms：原来 400ms，高速从机（100Hz 上报）在两次轮询之间就会把缓冲顶满。
    // 但真正的修法是**丢了多少要记账并告诉用户**（见下面的 dropped），
    // 否则用户只会以为"设备就没发那么多"。
    _bleNotifyTimer = setInterval(function() {
        invoke('ble_poll_notifications').then(function(res) {
            // 兼容新形状 {items, dropped} 与旧的纯数组
            var items = (res && res.items) ? res.items : res;
            (items || []).forEach(function(it) {
                var hex = it.value_hex || '';
                var bytes = null;
                try { bytes = Array.from(hexToBytes(hex)); } catch (e) { bytes = null; }
                // 标明来源：服务（短 UUID + 已知名）· 特征。后端通知里带了 service_uuid。
                var from = bleSvcLabel(it.service_uuid) + ' · 0x' + shortUuid(it.uuid || '');
                var label = '[通知] ' + from + ':\n';
                if (bytes && bytes.length && bleCanShowAsText(bytes)) {
                    // 文本可读：来源单独一行，payload 另起一行；十六进制灰显跟在文本后面（用户要求 A）
                    logBleDim(label + '  ' + bleFmtBytes(bytes) + ' · ', hex);
                } else {
                    logBle(label + '  ' + hex);
                }
            });
            // 后端缓冲溢出丢弃的条数：必须让用户看到，否则"数据少了"会被误判成设备没发
            if (res && res.dropped > 0) {
                logBle('[通知] ⚠ 缓冲溢出丢弃了 ' + res.dropped + ' 条（前端轮询跟不上设备上报速度）');
            }
        }).catch(function() {});
    }, 250);
}
// ---- BLE 写入（发送）弹窗 ----
// 点特征行的「写入」图标 → 弹出该窗口；以前是直接写死 0x01 演示值
var _bleWriteTarget = null;   // { uuid, name, prop }

// target 可选：{ kind:'desc', charUuid } 表示目标是特征下的描述符（如 0x2902 CCCD）；
// { kind:'periph_set' } / { kind:'periph_notify' } 是 BLE 从机模式的「设值 / 下发通知」；
// 默认 { kind:'char' } 即主机模式下的普通特征写入。
function openBleWriteModal(uuid, name, modes, target) {
    modes = (modes && modes.length) ? modes : ['write'];
    target = target || {};
    var kind = (target.kind === 'desc') ? 'desc'
             : (target.kind === 'periph_set') ? 'periph_set'
             : (target.kind === 'periph_notify') ? 'periph_notify'
             : 'char';
    _bleWriteTarget = { uuid: uuid, name: name || '', modes: modes, mode: modes[0],
                        kind: kind, charUuid: target.charUuid || '' };
    // 标题区分四种用途（原先靠副标题里的 UUID 区分，现按需求去掉副标题）
    var ttl = document.getElementById('bleWriteTitle');
    if (ttl) {
        ttl.textContent = (kind === 'desc') ? '写入描述符值'
                        : (kind === 'periph_set') ? '设置从机特征可读值'
                        : (kind === 'periph_notify') ? '向已订阅主机下发通知'
                        : '写入特征值';
    }
    // 提示并入输入框 placeholder（原先有独立提示行，按需求去掉，弹窗更简洁）
    var inp0 = document.getElementById('bleWriteValue');
    if (inp0) {
        if (kind === 'periph_set') inp0.placeholder = '主机下次读取时返回这个值；支持 \\r \\n \\t 转义，HEX 形如 01 A0 FF';
        else if (kind === 'periph_notify') inp0.placeholder = '下发给已订阅主机的通知内容；HEX 形如 01 A0 FF';
        else if (kind === 'desc' && shortUuid(uuid) === '2902') inp0.placeholder = '要写入的值，回车发送；CCCD：0100 开启通知，0200 开启指示，0000 关闭';
        else inp0.placeholder = '要写入的值，回车发送；支持 \\r \\n \\t 转义，HEX 形如 01 A0 FF';
    }
    // 写入方式：两种都支持时才显示选择器，只有一种时隐藏（避免多一个没用的控件）
    // （描述符写入按规范用带响应写，调用方只传一种模式，因此这里自然隐藏）
    // 注意隐藏的是整行（含「方式」标签），否则会留下一个孤零零的标签
    var wrap = document.getElementById('bleWriteModeRow');
    if (wrap) wrap.style.display = (modes.length > 1) ? '' : 'none';
    setBleWriteMode(modes[0]);
    var mask = document.getElementById('bleWriteModal');
    if (mask) mask.classList.add('show');
    var inp = document.getElementById('bleWriteValue');
    if (inp) {
        inp.value = '';
        if (!inp.dataset.bound) {          // 只绑一次
            inp.dataset.bound = '1';
            inp.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBleWrite(); }
                else if (e.key === 'Escape') { closeBleWriteModal(); }
            });
        }
        setTimeout(function() { inp.focus(); }, 30);
    }
}
function toggleBleWriteMode() {
    var d = document.getElementById('bleWriteModeDrop');
    if (d) d.classList.toggle('open');
}
function setBleWriteMode(val, el, e) {
    if (e) e.stopPropagation();
    var label = val === 'write_without_response' ? '无响应' : '写响应';
    var t = document.getElementById('bleWriteModeText');
    if (t) t.textContent = label;
    if (_bleWriteTarget) _bleWriteTarget.mode = val;
    var drop = document.getElementById('bleWriteModeDrop');
    if (drop) {
        drop.querySelectorAll('.send-as-opt').forEach(function(o) {
            o.classList.toggle('active', o.getAttribute('data-val') === val);
        });
        if (e) drop.classList.remove('open');
    }
}
function closeBleWriteModal() {
    var mask = document.getElementById('bleWriteModal');
    if (mask) mask.classList.remove('show');
    _bleWriteTarget = null;
}
// 只在「按下点就在遮罩上」时关闭弹窗。
// 原因：拖弹窗右下角调整大小时，若向左上（变小）拖，松手会落在遮罩上 ——
// 此时 click 的 target 会变成遮罩（按下与松手目标不同时，click 落在共同祖先），
// 不做这个判断就会「一拖就关」。参见 .ble-modal 的 resize:both。
var _bleWritePressOnMask = false;
function bleWriteMaskPress(e) {
    _bleWritePressOnMask = !!(e.target && e.target.id === 'bleWriteModal');
}
function bleWriteMaskClick(e) {
    var pressedOnMask = _bleWritePressOnMask;
    _bleWritePressOnMask = false;
    if (pressedOnMask && e.target && e.target.id === 'bleWriteModal') closeBleWriteModal();
}

/* ===== BLE 配对弹窗 =====
   后端 ble_pair 需要用户确认时会发 ble-pair-request 事件（payload: {address, kind, pin}），
   这里把配对码显示出来并等用户点确认/取消，再用 ble_pair_respond 把答复回传后端。
   kind 语义（对应 WinRT DevicePairingKinds）：
     confirm = 设备要求确认配对
     display = 设备把配对码交给我们，需由用户在设备上输入
     match   = 两端显示同一配对码，请用户比对
     provide = 需要用户在应用里输入设备上显示的配对码 */
function blePairPrompt(kind) {
    // 纯函数：按配对类型给出提示文案（便于无头断言）
    if (kind === 'display') return '设备配对码如下，请在蓝牙设备上输入并确认：';
    if (kind === 'match') return '请核对设备上显示的配对码是否与下面一致，一致则点「确认」：';
    if (kind === 'provide') return '请在下方输入设备上显示的配对码，然后点「确认」：';
    return '设备要求配对，请在蓝牙设备上确认这次配对请求：';
}

function showBlePairDialog(p) {
    p = p || {};
    var dev = document.getElementById('blePairDev');
    if (dev) {
        var nm = (_bleConnInfo && _bleConnInfo.name) ? (' · ' + _bleConnInfo.name) : '';
        dev.textContent = (p.address || '') + nm;
    }
    var txt = document.getElementById('blePairText');
    if (txt) txt.textContent = blePairPrompt(p.kind);
    var showPin = (p.kind === 'display' || p.kind === 'match') && !!p.pin;
    var pinEl = document.getElementById('blePairPin');
    if (pinEl) { pinEl.style.display = showPin ? '' : 'none'; pinEl.textContent = showPin ? p.pin : ''; }
    var inp = document.getElementById('blePairInput');
    if (inp) {
        inp.style.display = (p.kind === 'provide') ? '' : 'none';
        inp.value = '';
        if (p.kind === 'provide') setTimeout(function() { inp.focus(); }, 30);
    }
    var mask = document.getElementById('blePairModal');
    if (mask) mask.classList.add('show');
    logBle('[配对] ' + blePairPrompt(p.kind) + (p.pin ? ' ' + p.pin : ''));
}

// 用户点了确认/取消：把答复回传后端（后端在等这个答复，最多 60 秒）
function submitBlePair(accept) {
    var inp = document.getElementById('blePairInput');
    var pin = inp ? inp.value.trim() : '';
    var mask = document.getElementById('blePairModal');
    if (mask) mask.classList.remove('show');
    logBle(accept ? '[配对] 已确认' : '[配对] 已取消');
    invoke('ble_pair_respond', { accept: !!accept, pin: pin }).catch(function(e) {
        logBle('[配对] 回传答复失败: ' + e);
    });
}
// 弹窗打开时按 Esc 关闭（焦点不一定在输入框上，所以监听文档级）
document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    var mask = document.getElementById('bleWriteModal');
    if (mask && mask.classList.contains('show')) { e.preventDefault(); closeBleWriteModal(); }
});
function toggleBleWriteAs() {
    var d = document.getElementById('bleWriteAsDrop');
    if (d) d.classList.toggle('open');
}
function setBleWriteAs(val, el, e) {
    if (e) e.stopPropagation();
    var t = document.getElementById('bleWriteAsText');
    if (t) t.textContent = val === 'hex' ? 'HEX' : '文本';
    var drop = document.getElementById('bleWriteAsDrop');
    if (drop) {
        drop.querySelectorAll('.send-as-opt').forEach(function(o) { o.classList.remove('active'); });
        drop.classList.remove('open');
    }
    if (el) el.classList.add('active');
    var inp = document.getElementById('bleWriteValue');
    if (inp) inp.focus();
}
// 输入内容 → 字节数组：HEX 模式按十六进制解析；文本模式先处理 \r\n 等转义再按 UTF-8 编码
// 统一转成普通数组（hexToBytes 返回 Uint8Array），与 invoke 传参习惯保持一致
function bleSendBytes(text, hexMode) {
    if (hexMode) return Array.from(hexToBytes(text));
    return Array.from(new TextEncoder().encode(parseEscapes(text)));
}
// 行尾取值 → 转义文本（纯函数，便于无头断言）。
// 与串口监视器 leStr 的语义一致：crlf/lf/cr 分别对应 \r\n \n \r，none 不追加。
// 用"转义文本"而不是原始字符，是为了复用 bleSendBytes 里已有的 parseEscapes。
function leEscOf(v) {
    return v === 'crlf' ? '\\r\\n' : (v === 'lf' ? '\\n' : (v === 'cr' ? '\\r' : ''));
}
// 读出写入弹窗的内容并解析成字节（HEX / 文本 + 行尾）。
// 主机写入、描述符写入、从机设值 / 下发四种用途共用，避免各写一份解析逻辑。
// 返回 { bytes, hex, hexMode, leVal, leLog } 或 { error }（error 时调用方负责提示）。
function bleReadWriteModalInput() {
    var inp = document.getElementById('bleWriteValue');
    var text = inp ? inp.value : '';
    if (!text) return { error: '请输入要写入的值' };
    var asEl = document.getElementById('bleWriteAsText');
    var hexMode = !!asEl && asEl.textContent === 'HEX';
    // 行尾：与串口监视器一致 —— 仅文本模式追加（HEX 模式不追加）
    var leEl = document.getElementById('bleWriteLineEnd');
    var leVal = leEl ? (leEl.getAttribute('data-val') || 'crlf') : 'crlf';
    var payload = hexMode ? text : (text + leEscOf(leVal));
    var bytes;
    try { bytes = bleSendBytes(payload, hexMode); }
    catch (e) { return { error: '格式错误: ' + e }; }
    if (!bytes.length) return { error: '内容为空' };
    return {
        bytes: bytes,
        hex: bleBytesToHex(bytes).replace(/ /g, ''),
        hexMode: hexMode,
        leVal: leVal,
        // 日志标明追加的行尾（HEX 模式或选「无」时不显示）
        leLog: (hexMode || leVal === 'none') ? '' : ' · 行尾 ' + leVal.toUpperCase()
    };
}

// 面板那颗「发送」按钮与回车键的入口（返回值给 MCP 的 ble_write 用，按钮忽略）
function sendBleWrite() { return sendBleWriteCore(); }

// 核心：返回 Promise<{ok:true, hex, bytes, writeType} | {ok:false, error}>（一律 resolve）。
// **写失败不能当成成功** —— MCP 的 ble_write 靠这里的 ok 给 AI 真实结论，
// 按钮路径只关心提示（提示与日志仍在本函数里给，两条路看到的东西一样）。
function sendBleWriteCore() {
    if (!_bleWriteTarget) {
        showToast('请先点特征行的「写入」图标', 'error');
        return Promise.resolve({ ok: false, error: '还没有选好要写入的特征' });
    }
    // 从机模式（设值 / 下发通知）与主机写入共用这个弹窗，但校验与命令完全不同
    if (_bleWriteTarget.kind === 'periph_set' || _bleWriteTarget.kind === 'periph_notify') {
        sendBlePeriphWrite();
        return Promise.resolve({ ok: true, delegated: 'periph' });
    }
    var dev = getSelectedBleDev();
    if (!dev || !dev.connected) {
        showToast('请先连接设备', 'error');
        return Promise.resolve({ ok: false, error: '请先连接设备' });
    }
    var r = bleReadWriteModalInput();
    if (r.error) {
        showToast(r.error, 'error');
        var inp0 = document.getElementById('bleWriteValue');
        if (inp0 && !inp0.value) inp0.focus();
        return Promise.resolve({ ok: false, error: r.error });
    }
    var inp = document.getElementById('bleWriteValue');
    var bytes = r.bytes, hex = r.hex, hexMode = r.hexMode, leLog = r.leLog;
    // 写入方式由弹窗里的选择决定（特征同时支持两种时可选，否则用其唯一支持的那种）
    var writeType = (_bleWriteTarget.mode === 'write_without_response') ? 'without_response' : 'with_response';
    var isDesc = _bleWriteTarget.kind === 'desc';
    var onOk = function() {
        logBle('[发送成功] 0x' + hex + ' · ' + bytes.length + ' 字节');
        showToast('发送成功：0x' + hex, 'success');
        if (inp) { inp.value = ''; inp.focus(); }   // 发完一条即清空
        return { ok: true, hex: hex, bytes: bytes.length, writeType: writeType };
    };
    var onFail = function(e) {
        logBle('[发送失败] ' + e);
        showToast('发送失败: ' + e, 'error');       // 失败保留输入内容，便于修正重发
        return { ok: false, error: String(e), hex: hex };
    };
    if (isDesc) {
        logBle('[发送] 描述符 0x' + shortUuid(_bleWriteTarget.uuid) + ' ← 0x' + hex +
               '（' + (hexMode ? 'HEX' : '文本') + leLog + '）');
        return invoke('ble_write_descriptor', { charUuid: _bleWriteTarget.charUuid,
                                                descUuid: _bleWriteTarget.uuid, data: bytes })
            .then(onOk).catch(onFail);
    }
    logBle('[发送] 0x' + shortUuid(_bleWriteTarget.uuid) + ' ← 0x' + hex +
           '（' + (hexMode ? 'HEX' : '文本') + ' · ' + (writeType === 'without_response' ? '无响应' : '写响应') + leLog + '）');
    return invoke('ble_write', { charUuid: _bleWriteTarget.uuid, data: bytes, writeType: writeType })
        .then(onOk).catch(onFail);
}

function stopBleNotifyPoll() {
    if (_bleNotifyTimer) { clearInterval(_bleNotifyTimer); _bleNotifyTimer = null; }
}

// RSSI 颜色（选中态用白色，避免蓝底上彩色不友好）
function bleRssiColor(rssi, isActive) {
    if (isActive) return '#fff';
    return rssi >= -55 ? 'var(--accent-green)' : (rssi >= -75 ? 'var(--accent-orange)' : 'var(--accent-red)');
}

// ---- 已连接设备的信号强度周期刷新 ----
// Windows 上 RSSI 只随广播包更新，后端 ble_refresh_rssi 会做一次短扫描脉冲取新值。
// 仅在「已连接 + 蓝牙面板可见」时刷新，切到其它页面自动空转（不占无线电）。
function startBleRssiPoll() {
    if (_bleRssiTimer) return;
    _bleRssiTimer = setInterval(refreshBleRssi, BLE_RSSI_INTERVAL);
}
function stopBleRssiPoll() {
    if (_bleRssiTimer) { clearInterval(_bleRssiTimer); _bleRssiTimer = null; }
}
function refreshBleRssi() {
    if (!_bleConnAddr) { stopBleRssiPoll(); return; }
    var pane = document.getElementById('ble-pane');
    if (!pane || pane.style.display === 'none') return;   // 不在蓝牙页：本轮不刷
    invoke('ble_refresh_rssi').then(function(info) {
        if (!info) return;
        // 后端顺带回报链路状态：设备主动断开时立刻切成未连接，
        // 否则界面会一直停在假的「已连接 / 断开设备」上
        if (info.connected === false) { onBleLinkLost(); return; }
        if (info.rssi == null) return;
        applyLiveRssi(_bleConnAddr, info.rssi);
    }).catch(function() {});
}
// 链路自行断开（设备主动断开 / 关机 / 超出范围）：把界面同步成未连接
function onBleLinkLost() {
    var addr = _bleConnAddr;
    if (!addr) return;
    _bleConnAddr = null;
    _bleConnInfo = null;
    _bleServices = [];
    _bleSubs = {};
    stopBleNotifyPoll();
    stopBleRssiPoll();
    closeBleWriteModal();
    _bleDevices.forEach(function(d) { d.connected = false; });
    clearBleLog();                                          // 本次会话结束 → 先清空
    logBle('[已断开] 设备侧断开或超出范围（' + addr + '）');   // 再留一行原因，便于排查
    showToast('设备已断开连接', 'error');
    renderBleDeviceList();
    renderBleDetail();
}
// 只更新该设备的信号强度显示：不重排列表、不重建详情，避免跳动与滚动位置复位
function applyLiveRssi(address, rssi) {
    var dev = null;
    for (var i = 0; i < _bleDevices.length; i++) {
        if (_bleDevices[i].address === address) { dev = _bleDevices[i]; break; }
    }
    if (dev) dev.rssi = rssi;
    var isActive = (address === _bleSelected);
    var color = bleRssiColor(rssi, isActive);
    // typeof 守卫：非数字（读 RSSI 失败 / null）时给 null，让调用方按"无读数"处理。
    // 少了它 `(undefined + 100) / 90 * 100` → NaN，`Math.round(NaN)` 也是 NaN，
    // 最后画出一条 width:NaN% 的进度条（另一处 12193 一直有守卫，这里是漏的）。2026-09 审计发现。
    var pct = (typeof rssi === 'number' && isFinite(rssi))
        ? Math.max(0, Math.min(100, Math.round((rssi + 100) / 90 * 100)))
        : null;
    var card = document.querySelector('.ble-dev-card[data-addr="' + address + '"]');
    if (card) {
        var txt = card.querySelector('.ble-dev-rssi');
        // 没有读数就说"没有读数"：`null + ' dBm'` 会显示成 "null dBm"
        if (txt) {
            txt.textContent = (typeof rssi === 'number') ? (rssi + ' dBm') : '—';
            txt.style.color = color;
        }
        var bar = card.querySelector('.ble-dev-rssi-bar > span');
        if (bar) { bar.style.width = (pct === null ? '0%' : pct + '%'); bar.style.background = color; }
    }
    if (isActive && dev) {
        var meta = document.querySelector('#ble-detail .ble-detail-meta');
        // 走同一个纯函数：否则这里的 RSSI 刷新会把 MTU 那一段刷掉
        if (meta) meta.textContent = bleDetailMetaText(dev, rssi, _bleMtu);
    }
}

function openBle() {
    console.log('[BLE] 打开蓝牙调试页面');
    document.getElementById('paneContainer').style.display = 'none';
    document.getElementById('wsl-pane').style.display = 'none';
    document.getElementById('adb-pane').style.display = 'none';
    document.getElementById('ble-pane').style.display = 'flex';
    refreshMonitorPollRates();   // 页面切换 → 按可见性重设读取频率（隐藏的监视器降频）
    // 收起其它面板按钮的 active 态
    var wBtn = document.getElementById('wslToggleBtn');
    if (wBtn) { wBtn.setAttribute('title', 'WSL 端口映射'); wBtn.setAttribute('onclick', 'openWslMapping()'); wBtn.classList.remove('active'); }
    var aBtn = document.getElementById('adbToggleBtn');
    if (aBtn) { aBtn.setAttribute('title', 'ADB 调试'); aBtn.setAttribute('onclick', 'openAdb()'); aBtn.classList.remove('active'); }
    // 蓝牙按钮切到 active
    var btn = document.getElementById('bleToggleBtn');
    if (btn) { btn.setAttribute('title', '返回到串口调试器'); btn.setAttribute('onclick', 'closeBle()'); btn.classList.add('active'); }
    var text = document.getElementById('bleToggleText');
    if (text) text.textContent = '返回到串口调试器';
    // 顶栏「打开额外监视器」在蓝牙页是开关：进入页面时同步按钮状态与标题
    updateBleMonBtn();
    // 首次填充面板内容
    var blePane = document.getElementById('ble-pane');
    if (!blePane._initialized) {
        blePane.style.flexDirection = 'column';
        blePane.innerHTML =
            // 模式切换（主机 / 从机）放在**左侧分栏顶部**，不是横贯顶部的一条。
            // 两套 UI 各自带一个（同一时刻只显示一个），状态由 setBleMode 同步。
            '<div class="ble-body" id="bleBody">' +
                '<div class="ble-left">' +
                    bleModeSegHtml() +
                    '<div class="ble-left-head">' +
                        '<div class="ble-left-title"><svg width="20" height="20" viewBox="0 0 1024 1024" fill="currentColor"><path d="M466.125 149.709a45.875 45.875 0 0 1 70.349-39.936l1.638 1.126 250.982 178.483a48.128 48.128 0 0 1 2.253 76.186l-1.843 1.331L593.92 508.723l194.56 137.728a48.026 48.026 0 0 1 1.946 76.493l-1.844 1.434-250.47 178.483a45.773 45.773 0 0 1-71.68-36.762V601.6L287.437 731.238a45.056 45.056 0 0 1-62.157-9.523l-1.331-1.945a48.23 48.23 0 0 1 9.216-64.41l1.843-1.434 198.246-144.179L235.52 369.664a48.026 48.026 0 0 1-13.107-63.693l1.229-2.048a45.056 45.056 0 0 1 61.44-13.517l1.945 1.332 179.2 126.566z m92.16 448.102V773.94l123.801-87.859z m0-358.4V419.84l124.928-90.624z" p-id="13027"></path></svg>蓝牙列表</div>' +
                        '<button class="add-btn icon-btn" id="bleScanBtn" onclick="toggleBleScan()" title="开始/停止扫描" style="background:var(--accent-focus);color:#fff;border:1px solid transparent;width:auto;height:28px;box-sizing:border-box;padding:0 12px;margin-left:auto;gap:0;border-radius:5px;font-size:12px;flex-shrink:0;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;">开始扫描</button>' +
                        // 扫描时长：低功耗从机广播间隔常在 1~10 秒，5 秒硬编码窗口经常一包都收不到
                        '<select class="ble-scan-secs" id="bleScanSecs" onchange="onBleScanSecsChange()" title="自动停止扫描的时长">' +
                            '<option value="5">5 秒</option>' +
                            '<option value="15" selected>15 秒</option>' +
                            '<option value="30">30 秒</option>' +
                            '<option value="60">60 秒</option>' +
                            '<option value="0">持续</option>' +
                        '</select>' +
                    '</div>' +
                    // 按 MAC 直连：从机被 Windows 配对过 / 被别的手机连走后常常不再广播，
                    // 于是永远进不了扫描列表 —— 这种情况下只能按地址直接连
                    '<div class="ble-direct-row">' +
                        '<input class="ble-direct-input" id="bleDirectAddr" spellcheck="false" autocomplete="off" ' +
                            'placeholder="输入目标设备 MAC 直接连接" ' +
                            'onkeydown="if(event.key===\'Enter\'){event.preventDefault();connectBleDirect();}">' +
                        '<button class="ble-direct-btn" id="bleDirectBtn" onclick="connectBleDirect()" title="不依赖广播，直接按地址连接">直连</button>' +
                    '</div>' +
                    '<div class="ble-filter-row">' +
                        '<span class="ble-filter-toggle" onclick="toggleBleFilter(this)" title="过滤设备"><span class="ble-svc-caret">&#9654;</span>过滤 <span class="ble-filter-count" id="ble-filterCount"></span></span>' +
                    '</div>' +
                    '<div class="ble-filter-body" id="ble-filterBody" style="display:none;">' +
                        '<input class="ble-filter-input" id="bleFilterText" placeholder="输入名称或 MAC 地址" oninput="applyBleFilter()">' +
                        '<div class="ble-filter-hint">按设备名称或 MAC 地址过滤</div>' +
                    '</div>' +
                    '<div class="ble-devList no-scrollbar" id="ble-devList"></div>' +
                '</div>' +
                '<div class="ble-left-resize" id="ble-leftResize" title="拖动调节设备栏宽度"></div>' +
                '<div class="ble-right">' +
                    '<div class="ble-detail" id="ble-detail"></div>' +
                '</div>' +
                // 内嵌串口监视器区：由 toggleBleMonitor() 动态放入一个监视器窗口（开关语义，最多一个），
                // 左侧 5px 手柄可拖动调宽（见 initBleMonResize）
                '<div class="ble-monArea" id="ble-monitorArea">' +
                    '<div class="ble-mon-resize" id="ble-monResize" title="拖动调节宽度"></div>' +
                '</div>' +
            '</div>' +
            // ---- 从机（外设）模式：左列配置，右列状态 + 事件日志 ----
            '<div class="ble-periph" id="blePeriph">' +
                '<div class="ble-pf-left">' +
                    bleModeSegHtml() +
                    // 广播配置：内置预设 + 从**表格文件**（CSV 或 Markdown 表格）导入/导出。
                    // 服务结构那种又长又容易抄错的东西，放在表格里维护比在界面上一行行填舒服得多。
                    '<div class="ble-pf-sec">' +
                        '<div class="ble-pf-label">广播配置</div>' +
                        '<select class="ble-pf-select" id="blePfPreset" onchange="blePfApplyPreset(this.value)"></select>' +
                        '<div class="ble-pf-row">' +
                            '<button class="ble-pf-btn" id="blePfImportBtn" onclick="blePfImportTable()" title="从 CSV / Markdown 表格文件导入服务与特征">导入表格</button>' +
                            '<button class="ble-pf-btn" id="blePfExportBtn" onclick="blePfExportTable()" title="把当前服务与特征导出成 CSV 表格（可用 Excel/WPS 编辑）">导出表格</button>' +
                        '</div>' +
                    '</div>' +
                    // 我的配置：把常用的一套（服务 + 特征 + 选项）存下来，不用每次手抄 UUID
                    '<div class="ble-pf-sec">' +
                        '<div class="ble-pf-label">我的配置</div>' +
                        '<div class="ble-pf-row" style="margin-top:0;">' +
                            '<select class="ble-pf-select" id="blePfSaved" style="flex:1;min-width:0;" onchange="blePfLoadSaved(this.value)"></select>' +
                            '<button class="ble-pf-btn" onclick="blePfDeleteSaved()" title="删除当前选中的配置">删除</button>' +
                        '</div>' +
                        '<div class="ble-pf-row">' +
                            '<input class="ble-pf-input" id="blePfSavedName" style="flex:1;min-width:0;" spellcheck="false" autocomplete="off" placeholder="配置名，如 温湿度计">' +
                            '<button class="ble-pf-btn" onclick="blePfSaveAs()" title="把当前这套配置存下来">保存</button>' +
                        '</div>' +
                    '</div>' +
                    '<div class="ble-pf-sec">' +
                        '<div class="ble-pf-label">服务 UUID<span class="ble-pf-sub">只能广播一个服务</span></div>' +
                        '<input class="ble-pf-input" id="blePfService" spellcheck="false" autocomplete="off" ' +
                            'placeholder="6E400001-B5A3-F393-E0A9-E50E24DCCA9E 或 0xFFE0" ' +
                            'title="支持短写（如 0xFFE0），保存时自动展开成完整 128 位" ' +
                            'oninput="blePfSyncService(this.value)">' +
                    '</div>' +
                    '<div class="ble-pf-sec">' +
                        '<div class="ble-pf-label">特征 <span class="ble-pf-sub" id="blePfCharCount"></span></div>' +
                        '<div id="blePfCharEditor"></div>' +
                        '<button class="ble-pf-btn ble-pf-add" onclick="blePfAddChar()">+ 添加特征</button>' +
                    '</div>' +
                    '<div class="ble-pf-sec">' +
                        '<div class="ble-pf-label">广播选项</div>' +
                        '<label class="ble-pf-check"><input type="checkbox" id="blePfDiscoverable" checked>可被发现</label>' +
                        '<div class="ble-pf-row"><label class="ble-pf-check"><input type="checkbox" id="blePfConnectable" checked>可连接</label></div>' +
                        '<div class="ble-pf-row"><label class="ble-pf-check" title="勾上后主机的每次写入都会挂起，等你点「接受 / 拒绝（协议错误码）」——调试主机侧错误处理时必需">' +
                            '<input type="checkbox" id="blePfManualReply">写入需手动应答</label></div>' +
                        '<div class="ble-pf-row" style="margin-top:8px;">' +
                            '<label class="ble-pf-check" style="flex-shrink:0;"><input type="checkbox" id="blePfAdvData" onchange="blePfCollectOptions();renderBlePfAdvLen();">广播服务数据(HEX)</label>' +
                            '<input class="ble-pf-input" id="blePfAdvDataHex" style="flex:1;min-width:80px;" spellcheck="false" autocomplete="off" ' +
                                'placeholder="01 02" title="传统广播总共 31 字节，填太长会被截断" ' +
                                'oninput="blePfCollectOptions();renderBlePfAdvLen();">' +
                        '</div>' +
                        // 只在"偏长/格式错"时出现一行；正常不占地方
                        '<div class="ble-pf-warnline" id="blePfAdvLen"></div>' +
                        '<div class="ble-pf-hint" id="blePfAdapter"></div>' +
                    '</div>' +
                    '<div class="ble-pf-sec" style="border-bottom:0;">' +
                        '<div class="ble-pf-row" style="margin-top:0;">' +
                            '<button class="ble-pf-btn primary" id="blePfStartBtn" data-mcp-skip="1" onclick="startBlePeriph()">开始广播</button>' +
                            '<button class="ble-pf-btn danger" id="blePfStopBtn" data-mcp-skip="1" onclick="stopBlePeriph()" disabled>停止广播</button>' +
                            '<span class="ble-pf-badge" id="blePfBadge">未启动</span>' +
                        '</div>' +
                        '<div id="blePfWarn"></div>' +
                    '</div>' +
                '</div>' +
                '<div class="ble-left-resize" id="ble-pfResize" title="拖动调节配置栏宽度"></div>' +
                '<div class="ble-pf-right">' +
                    '<div class="ble-pf-label" style="margin-bottom:0;">特征状态 <span class="ble-pf-sub" id="blePfSvcLabel"></span></div>' +
                    '<div class="ble-pf-chars" id="blePfChars"></div>' +
                    // 手动应答模式下，待应答的写请求挂在这里等用户决定
                    '<div id="blePfPending"></div>' +
                    '<div class="ble-pf-label" style="margin-bottom:0;">事件日志' +
                        '<span class="ble-log-clear" onclick="clearBlePeriphLog()" title="清空事件日志">清空</span>' +
                    '</div>' +
                    '<div class="ble-log" id="blePfLog">暂无事件。开始广播后，手机的读取 / 写入 / 订阅都会记在这里。</div>' +
                '</div>' +
            '</div>';
        blePane._initialized = true;
        // 监视器区（含宽度拖拽手柄）已就位：绑一次拖拽
        initBleMonResize();
        // 左栏（设备列表 / 从机配置）宽度：先套上记住的宽度，再绑拖拽手柄
        applyBleLeftWidth();
        initBleLeftResize();
        initBlePfForm();
    }
    // 从用户配置恢复的蓝牙页状态：DOM 就绪后再应用（过滤框内容、上次打开的内嵌监视器）
    var filterInp = document.getElementById('bleFilterText');
    if (filterInp) filterInp.value = _bleFilterText || '';
    var secsSel = document.getElementById('bleScanSecs');
    if (secsSel) {
        secsSel.value = String(_bleScanSecs);
        // 配置里存的值不在选项里（比如手改过配置文件）→ 回落到 15 秒
        if (secsSel.value !== String(_bleScanSecs)) { _bleScanSecs = 15; secsSel.value = '15'; }
    }
    var filterBody = document.getElementById('ble-filterBody');
    if (filterBody) filterBody.style.display = _bleFilterOpen ? '' : 'none';
    if (_bleRestoreMon) {
        var want = _bleRestoreMon;
        _bleRestoreMon = null;                       // 只消费一次
        if (!_bleExtraMon) {
            toggleBleMonitor();                      // 打开内嵌监视器
            if (want.cfg) applyMonitorConfig('ble-mon', want.cfg);   // 再套用它的端口/波特率等设置
        }
        var area = document.getElementById('ble-monitorArea');
        if (area && want.width) area.style.flex = '0 0 ' + want.width + 'px';
        _bleMonWidth = want.width || _bleMonWidth;
    }
    // 从机模式：表单状态先恢复，再按保存的模式切换视图
    renderBlePfForm();
    setBleMode(_bleMode);
    // 蓝牙页的「打开额外监视器」是开关（开/关右侧嵌入的串口监视器，见 toggleBleMonitor），
    // 因此这里不再禁用按钮；按钮的可用性由 addMonitor() 按当前页面路由
    // 进入面板即刷新设备列表；先检测蓝牙兼容性（无适配器/蓝牙栈不可用 → 红字提示）
    invoke('ble_get_adapters').then(function(list) {
        _bleAdapterCount = (list || []).length;
        if (!list || !list.length) { showBleIncompatible('当前电脑蓝牙不兼容'); _bleDevices = []; renderBleDeviceList(); return; }
        // 多适配器：把数量写进扫描按钮的提示，免得"第二个适配器上的设备搜不到"又被当成玄学
        if (_bleAdapterCount > 1) {
            var sb = document.getElementById('bleScanBtn');
            if (sb) sb.title = '开始/停止扫描（' + _bleAdapterCount + ' 个适配器会同时扫描）';
        }
        // 切页回来：BLE 连接在后端是持续存在的，先按后端真实状态恢复
        // GATT 服务树与通知轮询，再刷新设备列表（否则会显示成未连接）
        syncBleConnection().then(refreshBleDevices);
    }).catch(function() { showBleIncompatible('当前电脑蓝牙不兼容'); _bleDevices = []; renderBleDeviceList(); });
}

// 同步后端真实连接态：地址 + GATT 服务 + 通知轮询
function syncBleConnection() {    var prevAddr = _bleConnAddr;   // 用于判断「切页期间链路自己断了」
    return invoke('ble_get_connection').catch(function() { return null; }).then(function(addr) {
        _bleConnAddr = addr || null;
        if (!_bleConnAddr) {
            _bleServices = [];
            _bleSubs = {};   // 连接已不在（含链路自行断开）：订阅显示一并复位
            stopBleNotifyPoll();
            stopBleRssiPoll();
            clearBleLog();   // 连接不在了 → 日志也清空（与「断开即清空」一致）
            if (prevAddr) logBle('[已断开] 设备侧断开或超出范围（' + prevAddr + '）');
            return null;
        }
        _bleSelected = _bleConnAddr;
        return invoke('ble_get_services').then(function(svcs) {
            _bleServices = svcs || [];
            refreshBleMtu();
            startBleNotifyPoll();
            startBleRssiPoll();
        }).catch(function(e) { console.warn('[BLE] 恢复 GATT 服务失败:', e); });
    });
}

// 扫描时长改动：立即持久化；若正在扫描，按新时长重排自动停止
function onBleScanSecsChange() {
    _bleScanSecs = bleScanSecs();
    scheduleConfigSave();
    logBle('[扫描] 自动停止时长改为 ' + bleScanSecsLabel());
    if (_bleScanning) enableBleScanAutoStop();   // 正在扫描：按新时长重排
}

// MAC 粗校验（6 段冒号分隔）。权威判断在后端（btleplug 的 BDAddr 解析），
// 这里只是别把明显不是地址的东西发过去。
function bleMacLooksValid(s) {
    return /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(String(s == null ? '' : s).trim());
}

// 按 MAC 直连。用于「设备不广播、扫描列表里永远没有它」这种情况 ——
// 从机被 Windows 配对过、或被另一台主机连走时最常见，也是"从机搜不到也连不上"的正解。
// `addrIn` 只有 MCP 的 ble_connect 会传（面板按钮不带参数、读输入框）；
// 返回 Promise<{ok:true, addr, name} | {ok:false, error, invalidParams?}>（一律 resolve）。
function connectBleDirect(addrIn) {
    if (_bleConnecting) {
        showToast('正在连接，请稍候…', 'info');
        return Promise.resolve({ ok: false, error: '正在连接，请稍候…' });
    }
    var inp = document.getElementById('bleDirectAddr');
    var addr = String(addrIn || (inp ? inp.value : '') || '').trim().toUpperCase();
    if (!bleMacLooksValid(addr)) {
        showToast('请输入 6 段 MAC，例如 A4:C1:38:11:14:2B', 'error');
        if (inp) inp.focus();
        return Promise.resolve({ ok: false, invalidParams: true,
                                 error: '地址不是 6 段 MAC（例如 A4:C1:38:11:14:2B）' });
    }
    if (inp) inp.value = addr;   // 回填输入框：用户看得见这次直连用的是哪个地址
    var btn = document.getElementById('bleDirectBtn');
    if (btn) btn.disabled = true;
    _bleConnecting = true;
    logBle('[直连] ' + addr + '（不依赖广播）');
    return invokeTimeout('ble_connect_direct', { address: addr }, BLE_CONNECT_TIMEOUT_MS).then(function() {
        _bleConnecting = false;
        if (btn) btn.disabled = false;
        return bleOnConnected(addr, '直连设备');
    }).then(function() {
        refreshBleDevices();
        showToast('已连接 ' + addr, 'success');
        return { ok: true, addr: addr, name: '直连设备' };
    }).catch(function(e) {
        _bleConnecting = false;
        if (btn) btn.disabled = false;
        logBle('[直连失败] ' + e);
        showToast('直连失败: ' + e, 'error');
        return { ok: false, error: String(e) };
    });
}

// 读取协商后的 MTU 并刷新详情头。
// 默认 23 → 有效载荷 20 字节；写长数据失败时靠它分辨"是 MTU 还是特征的问题"。
function refreshBleMtu() {
    return invoke('ble_get_mtu').then(function(m) {
        _bleMtu = (typeof m === 'number') ? m : 0;
        renderBleDetail();
    }).catch(function() { _bleMtu = 0; });
}

// 详情头的元信息（纯函数，便于无头断言）：地址 · 地址类型 · RSSI [· MTU]
// 抽出来是因为 RSSI 轮询会单独重写这一行，两处不能各写一份（否则 MTU 会被刷掉）
function bleDetailMetaText(dev, rssi, mtu) {
    dev = dev || {};
    var parts = [dev.address || ''];
    parts.push(dev.addressType || '—');
    parts.push((typeof rssi === 'number') ? (rssi + ' dBm') : '—');
    if (dev.connected && mtu > 0) parts.push('MTU ' + mtu + '（载荷 ' + (mtu - 3) + '）');
    return parts.join(' · ');
}

// 描述符文本 → [{uuid, value}]。格式：`UUID=值`，多个用 `;` 或换行分隔。
// 值默认按 HEX 解析；加 `T:` 前缀按 UTF-8 文本（0x2901 用户描述那种场景）。
// 返回 { descs } 或 { error }。注意 0x2900~0x290F 是标准描述符、由系统自动发布，
// 手工创建会被 WinRT 拒绝（真机实测），后端也会在本地挡掉。
function blePeriphParseDescriptors(s) {
    var out = [];
    var text = String(s == null ? '' : s).trim();
    if (!text) return { descs: out };
    var parts = text.split(/[;\n]/);
    for (var i = 0; i < parts.length; i++) {
        var p = parts[i].trim();
        if (!p) continue;
        var eq = p.indexOf('=');
        if (eq <= 0) return { error: '描述符「' + p + '」格式不对：应为 UUID=值' };
        var uuid = p.slice(0, eq).trim();
        var raw = p.slice(eq + 1).trim();
        if (!uuid) return { error: '描述符「' + p + '」缺少 UUID' };
        var bytes;
        if (raw.slice(0, 2) === 'T:') {
            bytes = Array.from(new TextEncoder().encode(raw.slice(2)));
        } else {
            var r = blePeriphHexBytes('描述符 ' + uuid, raw);
            if (r.error) return { error: r.error };
            bytes = r.bytes;
        }
        out.push({ uuid: uuid, value: bytes });
    }
    return { descs: out };
}

// 广播服务数据长度文案（纯函数）。传统广播总共 31 字节，还要放 flags 与服务 UUID。
// **只是提示**：真正的判定以后端返回的广播状态（StartedWithoutAllAdvertisementData）为准。
function blePeriphAdvDataWarnText(len) {
    if (!len) return '';
    if (len > 24) {
        return '⚠ ' + len + ' 字节偏长：传统广播总共只有 31 字节（还要放 flags 与服务 UUID），可能被截断';
    }
    return len + ' 字节（传统广播总额 31 字节，够用）';
}

// 广播数据长度的**告警行**：只在"偏长"或"格式错"时出现，正常时清空（不占版面）
function renderBlePfAdvLen() {
    var el = document.getElementById('blePfAdvLen');
    if (!el) return;
    var on = document.getElementById('blePfAdvData');
    if (!on || !on.checked) { el.textContent = ''; return; }
    var hex = document.getElementById('blePfAdvDataHex');
    var r = blePeriphHexBytes('广播服务数据', hex ? hex.value : '');
    if (r.error) { el.textContent = '⚠ ' + r.error; return; }
    var w = blePeriphAdvDataWarnText(r.bytes.length);
    el.textContent = (w && w.indexOf('偏长') >= 0) ? w : '';
}

// ---- 手动应答：待处理的写请求 ----
var _blePfPending = [];   // [{id, uuid, hex}]
function renderBlePfPending() {
    var box = document.getElementById('blePfPending');
    if (!box) return;
    if (!_blePfPending.length) { box.innerHTML = ''; return; }
    box.innerHTML = _blePfPending.map(function(p) {
        return '<div class="ble-pf-pending">' +
            '<span class="ble-pf-pending-txt">待应答 #' + p.id + ' · 0x' + escapeHtml(shortUuid(p.uuid || '')) +
                ' ← ' + escapeHtml(p.hex || '') + '</span>' +
            '<button class="ble-pf-btn" data-reply="' + p.id + '" data-accept="1">接受</button>' +
            '<button class="ble-pf-btn danger" data-reply="' + p.id + '" data-accept="0" title="按协议错误码 0x80 回复">拒绝</button>' +
        '</div>';
    }).join('');
}
function respondBlePfWrite(id, accept) {
    if (isNaN(id)) return;
    invoke('ble_periph_respond_write', { pendingId: id, accept: !!accept }).then(function() {
        _blePfPending = _blePfPending.filter(function(x) { return x.id !== id; });
        renderBlePfPending();
        refreshBlePeriphStatus();
    }).catch(function(e) {
        // 多半是已经超时被后端按协议错误回掉了：把它从列表里摘掉，不留死按钮
        _blePfPending = _blePfPending.filter(function(x) { return x.id !== id; });
        renderBlePfPending();
        showToast('应答失败: ' + e, 'error');
    });
}
function onBlePfPendingClick(e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-reply]') : null;
    if (!el) return;
    respondBlePfWrite(parseInt(el.getAttribute('data-reply'), 10), el.getAttribute('data-accept') === '1');
}

// ---- 我的配置（多套从机配置保存）----
var _blePeriphSaved = [];   // [{name, form}]
function renderBlePfSaved() {
    var sel = document.getElementById('blePfSaved');
    if (!sel) return;
    var cur = sel.value;
    var html = '<option value="">（未选择）</option>';
    _blePeriphSaved.forEach(function(it) {
        html += '<option value="' + escapeHtml(it.name) + '">' + escapeHtml(it.name) + '</option>';
    });
    sel.innerHTML = html;
    var keep = false;
    _blePeriphSaved.forEach(function(it) { if (it.name === cur) keep = true; });
    if (keep) sel.value = cur;
}
function blePfSaveAs() {
    var inp = document.getElementById('blePfSavedName');
    var name = inp ? String(inp.value || '').trim() : '';
    if (!name) { showToast('请先填个配置名', 'error'); if (inp) inp.focus(); return; }
    var form = blePfCollectForm();
    var hit = null;
    _blePeriphSaved.forEach(function(it) { if (it.name === name) hit = it; });
    if (hit) hit.form = form; else _blePeriphSaved.push({ name: name, form: form });
    renderBlePfSaved();
    var sel = document.getElementById('blePfSaved');
    if (sel) sel.value = name;
    scheduleConfigSave();
    showToast('已保存配置「' + name + '」', 'success');
}
function blePfLoadSaved(name) {
    if (!name) return;
    var hit = null;
    _blePeriphSaved.forEach(function(it) { if (it.name === name) hit = it; });
    if (!hit) return;
    restoreBlePeriphForm(hit.form);
    renderBlePfForm();
    showToast('已载入配置「' + name + '」', 'info');
}
function blePfDeleteSaved() {
    var sel = document.getElementById('blePfSaved');
    var name = sel ? sel.value : '';
    if (!name) { showToast('请先选择要删除的配置', 'error'); return; }
    _blePeriphSaved = _blePeriphSaved.filter(function(it) { return it.name !== name; });
    renderBlePfSaved();
    scheduleConfigSave();
    showToast('已删除配置「' + name + '」', 'info');
}

// ---- 广播配置的表格文件（CSV / Markdown 表格）----
// 服务结构又长又容易抄错，放在表格里维护（Excel/WPS/记事本都行）比在界面上一行行填舒服。
// 表头固定 5 列：服务UUID,特征UUID,属性,初值HEX,描述符
//   · CSV：逗号分隔
//   · Markdown 表格：| 分隔，自动跳过 |---|---| 分隔行；单元格内的竖线按规范写 \|
//   · 属性用 `;` 分隔（`|` 在 Markdown 里是列分隔符，会打架）
//   · 空行与 # 开头的注释行忽略
var BLE_PF_TABLE_HEADER = ['服务UUID', '特征UUID', '属性', '初值HEX', '描述符'];

// 拆一行为单元格（纯函数）。返回 null 表示这行该跳过（空行/注释/表头/分隔行）。
// Markdown 表格里单元格内的竖线按规范写成 `\|`，这里先藏起来再切分，最后还原。
function blePfTableCells(line) {
    var t = String(line == null ? '' : line).trim();
    if (!t) return null;
    if (t.charAt(0) === '#') return null;
    var isMd = t.charAt(0) === '|';
    if (isMd) t = t.replace(/^\|/, '').replace(/\|$/, '');
    var cells;
    if (isMd) {
        var PH = '\u0000';
        t = t.replace(/\\\|/g, PH);
        cells = t.split('|').map(function(c) { return c.split(PH).join('|').trim(); });
    } else {
        cells = t.split(',').map(function(c) { return c.trim(); });
    }
    // Markdown 分隔行：|---|---|
    if (isMd && cells.every(function(c) { return /^:?-{2,}:?$/.test(c) || c === ''; })) return null;
    // 表头行（按第一列关键字识别，大小写与中英文都认）
    var first = (cells[0] || '').toLowerCase();
    if (first === '服务uuid' || first === 'service' || first === 'serviceuuid') return null;
    return cells;
}

// 表格文本 → { service, chars } 或 { error }（纯函数，便于无头断言）
function blePfParseTable(text) {
    var lines = String(text == null ? '' : text).split(/\r?\n/);
    var service = '';
    var chars = [];
    for (var i = 0; i < lines.length; i++) {
        var cells = blePfTableCells(lines[i]);
        if (!cells) continue;
        if (cells.length < 2) return { error: '第 ' + (i + 1) + ' 行只有 ' + cells.length + ' 列：至少要「服务UUID,特征UUID」' };
        var svc = cells[0] || '';
        var cuuid = cells[1] || '';
        if (!svc) return { error: '第 ' + (i + 1) + ' 行服务 UUID 为空' };
        if (!cuuid) return { error: '第 ' + (i + 1) + ' 行特征 UUID 为空' };
        if (!service) {
            service = svc;
        } else if (svc.replace(/^0x/i, '').toLowerCase() !== service.replace(/^0x/i, '').toLowerCase()) {
            // 平台限制：一个服务提供者只能广播一个服务 UUID，文件里出现两个就必须说清楚
            return { error: '第 ' + (i + 1) + ' 行出现了另一个服务 UUID（' + svc + '）：本应用一次只能广播一个服务' };
        }
        chars.push({
            uuid: cuuid,
            // 属性分隔符只认 `;`：`|` 在 Markdown 表格里是列分隔符，拿来当属性分隔会打架
            props: (cells[2] || '').split(';').map(function(s) { return s.trim(); }).filter(function(s) { return s; }),
            value: cells[3] || '',
            desc: cells[4] || ''
        });
        if (chars.length > BLE_PERIPH_CHAR_MAX) {
            return { error: '特征数量超过上限 ' + BLE_PERIPH_CHAR_MAX + ' 个' };
        }
    }
    if (!service || !chars.length) return { error: '没有解析到任何特征行（第一列服务 UUID、第二列特征 UUID）' };
    return { service: service, chars: chars };
}

// 当前表单 → 表格文本（CSV）。Excel/WPS 直接打开即可编辑，改完再「导入表格」。
function blePfBuildTable(form) {
    form = form || blePfCollectForm();
    var esc = function(v) {
        var s = String(v == null ? '' : v);
        // 含逗号/引号/换行时按 CSV 规范加引号
        return /[",\n]/.test(s) ? ('"' + s.replace(/"/g, '""') + '"') : s;
    };
    var rows = [BLE_PF_TABLE_HEADER.join(',')];
    (form.chars || []).forEach(function(c) {
        rows.push([
            esc(form.service),
            esc(c.uuid),
            esc((c.props || []).join(';')),
            esc(c.value || ''),
            esc(c.desc || '')
        ].join(','));
    });
    return rows.join('\r\n') + '\r\n';
}

// 从文件导入：后端负责弹文件框与读文件，前端只解析与应用
function blePfImportTable() {
    var btn = document.getElementById('blePfImportBtn');
    if (btn) btn.disabled = true;
    invoke('ble_periph_pick_config_file').then(function(res) {
        if (btn) btn.disabled = false;
        if (!res) return;                       // 用户取消
        var r = blePfParseTable(res.text);
        if (r.error) { showToast('表格解析失败：' + r.error, 'error'); return; }
        _blePeriphForm.service = r.service;
        _blePeriphForm.chars = r.chars;
        _blePeriphForm.presetId = '';           // 来自文件，不再属于任何内置预设
        renderBlePfForm();
        scheduleConfigSave();
        logBle('[从机] 已从表格导入 ' + r.chars.length + ' 个特征：' + (res.path || ''));
        showToast('已导入 ' + r.chars.length + ' 个特征', 'success');
    }).catch(function(e) {
        if (btn) btn.disabled = false;
        showToast('导入失败: ' + e, 'error');
    });
}

// 导出为 CSV 表格（用文件框选路径）
function blePfExportTable() {
    var btn = document.getElementById('blePfExportBtn');
    if (btn) btn.disabled = true;
    var text = blePfBuildTable();
    invoke('ble_periph_save_config_file', { text: text }).then(function(path) {
        if (btn) btn.disabled = false;
        if (!path) return;                      // 用户取消
        logBle('[从机] 配置已导出到表格：' + path);
        showToast('已导出：' + path, 'success');
    }).catch(function(e) {
        if (btn) btn.disabled = false;
        showToast('导出失败: ' + e, 'error');
    });
}

function showBleIncompatible(msg) {    var list = document.getElementById('ble-devList');
    if (!list) return;
    // 用 textContent 而非拼 innerHTML：这个函数现在是字面量调用，
    // 但一旦有人传动态文案就会变成注入口（同类问题见 BLE 详情头曾漏转义设备名）
    list.innerHTML = '<div class="ble-err"></div>';
    list.firstChild.textContent = msg;
}
function toggleBleFilter(el) {
    _bleFilterOpen = !_bleFilterOpen;
    var body = document.getElementById('ble-filterBody');
    if (body) body.style.display = _bleFilterOpen ? 'block' : 'none';
    if (el) el.classList.toggle('expanded', _bleFilterOpen);
    scheduleConfigSave();   // 展开态随用户配置保留
}
function applyBleFilter() {
    var inp = document.getElementById('bleFilterText');
    _bleFilterText = (inp && inp.value) ? inp.value.trim().toLowerCase() : '';
    renderBleDeviceList();
    scheduleConfigSave();   // 过滤关键字随用户配置保留
}

function closeBle() {
    console.log('[BLE] 返回监视器页面');
    document.getElementById('ble-pane').style.display = 'none';
    document.getElementById('paneContainer').style.display = 'flex';
    refreshMonitorPollRates();   // 页面切换 → 按可见性重设读取频率（隐藏的监视器降频）
    var addBtn = document.getElementById('addMonitorBtn');
    if (addBtn) { addBtn.style.opacity = ''; addBtn.style.pointerEvents = ''; addBtn.title = '打开额外监视器'; addBtn.classList.remove('active'); }
    var btn = document.getElementById('bleToggleBtn');
    if (btn) { btn.setAttribute('title', '蓝牙调试'); btn.setAttribute('onclick', 'openBle()'); btn.classList.remove('active'); }
    var text = document.getElementById('bleToggleText');
    if (text) text.textContent = '蓝牙调试';
    // 从机的两个轮询只在蓝牙页有意义；广播本身留在后端继续（与主机连接一样跨页保持）
    stopBlePeriphPoll();
}

function toggleBleScan() {
    _bleScanning = !_bleScanning;
    var btn = document.getElementById('bleScanBtn');
    if (_bleScanning) {
        if (btn) btn.textContent = '停止扫描';
        if (!_bleDevices.length) renderBleDeviceList();   // 空列表时立刻显示「正在扫描…」
        invoke('ble_start_scan').then(function(n) {
            // 多适配器：后端会把扫描开到每一个适配器上，返回值是成功的个数
            if (typeof n === 'number' && n > 0) _bleAdapterCount = Math.max(_bleAdapterCount, n);
            refreshBleDevices();
            if (_bleDevTimer) clearInterval(_bleDevTimer);
            _bleDevTimer = setInterval(refreshBleDevices, 2000);
            enableBleScanAutoStop();
            renderBleDeviceList();   // 让空态显示"几个适配器在扫"
        }).catch(function(e) {
            console.warn('[BLE] 启动扫描失败:', e);
            _bleScanning = false;
            if (btn) btn.textContent = '开始扫描';
            if (_bleScanStopTimer) { clearTimeout(_bleScanStopTimer); _bleScanStopTimer = null; }
            showBleIncompatible('当前电脑蓝牙不兼容');
        });
    } else {
        stopBleScan();  // 手动停止
    }
}
// 停止扫描（手动或自动共用）
function stopBleScan() {
    _bleScanning = false;
    var btn = document.getElementById('bleScanBtn');
    if (btn) btn.textContent = '开始扫描';
    if (_bleScanStopTimer) { clearTimeout(_bleScanStopTimer); _bleScanStopTimer = null; }
    invoke('ble_stop_scan').catch(function(e) { console.warn('[BLE] 停止扫描失败:', e); });
    if (_bleDevTimer) { clearInterval(_bleDevTimer); _bleDevTimer = null; }
    if (!_bleDevices.length) renderBleDeviceList();   // 空列表时把「正在扫描…」换回未发现提示
}
// 扫描时长（秒）。0 = 一直扫到用户手动停。
// 以前硬编码 5 秒：低功耗从机广播间隔常在 1~2 秒、甚至 5~10 秒，
// 5 秒窗口经常一包都收不到，而且停得**悄无声息**，用户只会以为"没搜到"。
var BLE_SCAN_SECS_CHOICES = [5, 15, 30, 60, 0];
function bleScanSecs() {
    var el = document.getElementById('bleScanSecs');
    if (el) {
        var v = parseInt(el.value, 10);
        if (!isNaN(v)) return v;
    }
    return _bleScanSecs;   // 面板还没建：用配置里恢复出来的值
}
function bleScanSecsLabel() {
    var v = bleScanSecs();
    return v > 0 ? (v + ' 秒') : '持续';
}
// 扫描开始后按所选时长自动停止（除非期间已手动停止）
function enableBleScanAutoStop() {
    if (_bleScanStopTimer) { clearTimeout(_bleScanStopTimer); _bleScanStopTimer = null; }
    var secs = bleScanSecs();
    if (secs <= 0) return;   // 选「持续」就不自动停
    _bleScanStopTimer = setTimeout(function() {
        _bleScanStopTimer = null;
        if (!_bleScanning) return;
        stopBleScan();
        // **不要静默停止**：否则用户看到列表不再更新，会以为是自己没搜到
        logBle('[扫描] 已按设定时长（' + secs + ' 秒）自动停止；可在左上角把时长改成「持续」');
        showToast('扫描已自动停止（' + secs + ' 秒）；要长时间搜索请把时长改成「持续」', 'info');
    }, secs * 1000);
}

function refreshBleDevices() {
    // 连接态以后端为准：每次刷新都带上真实已连接地址，
    // 否则重建列表时会把 connected 硬编码成 false（切页回来显示成未连接）
    // 返回 promise 只为让 MCP 的 ble_list_devices 能"等刷新完再读"
    // （面板自己 fire-and-forget 调用，行为一个字没变）
    return Promise.all([
        invoke('ble_get_devices'),
        invoke('ble_get_connection').catch(function() { return null; })
    ]).then(function(res) {
        var devs = res[0] || [];
        var connAddr = res[1] || null;
        _bleConnAddr = connAddr;
        _bleDevices = devs.map(function(j) {
            return {
                address: j.address || '',
                name: j.local_name || j.advertisement_name || '',
                rssi: j.rssi,
                connected: !!connAddr && j.address === connAddr,
                addressType: j.address_type || '',
                deviceType: j.device_type || 'ble',
                services: j.services || [],
                adv: {
                    adName: j.advertisement_name || j.local_name || '',
                    txPower: j.tx_power_level,
                    appearance: j.appearance,
                    manufacturerData: j.manufacturer_data || [],
                    serviceData: j.service_data || [],
                    svcs: j.services || [],
                    raw: j.adv_raw || null
                }
            };
        });
        // 连接后设备常常停止广播 —— 扫描列表里就没有它了。
        // 而详情面板是靠 _bleDevices 定位设备的，找不到就会显示成空面板
        // （现象：已连接设备切到别的页面再切回来，右侧一片空白）。
        // 这里把已连接设备补进列表，保证详情始终能渲染。
        if (connAddr) {
            var foundConn = null;
            for (var k = 0; k < _bleDevices.length; k++) {
                if (_bleDevices[k].address === connAddr) { foundConn = _bleDevices[k]; break; }
            }
            if (foundConn) {
                _bleConnInfo = { address: foundConn.address, name: foundConn.name, rssi: foundConn.rssi,
                                 addressType: foundConn.addressType, deviceType: foundConn.deviceType };
            } else {
                var info = (_bleConnInfo && _bleConnInfo.address === connAddr) ? _bleConnInfo : {};
                _bleDevices.unshift({
                    address: connAddr,
                    name: info.name || '已连接设备',
                    rssi: (typeof info.rssi === 'number' ? info.rssi : null),
                    connected: true,
                    addressType: info.addressType || '',
                    deviceType: info.deviceType || 'ble',
                    services: [],
                    adv: null
                });
            }
        }
        // 已连接时把选中项落在该设备上，避免右侧详情与左侧高亮对不上
        if (connAddr) _bleSelected = connAddr;
        renderBleDeviceList();
        renderBleDetail();
    }).catch(function(e) {
        console.warn('[BLE] 获取设备失败:', e);
        _bleDevices = [];
        renderBleDeviceList();
    });
}

// 让面板刷新一次设备列表并**等它刷完**（MCP 的 ble_list_devices 用）。
// 为什么要有它：`_bleDevices` 是面板每 2 秒轮询的结果，AI 刚开完扫描就来问，
// 完全可能落在两次轮询之间 —— 那时读到的是空列表，AI 会得出"没搜到设备"的错误结论。
// 刷新失败不该让"读列表"整个失败（照旧读缓存，并把当时的情况如实说清）。
function bleRefreshDevicesNow() {
    try {
        var p = refreshBleDevices();
        return (p && typeof p.then === 'function') ? p.catch(function() {}) : Promise.resolve();
    } catch (e) {
        return Promise.resolve();
    }
}

function renderBleDeviceList() {
    var list = document.getElementById('ble-devList');
    if (!list) return;
    list.innerHTML = '';
    var shown = _bleDevices.slice();
    if (_bleFilterText) {
        shown = shown.filter(function(d) {
            var n = (d.name || '').toLowerCase();
            var a = (d.address || '').toLowerCase();
            return n.indexOf(_bleFilterText) >= 0 || a.indexOf(_bleFilterText) >= 0;
        });
    }
    // 按信号强度 RSSI 从强到弱排序（越大越强，如 -31 > -78）
    shown.sort(function(a, b) { return (b.rssi || -999) - (a.rssi || -999); });
    var countEl = document.getElementById('ble-filterCount');
    if (countEl) countEl.textContent = _bleFilterText ? ('匹配 ' + shown.length + '/' + _bleDevices.length) : '';
    if (!_bleDevices.length) {
        // 扫描中与未扫描要分开提示，否则"开始扫描后一片'未发现设备'"会让人以为扫描没生效
        // 适配器数量也写出来：多适配器时这是"为什么能搜到更多设备"的答案
        var adapterNote = _bleAdapterCount > 1 ? ('<br><span>' + _bleAdapterCount + ' 个蓝牙适配器同时在扫</span>') : '';
        list.innerHTML = _bleScanning
            ? '<div class="ble-empty scanning"><b>正在扫描…</b><br><span>正在搜索周边 BLE 设备（' + bleScanSecsLabel() + '后自动停止）</span>' + adapterNote + '</div>'
            : '<div class="ble-empty"><b>未发现蓝牙设备</b><br><span>点击「开始扫描」搜索周边 BLE 设备；设备不广播时可用上方「按 MAC 直连」</span></div>';
        return;
    }
    if (!shown.length) {
        list.innerHTML = '<div class="ble-empty">无匹配设备</div>';
        return;
    }
    shown.forEach(function(dev) {
        var isActive = (dev.address === _bleSelected);
        var card = document.createElement('div');
        card.className = 'ble-dev-card' + (isActive ? ' active' : '') + (dev.connected ? ' connected' : '');
        card.setAttribute('data-addr', dev.address);   // 供 RSSI 定点刷新定位卡片
        // RSSI 颜色与信号条强度（选中态用白色，避免蓝底上彩色不友好）
        // 已连接但不再广播的设备没有 RSSI（null）：显示「—」，不能显示成 null dBm / 满格信号条
        var hasRssi = (typeof dev.rssi === 'number');
        var rssiColor = hasRssi ? bleRssiColor(dev.rssi, isActive) : 'var(--text-d)';
        var pct = hasRssi ? Math.max(0, Math.min(100, Math.round((dev.rssi + 100) / 90 * 100))) : 0;
        // 设备类型图标 + 名称后缀提示（由后端依据广播特征判定：apple / ibeacon / pc / mesh / ble）
        var dtKey = BLE_DEV_ICONS[dev.deviceType] ? dev.deviceType : 'ble';
        var dtIcon = BLE_DEV_ICONS[dtKey];
        var dtMeta = BLE_DEV_TYPE_META[dtKey];
        var dtTitle = dtMeta.title;
        // 灰色后缀：仅 iBeacon / Mesh 这类「需要显式点明」的类型带 tag
        var dtTag = dtMeta.tag ? '<span class="ble-dev-tag">(' + dtMeta.tag + ')</span>' : '';
        // 已连接提示：用文字而非改图标颜色，避免与设备类型混淆
        var connTag = dev.connected ? '<span class="ble-dev-conn" title="BLE 已连接">已连接</span>' : '';
        card.innerHTML =
            '<span class="ble-dev-icon" title="' + dtTitle + '">' + dtIcon + '</span>' +
            '<div class="ble-dev-main">' +
                '<div class="ble-dev-name">' +
                    '<span class="ble-dev-text">' + escapeHtml(dev.name || '未知设备') + '</span>' + dtTag + connTag +
                '</div>' +
                '<div class="ble-dev-sub">' + dev.address + '</div>' +
            '</div>' +
            '<div class="ble-dev-rssi-bar"><span style="width:' + pct + '%;background:' + rssiColor + '"></span></div>' +
            '<div class="ble-dev-rssi" style="color:' + rssiColor + '">' + (hasRssi ? dev.rssi + ' dBm' : '—') + '</div>';
        card.addEventListener('click', function() {
            // 切换设备即清空日志与写入窗口：它们只属于「当前设备本次会话」
            if (dev.address !== _bleSelected) { clearBleLog(); closeBleWriteModal(); }
            _bleSelected = dev.address;
            scheduleConfigSave();   // 选中的设备地址随用户配置保留
            renderBleDeviceList();
            renderBleDetail();
        });
        list.appendChild(card);
    });
}

function renderBleDetail() {
    var detail = document.getElementById('ble-detail');
    if (!detail) return;
    var dev = null;
    for (var i = 0; i < _bleDevices.length; i++) {
        if (_bleDevices[i].address === _bleSelected) { dev = _bleDevices[i]; break; }
    }
    if (!dev) {
        detail.innerHTML = '<div class="ble-detail-empty">从左侧选择设备查看详情与 GATT 服务</div>';
        return;
    }
    // 服务行右侧标签：识别到的服务左侧已显示名称，不再重复标 "Service"；
    // 识别不到类型的（自定义/厂商私有 128 位 UUID）统一标 Custom Service。
    // 名称表见模块级 BLE_SVC_NAMES（Bluetooth SIG Assigned Numbers）。
    var svcList = pickBleSvcList(dev, _bleServices, _bleConnAddr);
    var svcHtml = svcList.map(function(s) { return renderBleServiceRow(s); }).join('');
    var advHtml = renderBleAdv(dev);
    var advBytes = (dev.adv && dev.adv.raw) ? dev.adv.raw.split(' ').length : 0;
    detail.innerHTML =
        '<div class="ble-detail-head">' +
            '<div class="ble-detail-name">' + escapeHtml(dev.name || '未知设备') + '</div>' +
            '<div class="ble-detail-meta">' + escapeHtml(bleDetailMetaText(dev, dev.rssi, _bleMtu)) + '</div>' +
            '<button class="add-btn icon-btn ble-connect-btn' + (dev.connected ? ' connected' : '') + '" onclick="toggleBleConnect()" title="连接/断开">' + (dev.connected ? '断开设备' : '连接设备') + '</button>' +
        '</div>' +
        '<div class="ble-detail-sec ble-adv-sec">' +
            '<div class="ble-sec-title ble-adv-toggle" onclick="toggleBleAdv(this)"><span class="ble-svc-caret">&#9654;</span>广播内容 <span class="ble-adv-count">' + (advBytes > 0 ? advBytes + ' B' : '') + '</span></div>' +
            '<div class="ble-adv-body" style="display:none;">' + advHtml + '</div>' +
        '</div>' +
        '<div class="ble-detail-sec">' +
            '<div class="ble-sec-title">GATT 服务 / 特征</div>' +
            '<div>' + svcHtml + '</div>' +
        '</div>' +
        '<div class="ble-detail-sec ble-log-sec">' +
            '<div class="ble-sec-title ble-log-title">数据日志<span class="ble-log-clear" onclick="clearBleLog()" title="清空数据日志">清空</span></div>' +
            '<div class="ble-log" id="ble-log">暂无日志</div>' +
        '</div>';
    // 恢复广播内容展开状态
    if (_bleAdvOpen) {
        var advBody = detail.querySelector('.ble-adv-body');
        var advToggle = detail.querySelector('.ble-adv-toggle');
        if (advBody) advBody.style.display = 'block';
        if (advToggle) advToggle.classList.add('expanded');
    }
    // 恢复此前展开的 GATT 服务（连接/断开等重建后不丢失展开状态）
    var openSvc = null;
    detail.querySelectorAll('.ble-svc').forEach(function(svc) {
        if (!openSvc && _bleOpenSvcs[svc.getAttribute('data-uuid')]) openSvc = svc;
    });
    if (openSvc) toggleBleService(openSvc);
    // 日志 DOM 刚被重建，把缓冲贴回去（切页 / 重渲染都不丢）
    renderBleLog();
}

// 解析广播 raw（空格分隔的 hex）为 AD 结构段
function parseBleAdv(hexStr) {
    var bytes = hexStr.trim().split(/\s+/);
    var segs = [];
    var i = 0;
    while (i < bytes.length) {
        var len = parseInt(bytes[i], 16);
        if (isNaN(len) || len <= 0 || i + 1 + len > bytes.length) break;
        var type = parseInt(bytes[i + 1], 16);
        segs.push({ label: advTypeLabel(type), hex: bytes.slice(i, i + 1 + len).join(' ') });
        i += 1 + len;
    }
    return segs;
}
// BLE 广播 AD type 表（来源：Bluetooth SIG Assigned Numbers — Generic Access Profile）
function advTypeLabel(t) {
    switch (t) {
        case 0x01: return 'Flags';
        case 0x02: return '服务UUID(16bit·不完整)';
        case 0x03: return '服务UUID(16bit)';
        case 0x04: return '服务UUID(32bit·不完整)';
        case 0x05: return '服务UUID(32bit)';
        case 0x06: return '服务UUID(128bit·不完整)';
        case 0x07: return '服务UUID(128bit)';
        case 0x08: return '广播名(简)';
        case 0x09: return '广播名';
        case 0x0A: return '发射功率';
        case 0x0D: return '设备类别';
        case 0x0E: return '配对Hash C-192';
        case 0x0F: return '配对Randomizer R-192';
        case 0x10: return 'Device ID';
        case 0x11: return 'SM TK Value';
        case 0x12: return 'SM OOB Flags';
        case 0x14: return '服务请求UUID(16bit)';
        case 0x15: return '服务请求UUID(32bit)';
        case 0x16: return '服务数据(16bit)';
        case 0x17: return 'Public Target Address';
        case 0x18: return 'Random Target Address';
        case 0x19: return '外观';
        case 0x1A: return '广播间隔';
        case 0x1B: return 'LE 设备地址';
        case 0x1C: return 'LE Role';
        case 0x1D: return '配对Hash C-256';
        case 0x1E: return '配对Randomizer R-256';
        case 0x1F: return '服务请求UUID(128bit)';
        case 0x20: return '服务数据(32bit)';
        case 0x21: return '服务数据(128bit)';
        case 0x22: return 'LE SC Confirmation';
        case 0x23: return 'LE SC Random';
        case 0x24: return 'URI';
        case 0x25: return '室内定位';
        case 0x26: return '传输发现数据';
        case 0x27: return 'LE 支持特性';
        case 0x28: return '信道图更新';
        case 0x29: return 'PB-ADV';
        case 0x2A: return 'Mesh Message';
        case 0x2B: return 'Mesh Beacon';
        case 0x2C: return 'BIGInfo';
        case 0x2D: return 'Broadcast_Code';
        case 0x2E: return 'Resolvable Set ID';
        case 0x2F: return '广播间隔(16bit UUID)';
        case 0x30: return '广播间隔(32bit UUID)';
        case 0x31: return '广播间隔(128bit UUID)';
        case 0x32: return '广播名(加密)';
        case 0x33: return '加密广播数据';
        case 0x34: return 'PA 响应时序';
        case 0x3D: return '3D 信息';
        case 0xFF: return '厂商数据';
        default: return '0x' + ('0' + t.toString(16)).slice(-2).toUpperCase();
    }
}
// 广播内容展开体：分段标注的原始 16 进制数据 + 从报文解析的摘要
function renderBleAdv(dev) {
    if (!dev.adv) return '<div class="ble-adv-empty">' + (dev.connected ? '已连接：设备已停止广播，无广播数据' : '无广播数据') + '</div>';
    var a = dev.adv;
    var html = '';
    if (a.raw) {
        var segHtml = parseBleAdv(a.raw).map(function(s) {
            return '<span class="ble-adv-seg"><em class="ble-adv-seg-label">' + s.label + '</em><span class="ble-adv-seg-hex">' + s.hex.replace(/ /g,'') + '</span></span>';
        }).join('<span class="ble-adv-sep">|</span>');
        if (segHtml) html += '<div class="ble-adv-raw">' + segHtml + '</div>';
    }
    var brief = [];
    if (a.adName) brief.push(advRow('广播名', a.adName));
    if (a.svcs && a.svcs.length) brief.push(advRow('广播服务', a.svcs.map(function(s){ return '0x' + shortUuid(s); }).join(' | ')));
    if (a.appearance != null) brief.push(advRow('外观', '0x' + a.appearance.toString(16).toUpperCase()));
    if (a.txPower != null) brief.push(advRow('发射功率', a.txPower + ' dBm'));
    if (a.manufacturerData && a.manufacturerData.length)
        brief.push(a.manufacturerData.map(function(m){ return advRow('厂商数据(0x' + m.id.toString(16).toUpperCase() + ')', bleDataVal(m.hex)); }).join(''));
    if (a.serviceData && a.serviceData.length)
        brief.push(a.serviceData.map(function(s){ return advRow('服务数据(0x' + shortUuid(s.uuid) + ')', bleDataVal(s.hex)); }).join(''));
    if (brief.length) html += '<div class="ble-adv-brief">' + brief.join('') + '</div>';
    return html;
}
// 摘要行：标签固定宽 + 值（长值换行）。标签过长会被截断，用 title 保留完整内容
function advRow(k, v) {
    return '<span class="ble-adv-k" title="' + escapeHtml(k) + '">' + escapeHtml(k) + '</span>' +
           '<span class="ble-adv-v">' + escapeHtml(v) + '</span>';
}
// 空格分隔的 hex 字节串 → 合并为小端(little-endian)整数并补足字节宽度，如 '0F 10 08' → 0x08100F
// 注意：用乘法而非 << 累加，避免 4 字节最高位为 1 时被当成有符号 32 位整数而输出 '0x-80000000'
function hexToLe(hexStr) {
    var parts = hexStr.trim().split(/\s+/).filter(function(b){ return b !== ''; });
    var bytes = parts.map(function(b){ return parseInt(b, 16); });
    if (!bytes.length || bytes.some(function(b){ return isNaN(b); })) return '0x' + parts.join('');
    var v = 0, mul = 1;
    for (var i = 0; i < bytes.length; i++) { v += bytes[i] * mul; mul *= 256; }
    return '0x' + v.toString(16).toUpperCase().padStart(bytes.length * 2, '0');
}
// 数据值显示：短数据(≤4字节)小端合并为 0x 整数；长数据保持字节串(0x + 连续hex)，避免精度丢失
function bleDataVal(hexStr) {
    var bytes = hexStr.trim().split(/\s+/);
    if (bytes.length <= 4) return hexToLe(hexStr);
    return '0x' + bytes.join('');
}
// 展开/收起广播内容（默认折叠）
function toggleBleAdv(el) {
    var body = el.nextElementSibling;
    if (!body || !body.classList.contains('ble-adv-body')) return;
    var show = (body.style.display !== 'none');
    body.style.display = show ? 'none' : 'block';
    el.classList.toggle('expanded', !show);
    _bleAdvOpen = !show;
    scheduleConfigSave();   // 展开态随用户配置保留
}

// 展开/收起某个服务下的特征（骨架示例特征）
function toggleBleService(el) {
    var uuid = el.getAttribute('data-uuid');
    var group = el.nextElementSibling;
    if (group && group.classList.contains('ble-charGroup')) {
        group.remove();
        el.classList.remove('expanded');
        if (uuid) delete _bleOpenSvcs[uuid];
        scheduleConfigSave();   // 展开状态随用户配置保留
        return;
    }
    // 收起其它已展开的服务
    document.querySelectorAll('#ble-detail .ble-svc.expanded').forEach(function(open) {
        var g = open.nextElementSibling;
        if (g && g.classList.contains('ble-charGroup')) g.remove();
        open.classList.remove('expanded');
        var ou = open.getAttribute('data-uuid');
        if (ou) delete _bleOpenSvcs[ou];
    });
    var groupHtml = document.createElement('div');
    groupHtml.className = 'ble-charGroup';
    // 从连接后的服务树取特征；**仅当查看的就是已连接设备**才允许，
    // 否则会把已连接设备的特征挂到未连接设备名下（用户反馈的 bug）
    var dev = getSelectedBleDev();
    var viewingConnected = isViewingConnectedDevice(dev, _bleConnAddr);
    var svc = null;
    if (viewingConnected) {
        for (var i = 0; i < _bleServices.length; i++) {
            if (_bleServices[i].uuid === uuid) { svc = _bleServices[i]; break; }
        }
    }
    if (svc && svc.characteristics && svc.characteristics.length) {
        groupHtml.innerHTML = svc.characteristics.map(function(c) {
            return renderCharRow({ uuid: c.uuid, name: BLE_CHAR_NAMES[shortUuid(c.uuid)] || '',
                                   props: c.properties || [], descriptors: c.descriptors || [] });
        }).join('');
    } else {
        // 三种情况文案要分开，否则「已连接却提示去连接设备」会误导排查方向：
        //   1) 没连（或看的不是已连接设备）→ 让用户先连
        //   2) 连着，但该服务不在设备实际发现的服务里（多半只出现在广播里）→ 说明来源
        //   3) 连着、服务也找到了，但它下面确实没有特征 → 如实说明
        var hint = !viewingConnected ? '连接设备后查看特征'
                 : (!svc ? '该服务只出现在广播里，设备上未发现它'
                         : '该服务下没有特征（设备可能未启用）');
        groupHtml.innerHTML = '<div class="ble-char-empty">' + hint + '</div>';
    }
    el.after(groupHtml);
    el.classList.add('expanded');
    if (uuid) _bleOpenSvcs[uuid] = true;
    scheduleConfigSave();   // 展开状态随用户配置保留
}

// 连接成功后的界面状态复位与数据加载。
// 从 toggleBleConnect 的内联代码里抽出来，好让「配对成功后自动重连」复用同一条成功路径。
function bleOnConnected(address, label) {
    _bleConnecting = false;
    // 连接期间列表可能整体刷新过 → 按地址在当前列表里重新定位，
    // 否则会写到一个已不在列表中的孤儿对象上
    var cur = null;
    _bleDevices.forEach(function(d) { if (d.address === address) cur = d; });
    if (cur) cur.connected = true;
    // 同一时刻只可能连一台：把其它设备的标记清掉，
    // 否则换连另一台时旧设备会一直显示「已连接」（后端只承认最后一台）
    _bleDevices.forEach(function(d) { if (d.address !== address) d.connected = false; });
    _bleConnAddr = address;
    // 记住它的展示信息：连上后它可能就不再广播了，列表里会查不到
    _bleConnInfo = { address: address, name: label, rssi: (cur ? cur.rssi : null),
                     addressType: (cur ? cur.addressType : ''), deviceType: (cur ? cur.deviceType : 'ble') };
    _bleSubs = {};   // 新连接从零开始，不继承上一轮的订阅显示
    return invoke('ble_get_services').then(function(svcs) {
        _bleServices = svcs || [];
        var chars = 0;
        _bleServices.forEach(function(s) { chars += (s.characteristics || []).length; });
        logBle('[连接成功] ' + label + ' (' + address + ') · 服务 ' + _bleServices.length + ' · 特征 ' + chars);
        return refreshBleMtu();   // 拿到 MTU 再渲染，详情头一次到位
    }).then(function() {
        renderBleDetail();
        renderBleDeviceList();   // 让列表立刻出现「已连接」提示
        startBleNotifyPoll();
        startBleRssiPoll();   // 连接期间周期刷新信号强度
    }).catch(function(e) {
        logBle('[服务获取失败] ' + e);
        showToast('获取服务失败: ' + e, 'error');
    });
}

// 这个连接错误是否"值得尝试配对"（纯函数，便于无头断言）。
// 只认认证/加密不足这一类 —— 配对仪式会占用设备并打断链路，
// 绝不能因为一次普通失败（超时、Not connected、设备不在范围）就去配对。
function bleErrNeedsPairing(err) {
    var s = String(err || '').toLowerCase();
    return s.indexOf('insufficient_authentication') >= 0
        || s.indexOf('insufficient_encryption') >= 0
        || s.indexOf('0x80650005') >= 0        // E_BLUETOOTH_ATT_INSUFFICIENT_AUTHENTICATION
        || s.indexOf('0x8065000c') >= 0        // E_BLUETOOTH_ATT_INSUFFICIENT_ENCRYPTION
        || s.indexOf('not paired') >= 0
        || s.indexOf('未配对') >= 0;
}

// 连接失败后的补救：设备确实"需要配对"时才发起 WinRT 配对，
// 成功后再重试一次连接（见 bleErrNeedsPairing 的判定）。
// 最终仍失败时 reject，错误串里带上原始连接错误，便于定位到底是配对问题还是别的原因。
function tryBlePairThenReconnect(address, label, origErr) {
    logBle('[连接失败] ' + label + ' · ' + origErr + ' · 该设备可能需要配对，发起配对…');
    return invokeTimeout('ble_pair', { address: address }, BLE_PAIR_TIMEOUT_MS)
        .catch(function(pe) {
            throw ('配对失败: ' + pe + ' · 原连接错误: ' + origErr);
        })
        .then(function(paired) {
            if (!paired) throw ('配对未完成（被取消或失败）· 原连接错误: ' + origErr);
            logBle('[配对] 完成，重试连接…');
            return invokeTimeout('ble_connect', { address: address }, BLE_CONNECT_TIMEOUT_MS);
        })
        .then(function() {
            bleOnConnected(address, label);
            return true;
        });
}

// 连接一台设备（面板「连接设备」按钮与 MCP 的 ble_connect 共用这一条路）：
// 显式超时 + 门闩；失败时**只有确实"需要配对"才发起配对**再重连一次。
// 返回 Promise<{ok:true, addr, name, paired?} | {ok:false, error}>——
// 一律 resolve（不 reject）：按钮路径不必再包一层 catch，MCP 侧靠 ok 判断真实结果。
function bleConnectTo(address, label) {
    if (_bleConnecting) {
        showToast('正在连接，请稍候…', 'info');
        return Promise.resolve({ ok: false, error: '正在连接，请稍候…' });
    }
    logBle('[连接中] ' + label + ' (' + address + ')');
    _bleConnecting = true;
    var fail = function(e2) {
        _bleConnecting = false;
        logBle('[连接失败] ' + label + ' (' + address + ') · ' + e2);
        console.warn('[BLE] 连接失败:', e2);
        showToast('连接失败: ' + e2, 'error');
        return { ok: false, error: String(e2) };
    };
    return invokeTimeout('ble_connect', { address: address }, BLE_CONNECT_TIMEOUT_MS).then(function() {
        return bleOnConnected(address, label);
    }).then(function() {
        return { ok: true, addr: address, name: label };
    }).catch(function(e) {
        // 只有错误确实是「认证/加密不足」时才值得尝试配对。
        // 早期版本对所有连接失败都发起配对 —— 而配对仪式会占用设备/打断链路，
        // 把普通失败（如 connect: Not connected）的正常重连也搅了（用户反馈）。
        if (!bleErrNeedsPairing(e)) return fail(e);
        // 疑似需要配对：发起配对（用户要在配对弹窗上确认），成功后再重连一次
        return tryBlePairThenReconnect(address, label, e).then(function() {
            return { ok: true, addr: address, name: label, paired: true };
        }).catch(fail);
    });
}

// 断开当前设备（面板「断开设备」按钮与 MCP 的 ble_disconnect 共用）。
// 返回 Promise<{ok:true} | {ok:false, error}>（同样一律 resolve）。
function bleDisconnect() {
    return invoke('ble_disconnect').then(function() {
        var dev = getSelectedBleDev();
        if (dev) dev.connected = false;
        _bleConnAddr = null;
        _bleConnInfo = null;   // 已连接设备的展示信息一并失效
        _bleServices = [];
        _bleSubs = {};   // 订阅随连接失效：不清会一直显示「启用」，实际已无订阅
        stopBleNotifyPoll();
        stopBleRssiPoll();
        clearBleLog();   // 断开即清空：本次连接会话结束
        closeBleWriteModal();   // 写入窗口随连接失效
        renderBleDetail();
        renderBleDeviceList();   // 去掉列表里的「已连接」提示
        return { ok: true };
    }).catch(function(e) {
        logBle('[断开失败] ' + e);
        console.warn('[BLE] 断开失败:', e);
        showToast('断开失败: ' + e, 'error');
        return { ok: false, error: String(e) };
    });
}

function toggleBleConnect() {
    // 连接进行中门闩：连点会对同一设备重复 connect（后端会换掉底层设备对象）
    if (_bleConnecting) { showToast('正在连接，请稍候…', 'info'); return; }
    var dev = getSelectedBleDev();
    if (!dev) { console.warn('[BLE] 请先选择设备'); return; }
    if (!dev.connected) {
        bleConnectTo(dev.address, dev.name || '未知设备');   // 提示与状态复位都在内部完成
    } else {
        bleDisconnect();
    }
}

/* ===== BLE 从机（外设）模式 —— 本机对外广播，供手机 / 其它主机搜索并连接 =====
   主机模式 = 扫描连接别人的设备；从机模式 = 本机当外设。
   后端走 WinRT GattServiceProvider（btleplug 是 central-only，没有外设角色）。

   平台限制（不是缺陷，已记入 doc/BLE_PERIPHERAL.md）：
     1) 广播里的设备名由 Windows 决定（系统蓝牙名称），这里配不了 —— 手机看到的是电脑名；
     2) 一个服务提供者只广播它自己那一个服务 UUID；
     3) 没有主机订阅时无法下发通知（后端会明确报错）。 */
var _bleMode = 'host';              // 'host' 主机（扫描连接） | 'periph' 从机（对外广播）
// 从机模式的界面开关。**默认关闭**：本机（Intel 集成蓝牙）实测无法广播 ——
// 射频能发广播（仅厂商数据时 Started），但带「服务 UUID / 广播名」的广播帧被系统拒绝
// （E_INVALIDARG），而 GattServiceProvider 必须广播服务 UUID 且没有绕过开关，故恒 Aborted。
// 完整证据与结论见 doc/BLE_PERIPHERAL.md 第 5 节。
// 代码**整体保留**（后端命令、面板、表格导入导出都还在），换到允许 service UUID 广播的机器时，
// 把这里改成 true 即可恢复入口。
var BLE_PERIPH_MODE_ENABLED = false;
var _blePeriphRunning = false;      // 后端是否已建好 GATT 服务
var _blePeriphAdv = false;          // 是否真的在广播（服务建好 ≠ 广播成功）
var _blePeriphStatusChars = [];     // 后端上报的特征运行态
var _blePeriphLog = [];
var _blePeriphLogMax = 400;
var _blePeriphEventTimer = null;    // 事件轮询（500ms）
var _blePeriphStatusTimer = null;   // 状态轮询（2s）

// 常见从机服务预设：打开就能被搜到并能读能写，不用每次手抄 UUID
var BLE_PERIPH_PRESETS = [
    {
        id: 'nus',
        name: 'Nordic UART（透传常用）',
        service: '6E400001-B5A3-F393-E0A9-E50E24DCCA9E',
        hint: 'nRF Connect 直接认这个服务：RX 收主机写入，TX 向主机通知',
        chars: [
            { uuid: '6E400002-B5A3-F393-E0A9-E50E24DCCA9E', props: ['write', 'write_without_response'], value: '' },
            { uuid: '6E400003-B5A3-F393-E0A9-E50E24DCCA9E', props: ['notify'], value: '' }
        ]
    },
    {
        id: 'ffe0',
        name: '透传模块 FFE0/FFE1',
        service: '0000FFE0-0000-1000-8000-00805F9B34FB',
        hint: '多数 BLE 串口透传模块用的服务：单特征同时支持读写与通知',
        chars: [
            { uuid: '0000FFE1-0000-1000-8000-00805F9B34FB', props: ['read', 'write', 'write_without_response', 'notify'], value: '48656C6C6F' }
        ]
    },
    {
        id: 'rw',
        name: '自定义（读 + 写 + 通知）',
        service: '0000FFF0-0000-1000-8000-00805F9B34FB',
        hint: '一个可读可写特征 + 一个通知特征，适合验证主机侧的读写与订阅流程',
        chars: [
            { uuid: '0000FFF1-0000-1000-8000-00805F9B34FB', props: ['read', 'write'], value: '48656C6C6F' },
            { uuid: '0000FFF2-0000-1000-8000-00805F9B34FB', props: ['notify'], value: '' }
        ]
    }
];
var BLE_PERIPH_PROP_ORDER = ['read', 'write', 'write_without_response', 'notify', 'indicate'];
var BLE_PERIPH_PROP_LABEL = { read: '读', write: '写', write_without_response: '无响应写', notify: '通知', indicate: '指示' };
var BLE_PERIPH_CHAR_MAX = 16;

// 从机表单状态：唯一数据源，DOM 只是它的投影（切换模式 / 重进页面都不丢编辑）
var _blePeriphForm = {
    presetId: 'nus',
    service: '6E400001-B5A3-F393-E0A9-E50E24DCCA9E',
    chars: [
        { uuid: '6E400002-B5A3-F393-E0A9-E50E24DCCA9E', props: ['write', 'write_without_response'], value: '' },
        { uuid: '6E400003-B5A3-F393-E0A9-E50E24DCCA9E', props: ['notify'], value: '' }
    ],
    discoverable: true,
    connectable: true,
    advData: false,
    advDataHex: ''
};

// 按 id 找预设；找不到返回 null（调用方决定回退，不在这里悄悄改掉用户的选择）
function blePeriphPreset(id) {
    for (var i = 0; i < BLE_PERIPH_PRESETS.length; i++) {
        if (BLE_PERIPH_PRESETS[i].id === id) return BLE_PERIPH_PRESETS[i];
    }
    return null;
}

// HEX 文本 → 字节数组。宽容分隔符（空格 / 逗号 / 冒号 / 连字符）与 0x 前缀，
// 空串合法（表示"不填初值"）。返回 { bytes } 或 { error }：
// **不静默把非法输入当空**，否则用户会以为初值填进去了。
function blePeriphHexBytes(label, s) {
    var t = String(s == null ? '' : s).replace(/0[xX]/g, '').replace(/[\s,;:_-]/g, '');
    if (!t) return { bytes: [] };
    if (!/^[0-9a-fA-F]+$/.test(t)) return { error: label + ' 含非十六进制字符：' + s };
    if (t.length % 2 !== 0) return { error: label + ' 的 HEX 长度为奇数（每个字节两位）：' + s };
    var out = [];
    for (var i = 0; i < t.length; i += 2) out.push(parseInt(t.substr(i, 2), 16));
    return { bytes: out };
}

// 后端事件 → 日志行（纯函数，便于无头断言）。
// 返回 { text, dim }：text 是主文本，dim 是灰显的十六进制部分。
function blePeriphFmtEvent(ev) {
    ev = ev || {};
    var uuid = ev.uuid ? ('0x' + shortUuid(ev.uuid)) : '';
    var who = ev.peer ? (' · ' + ev.peer) : '';
    var hex = ev.value_hex ? String(ev.value_hex) : '';
    var dim = hex ? ('  ' + bleFmtHex(hex) + ' · 0x' + hex.replace(/ /g, '')) : '';
    switch (ev.kind) {
        case 'start':
            return { text: '[广播] 服务 ' + uuid + ' 已启动' + (ev.note ? ' · ' + ev.note : ''), dim: '' };
        case 'stop':
            return { text: '[广播] 已停止', dim: '' };
        case 'adv':
            return { text: '[广播状态] ' + (ev.status || '') +
                (ev.status === 'Aborted' ? '（广播被中止：确认蓝牙已打开、本机有适配器）' : ''), dim: '' };
        case 'write':
            return { text: '[收到写入] ' + uuid + who + (ev.note ? ' · ' + ev.note : ''), dim: dim };
        case 'write_reply':
            return { text: '[写入应答] ' + (ev.note || ('#' + (ev.pending_id || '?'))), dim: '' };
        case 'notice':
            return { text: '[提示] ' + (ev.note || ''), dim: '' };
        case 'read':
            return { text: '[主机读取] ' + uuid + who, dim: dim };
        case 'subscribe': {
            var n = ev.subscribed || 0;
            var size = (n > 0 && ev.max_notify > 0) ? ('，单次最多 ' + ev.max_notify + ' 字节') : '';
            return { text: '[订阅] ' + uuid + (n > 0 ? (' 已被 ' + n + ' 台主机订阅' + size) : ' 订阅已取消') + who, dim: '' };
        }
        case 'notify':
            return { text: '[下发] ' + uuid + (ev.note ? ' · ' + ev.note : ''), dim: dim };
        default:
            return { text: '[' + (ev.kind || '事件') + '] ' + (ev.note || ''), dim: '' };
    }
}

function blePeriphTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    var p = function(n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

// MARK: 模式切换
// 说明文字不再单独占一行（界面要干净），改为挂在两个切换按钮的 title 上。
// 从机广播在后端是**跨页持续**的，切回主机模式时必须如实写出来 —— 否则用户会忘了自己还在广播。
function updateBleModeHint() {
    var hostTitle = '本机作为主机：扫描并连接周边 BLE 从机'
        + (_blePeriphRunning ? '（注意：从机广播仍在后台运行）' : '');
    var pfTitle = '本机作为从机：对外广播，等手机 / 主机搜索并连接（手机看到的设备名是电脑名，由 Windows 决定）';
    document.querySelectorAll('#ble-pane .ble-mode-btn').forEach(function(b) {
        var m = b.getAttribute('data-ble-mode');
        b.classList.toggle('active', m === _bleMode);
        b.title = (m === 'host') ? hostTitle : pfTitle;
    });
}

// 模式切换器的 HTML。从机模式关闭时返回空串 —— 入口不出现，但下面那套面板与逻辑都还在。
function bleModeSegHtml() {
    if (!BLE_PERIPH_MODE_ENABLED) return '';
    return '<div class="ble-mode-seg">' +
        '<button class="ble-mode-btn active" data-ble-mode="host" onclick="setBleMode(\'host\')">主机模式</button>' +
        '<button class="ble-mode-btn" data-ble-mode="periph" onclick="setBleMode(\'periph\')">从机模式</button>' +
    '</div>';
}

function setBleMode(mode) {
    // 入口关着时把 'periph' 一律折回主机模式：否则配置里残留的 mode:"periph"
    // 会让人启动就落进一个没有出口的隐藏模式
    if (mode === 'periph' && !BLE_PERIPH_MODE_ENABLED) {
        mode = 'host';
    }
    _bleMode = (mode === 'periph') ? 'periph' : 'host';
    var body = document.getElementById('bleBody');
    var pf = document.getElementById('blePeriph');
    if (body) body.style.display = (_bleMode === 'host') ? 'flex' : 'none';
    if (pf) pf.classList.toggle('active', _bleMode === 'periph');
    if (_bleMode === 'periph') {
        renderBlePfForm();
        startBlePeriphPoll();
        // 刷一次真实状态：title 里要如实反映"后台还在广播吗"
        refreshBlePeriphStatus().then(updateBleModeHint);
    } else {
        stopBlePeriphPoll();
        refreshBlePeriphStatus().then(updateBleModeHint);
    }
    updateBleModeHint();
    scheduleConfigSave();
}

// MARK: 从机表单
function renderBlePfForm() {
    var sel = document.getElementById('blePfPreset');
    if (sel) {
        if (!sel.options || !sel.options.length) {
            var opts = '';
            for (var i = 0; i < BLE_PERIPH_PRESETS.length; i++) {
                opts += '<option value="' + BLE_PERIPH_PRESETS[i].id + '">' +
                        escapeHtml(BLE_PERIPH_PRESETS[i].name) + '</option>';
            }
            sel.innerHTML = opts;
        }
        sel.value = _blePeriphForm.presetId;
        // 预设说明改成下拉框的 tooltip：说明还在，但不再占一行版面
        var p = blePeriphPreset(_blePeriphForm.presetId);
        if (p) sel.title = p.name + '：' + p.hint;
    }
    var svc = document.getElementById('blePfService');
    if (svc && svc.value !== _blePeriphForm.service) svc.value = _blePeriphForm.service;
    var d = document.getElementById('blePfDiscoverable');
    if (d) d.checked = !!_blePeriphForm.discoverable;
    var cn = document.getElementById('blePfConnectable');
    if (cn) cn.checked = !!_blePeriphForm.connectable;
    var ad = document.getElementById('blePfAdvData');
    if (ad) ad.checked = !!_blePeriphForm.advData;
    var adh = document.getElementById('blePfAdvDataHex');
    if (adh && adh.value !== _blePeriphForm.advDataHex) adh.value = _blePeriphForm.advDataHex;
    var mr = document.getElementById('blePfManualReply');
    if (mr) mr.checked = !!_blePeriphForm.manualReply;
    renderBlePfSaved();
    renderBlePfAdvLen();
    renderBlePfChars();
}

// 表单里的特征行（可编辑）。行内不用内联 onclick：UUID 走 data-* + 事件委托，
// 免得"用户填的 UUID"进到 HTML 属性里（同类隐患见 TODO M13/L13）
function renderBlePfChars() {
    var box = document.getElementById('blePfCharEditor');
    var cnt = document.getElementById('blePfCharCount');
    if (cnt) cnt.textContent = _blePeriphForm.chars.length + ' / ' + BLE_PERIPH_CHAR_MAX;
    if (!box) return;
    var html = '';
    _blePeriphForm.chars.forEach(function(c, i) {
        var props = '';
        BLE_PERIPH_PROP_ORDER.forEach(function(p) {
            var on = (c.props || []).indexOf(p) >= 0;
            props += '<span class="ble-pf-prop' + (on ? ' on' : '') + '" data-ci="' + i + '" data-prop="' + p + '">' +
                     BLE_PERIPH_PROP_LABEL[p] + '</span>';
        });
        html += '<div class="ble-pf-char">' +
            '<div class="ble-pf-char-head">' +
                '<input class="ble-pf-input" data-ci="' + i + '" data-field="uuid" spellcheck="false" autocomplete="off" ' +
                    'value="' + escapeHtml(c.uuid || '') + '" placeholder="特征 UUID">' +
                '<button class="ble-pf-del" data-del="' + i + '" title="删除该特征">&#10005;</button>' +
            '</div>' +
            '<div class="ble-pf-props">' + props + '</div>' +
            '<div class="ble-pf-value">' +
                '<input class="ble-pf-input" data-ci="' + i + '" data-field="value" spellcheck="false" autocomplete="off" ' +
                    'value="' + escapeHtml(c.value || '') + '" placeholder="初值 HEX（可留空），如 48656C6C6F">' +
            '</div>' +
            '<div class="ble-pf-value">' +
                '<input class="ble-pf-input" data-ci="' + i + '" data-field="desc" spellcheck="false" autocomplete="off" ' +
                    'value="' + escapeHtml(c.desc || '') + '" ' +
                    'placeholder="描述符（可选）：UUID=值，多个用 ; 分隔；T: 前缀表示文本，如 2901=T:温度计">' +
            '</div>' +
        '</div>';
    });
    box.innerHTML = html || '<div class="ble-pf-empty">还没有特征，点下面的「添加特征」</div>';
}

// 只绑一次：输入 / 点击都走委托，行增删重渲染不用重绑
function initBlePfForm() {
    var box = document.getElementById('blePfCharEditor');
    if (box && !box._bound) {
        box._bound = true;
        box.addEventListener('input', blePfEditorInput);
        box.addEventListener('click', blePfEditorClick);
    }
    var charsBox = document.getElementById('blePfChars');
    if (charsBox && !charsBox._bound) {
        charsBox._bound = true;
        charsBox.addEventListener('click', function(e) {
            var el = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
            if (!el) return;
            blePeriphCharAction(el.getAttribute('data-uuid'), el.getAttribute('data-act'));
        });
    }
    var pendBox = document.getElementById('blePfPending');
    if (pendBox && !pendBox._bound) {
        pendBox._bound = true;
        pendBox.addEventListener('click', onBlePfPendingClick);
    }
}

function blePfEditorInput(e) {
    var t = e.target;
    if (!t || !t.dataset) return;
    var c = _blePeriphForm.chars[parseInt(t.dataset.ci, 10)];
    if (!c) return;
    if (t.dataset.field === 'uuid') c.uuid = t.value;
    else if (t.dataset.field === 'value') c.value = t.value;
    else if (t.dataset.field === 'desc') c.desc = t.value;
    scheduleConfigSave();
}

function blePfEditorClick(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var del = t.closest('[data-del]');
    if (del) {
        var di = parseInt(del.getAttribute('data-del'), 10);
        if (!isNaN(di)) {
            _blePeriphForm.chars.splice(di, 1);
            renderBlePfChars();
            scheduleConfigSave();
        }
        return;
    }
    var prop = t.closest('.ble-pf-prop');
    if (prop) {
        var c = _blePeriphForm.chars[parseInt(prop.getAttribute('data-ci'), 10)];
        if (!c) return;
        var pv = prop.getAttribute('data-prop');
        c.props = c.props || [];
        var k = c.props.indexOf(pv);
        if (k >= 0) c.props.splice(k, 1); else c.props.push(pv);
        // 统一按固定顺序排列：顺序稳定，配置 diff 才不会因为勾选先后而抖动
        c.props = BLE_PERIPH_PROP_ORDER.filter(function(p) { return c.props.indexOf(p) >= 0; });
        prop.classList.toggle('on', k < 0);
        scheduleConfigSave();
    }
}

function blePfAddChar() {
    if (_blePeriphForm.chars.length >= BLE_PERIPH_CHAR_MAX) {
        showToast('特征数量上限 ' + BLE_PERIPH_CHAR_MAX + ' 个', 'error');
        return;
    }
    _blePeriphForm.chars.push({ uuid: '', props: ['read', 'write'], value: '' });
    renderBlePfChars();
    scheduleConfigSave();
}

function blePfApplyPreset(id) {
    var p = blePeriphPreset(id);
    if (!p) return;
    _blePeriphForm.presetId = p.id;
    _blePeriphForm.service = p.service;
    _blePeriphForm.chars = p.chars.map(function(c) {
        return { uuid: c.uuid, props: c.props.slice(), value: c.value || '' };
    });
    renderBlePfForm();
    scheduleConfigSave();
}

function blePfSyncService(v) {
    _blePeriphForm.service = v;
    scheduleConfigSave();
}

// 只把「存在」的控件读进状态：页面没建好时不要把状态冲成 false
function blePfCollectOptions() {
    var a = document.getElementById('blePfDiscoverable');
    if (a) _blePeriphForm.discoverable = !!a.checked;
    var b = document.getElementById('blePfConnectable');
    if (b) _blePeriphForm.connectable = !!b.checked;
    var c = document.getElementById('blePfAdvData');
    if (c) _blePeriphForm.advData = !!c.checked;
    var d = document.getElementById('blePfAdvDataHex');
    if (d) _blePeriphForm.advDataHex = d.value.trim();
    var e = document.getElementById('blePfManualReply');
    if (e) _blePeriphForm.manualReply = !!e.checked;
}

// 表单 → 可持久化的纯数据（顺带把选项控件读进状态，切模式不丢改动）
function blePfCollectForm() {
    blePfCollectOptions();
    return {
        presetId: _blePeriphForm.presetId,
        service: _blePeriphForm.service,
        chars: _blePeriphForm.chars.map(function(c) {
            return { uuid: c.uuid, props: (c.props || []).slice(), value: c.value, desc: c.desc || '' };
        }),
        discoverable: _blePeriphForm.discoverable,
        connectable: _blePeriphForm.connectable,
        advData: _blePeriphForm.advData,
        advDataHex: _blePeriphForm.advDataHex,
        manualReply: !!_blePeriphForm.manualReply
    };
}

// 恢复从机表单（纯数据）。形状不对就保持默认预设 —— 别让一个坏配置把面板弄成空白
function restoreBlePeriphForm(p) {
    if (!p || typeof p !== 'object') return;
    if (typeof p.presetId === 'string' && blePeriphPreset(p.presetId)) _blePeriphForm.presetId = p.presetId;
    if (typeof p.service === 'string' && p.service) _blePeriphForm.service = p.service;
    if (Object.prototype.toString.call(p.chars) === '[object Array]' && p.chars.length) {
        var list = [];
        p.chars.forEach(function(c) {
            if (!c || typeof c !== 'object' || list.length >= BLE_PERIPH_CHAR_MAX) return;
            list.push({
                uuid: typeof c.uuid === 'string' ? c.uuid : '',
                props: Object.prototype.toString.call(c.props) === '[object Array]'
                    ? BLE_PERIPH_PROP_ORDER.filter(function(x) { return c.props.indexOf(x) >= 0; })
                    : ['read'],
                value: typeof c.value === 'string' ? c.value : '',
                desc: typeof c.desc === 'string' ? c.desc : ''
            });
        });
        if (list.length) _blePeriphForm.chars = list;
    }
    _blePeriphForm.discoverable = p.discoverable !== false;
    _blePeriphForm.connectable = p.connectable !== false;
    _blePeriphForm.advData = !!p.advData;
    _blePeriphForm.advDataHex = typeof p.advDataHex === 'string' ? p.advDataHex : '';
    _blePeriphForm.manualReply = !!p.manualReply;
}

// 表单 → ble_periph_start 参数；返回 { params } 或 { error }
function blePeriphStartParams() {
    blePfCollectOptions();
    var serviceUuid = (_blePeriphForm.service || '').trim();
    if (!serviceUuid) return { error: '请填写服务 UUID' };
    if (!_blePeriphForm.chars.length) return { error: '至少需要一个特征' };
    var chars = [];
    for (var i = 0; i < _blePeriphForm.chars.length; i++) {
        var c = _blePeriphForm.chars[i];
        var uuid = (c.uuid || '').trim();
        if (!uuid) return { error: '第 ' + (i + 1) + ' 个特征的 UUID 为空' };
        if (!(c.props || []).length) return { error: '第 ' + (i + 1) + ' 个特征至少要选一个属性' };
        var v = blePeriphHexBytes('第 ' + (i + 1) + ' 个特征的初值', c.value);
        if (v.error) return { error: v.error };
        var d = blePeriphParseDescriptors(c.desc);
        if (d.error) return { error: '第 ' + (i + 1) + ' 个特征：' + d.error };
        chars.push({ uuid: uuid, props: c.props.slice(), value: v.bytes, descriptors: d.descs });
    }
    var adv = { bytes: [] };
    if (_blePeriphForm.advData) {
        adv = blePeriphHexBytes('广播服务数据', _blePeriphForm.advDataHex);
        if (adv.error) return { error: adv.error };
    }
    return { params: {
        serviceUuid: serviceUuid,
        characteristics: chars,
        discoverable: !!_blePeriphForm.discoverable,
        connectable: !!_blePeriphForm.connectable,
        advData: adv.bytes,
        manualReply: !!_blePeriphForm.manualReply
    } };
}

// MARK: 广播启停
function startBlePeriph() {
    var built = blePeriphStartParams();
    if (built.error) { showToast(built.error, 'error'); return; }
    var p = built.params;
    var btn = document.getElementById('blePfStartBtn');
    if (btn) btn.disabled = true;
    pushBlePeriphLog({ text: '[启动] 服务 ' + p.serviceUuid + ' · ' + p.characteristics.length + ' 个特征', dim: '' });
    renderBlePeriphLog();
    return invoke('ble_periph_start', {
        serviceUuid: p.serviceUuid,
        characteristics: p.characteristics,
        discoverable: p.discoverable,
        connectable: p.connectable,
        advData: p.advData,
        manualReply: p.manualReply
    }).then(function(st) {
        renderBlePeriphStatus(st);
        // 关键：服务建好 ≠ 在广播。后端会回报 advertising，别把 Aborted 显示成"一切正常"。
        // 有 warning 就用 warning —— 它写的是真实原因（蓝牙关着 / 不支持外设角色…），
        // 比一个状态码对用户有用得多。
        if (st && st.advertising) {
            showToast('已开始广播（' + shortUuid(st.service_uuid || '') + '）', 'success');
        } else {
            var why = (st && st.warning) ? st.warning : ('广播状态 ' + ((st && st.advertising_status) || '未知'));
            showToast('服务已建好，但' + why, 'error');
        }
        return refreshBlePeriphStatus();
    }).catch(function(e) {
        pushBlePeriphLog({ text: '[启动失败] ' + e, dim: '' });
        renderBlePeriphLog();
        showToast('启动失败: ' + e, 'error');
        // 失败也要回读一次真实状态：后端此时已经把服务收干净了，
        // 但界面上的 _blePeriphRunning / 特征表可能还停在"上一次是运行中"
        return refreshBlePeriphStatus();
    }).then(function() {
        if (btn) btn.disabled = false;
    });
}

function stopBlePeriph() {
    return invoke('ble_periph_stop').then(function() {
        // 停掉后待应答列表必然作废（后端会把它们按协议错误回掉）
        _blePfPending = [];
        renderBlePfPending();
        showToast('已停止广播', 'info');
        return refreshBlePeriphStatus();
    }).catch(function(e) {
        showToast('停止失败: ' + e, 'error');
    });
}

// MARK: 状态与事件
function refreshBlePeriphStatus() {
    var pane = document.getElementById('ble-pane');
    if (!pane || pane.style.display === 'none') return Promise.resolve(null);
    return invoke('ble_periph_status').then(function(st) {
        if (st) renderBlePeriphStatus(st);
        return st;
    }).catch(function(e) {
        console.warn('[BLE从机] 取状态失败:', e);
        return null;
    });
}

function renderBlePeriphStatus(st) {
    st = st || {};
    _blePeriphRunning = !!st.running;
    _blePeriphAdv = !!st.advertising;
    _blePeriphStatusChars = st.characteristics || [];
    var badge = document.getElementById('blePfBadge');
    if (badge) {
        var txt = '未启动', cls = '';
        if (_blePeriphRunning) {
            if (_blePeriphAdv) { txt = '广播中'; cls = 'on'; }
            else { txt = '广播未生效 ' + (st.advertising_status || ''); cls = 'off'; }
        }
        badge.textContent = txt;
        badge.className = 'ble-pf-badge' + (cls ? ' ' + cls : '');
    }
    var warn = document.getElementById('blePfWarn');
    if (warn) {
        warn.innerHTML = st.warning ? '<div class="ble-pf-warn"></div>' : '';
        // 文案来自后端，仍走 textContent：不给自己留注入口
        if (st.warning && warn.firstChild) warn.firstChild.textContent = st.warning;
    }
    var adapterEl = document.getElementById('blePfAdapter');
    if (adapterEl) {
        var a = st.adapter;
        if (!a) {
            adapterEl.textContent = '';
        } else {
            // 无线电访问权单独列出来：扫描可能仍可用，但广播一定起不来。
            // 注意别把它当成"用户拒绝了权限"——非打包桌面进程/非交互会话也会返回 DeniedByUser
            var access = '';
            if (a.radio_access === 'DeniedByUser' || a.radio_access === 'DeniedBySystem') {
                access = ' · 无线电访问权异常(' + a.radio_access + ')';
            }
            adapterEl.textContent = '本机适配器：' + (a.present ? '已找到' : '未找到')
                + ' · BLE ' + (a.low_energy ? '支持' : '不支持')
                // 只说"驱动声明了什么"，**不暗示一定能广播**：
                // 本机实测就出现过「驱动声明支持外设角色、但带服务 UUID 的广播被系统拒绝」，
                // 写"支持"会让人以为能用，白白浪费时间
                + ' · 外设角色 ' + (a.peripheral_role ? '驱动已声明' : '未声明')
                + (a.radio_state ? ' · 蓝牙 ' + (a.radio_state === 'On' ? '已开启' : a.radio_state) : '')
                + access;
            adapterEl.title = '「驱动已声明」只是适配器驱动程序上报的能力位，'
                + '不代表一定能广播：GATT 服务必须广播服务 UUID，而部分适配器/驱动会拒绝这类广播帧'
                + '（表现就是「开始广播」后状态变成 Aborted）。';
        }
    }
    var startBtn = document.getElementById('blePfStartBtn');
    if (startBtn) startBtn.textContent = _blePeriphRunning ? '重新广播' : '开始广播';
    var stopBtn = document.getElementById('blePfStopBtn');
    if (stopBtn) stopBtn.disabled = !_blePeriphRunning;
    var svc = document.getElementById('blePfSvcLabel');
    if (svc) svc.textContent = st.service_uuid ? ('服务 ' + shortUuid(st.service_uuid)) : '';
    renderBlePeriphStatusChars();
}

function renderBlePeriphStatusChars() {
    var box = document.getElementById('blePfChars');
    if (!box) return;
    if (!_blePeriphStatusChars.length) {
        box.innerHTML = '<div class="ble-pf-empty">' + (_blePeriphRunning ? '该服务下没有特征' : '还未启动广播') + '</div>';
        return;
    }
    box.innerHTML = _blePeriphStatusChars.map(function(c) {
        var props = (c.props || []).map(function(p) { return BLE_PERIPH_PROP_LABEL[p] || p; }).join(' / ');
        // 「设值」只在特征**可读**时才有意义：不可读的特征主机读不到，
        // 它上面的值只反映"主机刚写进来什么"，给个设值按钮纯属误导
        var canRead = (c.props || []).indexOf('read') >= 0;
        var canNotify = (c.props || []).indexOf('notify') >= 0 || (c.props || []).indexOf('indicate') >= 0;
        var sub = (c.subscribed > 0)
            ? '<span class="ble-pf-badge on">已订阅 ' + c.subscribed + '</span>'
            : '<span class="ble-pf-badge">未订阅</span>';
        var val = c.value_hex ? bleFmtHex(c.value_hex) : '（空）';
        return '<div class="ble-char">' +
            '<span class="ble-char-uuid">0x' + escapeHtml(shortUuid(c.uuid || '')) + '</span>' +
            '<span class="ble-char-name">' + escapeHtml(props) + '</span>' +
            '<span class="ble-char-tag">' + (canRead ? '主机读到 ' : '主机写入 ') + escapeHtml(val) + '</span>' +
            '<span class="ble-char-actions">' + sub +
                (canRead ? '<span class="ble-ch-action ready" data-act="set" data-uuid="' + escapeHtml(c.uuid || '') + '" title="设置主机读到的值">' + BLE_ICONS.read + '</span>' : '') +
                (canNotify ? '<span class="ble-ch-action ready" data-act="notify" data-uuid="' + escapeHtml(c.uuid || '') + '" title="向已订阅主机下发通知">' + BLE_ICONS.notify_enable + '</span>' : '') +
            '</span>' +
        '</div>';
    }).join('');
}

function startBlePeriphPoll() {
    if (!_blePeriphEventTimer) _blePeriphEventTimer = setInterval(pollBlePeriphEvents, 500);
    if (!_blePeriphStatusTimer) _blePeriphStatusTimer = setInterval(refreshBlePeriphStatus, 2000);
}

function stopBlePeriphPoll() {
    if (_blePeriphEventTimer) { clearInterval(_blePeriphEventTimer); _blePeriphEventTimer = null; }
    if (_blePeriphStatusTimer) { clearInterval(_blePeriphStatusTimer); _blePeriphStatusTimer = null; }
}

function pollBlePeriphEvents() {
    var pane = document.getElementById('ble-pane');
    if (!pane || pane.style.display === 'none') return;
    if (_bleMode !== 'periph' || !_blePeriphRunning) return;
    invoke('ble_periph_poll_events').then(function(items) {
        if (!items || !items.length) return;
        items.forEach(function(ev) {
            var line = blePeriphFmtEvent(ev);
            var t = blePeriphTime(ev.ts);
            if (t) line.text = t + '  ' + line.text;
            pushBlePeriphLog(line);
            // 手动应答模式：把待应答的写请求挂到右列等用户点接受/拒绝
            if (ev.pending_id) {
                if (ev.kind === 'write') {
                    _blePfPending.push({ id: ev.pending_id, uuid: ev.uuid, hex: ev.value_hex || '' });
                    renderBlePfPending();
                } else if (ev.kind === 'write_reply') {
                    _blePfPending = _blePfPending.filter(function(x) { return x.id !== ev.pending_id; });
                    renderBlePfPending();
                }
            }
        });
        renderBlePeriphLog();
    }).catch(function() {});
}

function pushBlePeriphLog(entry) {
    if (!entry) return;
    _blePeriphLog.push(entry);
    if (_blePeriphLog.length > _blePeriphLogMax) _blePeriphLog.splice(0, _blePeriphLog.length - _blePeriphLogMax);
}

function renderBlePeriphLog() {
    var log = document.getElementById('blePfLog');
    if (!log) return;
    if (!_blePeriphLog.length) {
        log.textContent = '暂无事件。开始广播后，手机的读取 / 写入 / 订阅都会记在这里。';
        return;
    }
    log.innerHTML = _blePeriphLog.map(function(e) {
        return escapeHtml(e.text || '') + (e.dim ? '<span class="ble-log-dim">' + escapeHtml(e.dim) + '</span>' : '');
    }).join('\n') + '\n';
    log.scrollTop = log.scrollHeight;
}

function clearBlePeriphLog() {
    _blePeriphLog = [];
    renderBlePeriphLog();
}

// MARK: 运行时对特征的操作（设值 / 下发）
function blePeriphCharAction(uuid, kind) {
    if (!_blePeriphRunning) { showToast('请先开始广播', 'error'); return; }
    var c = null;
    _blePeriphStatusChars.forEach(function(x) { if (x.uuid === uuid) c = x; });
    if (!c) return;
    if (kind === 'notify') {
        if (!c.subscribed) { showToast('还没有主机订阅该特征：先在手机侧打开通知', 'error'); return; }
        openBleWriteModal(uuid, '下发通知', ['notify'], { kind: 'periph_notify' });
    } else {
        // 不可读的特征上设值没有意义（主机根本读不到），按钮本就不显示，这里再兜一层
        if ((c.props || []).indexOf('read') < 0) { showToast('该特征不可读，设值无效', 'error'); return; }
        openBleWriteModal(uuid, '设置可读值', ['write'], { kind: 'periph_set' });
    }
}

// 从机模式下写入弹窗的发送分支（与主机模式共用同一个弹窗与解析逻辑）
function sendBlePeriphWrite() {
    var t = _bleWriteTarget;
    if (!t) return;
    if (!_blePeriphRunning) { showToast('请先开始广播', 'error'); return; }
    var r = bleReadWriteModalInput();
    if (r.error) { showToast(r.error, 'error'); return; }
    var inp = document.getElementById('bleWriteValue');
    var isNotify = (t.kind === 'periph_notify');
    var label = isNotify ? '下发' : '设值';
    pushBlePeriphLog({ text: '[' + label + '] 0x' + shortUuid(t.uuid) + ' ← 0x' + r.hex, dim: '' });
    renderBlePeriphLog();
    // 两条命令分开写：命令名保持字面量，"哪个命令被谁调用"能直接被静态检索到
    var call = isNotify
        ? invoke('ble_periph_notify', { charUuid: t.uuid, data: r.bytes })
        : invoke('ble_periph_set_value', { charUuid: t.uuid, data: r.bytes });
    call.then(function(res) {
        var extra = (res && res.count != null) ? (' · ' + res.count + ' 个订阅者') : '';
        showToast(label + '成功：0x' + r.hex + extra, 'success');
        if (inp) { inp.value = ''; inp.focus(); }   // 发完一条即清空
        return refreshBlePeriphStatus();
    }).catch(function(e) {
        pushBlePeriphLog({ text: '[' + label + '失败] ' + e, dim: '' });
        renderBlePeriphLog();
        showToast(label + '失败: ' + e, 'error');
    });
}


