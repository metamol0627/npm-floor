// 床の式と判定（純関数。ネットワークを触らない）。
//
//   床(窓) = Σ_{窓内に公開された版 v} S(m(v)) × 按分 + T(m(滴りの月)) × 対象が存在した窓内の日数
//     S(m)  月 m のコホート（練習用・単一版・repo 無し）の「公開後 4 日の DL」（中央値。p10・p90 を帯にする）
//     T(m)  同じコホートの「公開 15〜30 日目の平均 DL／日」（中央値。p10・p90 を帯にする）
//     滴りの月 = 窓内に版があればその最後の版の公開月、無ければ窓の末日の月（設計監査 2 巡目 #26。隣り合う月の T p90 は
//                thin な表では最大 3 倍跳ぶので、版の月と滴りの月を揃えないと、月末に公開したパッケージの床が隣の月の T で決まる）
//     按分   = 版の公開日から窓の末日までが 4 日未満なら、その日数に S が乗る割合（S_SHARE_BY_DAYS。2 巡目 #28）
//     存在した日数 = 窓内の日のうち、対象の created 以後の日（同 #28。作られる前の日には滴りは付かない）
//   超過 = 実測 − 床(中央値)
//     実測 ≥ 3 × 床(p90)                     → clearly-above（明確に床の上）
//     超過 ≤ 床(p90) − 床(中央値)（＝実測 ≤ 床 p90）→ indistinguishable（床と区別できない）
//     それ以外                                  → above（床を超える）
//   補助: 窓内の版数 ≥ 20 → version pumping の疑い
//
// 帯の足し方は素朴（版ごとの p90 をそのまま足す）。独立なら和の p90 より大きく出るので「床と区別できない」側に寄る（保守的）。
import { DAY, ymd, parseYmd, monthOf, monthIndex, addDays, dayDiff } from "./dates.mjs";

export const DEFAULT_WINDOW_DAYS = 30;
export const MAX_WINDOW_DAYS = 540;
export const LAG_DAYS = 2; // 範囲 API は直近 1〜2 日が 0 で返ることがある。既定の窓の末日は今日 − 2 日
export const PUMPING_VERSIONS = 20;
export const CLEAR_MULTIPLIER = 3;
export const INITIAL_DAYS = 4; // S: 公開日を含む 4 日（day 0..3）
export const DRIP_FROM = 15; // T: day 15..30 の平均
export const DRIP_TO = 30;
// S（day 0..3 の合計）のうち day 0 / day 0..1 / day 0..2 までに乗る割合の中央値（2026-09-18 の表・565 件の実測: 0.857・0.928・0.967）。
// 版の公開日から窓の末日までが 4 日未満のとき、S をこの割合で按分する（2 巡目 #28）
export const S_SHARE_BY_DAYS = [0.86, 0.93, 0.97];

export const VERDICTS = ["indistinguishable", "above", "clearly-above"];

// ── 統計の小道具（線形補間。R の type 7） ─────────────────────────────
export function quantile(values, q) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}
export const median = (values) => quantile(values, 0.5);
export const band = (values) => ({ median: quantile(values, 0.5), p10: quantile(values, 0.1), p90: quantile(values, 0.9) });

