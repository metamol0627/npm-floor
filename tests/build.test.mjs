// 有償データセットの組み立て（build_dataset.mjs）と ZIP・グラフ: 合成の calibrate 出力から組み、匿名化と中身を確かめる
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { aggregate } from "../lib/calibrate.mjs";
import { buildZip, readZip, crc32 } from "../scripts/zip.mjs";
import { renderTrendChart } from "../scripts/chart.mjs";
import { makeTmp, cleanup, PKG_DIR, syntheticDays } from "./helpers.mjs";
import { ymd, DAY } from "../lib/dates.mjs";

function fakeCalibrate(dir) {
  const series = {};
  const months = ["2026-04", "2026-05", "2026-06", "2026-07"];
  let idx = 0;
  for (const mo of months) {
    const n = mo === "2026-05" ? 1 : 6; // 05 は補間される
    for (let i = 0; i < n; i++) {
      const created = `${mo}-${String(3 + i).padStart(2, "0")}T10:00:00.000Z`;
      const days = syntheticDays(created, 47, (d) => (d === 0 ? 40 + i * 5 : d === 1 ? 20 : d >= 2 && d <= 3 ? 5 : d >= 15 && d <= 30 ? 1 : 0));
      series[`secret-name-${idx++}`] = { created, month: mo, start: days[0].day, end: days.at(-1).day, days: days.map((d) => d.downloads) };
    }
  }
  // 除外した系列（T = 9 ≥ 3）を 1 件足す: 表には入らず、ZIP の series.* には印つきで残る
  const busy = "2026-07-20T10:00:00.000Z";
  const busyDays = syntheticDays(busy, 47, (d) => (d === 0 ? 40 : d >= 15 && d <= 30 ? 9 : 0));
  series[`secret-name-${idx++}`] = { created: busy, month: "2026-07", start: busyDays[0].day, end: busyDays.at(-1).day, days: busyDays.map((d) => d.downloads), excluded: "sustained-use" };
  const forAgg = Object.fromEntries(Object.entries(series).map(([n, s]) => [n, { created: s.created, excluded: s.excluded ?? null, days: s.days.map((v, i) => ({ day: ymd(Date.parse(s.start) + i * DAY), downloads: v })) }]));
  const cohorts = aggregate(forAgg, { from: "2026-04", to: "2026-07", perMonth: 30, generatedAt: "2026-09-16T12:00:00.000Z", excluded: { placeholder: 4, dayCluster: 0 } });
  cohorts.method.seed = 7;
  cohorts.method.candidates = { searched: 100, afterPrefilter: 50, checked: 40, measured: Object.keys(series).length };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "series.json"), JSON.stringify(series));
  writeFileSync(join(dir, "cohorts.json"), JSON.stringify(cohorts, null, 1));
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ seed: 7, terms: 32, pages: 12 }));
  return { series, cohorts };
}

test("zip: 書いて読める。CRC と長さが一致。決定的（同じ入力なら同じバイト列）", () => {
  const entries = [{ name: "a/x.txt", data: "hello" }, { name: "b.bin", data: Buffer.alloc(3000, 7) }];
  const z1 = buildZip(entries);
  const z2 = buildZip(entries);
  assert.ok(z1.equals(z2));
  const back = readZip(z1);
  assert.deepEqual(back.map((e) => e.name), ["a/x.txt", "b.bin"]);
  assert.equal(back[0].data.toString(), "hello");
  assert.equal(back[1].data.length, 3000);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926, "CRC-32 の既知の答え");
  assert.throws(() => readZip(Buffer.from("not a zip")), /central directory/);
});

test("chart: SVG に 2 面・帯・線・点・ホバーの title・補間の中抜き・直接ラベルがあり、文字は文字用の色", () => {
  const dir = makeTmp("chart");
  try {
    const { cohorts } = fakeCalibrate(dir);
    const svg = renderTrendChart(cohorts, { lang: "en" });
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="960"/);
    assert.equal((svg.match(/class="band"/g) ?? []).length, 2, "S と T の 2 面");
    assert.equal((svg.match(/class="line"/g) ?? []).length, 2);
    assert.equal((svg.match(/<title>/g) ?? []).length, 8, "4 か月 × 2 面のホバー");
    assert.equal((svg.match(/class="dot hollow"/g) ?? []).length, 2, "補間した 2026-05 は中抜き（2 面）");
    assert.match(svg, /2026-05: median [\d.]+ \(p10 [\d.]+ - p90 [\d.]+\), n=1, interpolated/);
    assert.match(svg, /class="lbl"/, "直接ラベル");
    assert.ok(!/fill: var\(--series\)[^}]*}\s*\.ttl/.test(svg));
    assert.match(svg, /prefers-color-scheme: dark/);
    const ja = renderTrendChart(cohorts, { lang: "ja" });
    assert.match(ja, /床の推移/);
  } finally {
    cleanup(dir);
  }
});

