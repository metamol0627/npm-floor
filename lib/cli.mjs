// CLI。引数の解釈・文言・終了コード。ネットワークは api.mjs、計算は floor.mjs、コホート表の作成は calibrate.mjs。
// 壊れた入力（無い・空・形式違い・未来の窓・存在しないパッケージ・ネットワーク断・429）は、スタックトレースではなく
// 「error: …」1〜2 行で exit 1。
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname, resolve } from "node:path";
import { PKG_VERSION, ApiError, getPackument, getDailyRange, getReferenceRange, REFERENCE_PACKAGE } from "./api.mjs";
import { resolveWindow, loadCohorts, analyze, zeroRange, DEFAULT_WINDOW_DAYS, PUMPING_VERSIONS, CLEAR_MULTIPLIER } from "./floor.mjs";
import { runCalibrate, DEFAULT_PER_MONTH, DEFAULT_FROM } from "./calibrate.mjs";
import { fmtInt } from "./dates.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const BUNDLED_COHORTS = join(here, "..", "data", "cohorts.json");

class UserError extends Error {}

// ── 引数 ──────────────────────────────────────────────────────────────
const VALUE_OPTS = new Set(["window", "end", "start", "lang", "cohorts", "out", "per-month", "from", "to", "rate", "max-checks", "seed"]);
const FLAG_OPTS = new Set(["json", "help", "version", "quiet"]);
const camel = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === "--") {
      positional.push(...argv.slice(i + 1).map(String));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (FLAG_OPTS.has(key)) {
        if (eq > 0) throw new UserError(`--${key} takes no value`);
        opts[key] = true;
        continue;
      }
      if (!VALUE_OPTS.has(key)) throw new UserError(`unknown option --${key}`);
      const val = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (val === undefined || val === "" || (eq < 0 && String(val).startsWith("--"))) throw new UserError(`--${key} needs a value`);
      opts[camel(key)] = String(val);
      continue;
    }
    if (a === "-h") opts.help = true;
    else if (a === "-v" || a === "-V") opts.version = true;
    else if (a.startsWith("-") && a.length > 1) throw new UserError(`unknown option ${a}`);
    else positional.push(a);
  }
  return { positional, opts };
}

const intOpt = (v, name, { min = 1, max = Infinity } = {}) => {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`${name} must be an integer${max < Infinity ? ` from ${min} to ${max}` : ` >= ${min}`} (got ${v})`);
  return n;
};

// 言語: --lang > NPM_FLOOR_LANG > LC_ALL / LC_MESSAGES / LANG > OS のロケール（Windows には LANG が無い。低 #20）
export const osLocale = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale ?? "";
  } catch {
    return "";
  }
};
export function pickLang(opt, env = {}, locale = osLocale) {
  const v = (opt ?? env.NPM_FLOOR_LANG ?? env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG ?? locale() ?? "").toLowerCase();
  if (opt && !/^(en|ja)$/.test(v)) throw new UserError(`--lang must be en or ja (got ${opt})`);
  return v.startsWith("ja") ? "ja" : "en";
}

// ── 文言 ──────────────────────────────────────────────────────────────
const USAGE = `usage:
  npm-floor <package> [--window <days>] [--end YYYY-MM-DD | --start YYYY-MM-DD] [--json] [--lang en|ja] [--cohorts <file>]
  npm-floor explain [--json] [--cohorts <file>]
  npm-floor calibrate --out <dir> [--from YYYY-MM] [--to YYYY-MM] [--per-month N] [--rate <req/s>] [--max-checks N] [--seed N] [--quiet]
  npm-floor --version | --help

  default window: the ${DEFAULT_WINDOW_DAYS} days ending 2 days ago (UTC). --window is the length in days.
  cohort table: --cohorts <file>, else $NPM_FLOOR_COHORTS, else the bundled data/cohorts.json
  calibrate --to default: the last month whose last day is at least 37 days ago (the search alone takes ~8 minutes)`;

