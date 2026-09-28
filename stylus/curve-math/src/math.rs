//! Juno curve maths, integer-exact.
//!
//! This is the Rust port of `contracts/src/CurveMathRef.sol`, and must stay
//! bit-for-bit identical to it: the same segment table, the same rounding at
//! every step, the same search. `scripts/diff-curve-math.ts` compares the
//! deployed program with the reference over thousands of random inputs.
//!
//! No floating point anywhere — Stylus programs may not use it.

use alloc::vec::Vec;
use alloy_primitives::{U256, U512};

pub const SEGMENTS: usize = 16;

pub fn wad() -> U256 {
    U256::from(1_000_000_000_000_000_000u128)
}

#[derive(Debug, PartialEq, Eq)]
pub enum MathError {
    BadPreset,
    BadCap,
    Exceeds,
}

/// Liquidity weights x1e6: 0 content 1.2^i, 1 thin-name 0.82^i,
/// 2 ipo-book 0.25 + 0.75 t^2, 3 tight-nav flat.
const WEIGHTS: [[u64; 16]; 4] = [
    [
        1000000, 1200000, 1440000, 1728000, 2073600, 2488320, 2985984, 3583181, 4299817, 5159780,
        6191736, 7430084, 8916100, 10699321, 12839185, 15407022,
    ],
    [
        1000000, 820000, 672400, 551368, 452122, 370740, 304007, 249285, 204414, 167620, 137448,
        112707, 92420, 75784, 62143, 50957,
    ],
    [
        1000000, 813333, 653333, 520000, 413333, 333333, 280000, 253333, 253333, 280000, 333333,
        413333, 520000, 653333, 813333, 1000000,
    ],
    [1000000; 16],
];
const WEIGHT_SUMS: [u64; 4] = [87442130, 5323415, 8533330, 16000000];

/// e^-n for n = 0..4, WAD.
const EXP_NEG_INT: [u128; 5] = [
    1000000000000000000,
    367879441171442322,
    135335283236612691,
    49787068367863943,
    18315638888734180,
];

/// floor(a * b / d) at 512-bit precision.
pub fn mul_div(a: U256, b: U256, d: U256) -> U256 {
    let p = U512::from(a) * U512::from(b);
    U256::from(p / U512::from(d))
}

/// ceil(a * b / d) at 512-bit precision.
pub fn mul_div_up(a: U256, b: U256, d: U256) -> U256 {
    let p = U512::from(a) * U512::from(b);
    let d = U512::from(d);
    let q = p / d;
    if p % d == U512::ZERO { U256::from(q) } else { U256::from(q + U512::from(1u8)) }
}

/// floor(sqrt(x)).
pub fn isqrt(x: U256) -> U256 {
    if x < U256::from(2u8) {
        return x;
    }
    // Newton from a power-of-two guess >= sqrt(x); decreases monotonically.
    let bits = 256 - x.leading_zeros();
    let mut r = U256::from(1u8) << ((bits + 1) / 2);
    loop {
        let next = (r + x / r) >> 1;
        if next >= r {
            return r;
        }
        r = next;
    }
}

pub struct Table {
    pub prices: [U256; SEGMENTS + 1],
    pub sizes: [U256; SEGMENTS],
}

fn root16(cap_fp: U256) -> Result<U256, MathError> {
    if cap_fp < wad() {
        return Err(MathError::BadCap);
    }
    let mut r = cap_fp;
    for _ in 0..4 {
        r = isqrt(r * wad());
    }
    Ok(r)
}

pub fn table(preset: u8, p0: U256, cap_fp: U256, supply: U256) -> Result<Table, MathError> {
    let p = preset as usize;
    if p >= WEIGHTS.len() {
        return Err(MathError::BadPreset);
    }
    let r = root16(cap_fp)?;
    let mut prices = [U256::ZERO; SEGMENTS + 1];
    prices[0] = p0;
    for i in 1..=SEGMENTS {
        prices[i] = prices[i - 1] * r / wad();
    }
    let w = U256::from(WEIGHT_SUMS[p]);
    let mut sizes = [U256::ZERO; SEGMENTS];
    let mut used = U256::ZERO;
    for i in 0..SEGMENTS - 1 {
        sizes[i] = supply * U256::from(WEIGHTS[p][i]) / w;
        used += sizes[i];
    }
    sizes[SEGMENTS - 1] = supply - used;
    Ok(Table { prices, sizes })
}

/// Cost of `x` tokens in a segment starting `a` tokens in: x*P + dP*x*(2a+x)/(2S).
fn seg_cost(p: U256, dp: U256, s: U256, a: U256, x: U256, up: bool) -> U256 {
    if x.is_zero() {
        return U256::ZERO;
    }
    let two = U256::from(2u8);
    let span = x * (two * a + x);
    let den = two * s * wad();
    if up {
        mul_div_up(x, p, wad()) + mul_div_up(dp, span, den)
    } else {
        mul_div(x, p, wad()) + mul_div(dp, span, den)
    }
}

