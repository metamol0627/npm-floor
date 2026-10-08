// 床の推移のグラフ（SVG・依存ゼロ）。月別の S（公開後 4 日の DL）と T（15〜30 日目の滴り／日）の中央値と p10〜p90 の帯。
// 1 系列 × 2 面（小さな多重パネル。軸は 1 面に 1 本）。色は 1 色（青）で、帯は同じ色の 10% の塗り。文字は文字用の色。
// 補間した月は中抜きのマーカー（色以外の手掛かり）。各点に <title>（ブラウザのホバー）。値の表は cohorts.csv が持つ。
// パレットは dataviz の参照値（validate_palette.js で light/dark とも検査済み）。
import { fmtInt } from "../lib/dates.mjs";

const W = 960;
const M = { l: 72, r: 28, t: 64, b: 36 };
const PLOT_H = 200;
const GAP = 56;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function niceStep(max, ticks = 4) {
  if (!(max > 0)) return 1;
  const raw = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

const fmtVal = (v, digits) => (digits ? v.toFixed(digits) : fmtInt(v));

function panel({ y0, title, unit, months, get, digits = 0, lang }) {
  const n = months.length;
  const plotW = W - M.l - M.r;
  const x = (i) => M.l + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const rows = months.map((m, i) => ({ m, i, ...get(m) }));
  const maxV = Math.max(...rows.map((r) => r.p90), 1);
  const step = niceStep(maxV);
  const top = Math.ceil(maxV / step) * step;
  const y = (v) => y0 + PLOT_H - (v / top) * PLOT_H;
  const out = [];
  out.push(`<text class="ttl" x="${M.l}" y="${y0 - 22}">${esc(title)}</text>`);
  out.push(`<text class="sub" x="${M.l}" y="${y0 - 6}">${esc(unit)}</text>`);
  for (let v = 0; v <= top + 1e-9; v += step) {
    out.push(`<line class="grid" x1="${M.l}" x2="${W - M.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`);
    out.push(`<text class="tick" x="${M.l - 10}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${fmtVal(v, digits)}</text>`);
  }
  out.push(`<line class="axis" x1="${M.l}" x2="${W - M.r}" y1="${(y0 + PLOT_H).toFixed(1)}" y2="${(y0 + PLOT_H).toFixed(1)}"/>`);
  // x ラベル（3 か月ごと）
  rows.forEach((r) => {
    if (r.i % 3 === 0 || r.i === n - 1) out.push(`<text class="tick" x="${x(r.i).toFixed(1)}" y="${y0 + PLOT_H + 20}" text-anchor="middle">${esc(r.m)}</text>`);
  });
  // 帯
  const upper = rows.map((r) => `${x(r.i).toFixed(1)},${y(r.p90).toFixed(1)}`);
  const lower = rows.slice().reverse().map((r) => `${x(r.i).toFixed(1)},${y(r.p10).toFixed(1)}`);
  out.push(`<polygon class="band" points="${[...upper, ...lower].join(" ")}"/>`);
  // 中央値の線
  out.push(`<polyline class="line" points="${rows.map((r) => `${x(r.i).toFixed(1)},${y(r.median).toFixed(1)}`).join(" ")}"/>`);
  // マーカー（補間は中抜き）＋ホバー
  const tip = (r) => (lang === "ja" ? `${r.m}: 中央値 ${fmtVal(r.median, digits)}（p10 ${fmtVal(r.p10, digits)} 〜 p90 ${fmtVal(r.p90, digits)}）n=${r.n}${r.flag ? `・${r.flag}` : ""}` : `${r.m}: median ${fmtVal(r.median, digits)} (p10 ${fmtVal(r.p10, digits)} - p90 ${fmtVal(r.p90, digits)}), n=${r.n}${r.flag ? `, ${r.flag}` : ""}`);
  for (const r of rows) {
    const cls = r.flag === "interpolated" ? "dot hollow" : "dot";
    out.push(`<g class="pt"><title>${esc(tip(r))}</title><circle class="hit" cx="${x(r.i).toFixed(1)}" cy="${y(r.median).toFixed(1)}" r="12"/><circle class="${cls}" cx="${x(r.i).toFixed(1)}" cy="${y(r.median).toFixed(1)}" r="4"/></g>`);
  }
  // 直接ラベル: 最初・最後・最大（重ならないものだけ）
  const first = rows[0];
  const last = rows[n - 1];
  const maxRow = rows.reduce((a, b) => (b.median > a.median ? b : a), first);
  const labels = [[first, "start"], [last, "end"]];
  if (maxRow !== first && maxRow !== last) labels.push([maxRow, "middle"]);
  for (const [r, anchor] of labels) {
    const tx = anchor === "start" ? x(r.i) + 8 : anchor === "end" ? x(r.i) - 8 : x(r.i);
    out.push(`<text class="lbl" x="${tx.toFixed(1)}" y="${(y(r.median) - 10).toFixed(1)}" text-anchor="${anchor}">${fmtVal(r.median, digits)}</text>`);
  }
  return out.join("\n");
}

export function renderTrendChart(cohorts, { lang = "en", generatedAt = cohorts.generatedAt } = {}) {
  const months = Object.keys(cohorts.months).sort();
  const H = M.t + PLOT_H + M.b + GAP + PLOT_H + M.b + 40;
  const t = lang === "ja"
    ? { title: "npm の DL の床の推移（月別コホート）", s: "S — 公開後 4 日の DL（中央値、帯は p10〜p90）", sUnit: "件／版。練習用・単一版・repository 無しのパッケージ", tt: "T — 公開 15〜30 日目の滴り", tUnit: "件／日（中央値、帯は p10〜p90）", foot: `npm-floor データセット・作成 ${String(generatedAt ?? "").slice(0, 10)}・n=${cohorts.overall?.n ?? "-"}。中抜きの点は前後の月から補間した値。値の表は cohorts.csv。` }
    : { title: "The npm download floor over time (monthly cohorts)", s: "S — downloads in the first 4 days after a publish (median; band = p10 to p90)", sUnit: "downloads per version. Throwaway single-version packages without a repository", tt: "T — daily drip on days 15 to 30 after a publish", tUnit: "downloads per day (median; band = p10 to p90)", foot: `npm-floor dataset, generated ${String(generatedAt ?? "").slice(0, 10)}, n=${cohorts.overall?.n ?? "-"}. Hollow points are interpolated from neighbouring months. Values: cohorts.csv.` };
  const get = (key) => (m) => ({ median: cohorts.months[m][key].median, p10: cohorts.months[m][key].p10, p90: cohorts.months[m][key].p90, n: cohorts.months[m].n, flag: cohorts.months[m].flag ?? null });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t.title)}">