// ── 窓 ────────────────────────────────────────────────────────────────
// { start, end, days } のどれを渡してもよい。start と end の両方があれば days はそこから決まる。
// 何も無ければ「今日（UTC）− LAG_DAYS を末日とする 30 日」。末日が今日より後なら Error（未来の窓）。
export function resolveWindow({ start = null, end = null, days = null, now = Date.now() } = {}) {
  const today = parseYmd(ymd(now));
  let n = days == null ? null : Number(days);
  if (n != null && (!Number.isInteger(n) || n < 1 || n > MAX_WINDOW_DAYS)) throw new Error(`--window must be an integer from 1 to ${MAX_WINDOW_DAYS} (got ${days})`);
  let s = start == null ? null : parseYmd(start);
  let e = end == null ? null : parseYmd(end);
  if (s != null && e != null) {
    if (e < s) throw new Error(`window end ${ymd(e)} is before start ${ymd(s)}`);
    const d = Math.round((e - s) / DAY) + 1;
    if (n != null && n !== d) throw new Error(`--window ${n} does not match --start/--end (${d} days)`);
    n = d;
    if (n > MAX_WINDOW_DAYS) throw new Error(`window is longer than ${MAX_WINDOW_DAYS} days (${n})`);
  } else {
    n ??= DEFAULT_WINDOW_DAYS;
    if (s != null) e = addDays(s, n - 1);
    else {
      e ??= addDays(today, -LAG_DAYS);
      s = addDays(e, -(n - 1));
    }
  }
  if (e > today) throw new Error(`window ends in the future (${ymd(e)}; today is ${ymd(today)} UTC)`);
  return {
    start: ymd(s),
    end: ymd(e),
    days: n,
    startMs: s,
    endMs: e + DAY - 1, // 末日の 23:59:59.999Z
    recent: e > addDays(today, -LAG_DAYS), // 末日が直近 2 日以内（値が確定していないことがある）
  };
}

// ── コホート表 ──────────────────────────────────────────────────────────
const isBand = (b) => b && ["median", "p10", "p90"].every((k) => Number.isFinite(b[k]));

// 読み込んだ JSON を検査して、月の一覧を昇順で持つ形にする。壊れていれば Error（読める文）
export function loadCohorts(json, { source = "bundled" } = {}) {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("cohort table is not an object");
  if (json.schema !== 1) throw new Error(`cohort table schema ${json.schema ?? "(none)"} is not supported (expected 1)`);
  const months = json.months && typeof json.months === "object" ? json.months : null;
  if (!months) throw new Error("cohort table has no `months`");
  const keys = Object.keys(months).sort();
  if (!keys.length) throw new Error("cohort table has no months");
  for (const k of keys) {
    const m = months[k];
    if (!/^\d{4}-\d{2}$/.test(k)) throw new Error(`cohort table: bad month key ${k}`);
    if (!m || !isBand(m.S) || !isBand(m.T)) throw new Error(`cohort table: month ${k} lacks S/T median,p10,p90`);
    if (!(m.S.p10 <= m.S.median && m.S.median <= m.S.p90) || !(m.T.p10 <= m.T.median && m.T.median <= m.T.p90)) throw new Error(`cohort table: month ${k} band is not ordered (p10 <= median <= p90)`);
    if (m.T.p10 < 0 || m.S.p10 < 0) throw new Error(`cohort table: month ${k} has negative values`);
  }
  // 月に穴があると cohortFor が「最後の月で代用」を返して黙る（低 #14）。連続していない表は読める文で拒否する
  const expected = monthsBetween(keys[0], keys.at(-1));
  if (expected.length !== keys.length) throw new Error(`cohort table: months are not contiguous (missing ${expected.filter((k) => !months[k]).join(", ")})`);
  return { ...json, source, monthKeys: keys, first: keys[0], last: keys.at(-1) };
}

// 月 m に使うコホート。表に無ければ端の月で代用し、その旨を flags に残す。
// flags は配列: 代用した月自身の印（thin / interpolated）と、代用したこと（before-table / after-table）の両方を持つ（中 #3）
export function cohortFor(cohorts, month) {
  const m = String(month).slice(0, 7);
  const pick = (k, extra) => ({ month: k, stats: cohorts.months[k], flags: [cohorts.months[k].flag ?? null, extra].filter(Boolean) });
  if (cohorts.months[m]) return pick(m, null);
  if (m < cohorts.first) return pick(cohorts.first, "before-table");
  return pick(cohorts.last, "after-table");
}

// ── 床 ────────────────────────────────────────────────────────────────
export const versionsInWindow = (versions, win) => versions.filter((v) => v.ms >= win.startMs && v.ms <= win.endMs);

const addBand = (a, b) => ({ median: a.median + b.median, p10: a.p10 + b.p10, p90: a.p90 + b.p90 });
const scaleBand = (b, k) => ({ median: b.median * k, p10: b.p10 * k, p90: b.p90 * k });
const ZERO = { median: 0, p10: 0, p90: 0 };

