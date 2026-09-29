import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Linking, StyleSheet, Text, TextInput, View } from "react-native";

import { Tappable } from "./Press";
import { Button } from "./kit";
import { api, FaucetLimited, juno } from "../lib/api";
import { displayAddress, explorer, EXPLORER_NAME, IS_TESTNET, NETWORK_NAME } from "../lib/chain";
import { rememberName, useName } from "../lib/names";
import { useWallet } from "../lib/wallet";
import { useApi } from "../lib/useApi";
import { theme } from "../theme";

/**
 * The wallet itself: its address, what it holds, and how to fund it.
 *
 * A new user could browse everything and do nothing, with no hint as to why:
 * every action costs gas. So the card shows the ETH and USDC balances, and on
 * Arbitrum Sepolia a faucet button that sends test ETH (and Juno's test USDC,
 * which stock trackers are priced in).
 *
 * Balances are read from chain and shown as a dash when the read fails, never
 * as zero: "0 ETH" on a throttled read would tell someone to go and fund a
 * wallet that is already funded.
 */
export function WalletCard({ address }: { address: string }) {
  const balances = useApi(() => juno.balances(address), [address]);
  const [copied, setCopied] = useState(false);
  const [funding, setFunding] = useState(false);
  const [message, setMessage] = useState<{ tone: "pos" | "neg"; text: string; url?: string } | null>(null);
  const shown = displayAddress(address);

  const copy = async () => {
    await Clipboard.setStringAsync(shown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const fund = async () => {
    setFunding(true);
    setMessage(null);
    try {
      const result = await juno.faucet(address);
      setMessage({
        tone: "pos",
        text: result.usdc ? "Test ETH and test USDC are on their way." : "Test ETH is on its way.",
        url: explorer("tx", result.eth),
      });
      // The faucet answers once its transfer is sent; the balance follows a
      // block later, so read it again after one.
      balances.refresh();
      setTimeout(() => balances.refresh(), 2500);
    } catch (error) {
      setMessage({
        tone: "neg",
        text:
          error instanceof FaucetLimited
            ? error.message
            : error instanceof Error
              ? error.message
              : "The faucet did not answer.",
      });
    } finally {
      setFunding(false);
    }
  };

  const figure = (value: number | null | undefined) =>
    balances.loading
      ? "…"
      : value === null || value === undefined || balances.error
        ? "—"
        : value.toFixed(value === 0 ? 2 : value < 1 ? 4 : 2);

  const empty = balances.data?.eth === 0;

  return (
    <View style={styles.card}>
      <NameEditor address={address} />
      <View style={styles.head}>
        <Text style={styles.label}>Wallet · {NETWORK_NAME}</Text>
        <Tappable onPress={() => void copy()} to={0.95} accessibilityRole="button" accessibilityLabel="Copy address">
          <View style={styles.copy}>
            <Text style={styles.copyText}>{copied ? "Copied" : "Copy address"}</Text>
          </View>
        </Tappable>
      </View>
      <Text
        style={styles.address}
        selectable
        numberOfLines={1}
        ellipsizeMode="middle"
        onPress={() => void Linking.openURL(explorer("address", address))}
      >
        {shown}
      </Text>

      <View style={styles.balances}>
        <View style={styles.balance}>
          <Text style={styles.amount}>{figure(balances.data?.eth)}</Text>
          <Text style={styles.unit}>ETH</Text>
        </View>
        <View style={styles.rule} />
        <View style={styles.balance}>
          <Text style={styles.amount}>{figure(balances.data?.usdc)}</Text>
          <Text style={styles.unit}>USDC</Text>
        </View>
      </View>

      {empty ? (
        <Text style={styles.hint}>Every buy and launch costs a little gas. Fund this wallet to start.</Text>
      ) : null}

      {IS_TESTNET ? (
        <Button
          label={funding ? "Asking the faucet…" : "Get test ETH"}
          variant={empty ? "lime" : "quiet"}
          loading={funding}
          onPress={() => void fund()}
        />
      ) : null}

      {message ? (
        <Text style={[styles.message, { color: message.tone === "pos" ? theme.colors.pos : theme.colors.neg }]}>
          {message.text}
          {message.url ? (
            <Text style={styles.link} onPress={() => void Linking.openURL(message.url!)}>
              {"  "}View on {EXPLORER_NAME}
            </Text>
          ) : null}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    padding: 16,
    gap: 12,
    ...theme.shadow.card,
  },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  label: { fontSize: 12, fontWeight: "700", color: theme.colors.muted, letterSpacing: 0.2 },
  copy: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: theme.colors.surfaceAlt },
  copyText: { fontSize: 12, fontWeight: "700", color: theme.colors.text },
  address: { fontSize: 13, fontWeight: "600", color: theme.colors.text, fontVariant: ["tabular-nums"] },
  balances: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  balance: { flex: 1, flexDirection: "row", alignItems: "baseline", gap: 6 },
  amount: { fontSize: 20, fontWeight: "800", color: theme.colors.text, fontVariant: ["tabular-nums"] },
  unit: { fontSize: 12, fontWeight: "700", color: theme.colors.muted },
  rule: { width: StyleSheet.hairlineWidth, alignSelf: "stretch", backgroundColor: theme.colors.lineStrong, marginHorizontal: 12 },
  hint: { fontSize: 13, lineHeight: 18, color: theme.colors.muted },
  message: { fontSize: 13, lineHeight: 18 },
  link: { fontWeight: "800", color: theme.colors.focus },
  name: { fontSize: 17, fontWeight: "800", color: theme.colors.text, marginTop: 2 },
  choose: { backgroundColor: theme.colors.lime },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    height: 46,
    paddingHorizontal: 14,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  at: { fontSize: 16, fontWeight: "800", color: theme.colors.muted, marginRight: 2 },
  nameInput: { flex: 1, fontSize: 16, fontWeight: "700", color: theme.colors.text },
});

/**
 * Claim a name. Signed by this wallet, so nobody can take yours or rename
 * you; checked and stored by the server, so everyone sees the same one.
 */
function NameEditor({ address }: { address: string }) {
  const wallet = useWallet();
  const current = useName(address);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleaned = draft.trim().toLowerCase();
  const valid = /^[a-z0-9_]{3,20}$/.test(cleaned);

  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const issuedAt = new Date().toISOString();
      // Exactly the text the server rebuilds and checks with `verifyMessage`
      // (docs/API.md): the wallet lowercase, signed with EIP-191 personal_sign.
      const message = `Juno name: ${cleaned}\nWallet: ${address.toLowerCase()}\nIssued: ${issuedAt}`;
      const signature = await wallet.signMessage(message);
      const result = await api.post<{ name: string }>("/api/juno/profiles", {
        wallet: address.toLowerCase(),
        name: cleaned,
        issuedAt,
        signature,
      });
      rememberName(address, result.name);
      setEditing(false);
    } catch (caught) {
      // Declined in the wallet: nothing to say.
      if ((caught as { cancelled?: boolean } | null)?.cancelled) return;
      setError(caught instanceof Error ? caught.message : "That name could not be saved");
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <View style={styles.head}>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Name</Text>
          <Text style={styles.name}>{current ? `@${current}` : "No name yet"}</Text>
        </View>
        <Tappable
          onPress={() => {
            setDraft(current ?? "");
            setEditing(true);
          }}
          to={0.95}
          accessibilityRole="button"
          accessibilityLabel={current ? "Change your name" : "Choose a name"}
        >
          <View style={[styles.copy, !current ? styles.choose : null]}>
            <Text style={styles.copyText}>{current ? "Change" : "Choose a name"}</Text>
          </View>
        </Tappable>
      </View>
    );
  }

  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.label}>Name</Text>
      <View style={styles.nameRow}>
        <Text style={styles.at}>@</Text>
        <TextInput
          value={draft}
          onChangeText={(next) => setDraft(next.replace(/[^A-Za-z0-9_]/g, "").slice(0, 20))}
          placeholder="yourname"
          placeholderTextColor={theme.colors.faint}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          style={styles.nameInput}
          onSubmitEditing={() => void save()}
        />
      </View>
      <Text style={[styles.hint, error ? { color: theme.colors.neg } : null]}>
        {error ?? (draft && !valid ? "3–20 letters, digits or underscores." : "Your wallet signs to claim it. Free, no transaction.")}
      </Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button label="Cancel" variant="quiet" onPress={() => setEditing(false)} style={{ flex: 1 }} />
        <Button label="Save" onPress={() => void save()} loading={saving} disabled={!valid} style={{ flex: 1 }} />
      </View>
    </View>
  );
}
