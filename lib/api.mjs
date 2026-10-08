// npm の公開 API を読むだけの薄い層。認証は要らない。
//
//   registry.npmjs.org/<name>                 packument（版ごとの公開日時 time.<version>・time.created）
//   api.npmjs.org/downloads/range/<a>:<b>/<name>  日次 DL（単一パッケージは最長 18 か月。スコープ付きも単体なら受ける）
//   registry.npmjs.org/-/v1/search            検索（calibrate が練習用パッケージを集めるのに使う）
//
// 失敗は意味ごとに分ける（CLI が人間に読める文にする）:
//   not-found     404（パッケージが無い）
//   bad-request   400（窓が未来・日付の形が違う等。API の error 文を添える）
//   rate-limited  429 が再試行後も続く
//   server        5xx が再試行後も続く
//   network       接続できない・タイムアウト
//   invalid       名前や応答の形が読めない
// 429 と 5xx は待って再試行する（Retry-After があればそれ、無ければ 3s, 6s, 12s）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { DAY, ymd, parseYmd } from "./dates.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const PKG_VERSION = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;
export const USER_AGENT = `npm-floor/${PKG_VERSION} (+https://www.npmjs.com/package/npm-floor)`;
export const REGISTRY = "https://registry.npmjs.org";
export const DOWNLOADS = "https://api.npmjs.org/downloads";
export const RANGE_MAX_DAYS = 540; // 範囲 API の上限は 18 か月（npm/registry docs/download-counts.md）。超える範囲は分けて取る