const VERDICT = {
  en: { indistinguishable: "INDISTINGUISHABLE FROM THE FLOOR", above: "ABOVE THE FLOOR", "clearly-above": "CLEARLY ABOVE THE FLOOR" },
  ja: { indistinguishable: "床と区別できない", above: "床を超える", "clearly-above": "明確に床の上" },
};
const FLAG = {
  en: { thin: "thin", interpolated: "interpolated", "before-table": "before the table (first month used)", "after-table": "after the table (last month used)" },
  ja: { thin: "n が少ない", interpolated: "補間", "before-table": "表より前（最初の月で代用）", "after-table": "表より後（最後の月で代用）" },
};
const T = {
  en: {
    error: "error",
    window: "window",
    days: (n) => `${n} days, UTC`,
    actual: "downloads (actual)",
    floor: "floor (mirrors + scanners)",
    band: "p10..p90",
    excess: "excess over the floor",
    versions: "versions published in window",
    total: (n) => `(${n} versions in total)`,
    verdict: "verdict",
    why: {
      indistinguishable: (r) => `actual <= floor p90 (${fmtInt(r.thresholds.indistinguishableUpTo)})`,
      above: (r) => `actual > floor p90 (${fmtInt(r.thresholds.indistinguishableUpTo)}) but < ${CLEAR_MULTIPLIER} x p90 (${fmtInt(r.thresholds.clearlyAboveFrom)}); about 1 in 10 packages with no users also lands here`,
      "clearly-above": (r) => `actual >= ${CLEAR_MULTIPLIER} x floor p90 (${fmtInt(r.thresholds.clearlyAboveFrom)})`,
    },
    belowMedian: "(below the floor median)",
    pumping: (n) => `! version pumping suspected: ${n} versions published in the window (>= ${PUMPING_VERSIONS}). Each version alone draws ~100-150 automated downloads.`,
    how: "how the floor was built",
    initial: "initial spike per version",
    noneInWindow: "none in window",
    initialSum: (r) => `${r.versionsInWindow} version(s) -> ${fmtInt(r.initial.median)}   [${fmtInt(r.initial.p10)} .. ${fmtInt(r.initial.p90)}]`,
    versionRow: (v) => `${v.version}  ${v.time.slice(0, 10)}  S(${v.cohortMonth}) = ${fmtInt(v.S.median)}  [${fmtInt(v.S.p10)} .. ${fmtInt(v.S.p90)}]${v.share < 1 ? `  (${v.daysToWindowEnd} day(s) before the window ends: ${Math.round(v.share * 100)}% of S)` : ""}${flagText(v.flags, "en", (s) => `  (${s})`)}`,
    more: (n) => `... and ${n} more`,
    drip: "daily drip",
    dripRow: (r) => `${r.drip.perDay.median.toFixed(2)} /day x ${r.drip.days} days = ${fmtInt(r.drip.total.median)}   [${fmtInt(r.drip.total.p10)} .. ${fmtInt(r.drip.total.p90)}]   (cohort ${r.drip.cohortMonth}${r.versionsInWindow ? ", month of the last version" : ""}${flagText(r.drip.flags, "en", (s) => `, ${s}`)})`,
    table: "cohort table",
    tableRow: (r) => `${r.cohorts.source}${r.cohorts.generatedAt ? `, generated ${r.cohorts.generatedAt.slice(0, 10)}` : ""} (${r.cohorts.first} .. ${r.cohorts.last}; \`npm-floor explain\` prints it)`,
    notes: "notes",
    note: {
      "window-recent": "the window ends within the last 2 days; npm's daily counts for the newest 1-2 days can still be 0 (data lag). Use --end to move it back.",
      "window-before-created": "the package was created after this window ends, so every count in it is 0 by construction.",
      "created-in-window": (r) => `the package was created inside this window; the ${r.drip.daysBeforeCreated} day(s) before that carry no drip (the floor covers the ${r.drip.days} days it existed).`,
      "version-near-window-end": "a version was published less than 4 days before the window ends, so only the share of its initial spike that falls inside the window was added.",
      "no-download-records": "npm has no download records for this package yet (just published?); every day was counted as 0.",
      "series-incomplete": "npm returned no data for some days in the window (counted as 0).",
      "registry-zero-days": (r) => `npm's counts were 0 for the whole registry on ${r.registryZeroDays.count} day(s) in this window (${r.registryZeroDays.days.join(", ")}; checked against ${r.registryZeroDays.reference}). The actual count is short by about that share; the drip was applied to the remaining ${r.drip.days} days.`,
      "cohort-extrapolated": "some months fall outside the cohort table; the nearest month's values were used.",
      "cohort-thin": (r) => `the cohort month(s) used have fewer packages than the target of 30 (${thinList(r)}); the band is less reliable there.`,
      "floor-is-lower-bound": "this package has a repository, a README or more than one version, so it draws more automated traffic than the cohort (single version, no repository) did. The floor is a lower bound here; \"above the floor\" is weak evidence.",
      "like-cohort": "single version, no repository, no README: the same conditions as the cohort the floor was measured on.",
    },
    always: '"excess" is what the floor does not explain. It is not a count of real users.',
    notFound: (n) => `package not found on npm: ${n}`,
    noVersions: (n, unpub) => `${n} has no published versions on npm${unpub ? " (it was unpublished)" : ""}; there is nothing to measure`,
    network: (m) => `could not reach npm's API (${m}). Check the network connection or proxy and try again.`,
    rateLimited: "npm's API is rate-limiting this client (HTTP 429) even after retries. Wait a minute and try again.",
    server: (m) => `npm's API returned a server error (${m}) after retries. Try again later.`,
    badRequest: (m) => `npm's API rejected the request: ${m}`,
    cohortsUnreadable: (p, m) => `cohort table could not be read (${p}): ${m}`,
    explainHead: (c) => `npm-floor ${PKG_VERSION} cohort table (${c.source}${c.generatedAt ? `, generated ${c.generatedAt.slice(0, 10)}` : ""})`,
    explainCols: "month     n   S median   p10    p90   T/day  p10   p90   30d median  flag",
    formula: `floor(window) = sum over versions published in the window of S(month of the version) + T(month of the last version in the window, else of the window's last day) x days the package existed in the window
  S = downloads in the first 4 days after a publish (median / p10 / p90 of throwaway single-version packages published that month; pro-rated when the window ends within those 4 days)
  T = mean daily downloads on days 15..30 after a publish (same cohorts)
  actual <= floor p90 -> indistinguishable; above that -> above; actual >= ${CLEAR_MULTIPLIER} x floor p90 -> clearly above; >= ${PUMPING_VERSIONS} versions in window -> version pumping suspected`,
    explainFoot: (months) => `  note: S p10 far below the median in ${months.join(", ")} comes from classroom batches (several practice uploads from one day that got almost no initial spike); it does not affect the p90 the verdict uses`,
    calibDone: (r) => `calibrate: ${r.done ? "finished" : "stopped early (re-run the same --out to continue)"}; ${r.checks} packages checked this run; cohorts.json written to ${r.outDir}`,
    calibUse: (p) => `use it with: npm-floor <package> --cohorts ${p}`,
  },
  ja: {
    error: "エラー",
    window: "窓",
    days: (n) => `${n} 日・UTC`,
    actual: "実測 DL",
    floor: "床（ミラー＋スキャナ）",
    band: "p10〜p90",
    excess: "超過（実測 − 床）",
    versions: "窓内に公開した版",
    total: (n) => `（全 ${n} 版）`,
    verdict: "判定",
    why: {
      indistinguishable: (r) => `実測 ≤ 床 p90（${fmtInt(r.thresholds.indistinguishableUpTo)}）`,
      above: (r) => `実測 > 床 p90（${fmtInt(r.thresholds.indistinguishableUpTo)}）だが ${CLEAR_MULTIPLIER} × p90（${fmtInt(r.thresholds.clearlyAboveFrom)}）未満。利用者ゼロのパッケージの約 1 割もここに入る`,
      "clearly-above": (r) => `実測 ≥ ${CLEAR_MULTIPLIER} × 床 p90（${fmtInt(r.thresholds.clearlyAboveFrom)}）`,
    },
    belowMedian: "（床の中央値より下）",
    pumping: (n) => `！ version pumping の疑い: 窓内に ${n} 版を公開（${PUMPING_VERSIONS} 版以上）。版を出すだけで 1 版あたり 100〜150 件の自動 DL が付きます。`,
    how: "床の内訳",
    initial: "版ごとの初動",
    noneInWindow: "窓内に版なし",
    initialSum: (r) => `${r.versionsInWindow} 版 → ${fmtInt(r.initial.median)}   [${fmtInt(r.initial.p10)} 〜 ${fmtInt(r.initial.p90)}]`,
    versionRow: (v) => `${v.version}  ${v.time.slice(0, 10)}  S(${v.cohortMonth}) = ${fmtInt(v.S.median)}  [${fmtInt(v.S.p10)} 〜 ${fmtInt(v.S.p90)}]${v.share < 1 ? `（窓の末日まで ${v.daysToWindowEnd} 日: S の ${Math.round(v.share * 100)}%）` : ""}${flagText(v.flags, "ja", (s) => `（${s}）`)}`,
    more: (n) => `… ほか ${n} 版`,
    drip: "滴り",
    dripRow: (r) => `${r.drip.perDay.median.toFixed(2)} 件/日 × ${r.drip.days} 日 = ${fmtInt(r.drip.total.median)}   [${fmtInt(r.drip.total.p10)} 〜 ${fmtInt(r.drip.total.p90)}]  （コホート ${r.drip.cohortMonth}${r.versionsInWindow ? "・最後の版の月" : ""}${flagText(r.drip.flags, "ja", (s) => `・${s}`)}）`,
    table: "コホート表",
    tableRow: (r) => `${r.cohorts.source === "bundled" ? "同梱" : r.cohorts.source}${r.cohorts.generatedAt ? `・作成 ${r.cohorts.generatedAt.slice(0, 10)}` : ""}（${r.cohorts.first} 〜 ${r.cohorts.last}。npm-floor explain で表示）`,
    notes: "注意",
    note: {
      "window-recent": "窓の末日が直近 2 日以内です。npm の日次は直近 1〜2 日が 0 で返ることがあります（--end で末日を前にできます）。",
      "window-before-created": "このパッケージは窓の末日より後に作られたので、窓の中の値は必ず 0 です。",
      "created-in-window": (r) => `このパッケージは窓の途中で作られました。それより前の ${r.drip.daysBeforeCreated} 日には滴りを付けていません（床は存在した ${r.drip.days} 日分）。`,
      "version-near-window-end": "窓の末日まで 4 日未満のところで公開された版があるので、初動のうち窓に入る割合だけを足しています。",
      "no-download-records": "npm にこのパッケージの DL 記録がまだありません（公開直後？）。全日 0 として扱いました。",
      "series-incomplete": "窓の一部の日は npm がデータを返しませんでした（0 として数えています）。",
      "registry-zero-days": (r) => `この窓のうち ${r.registryZeroDays.count} 日（${r.registryZeroDays.days.join("・")}）は npm の日次がレジストリ全体で 0 でした（${r.registryZeroDays.reference} で照合）。実測はその分だけ過小で、滴りは残りの ${r.drip.days} 日に掛けています。`,
      "cohort-extrapolated": "コホート表の範囲外の月があり、いちばん近い月の値で代用しました。",
      "cohort-thin": (r) => `使ったコホート月の件数が目標の 30 件に届いていません（${thinList(r)}）。その分だけ帯の信頼性は下がります。`,
      "floor-is-lower-bound": "このパッケージは repository・README・複数版のどれかを持ちます。コホート（単一版・repository 無し）より多くの自動 DL を集めるはずで、床は下限です。「床を超える」は弱い証拠です。",
      "like-cohort": "単一版・repository 無し・README 無し。床を測ったコホートと同じ条件です。",
    },
    always: "「超過」は床で説明できない分であって、本当の利用者数ではありません。",
    notFound: (n) => `npm にそのパッケージはありません: ${n}`,
    noVersions: (n, unpub) => `${n} には公開された版がありません${unpub ? "（unpublish 済み）" : ""}。測るものがありません`,
    network: (m) => `npm の API に接続できません（${m}）。ネットワークかプロキシを確認して再実行してください。`,
    rateLimited: "npm の API がレート制限中です（HTTP 429。再試行しても続く）。1 分ほど待って再実行してください。",
    server: (m) => `npm の API がサーバーエラーを返しました（${m}。再試行済み）。時間をおいて再実行してください。`,
    badRequest: (m) => `npm の API が要求を拒否しました: ${m}`,
    cohortsUnreadable: (p, m) => `コホート表が読めません（${p}）: ${m}`,
    explainHead: (c) => `npm-floor ${PKG_VERSION} コホート表（${c.source === "bundled" ? "同梱" : c.source}${c.generatedAt ? `・作成 ${c.generatedAt.slice(0, 10)}` : ""}）`,
    explainCols: "月        n   S 中央値   p10    p90   T/日   p10   p90   30日 中央値  印",
    formula: `床(窓) = Σ[窓内に公開した版] S(その版の月) + T(窓内の最後の版の月。版が無ければ窓の末日の月) × 窓内でパッケージが存在した日数
  S = 公開後 4 日の DL（その月に公開された練習用・単一版パッケージの中央値／p10／p90。窓の末日がその 4 日の途中なら按分）
  T = 公開 15〜30 日目の平均 DL／日（同じコホート）
  実測 ≤ 床 p90 → 床と区別できない／それ以上 → 床を超える／実測 ≥ ${CLEAR_MULTIPLIER} × 床 p90 → 明確に床の上／窓内 ${PUMPING_VERSIONS} 版以上 → version pumping の疑い`,
    explainFoot: (months) => `  注: ${months.join("・")} の S p10 が中央値から大きく離れているのは、同じ日に同じ教室から出て初動がほぼ付かなかった練習パッケージのためです。判定に使う p90 には効きません`,
    calibDone: (r) => `calibrate: ${r.done ? "完了" : "途中で止まりました（同じ --out で再実行すると続きから）"}。この実行で ${r.checks} 件を照合。cohorts.json を ${r.outDir} に書きました`,
    calibUse: (p) => `使い方: npm-floor <package> --cohorts ${p}`,
  },
};

