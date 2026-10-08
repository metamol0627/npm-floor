# How the floor is measured (free, minimal version) / 床の測り方（無料の最小版）

This is the short version of the method behind `data/cohorts.json`. The paid dataset ships the full write-up (`METHOD.md`) together with the raw daily series; this page is enough to judge whether the numbers apply to your package.

## What is being measured

The number of downloads an npm package receives **with zero users** — from registry mirrors, CI caches, security scanners and similar automation. npm's counts are "naive by design" and do not separate these. `npm-floor` calls that number the *floor* and subtracts it from a 30-day window.

## Where the numbers come from

1. **Search** the registry for packages that describe themselves as practice uploads (32 phrases such as "my first package", "test package", "hello world npm"; the list is in `lib/calibrate.mjs`), 12 pages × 250 results per phrase, unscoped names only.
2. **Keep** only packages with **exactly one version**, **no `repository` field**, published **at least 37 days** before the run (so the first 30 days are final). A single version and no repository mean nobody maintained or promoted them; their own description says they are practice uploads.
3. **Exclude** what the search also drags in but is *not* a zero-user package (rules added on 2026-09-18 after a design audit found the first table contaminated):
   - ① **placeholder text** — the name, description, keywords or version name says placeholder / dependency confusion / security / reserved / typosquat / "do not use" / intentionally broken. These are names held by security teams and bug-bounty hunters to keep them from being taken; they are the *target* of real CI, scanner and mistaken-install traffic. In the first table, 24 of the 42 packages with a drip above 3/day were of this kind and one or two of them per month set the p90 of T.
   - ② **sustained use** — mean downloads per day on day 15..30 ≥ **3** (about ten times the cohort median of 0.31; clean months have a T p90 of 0.3–1.3). Kept in the paid raw series with an `excluded` mark, not in the table.
   - ③ **same-day clusters** — at most 3 packages from the same UTC publish day (a classroom's uploads are not independent samples).
   - ③′ **same-description batches** — 3 or more packages in one month with the same description, at least half of which rule ② caught, are one batch-published campaign; the rest are excluded too (in the 2026-09-18 table: 16 numbered packages from 2026-02, 12 in sustained use, 2 just under 3/day that were setting that month's T p90).
   The counts are in `cohorts.json → method.excluded` and on the `excluded:` line of `explain`.
4. **Fetch the daily downloads** from day −1 to day +45 around the UTC date of `time.created`, for up to 30 packages per publish month (seeded random order inside each month).
5. **Per package**: `S` = downloads on day 0..3 (the first 4 days, publish day included); `T` = mean downloads per day on day 15..30. Calendar days on which npm's counts were 0 for the whole registry (0 across ≥ 10 measured series — npm has such days; `method.zeroDays` lists them) are removed from the denominators.
   **Per month**: median, p10 and p90 of S and T. Months with fewer than 30 packages are flagged `thin`; months with fewer than 5 are `interpolated` from their neighbours. The last month of the table is the last month whose last day is at least 37 days before the run, so it is never half-filled.

`npx npm-floor explain` prints the table with `n`, the flags and the exclusion counts for every month.

## How the floor for a window is built

```
floor(window) = Σ over versions published in the window: S(month of that version) × share
              + T(month of the last version in the window; if none, month of the window's last day)
                × days in the window on which the package existed
```

`share` is 1 unless the window ends less than 4 days after the version (then 0.86 / 0.93 / 0.97 for 1 / 2 / 3 days — the cohort's median share of S on those days). The drip month follows the last version in the window so that a package published late in a month is compared with its own month's cohort (a thin table's T p90 jumps up to 3× between neighbouring months). `p10` and `p90` of each term are added the same way to form the band. The verdict compares the actual count with the band: at or below the p90 → *indistinguishable from the floor*; above it → *above the floor* (by construction about one zero-user package in ten lands here too — applied to the cohort itself the formula gives 10.5%, 0–33% by month); at or above 3 × p90 → *clearly above the floor*. 20 or more versions inside the window raises the *version pumping* hint (each version alone draws roughly 100–150 automated downloads; nightly builds trigger this legitimately). If the window contains registry-wide zero days (the target and the reference package `npm` are both 0), the drip is applied to the remaining days and the output says so.

## What the numbers do not say

- **They are a lower bound.** The cohort is the plainest kind of unused package. A real package with a README, a repository and releases attracts more automated traffic. "Above the floor" does not mean "has users"; "indistinguishable" means the count is explainable by automation alone. The output tells you which side your package is on (`floor-is-lower-bound` / `like-cohort`).
- **The floor rises over time.** Use the month the version was published in, not a fixed number, and re-run `calibrate` when the table gets old.
- **The drip decays.** T is day 15..30; on day 31..45 the same packages drip about 0.7× as much. A floor long after the last publish is on the high side (conservative).
- **UTC days, settled data.** The newest one or two days from npm can still be zero; the default window ends two days ago for that reason. npm also has occasional days on which the whole registry reads 0 (four in 2026-09 alone); the tool detects and reports them.
- **Read-only, gentle on the API.** `calibrate` makes about 400 search requests plus one or two per candidate, never more than one per second.

## Reproduce

```
npx npm-floor calibrate --out ./calib            # about an hour (search 8-10 min, checks ~50 min); resumable with the same --out
npx npm-floor <package> --cohorts ./calib/cohorts.json
```

---

## 日本語

- **測っているもの**: 利用者がゼロのパッケージに付く DL（ミラー・CI のキャッシュ・セキュリティスキャナ等）。npm の数字はこれを分けない。これを「床」と呼び、30 日窓から差し引く。
- **出所**: レジストリ検索（練習用パッケージが自称する 32 語 × 12 段 × 250 件・スコープ無し）→ **単一版・`repository` 無し・公開 37 日以上前** のものだけ → 公開日の −1〜+45 日の日次 DL を月ごとに最大 30 件（乱数種つきの順）。
- **除外**（2026-09-18 追加）: ① 名前・description・keywords・版名が placeholder / dependency confusion / security / reserved / typosquat / do not use 等（名前を取られないために置くセキュリティ用の名前。実トラフィックの標的で「利用者ゼロ」ではない）。② day 15..30 の平均が 3 件/日以上（コホート中央値 0.31 の約 10 倍）——生の系列には印つきで残し、表には入れない。③ 同じ公開日から 3 件まで。③′ 同じ月に同じ description が 3 件以上あり半数以上を ② が捕まえていれば、一括公開の 1 キャンペーンとして残りも除外（2026-02 の連番名 16 件）。件数は `explain` の `excluded:` 行。
- **統計**: 1 件ごとに S = day 0..3 の合計、T = day 15..30 の平均／日。レジストリ全体が 0 の日（npm 側の欠落）は分母から外す。月ごとに中央値・p10・p90。30 件未満は `thin`、5 件未満は前後から補間して `interpolated`。表の最終月は「末日が実行日の 37 日以上前である最後の月」（半分しか埋まらない月を最終月にしない）。`npx npm-floor explain` で表が見える。
- **床の式**: `Σ[窓内に公開した版] S(その版の月) × 按分 + T(窓内の最後の版の月。版が無ければ窓の末日の月) × 窓内で存在した日数`。按分は版から窓の末日まで 4 日未満のときだけ（1／2／3 日で 0.86／0.93／0.97）。帯も同じ足し方。実測 ≤ 床 p90 → 床と区別できない／それ以上 → 床を超える（作りからして利用者ゼロの約 1 割もここに入る。コホート自身に当てると 10.5%・月別 0〜33%）／実測 ≥ 3 × p90 → 明確に床の上。窓内 20 版以上で version pumping の注意。
- **言えないこと**: 下限である（README・repo・複数版のある普通のパッケージはもっと巡回を集める。出力の注記 `floor-is-lower-bound` / `like-cohort` でどちら側か分かる）。「床の上」は「利用者がいる」ではない。床は年々上がる。滴りは 31〜45 日目に約 0.7 倍に減る（古い窓の床は高め＝保守側）。直近 1〜2 日の値は未確定。
- **再現**: `npx npm-floor calibrate --out ./calib`（約 1 時間。検索 8〜10 分＋照合約 50 分・同じ --out で再開可）→ `--cohorts ./calib/cohorts.json`。
