import Svg, { Circle, Path, Rect } from "react-native-svg";
import styled from "styled-components/native";

import { BottomSheet } from "./BottomSheet";
import { Tappable } from "./Press";
import { Caption, Chevron, Col, Label } from "./kit";
import { theme } from "../theme";

/**
 * What the + button opens: post a photo, or post a reel.
 *
 * Both launch a market — on Juno a post *is* its bonding curve — so both hand
 * off to the launch screen with the format chosen. A sheet rather than a
 * screen because this is a decision, not a task: the feed stays visible behind
 * the scrim, and a wrong tap costs a flick down rather than a navigation back.
 *
 * ## There is no text-only post any more
 *
 * It was a third option: words to the feed, no coin. The feed now shows posts
 * that are markets and nothing else, so a text post published from here
 * landed nowhere a reader could see — the button succeeded and the post
 * vanished. Offering it would be offering a way to lose what you wrote.
 * Conversation happens where it is read: in a post's replies.
 */
export function CreateSheet({
  visible,
  onClose,
  onLaunch,
}: {
  visible: boolean;
  onClose: () => void;
  /** Hand off to the launch screen with the chosen format. */
  onLaunch: (format: "post" | "reel") => void;
}) {
  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Body_>
        <Option
          icon={<CoinIcon />}
          title="Post a photo"
          blurb="It goes live with its own bonding curve."
          accent
          onPress={() => {
            onClose();
            onLaunch("post");
          }}
        />
        <Option
          icon={<ReelIcon />}
          title="Post a reel"
          blurb="Vertical video with a market of its own."
          onPress={() => {
            onClose();
            onLaunch("reel");
          }}
        />
      </Body_>
    </BottomSheet>
  );
}

function Option({
  icon,
  title,
  blurb,
  onPress,
  accent = false,
}: {
  icon: React.ReactNode;
  title: string;
  blurb: string;
  onPress: () => void;
  /** The one that is Juno's actual claim, marked in lime. */
  accent?: boolean;
}) {
  return (
    <Tappable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${title}. ${blurb}`}>
      <OptionRow>
        <Disc $accent={accent}>{icon}</Disc>
        <Col gap={3} style={{ flex: 1 }}>
          <Label style={{ fontWeight: "700", fontSize: theme.type.body.size }}>{title}</Label>
          <Caption>{blurb}</Caption>
        </Col>
        <Chevron />
      </OptionRow>
    </Tappable>
  );
}

/* Icons inline, at the kit's stroke weight, rather than a font for three glyphs. */

function CoinIcon() {
  return (
    <Svg width={21} height={21} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={8.6} stroke={theme.colors.onLime} strokeWidth={1.9} />
      <Path
        d="M7.5 14.5 10.5 11l2.4 2.2L16.6 9"
        stroke={theme.colors.onLime}
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function ReelIcon() {
  return (
    <Svg width={21} height={21} viewBox="0 0 24 24" fill="none">
      <Rect x={6} y={3} width={12} height={18} rx={3} stroke={theme.colors.text} strokeWidth={1.9} />
      <Path
        d="M10.8 9.6 14.6 12l-3.8 2.4z"
        stroke={theme.colors.text}
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

const Body_ = styled.View`
  padding-horizontal: ${(p) => p.theme.space(4)}px;
  padding-top: ${(p) => p.theme.space(1)}px;
  gap: ${(p) => p.theme.space(2)}px;
`;

const OptionRow = styled.View`
  flex-direction: row;
  align-items: center;
  gap: ${(p) => p.theme.space(3)}px;
  padding: ${(p) => p.theme.space(3)}px;
  border-radius: ${(p) => p.theme.radius.lg}px;
  background-color: ${(p) => p.theme.colors.surfaceAlt};
`;

const Disc = styled.View<{ $accent: boolean }>`
  width: 44px;
  height: 44px;
  border-radius: ${(p) => p.theme.radius.md}px;
  align-items: center;
  justify-content: center;
  background-color: ${(p) => (p.$accent ? p.theme.colors.lime : p.theme.colors.surface)};
`;
