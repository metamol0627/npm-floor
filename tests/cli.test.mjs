// CLI: 壊れた入力で読める文・exit 1（スタックトレース無し）。正常系は fetch の偽物で。bin は子プロセスでも叩く
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runCli, parseArgs, pickLang } from "../lib/cli.mjs";
import { mockFetch, networkDown, packument, rangeBody, searchBody, sink, makeTmp, cleanup, PKG_DIR, SAMPLE_COHORTS, RANGE_RE } from "./helpers.mjs";

const BIN = join(PKG_DIR, "bin", "npm-floor.mjs");
const NOW = Date.parse("2026-09-16T05:00:00Z");
const noSleep = async () => {};

// locale は固定（OS のロケールに依らず英語）。ロケール経由の日本語は pickLang のテストで見る
async function cli(argv, { fetchImpl = mockFetch(() => ({ status: 404, body: { error: "not found" } })), env = {}, now = NOW, locale = () => "en-US" } = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await runCli(argv, { stdout, stderr, env, fetchImpl, now, sleepImpl: noSleep, locale });
  return { code, out: stdout.text, err: stderr.text };
}

// demo-pkg: 2 版（6/5・7/10）。DL は 7/10 に 40、7/11 に 20、他は 1
const demoFetch = (overrides = {}) =>
  mockFetch((url) => {
    if (overrides.all) return overrides.all(url);
    if (url === "https://registry.npmjs.org/demo-pkg") return overrides.packument ?? { body: packument({ name: "demo-pkg", versions: { "1.0.0": "2026-06-05T10:00:00.000Z", "1.1.0": "2026-07-10T10:00:00.000Z" } }) };
    const m = RANGE_RE.exec(url);
    if (m) return overrides.range ?? { body: rangeBody(m[3], m[1], m[2], (d) => (d === "2026-07-10" ? 40 : d === "2026-07-11" ? 20 : 1)) };
    return { status: 404, body: { error: "not found" } };
  });
const SAMPLE = ["--cohorts", SAMPLE_COHORTS];

test("parseArgs / pickLang: --key value と --key=value、フラグ、-- 以降は名前。壊れた形は Error", () => {
  assert.deepEqual(parseArgs(["pkg", "--window", "7", "--json", "--end=2026-09-01"]), { positional: ["pkg"], opts: { window: "7", json: true, end: "2026-09-01" } });
  assert.deepEqual(parseArgs(["--", "--weird"]).positional, ["--weird"]);
  assert.deepEqual(parseArgs(["--per-month", "10"]).opts, { perMonth: "10" });
  assert.throws(() => parseArgs(["--bogus"]), /unknown option --bogus/);
  assert.throws(() => parseArgs(["--window"]), /needs a value/);
  assert.throws(() => parseArgs(["--window", "--json"]), /needs a value/);
  assert.throws(() => parseArgs(["--json=1"]), /takes no value/);
  assert.throws(() => parseArgs(["-x"]), /unknown option -x/);
  assert.equal(pickLang(undefined, { LANG: "ja_JP.UTF-8" }), "ja");
  assert.equal(pickLang(undefined, { NPM_FLOOR_LANG: "en", LANG: "ja_JP" }), "en");
  assert.equal(pickLang("ja", {}), "ja");
  assert.equal(pickLang(undefined, {}, () => "en-US"), "en");
  assert.equal(pickLang(undefined, {}, () => "ja-JP"), "ja", "環境変数が無ければ OS のロケール（Windows）");
  assert.equal(pickLang(undefined, { LANG: "C" }, () => "ja-JP"), "en", "環境変数が優先");
  assert.equal(pickLang(undefined, {}, () => undefined), "en");
  assert.throws(() => pickLang("xx", {}), /--lang/);
});

test("--help は 0、引数なしは usage を stderr に出して 1、--version は版", async () => {
  const h = await cli(["--help"]);
  assert.equal(h.code, 0);
  assert.match(h.out, /^usage:/);
  const none = await cli([]);
  assert.equal(none.code, 1);
  assert.match(none.err, /^usage:/);
  const v = await cli(["--version"]);
  assert.equal(v.code, 0);
  assert.match(v.out, /^\d+\.\d+\.\d+\n$/);
});

