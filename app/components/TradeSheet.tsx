import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Modal, Platform, Pressable, TextInput } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import styled from "styled-components/native";

import { Tappable } from "./Press";
import { Button, Caption, Col, ExternalGlyph, Label, Row } from "./kit";
import { juno, type Coin, type SwapBuild } from "../lib/api";
import { describeTxError, explorer, EXPLORER_NAME, NETWORK_NAME } from "../lib/chain";
import { money, tokens } from "../lib/useApi";
import { useWallet, type SendProgress } from "../lib/wallet";
import { theme } from "../theme";

/**
 * Buy and sell, with a numpad.
 *
 * A system keyboard is the wrong control here. It covers half the screen —
 * including the quote the person is deciding on — offers characters an amount
 * cannot contain, and moves its decimal key by locale. A purpose-built pad
 * keeps the number, the quote and the button visible at once, which is the
 * whole decision in one view.
 *
 * ## The quote is fetched, not computed
 *
 * The amount could be multiplied by the last price, and that estimate would be
 * wrong in exactly the way that matters: a bonding curve moves as it fills, so
 * a large order does not clear at spot. The server quotes against the live
 * curve (`quoteBuy` / `quoteSell` on the curve contract) and returns the steps
 * built against that same quote, so what is shown is what gets signed.
 *
 * A post is priced in ETH and is one step. A stock tracker is priced in USDC
 * and is two — "Approve USDC", then "Buy" — and the sheet shows both, ticking
 * each off as its receipt comes back. A tracker's quote also says whether the
 * buy stays inside the stock's band and whether the market is open, and that
 * is said before anything is signed.
 *
 * Debounced, because a quote is an RPC round trip and typing "125" should not
 * cost three of them.
 *
 * ## Saying so afterwards
 *
 * Juno is a social app and a trade was the one thing you could not talk about:
 * the comment box here attaches your words to the fill, with the side and the
 * transaction hash on the row. That is what makes it an announcement rather
 * than a boast — anyone reading it can check it on Arbiscan.
 *
 * Posted only after the receipt lands, and a failure to post says so without
 * pretending the trade failed. The two are different events and only one of
 * them moved money.
 */

/** Dollar sizes, converted at the quote token's rate. */
const QUICK_USD = [2, 5, 10, 25];
/** What a buy offers when no USD feed answered, in quote units. The faucet sends 0.02 ETH. */
const QUICK_QUOTE: Record<"ETH" | "USDC", number[]> = {
  ETH: [0.001, 0.0025, 0.005, 0.01],
  USDC: [5, 10, 25, 50],
};
/** A sell is a fraction of what you hold; absolute sizes mean nothing there. */
const QUICK_SELL = [0.25, 0.5, 0.75, 1];
/** Exact-out sizes, in tokens. Every Juno coin has a 1B supply. */
const QUICK_TOKENS = [100_000, 1_000_000, 10_000_000, 50_000_000];

/**
 * The move the size suggester searches against.
 *
 * One percent of *curve* movement — not one percent of total cost. On a pool
 * whose fee is 48 bps the two differ by half the budget, and only one of them
 * grows with the order.
 */
const IMPACT_BUDGET = 0.01;

/**
 * How long the pre-sign refresh is allowed to take.
 *
 * Shorter than the client's default, because this one has somewhere to fall
 * back to: the quote already on screen, whose deadline is minutes away.
 */
const REQUOTE_MS = 12_000;

type Stage = "entry" | "confirming" | "done";

