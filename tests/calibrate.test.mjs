// コホート表の作成: 抽出条件・系列の統計・月ごとの集計と補間・端から端まで（fetch の偽物・一時ディレクトリ）
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { qualify, prefilter, seriesStats, aggregate, shuffle, mulberry32, runCalibrate, isPlaceholder, findZeroDays, defaultToMonth, markDescriptionClusters, expandSeries, TERMS, PAGES, MIN_AGE_DAYS, THIN_BELOW, SUSTAINED_T, MAX_PER_DAY } from "../lib/calibrate.mjs";
import { parsePackument } from "../lib/api.mjs";
import { mockFetch, packument, rangeBody, searchBody, syntheticDays, makeTmp, cleanup, RANGE_RE } from "./helpers.mjs";

const NOW = Date.parse("2026-09-16T05:00:00Z");
const noSleep = async () => {};

test("qualify: 単一版・repository 無し・37 日以上前だけ通る", () => {
  const pk = (o) => parsePackument(packument(o), o.name ?? "p");
  assert.equal(qualify(pk({ versions: { "1.0.0": "2026-07-01T00:00:00Z" } }), { nowMs: NOW }).ok, true);
  assert.equal(qualify(pk({ versions: { "1.0.0": "2026-07-01T00:00:00Z", "1.0.1": "2026-07-02T00:00:00Z" } }), { nowMs: NOW }).why, "versions=2");
  assert.equal(qualify(pk({ versions: { "1.0.0": "2026-07-01T00:00:00Z" }, repository: { url: "x" } }), { nowMs: NOW }).why, "has-repository");
  assert.equal(qualify(pk({ versions: { "1.0.0": "2026-09-01T00:00:00Z" } }), { nowMs: NOW }).why, "age=15d");
  assert.equal(qualify(pk({ versions: { "1.0.0": `2026-08-10T05:00:00Z` } }), { nowMs: NOW }).ok, true, `${MIN_AGE_DAYS} 日ちょうどは通る`);
  assert.equal(qualify(pk({ versions: { "1.0.0": `2026-08-10T05:00:01Z` } }), { nowMs: NOW }).ok, false);
  assert.equal(qualify(pk({ versions: {}, unpublished: true }), { nowMs: NOW }).why, "unpublished");
  assert.equal(qualify(null, { nowMs: NOW }).why, "no-created");
});

test("prefilter: 検索結果の段階で スコープ付き・repository リンクあり・若すぎ・期間外 を落とす", () => {
  const o = { nowMs: NOW, fromMonth: "2026-01", toMonth: "2026-08" };
  assert.deepEqual(prefilter({ name: "@x/y", date: "2026-06-10T00:00:00Z" }, o), { ok: false, why: "scoped" });
  assert.deepEqual(prefilter({ name: "a", hasRepo: true, date: "2026-06-10T00:00:00Z" }, o), { ok: false, why: "has-repository" });
  assert.deepEqual(prefilter({ name: "a", date: "2026-09-01T00:00:00Z" }, o), { ok: false, why: "too-young" });
  assert.deepEqual(prefilter({ name: "a", date: "2025-12-31T00:00:00Z" }, o), { ok: false, why: "out-of-range" });
  assert.deepEqual(prefilter({ name: "a", date: null }, o), { ok: false, why: "no-date" });
  assert.deepEqual(prefilter({ name: "a", date: "2026-06-10T00:00:00Z" }, o), { ok: true, month: "2026-06" });
});