fn range_cost(t: &Table, from: U256, to: U256, up: bool) -> U256 {
    let mut total = U256::ZERO;
    let mut start = U256::ZERO;
    for k in 0..SEGMENTS {
        if start >= to {
            break;
        }
        let end = start + t.sizes[k];
        if end > from && !t.sizes[k].is_zero() {
            let lo = if from > start { from } else { start };
            let hi = if to < end { to } else { end };
            total += seg_cost(t.prices[k], t.prices[k + 1] - t.prices[k], t.sizes[k], lo - start, hi - lo, up);
        }
        start = end;
    }
    total
}

pub fn boundaries(preset: u8, p0: U256, cap_fp: U256, supply: U256) -> Result<(Vec<U256>, Vec<U256>), MathError> {
    let t = table(preset, p0, cap_fp, supply)?;
    Ok((t.prices.to_vec(), t.sizes.to_vec()))
}

pub fn price_at(preset: u8, p0: U256, cap_fp: U256, supply: U256, sold: U256) -> Result<U256, MathError> {
    let t = table(preset, p0, cap_fp, supply)?;
    if sold >= supply {
        return Ok(t.prices[SEGMENTS]);
    }
    let mut start = U256::ZERO;
    for k in 0..SEGMENTS {
        let end = start + t.sizes[k];
        if sold < end {
            return Ok(t.prices[k] + mul_div(t.prices[k + 1] - t.prices[k], sold - start, t.sizes[k]));
        }
        start = end;
    }
    Ok(t.prices[SEGMENTS])
}

pub fn cost_to_buy(preset: u8, p0: U256, cap_fp: U256, supply: U256, sold: U256, amount: U256) -> Result<U256, MathError> {
    if sold + amount > supply {
        return Err(MathError::Exceeds);
    }
    let t = table(preset, p0, cap_fp, supply)?;
    Ok(range_cost(&t, sold, sold + amount, true))
}

pub fn proceeds_to_sell(preset: u8, p0: U256, cap_fp: U256, supply: U256, sold: U256, amount: U256) -> Result<U256, MathError> {
    if amount > sold || sold > supply {
        return Err(MathError::Exceeds);
    }
    let t = table(preset, p0, cap_fp, supply)?;
    Ok(range_cost(&t, sold - amount, sold, false))
}

pub fn amount_for_cost(preset: u8, p0: U256, cap_fp: U256, supply: U256, sold: U256, cost: U256) -> Result<U256, MathError> {
    if sold > supply {
        return Err(MathError::Exceeds);
    }
    let t = table(preset, p0, cap_fp, supply)?;
    let mut remaining = cost;
    let mut pos = sold;
    let mut start = U256::ZERO;
    for k in 0..SEGMENTS {
        let end = start + t.sizes[k];
        if pos < end {
            let a = pos - start;
            let room = end - pos;
            let dp = t.prices[k + 1] - t.prices[k];
            let full = seg_cost(t.prices[k], dp, t.sizes[k], a, room, true);
            if full <= remaining {
                remaining -= full;
                pos = end;
            } else {
                let mut lo = U256::ZERO;
                let mut hi = room;
                let one = U256::from(1u8);
                while hi - lo > one {
                    let mid = (lo + hi) >> 1;
                    if seg_cost(t.prices[k], dp, t.sizes[k], a, mid, true) <= remaining {
                        lo = mid;
                    } else {
                        hi = mid;
                    }
                }
                pos += lo;
                break;
            }
        }
        start = end;
    }
    Ok(pos - sold)
}

pub fn fee_bps(start_bps: U256, end_bps: U256, decay_seconds: U256, elapsed: U256) -> U256 {
    if decay_seconds.is_zero() || elapsed >= decay_seconds || start_bps <= end_bps {
        return end_bps;
    }
    let y = U256::from(5u8) * elapsed * wad() / decay_seconds;
    end_bps + (start_bps - end_bps) * exp_neg(y) / wad()
}

