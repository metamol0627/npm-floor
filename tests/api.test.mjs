// API 応答の解析（固定の JSON）・名前の検査・再試行と失敗の種類（fetch の偽物）
import test from "node:test";
import assert from "node:assert/strict";
import { validateName, encodeName, parsePackument, parseRange, parseSearch, fetchJson, getDailyRange, getPackument, RateLimiter, ApiError, USER_AGENT, RANGE_MAX_DAYS } from "../lib/api.mjs";
import { mockFetch, networkDown, packument, rangeBody, RANGE_RE } from "./helpers.mjs";

const noSleep = async () => {};

test("validateName: スコープ付き・大文字は通る。空・空白・二重スラッシュ・先頭の . _・長すぎは invalid", () => {
  for (const ok of ["left-pad", "@types/node", "UpperCase", "a.b_c~d", "@scope/x.y"]) assert.equal(validateName(ok), ok);
  assert.equal(validateName("  chalk "), "chalk");
  for (const bad of ["", "   ", "a/b/c", ".hidden", "_x", "@scope", "@scope/", "has space", "a".repeat(215), "@/x", "x<y"]) {
    assert.throws(() => validateName(bad), (e) => e instanceof ApiError && e.kind === "invalid", JSON.stringify(bad));
  }
  assert.equal(encodeName("@types/node"), "@types/node");
  assert.equal(encodeName("left-pad"), "left-pad");
  assert.equal(encodeName("a~b"), "a~b");
});

test("parsePackument: time から版の一覧（古い順）。created/modified/unpublished は版でない。壊れた日時は無視", () => {
  const doc = packument({ name: "p", versions: { "1.1.0": "2026-07-10T00:00:00.000Z", "1.0.0": "2026-06-05T00:00:00.000Z" } });
  doc.time.bogus = "not a date";
  const pk = parsePackument(doc, "p");
  assert.deepEqual(pk.versions.map((v) => v.version), ["1.0.0", "1.1.0"]);
  assert.equal(pk.created, "2026-06-05T00:00:00.000Z");
  assert.equal(pk.versionCount, 2);
  assert.equal(pk.unpublished, false);
  assert.equal(pk.repository, null);
  const un = parsePackument(packument({ name: "u", versions: {}, unpublished: true }), "u");
  assert.equal(un.unpublished, true);
  assert.equal(un.versions.length, 0);
  assert.equal(parsePackument({ name: "x" }, "x").versions.length, 0, "time が無くても落ちない");
  assert.throws(() => parsePackument(null, "x"), /not an object/);
  assert.throws(() => parsePackument([], "x"), /not an object/);
  assert.equal(parsePackument(packument({ name: "r", versions: { "1.0.0": "2026-01-01T00:00:00Z" }, repository: { type: "git", url: "x" } }), "r").repository.url, "x");
});

test("parseRange: 要求した全日を並べ、無い日は 0 と missing 印。downloads 配列が無ければ invalid", () => {
  const body = rangeBody("p", "2026-07-01", "2026-07-05", (_, i) => i + 1);
  body.downloads.splice(2, 1); // 07-03 を欠く
  const r = parseRange(body, "2026-07-01", "2026-07-05");
  assert.deepEqual(r.days.map((d) => d.downloads), [1, 2, 0, 4, 5]);
  assert.equal(r.missing, 1);
  assert.equal(r.days[2].missing, true);
  assert.equal(r.days[0].day, "2026-07-01");
  assert.throws(() => parseRange({ error: "x" }, "2026-07-01", "2026-07-05"), (e) => e.kind === "invalid");
});

test("parseSearch: 名前・最新版の日時・repository リンクの有無を取り出す", () => {
  const j = { total: 3, objects: [{ package: { name: "a", version: "1.0.0", date: "2026-06-10T00:00:00.000Z", links: { npm: "x", repository: "https://github.com/x/a" } } }, { package: { name: "b", date: "2026-06-11T00:00:00.000Z", links: { npm: "x" } } }, { package: {} }, null] };
  const s = parseSearch(j);
  assert.equal(s.total, 3);
  assert.deepEqual(s.objects.map((o) => [o.name, o.hasRepo, o.version]), [["a", true, "1.0.0"], ["b", false, null]]);
  assert.deepEqual(parseSearch(null), { total: 0, objects: [] });
});