test("壊れた引数は error 1 行＋usage で exit 1、スタックトレース無し", async () => {
  for (const argv of [["pkg", "--bogus"], ["pkg", "--window"], ["pkg", "--lang", "xx"], ["--json=1"]]) {
    const r = await cli(argv);
    assert.equal(r.code, 1, argv.join(" "));
    assert.match(r.err, /^error: /, argv.join(" "));
    assert.ok(!/\n\s+at .*\.mjs:\d+/.test(r.err), `stack trace: ${r.err}`);
  }
  for (const argv of [["pkg", "--window", "0", ...SAMPLE], ["pkg", "--window", "9999", ...SAMPLE], ["pkg", "--end", "2027-01-01", ...SAMPLE], ["pkg", "--end", "2026-02-30", ...SAMPLE], ["pkg", "--start", "2026-09-01", "--end", "2026-08-01", ...SAMPLE], ["a", "b", ...SAMPLE], ["explain", "pkg", ...SAMPLE], ["calibrate", "pkg"], ["calibrate"], ["calibrate", "--out", "x", "--rate", "9"], ["calibrate", "--out", "x", "--per-month", "0"], ["", ...SAMPLE], ["a/b/c", ...SAMPLE]]) {
    const r = await cli(argv, { fetchImpl: demoFetch() });
    assert.equal(r.code, 1, argv.join(" "));
    assert.match(r.err, /^error: [^\n]+\n/, argv.join(" "));
    assert.ok(!/\n\s+at .*\.mjs:\d+/.test(r.err), `stack trace: ${r.err}`);
  }
  assert.match((await cli(["pkg", "--end", "2027-01-01", ...SAMPLE])).err, /future/);
  assert.match((await cli(["a/b/c", ...SAMPLE])).err, /not a valid npm package name/);
});

test("計測: 既知の packument・既知の DL → 表示と --json（英・日）", async () => {
  const r = await cli(["demo-pkg", "--start", "2026-07-01", "--end", "2026-07-30", ...SAMPLE], { fetchImpl: demoFetch() });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /npm-floor \d+\.\d+\.\d+  demo-pkg/);
  assert.match(r.out, /window +2026-07-01 \.\. 2026-07-30  \(30 days, UTC\)/);
  assert.match(r.out, /downloads \(actual\) +88\b/);
  assert.match(r.out, /floor \(mirrors \+ scanners\) +72   p10\.\.p90  33 \.\. 144/);
  assert.match(r.out, /excess over the floor +16\b/);
  assert.match(r.out, /versions published in window +1   \(2 versions in total\)/);
  assert.match(r.out, /verdict +INDISTINGUISHABLE FROM THE FLOOR   actual <= floor p90 \(144\)/);
  assert.match(r.out, /1\.1\.0  2026-07-10  S\(2026-07\) = 60  \[30 \.\. 120\]/);
  assert.match(r.out, /0\.40 \/day x 30 days = 12/);
  assert.match(r.out, /not a count of real users/);
  const j = await cli(["demo-pkg", "--start", "2026-07-01", "--end", "2026-07-30", "--json", ...SAMPLE], { fetchImpl: demoFetch() });
  const o = JSON.parse(j.out);
  assert.equal(o.actual, 88);
  assert.deepEqual(o.floor, { median: 72, p10: 33, p90: 144 });
  assert.equal(o.verdict, "indistinguishable");
  assert.equal(o.versionsInWindow, 1);
  assert.deepEqual(o.notes, ["floor-is-lower-bound"], "2 版あるので「床は下限」の注記");
  assert.equal(o.registryZeroDays, null, "0 の日が無いので参照パッケージは引かない");
  assert.match(r.out, /has a repository, a README or more than one version/);
  const ja = await cli(["demo-pkg", "--start", "2026-07-01", "--end", "2026-07-30", "--lang", "ja", ...SAMPLE], { fetchImpl: demoFetch() });
  assert.match(ja.out, /実測 DL +88/);
  assert.match(ja.out, /判定 +床と区別できない/);
  assert.match(ja.out, /本当の利用者数ではありません/);
  // --lang ja の列: 全角を幅 2 で数えるので、値の右端が英語と同じ列に揃う（低 #10）
  const col = (text, re) => text.split("\n").find((l) => re.test(l));
  const width = (s) => [...s].reduce((w, ch) => w + (/[　-鿿＀-｠]/.test(ch) ? 2 : 1), 0);
  assert.equal(width(col(ja.out, /^実測 DL/).replace(/\s+$/, "")), width(col(r.out, /^downloads \(actual\)/).replace(/\s+$/, "")));
  const upto = (l) => l.slice(0, l.indexOf("   p10"));
  assert.equal(width(upto(col(ja.out, /^床（ミラー＋スキャナ）/))), width(upto(col(r.out, /^floor \(mirrors/))));
  assert.equal(width(upto(col(r.out, /^floor \(mirrors/))), 44);
  // 既定の窓（今日−2 日まで 30 日）。版は窓の外、DL 30 → 床 15/3/30 → 区別できない。表の後の月なので注記
  const d = await cli(["demo-pkg", ...SAMPLE], { fetchImpl: demoFetch() });
  assert.match(d.out, /2026-08-16 \.\. 2026-09-14/);
  assert.match(d.out, /INDISTINGUISHABLE/);
  assert.match(d.out, /nearest month's values were used/);
  // 環境変数 NPM_FLOOR_COHORTS
  const e = await cli(["demo-pkg", "--start", "2026-07-01", "--end", "2026-07-30"], { fetchImpl: demoFetch(), env: { NPM_FLOOR_COHORTS: SAMPLE_COHORTS } });
  assert.equal(e.code, 0, e.err);
});

test("判定の表示: 床を超える／明確に床の上／pumping の疑い", async () => {
  const big = demoFetch({ range: { body: rangeBody("demo-pkg", "2026-07-01", "2026-07-30", () => 10) } }); // 300 → 144 < 300 < 432
  const r1 = await cli(["demo-pkg", "--start", "2026-07-01", "--end", "2026-07-30", ...SAMPLE], { fetchImpl: big });
  assert.match(r1.out, /ABOVE THE FLOOR   actual > floor p90 \(144\) but < 3 x p90 \(432\)/);
  const huge = demoFetch({ range: { body: rangeBody("demo-pkg", "2026-07-01", "2026-07-30", () => 1000) } });
  const r2 = await cli(["demo-pkg", "--start", "2026-07-01", "--end", "2026-07-30", ...SAMPLE], { fetchImpl: huge });
  assert.match(r2.out, /CLEARLY ABOVE THE FLOOR   actual >= 3 x floor p90 \(432\)/);
  const versions = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`0.0.${i}`, `2026-07-${String(2 + i).padStart(2, "0")}T00:00:00.000Z`]));
  const pump = demoFetch({ packument: { body: packument({ name: "demo-pkg", versions }) } });
  const r3 = await cli(["demo-pkg", "--start", "2026-07-01", "--end", "2026-07-30", ...SAMPLE], { fetchImpl: pump });
  assert.match(r3.out, /versions published in window +25/);
  assert.match(r3.out, /version pumping suspected: 25 versions/);
  assert.match(r3.out, /\.\.\. and 15 more/);
  const j = JSON.parse((await cli(["demo-pkg", "--start", "2026-07-01", "--end", "2026-07-30", "--json", ...SAMPLE], { fetchImpl: pump })).out);
  assert.equal(j.pumpingSuspected, true);
  assert.equal(j.initial.median, 25 * 60);
});

