// 床の式・判定の 3 段・窓の境界・コホート表の検査（純関数。既知の答えとの照合）
import test from "node:test";
import assert from "node:assert/strict";
import { quantile, band, resolveWindow, loadCohorts, cohortFor, versionsInWindow, computeFloor, judge, analyze, zeroRange, sumDownloads, monthsBetween, DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS } from "../lib/floor.mjs";
import { parseYmd, parseMonth, monthIndex, monthFromIndex, dayDiff } from "../lib/dates.mjs";
import { sampleCohorts, rangeBody } from "./helpers.mjs";

const NOW = Date.parse("2026-09-16T05:00:00Z");
const cohorts = () => loadCohorts(sampleCohorts(), { source: "test" });

test("quantile: 線形補間（R type 7）。空なら null", () => {
  assert.equal(quantile([4, 1, 3, 2], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3, 4], 0.1), 1.3);
  assert.equal(quantile([1, 2, 3, 4], 0.9), 3.7);
  assert.equal(quantile([7], 0.9), 7);
  assert.equal(quantile([], 0.5), null);
  assert.deepEqual(band([1, 2, 3, 4]), { median: 2.5, p10: 1.3, p90: 3.7 });
});

test("dates: 暦日・月の検査と通し番号", () => {
  assert.equal(parseYmd("2026-09-16"), Date.parse("2026-09-16T00:00:00Z"));
  assert.throws(() => parseYmd("2026-02-30"), /calendar/);
  assert.throws(() => parseYmd("2026/09/16"), /YYYY-MM-DD/);
  assert.throws(() => parseYmd(""), /YYYY-MM-DD/);
  assert.equal(parseMonth("2026-09"), "2026-09");
  assert.throws(() => parseMonth("2026-13"), /YYYY-MM/);
  assert.equal(monthFromIndex(monthIndex("2026-01") - 1), "2025-12");
  assert.equal(dayDiff("2026-08-31", "2026-09-01"), 1);
});

test("resolveWindow: 既定は今日(UTC)−2 日を末日とする 30 日。--window は日数、--start/--end で固定窓", () => {
  const d = resolveWindow({ now: NOW });
  assert.deepEqual([d.start, d.end, d.days, d.recent], ["2026-08-16", "2026-09-14", DEFAULT_WINDOW_DAYS, false]);
  assert.equal(d.endMs, Date.parse("2026-09-14T23:59:59.999Z"));
  const e = resolveWindow({ end: "2026-09-15", now: NOW });
  assert.deepEqual([e.start, e.end, e.recent], ["2026-08-17", "2026-09-15", true]);
  const s = resolveWindow({ start: "2026-08-01", days: 29, now: NOW });
  assert.deepEqual([s.start, s.end, s.days], ["2026-08-01", "2026-08-29", 29]);
  const both = resolveWindow({ start: "2026-08-01", end: "2026-08-29", now: NOW });
  assert.equal(both.days, 29);
  assert.equal(resolveWindow({ start: "2026-08-01", end: "2026-08-01", now: NOW }).days, 1);
  assert.equal(resolveWindow({ start: "2026-08-01", end: "2026-08-29", days: 29, now: NOW }).days, 29);
  // 今日を末日にできる（recent の注記が付く）。今日より後は未来
  assert.equal(resolveWindow({ end: "2026-09-16", now: NOW }).recent, true);
});

test("resolveWindow: 壊れた入力（未来・逆順・日数 0／541・不一致・日付でない）は読める文で throw", () => {
  assert.throws(() => resolveWindow({ end: "2026-09-17", now: NOW }), /future/);
  assert.throws(() => resolveWindow({ start: "2026-09-10", days: 30, now: NOW }), /future/);
  assert.throws(() => resolveWindow({ start: "2026-09-02", end: "2026-09-01", now: NOW }), /before start/);
  assert.throws(() => resolveWindow({ days: 0, now: NOW }), /--window/);
  assert.throws(() => resolveWindow({ days: MAX_WINDOW_DAYS + 1, now: NOW }), /--window/);
  assert.throws(() => resolveWindow({ days: "abc", now: NOW }), /--window/);
  assert.throws(() => resolveWindow({ start: "2026-08-01", end: "2026-08-29", days: 30, now: NOW }), /does not match/);
  assert.throws(() => resolveWindow({ end: "yesterday", now: NOW }), /YYYY-MM-DD/);
});

