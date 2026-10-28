<script setup lang="ts">
import { computed } from 'vue'
import { useData } from 'vitepress'
import { getCopy } from './copy'

const { lang } = useData()
const t = computed(() => getCopy(lang.value))

/**
 * 功能卡片里的画面**全部是真实程序截图**，不是用 DOM 画的示意图。
 *
 * 每张图的来源（v0.5.21 release 构建、窗口 1440×950）：
 * - feature-panes：两个分栏同时连真实串口（COM9 Linux 设备 + COM17 USB 串口设备）
 * - feature-wsl：WSL 端口映射（真实 usbipd 设备列表 + 本机 Ubuntu-20.04）
 * - feature-qcmd：快速指令侧栏（数据来自程序配置，含 HEX 条目的真实状态）
 * - feature-ble：BLE 扫描结果与设备详情（本机蓝牙适配器真实扫到的设备）
 * - feature-terminal：终端模式接真实 Linux 设备跑 `ls` / `uname` / `uptime`
 *
 * 其中 hero 与 terminal 两张是**真实录制的动画**（`hero.mp4` / `terminal.mp4`，由窗口逐帧抓取后编码，
 * 不是 CSS 动画）：hero 演示串口日志滚动 + 快速指令侧栏；terminal 演示真实敲命令与彩色输出。
 * `prefers-reduced-motion` 用户看到的是同名 `.png` 静态帧。
 *
 * 更新方式：跑起程序、进入对应界面、截图覆盖 `docs/public/img/landing/*.png`。
 * **不要再用源码临摹界面**（2026-10 用户明确要求：首页展示的必须是真实渲染）。
 */
</script>

<template>
  <section class="lp-sec lp-wrap">
    <div class="lp-sec-h lp-reveal">
      <h2>{{ t.section.title }}</h2>
    </div>

    <div class="lp-grid2">
      <!-- 1. 多串口：整行宽（两个分栏并排，各自真实端口） -->
      <article class="lp-card lp-card-wide lp-reveal">
        <div class="lp-card-copy">
          <h3>{{ t.section.panes.title }}</h3>
          <p>{{ t.section.panes.body }}</p>
        </div>
        <div class="lp-media lp-media-wide">
          <img class="lp-shot" src="/img/landing/feature-panes.png" :alt="t.section.panes.title" loading="lazy" />
        </div>
      </article>

      <!-- 2. WSL 端口映射（整行宽：真实 usbipd 设备列表） -->
      <article class="lp-card lp-card-wide lp-reveal">
        <div class="lp-card-copy">
          <h3>{{ t.section.wsl.title }}</h3>
          <p>{{ t.section.wsl.body }}</p>
        </div>
        <div class="lp-media lp-media-wide">
          <img class="lp-shot" src="/img/landing/feature-wsl.png" :alt="t.section.wsl.title" loading="lazy" />
        </div>
      </article>

      <!-- 3. 快速指令 -->
      <article class="lp-card lp-reveal">
        <div class="lp-card-copy">
          <h3>{{ t.section.qcmd.title }}</h3>
          <p>{{ t.section.qcmd.body }}</p>
        </div>
        <div class="lp-media">
          <img class="lp-shot" src="/img/landing/feature-qcmd.png" :alt="t.section.qcmd.title" loading="lazy" />
        </div>
      </article>

      <!-- 4. 蓝牙 -->
      <article class="lp-card lp-reveal lp-d1">
        <div class="lp-card-copy">
          <h3>{{ t.section.gatt.title }}</h3>
          <p>{{ t.section.gatt.body }}</p>
        </div>
        <div class="lp-media">
          <img class="lp-shot" src="/img/landing/feature-ble.png" :alt="t.section.gatt.title" loading="lazy" />
        </div>
      </article>

      <!-- 5. 真终端（整行宽：真实 Linux 串口设备的终端画面） -->
      <article class="lp-card lp-card-wide lp-reveal">
        <div class="lp-card-copy">
          <h3>{{ t.section.terminal.title }}</h3>
          <p>{{ t.section.terminal.body }}</p>
        </div>
        <div class="lp-media lp-media-wide">
          <div class="motion">
            <video autoplay muted loop playsinline preload="metadata" poster="/img/landing/feature-terminal.png" :aria-label="t.section.terminal.title">
              <source src="/img/landing/terminal.mp4" type="video/mp4" />
            </video>
            <img class="lp-shot motion-still" src="/img/landing/feature-terminal.png" :alt="t.section.terminal.title" loading="lazy" />
          </div>
        </div>
      </article>
    </div>
  </section>
</template>
