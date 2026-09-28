import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import styled from "styled-components/native";

import { OnboardingArt } from "../components/art";
import { Body, Button, Display } from "../components/kit";

/**
 * Onboarding.
 *
 * One screen, one action. Get Started drops straight into the feed — it does
 * not ask for an account, because a social feed behind a login is dead on
 * arrival and the first thing anyone sees should be the product working. A
 * wallet is created later, at the moment someone actually needs one.
 */
export default function Onboarding() {
  const router = useRouter();

  return (
    <Page edges={["top", "bottom"]}>
      <Art>
        <OnboardingArt size={320} />
      </Art>

      {/* What it is, in the first five seconds. "Social Trading Community"
          said nothing a judge could not have guessed from any fintech app;
          this names the mechanism, the chain, and the pre-IPO half — and
          that it is devnet, so nobody mistakes test SOL for money. */}
      <Copy>
        <Network>
          <Dot />
          <NetworkText>Solana devnet · no real money</NetworkText>
        </Network>
        <Display>Every post{"\n"}is a market.</Display>
        <Body muted>
          Post a photo or a reel and it launches its own Meteora bonding curve.
          Buy into the posts you believe in — creators earn the trading fees.
          Pre-IPO names like OpenAI and SpaceX trade here too, marked against
          Tessera.
        </Body>
      </Copy>

      <Button label="Get Started" tall onPress={() => router.replace("/(tabs)/social")} />
    </Page>
  );
}

const Page = styled(SafeAreaView)`
  flex: 1;
  background-color: ${(p) => p.theme.colors.bg};
  padding-horizontal: ${(p) => p.theme.space(6)}px;
  padding-bottom: ${(p) => p.theme.space(4)}px;
`;

const Art = styled.View`
  flex: 1;
  align-items: center;
  justify-content: center;
`;

const Copy = styled.View`
  gap: ${(p) => p.theme.space(3)}px;
  padding-bottom: ${(p) => p.theme.space(8)}px;
`;

const Network = styled.View`
  flex-direction: row;
  align-items: center;
  align-self: flex-start;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 999px;
  background-color: ${(p) => p.theme.colors.surface};
`;

const Dot = styled.View`
  width: 6px;
  height: 6px;
  border-radius: 3px;
  background-color: ${(p) => p.theme.colors.pos};
`;

const NetworkText = styled.Text`
  font-size: ${(p) => p.theme.type.caption.size}px;
  font-weight: 700;
  color: ${(p) => p.theme.colors.muted};
`;