test("loadCohorts: 正しい表は月が昇順で first/last を持つ。壊れた表は理由つきで throw", () => {
  const c = cohorts();
  assert.deepEqual(c.monthKeys, ["2026-06", "2026-07", "2026-08"]);
  assert.equal(c.first, "2026-06");
  assert.equal(c.last, "2026-08");
  assert.throws(() => loadCohorts(null), /not an object/);
  assert.throws(() => loadCohorts([]), /not an object/);
  assert.throws(() => loadCohorts({ schema: 2, months: {} }), /schema 2/);
  assert.throws(() => loadCohorts({ schema: 1 }), /no `months`/);
  assert.throws(() => loadCohorts({ schema: 1, months: {} }), /no months/);
  assert.throws(() => loadCohorts({ schema: 1, months: { "2026-06": { S: { median: 1 }, T: { median: 1, p10: 0, p90: 2 } } } }), /lacks S\/T/);
  assert.throws(() => loadCohorts({ schema: 1, months: { "2026-06": { S: { median: 5, p10: 6, p90: 7 }, T: { median: 1, p10: 0, p90: 2 } } } }), /not ordered/);
  assert.throws(() => loadCohorts({ schema: 1, months: { "2026-06": { S: { median: 5, p10: -1, p90: 7 }, T: { median: 1, p10: 0, p90: 2 } } } }), /negative/);
  assert.throws(() => loadCohorts({ schema: 1, months: { "jun": { S: { median: 5, p10: 1, p90: 7 }, T: { median: 1, p10: 0, p90: 2 } } } }), /bad month key/);
});

test("cohortFor: 表の中はそのまま、前は最初の月、後は最後の月で代用して印を付ける。代用した月自身の印も消えない", () => {
  const c = cohorts();
  assert.deepEqual([cohortFor(c, "2026-07").month, cohortFor(c, "2026-07").flags], ["2026-07", []]);
  assert.deepEqual([cohortFor(c, "2026-08").month, cohortFor(c, "2026-08").flags], ["2026-08", ["interpolated"]]);
  assert.deepEqual([cohortFor(c, "2025-12").month, cohortFor(c, "2025-12").flags], ["2026-06", ["before-table"]]);
  assert.deepEqual([cohortFor(c, "2026-11").month, cohortFor(c, "2026-11").flags], ["2026-08", ["interpolated", "after-table"]], "表の後 → 最後の月（補間）の印と after-table の両方（中 #3）");
  assert.equal(cohortFor(c, "2026-07-15T00:00:00Z").month, "2026-07", "日付を渡しても月に丸める");
  // 表に穴があれば読める文で拒否（低 #14）
  const holed = sampleCohorts();
  delete holed.months["2026-07"];
  assert.throws(() => loadCohorts(holed), /not contiguous \(missing 2026-07\)/);
});

test("versionsInWindow: 境界は両端を含む（始日 00:00:00Z・末日 23:59:59.999Z）", () => {
  const w = resolveWindow({ start: "2026-07-01", end: "2026-07-30", now: NOW });
  const v = (t) => ({ version: t, time: t, ms: Date.parse(t) });
  const list = [v("2026-06-30T23:59:59.999Z"), v("2026-07-01T00:00:00.000Z"), v("2026-07-30T23:59:59.999Z"), v("2026-07-31T00:00:00.000Z")];
  assert.deepEqual(versionsInWindow(list, w).map((x) => x.version), ["2026-07-01T00:00:00.000Z", "2026-07-30T23:59:59.999Z"]);
});