const FLAG_SHORT = { thin: "thin", interpolated: "interp", "before-table": "before", "after-table": "after" };
// thin／補間の注記に月と件数を出す（2 巡目 #29）: 「2026-07: 22」の並び。n が無い表なら月だけ
const thinList = (r) =>
  (r.cohorts.used ?? [])
    .filter((c) => c.flag === "thin" || c.flag === "interpolated")
    .map((c) => `${c.month}: ${c.n ?? "?"}${c.flag === "interpolated" ? " (interpolated)" : ""}`)
    .join(", ") || "-";
// flags（配列）→ 表示。空なら ""
function flagText(flags, lang, wrap) {
  const list = (flags ?? []).map((f) => FLAG[lang][f] ?? f);
  return list.length ? wrap(list.join(lang === "ja" ? "・" : ", ")) : "";
}

// 表示幅: 全角（East Asian Wide / Fullwidth）と絵文字は 2、結合文字は 0（低 #10。--lang ja の列ずれ）
export function strWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || (c >= 0x300 && c <= 0x36f) || c === 0x200b || c === 0xfe0f) continue;
    w +=
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd)
        ? 2
        : 1;
  }
  return w;
}

// ── 実行 ──────────────────────────────────────────────────────────────
async function loadCohortsFrom(path, lang) {
  const p = resolve(path);
  let text;
  try {
    text = await readFile(p, "utf8");
  } catch (e) {
    throw new UserError(T[lang].cohortsUnreadable(p, e.code === "ENOENT" ? "file not found" : e.code === "EISDIR" ? "that is a directory, not a file" : e.message));
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new UserError(T[lang].cohortsUnreadable(p, `not JSON (${e.message})`));
  }
  try {
    return loadCohorts(json, { source: path === BUNDLED_COHORTS ? "bundled" : p.replace(/\\/g, "/") });
  } catch (e) {
    throw new UserError(T[lang].cohortsUnreadable(p, e.message));
  }
}

