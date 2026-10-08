#!/usr/bin/env node
// 有償の「npm DL 床データセット」を組む。
//   out/calibrate-<date>/{series.json,cohorts.json,meta.json} → dist/npm-floor-dataset/（CSV・JSON・METHOD.md・README.md・SVG）→ dist/npm-floor-dataset.zip
// パッケージ名は入れない（id は公開順の c0001…）。依存ゼロ・ZIP は決定的（同じ入力なら同じバイト列）・sha256 を印字する。
//
//   node scripts/build_dataset.mjs [--src=out/calibrate-2026-09-16] [--dist=dist]
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { buildZip } from "./zip.mjs";
import { renderTrendChart } from "./chart.mjs";
import { PKG_VERSION } from "../lib/api.mjs";
import { loadCohorts } from "../lib/floor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PKG = join(here, "..");
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? d;

function latestCalibrateDir() {
  const outDir = join(PKG, "out");
  if (!existsSync(outDir)) return null;
  const dirs = readdirSync(outDir).filter((d) => /^calibrate-\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return dirs.length ? join(outDir, dirs.at(-1)) : null;
}

const csvCell = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const csv = (rows) => rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const fill = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : `{{${k}}}`));

function main() {
  const src = arg("src", latestCalibrateDir());
  if (!src || !existsSync(join(src, "series.json"))) {
    console.error(`error: calibrate output not found${src ? ` in ${src}` : ""} (run: npm run calibrate -- --out out/calibrate-YYYY-MM-DD)`);
    return 1;
  }
  const dist = arg("dist", join(PKG, "dist"));
  const series = JSON.parse(readFileSync(join(src, "series.json"), "utf8"));
  const cohortsRaw = JSON.parse(readFileSync(join(src, "cohorts.json"), "utf8"));
  const cohorts = loadCohorts(cohortsRaw, { source: "dataset" });
  const meta = existsSync(join(src, "meta.json")) ? JSON.parse(readFileSync(join(src, "meta.json"), "utf8")) : {};

  // 匿名化: 公開順に id を振る。名前・正確な日付は落とし、月と曜日と相対日だけを残す
  const entries = Object.entries(series)
    .map(([name, s]) => ({ name, ...s, createdMs: Date.parse(s.created) }))
    .sort((a, b) => a.createdMs - b.createdMs || (a.name < b.name ? -1 : 1));
  // excluded: 表に入れなかった系列（sustained-use）。研究用途には残す価値があるので落とさず印を付ける（設計監査 1 巡目 #1）
  const anon = entries.map((s, i) => ({ id: `c${String(i + 1).padStart(4, "0")}`, month: s.month, weekday: new Date(s.createdMs).getUTCDay(), start_offset: -1, excluded: s.excluded ?? "", downloads: s.days }));
  const seriesCsv = [["id", "month", "weekday", "day_offset", "downloads", "excluded"]];
  for (const s of anon) s.downloads.forEach((v, k) => seriesCsv.push([s.id, s.month, s.weekday, k + s.start_offset, v, s.excluded]));
  const excludedCount = anon.filter((s) => s.excluded).length;
  const cohortsCsv = [["month", "n", "flag", "S_median", "S_p10", "S_p90", "T_median", "T_p10", "T_p90", "w30_median", "w30_p10", "w30_p90", "peak_median", "peak_day_median", "interpolated_from"]];
  for (const m of cohorts.monthKeys) {
    const x = cohorts.months[m];
    const r = (v, d = 2) => (v == null ? "" : Number(v.toFixed(d)));
    cohortsCsv.push([m, x.n, x.flag ?? "", r(x.S.median, 1), r(x.S.p10, 1), r(x.S.p90, 1), r(x.T.median, 3), r(x.T.p10, 3), r(x.T.p90, 3), x.w30 ? r(x.w30.median, 1) : "", x.w30 ? r(x.w30.p10, 1) : "", x.w30 ? r(x.w30.p90, 1) : "", x.peak ? r(x.peak.median, 1) : "", x.peak ? r(x.peak.day, 1) : "", (x.interpolatedFrom ?? []).join(" ")]);
  }
  const vars = {
    generatedAt: cohortsRaw.generatedAt,
    generatedAtDate: String(cohortsRaw.generatedAt).slice(0, 10),
    version: PKG_VERSION,
    seed: cohortsRaw.method?.seed ?? meta.seed ?? "-",
    first: cohorts.first,
    last: cohorts.last,
    n: cohortsRaw.overall?.n ?? anon.length,
    terms: meta.terms ?? 32,
    pages: meta.pages ?? 12,
    searched: cohortsRaw.method?.candidates?.searched ?? "-",
    afterPrefilter: cohortsRaw.method?.candidates?.afterPrefilter ?? "-",
    checked: cohortsRaw.method?.candidates?.checked ?? "-",
    measured: cohortsRaw.method?.candidates?.measured ?? anon.length,
    perMonth: cohortsRaw.method?.perMonthTarget ?? 30,
    thinBelow: cohortsRaw.method?.thinBelow ?? 5,
    seriesTotal: anon.length,
    seriesExcluded: excludedCount,
    excludedPlaceholder: cohortsRaw.method?.excluded?.placeholder ?? 0,
    excludedSustained: cohortsRaw.method?.excluded?.sustainedUse ?? 0,
    excludedDayCluster: cohortsRaw.method?.excluded?.dayCluster ?? 0,
    excludedDescriptionCluster: cohortsRaw.method?.excluded?.descriptionCluster ?? 0,
    sustainedT: cohortsRaw.method?.sustainedUseT ?? 3,
    maxPerDay: cohortsRaw.method?.maxPerDay ?? 3,
    minDescriptionCluster: cohortsRaw.method?.minDescriptionCluster ?? 3,
    // 月の薄さ（設計監査 2 巡目 #32: ZIP の METHOD にも「全月 thin」を書く）
    monthCount: cohorts.monthKeys.length,
    thinMonths: cohorts.monthKeys.filter((m) => cohorts.months[m].flag === "thin").length,
    nMin: Math.min(...cohorts.monthKeys.map((m) => cohorts.months[m].n)),
    nMax: Math.max(...cohorts.monthKeys.map((m) => cohorts.months[m].n)),
    nMedian: cohorts.monthKeys.map((m) => cohorts.months[m].n).sort((a, b) => a - b)[Math.floor(cohorts.monthKeys.length / 2)],
    placeholderRe: String(cohortsRaw.method?.exclusions?.placeholder ?? "").replace(/^.*matches /, "").replace(/ \(security.*$/, "") || "-",
    zeroDaysCount: cohortsRaw.method?.zeroDays?.length ?? 0,
    zeroDaysList: (cohortsRaw.method?.zeroDays ?? []).join(", ") || "none",
  };
  const files = new Map();
  files.set("README.md", fill(readFileSync(join(PKG, "dataset", "README.template.md"), "utf8"), vars));
  files.set("METHOD.md", fill(readFileSync(join(PKG, "dataset", "METHOD.template.md"), "utf8"), vars));
  files.set("cohorts.json", JSON.stringify(cohortsRaw, null, 2) + "\n");
  files.set("cohorts.csv", csv(cohortsCsv));
  files.set("series.csv", csv(seriesCsv));
  files.set("series.json", JSON.stringify(anon) + "\n");
  files.set("floor-trend.svg", renderTrendChart(cohortsRaw, { lang: "en" }));
  files.set("floor-trend.ja.svg", renderTrendChart(cohortsRaw, { lang: "ja" }));

  const outDir = join(dist, "npm-floor-dataset");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const [rel, text] of files) writeFileSync(join(outDir, rel), text, "utf8");
  const zip = buildZip([...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, data]) => ({ name: `npm-floor-dataset/${name}`, data })));
  const zipPath = join(dist, "npm-floor-dataset.zip");
  writeFileSync(zipPath, zip);
  const total = [...files.values()].reduce((n, t) => n + Buffer.byteLength(t, "utf8"), 0);
  console.log(`dataset: ${outDir.replace(/\\/g, "/")} (${files.size} files, ${total.toLocaleString("en-US")} bytes) -> ${zipPath.replace(/\\/g, "/")} (${zip.length.toLocaleString("en-US")} bytes, sha256 ${sha256(zip)})`);
  console.log(`  source ${src.replace(/\\/g, "/")}: ${anon.length} series, months ${cohorts.first}..${cohorts.last}, overall n=${vars.n}`);
  return 0;
}

process.exitCode = main();