test("床の式: Σ S(版の月) + T(窓の末日の月) × 日数。既知の表・既知の版 → 既知の床", () => {
  const c = cohorts();
  const w = resolveWindow({ start: "2026-06-01", end: "2026-07-30", now: NOW }); // 60 日。末日の月 2026-07 → T 0.4/0.1/0.8
  const versions = [
    { version: "1.0.0", time: "2026-06-05T10:00:00.000Z", ms: Date.parse("2026-06-05T10:00:00.000Z") }, // S(2026-06) 50/25/100
    { version: "1.1.0", time: "2026-07-10T10:00:00.000Z", ms: Date.parse("2026-07-10T10:00:00.000Z") }, // S(2026-07) 60/30/120
  ];
  const f = computeFloor({ cohorts: c, versions, window: w });
  assert.deepEqual(f.initial, { median: 110, p10: 55, p90: 220 });
  assert.equal(f.drip.cohortMonth, "2026-07");
  assert.deepEqual(f.drip.total, { median: 24, p10: 6, p90: 48 });
  assert.deepEqual(f.floor, { median: 134, p10: 61, p90: 268 });
  assert.deepEqual(f.flags, []);
  assert.equal(f.perVersion[0].cohortMonth, "2026-06");
  // 版が無ければ滴りだけ
  const g = computeFloor({ cohorts: c, versions: [], window: resolveWindow({ start: "2026-07-01", days: 30, now: NOW }) });
  assert.deepEqual(g.floor, { median: 12, p10: 3, p90: 24 });
  assert.deepEqual(f.cohortsUsed, [{ month: "2026-06", n: 30, flag: null }, { month: "2026-07", n: 30, flag: null }]);
});

test("滴りの月（2 巡目 #26）: 窓内に版があれば最後の版の月、無ければ窓の末日の月", () => {
  const c = cohorts();
  const v = (t) => ({ version: t, time: t, ms: Date.parse(t) });
  // 6 月 25 日公開・30 日窓は 7 月に終わるが、滴りは版の月 2026-06（T 0.3）から取る
  const w = resolveWindow({ start: "2026-06-25", days: 30, now: NOW });
  const f = computeFloor({ cohorts: c, versions: [v("2026-06-25T10:00:00.000Z")], window: w, created: "2026-06-25T10:00:00.000Z" });
  assert.equal(f.drip.cohortMonth, "2026-06");
  assert.equal(f.drip.month, "2026-06");
  assert.deepEqual(f.floor, { median: 50 + 0.3 * 30, p10: 25 + 0.1 * 30, p90: 100 + 0.6 * 30 });
  // 版が 2 つなら最後の版の月
  const f2 = computeFloor({ cohorts: c, versions: [v("2026-06-25T10:00:00.000Z"), v("2026-07-02T10:00:00.000Z")], window: w, created: "2026-06-25T10:00:00.000Z" });
  assert.equal(f2.drip.cohortMonth, "2026-07");
  // 版が無ければ窓の末日の月
  assert.equal(computeFloor({ cohorts: c, versions: [], window: w }).drip.cohortMonth, "2026-07");
});

test("存在期間で切る（2 巡目 #28）: 作られる前の日に滴りを付けない。末日近くの版は S を按分する", () => {
  const c = cohorts();
  const v = (t) => ({ version: t, time: t, ms: Date.parse(t) });
  const w = resolveWindow({ start: "2026-07-01", end: "2026-07-30", now: NOW });
  // 窓の最終日に作られて 1 版: 滴り 1 日分、S は day 0 の割合（0.86）
  const f = computeFloor({ cohorts: c, versions: [v("2026-07-30T08:00:00.000Z")], window: w, created: "2026-07-30T08:00:00.000Z" });
  assert.equal(f.drip.days, 1);
  assert.equal(f.drip.daysBeforeCreated, 29);
  assert.equal(f.perVersion[0].share, 0.86);
  assert.equal(f.perVersion[0].daysToWindowEnd, 1);
  assert.ok(Math.abs(f.floor.median - (60 * 0.86 + 0.4)) < 1e-9);
  // 末日の 3 日前の版 → 0.97。4 日前なら按分しない
  assert.equal(computeFloor({ cohorts: c, versions: [v("2026-07-28T00:00:00.000Z")], window: w }).perVersion[0].share, 0.97);
  assert.equal(computeFloor({ cohorts: c, versions: [v("2026-07-27T23:59:59.000Z")], window: w }).perVersion[0].share, 1);
  // 窓より前に作られていれば全日。窓の後に作られていれば 0 日
  assert.equal(computeFloor({ cohorts: c, versions: [], window: w, created: "2026-05-01T00:00:00.000Z" }).drip.days, 30);
  assert.equal(computeFloor({ cohorts: c, versions: [], window: w, created: "2026-08-01T00:00:00.000Z" }).drip.days, 0);
  // analyze の注記
  const pk = { name: "late", created: "2026-07-29T00:00:00.000Z", versions: [v("2026-07-29T00:00:00.000Z")] };
  const r = analyze({ packument: pk, range: { days: rangeBody("late", w.start, w.end, () => 0).downloads, missing: 0 }, window: w, cohorts: c });
  assert.ok(r.notes.includes("created-in-window"));
  assert.ok(r.notes.includes("version-near-window-end"));
  assert.ok(!r.notes.includes("window-before-created"));
  assert.equal(r.drip.days, 2);
  assert.equal(r.versions[0].share, 0.93);
});

