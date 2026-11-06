#!/usr/bin/env node
// time.mjs — CAOS 单点时间模块(全引擎唯一时间算术出口;其余文件禁自写日期算术)
// why:时间口径错位(UTC/本地日混排、滑窗拍动)是单机实弹暴露的三类病之一,架构层单点根治。
// 规则:账本比较一律 epoch ms;「今日」一律本地日界;ISO 解析一律走本模块。
export const localIso = (d = new Date()) => {
  const o = -d.getTimezoneOffset();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${o >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(o) / 60))}:${p(Math.abs(o) % 60)}`;
};
export const parseTs = (s) => { const t = Date.parse(String(s ?? '')); return Number.isFinite(t) ? t : 0; }; // 混排时区一律 epoch,坏串=0
export const localDayStartMs = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
export const localDay = (d = new Date()) => localIso(d).slice(0, 10);
