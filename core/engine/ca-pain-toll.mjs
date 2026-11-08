#!/usr/bin/env node
// ca-pain-toll.mjs — 痛觉不应期(定位:这不是规则,这是物理法则)
// 机理(信息热力学,非外在死规则):痛觉不免费——每次负反馈(miss/reject)都收电费,
//   同一对象反复负反馈 → 成本指数翻倍(0.10→0.20→0.40→0.80→1.60,2^min(repeat,4));
//   当日落空率>50%(≥10 判)再 ×2;单票上限 ¥2 焊死。高成本逼系统对痛觉「脱敏」,
//   瞎预言=高额电费,自激环在物理上失去燃料。
// 收费口径:罚单直进 state/wallet-credit.json(可负=多巴胺罚单先例;翻日自废不累计);
//   每笔落 ledgers/dopamine.jsonl kind=pain-toll(append-only 可稽)。
// 纪律:机械零LLM;收费器自身坏=免单不拦主流程(返回 toll:0,调用方留痕)。
import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { localDay } from './time.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CA = process.env.CA_HOME ?? path.resolve(HERE, '..');
const PRED = path.join(CA, 'ledgers', 'predictions.jsonl');
const CREDIT = path.join(CA, 'state', 'wallet-credit.json');
const DOPA = path.join(CA, 'ledgers', 'dopamine.jsonl');

// 电费基数由 ca-calib 内生(零LLM 机械统计器,先验 0.10);
//   读坏=回退先验(fail-safe=更紧更省)。帽 ¥2 与翻倍率暂不动(一件一动,防多变量归因打架)。
const calibValue = (name, fallback) => {
  try { const v = Number(JSON.parse(readFileSync(path.join(CA, 'state', 'calib', `${name}.json`), 'utf8')).value); return Number.isFinite(v) ? v : fallback; } catch { return fallback; }
};
const BASE_CNY = calibValue('pain-toll-base', 0.10), CAP_CNY = 2.00;

export function painToll({ predId = null, about = '', why = '' } = {}) {
  try {
    const today = localDay();
    let repeat = 0, hits = 0, misses = 0;
    const norm = (s) => String(s ?? '').replace(/\s+/g, '').slice(0, 60);
    const me = norm(about);
    for (const l of readFileSync(PRED, 'utf8').split('\n').filter(Boolean)) {
      let r; try { r = JSON.parse(l); } catch { continue; }
      // 重复计数:miss 走同 pred id 既往 miss/suspect;reject 走同 about 形状(拒收每次发新 rid,id 追不了)
      if (predId && r.id === predId && (r.state === 'miss' || r.state === 'suspect')) repeat++;
      if (!predId && r.state === 'rejected' && me && norm(r.about) === me) repeat++;
      // 当日落空率(判决口径,本地日)
      const ts = String(r.verdictTs ?? r.ts ?? '');
      if (ts.startsWith(today)) { if (r.state === 'miss') misses++; else if (r.state === 'hit') hits++; }
    }
    let toll = BASE_CNY * Math.pow(2, Math.min(repeat, 4));
    const n = hits + misses;
    const missRate = n >= 10 ? misses / n : 0;
    if (missRate > 0.5) toll *= 2;
    toll = Math.min(CAP_CNY, Math.round(toll * 100) / 100);
    // 罚单进 wallet-credit(净额合写,dopamine 奖金与痛觉罚单同池;翻日自废)
    let credit = { date: today, creditCny: 0, source: 'pain-toll' };
    try { credit = JSON.parse(readFileSync(CREDIT, 'utf8')); } catch { /* 无文件=从零起 */ }
    if (credit?.date !== today) credit = { date: today, creditCny: 0, source: 'pain-toll' };
    credit.creditCny = Math.round((Number(credit.creditCny ?? 0) - toll) * 10000) / 10000;
    credit.source = 'pain-toll+dopamine';
    credit.ts = new Date().toISOString();
    const t = `${CREDIT}.tmp-${process.pid}`; writeFileSync(t, JSON.stringify(credit) + '\n'); renameSync(t, CREDIT);
    mkdirSync(path.dirname(DOPA), { recursive: true });
    appendFileSync(DOPA, JSON.stringify({ ts: new Date().toISOString(), kind: 'pain-toll', pred: predId, about: String(about).slice(0, 120), repeat, missRate: Math.round(missRate * 1000) / 1000, amountCny: -toll, why: String(why).slice(0, 120) }) + '\n');
    return { repeat, missRate, toll };
  } catch { return { repeat: 0, missRate: 0, toll: 0 }; }
}