test("判定の 3 段: 実測 ≤ 床 p90 → 区別できない／それ以上 → 超える／実測 ≥ 3 × 床 p90 → 明確に上。窓内 20 版で pumping", () => {
  const floor = { median: 134, p10: 61, p90: 268 };
  const j = (actual, n = 2) => judge({ actual, floor, versionsInWindow: n });
  assert.equal(j(0).verdict, "indistinguishable");
  assert.equal(j(0).excess, -134);
  assert.equal(j(268).verdict, "indistinguishable", "p90 ちょうどは区別できない");
  assert.equal(j(269).verdict, "above");
  assert.equal(j(803).verdict, "above");
  assert.equal(j(804).verdict, "clearly-above", "3 × p90 ちょうどで明確に上");
  assert.equal(j(804).clearAt, 804);
  assert.equal(j(268).threshold, 134);
  assert.equal(j(100, 19).pumping, false);
  assert.equal(j(100, 20).pumping, true);
  // 床が 0 の表（あり得ないが）でも実測 > 0 なら明確に上、実測 0 なら区別できない
  assert.equal(judge({ actual: 5, floor: { median: 0, p10: 0, p90: 0 }, versionsInWindow: 0 }).verdict, "clearly-above");
  assert.equal(judge({ actual: 0, floor: { median: 0, p10: 0, p90: 0 }, versionsInWindow: 0 }).verdict, "indistinguishable");
});