test("レジストリ全体が 0 の日: 対象も参照（npm）も 0 の日を注記し、滴りを残りの日数に掛ける。参照が引けなければ注記なし", async () => {
  // demo-pkg: 7/05 と 7/06 が 0。参照 npm: 7/05 だけ 0（7/06 は対象だけ 0 → レジストリの欠落ではない）
  const withRef = (refHandler) =>
    mockFetch((url) => {
      if (url === "https://registry.npmjs.org/demo-pkg") return { body: packument({ name: "demo-pkg", versions: { "1.0.0": "2026-06-05T10:00:00.000Z" } }) };
      const m = RANGE_RE.exec(url);
      if (m && m[3] === "demo-pkg") return { body: rangeBody("demo-pkg", m[1], m[2], (d) => (d === "2026-07-05" || d === "2026-07-06" ? 0 : 2)) };
      if (m && m[3] === "npm") return refHandler(m);
      return { status: 404, body: { error: "not found" } };
    });
  const f = withRef((m) => ({ body: rangeBody("npm", m[1], m[2], (d) => (d === "2026-07-05" ? 0 : 100000)) }));
  const r = await cli(["demo-pkg", "--start", "2026-07-01", "--end", "2026-07-30", "--json", ...SAMPLE], { fetchImpl: f });
  assert.equal(r.code, 0, r.err);
  const o = JSON.parse(r.out);
  assert.deepEqual(o.registryZeroDays, { count: 1, days: ["2026-07-05"], reference: "npm" });
  assert.ok(o.notes.includes("registry-zero-days"));
  assert.ok(o.notes.includes("like-cohort"), "単一版・repo 無し・README 無し");
  assert.equal(o.drip.days, 29, "滴りは 30 − 1 日");
  assert.equal(o.drip.total.median, 11.6);
  assert.equal(o.actual, 56);
  assert.ok(f.calls.some((u) => /\/range\/2026-07-01:2026-07-30\/npm$/.test(u)), "参照は窓と同じ範囲を 1 回");
  const text = await cli(["demo-pkg", "--start", "2026-07-01", "--end", "2026-07-30", ...SAMPLE], { fetchImpl: f });
  assert.match(text.out, /0 for the whole registry on 1 day\(s\) in this window \(2026-07-05; checked against npm\)/);
  assert.match(text.out, /0\.40 \/day x 29 days/);
  assert.match(text.out, /the same conditions as the cohort/);
  // 実測が床の中央値より下 → 負の超過に「(below the floor median)」
  const low = await cli(["demo-pkg", "--start", "2026-07-01", "--end", "2026-07-30", ...SAMPLE], { fetchImpl: demoFetch({ range: { body: rangeBody("demo-pkg", "2026-07-01", "2026-07-30", () => 1) } }) });
  assert.match(low.out, /excess over the floor +-42   \(below the floor median\)/);
  const lowJa = await cli(["demo-pkg", "--start", "2026-07-01", "--end", "2026-07-30", "--lang", "ja", ...SAMPLE], { fetchImpl: demoFetch({ range: { body: rangeBody("demo-pkg", "2026-07-01", "2026-07-30", () => 1) } }) });
  assert.match(lowJa.out, /（床の中央値より下）/);
  // 参照が 404 → 検知しない（注記なし・null）
  const g = withRef(() => ({ status: 404, body: { error: "not found" } }));
  const o2 = JSON.parse((await cli(["demo-pkg", "--start", "2026-07-01", "--end", "2026-07-30", "--json", ...SAMPLE], { fetchImpl: g })).out);
  assert.equal(o2.registryZeroDays, null);
  assert.ok(!o2.notes.includes("registry-zero-days"));
  assert.equal(o2.drip.days, 30);
  // --cohorts にディレクトリ → 人向けの文
  const dir = await cli(["demo-pkg", "--cohorts", PKG_DIR], { fetchImpl: demoFetch() });
  assert.equal(dir.code, 1);
  assert.match(dir.err, /that is a directory, not a file/);
});

