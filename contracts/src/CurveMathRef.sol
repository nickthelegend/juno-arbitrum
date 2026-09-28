// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ICurveMath} from "./interfaces/IJuno.sol";

/// @title CurveMathRef
/// @notice Solidity reference implementation of Juno's curve maths.
///
/// Production curves call the Stylus (Rust) program in `stylus/curve-math`.
/// This contract is the specification it is tested against: every function
/// here and there must return the same integer for the same input. It is used
/// as the maths backend in Foundry tests (which cannot execute WASM) and is
/// deployed on Arbitrum Sepolia only, next to the Stylus program, so the two
/// can be compared over RPC (`scripts/diff-curve-math.ts`).
///
/// ## The curve
/// Sixteen segments. Segment i's price rises linearly from P[i] to P[i+1]
/// while it sells S[i] tokens. Prices are geometric, P[i] = p0 * r^i with
/// r = capFp^(1/16) (four nested WAD square roots), so the curve ends at
/// about p0 * cap. The preset's weight w[i] decides how many tokens each
/// segment holds: a heavy segment is deep (price moves slowly), a light one
/// is thin. Buy costs round up and sell proceeds round down, per segment, so a
/// round trip can never extract value.
contract CurveMathRef is ICurveMath {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant SEGMENTS = 16;

    error BadPreset();
    error BadCap();
    error Exceeds();

    /// @dev Liquidity weights x1e6, from the Solana presets (lib/juno/curves.ts):
    /// 0 content 1.2^i, 1 thin-name 0.82^i, 2 ipo-book 0.25 + 0.75 t^2, 3 tight-nav flat.
    function _weight(uint8 preset, uint256 i) internal pure returns (uint256) {
        if (preset == 0) {
            return [
                uint256(1000000), 1200000, 1440000, 1728000, 2073600, 2488320, 2985984, 3583181,
                4299817, 5159780, 6191736, 7430084, 8916100, 10699321, 12839185, 15407022
            ][i];
        }
        if (preset == 1) {
            return [
                uint256(1000000), 820000, 672400, 551368, 452122, 370740, 304007, 249285,
                204414, 167620, 137448, 112707, 92420, 75784, 62143, 50957
            ][i];
        }
        if (preset == 2) {
            return [
                uint256(1000000), 813333, 653333, 520000, 413333, 333333, 280000, 253333,
                253333, 280000, 333333, 413333, 520000, 653333, 813333, 1000000
            ][i];
        }
        if (preset == 3) return 1000000;
        revert BadPreset();
    }

    function _weightSum(uint8 preset) internal pure returns (uint256) {
        if (preset == 0) return 87442130;
        if (preset == 1) return 5323415;
        if (preset == 2) return 8533330;
        if (preset == 3) return 16000000;
        revert BadPreset();
    }

    /// @dev capFp^(1/16) in WAD: four floor square roots of x * WAD.
    function _root16(uint256 capFp) internal pure returns (uint256 r) {
        if (capFp < WAD) revert BadCap();
        r = capFp;
        for (uint256 k = 0; k < 4; k++) {
            r = Math.sqrt(r * WAD);
        }
    }

    function _table(uint8 preset, uint256 p0, uint256 capFp, uint256 supply)
        internal
        pure
        returns (uint256[17] memory P, uint256[16] memory S)
    {
        uint256 r = _root16(capFp);
        P[0] = p0;
        for (uint256 i = 1; i <= SEGMENTS; i++) {
            P[i] = (P[i - 1] * r) / WAD;
        }
        uint256 w = _weightSum(preset);
        uint256 used;
        for (uint256 i = 0; i < SEGMENTS - 1; i++) {
            S[i] = (supply * _weight(preset, i)) / w;
            used += S[i];
        }
        S[SEGMENTS - 1] = supply - used;
    }

    /// @dev Cost of `x` tokens in a segment starting `a` tokens in, rounded
    /// up (`up`) or down. The integral of a line: x*P + dP*x*(2a+x)/(2S).
    function _segCost(uint256 P, uint256 dP, uint256 S, uint256 a, uint256 x, bool up)
        internal
        pure
        returns (uint256)
    {
        if (x == 0) return 0;
        Math.Rounding rd = up ? Math.Rounding.Ceil : Math.Rounding.Floor;
        uint256 flat = Math.mulDiv(x, P, WAD, rd);
        uint256 slope = Math.mulDiv(dP, x * (2 * a + x), 2 * S * WAD, rd);
        return flat + slope;
    }

    /// @dev Cost of the token range [from, to), split at segment edges.
    function _rangeCost(uint256[17] memory P, uint256[16] memory S, uint256 from, uint256 to, bool up)
        internal
        pure
        returns (uint256 total)
    {
        uint256 start;
        for (uint256 k = 0; k < SEGMENTS && start < to; k++) {
            uint256 end = start + S[k];
            if (end > from && S[k] > 0) {
                uint256 lo = from > start ? from : start;
                uint256 hi = to < end ? to : end;
                total += _segCost(P[k], P[k + 1] - P[k], S[k], lo - start, hi - lo, up);
            }
            start = end;
        }
    }

    function boundaries(uint8 preset, uint256 p0, uint256 capFp, uint256 supply)
        external
        pure
        returns (uint256[] memory prices, uint256[] memory sizes)
    {
        (uint256[17] memory P, uint256[16] memory S) = _table(preset, p0, capFp, supply);
        prices = new uint256[](17);
        sizes = new uint256[](16);
        for (uint256 i = 0; i < 17; i++) prices[i] = P[i];
        for (uint256 i = 0; i < 16; i++) sizes[i] = S[i];
    }

    function priceAt(uint8 preset, uint256 p0, uint256 capFp, uint256 supply, uint256 sold)
        public
        pure
        returns (uint256)
    {
        (uint256[17] memory P, uint256[16] memory S) = _table(preset, p0, capFp, supply);
        if (sold >= supply) return P[SEGMENTS];
        uint256 start;
        for (uint256 k = 0; k < SEGMENTS; k++) {
            uint256 end = start + S[k];
            if (sold < end) {
                return P[k] + Math.mulDiv(P[k + 1] - P[k], sold - start, S[k]);
            }
            start = end;
        }
        return P[SEGMENTS];
    }

    function costToBuy(uint8 preset, uint256 p0, uint256 capFp, uint256 supply, uint256 sold, uint256 amount)
        external
        pure
        returns (uint256)
    {
        if (sold + amount > supply) revert Exceeds();
        (uint256[17] memory P, uint256[16] memory S) = _table(preset, p0, capFp, supply);
        return _rangeCost(P, S, sold, sold + amount, true);
    }

    function proceedsToSell(uint8 preset, uint256 p0, uint256 capFp, uint256 supply, uint256 sold, uint256 amount)
        external
        pure
        returns (uint256)
    {
        if (amount > sold || sold > supply) revert Exceeds();
        (uint256[17] memory P, uint256[16] memory S) = _table(preset, p0, capFp, supply);
        return _rangeCost(P, S, sold - amount, sold, false);
    }

    /// @notice Most tokens `cost` buys starting at `sold`. Whole segments are
    /// consumed while affordable; inside the last one a binary search finds the
    /// exact largest amount whose rounded-up cost fits. The answer is unique, so
    /// the Stylus program must return exactly the same number.
    function amountForCost(uint8 preset, uint256 p0, uint256 capFp, uint256 supply, uint256 sold, uint256 cost)
        external
        pure
        returns (uint256)
    {
        if (sold > supply) revert Exceeds();
        (uint256[17] memory P, uint256[16] memory S) = _table(preset, p0, capFp, supply);
        uint256 remaining = cost;
        uint256 pos = sold;
        uint256 start;
        for (uint256 k = 0; k < SEGMENTS; k++) {
            uint256 end = start + S[k];
            if (pos < end) {
                uint256 a = pos - start;
                uint256 room = end - pos;
                uint256 dP = P[k + 1] - P[k];
                uint256 full = _segCost(P[k], dP, S[k], a, room, true);
                if (full <= remaining) {
                    remaining -= full;
                    pos = end;
                } else {
                    uint256 lo = 0;
                    uint256 hi = room; // cost(hi) > remaining
                    while (hi - lo > 1) {
                        uint256 mid = (lo + hi) / 2;
                        if (_segCost(P[k], dP, S[k], a, mid, true) <= remaining) lo = mid;
                        else hi = mid;
                    }
                    pos += lo;
                    break;
                }
            }
            start = end;
        }
        return pos - sold;
    }

    /// @notice end + (start - end) * e^(-5 * elapsed / decay), floored to a bps.
    function feeBps(uint256 startBps, uint256 endBps, uint256 decaySeconds, uint256 elapsed)
        external
        pure
        returns (uint256)
    {
        if (decaySeconds == 0 || elapsed >= decaySeconds || startBps <= endBps) return endBps;
        uint256 y = (5 * elapsed * WAD) / decaySeconds; // < 5e18
        return endBps + ((startBps - endBps) * _expNeg(y)) / WAD;
    }

    /// @dev e^(-y) for y in [0, 5e18), WAD. Integer part from a table, the
    /// fraction as 1 / (Taylor series of e^f) with 20 terms at most.
    function _expNeg(uint256 y) internal pure returns (uint256) {
        uint256 n = y / WAD;
        uint256 f = y % WAD;
        uint256 en = [
            uint256(1000000000000000000),
            367879441171442322,
            135335283236612691,
            49787068367863943,
            18315638888734180
        ][n];
        uint256 term = WAD;
        uint256 sum = WAD;
        for (uint256 i = 1; i <= 20; i++) {
            term = (term * f) / (WAD * i);
            if (term == 0) break;
            sum += term;
        }
        uint256 ef = (WAD * WAD) / sum;
        return (en * ef) / WAD;
    }
}