test("analyze: 材料から結果を組み、注記（直近・公開前・欠損・表の外・DL 記録なし・pumping）を付ける", () => {
  const c = cohorts();
  const pk = { name: "demo-pkg", created: "2026-07-10T00:00:00.000Z", unpublished: false, versions: [{ version: "1.0.0", time: "2026-07-10T00:00:00.000Z", ms: Date.parse("2026-07-10T00:00:00.000Z") }] };
  const w = resolveWindow({ start: "2026-07-01", end: "2026-07-30", now: NOW });
  const range = rangeBody("demo-pkg", w.start, w.end, (d) => (d === "2026-07-10" ? 40 : d === "2026-07-11" ? 20 : 1));
  const r = analyze({ packument: pk, range: { ...range, days: range.downloads, missing: 0 }, window: w, cohorts: c });
  assert.equal(r.actual, 40 + 20 + 28);
  // 07-10 に作られたので滴りは 07-10〜07-30 の 21 日分（2 巡目 #28）: 60 + 0.4 × 21
  assert.deepEqual(r.floor, { median: 68.4, p10: 32.1, p90: 136.8 });
  assert.equal(r.drip.days, 21);
  assert.equal(r.drip.daysBeforeCreated, 9);
  assert.equal(r.verdict, "indistinguishable");
  assert.equal(r.versionsInWindow, 1);
  assert.deepEqual(r.notes, ["created-in-window", "like-cohort"], "単一版・repo 無し・README 無し → コホートと同じ条件。窓の途中で作られた注記");
  assert.equal(r.excess, 19.6);
  assert.equal(r.registryZeroDays, null);
  assert.deepEqual(r.cohorts.used, [{ month: "2026-07", n: 30, flag: null }]);
  // repository か README か複数版 → 床は下限の注記
  assert.ok(analyze({ packument: { ...pk, repository: { url: "x" } }, range: { ...range, days: range.downloads, missing: 0 }, window: w, cohorts: c }).notes.includes("floor-is-lower-bound"));
  assert.ok(analyze({ packument: { ...pk, hasReadme: true }, range: { ...range, days: range.downloads, missing: 0 }, window: w, cohorts: c }).notes.includes("floor-is-lower-bound"));
  // 公開前の窓・欠損・表の外・直近
  const w2 = resolveWindow({ start: "2026-05-01", end: "2026-05-30", now: NOW });
  const r2 = analyze({ packument: pk, range: { days: rangeBody("demo-pkg", w2.start, w2.end, () => 0).downloads, missing: 3 }, window: w2, cohorts: c });
  assert.ok(r2.notes.includes("window-before-created"));
  assert.ok(r2.notes.includes("series-incomplete"));
  assert.ok(r2.notes.includes("cohort-extrapolated"));
  const w3 = resolveWindow({ end: "2026-09-16", days: 5, now: NOW });
  const r3 = analyze({ packument: pk, range: zeroRange(w3), window: w3, cohorts: c });
  assert.ok(r3.notes.includes("window-recent"));
  assert.ok(r3.notes.includes("no-download-records"));
  assert.ok(r3.notes.includes("cohort-extrapolated"), "2026-09 は表の後");
  assert.ok(r3.notes.includes("cohort-thin"), "代用した 2026-08 は補間の月なので thin の注記も出る（中 #3）");
  assert.deepEqual(r3.drip.flags, ["interpolated", "after-table"]);
  assert.equal(r3.actual, 0);
  // レジストリ全体が 0 の日: 対象 0 かつ参照 0 の日だけ数え、滴りの日数から引く
  const ref = { name: "npm", days: rangeBody("npm", w.start, w.end, (d) => (d === "2026-07-20" || d === "2026-07-21" ? 0 : 5)).downloads };
  const zeroTarget = rangeBody("demo-pkg", w.start, w.end, (d) => (d === "2026-07-20" || d === "2026-07-25" ? 0 : 1)).downloads;
  const r5 = analyze({ packument: pk, range: { days: zeroTarget, missing: 0 }, window: w, cohorts: c, reference: ref });
  assert.deepEqual(r5.registryZeroDays, { count: 1, days: ["2026-07-20"], reference: "npm" });
  assert.ok(r5.notes.includes("registry-zero-days"));
  assert.equal(r5.drip.days, 20, "存在した 21 日からレジストリ 0 の 1 日を引く");
  assert.equal(r5.drip.total.median, 8);
  assert.equal(r5.floor.median, 68);
  // 作られる前の日にレジストリ 0 があっても、存在した日数からは引かない
  const ref2 = { name: "npm", days: rangeBody("npm", w.start, w.end, (d) => (d === "2026-07-03" ? 0 : 5)).downloads };
  const zeroTarget2 = rangeBody("demo-pkg", w.start, w.end, (d) => (d < "2026-07-10" ? 0 : 1)).downloads;
  const r6 = analyze({ packument: pk, range: { days: zeroTarget2, missing: 0 }, window: w, cohorts: c, reference: ref2 });
  assert.equal(r6.registryZeroDays.count, 1);
  assert.equal(r6.drip.days, 21);
  assert.equal(zeroRange(w3).days.length, 5);
  // pumping: 窓内に 20 版
  const many = Array.from({ length: 20 }, (_, i) => ({ version: `0.0.${i}`, time: `2026-07-${String(2 + i).padStart(2, "0")}T00:00:00.000Z`, ms: Date.parse(`2026-07-${String(2 + i).padStart(2, "0")}T00:00:00.000Z`) }));
  const r4 = analyze({ packument: { ...pk, versions: many }, range: { days: range.downloads, missing: 0 }, window: w, cohorts: c });
  assert.equal(r4.pumpingSuspected, true);
  assert.ok(r4.notes.includes("pumping"));
  assert.equal(r4.initial.median, 20 * 60);
  assert.equal(r4.versions.length, 20);
  assert.equal(sumDownloads([{ downloads: 1 }, { downloads: "2" }, {}]), 3);
  assert.deepEqual(monthsBetween("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
});
