# npm-floor — how many downloads would your package get if nobody used it?

Every npm package gets downloads from registry mirrors, CI caches and security scanners, even when nobody uses it. `npm-floor` tells you that number for your package (the *floor*) and whether your actual count stands out from it.

```
npx npm-floor <your-package>
```

No install, no account, no token. Node.js 20 or newer. Read-only, zero dependencies, MIT. 日本語の README は [`README.ja.md`](https://unpkg.com/npm-floor@0.1.1/README.ja.md) にあります。

Sold separately: the **download-floor dataset** (¥980) behind the monthly table — [sales page](https://lab-cws.pages.dev/npm-floor/). The CLI is free.

## What you get

Real output for `left-pad`, 2026-09-18:

<!-- example:left-pad (real output, 2026-09-18) -->
```
npm-floor 0.1.0  left-pad
window                        2026-08-18 .. 2026-09-16  (30 days, UTC)

downloads (actual)                 6,360,903
floor (mirrors + scanners)                17   p10..p90  9 .. 24
excess over the floor              6,360,886
versions published in window               0   (15 versions in total)
verdict                       CLEARLY ABOVE THE FLOOR   actual >= 3 x floor p90 (73)

how the floor was built
  initial spike per version   none in window
  daily drip                  0.67 /day x 26 days = 17   [9 .. 24]   (cohort 2026-07, thin, after the table (last month used))
  cohort table                bundled, generated 2026-09-18 (2024-01 .. 2026-07; `npm-floor explain` prints it)

notes
  - npm's counts were 0 for the whole registry on 4 day(s) in this window (2026-09-03, 2026-09-07, 2026-09-08, 2026-09-15; checked against npm). The actual count is short by about that share; the drip was applied to the remaining 26 days.
  - some months fall outside the cohort table; the nearest month's values were used.
  - the cohort month(s) used have fewer packages than the target of 30 (2026-07: 22); the band is less reliable there.
  - this package has a repository, a README or more than one version, so it draws more automated traffic than the cohort (single version, no repository) did. The floor is a lower bound here; "above the floor" is weak evidence.
  - "excess" is what the floor does not explain. It is not a count of real users.
```
<!-- /example:left-pad -->

Read the `verdict` line. There are three answers:

| verdict | meaning |
|---|---|
| `INDISTINGUISHABLE FROM THE FLOOR` | automation alone explains your count |
| `ABOVE THE FLOOR` | more than the floor, but not by much — weak evidence |
| `CLEARLY ABOVE THE FLOOR` | at least 3× the floor's upper band |

`floor` is the median with its p10–p90 band; `excess` is actual minus the floor median. The rest of the output shows how the floor was built and anything that makes it less reliable for this package.

## Usage

**1. Measure a package**

```
npx npm-floor <package>
```

Default window: the 30 days ending 2 days ago (npm's newest days can still read 0). Scoped names (`@scope/name`) work the same way.

**2. Get JSON**

```
npx npm-floor <package> --json
```

Same content as the table: `actual`, `floor {median,p10,p90}`, `excess`, `verdict` (`indistinguishable` / `above` / `clearly-above`), `thresholds`, `versionsInWindow`, `notes[]` and the breakdown. Exit code 0.

**3. Choose the window**

```
npx npm-floor <package> --window 7                       # the 7 days ending 2 days ago
npx npm-floor <package> --end 2026-08-31                 # the 30 days ending on that day
npx npm-floor <package> --start 2026-08-01 --window 31   # a fixed window
npx npm-floor <package> --start 2026-08-01 --end 2026-08-31
```

`--window` is 1–540 days. Give at most two of `--start` / `--end` / `--window`.

**4. See where the floor comes from**

```
npx npm-floor explain
```

Prints the bundled table: for each publish month since 2024-01, how many downloads a throwaway package (one version, no repository, self-described "my first package" / "test package" …) got in its first 4 days and per day afterwards. That is the floor.

Other flags: `--lang en|ja` (or `NPM_FLOOR_LANG`; a Japanese OS locale prints Japanese by default), `--cohorts <file>` to use your own table (see *Rebuild the table* below), `--help`, `--version`.

## Where the floor comes from, in short

npm's download counts are "naive by design" — they do not separate people from automation. A package nobody uses still gets dozens to a hundred-odd downloads in its first month, and every version you publish adds another ~100–150.

`npm-floor` ships a table measured from real throwaway packages, per publish month: `S` = downloads in the first 4 days after a publish, `T` = downloads per day on days 15–30. For your package it adds one `S` for every version you published inside the window plus `T` for every day the package existed in the window, and compares your actual count against the p90 of that sum. Because the table is per month, the floor moves with npm's own traffic (the first-month median roughly doubled between 2024 and mid-2026).

The full method is in [`docs/method.md`](https://unpkg.com/npm-floor@0.1.1/docs/method.md) (ships in the package); real runs against 20 control packages, 5 well-known packages and a nightly-build package are in [`docs/field-log.md`](https://unpkg.com/npm-floor@0.1.1/docs/field-log.md).

---

## Details

Everything below is for readers who want to check the numbers. You do not need it to run the tool.

### What the number means and does not mean

- **"Excess over the floor" is not a count of real users.** It is the part of the count that the floor does not explain. Nothing in npm's public data can tell people from bots.
- **The floor is a lower bound.** It comes from the plainest possible unused packages. A real package with a README, a repository and several releases attracts *more* automated traffic (scanners follow links, mirrors re-fetch on every publish). "Above the floor" therefore does not mean "has users"; the output says so (`floor-is-lower-bound`).
- **The floor moves.** The bundled table is per publish month; versions published outside its range use the first or last month and the output says so. Re-run `calibrate` when the table gets old.
- Days are UTC calendar days, as npm's API returns them.

### How the floor is computed

```
floor(window) = Σ over versions published inside the window:  S(month the version was published) × share
              + T(month of the last version in the window; if none, month of the window's last day)
                × days in the window on which the package existed

S(m) = downloads in days 0..3 after a publish (4 days, publish day included) — median / p10 / p90 of the
       throwaway packages published in month m
share = 1, unless the window ends less than 4 days after the version: then the part of S that falls on
        the first 1 / 2 / 3 days (0.86 / 0.93 / 0.97, the cohort's medians)
T(m) = mean downloads per day on days 15..30 after a publish — same cohort
```

The p10 and p90 of each term are added the same way to form the band. The drip month follows the last version in the window rather than the window's last day so that a package published late in a month is compared with its own month's cohort. Days before the package was created carry no drip; a version published in the window's last days only contributes the share of its spike that falls inside the window.

| verdict | condition |
|---|---|
| `indistinguishable` | actual ≤ floor p90 |
| `above` | floor p90 < actual < 3 × floor p90 |
| `clearly-above` | actual ≥ 3 × floor p90 |

Adding per-version p90s is deliberately conservative (the true p90 of a sum of independent terms is smaller), so the tool errs on the side of "indistinguishable". By construction about one throwaway package in ten lands above the p90 of its own cohort: applying the formula to the 563 cohort packages themselves puts **59 = 10.5%** `above` (per month 0–33%; the worst months have 9–12 packages). Of the 20 control packages in `docs/field-log.md`, 18 come out `indistinguishable` and 2 `above` (by 2 and 4 downloads) — the expected 2.

### The bundled table

<details>
<summary><code>npx npm-floor explain</code> (real output, 2026-09-18)</summary>

<!-- example:explain (real output, 2026-09-18) -->
```
npm-floor 0.1.0 cohort table (bundled, generated 2026-09-18)

  population: npm registry search, 32 terms x 12 pages x 250 (unscoped names only)
  conditions: single version / no repository field / published at least 37 days before the run / not a placeholder by its own text / drip T < 3 per day / at most 3 packages per publish day / not the rest of a same-description batch whose members are in sustained use
  overall: n=563  S median 64  T/day 0.31  30d median 75
  excluded: placeholder 600 / sustained-use 25 / day-cluster 110 / description-cluster 2   registry-zero days: 11

month     n   S median   p10    p90   T/day  p10   p90   30d median  flag
2024-01   29         56    53     66    0.25  0.13  0.38           65  thin
2024-02   26         60    54     69    0.31  0.19  0.44           72  thin
2024-03   24         56    47     64    0.38  0.25  0.44           65  thin
2024-04   24         50    45     57    0.31  0.25  0.38           63  thin
2024-05   23         49    43     62    0.31  0.19  0.44           64  thin
2024-06   18         51    47     61    0.31  0.25  0.44           64  thin
2024-07   22         60    50     68    0.50  0.25  0.62           77  thin
2024-08   17         53    49     73    0.31  0.19  0.40           72  thin
2024-09   21         66    58     71    0.19  0.06  0.31           77  thin
2024-10   12         65    61     71    0.19  0.13  0.25           73  thin
2024-11   17         64    59     68    0.25  0.13  0.40           73  thin
2024-12   28         64    59     70    0.38  0.25  0.52           76  thin
2025-01   21         64    61     67    0.44  0.13  0.75           78  thin
2025-02   16         63    56     72    0.19  0.13  0.28           68  thin
2025-03   17         59    49     66    0.33  0.14  0.63           72  thin
2025-04   10         52    34     59    0.69  0.50  0.95           76  thin
2025-05   11         50    43     54    0.56  0.44  0.88           67  thin
2025-06   22         50    45     56    0.50  0.26  0.63           71  thin
2025-07   14         66    60     69    0.31  0.14  0.36           76  thin
2025-08   27         66    61     70    0.19  0.10  0.46           75  thin
2025-09   17         69    65     73    0.19  0.13  0.38           76  thin
2025-10   22         75    10     97    0.10  0.07  0.19           83  thin
2025-11    9         90    83    108    0.15  0.06  0.55          119  thin
2025-12   16         89    87     99    0.29  0.19  0.47          103  thin
2026-01   13         85    74    100    0.31  0.20  0.38          103  thin
2026-02   14         87    79    103    0.19  0.13  0.25           99  thin
2026-03   11         91    88    105    0.44  0.25  0.63          109  thin
2026-04    9        116    94    126    0.50  0.38  0.93          128  thin
2026-05   17        131   110    153    0.56  0.25  0.78          146  thin
2026-06   14        125    42    140    0.77  0.54  1.19          144  thin
2026-07   22        130    24    156    0.67  0.34  0.94          156  thin

floor(window) = sum over versions published in the window of S(month of the version) + T(month of the last version in the window, else of the window's last day) x days the package existed in the window
  S = downloads in the first 4 days after a publish (median / p10 / p90 of throwaway single-version packages published that month; pro-rated when the window ends within those 4 days)
  T = mean daily downloads on days 15..30 after a publish (same cohorts)
  actual <= floor p90 -> indistinguishable; above that -> above; actual >= 3 x floor p90 -> clearly above; >= 20 versions in window -> version pumping suspected
  note: S p10 far below the median in 2025-10, 2026-07 comes from classroom batches (several practice uploads from one day that got almost no initial spike); it does not affect the p90 the verdict uses
```
<!-- /example:explain -->

</details>

What it says (2026-09-18 run): **563 packages over 31 publish months** (9–29 per month, median 17). **Every month has fewer than 30 and is flagged `thin`**, so the p90s rest on 1–3 packages in the thinnest months. Overall a throwaway package gets a median of **64 downloads in its first 4 days** (p10 49, p90 108), then **0.31 per day** (p90 0.63), for a median of **75 in its first 30 days**. The floor has risen: the first-4-day median was ≈ 55 in early 2024, ≈ 90 in late 2025 and ≈ 125–130 in mid 2026. With this table, a package with no version in the default window of the 2026-09-18 run reads "indistinguishable" up to about **24 downloads** and "clearly above" from about 73.

One row per publish month: `n` packages measured, `S` (median / p10 / p90), `T` (per day), the 30-day total, and a flag — `thin` (fewer than 30 packages) or `interp` (fewer than 5; interpolated from the neighbouring months). `explain --json` prints the table itself. Package names are not in the table on purpose (they are other people's practice uploads).

**What is and is not in the cohort.** The search phrases ("placeholder package", "test package", …) also drag in packages that exist *to keep a name from being taken* — dependency-confusion placeholders, reserved names, typosquat proofs-of-concept. They call themselves "do not use", yet they are the *target* of real CI and scanner traffic. `calibrate` excludes them by their own text, drops any package still fetched 3+ times a day on days 15–30, takes at most 3 packages from one publish day, and treats same-description batches as one campaign. The counts are on the `excluded:` line of `explain`; the rules and their history are in `docs/method.md`.

**Registry-wide zero days.** npm's daily API occasionally reports 0 for the *whole registry* on a day (2026-09 alone had four). When the target reads 0 on a day, the tool fetches the same window for the reference package `npm` (one extra request); days on which both are 0 are reported as `registry-zero-days`, and the drip is applied to the remaining days. `calibrate` removes such days from the cohort's denominators.

**Version pumping.** 20 or more versions published inside the window adds the line `! version pumping suspected`. Each version alone draws roughly 100–150 automated downloads (Tenable, May 2026: "download pumping"), so a burst of releases inflates a count without a single user. Packages that publish nightly builds trigger this legitimately — it is a hint, not an accusation.

**Notes** the output can add: `window-recent` (the window ends within the last 2 days; counts may still change), `window-before-created` (the package was created after the window ends, so 0 by construction), `created-in-window` (days before creation carry no drip), `version-near-window-end` (only the in-window share of that version's spike was added), `no-download-records` (on the registry, but npm has no download records yet — every day counts as 0, exit code 0), `series-incomplete` (npm returned no data for some days; counted as 0), `registry-zero-days`, `cohort-extrapolated` (a month outside the table; nearest month used), `cohort-thin` (a `thin` / `interpolated` month was used; the note names the month and its package count), `floor-is-lower-bound` (repository, README or more than one version) or `like-cohort` (single version, no repository, no README: the same conditions the floor was measured on), `pumping`.

### Rebuild the table yourself (optional, about an hour)

```
npx npm-floor calibrate --out ./calib
npx npm-floor <package> --cohorts ./calib/cohorts.json
```

`calibrate` searches the registry for 32 phrases that practice uploads use to describe themselves (12 pages × 250 results each), keeps unscoped packages with **exactly one version, no `repository` field, published at least 37 days ago, whose text does not say placeholder / security / reserved / typosquat / "do not use"**, takes at most 3 per publish day, fetches each one's daily downloads from day −1 to day +45 around its publish day, drops the ones still fetched **3 or more times a day on days 15–30** (kept in the raw series with an `excluded` mark), and writes `cohorts.json` with per-month S / T / 30-day totals for up to 30 packages per month (seeded random order inside each month). Options: `--from YYYY-MM` (default 2024-01), `--to YYYY-MM` (default: the last month whose last day is at least 37 days ago), `--per-month N`, `--rate <req/s>` (default 1, max 5), `--max-checks N`, `--seed N`, `--quiet`.

Timing: the search alone is ~400 requests and takes **8–10 minutes** (the search API answers 429 now and then; the tool waits), then the checks take ~50 minutes. It never sends more than `--rate` requests per second, retries HTTP 429 / 5xx with backoff, and saves its progress every 20 candidates, so **re-running with the same `--out` continues where it stopped** (exit code 2 = stopped early, re-run to continue; 0 = done). It does not write anything outside `--out`. `--cohorts <file>` (or `NPM_FLOOR_COHORTS`) then replaces the bundled `data/cohorts.json`.

### When it stops (broken input)

The command prints `error: …` (one or two lines, no stack trace) and exits with code 1 when:

- the package does not exist on npm, or has no published versions (unpublished)
- the name is not a valid npm package name, or more than one name is given
- a date is not `YYYY-MM-DD` / not a calendar date, the window ends in the future, `--end` is before `--start`, `--window` is not an integer from 1 to 540 or does not match `--start`/`--end`
- an option is unknown or lacks its value; `--lang` is not `en` / `ja`
- the cohort table (`--cohorts`, `NPM_FLOOR_COHORTS` or the bundled file) is missing, not JSON, or not a valid table (the reason is printed)
- npm's API cannot be reached (network / proxy / timeout), keeps answering 429 after retries, or returns a server error after retries — the message says which and what to do
- Node.js is older than 20 (the one-line message needs Node 14.8 or newer; older than that fails on the syntax of the entry file)

`calibrate` additionally refuses to run without `--out`, and stops (after saving its progress) on a network failure or persistent 429.

### Limits and what has not been verified

- Verified on Windows 11 with Node 24 only. macOS / Linux and Node 20 / 22 have not been run (standard library only, so they are expected to work).
- The bundled table covers the publish months printed by `explain`; months outside it use the nearest end month (`cohort-extrapolated`). In the 2026-09-18 table every month is `thin` (n 9–29): the exclusion rules cost about a third of the sample. Filling the months back to 30 needs more search phrases (planned for 0.2); until then the band in the thinnest months (2025-11: 9, 2026-04: 9) rests on very few packages.
- The bands are plain quantiles (R type 7), not trimmed. The p10 of `S` drops to single digits in a few months because some practice uploads get almost no initial spike (often several from one classroom on one day; `explain` names those months in a footnote).
- The verdict's false-`above` rate is not exactly one in ten: 10.5% overall on the cohort itself but 0–33% by month. A month with 9–12 packages (2024-10, 2025-04, 2025-05, 2025-11, 2026-03, 2026-04) is where an `above` verdict deserves the least weight.
- Registry-zero days are removed from the cohort's denominators by scaling (n / (n − k)). For the 4-day spike `S` this over-corrects when the missing day is day 0; in the bundled table it touches one package (2026-07, day 2 missing) and not that month's p90.
- The drip `T` is measured on days 15–30 and decays afterwards (about 0.7× on days 31–45), so the floor for a window long after the last publish is on the high side — conservative for the verdict.
- No breakdown by user agent (npm's API does not offer one), and the tool does not try to estimate one.
- npm's daily counts for the newest days can be revised (the default window already ends two days ago).
- The control cohort is self-selected: packages that describe themselves as practice uploads. Practice packages that say nothing are not represented; packages that call themselves placeholders are excluded even if nobody fetched them.
- The p10 of the band is meaningful only for windows with a single version (the p10s are summed like the p90s; for 20 versions the sum is far below the real p10). 0.2 will draw the band from the raw samples instead.

### Paid dataset (JPY 980, on sale)

The CLI and the monthly table it ships are free (MIT). Separately, a **npm download-floor dataset** (¥980, ZIP) is on sale: the raw anonymized daily series behind the table (day −1 to +45 for every measured package, as CSV and JSON), the monthly table as CSV/JSON, a method write-up and the floor-trend chart as SVG. It is for research, articles and your own dashboards; you do not need it to judge your own package with the CLI.

How to get it: on the [sales page](https://lab-cws.pages.dev/npm-floor/), click "¥980 で購入する" (Buy for ¥980), pay through Stripe, and the confirmation screen takes you to a download page for `npm-floor-dataset.zip`. The dataset text is in Japanese.

### For developers

Source is in the npm package (`npm pack npm-floor`); a public repository and an issue tracker are in preparation (the address will be added here and to `package.json` when it exists). `npm test`, `fieldlog`, `build:dataset` need `tests/` and `scripts/`, which are not in the tarball.

```
npm test                 # node --test: floor formula, 3-step verdict, API response parsing, window boundaries, broken inputs, calibrate on a fake API, exclusion rules
npm run calibrate -- --out out/calibrate-YYYY-MM-DD   # rebuild the table (about an hour; resumable)
npm run fieldlog         # re-run the real-data log into docs/field-log.md
npm run build:dataset    # assemble the paid ZIP from out/calibrate-*/ into dist/ (deterministic; prints sha256)
npm run demo             # pack, install into an empty prefix, run every command in this README → out/readme_demo_<date>.txt
```

As a library: `npm-floor` (`resolveWindow`, `loadCohorts`, `computeFloor`, `judge`, `analyze`, `zeroRange`, `registryZeroDays`), `npm-floor/api` (`getPackument`, `getDailyRange`, `getReferenceRange`, `searchPage`, `RateLimiter`, `ApiError`), `npm-floor/calibrate` (`runCalibrate`, `aggregate`, `seriesStats`, `qualify`, `prefilter`, `isPlaceholder`, `findZeroDays`, `markDescriptionClusters`, `defaultToMonth`), `npm-floor/dates`, `npm-floor/cohorts` (the bundled table as JSON).

### License

MIT. npm is a trademark of npm, Inc. This tool is unofficial and not endorsed by or affiliated with npm, Inc. or GitHub. The numbers are what npm's public API returned at run time; the control packages are other people's practice uploads and their names are intentionally not included anywhere in this package.
