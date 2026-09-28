import React, { useRef, useState } from "react";
import { Tabs, usePathname, useRouter } from "expo-router";
import { Animated, Platform, StyleSheet } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import styled from "styled-components/native";

import { CreateSheet } from "../../components/CreateSheet";
import { usePressScale } from "../../components/Press";
import { motion, useReducedMotion, nativeDriver } from "../../lib/motion";
import { useTabBarHeight } from "../../lib/tabbar";
import { theme } from "../../theme";

/**
 * The bottom bar: five slots, Post raised in the centre.
 *
 * The arrangement is the product in miniature. Social and Trade sit on the
 * left, Reels and Profile on the right, and the thing that *makes* a market
 * sits in the middle where a thumb lands — because Juno's claim is that posting
 * and launching are the same act, and a bar that buried Post in a menu would be
 * arguing the opposite.
 *
 * The active item is a lime pill; inactive ones are bare glyphs. No labels at
 * all — five icons are already legible, the label only ever appeared on the tab
 * you were demonstrably already on, and dropping it lets each slot breathe.
 * `accessibilityLabel` still names every tab for a screen reader.
 *
 * ## Post opens a sheet, it does not navigate
 *
 * It used to push a whole screen, which made picking what to create cost a
 * navigation each way. It now raises a drawer over the feed: the thing behind
 * stays visible, choosing does not feel like leaving, and a wrong tap costs a
 * flick down. The `post` tab still exists and is still where a launch actually
 * happens — the sheet hands off to it with a format already chosen.
 */
export default function TabsLayout() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  // Which tab is active comes from the route, not from the button's
  // `accessibilityState`. That prop is not populated for a custom
  // `tabBarButton`, so reading it left every slot looking inactive — the lime
  // pill never appeared on the tab you were actually on.
  const pathname = usePathname();
  /*
   * Reels are the one dark room in the app. A white bar across the bottom of
   * a full-bleed video is a light left on in a cinema, so on that tab the bar
   * goes to night and its glyphs to white.
   */
  const night = pathname.startsWith("/reels");
  const bar = useTabBarHeight();

  const slot =
    (label: string, Icon: (p: { color: string }) => React.ReactElement, href: string) =>
    () => (
      <Slot
        label={label}
        icon={Icon}
        active={pathname.startsWith(href.replace("/(tabs)", ""))}
        night={night}
        onPress={() => router.push(href as never)}
      />
    );

  return (
    // An explicit filling container, so the sheet's `absoluteFill` has
    // something known to position against rather than whatever box the
    // navigator happens to render its children into.
    <Shell>
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: false,
        tabBarStyle: {
          backgroundColor: night ? theme.colors.night : theme.colors.surface,
          borderTopWidth: night ? StyleSheet.hairlineWidth : 0,
          borderTopColor: theme.colors.nightLine,
          height: bar.height,
          paddingTop: 10,
          paddingBottom: bar.paddingBottom,
          paddingHorizontal: 8,
          borderTopLeftRadius: theme.radius.xl,
          borderTopRightRadius: theme.radius.xl,
          position: "absolute",
          ...theme.shadow.raised,
        },
        sceneStyle: { backgroundColor: theme.colors.bg },
      }}
    >
      <Tabs.Screen
        name="social"
        options={{ tabBarButton: slot("Social", HomeIcon, "/(tabs)/social") }}
      />
      <Tabs.Screen
        name="trade"
        options={{ tabBarButton: slot("Trade", TradeIcon, "/(tabs)/trade") }}
      />
      <Tabs.Screen
        name="post"
        options={{
          tabBarButton: () => (
            <PostSlot open={creating} night={night} onPress={() => setCreating((on) => !on)} />
          ),
        }}
      />
      <Tabs.Screen
        name="reels"
        options={{ tabBarButton: slot("Reels", ReelsIcon, "/(tabs)/reels") }}
      />
      <Tabs.Screen
        name="profile"
        options={{ tabBarButton: slot("Profile", ProfileIcon, "/(tabs)/profile") }}
      />
    </Tabs>

    {/* A sibling of `Tabs`, not a child, so the sheet rises over the tab bar
        rather than being clipped by the screen it was opened from. */}
    <CreateSheet
      visible={creating}
      onClose={() => setCreating(false)}
      onLaunch={(format) => router.push(`/(tabs)/post?format=${format}` as never)}
    />
    </Shell>
  );
}

const Shell = styled.View`
  flex: 1;
`;

