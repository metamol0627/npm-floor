// 床のコホート表を作る（npx npm-floor calibrate）。
//
//   1. 練習用パッケージが自称する 32 語でレジストリを検索（1 語 12 段 × 250 件）→ 候補の名簿
//   2. 前処理: スコープ付き・repository リンクあり・最新版の公開が 37 日以内／対象期間外・文面がプレースホルダ を落とす
//   3. 月ごとに（候補を乱数種でシャッフルして）packument を引き、単一版・repository 無し・公開 37 日以上前・文面 を確かめる。
//      同じ公開日からは 3 件まで（同じ教室から同日に出た練習パッケージが月を占めないように）
//   4. 通った候補の日次 DL（公開日 −1 〜 +45 日）を取る。T ≥ 3 件/日 は「利用者ゼロ」ではないので除外（印を付けて残す）。
//      月ごとに 30 件（--per-month）集まったら次の月へ
//   5. 月ごとに S（公開後 4 日の合計）と T（15〜30 日目の平均／日）の中央値・p10・p90 を出す → cohorts.json。
//      レジストリ全体が 0 の日（被覆 10 系列以上で合計 0）は分母から外す
//
// 除外規則 2 つ（設計監査 1 巡目 #1）: 検索語「placeholder package」等が、名前を取られないために置くセキュリティ用プレースホルダ
// （dependency-confusion 対策）を系統的に拾う。それらは自称で「使うな」と言いながら実トラフィックの標的で、「利用者ゼロ」の反対側にある。
//   ① 文面: 名前・description・keywords・版名に PLACEHOLDER_RE が当たる → placeholder
//   ② データ: T ≥ SUSTAINED_T 件/日 → sustained-use（汚染の無い月の T p90 は ≤ 1.3、全体の中央値 0.31。その約 10 倍）
//   ③′ 同一 description のクラスター（設計監査 2 巡目 #27）: 同じ月に同じ description の系列が MIN_DESC_CLUSTER 件以上あり、その半数以上が
//      sustained-use なら、一括公開された 1 つのキャンペーン（連番名・同一文面）とみなし、残りも description-cluster として表に入れない。
//      「test package」「my first package」のような、独立した人が同じ文面を書くクラスターは sustained-use を含まないので触らない
//
// ship の配管（scripts/probe_npm_baseline.mjs・lib/window.mjs）と同じ考え方だが、コードは商品側に独立して持つ（DESIGN §3-1）。
// PREREG の対照を書くことは無い。途中経過はディレクトリに残し、同じディレクトリで再実行すれば続きから走る。
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DAY, ymd, parseYmd, monthOf, monthIndex, monthFromIndex, addDays, dayDiff } from "./dates.mjs";
import { RateLimiter, getPackument, getDailyRange, searchPage, ApiError } from "./api.mjs";
import { band, quantile, INITIAL_DAYS, DRIP_FROM, DRIP_TO } from "./floor.mjs";

