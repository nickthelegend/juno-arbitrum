import { useCallback, useRef } from "react";
import { Animated, Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";

import { motion, nativeDriver } from "../lib/motion";

/**
 * The scale-down that tells a finger the interface heard it.
 *
 * Nothing in this app had it. A card that does not move under a thumb reads as
 * a picture of a card, and on a touch screen there is no hover state to carry
 * the difference — the press *is* the whole conversation.
 *
 * Down is faster than up, and that asymmetry is deliberate: the press is the
 * acknowledgement and wants to be immediate, the release is the system letting
 * go and can afford to settle. Both stay under 200ms, because past that the
 * feedback arrives after the user has already moved on.
 *
 * Reduced motion keeps it. This is feedback, not decoration — removing it would
 * cost information and the movement is a couple of points.
 */
export function usePressScale(to = 0.97) {
  const scale = useRef(new Animated.Value(1)).current;

  const onPressIn = useCallback(() => {
    Animated.timing(scale, {
      toValue: to,
      duration: motion.press,
      easing: motion.easeOut,
      useNativeDriver: nativeDriver,
    }).start();
  }, [scale, to]);

  const onPressOut = useCallback(() => {
    Animated.spring(scale, {
      toValue: 1,
      tension: 200,
      friction: 12,
      useNativeDriver: nativeDriver,
    }).start();
  }, [scale]);

  return { scale, onPressIn, onPressOut };
}

/**
 * A pressable that responds to being pressed.
 *
 * `scale()` takes the element's children with it, so a card's art, type and
 * figures all shrink together and the whole thing reads as one object being
 * pushed rather than a box animating around its contents.
 */
export function Tappable({
  children,
  style,
  to = 0.97,
  ...rest
}: PressableProps & {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** How far down. 0.95–0.98; below that it stops being feedback and starts being a jump. */
  to?: number;
}) {
  const { scale, onPressIn, onPressOut } = usePressScale(to);

  return (
    <Pressable onPressIn={onPressIn} onPressOut={onPressOut} {...rest}>
      <Animated.View style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>
    </Pressable>
  );
}
