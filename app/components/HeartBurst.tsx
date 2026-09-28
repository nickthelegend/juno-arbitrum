import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";

import { HeartGlyph } from "./icons";
import { useReducedMotion, nativeDriver } from "../lib/motion";

/**
 * The double-tap heart, where the finger landed.
 *
 * A big heart pops, overshoots, settles and lifts away; six small ones spray
 * out of it. The whole thing is 900ms of transform and opacity on the native
 * driver, so it stays smooth while the like is being written.
 *
 * It is keyed by the caller per tap, so a second double tap mid-animation
 * starts a second burst instead of restarting the first. Reduced motion keeps
 * the heart and drops the travel.
 */
const SPARKS = [
  { dx: -64, dy: -46, color: "#FF2D6F" },
  { dx: 60, dy: -58, color: "#D6FF3D" },
  { dx: -30, dy: -88, color: "#FFFFFF" },
  { dx: 34, dy: -92, color: "#FF2D6F" },
  { dx: -78, dy: 6, color: "#D6FF3D" },
  { dx: 74, dy: 2, color: "#FFFFFF" },
];

export function HeartBurst({ x, y, onDone }: { x: number; y: number; onDone: () => void }) {
  const reduced = useReducedMotion();
  const t = useRef(new Animated.Value(0)).current;
  const tilt = useRef((Math.random() - 0.5) * 36).current;

  useEffect(() => {
    Animated.timing(t, {
      toValue: 1,
      duration: reduced ? 500 : 900,
      easing: Easing.linear,
      useNativeDriver: nativeDriver,
    }).start(onDone);
  }, [onDone, reduced, t]);

  const scale = t.interpolate({
    inputRange: [0, 0.18, 0.3, 0.75, 1],
    outputRange: reduced ? [1, 1, 1, 1, 1] : [0.2, 1.3, 1, 1, 1.15],
  });
  const opacity = t.interpolate({ inputRange: [0, 0.1, 0.72, 1], outputRange: [0, 1, 1, 0] });
  const lift = t.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0, 0, reduced ? 0 : -70] });

  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill]}>
      {reduced
        ? null
        : SPARKS.map((spark, i) => {
            const travel = t.interpolate({ inputRange: [0.1, 0.6], outputRange: [0, 1], extrapolate: "clamp" });
            const fade = t.interpolate({ inputRange: [0.1, 0.2, 0.55, 0.7], outputRange: [0, 1, 1, 0], extrapolate: "clamp" });
            return (
              <Animated.View
                key={i}
                style={{
                  position: "absolute",
                  left: x - 9,
                  top: y - 9,
                  opacity: fade,
                  transform: [
                    { translateX: Animated.multiply(travel, spark.dx) },
                    { translateY: Animated.multiply(travel, spark.dy) },
                    { scale: travel.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) },
                  ],
                }}
              >
                <HeartGlyph size={18} color={spark.color} filled stroke={0} />
              </Animated.View>
            );
          })}
      <Animated.View
        style={{
          position: "absolute",
          left: x - 55,
          top: y - 55,
          opacity,
          transform: [{ translateY: lift }, { scale }, { rotate: `${tilt}deg` }],
          shadowColor: "#FF2D6F",
          shadowOpacity: 0.6,
          shadowRadius: 24,
          shadowOffset: { width: 0, height: 0 },
        }}
      >
        <HeartGlyph size={110} color="#FF2D6F" filled stroke={0} />
      </Animated.View>
    </View>
  );
}
