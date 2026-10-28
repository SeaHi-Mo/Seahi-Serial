<script setup lang="ts">
import { computed } from 'vue'
import { useData } from 'vitepress'
import { getCopy } from './copy'

const { lang } = useData()
const t = computed(() => getCopy(lang.value))

/* 多串口同屏：三个分栏，端口名用真实友好名（截图里是 CH343 / WCH-Link / USB 串行设备） */
const ports = [
  { name: 'CH343 (COM3)', baud: '115200', w: [92, 64, 78, 40, 70] },
  { name: 'WCH-Link (COM17)', baud: '115200', w: [70, 88, 52, 66] },
  { name: 'USB 串行设备 (COM16)', baud: '115200', w: [58, 74, 96, 36, 62] },
]

const rows = [
  { seq: '1', txt: 'AT', to: '3000' },
  { seq: '2', txt: 'AT+GMR', to: '3000' },
  { seq: '3', txt: 'AT+CWJAP', to: '5000' },
]

const services = [
  { u: '0x1800', n: 'Generic Access' },
  { u: '0x180F', n: 'Battery Service' },
  { u: '0x1805', n: 'Current Time' },
]
</script>

<template>
  <section class="lp-sec lp-wrap">
    <div class="lp-sec-h lp-reveal">
      <h2>{{ t.section.title }}</h2>
    </div>

    <div class="lp-grid2">
      <!-- 1. 多串口 -->
      <article class="lp-card lp-reveal">
        <div class="lp-card-copy">
          <h3>{{ t.section.cards[0].title }}</h3>
          <p>{{ t.section.cards[0].body }}</p>
        </div>
        <div class="lp-media">
          <!-- 画的是「点了左上角 ＋ 新建分栏」这一刻：前两栏已在跑，第三栏正在插入 -->
          <div class="lp-mwin">
            <div class="lp-mbar">
              <img src="/logo.png" class="lp-mbar-app" width="12" height="12" alt="" />
              <span class="lp-mbar-btn lp-press">＋</span>
              <span class="lp-mbar-btn">▢</span>
              <span class="lp-mbar-btn">ADB</span>
              <span class="lp-mbar-btn">✦</span>
              <span class="lp-mbar-spacer"></span>
              <span class="lp-mbar-win">— ▢ ✕</span>
              <svg class="lp-cursor" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3.2 2.2l8.9 5.9-4 .8-1.7 3.6z" />
              </svg>
            </div>
            <div class="lp-mpanes">
              <article v-for="(p, i) in ports.slice(0, 2)" :key="p.name" class="lp-mpane">
                <div class="lp-mpane-tb">
                  <span class="lp-mpane-sel">{{ p.name }}</span>
                  <span class="lp-mpane-ref">⟳</span>
                  <span class="lp-mpane-baud">{{ p.baud }}</span>
                  <span class="lp-mpane-run">▶</span>
                  <span v-if="i > 0" class="lp-mpane-close">✕</span>
                </div>
                <div class="lp-mpane-out">
                  <i v-for="(w, j) in p.w" :key="j" :style="{ width: w + '%' }"></i>
                </div>
                <div class="lp-mpane-send"><span></span></div>
              </article>

              <article class="lp-mpane lp-mpane-ghost">
                <span class="lp-ghost-plus">＋</span>
                <span class="lp-ghost-hint">新分栏</span>
              </article>
            </div>
          </div>
        </div>
      </article>

      <!-- 2. 终端 -->
      <article class="lp-card lp-reveal lp-d1">
        <div class="lp-card-copy">
          <h3>{{ t.section.cards[1].title }}</h3>
          <p>{{ t.section.cards[1].body }}</p>
        </div>
        <div class="lp-media">
          <div class="lp-term">
            <div class="lp-term-h">
              <span class="lp-term-name">COM3 · xterm</span>
              <span class="lp-term-ctrl">
                <svg viewBox="0 0 10 10"><line x1="2" y1="5" x2="8" y2="5" /></svg>
                <svg viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7" rx="0.5" /></svg>
                <svg class="lp-term-x" viewBox="0 0 10 10"><path d="M2.2 2.2l5.6 5.6M7.8 2.2L2.2 7.8" /></svg>
              </span>
            </div>
            <div class="lp-term-b">
              <div><span class="lp-prompt">$</span> ls</div>
              <div class="lp-term-out">serial/ bluetooth/ docs/ tools/</div>
              <div><span class="lp-prompt">$</span> top<span class="lp-caret"></span></div>
            </div>
          </div>
        </div>
      </article>

      <!-- 3. 快速指令 -->
      <article class="lp-card lp-reveal">
        <div class="lp-card-copy">
          <h3>{{ t.section.cards[2].title }}</h3>
          <p>{{ t.section.cards[2].body }}</p>
        </div>
        <div class="lp-media">
          <div class="lp-qcmd">
            <div class="lp-qcmd-h">
              <span class="lp-qloop"><i></i>循环发送</span>
              <span class="lp-loop">＋ 新建组</span>
            </div>
            <div class="lp-qcols"><span>顺序</span><span>指令</span><span>超时(ms)</span></div>
            <div v-for="r in rows" :key="r.seq" class="lp-qrow">
              <span class="lp-qseq on">{{ r.seq }}</span>
              <span class="lp-qtxt">{{ r.txt }}</span>
              <span class="lp-qto">{{ r.to }}</span>
            </div>
          </div>
        </div>
      </article>

      <!-- 4. 蓝牙 -->
      <article class="lp-card lp-reveal lp-d1">
        <div class="lp-card-copy">
          <h3>{{ t.section.cards[3].title }}</h3>
          <p>{{ t.section.cards[3].body }}</p>
        </div>
        <div class="lp-media">
          <div class="lp-gatt">
            <div v-for="s in services" :key="s.u" class="lp-grow">
              <span class="lp-guuid">{{ s.u }}</span>
              <span class="lp-gname">{{ s.n }}</span>
            </div>
            <div class="lp-gdecode">→ 2026-10-27T23:12:08+08:00 (Tue)</div>
          </div>
        </div>
      </article>

      <!-- 5. WSL 端口映射（整行宽卡：表格需要宽度） -->
      <article class="lp-card lp-card-wide lp-reveal">
        <div class="lp-card-copy">
          <h3>{{ t.section.wsl.title }}</h3>
          <p>{{ t.section.wsl.body }}</p>
        </div>
        <div class="lp-media lp-media-wide">
          <div class="lp-wsl">
            <div class="lp-wsl-bar">
              <span class="lp-wsl-title">WSL 端口映射</span>
              <span class="lp-wsl-lbl">映射到</span>
              <span class="lp-sel-s">默认 ▾</span>
              <span class="lp-wsl-spacer"></span>
              <span class="lp-wsl-toast"><i></i>已将 COM8 (busid: 5-1) 映射到 WSL</span>
            </div>
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
    </div>
  </section>
</template>