// zeroDays: 窓の中でレジストリ全体が 0 だった日（日付の配列。数を渡せば日数として扱う）。滴りはその日には付かない（実測にも無い）ので残りの日数に掛ける。
// created: 対象の time.created（ISO）。窓の中で対象が存在した日だけに滴りを掛ける（2 巡目 #28）。無ければ窓の全日
export function computeFloor({ cohorts, versions, window, zeroDays = 0, created = null }) {
  const endDay = window.end;
  const perVersion = versions.map((v) => {
    const c = cohortFor(cohorts, monthOf(v.time));
    // 版の公開日から窓の末日までの日数（公開日を含む）。4 日未満なら S のうちその日数に乗る割合だけを足す
    const daysToEnd = Math.max(0, dayDiff(ymd(Date.parse(v.time)), endDay) + 1);
    const share = daysToEnd >= INITIAL_DAYS ? 1 : S_SHARE_BY_DAYS[daysToEnd - 1] ?? 0;
    return { version: v.version, time: v.time, month: monthOf(v.time), cohortMonth: c.month, flags: c.flags, S: scaleBand(c.stats.S, share), share, daysToWindowEnd: Math.min(daysToEnd, INITIAL_DAYS) };
  });
  const initial = perVersion.reduce((acc, p) => addBand(acc, p.S), { ...ZERO });
  // 滴りの月: 窓内に版があれば最後の版の公開月、無ければ窓の末日の月（#26）
  const lastVersion = versions.length ? versions.reduce((a, b) => (b.ms > a.ms ? b : a)) : null;
  const dripMonth = lastVersion ? monthOf(lastVersion.time) : monthOf(parseYmd(endDay));
  const dripCohort = cohortFor(cohorts, dripMonth);
  // 対象が存在した窓内の日数（created の UTC 日から末日まで）。レジストリ全体が 0 の日はそのうちから引く
  const createdDay = created ? ymd(Date.parse(created)) : null;
  const firstDay = createdDay && createdDay > window.start ? createdDay : window.start;
  const existDays = createdDay && createdDay > endDay ? 0 : dayDiff(firstDay, endDay) + 1;
  const zeroCount = Array.isArray(zeroDays) ? zeroDays.filter((d) => d >= firstDay && d <= endDay).length : Number(zeroDays) || 0;
  const dripDays = Math.max(0, existDays - zeroCount);
  const drip = { month: dripMonth, cohortMonth: dripCohort.month, flags: dripCohort.flags, perDay: { ...dripCohort.stats.T }, days: dripDays, daysBeforeCreated: window.days - existDays, total: scaleBand(dripCohort.stats.T, dripDays) };
  const floor = addBand(initial, drip.total);
  const flags = [...new Set([...perVersion.flatMap((p) => p.flags), ...drip.flags])];
  // 使ったコホート月と、その月の n（thin の注記に月と件数を出すため。2 巡目 #29）
  const cohortsUsed = [...new Set([...perVersion.map((p) => p.cohortMonth), dripCohort.month])].sort().map((m) => ({ month: m, n: cohorts.months[m].n ?? null, flag: cohorts.months[m].flag ?? null }));
  return { perVersion, initial, drip, floor, flags, cohortsUsed };
}

// レジストリ全体が 0 の日: 窓の中で対象も参照パッケージ（npm）も 0 の日（中 #12）。参照が無ければ null（判定しない）
export function registryZeroDays(rangeDays, referenceDays) {
  if (!Array.isArray(referenceDays)) return null;
  const ref = new Map(referenceDays.map((d) => [d.day, Number(d.downloads) || 0]));
  return rangeDays.filter((d) => (Number(d.downloads) || 0) === 0 && ref.has(d.day) && ref.get(d.day) === 0).map((d) => d.day);
}

export function judge({ actual, floor, versionsInWindow }) {
  const excess = actual - floor.median;
  const threshold = floor.p90 - floor.median;
  const clearAt = CLEAR_MULTIPLIER * floor.p90;
  let verdict;
  if (actual >= clearAt && actual > floor.p90) verdict = "clearly-above";
  else if (excess <= threshold) verdict = "indistinguishable";
  else verdict = "above";
  return { verdict, excess, threshold, clearAt, pumping: versionsInWindow >= PUMPING_VERSIONS };
}

