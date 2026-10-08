# npm download-floor dataset ({{generatedAtDate}})

Daily download series for **{{n}}** throwaway npm packages (single version, no repository, self-described practice uploads) published **{{first}} .. {{last}}**, anonymized, plus the monthly floor table (`S` first-4-day downloads per version, `T` daily drip) that the free CLI [`npm-floor`](https://www.npmjs.com/package/npm-floor) ships.

Start with **`METHOD.md`** (how the packages were found, what each column means, the caveats, and the terms of use). Then:

- `cohorts.csv` / `cohorts.json` — the monthly table (median / p10 / p90 of S, T, the 30-day total, and the peak day)
- `series.csv` / `series.json` — the raw daily series (day −1 .. +45 around the publish day)
- `floor-trend.svg` — S and T by month, median with p10–p90 band

To apply the table to a package: `npx npm-floor <package> --cohorts cohorts.json`.

---

練習用 npm パッケージ **{{n}}** 件の日次 DL 系列（匿名化）と、無料 CLI `npm-floor` が同梱する月別の床の表です。先に `METHOD.md`（取り方・列の意味・注意・利用条件）を読んでください。