export function TradeSheet({
  coin,
  side: initialSide,
  onClose,
  onDone,
  holding = null,
  quoteBalance = null,
  initialAmount = "",
  onFilled,
  onCommented,
  feeBalance = null,
}: {
  coin: Coin;
  side: "buy" | "sell";
  onClose: () => void;
  onDone: () => void;
  /** Coin balance, for a sell. Null when unknown. */
  holding?: number | null;
  /** Quote-token balance, for a buy. Null when unknown. */
  quoteBalance?: number | null;
  /**
   * Pre-filled amount, for a buy opened from somewhere that already knows the
   * size — a recurring-buy contribution. Editable: it is a starting point, not
   * a lock, because the whole point of signing each one is that you can change
   * your mind about this week.
   */
  initialAmount?: string;
  /**
   * A swap **confirmed**, with the quote amount that was spent or received.
   *
   * Fires on the receipt landing, not on the sheet closing. Anything that
   * records a fill has to hang off this and only this: a callback on close
   * would count a trade that errored, and one on submit would count a
   * transaction that never made it into a block.
   */
  onFilled?: (quoteAmount: number) => void;
  /** An announcement was posted alongside the fill. */
  onCommented?: () => void;
  /** ETH held, for gas. Null when unknown — then it is not checked. */
  feeBalance?: number | null;
}) {
  const wallet = useWallet();
  const [side, setSide] = useState<"buy" | "sell">(initialSide);
  const [amount, setAmount] = useState(initialAmount);
  /**
   * Buy an exact number of tokens rather than spend an exact amount.
   *
   * `SwapMode.ExactOut`: the trader names what they want to hold and the
   * curve names the price, with the transaction capped at a maximum spend
   * instead of guarded by a minimum out. Buys only — a sell already names
   * its token amount exactly.
   */
  const [exact, setExact] = useState(false);
  const [quote, setQuote] = useState<SwapBuild | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [stage, setStage] = useState<Stage>("entry");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  /** Each step's label and where it has got to, while the wallet sends. */
  const [progress, setProgress] = useState<{ labels: string[]; at: SendProgress } | null>(null);
  /** When the chain confirmed it — shown beside the hash on the receipt. */
  const [landedAt, setLandedAt] = useState<Date | null>(null);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  /**
   * The largest buy that stays inside a 1% move of the curve.
   *
   * Binary-searched server-side against the same `swapQuote` the transaction
   * is built with, on *curve* impact with the fee excluded — a fee is a flat
   * percentage and does not grow with size, so including it would make the
   * answer mostly a constant and give the same number on a deep curve as a
   * thin one. This is the figure that actually distinguishes Juno's four
   * presets from each other, and until now it existed only in an endpoint.
   */
  const [suggestion, setSuggestion] = useState<
    { amountIn: number; curveImpact: number; ceilingReached: boolean } | null
  >(null);
  const [suggesting, setSuggesting] = useState(false);
  /** When the quote on screen was built. Kept for the "quoted Ns ago" read. */
  const quotedAt = useRef(0);

  const value = Number(amount || "0");
  const valid = Number.isFinite(value) && value > 0;
  const exactOut = side === "buy" && exact;
  const unit = side === "buy" && !exactOut ? coin.quote.symbol : coin.symbol;
  /** Decimals the typed amount may carry: USDC has six, ETH and every Juno token eighteen. */
  const maxDecimals = side === "buy" && !exactOut && coin.quote.decimals === 6 ? 6 : 9;
  /** A tracker whose feed has gone stale takes sells only; the contract enforces it too. */
  const marketClosed = side === "buy" && (coin.nav?.marketOpen === false || quote?.quote.marketOpen === false);
  /** What the balance is counted in — never the exact-out token. */
  const balanceUnit = side === "buy" ? coin.quote.symbol : coin.symbol;
  const rate = coin.quoteUsdRate;

  /**
   * What the wallet can actually spend on this side.
   *
   * Null rather than zero when it is not known — a balance that failed to load
   * and a genuinely empty wallet are different, and only one of them should
   * stop someone trying.
   */
  const balance = useMemo(() => {
    if (side === "sell") return holding;
    return quoteBalance;
  }, [side, holding, quoteBalance]);

  /*
   * Why this trade cannot go through, decided before anything is signed.
   *
   * The server builds steps for any amount, and the chain refuses what the
   * wallet cannot pay for. These are the refusals worth saying in words, with
   * where to fix them. Unknown balances are not checked: a read that failed is
   * not "empty".
   */
  // What this trade takes out of the wallet. For an exact-out buy that is only
  // known once quoted, and the bound that matters is the most it may cost.
  const spend = exactOut ? (quote?.quote.maximumAmountIn ?? null) : value;
  const paysEth = coin.quote.symbol === "ETH" && side === "buy";
  const blocker = useMemo((): { text: string; short: string } | null => {
    if (marketClosed) {
      return {
        text: "Market closed — the stock price is stale, so buys are paused. You can still sell.",
        short: "Market closed · sells only",
      };
    }
    if (!valid) return null;
    if (balance !== null && spend !== null && spend > balance) {
      if (side === "sell") return { text: `You hold ${tokens(balance)} ${coin.symbol}.`, short: `Not enough ${coin.symbol}` };
      return coin.quote.symbol === "USDC"
        ? {
            text: `This market is priced in USDC and you have ${tokens(balance)}. Get test USDC from your profile.`,
            short: "Not enough USDC",
          }
        : { text: `You have ${tokens(balance)} ETH. Get test ETH from your profile.`, short: "Not enough ETH" };
    }
    // Whether the rest covers gas is the server's call: it builds the trade
    // against the real gas estimate and says "Not enough ETH … plus gas" when
    // it does not. Only an empty wallet is certain to fail.
    const eth = paysEth ? balance : feeBalance;
    const spending = paysEth ? (spend ?? 0) : 0;
    if (eth !== null && eth !== undefined && eth - spending <= 0) {
      return spending > 0
        ? { text: "That is all your ETH, with nothing left for gas. Try a little less.", short: "Leave ETH for gas" }
        : { text: "You need a little ETH for gas. Get test ETH from your profile.", short: "Need ETH for gas" };
    }
    return null;
  }, [marketClosed, valid, balance, spend, side, coin.symbol, coin.quote.symbol, feeBalance, paysEth]);

  /**
   * The stock, said before signing rather than only on the coin page.
   *
   * A tracker's curve is held to a Chainlink price: the contract reverts a buy
   * that would leave the curve more than the band above it. The quote already
   * knows whether this buy would (`bandOk`), so the sheet says so first.
   */
  const bandBps = quote?.quote.bandBps ?? coin.nav?.bandBps ?? null;
  const navWarning = useMemo((): string | null => {
    if (side === "buy" && quote?.quote.bandOk === false) {
      return `This buy would push the price more than ${
        bandBps ? `${Number((bandBps / 100).toFixed(2))}%` : "its band"
      } above the stock. Try a smaller amount.`;
    }
    const nav = coin.nav;
    if (!nav || nav.deviationPct === null) return null;
    const band = nav.bandBps / 100;
    if (Math.abs(nav.deviationPct) <= band) return null;
    const above = nav.deviationPct > 0;
    return `This curve is ${Math.abs(nav.deviationPct).toFixed(1)}% ${above ? "above" : "below"} ${nav.symbol}, outside its ${band}% band.${
      side === "sell" && !above ? " A sell here gets less than the stock." : ""
    }`;
  }, [coin.nav, side, quote?.quote.bandOk, bandBps]);

  const usdEquivalent = useMemo(() => {
    if (!valid) return null;
    const live = quote?.quoteUsdRate ?? rate;
    if (side === "buy" && !exactOut) {
      return live === null ? null : money(value * live, "USD", { compact: false });
    }
    return coin.priceUsd > 0 ? money(value * coin.priceUsd, coin.marketCapCurrency, { compact: false }) : null;
  }, [valid, value, side, exactOut, quote?.quoteUsdRate, rate, coin.priceUsd, coin.marketCapCurrency]);

  // An amount the wallet cannot cover is refused in words above; quoting it
  // would spend a round trip on a transaction nobody can sign.
  const overBalance = valid && balance !== null && !exactOut && value > balance;
  /** The typed amount as the server wants it: a decimal string, no trailing point. */
  const amountText = amount.replace(/\.$/, "");

  useEffect(() => {
    // Signed out, the sheet still quotes (quoteOnly): the fee, the impact and a
    // tracker's band verdict are shown before anyone has a wallet.
    if (!valid || overBalance || marketClosed) {
      setQuote(null);
      setQuoting(false);
      return;
    }
    let cancelled = false;
    setQuoting(true);
    setError(null);

    const timer = setTimeout(async () => {
      try {
        const amounts = exactOut ? { amountOut: amountText } : { amountIn: amountText };
        const built = wallet.address
          ? await juno.quoteForWallet({ curve: coin.pool, trader: wallet.address, side, ...amounts })
          : await juno.quoteSwap({ curve: coin.pool, side, ...amounts });
        if (!cancelled) {
          if ("refusal" in built) {
            setQuote(null);
            setError(built.refusal.message);
          } else {
            setQuote(built);
            quotedAt.current = Date.now();
          }
        }
      } catch (caught) {
        if (!cancelled) {
          setQuote(null);
          setError(caught instanceof Error ? caught.message : "Could not quote this trade");
        }
      } finally {
        if (!cancelled) setQuoting(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [amountText, valid, side, exactOut, coin.pool, wallet.address, overBalance, marketClosed]);

  useEffect(() => {
    let cancelled = false;
    setSuggestion(null);
    setSuggesting(true);
    juno
      .depth(coin.address, side, IMPACT_BUDGET)
      .then((result) => {
        if (cancelled) return;
        setSuggestion(
          result.suggestion
            ? {
                amountIn: result.suggestion.amountIn,
                curveImpact: result.suggestion.curveImpact,
                ceilingReached: result.suggestion.ceilingReached,
              }
            : null,
        );
      })
      // No suggestion is a fine outcome and gets no error copy: the pill
      // simply does not appear. It is a convenience, not the trade.
      .catch(() => (cancelled ? undefined : setSuggestion(null)))
      .finally(() => (cancelled ? undefined : setSuggesting(false)));
    return () => {
      cancelled = true;
    };
  }, [coin.address, side]);

  const press = useCallback((key: string) => {
    setError(null);
    setTxHash(null);
    setAmount((current) => {
      if (key === "back") return current.slice(0, -1);
      if (key === ".") return current.includes(".") ? current : current === "" ? "0." : `${current}.`;
      // No leading zeros: "05" is not an amount anyone meant to type.
      const next = current === "0" ? key : current + key;
      const [, decimals = ""] = next.split(".");
      if (decimals.length > maxDecimals) return current;
      return next;
    });
  }, [maxDecimals]);

  async function confirm() {
    if (!quote) return;
    setStage("confirming");
    setError(null);
    setProgress(null);
    try {
      const address = wallet.address ?? (await wallet.connect());
      if (!address) throw new Error("No wallet available");

      /*
       * Rebuild the quote right before signing.
       *
       * The curve moves as it fills, so a minute-old quote is quoting a price
       * nobody would get now, and its `minOut` and deadline were set from it.
       * The rebuilt quote replaces the visible one before signing, so what is
       * signed is what the sheet shows.
       */
      const fresh = await juno
        .buildSwap(
          {
            curve: coin.pool,
            trader: address,
            side,
            ...(exactOut ? { amountOut: amountText } : { amountIn: amountText }),
          },
          REQUOTE_MS,
        )
        // A refresh that times out is not a reason to refuse the trade: the
        // quote on screen is still inside its deadline, and the contract's
        // slippage check is what actually protects the price.
        .catch(() => null);
      const live = fresh ?? quote;
      // A visitor's quote (quoteOnly) has nothing to sign; only a rebuild does.
      if (live.steps.length === 0) throw new Error("Could not build this trade. Try again.");
      if (fresh) {
        setQuote(fresh);
        quotedAt.current = Date.now();
      }
      if (side === "buy" && live.quote.marketOpen === false) {
        throw new Error("Market closed — the stock price is stale, so buys are paused. You can still sell.");
      }

      const labels = live.steps.map((step) => step.label);
      const sent = await wallet.send(live.steps, {
        chainId: live.chainId,
        onProgress: (at) => setProgress({ labels, at }),
      });
      const landed = sent.hashes[sent.hashes.length - 1]!;
      setTxHash(landed);
      setLandedAt(sent.confirmedAt);
      setStage("done");
      onFilled?.(exactOut ? (live.quote.amountIn ?? value) : value);

      // The announcement, if one was written. Its failure is reported on its
      // own line: the trade is already on chain and saying "the trade failed"
      // here would be false.
      const body = note.trim();
      if (body) {
        try {
          await juno.addComment({
            coin: coin.address,
            wallet: address,
            body,
            side,
            txHash: landed,
          });
          setNote("");
          onCommented?.();
        } catch (caught) {
          setNoteError(
            caught instanceof Error
              ? `The trade landed; your note did not post: ${caught.message}`
              : "The trade landed; your note did not post.",
          );
        }
      }
    } catch (caught) {
      const failure = describeTxError(caught);
      // Declined in the wallet, or the sign-in sheet was closed: say nothing.
      setError(failure.cancelled ? null : failure.message || "The trade failed");
      setStage("entry");
    } finally {
      setProgress(null);
    }
  }

  const receiving = useMemo(() => {
    if (!quote) return null;
    return side === "buy"
      ? `${tokens(quote.quote.amountOut)} ${coin.symbol}`
      : money(quote.quote.amountOut, coin.quote.symbol, { compact: false });
  }, [quote, side, coin.symbol, coin.quote.symbol]);

  /**
   * The quick sizes, in whatever unit the trade is actually denominated in.
   *
   * Dollars when a feed gives a rate to convert them at, because "$20" is the
   * size someone has in mind and "0.0045 ETH" is the same thought after
   * arithmetic they should not have to do. Without a rate the dollar labels
   * would be a guess, so the presets fall back to quote units and say so by
   * showing the symbol.
   */
  const quickSizes = useMemo(() => {
    if (side === "sell") {
      return QUICK_SELL.map((fraction) => ({
        label: `${fraction * 100}%`,
        // Null when the balance is unknown: a percentage of an unknown number
        // is not a number, and the pill is disabled rather than guessing.
        amount: balance === null ? null : balance * fraction,
        // Never rounded up past what is held: a part rounds down, and 100% is
        // the whole holding (the server takes float noise above it as "all").
        text: balance === null ? null : fraction === 1 ? String(balance) : floorPrecision(balance * fraction),
      }));
    }
    if (exactOut) {
      return QUICK_TOKENS.map((size) => ({ label: tokens(size), amount: size }));
    }
    if (rate === null || rate <= 0) {
      return QUICK_QUOTE[coin.quote.symbol].map((size) => ({ label: `${size} ${coin.quote.symbol}`, amount: size }));
    }
    return QUICK_USD.map((dollars) => ({ label: `$${dollars}`, amount: dollars / rate }));
  }, [side, exactOut, balance, rate, coin.quote.symbol]);

  const done = stage === "done" && txHash !== null;
  const stepLabels = quote && quote.steps.length > 1 ? quote.steps.map((step) => step.label) : null;

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Scrim onPress={onClose} />

      <Sheet>
        <Grabber />

        <Row justify="space-between" align="center">
          <Row gap={8}>
            <SideTap
              $on={side === "buy"}
              $buy
              onPress={() => setSide("buy")}
              accessibilityRole="button"
              accessibilityState={{ selected: side === "buy" }}
            >
              <SideText $on={side === "buy"} $buy>
                Buy
              </SideText>
            </SideTap>
            <SideTap
              $on={side === "sell"}
              $buy={false}
              onPress={() => setSide("sell")}
              accessibilityRole="button"
              accessibilityState={{ selected: side === "sell" }}
            >
              <SideText $on={side === "sell"} $buy={false}>
                Sell
              </SideText>
            </SideTap>
          </Row>
          <Close onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
            <CloseMark>✕</CloseMark>
          </Close>
        </Row>

        {done ? (
          <Done>
            <DoneTitle>Done</DoneTitle>
            <Label muted style={{ textAlign: "center" }}>
              {side === "buy"
                ? `Bought ${receiving ?? ""}`
                : `Sold ${tokens(value)} ${coin.symbol} for ${receiving ?? ""}`}{" "}
              — confirmed on {NETWORK_NAME}.
            </Label>
            {noteError ? <ErrorText>{noteError}</ErrorText> : null}
            <Receipt>
              tx {txHash!.slice(0, 10)}…{txHash!.slice(-8)}
              {landedAt
                ? ` · ${landedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
                : ""}
            </Receipt>
            <LinkTap onPress={() => Linking.openURL(explorer("tx", txHash!))}>
              <LinkText>View on {EXPLORER_NAME}</LinkText>
              <ExternalGlyph />
            </LinkTap>
            <Button label="Done" onPress={onDone} style={{ marginTop: 16, alignSelf: "stretch" }} />
          </Done>
        ) : (
          <>
            {/* The field, the token it is denominated in, and what you have to
                spend — the three things the number has to be read against, in
                one box. */}
            <Field $live={valid}>
              <Col gap={2} style={{ flex: 1 }}>
                <AmountRow>
                  <AmountValue numberOfLines={1}>{amount || "0"}</AmountValue>
                  <Caret />
                </AmountRow>
                <Caption>{usdEquivalent ? `~${usdEquivalent}` : " "}</Caption>
              </Col>
              <Col gap={4} style={{ alignItems: "flex-end" }}>
                {/* On a buy the chip is the switch: spend an exact amount of
                    the quote token, or receive an exact number of tokens. */}
                <Pressable
                  disabled={side !== "buy"}
                  onPress={() => {
                    setExact((on) => !on);
                    setAmount("");
                    setQuote(null);
                    setError(null);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={
                    exactOut
                      ? `Buying an exact number of ${coin.symbol}. Switch to spending ${coin.quote.symbol}`
                      : `Spending ${coin.quote.symbol}. Switch to buying an exact number of ${coin.symbol}`
                  }
                >
                  <TokenChip>
                    <TokenDot />
                    <TokenText>{unit}</TokenText>
                    {side === "buy" ? <TokenText>⇅</TokenText> : null}
                  </TokenChip>
                </Pressable>
                <Caption>
                  Balance: {balance === null ? "—" : `${tokens(balance)} ${balanceUnit}`}
                </Caption>
              </Col>
            </Field>

            <Row gap={8}>
              {quickSizes.map((preset) => (
                <Quick
                  key={preset.label}
                  disabled={preset.amount === null}
                  onPress={() =>
                    preset.amount === null
                      ? undefined
                      : setAmount(("text" in preset && preset.text) || trimTrailingZeros(preset.amount))
                  }
                >
                  <QuickLabel $off={preset.amount === null}>{preset.label}</QuickLabel>
                </Quick>
              ))}
            </Row>

            {/* How much this curve will take before it moves.
                A bonding curve's whole character is how it absorbs size, and
                that number was invisible in the one place a trader is deciding
                on size. */}
            {suggesting && !exactOut ? (
              <Depth>
                <Caption>Measuring what this curve will take…</Caption>
              </Depth>
            ) : suggestion && !exactOut ? (
              <Tappable
                onPress={() => setAmount(trimTrailingZeros(suggestion.amountIn))}
                to={0.98}
              >
                <Depth accessibilityRole="button">
                  <Col gap={2} style={{ flex: 1 }}>
                    <Label style={{ fontWeight: "700" }}>
                      {tokens(suggestion.amountIn)} {unit} moves it{" "}
                      {(suggestion.curveImpact * 100).toFixed(2)}%
                    </Label>
                    <Caption>
                      {suggestion.ceilingReached
                        ? `Everything this curve can still fill stays under ${
                            IMPACT_BUDGET * 100
                          }%.`
                        : `The most you can ${side} before the curve moves ${
                            IMPACT_BUDGET * 100
                          }%.`}
                    </Caption>
                  </Col>
                  <UseIt>Use</UseIt>
                </Depth>
              </Tappable>
            ) : null}

            {/* Network fee, and the curve's own cost beside it. They are
                different things and a trader deciding on size needs the second
                one: the fee does not grow with the order, the curve does. */}
            <Line>
              <Row gap={6}>
                <Label muted>Trading fee</Label>
                <Info />
              </Row>
              <Mono_>
                {quote
                  ? // `money` keeps small fees legible (0.0₄48 ETH) where four
                    // fixed decimals rounded a real fee on a small buy to 0.0000.
                    money(quote.quote.fee, coin.quote.symbol, { compact: false })
                  : quoting
                    ? "…"
                    : "—"}
              </Mono_>
            </Line>
            <Line>
              <Label muted>Price impact</Label>
              <Mono_
                $warn={(quote?.quote.priceImpact ?? 0) > 0.02}
              >
                {quote ? `${(quote.quote.priceImpact * 100).toFixed(2)}%` : quoting ? "…" : "—"}
              </Mono_>
            </Line>

            {/* What the curve will actually give you, quoted rather than
                multiplied out from spot. Blank rather than instructional when
                there is no amount yet: the caret in the field is already
                saying "type here", and a second voice saying it sat between
                two rows of figures where a figure belongs. */}
            <Receive>
              {quoting
                ? "Quoting against the curve…"
                : exactOut && quote?.quote.amountIn !== undefined
                  ? `Costs ${money(quote.quote.amountIn, coin.quote.symbol, { compact: false })} · at most ${money(
                      quote.quote.maximumAmountIn ?? quote.quote.amountIn,
                      coin.quote.symbol,
                      { compact: false },
                    )}`
                  : receiving
                    ? `You'll receive ${receiving}`
                    : " "}
            </Receive>

            {/* The announcement. Optional, and never the default — a trade is
                not a post unless you say so. */}
            <Note>
              <TextInput
                value={note}
                onChangeText={setNote}
                placeholder="Add a comment..."
                placeholderTextColor={theme.colors.faint}
                maxLength={280}
                style={{
                  flex: 1,
                  fontSize: theme.type.body.size,
                  color: theme.colors.text,
                }}
              />
            </Note>

            {/* No wallet means no quote — the button used to sit disabled
                with nothing saying why. Creating one is the next step. */}
            {/* The steps this trade takes, and where each has got to. A tracker
                buy is two transactions and the wallet asks twice; saying so
                beforehand is the difference between a flow and a surprise. */}
            {stage === "confirming" && progress ? (
              <Steps labels={progress.labels} at={progress.at} />
            ) : stepLabels ? (
              <Caption style={{ textAlign: "center" }}>{stepLabels.join("  →  ")}</Caption>
            ) : null}

            {!wallet.address ? (
              <Button
                label="Sign in to trade"
                tall
                onPress={() => void wallet.connect().catch(() => undefined)}
                style={{ alignSelf: "stretch" }}
              />
            ) : (
              <Button
                label={
                  stage === "confirming"
                    ? progress
                      ? progress.at.phase === "signing"
                        ? `${progress.at.label}: confirm in wallet…`
                        : progress.at.phase === "checking"
                          ? `${progress.at.label}: checking…`
                          : `${progress.at.label}: confirming…`
                      : "Confirming…"
                    : blocker
                      ? blocker.short
                      : side === "buy"
                        ? "Buy"
                        : "Sell"
                }
                variant={side === "buy" ? "lime" : "sell"}
                tall
                onPress={confirm}
                loading={stage === "confirming" || wallet.signing}
                disabled={!quote || quoting || !!blocker}
                style={{ alignSelf: "stretch" }}
              />
            )}

            {navWarning && !blocker ? <WarnText>{navWarning}</WarnText> : null}
            {blocker ? <HintText>{blocker.text}</HintText> : null}
            {error ? <ErrorText>{error}</ErrorText> : null}

            <Pad>
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "back"].map((key) => (
                <Key
                  key={key}
                  onPress={() => press(key)}
                  accessibilityRole="button"
                  accessibilityLabel={key === "back" ? "Delete" : key}
                >
                  <KeyLabel>{key === "back" ? "⌫" : key}</KeyLabel>
                </Key>
              ))}
            </Pad>
          </>
        )}
      </Sheet>
    </Modal>
  );
}

/**
 * A size as a typed amount rather than a float's decimal expansion.
 *
 * `20 / 114.03` is `0.17539244058581952`, which is not something anyone typed
 * and reads as noise in a field. Six significant figures is more precision
 * than any curve quote needs and still exact enough that the dollar figure
 * beside it rounds to the preset.
 */
function trimTrailingZeros(value: number): string {
  return String(Number(value.toPrecision(6)));
}

/** Six significant figures, rounded down: a share of a holding never exceeds it. */
function floorPrecision(value: number): string {
  if (!(value > 0)) return "0";
  const step = 10 ** (Math.floor(Math.log10(value)) - 5);
  return String(Number((Math.floor(value / step) * step).toPrecision(6)));
}

/** "Approve USDC ✓ → Buy …", live while the wallet works through the steps. */
function Steps({ labels, at }: { labels: string[]; at: SendProgress }) {
  return (
    <Row gap={8} justify="center" align="center" style={{ flexWrap: "wrap" }}>
      {labels.map((label, index) => {
        const done = index < at.index || (index === at.index && at.phase === "confirmed");
        const active = index === at.index && !done;
        return (
          <Row key={`${label}-${index}`} gap={8} align="center">
            {index > 0 ? <StepArrow>→</StepArrow> : null}
            <StepChip $done={done} $active={active}>
              <StepText $done={done} $active={active}>
                {done ? "✓ " : active ? "… " : ""}
                {label}
              </StepText>
            </StepChip>
          </Row>
        );
      })}
    </Row>
  );
}

function Info() {
  return (
    <Svg width={14} height={14} viewBox="0 0 16 16" fill="none">
      <Circle cx={8} cy={8} r={6.6} stroke={theme.colors.faint} strokeWidth={1.6} />
      <Path d="M8 7.2v4" stroke={theme.colors.faint} strokeWidth={1.8} strokeLinecap="round" />
      <Circle cx={8} cy={4.9} r={0.95} fill={theme.colors.faint} />
    </Svg>
  );
}

const WarnText = styled.Text`
  font-size: ${(p) => p.theme.type.label.size}px;
  line-height: 19px;
  font-weight: 600;
  color: ${(p) => p.theme.colors.neg};
  text-align: center;
`;

const Receipt = styled.Text`
  margin-top: 6px;
  font-size: 12px;
  font-family: ${Platform.OS === "ios" ? "Menlo" : "monospace"};
  color: ${(p) => p.theme.colors.muted};
  text-align: center;
`;

const HintText = styled.Text`
  font-size: ${(p) => p.theme.type.label.size}px;
  line-height: 19px;
  color: ${(p) => p.theme.colors.muted};
  text-align: center;
`;

const StepArrow = styled.Text`
  font-size: ${(p) => p.theme.type.caption.size}px;
  color: ${(p) => p.theme.colors.faint};
`;

const StepChip = styled.View<{ $done: boolean; $active: boolean }>`
  padding: 5px 10px;
  border-radius: ${(p) => p.theme.radius.pill}px;
  background-color: ${(p) => (p.$done ? p.theme.colors.lime : p.$active ? p.theme.colors.surfaceAlt : "transparent")};
  border-width: ${(p) => p.theme.hairline}px;
  border-color: ${(p) => (p.$done ? p.theme.colors.lime : p.theme.colors.line)};
`;

const StepText = styled.Text<{ $done: boolean; $active: boolean }>`
  font-size: ${(p) => p.theme.type.caption.size}px;
  font-weight: 800;
  color: ${(p) => (p.$done ? p.theme.colors.onLime : p.$active ? p.theme.colors.text : p.theme.colors.faint)};
`;

const Scrim = styled.Pressable`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(18, 21, 14, 0.45);
`;

const Sheet = styled.View`
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  /* A Modal renders over the whole window on web, not inside the app's
     phone-width frame — so the sheet holds the same width itself. */
  max-width: 480px;
  margin-horizontal: auto;
  background-color: ${(p) => p.theme.colors.surface};
  border-top-left-radius: ${(p) => p.theme.radius.xl}px;
  border-top-right-radius: ${(p) => p.theme.radius.xl}px;
  padding: ${(p) => p.theme.space(4)}px;
  padding-bottom: ${(p) => p.theme.space(8)}px;
  gap: ${(p) => p.theme.space(3)}px;
`;

const Grabber = styled.View`
  width: 40px;
  height: 4px;
  border-radius: 2px;
  background-color: ${(p) => p.theme.colors.line};
  align-self: center;
`;

const SideTap = styled.Pressable<{ $on: boolean; $buy: boolean }>`
  padding: 9px 18px;
  border-radius: ${(p) => p.theme.radius.md}px;
  background-color: ${(p) =>
    !p.$on ? "transparent" : p.$buy ? p.theme.colors.lime : p.theme.colors.negSoft};
`;

const SideText = styled.Text<{ $on: boolean; $buy: boolean }>`
  font-size: ${(p) => p.theme.type.lead.size}px;
  font-weight: 800;
  letter-spacing: ${(p) => p.theme.type.lead.tracking}px;
  color: ${(p) =>
    !p.$on ? p.theme.colors.faint : p.$buy ? p.theme.colors.onLime : p.theme.colors.neg};
`;

const Close = styled.Pressable`
  width: 32px;
  height: 32px;
  border-radius: 16px;
  background-color: ${(p) => p.theme.colors.surfaceAlt};
  align-items: center;
  justify-content: center;
`;

const CloseMark = styled.Text`
  font-size: ${(p) => p.theme.type.body.size}px;
  color: ${(p) => p.theme.colors.muted};
`;

const Field = styled.View<{ $live: boolean }>`
  flex-direction: row;
  align-items: center;
  gap: ${(p) => p.theme.space(3)}px;
  padding: ${(p) => p.theme.space(4)}px;
  border-radius: ${(p) => p.theme.radius.lg}px;
  border-width: 1.5px;
  border-color: ${(p) => (p.$live ? p.theme.colors.ink : p.theme.colors.line)};
  background-color: ${(p) => p.theme.colors.surface};
`;

const AmountRow = styled.View`
  flex-direction: row;
  align-items: center;
  gap: 2px;
`;

const AmountValue = styled.Text`
  font-size: ${(p) => p.theme.type.heading.size}px;
  line-height: ${(p) => p.theme.type.heading.height}px;
  letter-spacing: ${(p) => p.theme.type.heading.tracking}px;
  font-weight: 800;
  font-variant: tabular-nums;
  color: ${(p) => p.theme.colors.text};
`;

/* The caret. The pad is the keyboard, so the field never takes focus and
   never draws one of its own — without this the box reads as a label. */
const Caret = styled.View`
  width: 2px;
  height: ${(p) => p.theme.type.heading.size}px;
  background-color: ${(p) => p.theme.colors.focus};
  margin-left: 2px;
`;

const TokenChip = styled.View`
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border-radius: ${(p) => p.theme.radius.pill}px;
  background-color: ${(p) => p.theme.colors.surfaceAlt};
`;

const TokenDot = styled.View`
  width: 14px;
  height: 14px;
  border-radius: 7px;
  background-color: ${(p) => p.theme.colors.ink};
`;

const TokenText = styled.Text`
  font-size: ${(p) => p.theme.type.caption.size}px;
  font-weight: 800;
  color: ${(p) => p.theme.colors.text};
`;

const Depth = styled.View`
  flex-direction: row;
  align-items: center;
  gap: ${(p) => p.theme.space(3)}px;
  padding: ${(p) => p.theme.space(3)}px;
  border-radius: ${(p) => p.theme.radius.md}px;
  background-color: ${(p) => p.theme.colors.surfaceAlt};
`;

const UseIt = styled.Text`
  font-size: ${(p) => p.theme.type.caption.size}px;
  font-weight: 800;
  color: ${(p) => p.theme.colors.focus};
`;

const Line = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
`;

const Mono_ = styled.Text<{ $warn?: boolean }>`
  font-size: ${(p) => p.theme.type.label.size}px;
  font-weight: 700;
  font-variant: tabular-nums;
  color: ${(p) => (p.$warn ? p.theme.colors.neg : p.theme.colors.text)};
`;

const Receive = styled.Text`
  font-size: ${(p) => p.theme.type.label.size}px;
  font-weight: 600;
  color: ${(p) => p.theme.colors.text};
  min-height: 18px;
`;

const Note = styled.View`
  flex-direction: row;
  align-items: center;
  padding-horizontal: ${(p) => p.theme.space(4)}px;
  padding-vertical: 12px;
  border-radius: ${(p) => p.theme.radius.md}px;
  border-width: ${(p) => p.theme.hairline}px;
  border-color: ${(p) => p.theme.colors.line};
  background-color: ${(p) => p.theme.colors.surface};
`;

const Quick = styled.Pressable`
  flex: 1;
  padding-vertical: ${(p) => p.theme.space(3)}px;
  border-radius: ${(p) => p.theme.radius.md}px;
  border-width: ${(p) => p.theme.hairline}px;
  border-color: ${(p) => p.theme.colors.line};
  align-items: center;
`;

const QuickLabel = styled.Text<{ $off?: boolean }>`
  font-size: ${(p) => p.theme.type.label.size}px;
  font-weight: 700;
  color: ${(p) => (p.$off ? p.theme.colors.faint : p.theme.colors.text)};
`;

const Pad = styled.View`
  flex-direction: row;
  flex-wrap: wrap;
`;

const Key = styled.Pressable`
  width: 33.33%;
  padding-vertical: ${(p) => p.theme.space(3)}px;
  align-items: center;
`;

const KeyLabel = styled.Text`
  font-size: ${(p) => p.theme.type.heading.size}px;
  font-weight: 500;
  color: ${(p) => p.theme.colors.text};
`;

const Done = styled.View`
  align-items: center;
  gap: ${(p) => p.theme.space(2)}px;
  padding-vertical: ${(p) => p.theme.space(6)}px;
`;

const DoneTitle = styled.Text`
  font-size: ${(p) => p.theme.type.heading.size}px;
  font-weight: 800;
  color: ${(p) => p.theme.colors.pos};
`;

const LinkTap = styled.Pressable`
  flex-direction: row;
  align-items: center;
  gap: 6px;
  margin-top: ${(p) => p.theme.space(2)}px;
`;

const LinkText = styled.Text`
  font-size: ${(p) => p.theme.type.label.size}px;
  font-weight: 700;
  color: ${(p) => p.theme.colors.focus};
`;

const ErrorText = styled.Text`
  font-size: ${(p) => p.theme.type.label.size}px;
  color: ${(p) => p.theme.colors.neg};
  text-align: center;
`;