test("除外規則 ①（文面）: プレースホルダ・dependency-confusion・security・reserved・typosquat・版名 -security は落ちる。練習用の自称は通る", () => {
  const pk = (o) => parsePackument(packument(o), o.name ?? "p");
  // 設計監査 1 巡目が同梱の表で見つけた実物の文面（名前は伏せる）
  const bad = [
    { description: "🚫 Placeholder to prevent dependency confusion.", keywords: ["security", "placeholder", "dependency-confusion"] },
    { description: "placeholder package by hackerone.com/thruster" },
    { description: "Security placeholder for @x/cli." },
    { description: "Reserved name placeholder. No functionality.", versions: ["0.0.1-security"] },
    { description: "Placeholder package name reservation for foo." },
    { description: "Utility library for JavaScript (POC typosquat of lodash)" },
    { description: "Fake demo package to simulate dependency confusion" },
    { description: "A package with intentionally invalid syntax, which will cause an error when imported" },
    { description: "dont use this package. its exploration test package" },
    { description: "Test module for dependency confusion - Synack" },
    { name: "foo", description: "The real CLI ships elsewhere", versions: ["0.0.1-placeholder"] },
    { name: "foo-security", description: "" },
  ];
  for (const b of bad) assert.equal(isPlaceholder({ name: "x", keywords: [], versions: ["1.0.0"], ...b }), true, JSON.stringify(b));
  const good = ["my first package", "this is my first npm package", "test package for learning", "hello world npm", "Test package for demonstration purposes.", "Mocks banking API responses for testing purposes.", ""];
  for (const d of good) assert.equal(isPlaceholder({ name: "my-first-pkg", description: d, keywords: ["test"], versions: ["1.0.0"] }), false, d);
  // qualify と prefilter の両方で効く
  assert.equal(qualify(pk({ name: "q", versions: { "1.0.0": "2026-07-01T00:00:00Z" } }), { nowMs: NOW }).ok, true);
  const doc = packument({ name: "q", versions: { "1.0.0": "2026-07-01T00:00:00Z" } });
  doc.description = "🚫 Placeholder to prevent dependency confusion.";
  assert.equal(qualify(parsePackument(doc, "q"), { nowMs: NOW }).why, "placeholder");
  const doc2 = packument({ name: "q", versions: { "0.0.1-security": "2026-07-01T00:00:00Z" } });
  assert.equal(qualify(parsePackument(doc2, "q"), { nowMs: NOW }).why, "placeholder", "版名 -security");
  const o = { nowMs: NOW, fromMonth: "2026-01", toMonth: "2026-08" };
  assert.deepEqual(prefilter({ name: "a", date: "2026-06-10T00:00:00Z", description: "Security placeholder for x" }, o), { ok: false, why: "placeholder" });
  assert.deepEqual(prefilter({ name: "a", date: "2026-06-10T00:00:00Z", description: "my first package" }, o), { ok: true, month: "2026-06" });
});

test("除外規則 ②（データ）と同日クラスター: T ≥ 3 件/日 は表に入れず印を残す。同じ公開日は 3 件まで", async () => {
  const dir = makeTmp("calibex");
  const day = "2026-06-10T00:00:00.000Z";
  const when = { busy: "2026-06-11T00:00:00.000Z", other: "2026-06-12T00:00:00.000Z" };
  const objects = [
    { name: "busy", date: when.busy }, // T = 10 → sustained-use
    { name: "d1", date: day },
    { name: "d2", date: day },
    { name: "d3", date: day },
    { name: "d4", date: day }, // 同日 4 件目 → day-cluster（どの 1 件が落ちるかは乱数種次第）
    { name: "other", date: when.other },
  ];
  const f = mockFetch((url) => {
    if (url.includes("/-/v1/search")) return { body: url.includes("from=0") ? searchBody(objects) : searchBody([]) };
    const m = RANGE_RE.exec(url);
    if (m) return { body: rangeBody(m[3], m[1], m[2], (_, i) => (m[3] === "busy" ? 10 : i === 1 ? 50 : 1)) };
    const name = url.replace("https://registry.npmjs.org/", "");
    return { body: packument({ name, versions: { "1.0.0": when[name] ?? day } }) };
  });
  try {
    const r = await runCalibrate({ outDir: dir, from: "2026-06", to: "2026-06", perMonth: 10, rate: 0, now: NOW, fetchImpl: f, sleepImpl: noSleep, terms: ["t1"], pages: [0], seed: 1 });
    const series = JSON.parse(readFileSync(join(dir, "series.json"), "utf8"));
    const checked = JSON.parse(readFileSync(join(dir, "checked.json"), "utf8"));
    assert.equal(series.busy.excluded, "sustained-use");
    assert.equal(r.cohorts.method.excluded.sustainedUse, 1);
    assert.equal(r.cohorts.method.excluded.dayCluster, 1);
    assert.equal(r.cohorts.method.maxPerDay, MAX_PER_DAY);
    const cluster = Object.entries(checked).filter(([, c]) => c.why === "day-cluster").map(([n]) => n);
    assert.equal(cluster.length, 1);
    assert.equal(r.months["2026-06"], 4, "同日 3 件 + other 1 件（busy は数えない）");
    assert.equal(r.cohorts.months["2026-06"].n, 4);
    assert.equal(r.cohorts.overall.n, 4);
    assert.ok(!f.calls.some((u) => u.includes(`/range/`) && u.endsWith(`/${cluster[0]}`)), "クラスターで落とした候補の系列は取らない");
  } finally {
    cleanup(dir);
  }
});