function pad(s, n, right = false) {
  s = String(s);
  const fill = " ".repeat(Math.max(0, n - strWidth(s)));
  return right ? fill + s : s + fill;
}

export function renderResult(r, lang = "en") {
  const t = T[lang];
  const L = [];
  const label = (k, v, extra = "") => L.push(`${pad(k, 30)}${pad(v, 14, true)}${extra ? `   ${extra}` : ""}`);
  L.push(`npm-floor ${PKG_VERSION}  ${r.package}`);
  L.push(`${pad(t.window, 30)}${r.window.start} .. ${r.window.end}  (${t.days(r.window.days)})`);
  L.push("");
  label(t.actual, fmtInt(r.actual));
  label(t.floor, fmtInt(r.floor.median), `${t.band}  ${fmtInt(r.floor.p10)} .. ${fmtInt(r.floor.p90)}`);
  label(t.excess, fmtInt(r.excess), r.excess < 0 ? t.belowMedian : "");
  label(t.versions, String(r.versionsInWindow), t.total(r.totalVersions));
  L.push(`${pad(t.verdict, 30)}${VERDICT[lang][r.verdict]}   ${t.why[r.verdict](r)}`);
  if (r.pumpingSuspected) L.push(`  ${t.pumping(r.versionsInWindow)}`);
  L.push("");
  L.push(t.how);
  L.push(`  ${pad(t.initial, 28)}${r.versionsInWindow ? t.initialSum(r) : t.noneInWindow}`);
  const shown = r.versions.slice(0, 10);
  for (const v of shown) L.push(`    ${t.versionRow(v)}`);
  if (r.versions.length > shown.length) L.push(`    ${t.more(r.versions.length - shown.length)}`);
  L.push(`  ${pad(t.drip, 28)}${t.dripRow(r)}`);
  L.push(`  ${pad(t.table, 28)}${t.tableRow(r)}`);
  L.push("");
  L.push(t.notes);
  for (const n of r.notes) if (t.note[n]) L.push(`  - ${typeof t.note[n] === "function" ? t.note[n](r) : t.note[n]}`);
  L.push(`  - ${t.always}`);
  return L.join("\n");
}

