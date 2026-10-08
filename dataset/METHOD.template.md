# npm download-floor dataset — method

Generated **{{generatedAt}}** by `npm-floor {{version}} calibrate` (random seed {{seed}}). Publish months **{{first}} .. {{last}}**, **{{n}}** packages measured.

日本語の要約は末尾にあります。

## 1. What is in this ZIP

| file | what |
|---|---|
| `series.csv` | one row per package-day: `id, month, weekday, day_offset, downloads, excluded`. `day_offset` runs from −1 (the day before the publish day) to +45 (or less for the youngest cohorts). `weekday` is the UTC weekday of the publish (0 = Sunday). `excluded` is empty for the {{n}} series in the table and `sustained-use` ({{excludedSustained}}) or `description-cluster` ({{excludedDescriptionCluster}}) for the {{seriesExcluded}} series that were measured but excluded from it (§3, rules ② and ③′) — so `series.*` hold {{seriesTotal}} series, {{n}} of which are in the table. Package names are removed; `id` is `c0001` … in publish order |
| `series.json` | the same series as an array of objects (`{ id, month, weekday, start_offset, excluded, downloads[] }`) |
| `cohorts.json` | the monthly table the free CLI ships (`S`, `T`, `w30`, `peak` per month with median / p10 / p90, `n`, flags) — this file *is* what `npx npm-floor` uses |
| `cohorts.csv` | the same table, flat |
| `floor-trend.svg` | S (first-4-day downloads per version) and T (daily drip) by month, median with p10–p90 band |
| `METHOD.md` | this file |

## 2. Why a floor

npm's download counts are "naive by design" (npm, 2014): mirrors, CI caches, security scanners and download-count pumps all count. A package nobody uses still shows dozens to a few hundred downloads in its first month, and every new version adds a fresh spike. To say anything about a count you need the number that would appear *with zero users*. That is the floor, and this dataset is a measurement of it, month by month, from packages that by their own description have no users.

## 3. Population and sampling