function Slot({
  label,
  icon: Icon,
  active,
  night = false,
  onPress,
}: {
  label: string;
  icon: (props: { color: string }) => React.ReactElement;
  active: boolean;
  night?: boolean;
  onPress: () => void;
}) {
  return (
    <SlotBox
      onPress={onPress}
      $on={active}
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
    >
      <Icon color={active ? theme.colors.onLime : night ? theme.colors.onNightMuted : theme.colors.faint} />
    </SlotBox>
  );
}

/**
 * The raised centre button, and the one place in the bar that animates.
 *
 * The plus rotates 45° into a close mark while the sheet is up. It is the same
 * two strokes throughout — nothing appears or disappears, the glyph turns —
 * which is what makes one control read as having two states rather than two
 * controls swapping places. It also means the button that opened the sheet is
 * the button that closes it, and looks like it.
 *
 * 45° over 220ms with the drawer curve, so it turns at roughly the pace the
 * sheet travels; the two read as one gesture rather than two animations that
 * happened to start together.
 */
function PostSlot({ open, night = false, onPress }: { open: boolean; night?: boolean; onPress: () => void }) {
  const reduced = useReducedMotion();
  const { scale, onPressIn, onPressOut } = usePressScale(0.9);
  const turn = useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    Animated.timing(turn, {
      toValue: open ? 1 : 0,
      duration: reduced ? 0 : motion.swap,
      easing: motion.easeDrawer,
      useNativeDriver: nativeDriver,
    }).start();
  }, [open, reduced, turn]);

  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "45deg"] });

  return (
    <PostBox
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={open ? "Close" : "Create — a photo or a reel"}
    >
      <Animated.View style={{ transform: [{ scale }] }}>
        <PostDisc $night={night}>
          <Animated.View style={{ transform: [{ rotate }] }}>
            <Svg width={24} height={24} viewBox="0 0 24 24">
              <Path
                d="M12 5v14M5 12h14"
                stroke={theme.colors.lime}
                strokeWidth={2.6}
                strokeLinecap="round"
              />
            </Svg>
          </Animated.View>
        </PostDisc>
      </Animated.View>
    </PostBox>
  );
}

const SlotBox = styled.Pressable<{ $on: boolean }>`
  flex: 1;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  height: 44px;
  margin-horizontal: 2px;
  border-radius: ${(p) => p.theme.radius.pill}px;
  background-color: ${(p) => (p.$on ? p.theme.colors.lime : "transparent")};
`;

/* The same flex as every other slot. It was a fixed 62pt while the four
   around it shared the rest, and the navigator does not centre a fixed-width
   button in its cell — so the + sat left of the bar's centre. */
const PostBox = styled.Pressable`
  flex: 1;
  align-items: center;
  justify-content: center;
`;

const PostDisc = styled.View<{ $night: boolean }>`
  width: 48px;
  height: 44px;
  border-radius: ${(p) => p.theme.radius.pill}px;
  background-color: ${(p) => (p.$night ? "rgba(255,255,255,0.12)" : p.theme.colors.ink)};
  align-items: center;
  justify-content: center;
`;

/* Icons are inline SVG rather than an icon font: five glyphs do not justify a
   dependency, and these carry the theme's exact stroke weight. */

function HomeIcon({ color }: { color: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3 10.2 12 3.5l9 6.7V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"
        stroke={color}
        strokeWidth={1.9}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function TradeIcon({ color }: { color: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Rect x={3} y={12} width={4} height={8} rx={1.4} stroke={color} strokeWidth={1.9} />
      <Rect x={10} y={7} width={4} height={13} rx={1.4} stroke={color} strokeWidth={1.9} />
      <Rect x={17} y={3} width={4} height={17} rx={1.4} stroke={color} strokeWidth={1.9} />
    </Svg>
  );
}

function ReelsIcon({ color }: { color: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Rect x={3} y={4} width={18} height={16} rx={3.4} stroke={color} strokeWidth={1.9} />
      <Path d="M10 9.5 15 12l-5 2.5z" stroke={color} strokeWidth={1.9} strokeLinejoin="round" />
    </Svg>
  );
}

function ProfileIcon({ color }: { color: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={8.5} r={3.6} stroke={color} strokeWidth={1.9} />
      <Path
        d="M4.8 20c.7-3.6 3.6-5.6 7.2-5.6s6.5 2 7.2 5.6"
        stroke={color}
        strokeWidth={1.9}
        strokeLinecap="round"
      />
    </Svg>
  );
}