export function renderExplain(c, lang = "en") {
  const t = T[lang];
  const L = [t.explainHead(c), ""];
  if (c.method) {
    const m = (lang === "ja" && c.method.ja) || c.method;
    L.push(`  ${lang === "ja" ? "母集団" : "population"}: ${m.population ?? c.method.population ?? "-"}`);
    L.push(`  ${lang === "ja" ? "抽出条件" : "conditions"}: ${m.conditions ?? c.method.conditions ?? "-"}`);
    if (c.overall?.n) L.push(`  ${lang === "ja" ? "全体" : "overall"}: n=${c.overall.n}  S median ${fmtInt(c.overall.S.median)}  T/day ${c.overall.T.median.toFixed(2)}  30d median ${fmtInt(c.overall.w30.median)}`);
    if (c.method.excluded) {
      const ex = c.method.excluded;
      L.push(`  ${lang === "ja" ? "除外" : "excluded"}: placeholder ${ex.placeholder ?? 0} / sustained-use ${ex.sustainedUse ?? 0}${ex.dayCluster != null ? ` / day-cluster ${ex.dayCluster}` : ""}${ex.descriptionCluster != null ? ` / description-cluster ${ex.descriptionCluster}` : ""}${c.method.zeroDays?.length ? `   ${lang === "ja" ? "レジストリ全体が 0 の日" : "registry-zero days"}: ${c.method.zeroDays.length}` : ""}`);
    }
    L.push("");
  }
  L.push(t.explainCols);
  for (const m of c.monthKeys) {
    const x = c.months[m];
    L.push(
      `${m}  ${pad(x.n ?? "-", 3, true)}   ${pad(fmtInt(x.S.median), 8, true)} ${pad(fmtInt(x.S.p10), 5, true)}  ${pad(fmtInt(x.S.p90), 5, true)}   ${pad(x.T.median.toFixed(2), 5, true)} ${pad(x.T.p10.toFixed(2), 5, true)} ${pad(x.T.p90.toFixed(2), 5, true)}   ${pad(x.w30 ? fmtInt(x.w30.median) : "-", 10, true)}  ${x.flag ? FLAG_SHORT[x.flag] ?? x.flag : ""}`.trimEnd()
    );
  }
  L.push("", t.formula);
  // S の p10 が中央値の 1/3 未満の月（同日の教室クラスター由来。2 巡目 #35）
  const lowP10 = c.monthKeys.filter((m) => c.months[m].flag !== "interpolated" && c.months[m].S.p10 * 3 < c.months[m].S.median);
  if (lowP10.length) L.push(t.explainFoot(lowP10));
  return L.join("\n");
}