// ① 文面の規則。名前・description・keywords・版名のどれかに当たれば「プレースホルダ／セキュリティ用／意図的に壊した」とみなす
export const PLACEHOLDER_RE =
  /placeholder|dependency[ -]confusion|\bsecurity\b|\breserved\b|squat|do ?n['o]?t use|not for (public )?use|hackerone|-security\b|-placeholder\b|name reservation|proof[ -]of[ -]concept|\bpoc\b|intentionally (invalid|broken)|malicious/i;
// ② データの規則（件/日）
export const SUSTAINED_T = 3;
// 同じ公開日から採る件数の上限（同日クラスターの抑制。低 #13）
export const MAX_PER_DAY = 3;
// 同一 description のクラスターとみなす最小の件数（同じ月・同じ文面。2 巡目 #27）
export const MIN_DESC_CLUSTER = 3;
// レジストリ全体が 0 の日の判定に要る被覆（その日を含む系列の数）
export const ZERO_DAY_COVERAGE = 10;

export function isPlaceholder({ name = "", description = "", keywords = [], versions = [] } = {}) {
  const text = [name, description, ...keywords, ...versions.map((v) => (typeof v === "string" ? v : v?.version ?? ""))].filter(Boolean).join("\n");
  return PLACEHOLDER_RE.test(text);
}

// 練習用パッケージが自称する語（DESIGN §7。ship の PREREG「対照標本」と同じ 32 語）
export const TERMS = [
  "my first package", "this is my first package", "first npm package",
  "my first npm module", "first package ever", "just my first package",
  "test package", "testing package", "test module", "testing npm publish",
  "learning npm", "learning to publish", "npm tutorial", "npm practice",
  "practice package", "practice module", "sample package", "sample module",
  "demo package", "demo module", "hello world package", "hello world npm",
  "my package", "my module", "my first library", "trying npm",
  "dummy package", "placeholder package", "experiment package",
  "playground package", "study npm", "for learning purposes",
];
export const PAGES = [0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750];
export const PAGE_SIZE = 250;
export const MIN_AGE_DAYS = 37; // 窓 30 日＋確定待ち 7 日。T（15〜30 日目）が確定している
export const SERIES_BEFORE = 1; // 公開日の前日から
export const SERIES_AFTER = 45; // 公開日の 45 日後まで
export const DEFAULT_PER_MONTH = 30;
export const THIN_BELOW = 5; // これ未満の月は前後から補間する（印を付ける）
export const DEFAULT_FROM = "2024-01";

// ── 純関数 ─────────────────────────────────────────────────────────────

// 乱数（mulberry32）。同じ種なら同じ順
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle(arr, seed) {
  const out = arr.slice();
  const rnd = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// 抽出条件（packument で確かめる）。年齢は now 基準
export function qualify(pk, { nowMs, minAgeDays = MIN_AGE_DAYS } = {}) {
  if (!pk || !pk.created) return { ok: false, why: "no-created" };
  if (pk.unpublished) return { ok: false, why: "unpublished" };
  if (pk.versions.length !== 1 || pk.versionCount > 1) return { ok: false, why: `versions=${Math.max(pk.versions.length, pk.versionCount)}` };
  if (pk.repository) return { ok: false, why: "has-repository" };
  if (isPlaceholder(pk)) return { ok: false, why: "placeholder" };
  const age = (nowMs - Date.parse(pk.created)) / DAY;
  if (!(age >= minAgeDays)) return { ok: false, why: `age=${age.toFixed(0)}d` };
  return { ok: true, created: pk.created };
}

// 検索結果の前処理（packument を引く前に落とせるもの）。date は最新版の公開日時（単一版なら公開日）
export function prefilter(obj, { nowMs, fromMonth, toMonth, minAgeDays = MIN_AGE_DAYS }) {
  if (!obj.name || obj.name.startsWith("@")) return { ok: false, why: "scoped" };
  if (obj.hasRepo) return { ok: false, why: "has-repository" };
  const ms = Date.parse(obj.date ?? "");
  if (!Number.isFinite(ms)) return { ok: false, why: "no-date" };
  if ((nowMs - ms) / DAY < minAgeDays) return { ok: false, why: "too-young" };
  const m = monthOf(ms);
  if (m < fromMonth || m > toMonth) return { ok: false, why: "out-of-range" };
  if (isPlaceholder({ name: obj.name, description: obj.description ?? "", versions: obj.version ? [obj.version] : [] })) return { ok: false, why: "placeholder" };
  return { ok: true, month: m };
}

// --to の既定: 「末日が 37 日以上前である最後の月」。実行日が 16 日なら先月ではなく先々月（先月は 1〜10 日公開分しか入らず、構造的に薄い。中 #2）
export function defaultToMonth(nowMs, minAgeDays = MIN_AGE_DAYS) {
  const d = addDays(nowMs, -minAgeDays);
  const m = monthOf(d);
  return monthOf(addDays(d, 1)) === m ? monthFromIndex(monthIndex(m) - 1) : m;
}

// 1 件の日次系列（公開日 −1 日から）→ S・T・ピーク・30 日窓。
// zeroDays（レジストリ全体が 0 だった暦日の集合）は分母から外す: 合計は残りの日の平均 × 本来の日数、平均は残りの日で取る
export function seriesStats(days, createdIso, { zeroDays = null } = {}) {
  const c = ymd(Date.parse(createdIso));
  const by = new Map();
  const skip = new Set();
  for (const d of days) {
    const i = dayDiff(c, d.day);
    by.set(i, Number(d.downloads) || 0);
    if (zeroDays && zeroDays.has(d.day)) skip.add(i);
  }
  const sum = (a, b) => {
    let s = 0;
    let k = 0;
    for (let i = a; i <= b; i++) {
      if (!by.has(i)) return null;
      if (skip.has(i)) {
        k++;
        continue;
      }
      s += by.get(i);
    }
    const n = b - a + 1;
    if (k === n) return null; // 全日がレジストリ 0 → 測れない
    return k ? (s * n) / (n - k) : s;
  };
  const S = sum(0, INITIAL_DAYS - 1);
  const tSum = sum(DRIP_FROM, DRIP_TO);
  const T = tSum == null ? null : tSum / (DRIP_TO - DRIP_FROM + 1);
  const w30 = sum(0, 29);
  let peak = null;
  let peakDay = null;
  for (let i = 0; i <= 29; i++) {
    if (!by.has(i)) break;
    if (peak == null || by.get(i) > peak) {
      peak = by.get(i);
      peakDay = i;
    }
  }
  return { S, T, w30, peak, peakDay, days: days.length, zeroDaysSkipped: [...skip].filter((i) => i >= 0 && i <= DRIP_TO).length };
}

// 暦日ごとの合計が 0 で、その日を含む系列が coverage 以上ある日 → レジストリ全体が 0 の日（npm 側の集計の欠落）
export function findZeroDays(series, { coverage = ZERO_DAY_COVERAGE } = {}) {
  const sum = new Map();
  const cov = new Map();
  for (const s of Object.values(series)) {
    for (const d of s.days) {
      sum.set(d.day, (sum.get(d.day) ?? 0) + (Number(d.downloads) || 0));
      cov.set(d.day, (cov.get(d.day) ?? 0) + 1);
    }
  }
  return [...sum.keys()].filter((day) => sum.get(day) === 0 && cov.get(day) >= coverage).sort();
}

// ③′ 同一 description のクラスター。series は aggregate と同じ形（days は {day, downloads}。description を持つ）。
// 同じ月・同じ文面（空白と大小を正規化。空は対象外）が minCluster 件以上で、その半数以上が sustained-use（印か T ≥ sustainedT）なら、
// 残りの系列に excluded = "description-cluster" を付ける（その場で書き換え、付けた名前の一覧を返す）
export function markDescriptionClusters(series, { minCluster = MIN_DESC_CLUSTER, sustainedT = SUSTAINED_T } = {}) {
  const groups = new Map();
  for (const [name, s] of Object.entries(series)) {
    const d = String(s.description ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!d) continue;
    const key = `${monthOf(Date.parse(s.created))}|${d}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ name, s });
  }
  const marked = [];
  for (const g of groups.values()) {
    if (g.length < minCluster) continue;
    const isSustained = ({ s }) => s.excluded === "sustained-use" || (!s.excluded && (seriesStats(s.days, s.created).T ?? 0) >= sustainedT);
    const sustained = g.filter(isSustained);
    if (sustained.length * 2 < g.length) continue;
    for (const m of g) {
      if (m.s.excluded || sustained.includes(m)) continue; // 既に除外済み・T ≥ 3 で aggregate が sustained-use に数えるものはそのまま
      m.s.excluded = "description-cluster";
      marked.push(m.name);
    }
  }
  return marked.sort();
}

// series: { name: { created, days: [{day, downloads}], excluded? } } → コホート表（cohorts.json の形）。
// excluded の印が付いた系列と T ≥ sustainedT の系列は表に入れず、件数だけ method.excluded に残す
export function aggregate(series, { from, to, perMonth = DEFAULT_PER_MONTH, thinBelow = THIN_BELOW, generatedAt = new Date().toISOString(), zeroDays = null, sustainedT = SUSTAINED_T, excluded = {} } = {}) {
  const rows = [];
  const zd = zeroDays ? new Set(zeroDays) : null;
  const ex = { placeholder: 0, dayCluster: 0, ...excluded, sustainedUse: 0, descriptionCluster: 0 };
  for (const [name, s] of Object.entries(series)) {
    const st = seriesStats(s.days, s.created, { zeroDays: zd });
    if (st.S == null || st.T == null) continue; // 系列が短い（S か T が確定していない）ものは表に入れない
    if (s.excluded === "description-cluster") {
      ex.descriptionCluster++;
      continue;
    }
    if (s.excluded || st.T >= sustainedT) {
      ex.sustainedUse++;
      continue;
    }
    rows.push({ name, month: monthOf(Date.parse(s.created)), ...st });
  }
  const byMonth = {};
  for (const r of rows) (byMonth[r.month] ??= []).push(r);
  const keys = Object.keys(byMonth).sort();
  const fromM = from ?? keys[0];
  const toM = to ?? keys.at(-1);
  if (!fromM || !toM) throw new Error("no usable series to aggregate");
  const months = {};
  const own = {};
  for (let i = monthIndex(fromM); i <= monthIndex(toM); i++) {
    const m = monthFromIndex(i);
    const rs = byMonth[m] ?? [];
    const n = rs.length;
    if (n >= thinBelow) {
      own[m] = {
        n,
        S: band(rs.map((r) => r.S)),
        T: band(rs.map((r) => r.T)),
        w30: band(rs.map((r) => r.w30)),
        peak: { median: quantile(rs.map((r) => r.peak), 0.5), day: quantile(rs.map((r) => r.peakDay), 0.5) },
        flag: n < perMonth ? "thin" : null,
      };
    } else own[m] = { n, flag: "interpolated" };
  }
  const idx = Object.keys(own).sort();
  let solid = idx.filter((m) => own[m].flag !== "interpolated");
  if (!solid.length) {
    // どの月も thinBelow に届かない（短い試し実行など）。1 件でもある月を「thin」として使い、表を作れる形にする
    for (const m of idx) {
      const rs = byMonth[m] ?? [];
      if (!rs.length) continue;
      own[m] = { n: rs.length, S: band(rs.map((r) => r.S)), T: band(rs.map((r) => r.T)), w30: band(rs.map((r) => r.w30)), peak: { median: quantile(rs.map((r) => r.peak), 0.5), day: quantile(rs.map((r) => r.peakDay), 0.5) }, flag: "thin" };
    }
    solid = idx.filter((m) => own[m].flag !== "interpolated");
  }
  const lerpBand = (a, b, t) => ({ median: a.median + (b.median - a.median) * t, p10: a.p10 + (b.p10 - a.p10) * t, p90: a.p90 + (b.p90 - a.p90) * t });
  for (const m of idx) {
    if (own[m].flag !== "interpolated") {
      months[m] = own[m];
      continue;
    }
    const prev = solid.filter((k) => k < m).at(-1);
    const next = solid.find((k) => k > m);
    let base;
    let basis;
    if (prev && next) {
      const t = (monthIndex(m) - monthIndex(prev)) / (monthIndex(next) - monthIndex(prev));
      base = { S: lerpBand(own[prev].S, own[next].S, t), T: lerpBand(own[prev].T, own[next].T, t), w30: lerpBand(own[prev].w30, own[next].w30, t) };
      basis = [prev, next];
    } else if (prev || next) {
      const src = own[prev ?? next];
      base = { S: { ...src.S }, T: { ...src.T }, w30: { ...src.w30 } };
      basis = [prev ?? next];
    } else throw new Error(`no month with at least ${thinBelow} packages; cannot build a table`);
    months[m] = { n: own[m].n, ...base, peak: null, flag: "interpolated", interpolatedFrom: basis };
  }
  const all = rows;
  return {
    schema: 1,
    tool: "npm-floor",
    generatedAt,
    method: {
      population: `npm registry search, ${TERMS.length} terms x ${PAGES.length} pages x ${PAGE_SIZE} (unscoped names only)`,
      conditions: `single version / no repository field / published at least ${MIN_AGE_DAYS} days before the run / not a placeholder by its own text / drip T < ${sustainedT} per day / at most ${MAX_PER_DAY} packages per publish day / not the rest of a same-description batch whose members are in sustained use`,
      exclusions: {
        placeholder: `name, description, keywords or version name matches ${PLACEHOLDER_RE} (security / dependency-confusion placeholders, reserved names, typosquats, intentionally broken packages: they are targets of real traffic, not zero-user packages)`,
        sustainedUse: `mean daily downloads on days ${DRIP_FROM}..${DRIP_TO} >= ${sustainedT} (about 10x the cohort median; kept in the raw series with an 'excluded' mark, not in this table)`,
        dayCluster: `more than ${MAX_PER_DAY} packages published on the same UTC day (practice uploads from one classroom are not independent)`,
        descriptionCluster: `${MIN_DESC_CLUSTER} or more packages in one month with the same description of which at least half are in sustained use: one batch-published campaign, so the rest are excluded too (kept in the raw series with an 'excluded' mark)`,
      },
      series: `daily downloads from day -${SERIES_BEFORE} to day +${SERIES_AFTER} relative to the publish day (UTC)`,
      S: `sum of downloads on days 0..${INITIAL_DAYS - 1} (${INITIAL_DAYS} days incl. the publish day) per package; median / p10 / p90 over the month's cohort`,
      T: `mean daily downloads on days ${DRIP_FROM}..${DRIP_TO} per package; median / p10 / p90 over the month's cohort`,
      w30: "sum of downloads on days 0..29 per package (the 30-day window from the publish day); median / p10 / p90",
      zeroDays: zeroDays ?? [],
      zeroDaysNote: `UTC days on which npm's daily counts were 0 for the whole registry (0 across >= ${ZERO_DAY_COVERAGE} series); removed from the denominators of S, T and w30`,
      quantile: "linear interpolation between order statistics (R type 7)",
      perMonthTarget: perMonth,
      thinBelow,
      sustainedUseT: sustainedT,
      maxPerDay: MAX_PER_DAY,
      minDescriptionCluster: MIN_DESC_CLUSTER,
      excluded: ex,
      flags: { thin: `fewer than ${perMonth} packages in the month (own values used)`, interpolated: `fewer than ${thinBelow} packages; values interpolated linearly from the nearest months with enough packages` },
      ja: {
        population: `npm レジストリ検索 ${TERMS.length} 語 × ${PAGES.length} 段 × ${PAGE_SIZE} 件（スコープ無しの名前のみ）`,
        conditions: `単一版／repository 無し／実行日の ${MIN_AGE_DAYS} 日以上前に公開／文面がプレースホルダでない／滴り T < ${sustainedT} 件/日／同じ公開日から ${MAX_PER_DAY} 件まで／同じ文面の一括公開で仲間が使われ続けているものの残りでない`,
      },
    },
    overall: { n: all.length, S: band(all.map((r) => r.S)), T: band(all.map((r) => r.T)), w30: band(all.map((r) => r.w30)) },
    months,
  };
}

// ── 実行（ネットワーク・ディスク） ────────────────────────────────────────

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw new Error(`${path} could not be read: ${e.message}`);
  }
}
const writeJson = (path, obj) => writeFile(path, JSON.stringify(obj, null, 1) + "\n");