<style>
  :root { color-scheme: light dark; }
  svg { --surface: #fcfcfb; --ink: #0b0b0b; --ink2: #52514e; --muted: #898781; --grid: #e1e0d9; --axis: #c3c2b7; --series: #2a78d6; }
  @media (prefers-color-scheme: dark) { svg { --surface: #1a1a19; --ink: #ffffff; --ink2: #c3c2b7; --muted: #898781; --grid: #2c2c2a; --axis: #383835; --series: #3987e5; } }
  .bg { fill: var(--surface); }
  text { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; fill: var(--ink2); }
  .h1 { font-size: 16px; font-weight: 600; fill: var(--ink); }
  .ttl { font-size: 13px; font-weight: 600; fill: var(--ink); }
  .sub, .foot { font-size: 11px; fill: var(--ink2); }
  .tick { font-size: 11px; fill: var(--muted); font-variant-numeric: tabular-nums; }
  .lbl { font-size: 11px; fill: var(--ink2); }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .axis { stroke: var(--axis); stroke-width: 1; }
  .band { fill: var(--series); fill-opacity: 0.10; }
  .line { fill: none; stroke: var(--series); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .dot { fill: var(--series); stroke: var(--surface); stroke-width: 2; }
  .dot.hollow { fill: var(--surface); stroke: var(--series); stroke-width: 2; }
  .hit { fill: transparent; }
  .pt:hover .dot { r: 5; }
</style>
<rect class="bg" x="0" y="0" width="${W}" height="${H}"/>
<text class="h1" x="${M.l}" y="30">${esc(t.title)}</text>
${panel({ y0: M.t, title: t.s, unit: t.sUnit, months, get: get("S"), digits: 0, lang })}
${panel({ y0: M.t + PLOT_H + M.b + GAP, title: t.tt, unit: t.tUnit, months, get: get("T"), digits: 2, lang })}
<text class="foot" x="${M.l}" y="${H - 14}">${esc(t.foot)}</text>
</svg>
`;
}
