// 日付の小道具。すべて UTC の暦日（npm の DL API は UTC の日単位で返す）。
export const DAY = 86400000;

// ms → "YYYY-MM-DD"（UTC）
export const ymd = (t) => new Date(t).toISOString().slice(0, 10);

// "YYYY-MM-DD" → その日の 00:00:00Z の ms。読めなければ Error（存在しない日付 2026-02-30 も弾く）
export function parseYmd(s) {
  const str = String(s ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) throw new Error(`not a date (YYYY-MM-DD): ${str || "(empty)"}`);
  const ms = Date.parse(`${str}T00:00:00Z`);
  if (!Number.isFinite(ms) || ymd(ms) !== str) throw new Error(`not a calendar date: ${str}`);
  return ms;
}

// "YYYY-MM" の検査。読めなければ Error
export function parseMonth(s) {
  const str = String(s ?? "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(str)) throw new Error(`not a month (YYYY-MM): ${str || "(empty)"}`);
  return str;
}

// ISO 文字列や ms から "YYYY-MM"
export const monthOf = (t) => (typeof t === "number" ? ymd(t) : String(t)).slice(0, 7);

// 月の通し番号（線形補間・順序比較用）
export const monthIndex = (m) => {
  const [y, mo] = parseMonth(m).split("-").map(Number);
  return y * 12 + (mo - 1);
};
export const monthFromIndex = (i) => `${String(Math.floor(i / 12)).padStart(4, "0")}-${String((i % 12) + 1).padStart(2, "0")}`;

// 2 つの暦日の差（日）。同じ日なら 0
export const dayDiff = (aYmd, bYmd) => Math.round((parseYmd(bYmd) - parseYmd(aYmd)) / DAY);

// ms を n 日ずらす
export const addDays = (ms, n) => ms + n * DAY;

// ms を 3 桁区切りに（表示用）
export const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