function describeError(e, lang) {
  const t = T[lang];
  if (e instanceof ApiError) {
    if (e.kind === "network") return t.network(e.message);
    if (e.kind === "rate-limited") return t.rateLimited;
    if (e.kind === "server") return t.server(e.message);
    if (e.kind === "bad-request") return t.badRequest(e.message);
    return e.message;
  }
  return e?.message ?? String(e);
}

async function cmdMeasure(name, opts, { lang, env, fetchImpl, now, sleepImpl, out }) {
  const t = T[lang];
  const days = intOpt(opts.window, "--window", { min: 1, max: 540 });
  if (opts.start && opts.end && days) throw new UserError("give at most two of --start, --end, --window");
  const window = resolveWindow({ start: opts.start ?? null, end: opts.end ?? null, days, now });
  const cohorts = await loadCohortsFrom(opts.cohorts ?? env.NPM_FLOOR_COHORTS ?? BUNDLED_COHORTS, lang);
  const net = { fetchImpl, ...(sleepImpl ? { sleepImpl } : {}) };
  let packument;
  try {
    packument = await getPackument(name, net);
  } catch (e) {
    if (e instanceof ApiError && e.kind === "not-found") throw new UserError(t.notFound(name));
    throw e;
  }
  if (!packument.versions.length) throw new UserError(t.noVersions(name, packument.unpublished));
  let range;
  try {
    range = await getDailyRange(name, window.start, window.end, net);
  } catch (e) {
    // packument はあるのに範囲 API が 404 → DL の記録がまだ無い（公開直後に実測）。全日 0 として扱い、注記する
    if (e instanceof ApiError && e.kind === "not-found") range = zeroRange(window);
    else throw e;
  }
  // レジストリ全体が 0 の日の検知（中 #12）: 対象が 0 の日があるときだけ参照パッケージを 1 要求。失敗しても計測は続く
  const reference = range.days.some((d) => !(Number(d.downloads) > 0)) && name !== REFERENCE_PACKAGE ? await getReferenceRange(window.start, window.end, net) : null;
  const r = analyze({ packument, range, window, cohorts, reference });
  out(opts.json ? JSON.stringify(r, null, 2) : renderResult(r, lang));
  return 0;
}

