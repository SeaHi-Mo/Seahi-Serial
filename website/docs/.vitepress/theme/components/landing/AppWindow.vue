<script setup lang="ts">
import { computed } from 'vue'
import { useData } from 'vitepress'
import { getCopy } from './copy'
import { UI_ICONS as I } from './icons.generated'

const { lang } = useData()
const t = computed(() => getCopy(lang.value))

/**
 * 照 src/index.html + js/10-monitor.js 的真实结构画的（2026-10-28 对着运行时截图校准）。
 * 图标**全部取自源码**（icons.generated.ts 由 scripts/sync-ui-icons.mjs 抽取），
 * 尺寸也用源码里的 width/height，不再手画线稿。
 */

const logs = [
  { k: 'sys', text: '已连接 COM8 · 115200 8N1' },
  { k: 'send', text: 'AT+GMR' },
  { k: 'recv', text: 'AT version:1.7.4.0 (May 11 2022)' },
  { k: 'send', text: 'AT+CIFSR' },
  { k: 'recv', text: '+CIFSR:STAIP,"192.168.4.23"' },
  { k: 'recv', text: '+CIFSR:STAMAC,"3c:71:bf:1a:0c:5e"' },
  { k: 'send', text: 'AT+BLUFIND=1' },
  { k: 'recv', text: '+BLUFIND:1,"a4:c1:38:2b:9f:01",-58' },
  { k: 'recv', text: '+BLUFIND:2,"d0:9f:14:7c:22:8e",-71' },
  { k: 'send', text: 'AT+RST' },
  { k: 'sys', text: 'ready · 312 ms' },
]

const cmds = [
  { seq: '1', text: '12345678901', delay: '200', on: true },
  { seq: '0', text: '231231', delay: '1000', on: false },
]

