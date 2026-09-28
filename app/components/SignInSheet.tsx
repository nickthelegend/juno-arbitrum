import { useEffect, useState } from "react";
import { ActivityIndicator, TextInput } from "react-native";
import styled from "styled-components/native";

import { BottomSheet } from "./BottomSheet";
import { Body, Button, Caption, Title } from "./kit";
import type { PrivyBridge } from "../lib/privy.types";
import { theme } from "../theme";

/**
 * Sign in with email; Privy makes the Solana wallet.
 *
 * Three steps in one sheet: an email address, the six-digit code Privy sends
 * to it, then a short wait while the embedded wallet is created. The wallet
 * provider closes the sheet once an address exists, so this component never
 * has to know what the caller was trying to do.
 */
export function SignInSheet({
  visible,
  onClose,
  privy,
}: {
  visible: boolean;
  onClose: () => void;
  privy: PrivyBridge;
}) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Start clean each time the sheet opens.
  useEffect(() => {
    if (!visible) return;
    setCode("");
    setStep("email");
    setError(null);
    setBusy(false);
  }, [visible]);

  const creating = privy.status === "creating" || privy.status === "error";

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    try {
      await privy.sendCode(email.trim());
      setStep("code");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the code");
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      await privy.loginWithCode(code.trim(), email.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "That code did not work");
      setBusy(false);
    }
  };

  const validEmail = /.+@.+\..+/.test(email.trim());

  return (
    <BottomSheet visible={visible} onClose={onClose} dismissable={!busy}>
      <Sheet>
        <Title>{creating ? "Creating your wallet" : "Sign in to Juno"}</Title>
        <Body muted>
          {creating
            ? "Privy is making a Solana wallet for this account."
            : step === "email"
              ? "Privy creates a Solana wallet for you. No seed phrase, nothing to install."
              : `Enter the six-digit code sent to ${email.trim()}.`}
        </Body>

        {creating ? (
          <Waiting>
            {privy.error || !["creating", "connecting", "reconnecting"].includes(privy.walletStatus) ? (
              <Button
                label="Try again"
                variant="ink"
                onPress={() => void privy.retry().catch((e) => setError(e instanceof Error ? e.message : String(e)))}
              />
            ) : (
              <ActivityIndicator color={theme.colors.text} />
            )}
            <Caption>{privy.error ?? `Wallet: ${privy.walletStatus}`}</Caption>
          </Waiting>
        ) : step === "email" ? (
          <>
            <Field>
              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="you@example.com"
                placeholderTextColor={theme.colors.faint}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                textContentType="emailAddress"
                returnKeyType="send"
                onSubmitEditing={() => validEmail && void sendCode()}
                style={{ fontSize: theme.type.body.size, color: theme.colors.text }}
              />
            </Field>
            <Button label="Send code" onPress={() => void sendCode()} loading={busy} disabled={!validEmail} tall />
          </>
        ) : (
          <>
            <Field>
              <TextInput
                value={code}
                onChangeText={(text) => setCode(text.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456"
                placeholderTextColor={theme.colors.faint}
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                autoComplete="one-time-code"
                style={{
                  fontSize: theme.type.title.size,
                  letterSpacing: 6,
                  color: theme.colors.text,
                }}
              />
            </Field>
            <Button label="Verify" onPress={() => void verify()} loading={busy} disabled={code.length !== 6} tall />
            <Caption onPress={() => setStep("email")}>Use a different email</Caption>
          </>
        )}

        {error ? <ErrorText>{error}</ErrorText> : null}
        <Secured>Secured by Privy</Secured>
      </Sheet>
    </BottomSheet>
  );
}

const Sheet = styled.View`
  gap: ${(p) => p.theme.space(3)}px;
  padding: ${(p) => p.theme.space(2)}px ${(p) => p.theme.space(5)}px ${(p) => p.theme.space(8)}px;
`;

const Field = styled.View`
  padding-horizontal: ${(p) => p.theme.space(4)}px;
  padding-vertical: 14px;
  border-radius: ${(p) => p.theme.radius.md}px;
  background-color: ${(p) => p.theme.colors.surfaceAlt};
  border-width: ${(p) => p.theme.hairline}px;
  border-color: ${(p) => p.theme.colors.lineStrong};
`;

const Waiting = styled.View`
  padding-vertical: ${(p) => p.theme.space(5)}px;
  align-items: center;
  gap: ${(p) => p.theme.space(3)}px;
`;

const ErrorText = styled.Text`
  font-size: ${(p) => p.theme.type.label.size}px;
  color: ${(p) => p.theme.colors.neg};
`;

const Secured = styled.Text`
  text-align: center;
  font-size: ${(p) => p.theme.type.caption.size}px;
  color: ${(p) => p.theme.colors.faint};
`;