export async function runCalibrate({
  outDir,
  from = DEFAULT_FROM,
  to = null,
  perMonth = DEFAULT_PER_MONTH,
  thinBelow = THIN_BELOW,
  rate = 1,
  maxChecks = Infinity,
  seed = null,
  now = Date.now(),
  fetchImpl = fetch,
  sleepImpl,
  log = () => {},
  terms = TERMS,
  pages = PAGES,
} = {}) {
  if (!outDir) throw new Error("calibrate needs an output directory (--out <dir>)");
  const nowMs = now;
  const toM = to ?? defaultToMonth(nowMs);
  if (monthIndex(from) > monthIndex(toM)) throw new Error(`--from ${from} is after --to ${toM}`);
  const theSeed = seed ?? Number(ymd(nowMs).replace(/-/g, ""));
  const limiter = new RateLimiter(rate, sleepImpl ? { sleepImpl } : {});
  // 検索 API は 429 を返しやすい。数時間の走査を 20 秒の再試行で捨てないよう、再試行を 8 回（最長 3+6+…+384 秒）まで待つ
  const net = { fetchImpl, limiter, tries: 8, log: (m) => log(`  ${m}`), ...(sleepImpl ? { sleepImpl } : {}) };
  await mkdir(outDir, { recursive: true });

  const P = (f) => join(outDir, f);
  const meta = (await readJson(P("meta.json"), null)) ?? { startedAt: new Date(nowMs).toISOString(), from, to: toM, perMonth, seed: theSeed, minAgeDays: MIN_AGE_DAYS, terms: terms.length, pages: pages.length };
  await writeJson(P("meta.json"), meta);

  // 1. 検索（語ごとに保存。中断しても続きから）
  const search = (await readJson(P("search.json"), null)) ?? { done: [], candidates: {} };
  for (const term of terms) {
    if (search.done.includes(term)) continue;
    let got = 0;
    for (const fromIdx of pages) {
      const page = await searchPage(term, fromIdx, PAGE_SIZE, net);
      if (!page.objects.length) break;
      for (const o of page.objects) {
        if (!search.candidates[o.name]) {
          // description は前処理の文面規則（①）に使う。長いものは切る（名簿のサイズのため）
          search.candidates[o.name] = { date: o.date, hasRepo: o.hasRepo, version: o.version, description: String(o.description ?? "").slice(0, 200) };
          got++;
        }
      }
      if (page.objects.length < PAGE_SIZE) break;
    }
    search.done.push(term);
    await writeJson(P("search.json"), search);
    log(`search "${term}": +${got} (total ${Object.keys(search.candidates).length})`);
  }

  // 2. 前処理と月ごとの名簿
  const buckets = {};
  const pre = { total: 0, kept: 0, why: {} };
  for (const [name, c] of Object.entries(search.candidates)) {
    pre.total++;
    const r = prefilter({ name, ...c }, { nowMs, fromMonth: from, toMonth: toM });
    if (!r.ok) {
      pre.why[r.why] = (pre.why[r.why] ?? 0) + 1;
      continue;
    }
    pre.kept++;
    (buckets[r.month] ??= []).push(name);
  }
  for (const m of Object.keys(buckets)) buckets[m] = shuffle(buckets[m].sort(), theSeed + monthIndex(m));
  log(`candidates ${pre.total} → after prefilter ${pre.kept} (${Object.entries(pre.why).map(([k, v]) => `${k} ${v}`).join(", ")})`);

  // 3〜4. 月ごとに照合と日次 DL の取得（月を巡回して均等に埋める）
  const checked = (await readJson(P("checked.json"), null)) ?? {};
  const series = (await readJson(P("series.json"), null)) ?? {};
  const countOf = (m) => Object.values(series).filter((s) => s.month === m && !s.excluded).length;
  const countOnDay = (day) => Object.values(series).filter((s) => !s.excluded && ymd(Date.parse(s.created)) === day).length;
  const months = [];
  for (let i = monthIndex(from); i <= monthIndex(toM); i++) months.push(monthFromIndex(i));
  const cursor = Object.fromEntries(months.map((m) => [m, 0]));
  let checks = 0;
  let sinceSave = 0;
  const save = async () => {
    await writeJson(P("checked.json"), checked);
    await writeJson(P("series.json"), series);
    sinceSave = 0;
  };
  const seriesEnd = ymd(addDays(nowMs, -2)); // 直近 2 日は 0 で返りうるので取らない
  let progress = true;
  while (progress && checks < maxChecks) {
    progress = false;
    for (const m of months) {
      if (checks >= maxChecks) break;
      if (countOf(m) >= perMonth) continue;
      const list = buckets[m] ?? [];
      // 未照合の次の候補
      let name = null;
      while (cursor[m] < list.length) {
        const n = list[cursor[m]++];
        if (!checked[n]) {
          name = n;
          break;
        }
        if (checked[n].ok && !series[n]) {
          name = n; // 照合は済んだが系列が無い（前回の中断）
          break;
        }
      }
      if (!name) continue;
      progress = true;
      checks++;
      try {
        let row = checked[name];
        if (!row || !row.ok) {
          const pk = await getPackument(name, net);
          const q = qualify(pk, { nowMs });
          row = { at: new Date().toISOString(), ok: q.ok, why: q.why ?? null, created: q.created ?? null };
          checked[name] = row;
        }
        if (row.ok && countOnDay(ymd(Date.parse(row.created))) >= MAX_PER_DAY) {
          // 同じ公開日から既に 3 件ある → 系列を取らずに落とす（同日クラスターの抑制）
          checked[name] = { ...row, ok: false, why: "day-cluster" };
          row = checked[name];
        }
        if (row.ok) {
          const cMs = Date.parse(row.created);
          const start = ymd(addDays(cMs, -SERIES_BEFORE));
          const end = ymd(Math.min(addDays(cMs, SERIES_AFTER), parseYmd(seriesEnd)));
          const r = await getDailyRange(name, start, end, net);
          const st = seriesStats(r.days, row.created);
          // description は ③′（同一文面のクラスター）に使う。検索結果のものを残す（packument を引き直さない）
          const entry = { created: row.created, month: monthOf(cMs), start, end, description: search.candidates[name]?.description ?? "", days: r.days.map((d) => d.downloads) };
          // ② 滴りが多い（T ≥ 3 件/日）→ 利用者ゼロではない。系列は残すが表には入れず、月の件数にも数えない
          if (st.T != null && st.T >= SUSTAINED_T) entry.excluded = "sustained-use";
          series[name] = entry;
          log(`${m}: ${countOf(m)}/${perMonth}  ${name}  S=${st.S}  T=${st.T == null ? "-" : st.T.toFixed(2)}${entry.excluded ? `  (excluded: ${entry.excluded})` : ""}`);
        }
      } catch (e) {
        if (e instanceof ApiError && e.kind === "not-found") checked[name] = { at: new Date().toISOString(), ok: false, why: "404" };
        else {
          log(`${name}: ${e.message} (left unchecked; re-run to retry)`);
          if (e instanceof ApiError && (e.kind === "network" || e.kind === "rate-limited" || e.kind === "server")) {
            await save();
            throw e; // 続けても同じ失敗になる。途中経過は保存済み
          }
        }
      }
      if (++sinceSave >= 20) await save();
    }
  }
  await save();

  // 5. 集計。③′ 同一文面のクラスターに印を付け（古い series.json には description が無いので検索結果から補う）、
  //    レジストリ全体が 0 の日を先に見つけて分母から外す
  for (const [n, s] of Object.entries(series)) if (s.description == null && search.candidates[n]) s.description = search.candidates[n].description ?? "";
  const seriesForAgg = expandSeries(series);
  const clustered = markDescriptionClusters(seriesForAgg);
  for (const n of clustered) {
    series[n].excluded = "description-cluster";
    log(`${series[n].month}: ${n}  (excluded: description-cluster)`);
  }
  await save();
  const zeroDays = findZeroDays(seriesForAgg);
  const whyCount = (w) => Object.values(checked).filter((c) => c.why === w).length;
  const excluded = { placeholder: (pre.why.placeholder ?? 0) + whyCount("placeholder"), dayCluster: whyCount("day-cluster") };
  const cohorts = aggregate(seriesForAgg, { from, to: toM, perMonth, thinBelow, generatedAt: new Date().toISOString(), zeroDays, excluded });
  cohorts.method.seed = theSeed;
  cohorts.method.candidates = { searched: pre.total, afterPrefilter: pre.kept, checked: Object.keys(checked).length, measured: Object.keys(series).length };
  await writeJson(P("cohorts.json"), cohorts);
  if (zeroDays.length) log(`registry-zero days (excluded from denominators): ${zeroDays.join(" ")}`);
  log(`excluded: placeholder ${cohorts.method.excluded.placeholder} / sustained-use ${cohorts.method.excluded.sustainedUse} / day-cluster ${cohorts.method.excluded.dayCluster} / description-cluster ${cohorts.method.excluded.descriptionCluster}`);
  const done = months.every((m) => countOf(m) >= perMonth || (buckets[m] ?? []).every((n) => checked[n]));
  return { cohorts, months: Object.fromEntries(months.map((m) => [m, countOf(m)])), checks, done, outDir };
}

// series.json の形（days は数の配列）→ aggregate の形（days は {day, downloads}）。excluded の印と description は持ち越す
export function expandSeries(series) {
  return Object.fromEntries(
    Object.entries(series).map(([n, s]) => [n, { created: s.created, excluded: s.excluded ?? null, description: s.description ?? "", days: s.days.map((v, i) => ({ day: ymd(addDays(parseYmd(s.start), i)), downloads: v })) }])
  );
}