/** 顺序与 10-monitor.js 的 ibtn-group 一致；on 态也照默认（自动滚动 / 命令行缓冲 / 更多设置） */
const ibtns = [
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
</script>

<template>
  <div class="aw-win" role="img" :aria-label="t.hero.winLabel">
    <!-- ===== 全局操作栏（自定义标题栏 36px）===== -->
    <div class="aw-gb">
      <img class="aw-gb-icon" src="/logo.png" width="22" height="22" alt="" />
      <span class="aw-gb-btn" title="再开一个串口监视器分栏" v-html="I.global.add"></span>
      <span class="aw-gb-btn" title="WSL 端口映射" v-html="I.global.wsl"></span>
      <span class="aw-gb-btn" title="ADB 设备调试" v-html="I.global.adb"></span>
      <span class="aw-gb-btn" title="蓝牙调试" v-html="I.global.ble"></span>

      <span class="aw-gb-spacer"></span>

      <span class="aw-gb-btn" title="MCP 服务器">
        <span v-html="I.global.mcp"></span>
        <i class="aw-dot"></i>
      </span>

      <span class="aw-gb-sel" title="主题风格" v-html="I.global.palette"></span>

      <span class="aw-gb-issue">提交issue</span>

      <span class="aw-gb-theme" title="深浅色切换">
        <span class="aw-sun" v-html="I.global.sun"></span>
        <span class="aw-track"><i></i></span>
        <span class="aw-moon" v-html="I.global.moon"></span>
      </span>

      <span class="aw-winctrl">
        <i v-html="I.winCtrl[0]"></i>
        <i v-html="I.winCtrl[1]"></i>
        <i class="aw-close" v-html="I.winCtrl[2]"></i>
      </span>
    </div>

    <!-- ===== 监视器分栏 ===== -->
    <div class="aw-pane">
      <div class="aw-tb">
        <span class="aw-grp">
          <span class="aw-lbl">查看</span>
          <span class="aw-sel">文本<span class="aw-arw"></span></span>
        </span>
        <span class="aw-grp">
          <span class="aw-lbl">端口</span>
          <span class="aw-sel aw-sel-port">USB-SERIAL CH340 (COM8)<span class="aw-arw"></span></span>
          <span class="aw-ref" title="刷新端口" v-html="I.toolbar.refresh"></span>
        </span>
        <span class="aw-grp">
          <span class="aw-lbl">波特率</span>
          <span class="aw-baud"><span class="aw-baud-in">115200</span><span class="aw-baud-arw"></span></span>
        </span>
        <span class="aw-grp">
          <span class="aw-lbl">行尾</span>
          <span class="aw-sel">CRLF<span class="aw-arw"></span></span>
        </span>
        <span class="aw-run aw-run-stop"><span class="aw-run-ico">■</span>停止监控</span>
        <span class="aw-tsep"></span>
        <span class="aw-ibg">
          <span v-for="b in ibtns" :key="b.k" class="aw-ibtn" :class="{ on: b.on }" v-html="I.toolbar[b.k]"></span>
        </span>
      </div>

      <!-- 高级设置行（新建监视器默认展开）-->
      <div class="aw-adv">
        <span class="aw-grp"><span class="aw-lbl">数据位</span><span class="aw-sel">8<span class="aw-arw"></span></span></span>
        <span class="aw-grp"><span class="aw-lbl">停止位</span><span class="aw-sel">1<span class="aw-arw"></span></span></span>
        <span class="aw-grp"><span class="aw-lbl">校验位</span><span class="aw-sel">无<span class="aw-arw"></span></span></span>
        <span class="aw-chk"><i class="aw-box"></i>DTR</span>
        <span class="aw-chk"><i class="aw-box on"></i>RTS</span>
        <span class="aw-logdir">📁 选择日志目录</span>
        <span class="aw-adv-ico" v-html="I.toolbar.saveLog"></span>
        <span class="aw-adv-ico" v-html="I.toolbar.copyAll"></span>
        <span class="aw-adv-ico" v-html="I.toolbar.chevronUp"></span>
        <span class="aw-gb-spacer"></span>
        <span class="aw-wf-add">+ 添加规则</span>
      </div>

      <div class="aw-body">
        <div class="aw-out">
          <div v-for="(l, i) in logs" :key="i" class="aw-ol" :class="'aw-ol-' + l.k">
            <span class="aw-lc">{{ l.text }}</span>
          </div>
          <div class="aw-caret-line"><span class="aw-caret"></span></div>
        </div>

        <!-- 快速指令侧栏（展开态，300px） -->
        <div class="aw-qcmd">
          <span class="aw-qtab"></span>
          <div class="aw-qbody">
            <div class="aw-qhd">
              <span class="aw-qloop"><i></i>循环发送</span>
              <span class="aw-qacts">
                <span class="aw-qact">＋ 新建循环组</span>
                <span class="aw-qact">导入</span>
                <span class="aw-qact">导出</span>
              </span>
            </div>
            <div class="aw-qgroup">
              <span class="aw-qgrip"></span>
              <span class="aw-qsw on"><i></i></span>
              <span class="aw-qname">循环 1</span>
              <span class="aw-qcount">2 条</span>
              <span class="aw-qdel">✕</span>
            </div>
            <div class="aw-qcols">
              <span class="c-seq">顺序</span>
              <span class="c-val">指令</span>
              <span class="c-delay">超时<i>(ms)</i></span>
              <span class="c-hex">HEX</span>
              <span class="c-add">＋ 添加</span>
            </div>
            <div v-for="c in cmds" :key="c.seq" class="aw-qrow">
              <span class="aw-qseq" :class="{ on: c.on }">{{ c.seq }}</span>
              <span class="aw-qval">{{ c.text }}</span>
              <span class="aw-qdelay">{{ c.delay }}</span>
              <span class="aw-qhex">HEX</span>
              <span class="aw-qmini" v-html="I.toolbar.sendIcon"></span>
              <span class="aw-qmini">✕</span>
            </div>
          </div>
        </div>
      </div>

      <div class="aw-sendbar">
        <span class="aw-send-inp">输入要发送的内容，回车发送...</span>
        <span class="aw-send-as">文本<span class="aw-arw"></span></span>
        <span class="aw-ssep">|</span>
        <span class="aw-btn-send">▶ 发送</span>
      </div>
    </div>
  </div>
</template>
