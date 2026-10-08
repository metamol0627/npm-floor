# npm-floor — field log (real data) / 実データで動かした記録

Run: 2026-09-18T12:24:21.537Z with npm-floor 0.1.0, cohort table generated 2026-09-18 (2024-01 .. 2026-07, overall n=563).
Everything below was fetched from npm's public APIs at run time (registry packument + downloads range). Nothing is fabricated; re-run with `npm run fieldlog` (needs `ship/out/control/cache.json` for section 1).

## 1. Control packages (20 throwaway packages, each measured on its own first 30 days)

These are the 20 single-version, repository-less practice packages this lab measured on 2026-09-13 for its own download-floor control (names and exact publish dates withheld on purpose; they are other people's practice uploads). Each is measured on day 0..29 from its own publish day. Design expectation: **18±2 of 20** `indistinguishable` — the threshold is the cohort's p90, so by construction about one throwaway package in ten lands `above` (expected 2, 95% range 0–4).

| # | published (month) | window | actual | floor median | floor p90 | verdict | notes |
|---|---|---|---|---|---|---|---|
| 1 | 2026-06 | day 0..29 | 144 | 147 | 175 | indistinguishable | registry-zero-days, cohort-thin |
| 2 | 2026-06 | day 0..29 | 125 | 147 | 175 | indistinguishable | registry-zero-days, cohort-thin |
| 3 | 2025-08 | day 0..29 | 73 | 72 | 84 | indistinguishable | cohort-thin |
| 4 | 2026-07 | day 0..29 | 170 | 149 | 183 | indistinguishable | registry-zero-days, cohort-thin |
| 5 | 2025-06 | day 0..29 | 77 | 65 | 75 | above | cohort-thin |
| 6 | 2025-03 | day 0..29 | 64 | 69 | 85 | indistinguishable | cohort-thin, floor-is-lower-bound |
| 7 | 2025-04 | day 0..29 | 86 | 73 | 87 | indistinguishable | cohort-thin |
| 8 | 2026-07 | day 0..29 | 92 | 149 | 183 | indistinguishable | registry-zero-days, cohort-thin, floor-is-lower-bound |
| 9 | 2025-10 | day 0..29 | 11 | 78 | 102 | indistinguishable | cohort-thin |
| 10 | 2026-06 | day 0..29 | 142 | 147 | 175 | indistinguishable | registry-zero-days, cohort-thin |
| 11 | 2024-04 | day 0..29 | 72 | 59 | 68 | above | cohort-thin |
| 12 | 2026-06 | day 0..29 | 132 | 147 | 175 | indistinguishable | registry-zero-days, cohort-thin |
| 13 | 2025-01 | day 0..29 | 75 | 77 | 90 | indistinguishable | cohort-thin |
| 14 | 2025-04 | day 0..29 | 28 | 73 | 87 | indistinguishable | cohort-thin |
| 15 | 2024-09 | day 0..29 | 78 | 72 | 80 | indistinguishable | cohort-thin |
| 16 | 2025-04 | day 0..29 | 75 | 73 | 87 | indistinguishable | cohort-thin |
| 17 | 2024-05 | day 0..29 | 64 | 58 | 75 | indistinguishable | cohort-thin, floor-is-lower-bound |
| 18 | 2024-08 | day 0..29 | 72 | 62 | 85 | indistinguishable | cohort-thin |
| 19 | 2025-01 | day 0..29 | 83 | 77 | 90 | indistinguishable | cohort-thin, floor-is-lower-bound |
| 20 | 2024-04 | day 0..29 | 60 | 59 | 68 | indistinguishable | cohort-thin, floor-is-lower-bound |

Tally: indistinguishable 18, above 2 of 20.

## 2. Well-known packages (default window)

Design expectation: 5/5 `clearly-above`.

| package | window | actual | floor median | floor p90 | versions in window | verdict | notes |
|---|---|---|---|---|---|---|---|
| left-pad | 2026-08-18 .. 2026-09-16 | 6,360,903 | 17 | 24 | 0 | clearly-above | registry-zero-days, cohort-extrapolated, cohort-thin, floor-is-lower-bound |
| chalk | 2026-08-18 .. 2026-09-16 | 1,906,327,739 | 17 | 24 | 0 | clearly-above | registry-zero-days, cohort-extrapolated, cohort-thin, floor-is-lower-bound |
| lodash | 2026-08-18 .. 2026-09-16 | 649,635,377 | 17 | 24 | 0 | clearly-above | registry-zero-days, cohort-extrapolated, cohort-thin, floor-is-lower-bound |
| express | 2026-08-18 .. 2026-09-16 | 482,331,266 | 143 | 176 | 1 | clearly-above | version-near-window-end, registry-zero-days, cohort-extrapolated, cohort-thin, floor-is-lower-bound |
| react | 2026-08-18 .. 2026-09-16 | 660,141,269 | 5,025 | 6,030 | 39 (pumping flag) | clearly-above | version-near-window-end, registry-zero-days, cohort-extrapolated, cohort-thin, pumping, floor-is-lower-bound |

## 3. Real, non-fixture packages (default window)

`ask-later` and `clip-layer-tidy` are this lab's own packages, published on 2026-09-15/16 (if the window ends before they existed, npm has no download records yet and the row shows a brand-new package: counted as 0). `download-stats` is one of the adjacent tools named in DESIGN.md §4 (it displays the official counts and does not subtract a floor). Adjacent tools whose counts are indistinguishable from the floor are not named here on purpose.

| package | window | actual | floor median | floor p90 | versions in window | verdict | notes |
|---|---|---|---|---|---|---|---|
| ask-later | 2026-08-18 .. 2026-09-16 | 142 | 112 | 135 | 1 | above | created-in-window, version-near-window-end, registry-zero-days, cohort-extrapolated, cohort-thin, floor-is-lower-bound |
| clip-layer-tidy | 2026-08-18 .. 2026-09-16 | 15 | 122 | 146 | 1 | indistinguishable | created-in-window, version-near-window-end, registry-zero-days, cohort-extrapolated, cohort-thin, floor-is-lower-bound |
| download-stats | 2026-08-18 .. 2026-09-16 | 2,534,375 | 17 | 24 | 0 | clearly-above | registry-zero-days, cohort-extrapolated, cohort-thin, floor-is-lower-bound |

## 4. A package that publishes nightly builds

`typescript` publishes a nightly build every day, so it has 20+ versions in any 30-day window. The `version pumping` flag is a hint, not an accusation: nightly builds trigger it legitimately.

| package | window | actual | floor median | floor p90 | versions in window | verdict | notes |
|---|---|---|---|---|---|---|---|
| typescript | 2026-08-18 .. 2026-09-16 | 1,051,829,036 | 3,630 | 4,357 | 28 (pumping flag) | clearly-above | version-near-window-end, registry-zero-days, cohort-extrapolated, cohort-thin, pumping, floor-is-lower-bound |

## How to read the verdicts / 判定の読み方

- `indistinguishable` (床と区別できない): actual <= floor p90. The count can be explained by mirrors and scanners alone.
- `above` (床を超える): actual > floor p90 but < 3 x floor p90.
- `clearly-above` (明確に床の上): actual >= 3 x floor p90.
- "Excess over the floor" is not a count of real users; it is what the floor does not explain. / 「超過」は本当の利用者数ではありません。

Verdict labels in Japanese: indistinguishable = 床と区別できない, above = 床を超える, clearly-above = 明確に床の上.