test("除外規則 ③′（同一文面のクラスター。2 巡目 #27）: 同じ月・同じ description が 3 件以上で半数以上が sustained-use なら残りも表に入れない。独立した人の同じ文面は触らない", () => {
  const mk = (created, T, description) => ({ created, description, days: syntheticDays(created, 47, (i) => (i >= 0 && i <= 3 ? 20 : i >= 15 && i <= 30 ? T : 0)) });
  const series = {
    // 連番名の一括公開: 3 件中 2 件が sustained-use → 残り 1 件（T 2.5）も description-cluster
    a1: { ...mk("2026-02-19T00:00:00Z", 4, "Data Handler"), excluded: "sustained-use" },
    a2: mk("2026-02-24T00:00:00Z", 5, " data  handler "), // 印は無いが T ≥ 3。文面は空白・大小を正規化して同じ
    a3: mk("2026-02-25T00:00:00Z", 2.5, "Data Handler"),
    // 独立した練習用: 3 件とも T < 3 → 触らない
    b1: mk("2026-02-01T00:00:00Z", 0.2, "test package"),
    b2: mk("2026-02-02T00:00:00Z", 0.3, "test package"),
    b3: mk("2026-02-03T00:00:00Z", 0.1, "test package"),
    // 半数未満（3 件中 1 件）→ 触らない
    c1: { ...mk("2026-02-05T00:00:00Z", 4, "CLI Helper"), excluded: "sustained-use" },
    c2: mk("2026-02-06T00:00:00Z", 0.2, "CLI Helper"),
    c3: mk("2026-02-07T00:00:00Z", 0.3, "CLI Helper"),
    // 月が違えば別のクラスター。description が空なら対象外
    d1: mk("2026-03-01T00:00:00Z", 2.5, "Data Handler"),
    e1: { ...mk("2026-02-10T00:00:00Z", 4, ""), excluded: "sustained-use" },
    e2: mk("2026-02-11T00:00:00Z", 0.2, ""),
    e3: mk("2026-02-12T00:00:00Z", 0.2, ""),
  };
  const marked = markDescriptionClusters(series);
  assert.deepEqual(marked, ["a3"]);
  assert.equal(series.a3.excluded, "description-cluster");
  assert.equal(series.a2.excluded, undefined, "T ≥ 3 の系列は aggregate が sustained-use に数える（印は付けない）");
  assert.equal(series.c2.excluded, undefined);
  assert.equal(series.d1.excluded, undefined);
  const c = aggregate(series, { from: "2026-02", to: "2026-03", perMonth: 30 });
  assert.equal(c.method.excluded.descriptionCluster, 1);
  assert.equal(c.method.excluded.sustainedUse, 4, "a1・a2・c1・e1");
  assert.equal(c.months["2026-02"].n, 7, "b1〜b3・c2・c3・e2・e3");
  assert.equal(c.overall.n, 8);
  // series.json の形（description を持つ）→ expandSeries が持ち越す
  const raw = { x: { created: "2026-02-19T00:00:00Z", month: "2026-02", start: "2026-02-18", end: "2026-04-05", description: "Data Handler", days: [0, 1, 2] } };
  assert.equal(expandSeries(raw).x.description, "Data Handler");
});

