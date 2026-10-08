// テストの共通部品。ネットワークは触らない（fetch の偽物）。一時ディレクトリは tests/tmp/（.gitignore 済み）
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DAY, ymd, parseYmd } from "../lib/dates.mjs";

export const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
export const PKG_DIR = join(TESTS_DIR, "..");
export const TMP_BASE = join(TESTS_DIR, "tmp");
export const SAMPLE_COHORTS = join(TESTS_DIR, "fixtures", "cohorts.sample.json");
export const sampleCohorts = () => JSON.parse(readFileSync(SAMPLE_COHORTS, "utf8"));

export function makeTmp(name) {
  mkdirSync(TMP_BASE, { recursive: true });
  return mkdtempSync(join(TMP_BASE, `${name}-`));
}
export function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows で開いたままのことがある */
  }
}
export const exists = (p) => existsSync(p);

// 出力を集める疑似ストリーム
export function sink() {
  const s = { text: "", write(chunk, cb) { s.text += String(chunk); if (typeof cb === "function") cb(); return true; }, writableLength: 0 };
  return s;
}

// fetch の偽物。handler(url) は { status, body, headers } を返すか、throw する（ネットワーク断）
export function mockFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push(String(url));
    const r = await handler(String(url), init, calls.length);
    const status = r.status ?? 200;
    const headers = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
      json: async () => {
        if (r.body === undefined) throw new SyntaxError("Unexpected end of JSON input");
        return r.body;
      },
    };
  };
  f.calls = calls;
  return f;
}

export const networkDown = () => {
  const e = new TypeError("fetch failed");
  e.cause = new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
  throw e;
};

// packument の偽物。versions: { "1.0.0": "2026-07-10T00:00:00.000Z", ... }
export function packument({ name = "demo-pkg", created = null, versions = {}, repository = null, unpublished = false } = {}) {
  const times = Object.values(versions).map((t) => Date.parse(t)).filter(Number.isFinite);
  const c = created ?? (times.length ? new Date(Math.min(...times)).toISOString() : "2026-01-01T00:00:00.000Z");
  const m = times.length ? new Date(Math.max(...times)).toISOString() : c;
  const doc = { name, "dist-tags": {}, time: { created: c, modified: m, ...versions }, versions: Object.fromEntries(Object.keys(versions).map((v) => [v, { name, version: v }])) };
  if (repository) doc.repository = repository;
  if (unpublished) doc.time.unpublished = { time: m };
  return doc;
}

// 範囲 API の応答の偽物。value(dayYmd, index) → 件数
export function rangeBody(name, start, end, value = () => 1) {
  const downloads = [];
  let i = 0;
  for (let t = parseYmd(start); t <= parseYmd(end); t += DAY) downloads.push({ day: ymd(t), downloads: value(ymd(t), i++) });
  return { start, end, package: name, downloads };
}

// URL から範囲 API の start/end/name を取り出す
export const RANGE_RE = /\/downloads\/range\/(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})\/(.+)$/;

// 検索 API の応答の偽物
export const searchBody = (objects, total = objects.length) => ({
  total,
  objects: objects.map((o) => ({ package: { name: o.name, version: o.version ?? "1.0.0", date: o.date ?? "2026-06-10T00:00:00.000Z", description: o.description ?? "my first package", links: o.repo ? { npm: "x", repository: o.repo } : { npm: "x" } } })),
});

// 公開日 −1 日から N 日の日次系列（値の関数つき）
export function syntheticDays(created, n, value) {
  const c = parseYmd(ymd(Date.parse(created)));
  const days = [];
  for (let i = -1; i < n - 1; i++) days.push({ day: ymd(c + i * DAY), downloads: value(i) });
  return days;
}
