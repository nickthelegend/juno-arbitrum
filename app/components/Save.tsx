import { useCallback, useEffect, useState } from "react";
import { TextInput } from "react-native";
import Svg, { Path } from "react-native-svg";
import styled from "styled-components/native";

import { BottomSheet } from "./BottomSheet";
import { Tappable } from "./Press";
import { Body, Button, Caption, Col, Label, Pill, Progress, Row, Segmented } from "./kit";
import { juno, type Coin, type Plan } from "../lib/api";
import { money, tokens } from "../lib/useApi";
import { theme } from "../theme";

/**
 * The savings half of the app, on a coin's own page.
 *
 * Juno could show you a market and let you trade it once. Nothing let you say
 * *keep an eye on this* or *put the same amount in every week*, which is the
 * difference between a launchpad and somewhere you come back to.
 *
 * ## What is real here and what is not
 *
 * The watch and the alert are rows in Postgres, and the alert resolves against
 * the price this screen already read from the chain. The plan is also a row —
 * and it does **not** execute itself. Signing a swap on someone's behalf needs
 * a delegate or a session key with spending authority, which this project does
 * not have and will not pretend to: the plan says when it is due, and the buy
 * is the same device-signed transaction as any other buy. `contributed` moves
 * only after a signature lands, so the progress bar is a record of
 * transactions rather than of intentions.
 *
 * ## Units
 *
 * Plan amounts are quote-token units — SOL or USDC — because that is what the
 * transaction is denominated in. They are labelled with the quote symbol
 * everywhere, and converted to dollars only where a Pyth rate exists to
 * convert them with.
 */

export type SavedState = {
  watching: boolean;
  alertPrice: number | null;
  alertSetAtPrice: number | null;
  plans: Omit<Plan, "coin">[];
};

const CADENCES = [
  { id: "daily" as const, label: "Daily" },
  { id: "weekly" as const, label: "Weekly" },
  { id: "monthly" as const, label: "Monthly" },
];

/* ------------------------------------------------------------------ */
/* The watch toggle, for the nav bar                                   */
/* ------------------------------------------------------------------ */

/**
 * Watch / Watching, as one tap.
 *
 * Optimistic, and it rolls back. A watch is a row insert that either happened
 * or did not, and waiting a round trip to fill in a shape makes the control
 * feel broken on a connection that is merely slow. When the write fails the
 * state goes back and the error surfaces on the card below, rather than
 * leaving a filled eye over a row that was never written.
 */
export function WatchToggle({
  saved,
  wallet,
  baseMint,
  onChange,
}: {
  saved: SavedState | null;
  wallet: string | null;
  baseMint: string;
  onChange: (next: SavedState) => void;
}) {
  const [busy, setBusy] = useState(false);
  const on = saved?.watching === true;

  const toggle = useCallback(async () => {
    if (!wallet || !saved || busy) return;
    const next = !on;
    setBusy(true);
    onChange({ ...saved, watching: next, ...(next ? {} : { alertPrice: null, alertSetAtPrice: null }) });
    try {
      await juno.setWatch({ wallet, baseMint, watch: next });
    } catch {
      onChange(saved);
    } finally {
      setBusy(false);
    }
  }, [wallet, saved, busy, on, baseMint, onChange]);

  // Nothing to toggle until we know the current answer: a control that shows
  // "Watch" before the read lands would flip under the thumb.
  if (!wallet || !saved) return null;

  return (
    <Tappable onPress={() => void toggle()} to={0.92}>
      <WatchBox $on={on} accessibilityRole="button" accessibilityLabel={on ? "Stop watching" : "Watch"}>
        <EyeGlyph on={on} />
        <WatchText $on={on}>{on ? "Watching" : "Watch"}</WatchText>
      </WatchBox>
    </Tappable>
  );
}

const WatchBox = styled.View<{ $on: boolean }>`
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding: 7px 12px 7px 10px;
  border-radius: 999px;
  background-color: ${(p) => (p.$on ? p.theme.colors.ink : p.theme.colors.surfaceAlt)};
`;