1. **Search.** The npm registry search API (`/-/v1/search`) was queried for {{terms}} phrases that practice uploads use to describe themselves ("my first package", "test package", "hello world npm", …; the full list is in `cohorts.json → method` and in the free CLI's `lib/calibrate.mjs`). Each phrase was paged {{pages}} times × 250 results. Distinct unscoped names: **{{searched}}**.
2. **Pre-filter from the search result** (no API call): no repository link; latest publish at least 37 days before the run; latest publish month within {{first}} .. {{last}}. Kept: **{{afterPrefilter}}**.
3. **Conditions checked on the registry document** (one request per candidate): exactly one published version, no `repository` field, `time.created` at least 37 days before the run, and not a placeholder by its own text (rule ① below). At most {{maxPerDay}} packages per publish day were taken (rule ③). Candidates were taken in a seeded random order inside each publish month, filling the months round-robin until each had **{{perMonth}}** measured packages or ran out of candidates. Checked: **{{checked}}**; measured: **{{measured}}** (of which **{{seriesExcluded}}** were then excluded by rules ② and ③′, leaving **{{n}}** in the table).

Why these conditions: a single version means nobody bothered to update it; no repository means no development activity to attract visitors; the self-description means the author says it is a practice upload. 37 days guarantees that days 0..30 are final (npm's daily counts settle within a few days).

**Exclusion rules** (added in the second table build, 2026-09-18, after a design audit found that the first build was contaminated):

- **① Placeholder text** — dropped **{{excludedPlaceholder}}** candidates (search-result stage and registry-document stage together). The search phrases ("placeholder package", "dummy package", "test package" …) systematically pick up packages that exist *to keep a name from being taken*: dependency-confusion placeholders published by security teams and bug-bounty hunters, reserved names, typosquat proofs-of-concept, intentionally broken packages. They describe themselves as "do not use", yet they are the *target* of real traffic (CI, scanners, mistaken installs) — the opposite of a zero-user package. A candidate is excluded when its name, description, keywords or version name matches `{{placeholderRe}}`. In the first build, 24 of the 42 packages with a drip above 3/day were of this kind, and one or two of them per month set the p90 of T.
- **② Sustained use** — **{{excludedSustained}}** measured packages whose mean daily downloads on day 15..30 were **≥ {{sustainedT}}** were kept in `series.*` (marked `excluded = sustained-use`) but left out of the table. Uncontaminated months have a T p90 of 0.3–1.3 and the overall median is 0.31/day, so 3/day is roughly ten times the typical drip: something is fetching the package on purpose. These are real (if tiny) tools, classroom servers, or placeholders whose text did not match rule ①.
- **③ Same-day clusters** — **{{excludedDayCluster}}** candidates were skipped because {{maxPerDay}} packages from the same UTC publish day were already in the month. Practice uploads from one classroom go out together and are not independent samples (in the first build 5 of the 6 lowest-S packages of one month were published on the same day).
- **③′ Same-description batches** — **{{excludedDescriptionCluster}}** measured packages were excluded (marked `excluded = description-cluster` in `series.*`) because {{minDescriptionCluster}} or more packages published in the same month carried the same description and at least half of them had already been excluded by rule ②: one batch-published campaign, whose remaining members are the same traffic just under the 3/day line. Generic descriptions shared by independent people ("test package", "my first package") have no sustained-use members and are not touched. In this build the rule caught 2 of 16 numbered packages published in 2026-02 with four descriptions between them (12 were in sustained use); before the rule those 2 set that month's T p90 at 1.22 instead of 0.25.

## 4. Series

For each measured package, `api.npmjs.org/downloads/range/{start}:{end}/{name}` from **day −1** to **day +45** (UTC calendar days relative to the UTC date of `time.created`). Days after (run date − 2) were not fetched because npm's newest one or two days can still be 0. All requests were read-only, at most 1 per second, with a descriptive User-Agent.

**Registry-zero days.** npm's daily counts are occasionally 0 *for the whole registry* (not only for the newest two days — 2026-09 alone had four such days two weeks after the fact). A calendar day on which the sum over all measured series was 0 while at least 10 series covered it is treated as missing rather than as zero: **{{zeroDaysCount}}** such day(s) in this dataset ({{zeroDaysList}}; also listed in `cohorts.json → method.zeroDays`). They are removed from the denominators of S, T and w30 (a sum over n days with k missing is scaled by n / (n − k)); the raw rows in `series.*` keep the 0. For the 4-day spike S this proportional scaling over-corrects when the missing day is day 0 (about 86% of S falls on day 0, 93% on days 0–1); in this build it touches a single package (2026-07, day 2 missing: 146 → 194.7) and not that month's p90.

## 5. Statistics (per package → per month)

| symbol | per package | per month |
|---|---|---|
| **S** | sum of downloads on day 0..3 (4 days including the publish day) | median, p10, p90 |
| **T** | mean downloads per day on day 15..30 | median, p10, p90 |
| **w30** | sum on day 0..29 (the 30-day window from the publish day) | median, p10, p90 |
| **peak** | the largest single day in day 0..29 and its offset | median |

Quantiles use linear interpolation between order statistics (R type 7). A month with fewer than {{perMonth}} packages is flagged `thin` (its own values are used); a month with fewer than {{thinBelow}} is flagged `interpolated` (S/T/w30 interpolated linearly from the nearest months with enough packages; `interpolatedFrom` names them). **In this build {{thinMonths}} of the {{monthCount}} months are `thin`** (n per month {{nMin}}–{{nMax}}, median {{nMedian}}): the exclusion rules cost about a third of the candidates the {{terms}} phrases yield, so a thin month's p90 rests on its top 1–3 packages. Treat the band of the thinnest months accordingly.

The CLI's floor for a window is `Σ S(month of each version published in the window) × share + T(month of the last version in the window, else of the window's last day) × days the package existed in the window`, with the p10/p90 of each term added to make the band (`share` < 1 only when the window ends less than 4 days after the version: 0.86 / 0.93 / 0.97 for 1 / 2 / 3 days, the cohort's medians). Applied to the {{n}} cohort packages themselves (one version, its own 30 days) the formula puts 10.5% `above` the p90 — 0–33% by month, worst in the thinnest months.

## 6. Caveats — read before using the numbers

- **This is a floor for packages nobody uses, of the plainest kind.** Real packages with a README, a repository, and several versions draw more automated traffic (scanners follow links; mirrors re-fetch on every publish). The floor is a lower bound; a count near it says "explainable by automation", a count under it says nothing special.
- **The floor moves.** Compare the months in `cohorts.json`; the median first-month total roughly doubled between 2024 and mid-2026 in this lab's earlier measurement. Do not carry a single number across years.
- **UTC day boundaries.** A publish late in the UTC day puts most of its first-day traffic on day 1; that is why S covers 4 days rather than 1.
- **npm's numbers can be revised** for the newest days, and the API returns 404 for packages that have never been downloaded at all (extremely rare for anything older than a day).
- **Self-selection.** Packages were found through their own description; practice packages that describe themselves differently are not represented. The exclusion rules in §3 cut the other way: a package that calls itself a placeholder is out even if nobody ever fetched it.
- **The drip decays.** T is measured on day 15..30. On day 31..45 the median drip of the same packages is about 0.7× that (measured on the first build's 802 full-length series). A floor for a window long after the last publish, computed as T × days, is therefore on the high side — conservative for the verdict.
- **Identities were removed on purpose.** The packages are other people's practice uploads; do not try to re-identify them.

## 7. Reproduce or extend

```
npx npm-floor calibrate --out ./calib --from 2024-01 --per-month 30
npx npm-floor <package> --cohorts ./calib/cohorts.json
```

A full run takes about an hour at the default 1 request/second: the search alone is ~400 requests and 8–10 minutes (the search API rate-limits and the tool waits), then ~50 minutes of checks. The run is resumable: re-run with the same `--out` to continue. The tool and its cohort table are MIT-licensed and free on npm; this ZIP is the raw series plus the write-up.

## 8. Terms of use

- For your own use: research, articles, dashboards, internal reports.
- You may publish aggregates, charts and excerpts derived from this data with the attribution "npm-floor dataset, {{generatedAtDate}}".
- Please do not redistribute `series.csv` / `series.json` as files, and do not attempt to re-identify the packages.
- No warranty. The numbers are what npm's public API returned on the dates above.

---

## 日本語の要約

- 中身: 練習用パッケージ **{{n}}** 件（{{first}}〜{{last}} 公開・単一版・repository 無し）の日次 DL（公開日 −1〜+45 日・匿名化）、月別コホート表（`cohorts.json` は無料 CLI が同梱するものと同一）、推移のグラフ、この手順書。
- 取り方: レジストリ検索 {{terms}} 語 × {{pages}} 段 → 検索結果で前処理 → packument で 3 条件（単一版・repository 無し・公開 37 日以上前）→ 範囲 API で日次。読むだけ・1 req/秒以下。所要は約 1 時間（検索 8〜10 分＋照合約 50 分）。
- 除外規則（2026-09-18 の 2 回目の作成で追加）: ① 名前・description・keywords・版名が「placeholder / dependency confusion / security / reserved / squat / do not use …」に当たるもの（名前を取られないために置くセキュリティ用プレースホルダ。実トラフィックの標的であり「利用者ゼロ」の反対側）{{excludedPlaceholder}} 件。② day 15..30 の平均 DL が {{sustainedT}} 件/日以上（汚染の無い月の p90 ≤ 1.3 の約 10 倍）{{excludedSustained}} 件——系列は `excluded = sustained-use` の印つきで残し、表には入れない。③ 同じ公開日から {{maxPerDay}} 件まで（同じ教室から同日に出た練習パッケージは独立でない）{{excludedDayCluster}} 件を飛ばした。③′ 同じ月に同じ description が {{minDescriptionCluster}} 件以上あり、その半数以上を ② が捕まえていれば一括公開の 1 キャンペーンとみなし、残り {{excludedDescriptionCluster}} 件も `excluded = description-cluster` の印つきで表から外した（2026-02 の連番名 16 件）。`series.*` は {{seriesTotal}} 系列で、表に入っているのは {{n}} 件。**この作成では {{monthCount}} か月のうち {{thinMonths}} か月が `thin`**（月あたり n {{nMin}}〜{{nMax}}・中央値 {{nMedian}}）。
- レジストリ全体が 0 の日（npm 側の集計の欠落。被覆 10 系列以上で合計 0）{{zeroDaysCount}} 日は分母から外した（`cohorts.json → method.zeroDays`）。
- S = 公開後 4 日（day 0..3）の合計、T = day 15..30 の平均／日、w30 = day 0..29 の合計。月ごとに中央値・p10・p90（R type 7）。n < {{perMonth}} は `thin`、n < {{thinBelow}} は前後から補間して `interpolated`。滴りは 31〜45 日目には約 0.7 倍に減るので、最後の公開からずっと後の窓の床は高め（判定には保守側）。レジストリ 0 の日の分母補正（n／(n − k) 倍）は S に掛かると過大（S の約 86% は day 0 に乗る）——この作成で当たるのは 1 件で、その月の p90 には乗っていない。CLI の床は `Σ S(版の月) × 按分 + T(窓内の最後の版の月。版が無ければ末日の月) × 窓内で存在した日数`。コホート自身に当てると 10.5%（月別 0〜33%）が p90 を超える。
- 注意: これは「誰も使っていない最も素朴なパッケージ」の床であり下限。README・repo・複数版を持つ普通のパッケージはもっと巡回を集める。床は年々上がる。UTC 日境界。名前は意図して消してある（他人の練習パッケージ）。
- 利用条件: 自分の研究・記事・ダッシュボード用。集計値・図・抜粋は出典「npm-floor dataset, {{generatedAtDate}}」を添えて公開可。生の系列ファイルの再配布と再識別はしない。無保証。