test("findZeroDays / seriesStats の zeroDays: 被覆 10 以上で合計 0 の暦日を見つけ、分母から外す（合計は残りの日の平均 × 日数）", () => {
  const created = "2026-06-10T00:00:00.000Z";
  const series = {};
  for (let k = 0; k < 12; k++) series[`p${k}`] = { created, days: syntheticDays(created, 47, (i) => (i === 2 || i === 20 ? 0 : i <= 3 ? 4 : 1)) };
  const zero = findZeroDays(series);
  assert.deepEqual(zero, ["2026-06-12", "2026-06-30"]);
  assert.deepEqual(findZeroDays({ a: series.p0, b: series.p1 }), [], "被覆が足りない日は判定しない");
  const st = seriesStats(series.p0.days, created, { zeroDays: new Set(zero) });
  assert.equal(st.S, 16, "day 2 が 0 の日 → 残り 3 日の 12 を 4 日分に伸ばす");
  assert.equal(st.T, 1, "day 20 を分母から外す");
  assert.ok(Math.abs(st.w30 - (37 * 30) / 28) < 1e-9);
  assert.equal(st.zeroDaysSkipped, 2);
  const plain = seriesStats(series.p0.days, created);
  assert.equal(plain.S, 12);
  assert.ok(Math.abs(plain.T - 15 / 16) < 1e-9);
  const c = aggregate(series, { from: "2026-06", to: "2026-06", perMonth: 30, zeroDays: zero });
  assert.deepEqual(c.method.zeroDays, zero);
  assert.equal(c.months["2026-06"].S.median, 16);
});

test("defaultToMonth: 末日が 37 日以上前である最後の月（実行日が 16 日なら先々月、月末近くなら先月）", () => {
  assert.equal(defaultToMonth(Date.parse("2026-09-18T00:00:00Z")), "2026-07", "09-18 − 37 日 = 08-12 → 08 は途中 → 07");
  assert.equal(defaultToMonth(Date.parse("2026-10-07T00:00:00Z")), "2026-08", "10-07 − 37 日 = 08-31（月末）→ 08");
  assert.equal(defaultToMonth(Date.parse("2026-10-08T00:00:00Z")), "2026-08", "10-08 − 37 日 = 09-01 → 09 は途中 → 08");
  assert.equal(defaultToMonth(Date.parse("2026-01-10T00:00:00Z")), "2025-11");
});

test("seriesStats: S は day 0..3 の合計、T は day 15..30 の平均、ピークは day 0..29 の最大。短い系列は null", () => {
  const created = "2026-06-10T13:00:00.000Z";
  const days = syntheticDays(created, 47, (i) => (i === 0 ? 10 : i === 1 ? 20 : i === 2 ? 5 : i === 3 ? 1 : i >= 15 && i <= 30 ? 2 : 0));
  const st = seriesStats(days, created);
  assert.equal(st.S, 36);
  assert.equal(st.T, 2);
  assert.equal(st.w30, 36 + 2 * 15);
  assert.equal(st.peak, 20);
  assert.equal(st.peakDay, 1);
  assert.equal(st.days, 47);
  const short = seriesStats(syntheticDays(created, 10, () => 1), created);
  assert.equal(short.S, 4);
  assert.equal(short.T, null);
  assert.equal(short.w30, null);
});