test("fetchJson: 429/5xx は待って再試行し、続けば rate-limited/server。Retry-After を尊重。UA を送る", async () => {
  const sleeps = [];
  const sleep = async (ms) => sleeps.push(ms);
  let n = 0;
  const f = mockFetch((url, init) => {
    assert.equal(init.headers["User-Agent"], USER_AGENT);
    n++;
    return n < 3 ? { status: 429, headers: { "Retry-After": "5" } } : { body: { ok: 1 } };
  });
  assert.deepEqual(await fetchJson("https://x/", { fetchImpl: f, sleepImpl: sleep }), { ok: 1 });
  assert.equal(f.calls.length, 3);
  assert.deepEqual(sleeps, [5000, 5000]);
  const always429 = mockFetch(() => ({ status: 429 }));
  await assert.rejects(fetchJson("https://x/", { fetchImpl: always429, sleepImpl: noSleep }), (e) => e instanceof ApiError && e.kind === "rate-limited" && e.status === 429);
  assert.equal(always429.calls.length, 4);
  const always503 = mockFetch(() => ({ status: 503 }));
  await assert.rejects(fetchJson("https://x/", { fetchImpl: always503, sleepImpl: noSleep, tries: 2 }), (e) => e.kind === "server");
  assert.equal(always503.calls.length, 2);
});

test("fetchJson: ネットワーク断は network、404 は not-found（本文の error 文つき）、400 は bad-request、JSON でない本文は invalid", async () => {
  const down = mockFetch(networkDown);
  await assert.rejects(fetchJson("https://x/", { fetchImpl: down, sleepImpl: noSleep }), (e) => e.kind === "network" && /ENOTFOUND/.test(e.message));
  assert.equal(down.calls.length, 4, "ネットワーク断も再試行する");
  await assert.rejects(fetchJson("https://x/", { fetchImpl: mockFetch(() => ({ status: 404, body: { error: "package foo not found" } })), sleepImpl: noSleep }), (e) => e.kind === "not-found" && e.message === "package foo not found");
  await assert.rejects(fetchJson("https://x/", { fetchImpl: mockFetch(() => ({ status: 400, body: { error: "end date > start date" } })), sleepImpl: noSleep }), (e) => e.kind === "bad-request" && /end date/.test(e.message));
  await assert.rejects(fetchJson("https://x/", { fetchImpl: mockFetch(() => ({ status: 200 })), sleepImpl: noSleep }), (e) => e.kind === "invalid");
  await assert.rejects(fetchJson("https://x/", { fetchImpl: mockFetch(() => ({ status: 403, body: { error: "forbidden" } })), sleepImpl: noSleep }), (e) => e.kind === "http" && e.status === 403);
  // タイムアウト（AbortError）も network
  const hang = async (_url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; rej(e); }));
  await assert.rejects(fetchJson("https://x/", { fetchImpl: hang, sleepImpl: noSleep, timeoutMs: 5, tries: 1 }), (e) => e.kind === "network" && /timed out/.test(e.message));
});

test("RateLimiter: 間隔が空くまで待つ（偽の時計）", async () => {
  let t = 0;
  const waits = [];
  const rl = new RateLimiter(2, { sleepImpl: async (ms) => { waits.push(ms); t += ms; }, clock: () => t });
  await rl.wait();
  await rl.wait();
  await rl.wait();
  assert.deepEqual(waits, [500, 500]);
  const off = new RateLimiter(0, { sleepImpl: async (ms) => waits.push(ms), clock: () => 0 });
  await off.wait();
  assert.equal(waits.length, 2, "0 なら待たない");
});

test("getDailyRange: 18 か月を超える範囲は分けて取って繋ぐ。getPackument はスコープ付きの URL を組む", async () => {
  const f = mockFetch((url) => {
    const m = RANGE_RE.exec(url);
    assert.ok(m, url);
    return { body: rangeBody(m[3], m[1], m[2], () => 1) };
  });
  const r = await getDailyRange("@types/node", "2025-01-01", "2026-08-23", { fetchImpl: f, sleepImpl: noSleep });
  assert.equal(r.days.length, 600);
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[0], new RegExp(`/range/2025-01-01:2026-06-24/@types/node$`));
  assert.equal(RANGE_MAX_DAYS, 540);
  assert.equal(r.days.at(-1).day, "2026-08-23");
  await assert.rejects(getDailyRange("p", "2026-02-02", "2026-02-01", { fetchImpl: f }), /before start/);
  const g = mockFetch((url) => {
    assert.equal(url, "https://registry.npmjs.org/@types/node");
    return { body: packument({ name: "@types/node", versions: { "1.0.0": "2026-01-01T00:00:00.000Z" } }) };
  });
  assert.equal((await getPackument("@types/node", { fetchImpl: g })).versions.length, 1);
});