const WatchText = styled.Text<{ $on: boolean }>`
  font-size: ${(p) => p.theme.type.caption.size}px;
  font-weight: 700;
  letter-spacing: ${(p) => p.theme.type.caption.tracking}px;
  color: ${(p) => (p.$on ? p.theme.colors.onInk : p.theme.colors.muted)};
`;

/**
 * An eye, open or shut.
 *
 * A star would have been the obvious mark and is the wrong one: a star means
 * *favourite*, and this list is not a list of things you like. It is a list of
 * things you are looking at, which is also exactly what the alert attached to
 * it does.
 */
function EyeGlyph({ on }: { on: boolean }) {
  const color = on ? theme.colors.onInk : theme.colors.muted;
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <Path
        d="M1.5 8s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4S1.5 8 1.5 8Z"
        stroke={color}
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {on ? (
        <Path d="M8 6.1a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 0 0 0-3.8Z" fill={color} />
      ) : null}
    </Svg>
  );
}

/* ------------------------------------------------------------------ */
/* The card                                                            */
/* ------------------------------------------------------------------ */

export function SaveCard({
  coin,
  saved,
  wallet,
  error,
  onEditAlert,
  onNewPlan,
  onContribute,
  onTogglePlan,
}: {
  coin: Coin;
  saved: SavedState | null;
  wallet: string | null;
  error: string | null;
  onEditAlert: () => void;
  onNewPlan: () => void;
  onContribute: (plan: Omit<Plan, "coin">) => void;
  onTogglePlan: (plan: Omit<Plan, "coin">) => void;
}) {
  if (!wallet || !saved) return null;

  const direction = alertDirection(saved, coin.priceUsd);

  return (
    <Box>
      <Row justify="space-between">
        <Label muted>Keep at it</Label>
        {saved.plans.some((plan) => plan.due && plan.active) ? (
          <Pill label="Due now" tone="lime" />
        ) : null}
      </Row>

      {error ? <Body style={{ color: theme.colors.neg, marginTop: 10 }}>{error}</Body> : null}

      {/* Alert */}
      <AlertRow onPress={onEditAlert} accessibilityRole="button">
        <Col gap={2} style={{ flex: 1 }}>
          <Label>
            {saved.alertPrice === null
              ? "Alert me at a price"
              : `Alert at ${price(saved.alertPrice, coin.marketCapCurrency)}`}
          </Label>
          <Caption>
            {saved.alertPrice === null
              ? "Watching it is not the same as being told."
              : direction === "fired"
                ? "It has crossed."
                : direction === "up"
                  ? "Fires when it rises to there."
                  : "Fires when it falls to there."}
          </Caption>
        </Col>
        {saved.alertPrice !== null && direction === "fired" ? (
          <Pill label="Crossed" tone="pos" />
        ) : null}
        <SetText>{saved.alertPrice === null ? "Set" : "Change"}</SetText>
      </AlertRow>

      {/* Plans */}
      {saved.plans.map((plan) => {
        const pct =
          plan.target && plan.target > 0
            ? Math.max(0, Math.min(1, plan.contributed / plan.target))
            : null;
        return (
          <PlanBlock key={plan.id}>
            <Row justify="space-between" align="center">
              <Col gap={2} style={{ flex: 1 }}>
                <Label style={{ fontWeight: "700" }}>
                  {tokens(plan.amount)} {coin.quote.symbol} {plan.cadence}
                </Label>
                <Caption>
                  {plan.fills === 0
                    ? "Nothing put in yet"
                    : `${tokens(plan.contributed)} ${coin.quote.symbol} in, over ${plan.fills} ${
                        plan.fills === 1 ? "fill" : "fills"
                      }`}
                </Caption>
              </Col>
              <Tappable onPress={() => onTogglePlan(plan)} to={0.94}>
                <QuietTap>
                  <QuietText>{plan.active ? "Pause" : "Resume"}</QuietText>
                </QuietTap>
              </Tappable>
            </Row>

            {pct !== null ? (
              <Col gap={6} style={{ marginTop: 12 }}>
                <Progress pct={pct * 100} />
                <Caption>
                  {tokens(plan.contributed)} of {tokens(plan.target!)} {coin.quote.symbol}
                </Caption>
              </Col>
            ) : null}

            {plan.active ? (
              <Button
                label={`Put in ${tokens(plan.amount)} ${coin.quote.symbol}`}
                variant={plan.due ? "lime" : "quiet"}
                onPress={() => onContribute(plan)}
                style={{ marginTop: 14, alignSelf: "stretch" }}
              />
            ) : null}
          </PlanBlock>
        );
      })}

      <Button
        label={saved.plans.length === 0 ? "Buy this every week" : "Add another schedule"}
        variant="quiet"
        onPress={onNewPlan}
        style={{ marginTop: 14, alignSelf: "stretch" }}
      />
    </Box>
  );
}

