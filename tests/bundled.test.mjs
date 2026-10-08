// 同梱の表（data/cohorts.json）: 読める・月が連続している・名前を含まない・床の式がその表で既知の答えを返す。
// ここが落ちたら、tarball に入る表が壊れているか、表の作り直しで形が変わっている。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCohorts, analyze, resolveWindow, monthsBetween } from "../lib/floor.mjs";
import { runCli } from "../lib/cli.mjs";
import { packument, rangeBody, mockFetch, sink, PKG_DIR, RANGE_RE } from "./helpers.mjs";

const BUNDLED = join(PKG_DIR, "data", "cohorts.json");
const text = readFileSync(BUNDLED, "utf8");
const raw = JSON.parse(text);

test("同梱の表: schema 1・2024-01 から連続・各月の n と印が整合・Σn = overall.n", () => {
  const c = loadCohorts(raw, { source: "bundled" });
  assert.equal(c.schema, 1);
  assert.equal(c.tool, "npm-floor");
  assert.match(String(c.generatedAt), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(c.first, "2024-01");
  assert.ok(c.last >= "2026-07", `last month ${c.last}`);
  // 除外規則の件数と、レジストリ全体が 0 の日の一覧が表に残っている（設計監査 1 巡目 #1・#12）
  assert.deepEqual(Object.keys(raw.method.excluded).sort(), ["dayCluster", "descriptionCluster", "placeholder", "sustainedUse"]);
  assert.ok(raw.method.excluded.placeholder > 0 && raw.method.excluded.sustainedUse > 0, `excluded ${JSON.stringify(raw.method.excluded)}`);
  assert.equal(raw.method.sustainedUseT, 3);
  assert.ok(Array.isArray(raw.method.zeroDays));
  for (const d of raw.method.zeroDays) assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
  // 汚染の無い月の T p90 は 0.26〜1.3 だった（監査の実測）。除外後はすべての月がその範囲に収まる
  for (const m of c.monthKeys) assert.ok(c.months[m].T.p90 < 3, `${m} T p90 ${c.months[m].T.p90} (contamination?)`);
  assert.deepEqual(c.monthKeys, monthsBetween(c.first, c.last), "months are contiguous");
  let sum = 0;
  for (const m of c.monthKeys) {
    const x = c.months[m];
    assert.ok(Number.isInteger(x.n) && x.n >= 0, `${m} n`);
    assert.ok([null, undefined, "thin", "interpolated"].includes(x.flag), `${m} flag ${x.flag}`);
    if (x.flag === "interpolated") {
      assert.ok(x.n < raw.method.thinBelow, `${m} interpolated but n=${x.n}`);
      assert.ok(Array.isArray(x.interpolatedFrom) && x.interpolatedFrom.length >= 1, `${m} interpolatedFrom`);
    } else {
      assert.ok(x.n >= raw.method.thinBelow, `${m} own values but n=${x.n}`);
      if (x.flag === "thin") assert.ok(x.n < raw.method.perMonthTarget, `${m} thin but n=${x.n}`);
      else assert.ok(x.n >= raw.method.perMonthTarget, `${m} no flag but n=${x.n}`);
      assert.ok(x.w30 && x.w30.p10 <= x.w30.median && x.w30.median <= x.w30.p90, `${m} w30 band`);
    }
    sum += x.n;
  }
  assert.equal(sum, raw.overall.n, "sum of monthly n equals overall n");
  assert.ok(raw.overall.n >= 100, `overall n ${raw.overall.n} (a real calibrate run)`);
  assert.ok(raw.overall.S.median > 0 && raw.overall.T.median >= 0);
});

test("同梱の表: パッケージ名を含まない（鍵の集合が固定）", () => {
  assert.deepEqual(Object.keys(raw).sort(), ["generatedAt", "method", "months", "overall", "schema", "tool"]);
  const allowed = new Set(["n", "S", "T", "w30", "peak", "flag", "interpolatedFrom"]);
  for (const [m, x] of Object.entries(raw.months)) for (const k of Object.keys(x)) assert.ok(allowed.has(k), `${m}.${k}`);
  assert.deepEqual(Object.keys(raw.method.candidates).sort(), ["afterPrefilter", "checked", "measured", "searched"]);
  assert.equal(raw.method.candidates.measured, raw.overall.n + raw.method.excluded.sustainedUse + raw.method.excluded.descriptionCluster, "measured = 表の n + 除外（sustained-use・description-cluster）");
});

test("同梱の表で床の式: 表の最終月に 1 版＋その月の 30 日窓 → S(最終月) + T(最終月) × 30", () => {
  const c = loadCohorts(raw, { source: "bundled" });
  const L = c.last;
  const window = resolveWindow({ start: `${L}-01`, end: `${L}-30`, now: Date.parse("2026-09-16T00:00:00Z") });
  const pk = { name: "x", created: "2026-06-20T00:00:00.000Z", versions: [{ version: "1.0.0", time: `${L}-10T12:00:00.000Z`, ms: Date.parse(`${L}-10T12:00:00.000Z`) }] };
  const range = { days: window.days ? Array.from({ length: 30 }, (_, i) => ({ day: `${L}-${String(i + 1).padStart(2, "0")}`, downloads: 3 })) : [] };
  const r = analyze({ packument: pk, range, window, cohorts: c });
  const S = c.months[L].S;
  const T = c.months[L].T;
  assert.equal(r.floor.median, Math.round((S.median + T.median * 30) * 100) / 100);
  assert.equal(r.floor.p90, Math.round((S.p90 + T.p90 * 30) * 100) / 100);
  assert.equal(r.actual, 90);
  assert.equal(r.verdict, r.actual <= r.floor.p90 ? "indistinguishable" : r.actual >= 3 * r.floor.p90 ? "clearly-above" : "above");
  // 表の中の月なので端の月で代用していない（thin / interpolated の印はその月の実態次第で付いてよい）
  assert.ok(r.cohorts.flags.every((f) => f === "thin" || f === "interpolated"), `flags ${r.cohorts.flags}`);
});

test("explain（同梱）: 見出しに bundled と作成日、月の行が表と同じ数", async () => {
  const stdout = sink();
  const stderr = sink();
  const code = await runCli(["explain"], { stdout, stderr, env: {}, locale: () => "en-US", fetchImpl: mockFetch(() => ({ status: 404, body: {} })) });
  assert.equal(code, 0, stderr.text);
  assert.match(stdout.text, /cohort table \(bundled, generated \d{4}-\d{2}-\d{2}\)/);
  const rows = stdout.text.split("\n").filter((l) => /^\d{4}-\d{2}\s/.test(l));
  assert.equal(rows.length, Object.keys(raw.months).length);
  const json = sink();
  await runCli(["explain", "--json"], { stdout: json, stderr: sink(), env: {}, locale: () => "en-US", fetchImpl: mockFetch(() => ({ status: 404, body: {} })) });
  assert.deepEqual(JSON.parse(json.text).months, raw.months);
});

test("計測（同梱の表・偽の API）: 既定の窓で bundled と出て exit 0", async () => {
  const f = mockFetch((url) => {
    if (url === "https://registry.npmjs.org/demo-pkg") return { body: packument({ name: "demo-pkg", versions: { "1.0.0": "2026-08-05T10:00:00.000Z" } }) };
    const m = RANGE_RE.exec(url);
    if (m) return { body: rangeBody(m[3], m[1], m[2], () => 0) }; // 0 件なら必ず「区別できない」
    return { status: 404, body: { error: "not found" } };
  });
  const stdout = sink();
  const code = await runCli(["demo-pkg"], { stdout, stderr: sink(), env: {}, locale: () => "en-US", fetchImpl: f, now: Date.parse("2026-09-16T05:00:00Z") });
  assert.equal(code, 0);
  assert.match(stdout.text, /cohort table\s+bundled, generated \d{4}-\d{2}-\d{2}/);
  assert.match(stdout.text, /verdict\s+INDISTINGUISHABLE FROM THE FLOOR/);
});