test("aggregate: 月ごとの中央値/p10/p90。n < 5 の月は前後から線形補間して印、n < 目標なら thin", () => {
  const mk = (created, S, T) => ({ created, days: syntheticDays(created, 47, (i) => (i >= 0 && i <= 3 ? S / 4 : i >= 15 && i <= 30 ? T : 0)) });
  const series = {};
  for (let k = 0; k < 6; k++) series[`may${k}`] = mk(`2026-05-${String(2 + k).padStart(2, "0")}T00:00:00Z`, 40 + 4 * k, 0.2);
  for (let k = 0; k < 6; k++) series[`jul${k}`] = mk(`2026-07-${String(2 + k).padStart(2, "0")}T00:00:00Z`, 80 + 4 * k, 0.6);
  series.jun0 = mk("2026-06-10T00:00:00Z", 999, 2); // 1 件だけ → 補間される（値は使われない）
  series.tooShort = { created: "2026-07-20T00:00:00Z", days: syntheticDays("2026-07-20T00:00:00Z", 8, () => 1) }; // T が無い → 数えない
  series.busy = mk("2026-07-09T00:00:00Z", 80, 9); // T = 9 ≥ 3 → sustained-use として表に入れない
  series.marked = { ...mk("2026-07-10T00:00:00Z", 80, 0.5), excluded: "sustained-use" }; // calibrate が印を付けたもの → 同じく入れない
  const c = aggregate(series, { from: "2026-04", to: "2026-08", perMonth: 30, generatedAt: "2026-09-16T00:00:00Z", excluded: { placeholder: 4, dayCluster: 1 } });
  assert.deepEqual(c.method.excluded, { placeholder: 4, dayCluster: 1, sustainedUse: 2, descriptionCluster: 0 });
  assert.equal(c.method.sustainedUseT, SUSTAINED_T);
  assert.equal(c.months["2026-07"].n, 6, "busy と marked は数えない");
  assert.equal(c.schema, 1);
  assert.deepEqual(Object.keys(c.months), ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]);
  assert.equal(c.months["2026-05"].n, 6);
  assert.equal(c.months["2026-05"].flag, "thin");
  assert.equal(c.months["2026-05"].S.median, 50);
  assert.equal(c.months["2026-07"].S.median, 90);
  assert.ok(Math.abs(c.months["2026-07"].T.median - 0.6) < 1e-9);
  const jun = c.months["2026-06"];
  assert.equal(jun.flag, "interpolated");
  assert.equal(jun.n, 1);
  assert.deepEqual(jun.interpolatedFrom, ["2026-05", "2026-07"]);
  assert.equal(jun.S.median, 70);
  assert.ok(Math.abs(jun.T.median - 0.4) < 1e-9);
  assert.equal(c.months["2026-04"].flag, "interpolated");
  assert.equal(c.months["2026-04"].S.median, 50, "端は隣の月を写す");
  assert.deepEqual(c.months["2026-04"].interpolatedFrom, ["2026-05"]);
  assert.equal(c.months["2026-08"].S.median, 90);
  assert.equal(c.overall.n, 13);
  assert.equal(c.method.thinBelow, THIN_BELOW);
  // どの月も 5 件に届かなければ、1 件でもある月を thin として使う（短い試し実行で落ちない）
  const tiny = aggregate({ a: mk("2026-07-02T00:00:00Z", 40, 0.2), b: mk("2026-07-03T00:00:00Z", 60, 0.4) }, { perMonth: 30 });
  assert.equal(tiny.months["2026-07"].flag, "thin");
  assert.equal(tiny.months["2026-07"].S.median, 50);
  assert.throws(() => aggregate({}), /no usable series/);
});

test("shuffle: 同じ種なら同じ順、違う種なら違う順。元の配列は変えない", () => {
  const a = Array.from({ length: 20 }, (_, i) => `p${i}`);
  const s1 = shuffle(a, 20260916);
  const s2 = shuffle(a, 20260916);
  assert.deepEqual(s1, s2);
  assert.notDeepEqual(s1, a);
  assert.notDeepEqual(shuffle(a, 1), s1);
  assert.deepEqual([...s1].sort(), [...a].sort());
  const r = mulberry32(7);
  const x = r();
  assert.ok(x >= 0 && x < 1);
  assert.equal(mulberry32(7)(), x);
  assert.equal(TERMS.length, 32);
  assert.equal(PAGES.length, 12);
});