test("build_dataset: 合成の calibrate 出力から ZIP を組む。パッケージ名は入らず、id は公開順、プレースホルダは残らない", () => {
  const dir = makeTmp("build");
  try {
    const src = join(dir, "calibrate-2026-09-16");
    const { series } = fakeCalibrate(src);
    const dist = join(dir, "dist");
    const r = spawnSync(process.execPath, [join(PKG_DIR, "scripts", "build_dataset.mjs"), `--src=${src}`, `--dist=${dist}`], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /npm-floor-dataset\.zip \([\d,]+ bytes, sha256 [0-9a-f]{64}\)/);
    const zipPath = join(dist, "npm-floor-dataset.zip");
    assert.ok(existsSync(zipPath));
    const entries = readZip(readFileSync(zipPath));
    assert.deepEqual(entries.map((e) => e.name).sort(), ["METHOD.md", "README.md", "cohorts.csv", "cohorts.json", "floor-trend.ja.svg", "floor-trend.svg", "series.csv", "series.json"].map((n) => `npm-floor-dataset/${n}`).sort());
    const text = Object.fromEntries(entries.map((e) => [e.name.replace("npm-floor-dataset/", ""), e.data.toString("utf8")]));
    for (const name of Object.keys(series)) for (const f of Object.values(text)) assert.ok(!f.includes(name), `名前 ${name} が入っている`);
    assert.ok(!/\{\{\w+\}\}/.test(text["METHOD.md"]), "METHOD.md にプレースホルダが残っている");
    assert.ok(!/\{\{\w+\}\}/.test(text["README.md"]));
    assert.match(text["METHOD.md"], /Generated \*\*2026-09-16T12:00:00\.000Z\*\* by `npm-floor \d+\.\d+\.\d+ calibrate` \(random seed 7\)/);
    assert.match(text["METHOD.md"], /\*\*19\*\* packages measured/);
    const csvLines = text["series.csv"].trim().split("\n");
    assert.equal(csvLines[0], "id,month,weekday,day_offset,downloads,excluded");
    assert.equal(csvLines.length, 1 + 20 * 47);
    assert.equal(csvLines[1], "c0001,2026-04,5,-1,0,", "最初の行: id は公開順・曜日は UTC・day −1 は 0・除外なし");
    assert.equal(csvLines[2], "c0001,2026-04,5,0,40,");
    assert.ok(csvLines.some((l) => /^c\d{4},2026-07,\d,-1,0,sustained-use$/.test(l)), "除外した系列は印つきで残る");
    const sj = JSON.parse(text["series.json"]);
    assert.equal(sj.length, 20);
    assert.deepEqual(Object.keys(sj[0]), ["id", "month", "weekday", "start_offset", "excluded", "downloads"]);
    assert.equal(sj.filter((s) => s.excluded === "sustained-use").length, 1);
    assert.match(text["METHOD.md"], /\*\*1\*\* were then excluded by rules ② and ③′, leaving \*\*19\*\* in the table/);
    assert.match(text["METHOD.md"], /dropped \*\*4\*\* candidates/);
    assert.match(text["METHOD.md"], /\*\*0\*\* measured packages were excluded \(marked `excluded = description-cluster`/);
    assert.match(text["METHOD.md"], /In this build 3 of the 4 months are `thin`/, "月の薄さが ZIP の METHOD に出る（2 巡目 #32）");
    assert.ok(!/\{\{\w+\}\}/.test(text["METHOD.md"]), "埋め残しのプレースホルダが無い");
    const cc = text["cohorts.csv"].trim().split("\n");
    assert.equal(cc[0].split(",")[0], "month");
    assert.equal(cc.length, 5);
    assert.match(cc[2], /^2026-05,1,interpolated,/);
    assert.match(text["floor-trend.svg"], /<svg /);
    const built = JSON.parse(text["cohorts.json"]);
    assert.equal(built.schema, 1);
    // 決定的: もう一度組んでも同じバイト列
    const first = readFileSync(zipPath);
    spawnSync(process.execPath, [join(PKG_DIR, "scripts", "build_dataset.mjs"), `--src=${src}`, `--dist=${dist}`], { encoding: "utf8" });
    assert.ok(readFileSync(zipPath).equals(first));
    // 無い src は読める文で 1
    const bad = spawnSync(process.execPath, [join(PKG_DIR, "scripts", "build_dataset.mjs"), `--src=${join(dir, "nope")}`, `--dist=${dist}`], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /^error: calibrate output not found/);
  } finally {
    cleanup(dir);
  }
});