async function cmdExplain(opts, { lang, env, out }) {
  const c = await loadCohortsFrom(opts.cohorts ?? env.NPM_FLOOR_COHORTS ?? BUNDLED_COHORTS, lang);
  if (opts.json) {
    const { monthKeys, first, last, ...rest } = c;
    out(JSON.stringify(rest, null, 2));
  } else out(renderExplain(c, lang));
  return 0;
}

async function cmdCalibrate(opts, { lang, fetchImpl, now, sleepImpl, out }) {
  const t = T[lang];
  if (!opts.out) throw new UserError("calibrate needs --out <dir> (where the cache and cohorts.json go)");
  const rate = opts.rate == null ? 1 : Number(opts.rate);
  if (!(rate > 0 && rate <= 5)) throw new UserError(`--rate must be between 0 and 5 requests per second (got ${opts.rate})`);
  const r = await runCalibrate({
    outDir: resolve(opts.out),
    from: opts.from ?? DEFAULT_FROM,
    to: opts.to ?? null,
    perMonth: intOpt(opts.perMonth, "--per-month") ?? DEFAULT_PER_MONTH,
    rate,
    maxChecks: intOpt(opts.maxChecks, "--max-checks") ?? Infinity,
    seed: intOpt(opts.seed, "--seed", { min: 0 }),
    now,
    fetchImpl,
    sleepImpl,
    log: opts.quiet ? () => {} : out,
  });
  const rows = Object.entries(r.months).map(([m, n]) => `${m} ${n}`).join("  ");
  out(`months: ${rows}`);
  out(t.calibDone(r));
  out(t.calibUse(join(r.outDir, "cohorts.json").replace(/\\/g, "/")));
  return r.done ? 0 : 2;
}

export async function runCli(argv, io = {}) {
  const { stdout = process.stdout, stderr = process.stderr, env = process.env, fetchImpl = fetch, now = undefined, sleepImpl = undefined, locale = osLocale } = io;
  const out = (s) => stdout.write(s + "\n");
  const err = (s) => stderr.write(s + "\n");
  let parsed;
  let lang = "en";
  try {
    parsed = parseArgs(argv);
    lang = pickLang(parsed.opts.lang, env, locale);
  } catch (e) {
    err(`${T[lang].error}: ${e.message}`);
    err(USAGE);
    return 1;
  }
  const { positional, opts } = parsed;
  if (opts.version) {
    out(PKG_VERSION);
    return 0;
  }
  if (opts.help || !positional.length) {
    (opts.help ? out : err)(USAGE);
    return opts.help ? 0 : 1;
  }
  const ctx = { lang, env, fetchImpl, now: now ?? Date.now(), sleepImpl, out };
  try {
    const [cmd, ...rest] = positional;
    if (cmd === "explain") {
      if (rest.length) throw new UserError(`explain takes no package name (got ${rest.join(" ")})`);
      return await cmdExplain(opts, ctx);
    }
    if (cmd === "calibrate") {
      if (rest.length) throw new UserError(`calibrate takes no package name (got ${rest.join(" ")})`);
      return await cmdCalibrate(opts, ctx);
    }
    if (rest.length) throw new UserError(`one package at a time (got ${positional.join(" ")})`);
    return await cmdMeasure(cmd, opts, ctx);
  } catch (e) {
    err(`${T[lang].error}: ${describeError(e, lang)}`);
    return 1;
  }
}