export const sumDownloads = (days) => days.reduce((n, d) => n + (Number(d.downloads) || 0), 0);

// 範囲 API が 404 を返したとき（packument はあるのに DL の記録がまだ無い＝公開直後）の代わり: 全日 0
export function zeroRange(window) {
  const days = [];
  for (let t = window.startMs; t <= window.endMs; t += DAY) days.push({ day: ymd(t), downloads: 0 });
  return { start: window.start, end: window.end, days, missing: 0, noRecords: true };
}

const round = (x, k = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** k) / 10 ** k : x);
const roundBand = (b) => ({ median: round(b.median), p10: round(b.p10), p90: round(b.p90) });

// 取ってきた材料（packument・日次 DL・窓・コホート表）から結果を組む
// reference: 参照パッケージの日次（レジストリ全体が 0 の日の検知用）。無ければ検知しない
export function analyze({ packument, range, window, cohorts, reference = null }) {
  const inWin = versionsInWindow(packument.versions, window);
  const zero = registryZeroDays(range.days, reference?.days ?? null);
  const f = computeFloor({ cohorts, versions: inWin, window, zeroDays: zero ?? 0, created: packument.created ?? null });
  const actual = sumDownloads(range.days);
  const j = judge({ actual, floor: f.floor, versionsInWindow: inWin.length });
  const notes = [];
  const beforeCreated = Boolean(packument.created && Date.parse(packument.created) > window.endMs);
  if (window.recent) notes.push("window-recent");
  if (beforeCreated) notes.push("window-before-created");
  // 窓の途中で作られた（#28）: 作られる前の日には滴りを付けない。末日近くの版は S を按分した
  if (!beforeCreated && f.drip.daysBeforeCreated > 0) notes.push("created-in-window");
  if (f.perVersion.some((p) => p.share < 1)) notes.push("version-near-window-end");
  if (range.noRecords) notes.push("no-download-records");
  if (range.missing) notes.push("series-incomplete");
  if (zero?.length) notes.push("registry-zero-days");
  if (f.flags.includes("after-table") || f.flags.includes("before-table")) notes.push("cohort-extrapolated");
  if (f.flags.includes("interpolated") || f.flags.includes("thin")) notes.push("cohort-thin");
  if (j.pumping) notes.push("pumping");
  // 床は下限（中 #9）: repository・README・複数版のあるパッケージはコホートより多くの自動 DL を集める。「床を超える」は弱い
  const likeCohort = packument.versions.length <= 1 && !packument.repository && !packument.hasReadme;
  notes.push(likeCohort ? "like-cohort" : "floor-is-lower-bound");
  return {
    package: packument.name,
    window: { start: window.start, end: window.end, days: window.days },
    actual,
    floor: roundBand(f.floor),
    excess: round(j.excess),
    verdict: j.verdict,
    thresholds: { indistinguishableUpTo: round(f.floor.p90), clearlyAboveFrom: round(j.clearAt) },
    versionsInWindow: inWin.length,
    totalVersions: packument.versions.length,
    pumpingSuspected: j.pumping,
    versions: f.perVersion.map((p) => ({ ...p, S: roundBand(p.S) })),
    initial: roundBand(f.initial),
    drip: { ...f.drip, perDay: roundBand(f.drip.perDay), total: roundBand(f.drip.total) },
    registryZeroDays: zero == null ? null : { count: zero.length, days: zero, reference: reference?.name ?? null },
    cohorts: { source: cohorts.source, generatedAt: cohorts.generatedAt ?? null, first: cohorts.first, last: cohorts.last, flags: f.flags, used: f.cohortsUsed },
    notes,
  };
}

// 月の並び（補間・表示用）
export const monthsBetween = (from, to) => {
  const out = [];
  for (let i = monthIndex(from); i <= monthIndex(to); i++) out.push(`${String(Math.floor(i / 12)).padStart(4, "0")}-${String((i % 12) + 1).padStart(2, "0")}`);
  return out;
};