/// e^(-y), y in [0, 5e18), WAD.
fn exp_neg(y: U256) -> U256 {
    let n = (y / wad()).to::<usize>();
    let f = y % wad();
    let en = U256::from(EXP_NEG_INT[n]);
    let mut term = wad();
    let mut sum = wad();
    for i in 1..=20u64 {
        term = term * f / (wad() * U256::from(i));
        if term.is_zero() {
            break;
        }
        sum += term;
    }
    let ef = wad() * wad() / sum;
    en * ef / wad()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e18(x: u64) -> U256 {
        U256::from(x) * wad()
    }

    #[test]
    fn isqrt_is_floor() {
        for x in [0u64, 1, 2, 3, 4, 15, 16, 17, 1_000_000, 999_999_999_999] {
            let r = isqrt(U256::from(x));
            let rr = r * r;
            assert!(rr <= U256::from(x));
            assert!((r + U256::from(1u8)) * (r + U256::from(1u8)) > U256::from(x));
        }
        let big = U256::MAX;
        let r = isqrt(big);
        assert!(r.checked_mul(r).is_some());
    }

    #[test]
    fn table_ends_near_cap() {
        let supply = e18(200_000_000);
        for preset in 0..4u8 {
            let t = table(preset, U256::from(20_000_000u64), e18(25), supply).unwrap();
            let sum: U256 = t.sizes.iter().fold(U256::ZERO, |a, b| a + *b);
            assert_eq!(sum, supply);
            let end = t.prices[SEGMENTS];
            let target = U256::from(20_000_000u64) * U256::from(25u8);
            let diff = if end > target { end - target } else { target - end };
            assert!(diff * U256::from(1000u32) < target, "preset {preset}: {end} vs {target}");
        }
    }

    #[test]
    fn prices_increase() {
        let supply = e18(1_000_000);
        let mut last = U256::ZERO;
        let mut sold = U256::ZERO;
        while sold <= supply {
            let p = price_at(0, U256::from(1_000_000_000u64), e18(25), supply, sold).unwrap();
            assert!(p >= last);
            last = p;
            sold += e18(37_000);
        }
    }

    #[test]
    fn buy_is_additive_within_rounding() {
        let supply = e18(200_000_000);
        let (p0, cap) = (U256::from(20_000_000u64), e18(25));
        for preset in 0..4u8 {
            let a = e18(12_345_678);
            let b = e18(40_000_000);
            let whole = cost_to_buy(preset, p0, cap, supply, U256::ZERO, a + b).unwrap();
            let parts = cost_to_buy(preset, p0, cap, supply, U256::ZERO, a).unwrap()
                + cost_to_buy(preset, p0, cap, supply, a, b).unwrap();
            let diff = if whole > parts { whole - parts } else { parts - whole };
            assert!(diff <= U256::from(34u8), "preset {preset} diff {diff}");
        }
    }

    #[test]
    fn round_trip_never_profits() {
        let supply = e18(200_000_000);
        let (p0, cap) = (U256::from(20_000_000u64), e18(25));
        for preset in 0..4u8 {
            let mut sold = U256::ZERO;
            for step in [1u64, 999, 5_000_000, 33_333_333, 70_000_000] {
                let amt = e18(step);
                if sold + amt > supply {
                    break;
                }
                let cost = cost_to_buy(preset, p0, cap, supply, sold, amt).unwrap();
                sold += amt;
                let back = proceeds_to_sell(preset, p0, cap, supply, sold, amt).unwrap();
                assert!(back <= cost);
            }
        }
    }

    #[test]
    fn amount_for_cost_inverts_cost() {
        let supply = e18(200_000_000);
        let (p0, cap) = (U256::from(20_000_000u64), e18(25));
        for preset in 0..4u8 {
            for (sold, amount) in [(0u64, 1u64), (0, 10_000_000), (5_000_000, 50_000_000), (150_000_000, 49_000_000)] {
                let s = e18(sold);
                let a = e18(amount);
                let cost = cost_to_buy(preset, p0, cap, supply, s, a).unwrap();
                let got = amount_for_cost(preset, p0, cap, supply, s, cost).unwrap();
                assert!(got >= a, "preset {preset}: {got} < {a}");
                assert!(cost_to_buy(preset, p0, cap, supply, s, got).unwrap() <= cost);
                // one more unit would not fit
                if s + got < supply {
                    assert!(cost_to_buy(preset, p0, cap, supply, s, got + U256::from(1u8)).unwrap() > cost);
                }
            }
        }
    }

    #[test]
    fn amount_for_cost_caps_at_supply() {
        let supply = e18(1_000);
        let got = amount_for_cost(3, U256::from(10u64), e18(2), supply, U256::ZERO, U256::MAX >> 64).unwrap();
        assert_eq!(got, supply);
    }

    #[test]
    fn fee_decays() {
        let (s, e, t) = (U256::from(900u32), U256::from(100u32), U256::from(600u32));
        assert_eq!(fee_bps(s, e, t, U256::ZERO), s);
        assert_eq!(fee_bps(s, e, t, t), e);
        let mut last = s;
        for el in (0..600u32).step_by(7) {
            let f = fee_bps(s, e, t, U256::from(el));
            assert!(f <= last && f >= e);
            last = f;
        }
        // e^-2.5 * 800 + 100 ~= 165.67
        assert_eq!(fee_bps(s, e, t, U256::from(300u32)), U256::from(165u32));
    }

    #[test]
    fn rejects_bad_input() {
        assert_eq!(price_at(4, U256::from(1u8), e18(2), e18(10), U256::ZERO), Err(MathError::BadPreset));
        assert_eq!(price_at(0, U256::from(1u8), wad() - U256::from(1u8), e18(10), U256::ZERO), Err(MathError::BadCap));
        assert_eq!(cost_to_buy(0, U256::from(1u8), e18(2), e18(10), e18(5), e18(6)), Err(MathError::Exceeds));
    }
}