export class ApiError extends Error {
  constructor(kind, message, { status = null, url = null, cause = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.url = url;
    if (cause) this.cause = cause;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1 秒あたり N 件に抑える（calibrate の既定は 1 req/s。DESIGN §6）
export class RateLimiter {
  constructor(perSecond = 1, { sleepImpl = sleep, clock = Date.now } = {}) {
    this.interval = perSecond > 0 ? 1000 / perSecond : 0;
    this.last = -Infinity;
    this.sleepImpl = sleepImpl;
    this.clock = clock;
  }
  async wait() {
    if (!this.interval) return;
    const due = this.last + this.interval;
    const now = this.clock();
    if (due > now) await this.sleepImpl(due - now);
    this.last = Math.max(this.clock(), due);
  }
}

const backoff = (i) => 3000 * 2 ** i;

async function bodyMessage(res) {
  try {
    const j = await res.json();
    if (typeof j?.error === "string") return j.error;
    if (typeof j?.message === "string") return j.message;
  } catch {
    /* 本文が JSON でない */
  }
  return null;
}

// JSON を取る。再試行・タイムアウト・レート制限つき。
export async function fetchJson(url, { fetchImpl = fetch, tries = 4, timeoutMs = 20000, limiter = null, sleepImpl = sleep, log = null } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    if (limiter) await limiter.wait();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      let res;
      try {
        res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: ac.signal });
      } catch (e) {
        const timedOut = e?.name === "AbortError";
        last = new ApiError("network", timedOut ? `timed out after ${timeoutMs} ms` : e?.cause?.message ?? e?.message ?? String(e), { url, cause: e });
        if (i < tries - 1) {
          log?.(`network error (${last.message}); retrying in ${backoff(i) / 1000}s`);
          await sleepImpl(backoff(i));
          continue;
        }
        throw last;
      }
      const status = Number(res.status);
      if (status === 429 || status >= 500) {
        const kind = status === 429 ? "rate-limited" : "server";
        last = new ApiError(kind, `HTTP ${status}`, { status, url });
        if (i < tries - 1) {
          const ra = Number(res.headers?.get?.("retry-after"));
          const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 120) * 1000 : backoff(i);
          log?.(`HTTP ${status}; retrying in ${wait / 1000}s`);
          await sleepImpl(wait);
          continue;
        }
        throw last;
      }
      if (status === 404) throw new ApiError("not-found", (await bodyMessage(res)) ?? "HTTP 404", { status, url });
      if (status === 400) throw new ApiError("bad-request", (await bodyMessage(res)) ?? "HTTP 400", { status, url });
      if (!res.ok) throw new ApiError("http", (await bodyMessage(res)) ?? `HTTP ${status}`, { status, url });
      try {
        return await res.json();
      } catch (e) {
        throw new ApiError("invalid", "response was not JSON", { status, url, cause: e });
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw last ?? new ApiError("network", "no attempts made", { url });
}

// npm のパッケージ名として読めるか（スコープ付き可）。読めなければ ApiError("invalid")
export function validateName(name) {
  const s = String(name ?? "").trim();
  if (!s) throw new ApiError("invalid", "empty package name");
  const bare = s.replace(/^@[^/]+\//, "");
  if (s.length > 214 || /\s/.test(s) || !/^(@[^/@\s]+\/)?[^/@\s]+$/.test(s) || /^[._]/.test(bare) || /[<>:"|?*\\]/.test(s)) {
    throw new ApiError("invalid", `not a valid npm package name: ${s}`);
  }
  return s;
}

// URL の中の名前。スコープの "@" と "/" はそのまま（registry も downloads API もこの形を受ける）
export const encodeName = (n) => encodeURIComponent(n).replace(/^%40/, "@").replace(/%2F/gi, "/");

// packument → 版の一覧（公開日時つき・古い順）。unpublished（全削除）も分かる
export function parsePackument(doc, name) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new ApiError("invalid", `registry document for ${name} is not an object`);
  const time = doc.time && typeof doc.time === "object" ? doc.time : {};
  const versions = [];
  for (const [k, v] of Object.entries(time)) {
    if (k === "created" || k === "modified" || k === "unpublished") continue;
    const ms = Date.parse(v);
    if (!Number.isFinite(ms)) continue;
    versions.push({ version: k, time: new Date(ms).toISOString(), ms });
  }
  versions.sort((a, b) => a.ms - b.ms || (a.version < b.version ? -1 : 1));
  const readme = typeof doc.readme === "string" ? doc.readme.trim() : "";
  return {
    name: typeof doc.name === "string" ? doc.name : name,
    created: typeof time.created === "string" ? time.created : null,
    modified: typeof time.modified === "string" ? time.modified : null,
    unpublished: !!time.unpublished,
    repository: doc.repository ?? null,
    description: typeof doc.description === "string" ? doc.description : "",
    keywords: Array.isArray(doc.keywords) ? doc.keywords.filter((k) => typeof k === "string") : [],
    // packument の readme。無いときは空か "ERROR: No README data found!" が入る
    hasReadme: readme.length > 0 && !/^ERROR: No README/i.test(readme),
    versionCount: doc.versions && typeof doc.versions === "object" ? Object.keys(doc.versions).length : 0,
    versions,
  };
}

export async function getPackument(name, opts = {}) {
  const n = validateName(name);
  const doc = await fetchJson(`${REGISTRY}/${encodeName(n)}`, opts);
  return parsePackument(doc, n);
}

// 範囲 API の応答 → start..end の全日（無い日は 0・missing 印）
export function parseRange(j, start, end) {
  if (!j || !Array.isArray(j.downloads)) throw new ApiError("invalid", "downloads range response has no `downloads` array");
  const map = new Map();
  for (const d of j.downloads) if (d && typeof d.day === "string") map.set(d.day, Number(d.downloads) || 0);
  const days = [];
  let missing = 0;
  const s = parseYmd(start);
  const e = parseYmd(end);
  for (let t = s; t <= e; t += DAY) {
    const k = ymd(t);
    if (map.has(k)) days.push({ day: k, downloads: map.get(k) });
    else {
      days.push({ day: k, downloads: 0, missing: true });
      missing++;
    }
  }
  return { days, missing };
}

// 日次 DL（start..end を含む）。18 か月を超える範囲は分けて取って繋ぐ
export async function getDailyRange(name, start, end, opts = {}) {
  const n = validateName(name);
  const s = parseYmd(start);
  const e = parseYmd(end);
  if (e < s) throw new ApiError("invalid", `window end ${end} is before start ${start}`);
  const days = [];
  let missing = 0;
  for (let a = s; a <= e; a += RANGE_MAX_DAYS * DAY) {
    const b = Math.min(e, a + (RANGE_MAX_DAYS - 1) * DAY);
    const j = await fetchJson(`${DOWNLOADS}/range/${ymd(a)}:${ymd(b)}/${encodeName(n)}`, opts);
    const part = parseRange(j, ymd(a), ymd(b));
    days.push(...part.days);
    missing += part.missing;
  }
  return { name: n, start: ymd(s), end: ymd(e), days, missing };
}

// レジストリ全体が 0 の日（npm 側の集計の欠落。2026-09 だけで 4 日あった）を見分けるための参照パッケージの日次。
// 失敗しても計測は続ける（null を返す）——参照は注記のためで、無くても答えは出る
export const REFERENCE_PACKAGE = "npm";
export async function getReferenceRange(start, end, opts = {}) {
  try {
    return await getDailyRange(REFERENCE_PACKAGE, start, end, opts);
  } catch {
    return null;
  }
}

// 検索の 1 ページ → 候補（calibrate 用）。date は最新版の公開日時、hasRepo は links.repository の有無
export function parseSearch(j) {
  const objs = Array.isArray(j?.objects) ? j.objects : [];
  const objects = [];
  for (const o of objs) {
    const p = o?.package;
    if (!p || typeof p.name !== "string") continue;
    objects.push({
      name: p.name,
      version: typeof p.version === "string" ? p.version : null,
      date: typeof p.date === "string" ? p.date : null,
      hasRepo: !!p.links?.repository,
      description: typeof p.description === "string" ? p.description : "",
    });
  }
  return { total: Number(j?.total) || 0, objects };
}

export async function searchPage(term, from = 0, size = 250, opts = {}) {
  const j = await fetchJson(`${REGISTRY}/-/v1/search?text=${encodeURIComponent(term)}&size=${size}&from=${from}`, opts);
  return parseSearch(j);
}
