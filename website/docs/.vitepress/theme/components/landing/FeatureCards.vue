<script setup lang="ts">
import { computed } from 'vue'
import { useData } from 'vitepress'
import { getCopy } from './copy'
import { UI_ICONS as I } from './icons.generated'

const { lang } = useData()
const t = computed(() => getCopy(lang.value))

/**
 * 三个分栏，照真实三栏截图摆：端口名/连接状态/关闭按钮各不相同。
 * 左栏是第一个分栏（不能关），右边两栏带 ✕。
 */
const panes = [
  { name: 'USB-SERIAL CH340 (COM8)', on: false, close: false },
  { name: 'USB-SERIAL CH343 (COM3)', on: false, close: true },
]

/** 工具栏那一排 ibtn：顺序与 10-monitor.js 一致，on 态取默认（自动滚动 / 命令行缓冲 / 更多设置） */
const miniIcons = [
  { k: 'clear', on: false },
  { k: 'rollback', on: true },
  { k: 'reconnect', on: false },
  { k: 'terminal', on: false },
  { k: 'lineBuf', on: true },
  { k: 'lineNum', on: false },
  { k: 'timestamp', on: false },
  { k: 'copy', on: false },
  { k: 'settings', on: true },
]

/** 快速指令一组两条：顺序号 1 参与循环（蓝）、0 不参与（灰），数值取自运行时截图 */
const qcmds = [
  { seq: '1', text: '12345678901', delay: '200', on: true },
  { seq: '0', text: '231231', delay: '1000', on: false },
]

/** 终端模式下这几个按钮置灰（只改外观，不动用户开关） */
const termIcons = [
  { k: 'clear', off: false },
  { k: 'rollback', off: false },
  { k: 'reconnect', off: false },
  { k: 'terminal', off: false },
  { k: 'lineBuf', off: false },
  { k: 'lineNum', off: true },
  { k: 'timestamp', off: true },
  { k: 'copy', off: true },
  { k: 'settings', off: false },
]

/** 蓝牙列表里的三台设备（名称 / MAC / RSSI），第一台是选中的 */
const bleDevices = [
  { name: 'JY202504220005', mac: '4C:A0:3D:05:3E:5C', rssi: '-63 dBm', on: true },
  { name: '未知设备', mac: 'CB:1D:B8:B8:53:C3', rssi: '-63 dBm', on: false },
  { name: 'B225020… (Beacon)', mac: '52:01:24:09:03:B5', rssi: '-65 dBm', on: false },
  { name: '未知设备', mac: 'DC:49:F2:F1:51:44', rssi: '-65 dBm', on: false },
  { name: '未知设备', mac: '88:12:AC:91:9B:CC', rssi: '-65 dBm', on: false },
  { name: '未知设备', mac: '1E:C5:DD:BC:9E:89', rssi: '-65 dBm', on: false },
]
</script>