/**
 * Where an alert stands, against the price on screen.
 *
 * `"fired"` is a real third answer and not a styling flourish: an alert set
 * above the price at the time is an upward one, and once the price is there
 * the sentence "fires when it rises to there" is false.
 */
function alertDirection(saved: SavedState, priceNow: number): "up" | "down" | "fired" | null {
  if (saved.alertPrice === null || saved.alertSetAtPrice === null) return null;
  const wantsUp = saved.alertPrice > saved.alertSetAtPrice;
  if (wantsUp) return priceNow >= saved.alertPrice ? "fired" : "up";
  return priceNow <= saved.alertPrice ? "fired" : "down";
}

/* ------------------------------------------------------------------ */
/* The sheets                                                          */
/* ------------------------------------------------------------------ */

export function AlertSheet({
  visible,
  onClose,
  coin,
  wallet,
  saved,
  onSaved,
}: {
  visible: boolean;
  onClose: () => void;
  coin: Coin;
  wallet: string | null;
  saved: SavedState | null;
  onSaved: (next: SavedState) => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seeded on the way in, so reopening shows what is set rather than a blank.
  useEffect(() => {
    if (!visible) return;
    setError(null);
    setValue(saved?.alertPrice === null || saved?.alertPrice === undefined ? "" : String(saved.alertPrice));
  }, [visible, saved?.alertPrice]);

  const target = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(target) && target > 0;
  const willFire = valid ? (target > coin.priceUsd ? "rises" : target < coin.priceUsd ? "falls" : null) : null;

  async function save(clear: boolean) {
    if (!wallet || !saved) return;
    setBusy(true);
    setError(null);
    try {
      await juno.setWatch({
        wallet,
        baseMint: coin.address,
        watch: true,
        ...(clear ? {} : { alertPrice: target, priceNow: coin.priceUsd }),
      });
      onSaved({
        ...saved,
        watching: true,
        alertPrice: clear ? null : target,
        alertSetAtPrice: clear ? null : coin.priceUsd,
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The alert could not be saved");
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet visible={visible} onClose={onClose} dismissable={!busy}>
      <SheetBody>
        <Col gap={4}>
          <Label muted>Alert me on {coin.symbol}</Label>
          <Caption>Now {price(coin.priceUsd, coin.marketCapCurrency)}</Caption>
        </Col>

        <Field>
          <FieldUnit>{coin.marketCapCurrency === "USD" ? "$" : coin.marketCapCurrency}</FieldUnit>
          <TextInput
            value={value}
            onChangeText={(next) => setValue(decimalOnly(next))}
            keyboardType="decimal-pad"
            placeholder="0.00"
            placeholderTextColor={theme.colors.faint}
            autoFocus
            style={{
              flex: 1,
              fontSize: theme.type.heading.size,
              fontWeight: "700",
              color: theme.colors.text,
            }}
          />
        </Field>

        {/* The direction is never asked for — it is implied by the number
            against the price, and a picker for it would be a way to disagree
            with arithmetic. */}
        <Caption>
          {willFire === null
            ? "Above or below today's price — whichever you type decides which."
            : `Fires when ${coin.symbol} ${willFire} to ${price(target, coin.marketCapCurrency)}.`}
        </Caption>

        {error ? <Body style={{ color: theme.colors.neg }}>{error}</Body> : null}

        <Row gap={10}>
          {saved?.alertPrice !== null && saved?.alertPrice !== undefined ? (
            <Tappable onPress={() => void save(true)} to={0.96}>
              <QuietTap>
                <QuietText>Remove</QuietText>
              </QuietTap>
            </Tappable>
          ) : null}
          <Grow />
          <Button
            label={busy ? "Saving…" : "Set alert"}
            loading={busy}
            disabled={!valid}
            onPress={() => void save(false)}
          />
        </Row>
      </SheetBody>
    </BottomSheet>
  );
}

export function PlanSheet({
  visible,
  onClose,
  coin,
  wallet,
  saved,
  onSaved,
}: {
  visible: boolean;
  onClose: () => void;
  coin: Coin;
  wallet: string | null;
  saved: SavedState | null;
  onSaved: (next: SavedState) => void;
}) {
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState<"daily" | "weekly" | "monthly">("weekly");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) return;
    const timer = setTimeout(() => {
      setAmount("");
      setTarget("");
      setCadence("weekly");
      setError(null);
    }, 300);
    return () => clearTimeout(timer);
  }, [visible]);

  const value = Number(amount);
  const goal = target.trim() === "" ? null : Number(target);
  const validAmount = amount.trim() !== "" && Number.isFinite(value) && value > 0;
  // The same rule the server enforces, checked here so the button is not live
  // on a request that is already going to be refused.
  const validGoal = goal === null || (Number.isFinite(goal) && goal >= value);
  const rate = coin.quoteUsdRate;

  async function create() {
    if (!wallet) return;
    setBusy(true);
    setError(null);
    try {
      const { id } = await juno.createPlan({
        wallet,
        baseMint: coin.address,
        amount: value,
        cadence,
        target: goal,
      });
      onSaved({
        ...(saved ?? { watching: false, alertPrice: null, alertSetAtPrice: null, plans: [] }),
        plans: [
          {
            id,
            baseMint: coin.address,
            amount: value,
            cadence,
            target: goal,
            contributed: 0,
            fills: 0,
            lastFilledAt: null,
            // A plan that has never filled is due immediately — the same rule
            // the server applies, so the card does not disagree with the list.
            nextDueAt: new Date().toISOString(),
            due: true,
            active: true,
          },
          ...(saved?.plans ?? []),
        ],
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The plan could not be created");
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet visible={visible} onClose={onClose} dismissable={!busy}>
      <SheetBody>
        <Col gap={4}>
          <Label muted>Buy {coin.symbol} on a schedule</Label>
          <Caption>
            Juno cannot spend from your wallet, so nothing happens without you. This says how much
            and how often, and tells you when it is due.
          </Caption>
        </Col>

        <Field>
          <FieldUnit>{coin.quote.symbol}</FieldUnit>
          <TextInput
            value={amount}
            onChangeText={(next) => setAmount(decimalOnly(next))}
            keyboardType="decimal-pad"
            placeholder="0.00"
            placeholderTextColor={theme.colors.faint}
            autoFocus
            style={{
              flex: 1,
              fontSize: theme.type.heading.size,
              fontWeight: "700",
              color: theme.colors.text,
            }}
          />
          {validAmount && rate !== null ? (
            <FieldAside>{money(value * rate, "USD", { compact: false })}</FieldAside>
          ) : null}
        </Field>

        <Segmented items={CADENCES} value={cadence} onChange={setCadence} />

        <Col gap={8}>
          <Caption>Goal, optional</Caption>
          <Field>
            <FieldUnit>{coin.quote.symbol}</FieldUnit>
            <TextInput
              value={target}
              onChangeText={(next) => setTarget(decimalOnly(next))}
              keyboardType="decimal-pad"
              placeholder="No goal"
              placeholderTextColor={theme.colors.faint}
              style={{
                flex: 1,
                fontSize: theme.type.lead.size,
                color: theme.colors.text,
              }}
            />
          </Field>
          {!validGoal ? (
            <Caption style={{ color: theme.colors.neg }}>
              A goal has to be at least one contribution.
            </Caption>
          ) : null}
        </Col>

        {error ? <Body style={{ color: theme.colors.neg }}>{error}</Body> : null}

        <Button
          label={busy ? "Saving…" : "Start"}
          loading={busy}
          disabled={!validAmount || !validGoal}
          onPress={() => void create()}
          style={{ alignSelf: "stretch" }}
        />
      </SheetBody>
    </BottomSheet>
  );
}

/* ------------------------------------------------------------------ */

/** The coin page's own price format, duplicated rather than imported to keep
 *  this component free of a dependency on the screen that hosts it. */
function price(value: number, currency: string): string {
  return money(value, currency, { compact: false });
}

const Box = styled.View`
  background-color: ${(p) => p.theme.colors.surface};
  border-radius: ${(p) => p.theme.radius.lg}px;
  padding: ${(p) => p.theme.space(4)}px;
`;

const AlertRow = styled.Pressable`
  flex-direction: row;
  align-items: center;
  gap: 10px;
  margin-top: ${(p) => p.theme.space(3)}px;
  padding-top: ${(p) => p.theme.space(3)}px;
  border-top-width: ${(p) => p.theme.hairline}px;
  border-top-color: ${(p) => p.theme.colors.line};
`;

const SetText = styled.Text`
  font-size: ${(p) => p.theme.type.label.size}px;
  font-weight: 700;
  color: ${(p) => p.theme.colors.focus};
`;

const PlanBlock = styled.View`
  margin-top: ${(p) => p.theme.space(3)}px;
  padding-top: ${(p) => p.theme.space(3)}px;
  border-top-width: ${(p) => p.theme.hairline}px;
  border-top-color: ${(p) => p.theme.colors.line};
`;

const QuietTap = styled.View`
  padding: 8px 14px;
  border-radius: 999px;
  background-color: ${(p) => p.theme.colors.surfaceAlt};
`;

const QuietText = styled.Text`
  font-size: ${(p) => p.theme.type.caption.size}px;
  font-weight: 700;
  color: ${(p) => p.theme.colors.muted};
`;

const SheetBody = styled.View`
  padding: 0 ${(p) => p.theme.space(4)}px ${(p) => p.theme.space(4)}px;
  gap: ${(p) => p.theme.space(4)}px;
`;

const Field = styled.View`
  flex-direction: row;
  align-items: center;
  gap: 8px;
  padding: ${(p) => p.theme.space(3)}px;
  border-radius: ${(p) => p.theme.radius.lg}px;
  background-color: ${(p) => p.theme.colors.surfaceAlt};
`;

const FieldUnit = styled.Text`
  font-size: ${(p) => p.theme.type.lead.size}px;
  font-weight: 700;
  color: ${(p) => p.theme.colors.muted};
`;

const FieldAside = styled.Text`
  font-size: ${(p) => p.theme.type.label.size}px;
  font-variant: tabular-nums;
  color: ${(p) => p.theme.colors.muted};
`;

const Grow = styled.View`
  flex: 1;
`;

/**
 * Digits and one decimal point, nothing else.
 *
 * `keyboardType="decimal-pad"` only chooses a keyboard on a phone. On web and
 * with a hardware keyboard it constrains nothing, so a price field took
 * "abc" and sat there with a disabled button and no reason. A comma is read
 * as the decimal point, which is what a European keyboard types.
 */
function decimalOnly(text: string): string {
  const cleaned = text.replace(",", ".").replace(/[^0-9.]/g, "");
  const [whole, ...rest] = cleaned.split(".");
  return rest.length ? `${whole}.${rest.join("")}` : whole;
}