test("壊れた入力 6 種: 存在しない／版が無い／ネットワーク断／429 が続く／5xx／未来の窓 → 読める文で exit 1。DL 記録なしは 0 扱いで exit 0", async () => {
  const notFound = await cli(["no-such-pkg", ...SAMPLE], { fetchImpl: mockFetch(() => ({ status: 404, body: { error: "Not found" } })) });
  assert.equal(notFound.code, 1);
  assert.equal(notFound.err, "error: package not found on npm: no-such-pkg\n");
  const noVersions = await cli(["demo-pkg", ...SAMPLE], { fetchImpl: demoFetch({ packument: { body: packument({ name: "demo-pkg", versions: {}, unpublished: true }) } }) });
  assert.equal(noVersions.code, 1);
  assert.match(noVersions.err, /has no published versions on npm \(it was unpublished\)/);
  const down = await cli(["demo-pkg", ...SAMPLE], { fetchImpl: mockFetch(networkDown) });
  assert.equal(down.code, 1);
  assert.match(down.err, /^error: could not reach npm's API \(.*ENOTFOUND.*\)\. Check the network connection/);
  const limited = await cli(["demo-pkg", ...SAMPLE], { fetchImpl: mockFetch(() => ({ status: 429 })) });
  assert.equal(limited.code, 1);
  assert.match(limited.err, /rate-limiting this client \(HTTP 429\)/);
  const server = await cli(["demo-pkg", ...SAMPLE], { fetchImpl: mockFetch(() => ({ status: 503 })) });
  assert.equal(server.code, 1);
  assert.match(server.err, /server error \(HTTP 503\)/);
  const bad = await cli(["demo-pkg", ...SAMPLE], { fetchImpl: demoFetch({ range: { status: 400, body: { error: "end date > start date" } } }) });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /rejected the request: end date > start date/);
  const future = await cli(["demo-pkg", "--end", "2027-01-01", ...SAMPLE], { fetchImpl: demoFetch() });
  assert.equal(future.code, 1);
  assert.match(future.err, /ends in the future \(2027-01-01/);
  const ja = await cli(["no-such-pkg", "--lang", "ja", ...SAMPLE]);
  assert.equal(ja.err, "エラー: npm にそのパッケージはありません: no-such-pkg\n");
  // packument はあるのに範囲 API が 404（公開直後）→ 全日 0・注記・exit 0
  const fresh = await cli(["demo-pkg", ...SAMPLE], { fetchImpl: demoFetch({ range: { status: 404, body: { error: "package demo-pkg not found" } } }) });
  assert.equal(fresh.code, 0, fresh.err);
  assert.match(fresh.out, /downloads \(actual\) +0\b/);
  assert.match(fresh.out, /no download records for this package yet/);
  for (const r of [notFound, noVersions, down, limited, server, bad, future]) assert.ok(!/\n\s+at .*\.mjs:\d+/.test(r.err), `stack trace: ${r.err}`);
});

test("コホート表が無い・JSON でない・形が違うときは読める文で exit 1", async () => {
  const dir = makeTmp("cohorts");
  try {
    const missing = await cli(["demo-pkg", "--cohorts", join(dir, "nope.json")], { fetchImpl: demoFetch() });
    assert.equal(missing.code, 1);
    assert.match(missing.err, /cohort table could not be read \(.*nope\.json\): file not found/);
    writeFileSync(join(dir, "bad.json"), "{ not json");
    const bad = await cli(["demo-pkg", "--cohorts", join(dir, "bad.json")], { fetchImpl: demoFetch() });
    assert.match(bad.err, /not JSON/);
    writeFileSync(join(dir, "wrong.json"), JSON.stringify({ schema: 1, months: {} }));
    const wrong = await cli(["explain", "--cohorts", join(dir, "wrong.json")]);
    assert.equal(wrong.code, 1);
    assert.match(wrong.err, /no months/);
  } finally {
    cleanup(dir);
  }
});

test("explain: 表と式を出す。--json は表そのもの", async () => {
  const r = await cli(["explain", ...SAMPLE]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /cohort table/);
  assert.match(r.out, /2026-07   30 +60 +30 +120 +0\.40 +0\.10 +0\.80 +75/);
  assert.match(r.out, /2026-08 +4 .* interp/);
  assert.match(r.out, /floor\(window\) = sum over versions/);
  const j = JSON.parse((await cli(["explain", "--json", ...SAMPLE])).out);
  assert.equal(j.schema, 1);
  assert.equal(j.months["2026-07"].S.median, 60);
  const ja = await cli(["explain", "--lang", "ja", ...SAMPLE]);
  assert.match(ja.out, /コホート表/);
});

test("calibrate（CLI）: 偽の API で小さな表を作り cohorts.json を書く。--out 無しは exit 1", async () => {
  const dir = makeTmp("clicalib");
  try {
    const f = mockFetch((url) => {
      if (url.includes("/-/v1/search")) return { body: url.includes("from=0") ? searchBody([{ name: "a", date: "2026-06-10T00:00:00.000Z" }, { name: "b", date: "2026-06-11T00:00:00.000Z" }]) : searchBody([]) };
      const m = RANGE_RE.exec(url);
      if (m) return { body: rangeBody(m[3], m[1], m[2], () => 2) };
      const name = url.replace("https://registry.npmjs.org/", "");
      return { body: packument({ name, versions: { "1.0.0": name === "a" ? "2026-06-10T00:00:00.000Z" : "2026-06-11T00:00:00.000Z" } }) };
    });
    // 本物の 32 語 × 12 段を偽の API で回す（空の応答で即終わる）
    const r = await cli(["calibrate", "--out", dir, "--from", "2026-06", "--to", "2026-06", "--per-month", "2", "--rate", "5", "--quiet"], { fetchImpl: f });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /months: 2026-06 2/);
    assert.match(r.out, /calibrate: finished/);
    assert.ok(existsSync(join(dir, "cohorts.json")));
    const use = await cli(["demo-pkg", "--start", "2026-07-01", "--end", "2026-07-30", "--cohorts", join(dir, "cohorts.json")], { fetchImpl: demoFetch() });
    assert.equal(use.code, 0, use.err);
    assert.match(use.out, /S\(2026-06\) = 8/, "S = 2 × 4 日");
  } finally {
    cleanup(dir);
  }
  const none = await cli(["calibrate"]);
  assert.equal(none.code, 1);
  assert.match(none.err, /--out/);
});

test("bin: 子プロセスで --version が出る。Node の版の門は文言だけ確認", () => {
  const r = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\d+\.\d+\.\d+\r?\n$/);
  const u = spawnSync(process.execPath, [BIN], { encoding: "utf8" });
  assert.equal(u.status, 1);
  assert.match(u.stderr, /^usage:/);
});
