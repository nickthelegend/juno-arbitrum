import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  BackHandler,
  Dimensions,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import * as Haptics from "expo-haptics";
import styled from "styled-components/native";

import { motion, useReducedMotion, nativeDriver } from "../lib/motion";
import { theme } from "../theme";

/**
 * A sheet that comes up from the bottom, and can be thrown back down.
 *
 * ## Why this is not `Modal animationType="slide"`
 *
 * The platform slide is a fixed linear-ish ramp with no backdrop, no grabber
 * and no gesture. It cannot be interrupted, so a finger arriving mid-animation
 * is ignored until the slide finishes — which is the moment someone is most
 * likely to change their mind. Here the same `translateY` drives the opening
 * spring *and* the drag, so a finger can catch the sheet in flight and the
 * spring picks up from wherever it was let go.
 *
 * It is not wrapped in `Modal` either. On iOS a `Modal` is presented in its own
 * `UIWindow`, which put the sheet outside the ordinary view tree and made the
 * drag untestable. What `Modal` was providing — covering the tab bar, and the
 * Android back button — is a sibling rendered after `<Tabs>` and a
 * `BackHandler` subscription.
 *
 * ## The drag is a native recognizer, not `PanResponder`
 *
 * `PanResponder` negotiates on the JS thread, and in this app that is the wrong
 * thread to bet a gesture on: a feed read walks every pool against a
 * rate-limited RPC and can hold JS for most of a minute. A drawer that ignores
 * your finger while a list loads is worse than one that does not drag at all.
 * `Gesture.Pan()` recognises natively, so the sheet answers the finger whatever
 * JS is doing — and it composes with the scroll views a sheet's contents will
 * eventually hold, which `PanResponder` does not.
 *
 * ## The motion, and why each number
 *
 * - **Open is a spring, close is a curve.** Opening is physical: a surface
 *   arriving and settling. Closing is the system getting out of the way, so it
 *   is a 230ms ease-out — shorter than the spring that opened it, because a
 *   sheet that takes as long to leave as it took to arrive feels like it is
 *   arguing.
 * - **The backdrop tracks the sheet.** Its opacity is interpolated from the
 *   same value, so dragging halfway down lightens the scrim halfway. Fading it
 *   on a separate timer is the detail that makes a drag feel like it is moving
 *   a real object rather than triggering two animations.
 * - **Up has friction, not a wall.** Dragging above the resting position moves
 *   at 14% of the finger. Nothing in the world stops dead, and an outright
 *   block reads as a bug.
 * - **A flick counts.** Release past 28% of the height *or* faster than
 *   0.55px/ms dismisses. Distance alone punishes the gesture people actually
 *   make, which is short and fast.
 *
 * Everything animated here is `transform` or `opacity` on the native driver,
 * so the drag stays smooth while JS is busy — which, in this app, it often is.
 */
