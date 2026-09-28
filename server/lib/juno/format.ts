/**
 * Display formatting for Juno.
 *
 * Zora's numbers are terse — `$6.73k`, `7.5m`, `9h` — and that terseness is
 * load-bearing in a dense grid, so these mirror it rather than falling back to
 * `Intl` defaults.
 */

const COMPACT_STEPS = [
  { limit: 1e12, suffix: "t" },
  { limit: 1e9, suffix: "b" },
  { limit: 1e6, suffix: "m" },
  { limit: 1e3, suffix: "k" },
] as const;

/** `6730` → `6.73k`, `17535191` → `17.54m`. */
export function compact(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  for (const { limit, suffix } of COMPACT_STEPS) {
    if (abs >= limit) {
      const scaled = value / limit;
      // Keep three significant figures: 6.73k, 74.8k, 748k.
      const places = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : digits;
      return `${trimZeros(scaled.toFixed(places))}${suffix}`;
    }
  }
  return trimZeros(value.toFixed(abs < 1 ? digits : 0));
}

/**
 * `$748.18` under 1k, `$6.73k` above — matching how Zora switches from exact
 * dollars to compact once a number stops fitting in a stat cell.
 */
export function usd(
  value: number | null | undefined,
  opts: { compact?: boolean } = {},
): string {
  // Null means genuinely unknown — an em dash, never a confident zero.
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (opts.compact !== false && abs >= 1000) return `${sign}$${compact(abs)}`;
  if (abs === 0) return "$0";
  if (abs < 0.01) return `${sign}$${trimZeros(abs.toPrecision(2))}`;
  return `${sign}$${abs.toFixed(2)}`;
}

/**
 * A money figure in whatever unit it is actually denominated in.
 *
 * `usd()` prints a dollar sign unconditionally, which is wrong for an ETH-quoted
 * coin: no USD price feed means the figure is in ETH, and a `$` in front of it
 * would overstate it by the ETH price. Pass `Coin.marketCapCurrency` and the
 * label follows the number.
 */
export function money(
  value: number | null | undefined,
  currency: string,
  opts: { compact?: boolean } = {},
): string {
  if (currency === "USD") return usd(value, opts);
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (opts.compact !== false && abs >= 1000) return `${sign}${compact(abs)} ${currency}`;
  if (abs === 0) return `0 ${currency}`;
  const figure = abs < 0.01 ? trimZeros(abs.toPrecision(2)) : abs.toFixed(abs < 1 ? 4 : 2);
  return `${sign}${figure} ${currency}`;
}

/** Coin balances and trade sizes: `7.5m`, `349,674`. */
export function tokenAmount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1e6) return compact(value, 1);
  return Math.round(value).toLocaleString("en-US");
}

/** `0.0083` — quote-side input echo, trimmed but never in exponent form. */
export function quoteAmount(value: number, decimals = 4): string {
  if (!Number.isFinite(value) || value === 0) return "0";
  if (Math.abs(value) < 10 ** -decimals) return `<${10 ** -decimals}`;
  return trimZeros(value.toFixed(decimals));
}

/** `9h`, `3d`, `2mo` — single unit, no "ago". */
export function since(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const secs = Math.max(0, Math.floor((now - then) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

/** `0x1a2b…9f0e` — addresses are too long to render whole. */
export function shortAddress(address: string, lead = 4, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/** `+4.21%` / `-1.80%`, always signed. */
export function percent(ratio: number, digits = 2): string {
  if (!Number.isFinite(ratio)) return "—";
  const pct = ratio * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(digits)}%`;
}

function trimZeros(fixed: string): string {
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}