<template>
  <section class="lp-sec lp-wrap">
    <div class="lp-sec-h lp-reveal">
      <h2>{{ t.section.title }}</h2>
    </div>

    <div class="lp-grid2">
      <!-- 1. 多串口：整行宽，三栏并排（每栏都是完整的工具栏 + 高级设置 + 输出 + 发送栏） -->
      <article class="lp-card lp-card-wide lp-reveal">
        <div class="lp-card-copy">
          <h3>{{ t.section.panes.title }}</h3>
          <p>{{ t.section.panes.body }}</p>
        </div>
        <div class="lp-media lp-media-wide">
          <div class="lp-mp">
            <article v-for="p in panes" :key="p.name" class="lp-mpane">
              <div class="lp-mpane-hd"><span v-if="p.close" class="lp-mpane-x">✕</span></div>

              <!-- 一整条 .toolbar：flex-wrap，窄了就按真实界面的顺序折行 -->
              <div class="lp-mpane-tb">
                <span class="lp-mpane-lbl">查看</span>
                <span class="lp-mpane-sel">文本<i>▾</i></span>
                <span class="lp-mpane-lbl">端口</span>
                <span class="lp-mpane-sel lp-mpane-port">{{ p.name }}<i>▾</i></span>
                <span class="lp-mpane-ref" v-html="I.toolbar.refresh"></span>
                <span class="lp-mpane-lbl">波特率</span>
                <span class="lp-mpane-sel">115200<i>▾</i></span>
                <span class="lp-mpane-lbl">行尾</span>
                <span class="lp-mpane-sel">CRLF<i>▾</i></span>
                <span class="lp-mpane-run" :class="{ on: p.on }"><i>{{ p.on ? '■' : '▶' }}</i>{{ p.on ? '停止监控' : '开始监控' }}</span>
              </div>

              <div class="lp-mpane-icos">
                <span
                  v-for="b in miniIcons"
                  :key="b.k"
                  class="lp-mpane-ibtn"
                  :class="{ on: b.on }"
                  v-html="I.toolbar[b.k]"
                ></span>
              </div>

              <!-- .adv-row 也是一条 flex-wrap：数据位…RTS、日志目录、保存/复制/收起、添加规则，窄了整条折行 -->
              <div class="lp-mpane-adv">
                <span class="lp-mpane-lbl">数据位</span><span class="lp-mpane-sel">8<i>▾</i></span>
                <span class="lp-mpane-lbl">停止位</span><span class="lp-mpane-sel">1<i>▾</i></span>
                <span class="lp-mpane-lbl">校验位</span><span class="lp-mpane-sel">无<i>▾</i></span>
                <span class="lp-chk"><i></i>DTR</span>
                <span class="lp-chk"><i></i>RTS</span>
                <span class="lp-mpane-logdir">📁 选择日志目录</span>
                <span class="lp-mpane-aico" v-html="I.toolbar.saveLog"></span>
                <span class="lp-mpane-aico" v-html="I.toolbar.copyAll"></span>
                <span class="lp-mpane-aico" v-html="I.toolbar.chevronUp"></span>
                <span class="lp-mpane-wf">+ 添加规则</span>
              </div>

              <div class="lp-mpane-out"></div>

              <div class="lp-mpane-send">
                <span class="lp-mpane-inp">输入要发送的内容，回车发送 ...</span>
                <span class="lp-mpane-as">文本<i>▾</i></span>
                <span class="lp-mpane-sep">|</span>
                <span class="lp-mpane-sbtn" :class="{ off: !p.on }"><i>▶</i> 发送</span>
              </div>

              <span class="lp-mpane-qtab"></span>
            </article>
          </div>
        </div>
      </article>

      <!-- 2. WSL 端口映射（优势点，排在第二位） -->
      <article class="lp-card lp-reveal">
        <div class="lp-card-copy">
          <h3>{{ t.section.wsl.title }}</h3>
          <p>{{ t.section.wsl.body }}</p>
        </div>
        <div class="lp-media">
          <div class="lp-wsl">
            <div class="lp-wsl-bar">
              <span class="lp-wsl-title">WSL 端口映射</span>
              <span class="lp-wsl-lbl">映射到</span>
              <span class="lp-sel-s">默认 ▾</span>
            </div>
            <div class="lp-wsl-note"><i></i>COM8 已映射到 WSL</div>
            <div class="lp-wsl-cols">
              <span>BUSID</span><span>端口</span><span>设备名称</span><span>状态</span><span>自动</span><span>映射</span>
            </div>
            <div class="lp-wsl-row">
              <span>5-1</span>
              <span class="lp-wsl-dev">/dev/ttyUSB0</span>
              <span class="lp-wsl-name">USB-SERIAL CH340<em>1A86:7523</em></span>
              <span class="lp-wsl-state"><i></i></span>
              <span class="lp-sw"><i></i></span>
              <span class="lp-check">✓</span>
            </div>
          </div>
        </div>
      </article>

      <!-- 3. 快速指令 -->
      <article class="lp-card lp-reveal">
        <div class="lp-card-copy">
          <h3>{{ t.section.qcmd.title }}</h3>
          <p>{{ t.section.qcmd.body }}</p>
        </div>
        <div class="lp-media">
          <div class="lp-qc">
            <div class="lp-qc-hd">
              <span class="lp-qc-loop"><i></i>循环发送</span>
              <span class="lp-qc-acts"><span>＋ 新建循环组</span><span>导入</span><span>导出</span></span>
            </div>
            <div class="lp-qc-group">
              <span class="lp-qc-grip"></span>
              <span class="lp-qc-sw"><i></i></span>
              <span class="lp-qc-name">循环 1</span>
              <span class="lp-qc-count">2 条</span>
              <span class="lp-qc-del">✕</span>
            </div>
            <div class="lp-qc-cols">
              <span class="c-seq">顺序</span>
              <span class="c-val">指令</span>
              <span class="c-delay">超时<i>(ms)</i></span>
              <span class="c-hex">HEX</span>
              <span class="c-add">＋ 添加</span>
            </div>
            <div v-for="c in qcmds" :key="c.seq" class="lp-qc-row">
              <span class="lp-qc-seq" :class="{ on: c.on }">{{ c.seq }}</span>
              <span class="lp-qc-val">{{ c.text }}</span>
              <span class="lp-qc-delay">{{ c.delay }}</span>
              <span class="lp-qc-hex">HEX</span>
              <span class="lp-qc-ico">⤴</span>
              <span class="lp-qc-ico">✕</span>
            </div>
          </div>
        </div>
      </article>

      <!-- 4. 蓝牙 -->
      <article class="lp-card lp-reveal lp-d1">
        <div class="lp-card-copy">
          <h3>{{ t.section.gatt.title }}</h3>
          <p>{{ t.section.gatt.body }}</p>
        </div>
        <div class="lp-media">
          <div class="lp-ble">
            <div class="lp-ble-side">
              <div class="lp-ble-sh">
                <span class="lp-ble-title"><i></i>蓝牙列表</span>
                <span class="lp-ble-btn">开始扫描</span>
                <span class="lp-ble-sel">30 秒 ▾</span>
              </div>
              <div class="lp-ble-search">
                <span class="lp-ble-inp">输入目标设备 MAC</span>
                <span class="lp-ble-btn2">直连</span>
              </div>
              <div v-for="d in bleDevices" :key="d.mac" class="lp-ble-dev" :class="{ on: d.on }">
                <span class="lp-ble-ico"></span>
                <span class="lp-ble-devname">{{ d.name }}<em>{{ d.mac }}</em></span>
                <span class="lp-ble-rssi">{{ d.rssi }}</span>
              </div>
            </div>

            <div class="lp-ble-main">
              <div class="lp-ble-mh">
                <span class="lp-ble-name">JY202504220005</span>
                <span class="lp-ble-mac">4C:A0:3D:05:3E:5C</span>
                <span class="lp-ble-tag">Public</span>
                <span class="lp-ble-tag">-63 dBm</span>
                <span class="lp-ble-conn">连接设备</span>
              </div>

              <div class="lp-ble-sec"><span>广播内容</span><span>43 B</span></div>
              <div class="lp-ble-cols">
                <span>Flags</span><span>服务UUID(16bit)</span><span>厂商数据</span><span>广播名</span>
              </div>
              <div class="lp-ble-vals">
                <span>020106</span><span>050343533322</span><span>11FF0000…</span><span>0F094A…</span>
              </div>
              <div class="lp-ble-pairs">
                <span class="k">广播名</span><span class="v">JY202504220005</span>
                <span class="k">广播服务</span><span class="v">0x5343 · 0x2233</span>
                <span class="k">厂商数据(0x0)</span><span class="v">0x00000000…</span>
              </div>

              <div class="lp-ble-sec"><span>GATT 服务 / 特征</span></div>
              <div class="lp-ble-g"><span class="p">P</span><span class="u">▸ 0x5343</span><span class="n">Custom Service</span></div>
              <div class="lp-ble-g"><span class="p">S</span><span class="u">▸ 0x2233</span><span class="n">Custom Service</span></div>

              <div class="lp-ble-sec"><span>数据日志</span><span>清空</span></div>
              <div class="lp-ble-log">暂无日志</div>
            </div>
          </div>
        </div>
      </article>

      <!-- 5. 真终端（不是主打，放最后） -->
      <article class="lp-card lp-reveal">
        <div class="lp-card-copy">
          <h3>{{ t.section.terminal.title }}</h3>
          <p>{{ t.section.terminal.body }}</p>
        </div>
        <div class="lp-media">
          <!-- 不是另开一个窗口：终端模式就是分栏的输出区换成 xterm 画布 -->
          <div class="lp-xterm">
            <div class="lp-xterm-tb">
              <span class="lp-xterm-lbl">查看</span>
              <span class="lp-xterm-sel">文本<i>▾</i></span>
              <span class="lp-xterm-lbl">端口</span>
              <span class="lp-xterm-sel lp-xterm-port">USB-SERIAL CH343 (COM3)<i>▾</i></span>
              <span class="lp-xterm-lbl">波特率</span>
              <span class="lp-xterm-sel">115200<i>▾</i></span>
              <span class="lp-xterm-run"><i>■</i>停止监控</span>
            </div>
            <div class="lp-xterm-icos">
              <span
                v-for="b in termIcons"
                :key="b.k"
                class="lp-xterm-ibtn"
                :class="{ on: b.k === 'terminal', off: b.off }"
                v-html="I.toolbar[b.k]"
              ></span>
            </div>
            <div class="lp-xterm-body">
              <div><span class="lp-xp">root@seahi</span><span class="lp-xp2">:~#</span> uname -a</div>
              <div class="lp-xo">Linux seahi 5.10.160 #1 SMP Tue Oct 21 10:12:03 CST 2025</div>
              <div><span class="lp-xp">root@seahi</span><span class="lp-xp2">:~#</span> ls /etc/init.d</div>
              <div class="lp-xo">S10mdev  S50dropbear  rcS</div>
              <div><span class="lp-xp">root@seahi</span><span class="lp-xp2">:~#</span> <span class="lp-xcursor"></span></div>
            </div>
            <div class="lp-xterm-send">
              <span class="inp">输入要发送的内容，回车发送 ...</span>
              <span class="as">文本<i>▾</i></span>
              <span class="sep">|</span>
              <span class="btn">▶ 发送</span>
            </div>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>