export function BottomSheet({
  visible,
  onClose,
  children,
  /** Set false for a sheet holding work someone could lose, e.g. a filled form. */
  dismissable = true,
}: {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  dismissable?: boolean;
}) {
  const reduced = useReducedMotion();
  // Kept separate from `visible` so the closing animation has something to
  // play out against: `visible` goes false first, this follows on settle.
  const [mounted, setMounted] = useState(visible);

  /*
   * Distance below resting position, in points. One value, three jobs: the
   * opening spring, the finger, and the closing curve. Sharing it is what lets
   * a drag interrupt an animation instead of fighting it.
   */
  const y = useRef(new Animated.Value(Dimensions.get("window").height)).current;
  // Measured rather than assumed, so `translateY(height)` hides the sheet
  // exactly whatever it ends up containing.
  const height = useRef(Dimensions.get("window").height);
  const dragging = useRef(false);

  /*
   * How far the keyboard has pushed this sheet up.
   *
   * A sheet anchored to the bottom of the screen is exactly the thing a
   * keyboard covers, and the button someone is reaching for is at its bottom
   * edge. `KeyboardAvoidingView` is the usual answer and is wrong here: it
   * resizes, which fights the drag gesture and the measured height.
   *
   * Adding a second offset to the same transform keeps one source of truth for
   * position — `Animated.add` composes on the native driver, so the sheet can
   * still be dragged while the keyboard is up.
   *
   * `keyboardWillShow` on iOS rather than `didShow`: it fires with the system
   * animation rather than after it, so the sheet travels *with* the keyboard
   * instead of chasing it.
   */
  const lift = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!mounted) return;
    const willShow = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const willHide = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const show = Keyboard.addListener(willShow, (event) => {
      Animated.timing(lift, {
        toValue: -event.endCoordinates.height,
        // Match the system's own curve and duration so the two move as one.
        duration: event.duration || motion.swap,
        easing: motion.easeOut,
        useNativeDriver: nativeDriver,
      }).start();
    });
    const hide = Keyboard.addListener(willHide, (event) => {
      Animated.timing(lift, {
        toValue: 0,
        duration: event.duration || motion.swap,
        easing: motion.easeOut,
        useNativeDriver: nativeDriver,
      }).start();
    });

    return () => {
      show.remove();
      hide.remove();
    };
  }, [mounted, lift]);

  const settle = useCallback(() => {
    Animated.spring(y, {
      toValue: 0,
      useNativeDriver: nativeDriver,
      ...motion.sheetSettle,
    }).start();
  }, [y]);

  const dismiss = useCallback(() => {
    // Otherwise the keyboard is left on screen with nothing above it.
    Keyboard.dismiss();
    Animated.timing(y, {
      toValue: height.current,
      duration: motion.exit,
      easing: motion.easeOut,
      useNativeDriver: nativeDriver,
    }).start(({ finished }) => {
      if (finished) setMounted(false);
    });
    onClose();
  }, [onClose, y]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(dismissable)
        // Only take over once it is clearly a vertical drag, so a finger that
        // came down to press a row inside the sheet still presses it.
        .activeOffsetY([-10, 10])
        .failOffsetX([-20, 20])
        .onUpdate((event) => {
          dragging.current = true;
          // Down follows the finger exactly; up is resisted rather than refused.
          y.setValue(
            event.translationY >= 0 ? event.translationY : event.translationY * motion.overdrag,
          );
        })
        .onEnd((event) => {
          dragging.current = false;
          const far = event.translationY > height.current * motion.dismissRatio;
          // velocityY is px/s here, where PanResponder reported px/ms.
          const fast = event.velocityY / 1000 > motion.dismissVelocity;
          if (far || fast) {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            dismiss();
          } else {
            settle();
          }
        })
        // A gesture the system takes away — a call, a notification — must not
        // leave the sheet parked wherever the finger was.
        .onFinalize((_event, success) => {
          if (!success && dragging.current) {
            dragging.current = false;
            settle();
          }
        }),
    [dismissable, dismiss, settle, y],
  );

  useEffect(() => {
    if (visible) {
      setMounted(true);
      return;
    }
    if (mounted) dismiss();
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  // Android's back button closes the sheet rather than the screen under it.
  useEffect(() => {
    if (!mounted || Platform.OS !== "android") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (dismissable) onClose();
      return true;
    });
    return () => subscription.remove();
  }, [mounted, dismissable, onClose]);

  const onLayout = useCallback(
    (event: { nativeEvent: { layout: { height: number } } }) => {
      const measured = event.nativeEvent.layout.height;
      if (measured <= 0 || Math.abs(measured - height.current) < 1) return;
      height.current = measured;
      // Only reposition while the sheet is parked off-screen. Doing it mid-open
      // would snap a sheet whose content just grew — a keyboard appearing, say.
      if (!visible) y.setValue(measured);
    },
    [visible, y],
  );

  useEffect(() => {
    if (!mounted || !visible) return;
    y.setValue(height.current);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (reduced) {
      // Reduced motion keeps the fade and drops the travel: the backdrop still
      // says "something arrived", nothing slides across the screen to say it.
      Animated.timing(y, {
        toValue: 0,
        duration: motion.quick,
        easing: motion.easeOut,
        useNativeDriver: nativeDriver,
      }).start();
      return;
    }
    Animated.spring(y, {
      toValue: 0,
      useNativeDriver: nativeDriver,
      ...motion.sheetOpen,
    }).start();
  }, [mounted, visible, reduced, y]);

  if (!mounted) return null;

  /*
   * The scrim, driven by the sheet's own position rather than its own timer.
   * Dragging the sheet a third of the way down lightens the scrim by a third,
   * which is what makes the gesture feel like it is moving one object.
   */
  const scrim = y.interpolate({
    inputRange: [0, Math.max(height.current, 1)],
    outputRange: [1, 0],
    extrapolate: "clamp",
  });

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, { opacity: scrim }]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={dismissable ? onClose : undefined}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
      </Animated.View>

      <GestureDetector gesture={pan}>
        <Animated.View
          onLayout={onLayout}
          style={[styles.sheet, { transform: [{ translateY: Animated.add(y, lift) }] }]}
        >
          {/* The grab area is deliberately taller than the bar it draws: a 5pt
              target is a 5pt target however good the gesture is. No label above
              it — a sheet whose three rows name themselves does not need a word
              announcing that it is a sheet. */}
          <Handle>
            <Grabber />
          </Handle>
          {children}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: "rgba(18, 21, 14, 0.42)" },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    paddingBottom: 34,
    ...theme.shadow.raised,
  },
});

/**
 * The grab area, which is deliberately taller than the bar it draws.
 *
 * A 4pt target is a 4pt target however good the gesture is. The padding here is
 * the difference between a grabber that looks draggable and one that is.
 */
const Handle = styled.View`
  padding-top: ${(p) => p.theme.space(3)}px;
  padding-bottom: ${(p) => p.theme.space(3)}px;
  align-items: center;
`;

const Grabber = styled.View`
  width: 38px;
  height: 5px;
  border-radius: 3px;
  background-color: ${(p) => p.theme.colors.lineStrong};
`;