test("runCalibrate: 検索 → 前処理 → 照合 → 日次 → 集計。途中経過を書き、再実行は続きから（照合 0 件）", async () => {
  const dir = makeTmp("calib");
  const created = { a: "2026-06-10T00:00:00.000Z", e: "2026-06-15T00:00:00.000Z", f: "2026-06-16T00:00:00.000Z", g: "2026-06-17T00:00:00.000Z", h: "2026-06-18T00:00:00.000Z", c: "2026-06-12T00:00:00.000Z" };
  const objects = [
    { name: "a", date: created.a },
    { name: "b", date: "2026-06-11T00:00:00.000Z", repo: "https://github.com/x/b" }, // 前処理で落ちる
    { name: "c", date: created.c }, // packument で 2 版 → 落ちる
    { name: "@x/d", date: "2026-06-13T00:00:00.000Z" }, // スコープ付き
    { name: "e", date: created.e },
    { name: "f", date: created.f },
    { name: "g", date: created.g },
    { name: "h", date: created.h },
    { name: "young", date: "2026-09-10T00:00:00.000Z" },
    { name: "gone", date: "2026-06-20T00:00:00.000Z" }, // packument 404
  ];
  const f = mockFetch((url) => {
    if (url.includes("/-/v1/search")) return { body: url.includes("from=0") ? searchBody(objects) : searchBody([]) };
    const m = RANGE_RE.exec(url);
    if (m) return { body: rangeBody(m[3], m[1], m[2], (_, i) => (i === 1 ? 50 : i >= 2 && i <= 4 ? 5 : 1)) }; // day −1 が i=0 → day0 が 50
    const name = url.replace("https://registry.npmjs.org/", "");
    if (name === "gone") return { status: 404, body: { error: "Not found" } };
    if (name === "c") return { body: packument({ name, versions: { "1.0.0": created.c, "1.0.1": "2026-06-13T00:00:00.000Z" } }) };
    return { body: packument({ name, versions: { "1.0.0": created[name] } }) };
  });
  const logs = [];
  // 目標 6 件に対して通るのは 5 件 → 候補を使い切って終わる（done）。全候補が照合される
  const r = await runCalibrate({ outDir: dir, from: "2026-06", to: "2026-06", perMonth: 6, rate: 0, now: NOW, fetchImpl: f, sleepImpl: noSleep, log: (m) => logs.push(m), terms: ["t1"], pages: [0] });
  try {
    assert.equal(r.done, true);
    assert.deepEqual(r.months, { "2026-06": 5 });
    assert.equal(r.cohorts.months["2026-06"].n, 5);
    assert.equal(r.cohorts.months["2026-06"].S.median, 50 + 5 + 5 + 5, "S = day 0..3");
    assert.equal(r.cohorts.months["2026-06"].T.median, 1);
    assert.equal(r.cohorts.months["2026-06"].flag, "thin", "5 件 < 目標 6 件");
    assert.equal(r.cohorts.method.candidates.searched, 10);
    for (const fn of ["meta.json", "search.json", "checked.json", "series.json", "cohorts.json"]) assert.ok(existsSync(join(dir, fn)), fn);
    const checked = JSON.parse(readFileSync(join(dir, "checked.json"), "utf8"));
    assert.equal(checked.c.why, "versions=2");
    assert.equal(checked.gone.why, "404");
    assert.equal(checked.b, undefined, "前処理で落ちたものは照合しない");
    assert.equal(checked["@x/d"], undefined);
    const series = JSON.parse(readFileSync(join(dir, "series.json"), "utf8"));
    assert.deepEqual(Object.keys(series).sort(), ["a", "e", "f", "g", "h"]);
    assert.equal(series.a.start, "2026-06-09");
    assert.equal(series.a.end, "2026-07-25");
    assert.equal(series.a.days.length, 47);
    assert.ok(f.calls.some((u) => u.includes("/range/2026-06-09:2026-07-25/a")));
    assert.ok(!f.calls.some((u) => u.includes("registry.npmjs.org/young")), "若すぎる候補は引かない");
    const n1 = f.calls.length;
    const r2 = await runCalibrate({ outDir: dir, from: "2026-06", to: "2026-06", perMonth: 6, rate: 0, now: NOW, fetchImpl: f, sleepImpl: noSleep, terms: ["t1"], pages: [0] });
    assert.equal(r2.checks, 0, "続きから: 検索も照合もしない");
    assert.equal(f.calls.length, n1);
    assert.ok(logs.some((l) => /after prefilter/.test(l)));
  } finally {
    cleanup(dir);
  }
});

test("runCalibrate: ネットワーク断は途中経過を保存してから止まる。--out 無しは Error", async () => {
  const dir = makeTmp("calibdown");
  try {
    await assert.rejects(runCalibrate({ outDir: dir, from: "2026-06", to: "2026-06", rate: 0, now: NOW, fetchImpl: mockFetch(() => { throw Object.assign(new TypeError("fetch failed"), { cause: new Error("ECONNREFUSED") }); }), sleepImpl: noSleep, terms: ["t1"], pages: [0] }), (e) => e.kind === "network");
    assert.ok(existsSync(join(dir, "meta.json")));
    await assert.rejects(runCalibrate({}), /--out/);
    await assert.rejects(runCalibrate({ outDir: dir, from: "2026-09", to: "2026-08", now: NOW }), /after --to/);
  } finally {
    cleanup(dir);
  }
});
