import { useEffect, useState } from "react";
import { AccessibilityInfo, Easing, Platform } from "react-native";

/**
 * Juno's motion constants, in one place so the app moves as one thing.
 *
 * The numbers are not taste alone. Three rules decide almost all of them:
 *
 * **Entering and exiting use ease-out.** It starts fast, so the first frame the
 * eye is watching already shows movement. `ease-in` at the same duration
 * *feels* slower because it withholds exactly the frames someone is looking at.
 *
 * **Exit is faster than enter.** Opening is the user deciding; closing is the
 * system getting out of the way. A sheet that takes as long to leave as it took
 * to arrive feels like it is arguing.
 *
 * **Under 300ms, except the sheet.** A drawer crossing most of the screen has
 * further to travel and reads as sluggish if it is rushed, so it gets a spring
 * rather than a longer duration — and a spring can be caught mid-flight by a
 * finger, which is the whole point on a surface people drag.
 *
 * There is no list-entrance constant here on purpose. A staggered cascade on a
 * feed shipped briefly and was wrong: this app's surfaces are for completing a
 * task, the feed can take fifteen seconds to read, and choreography on top of
 * that is asking someone to watch it load. The skeletons say "loading"; the
 * rows arrive. Motion in this app conveys state — a press, a sheet, a glyph
 * turning — and nothing else.
 */
/**
 * Whether animations can run on the native thread.
 *
 * On web there is no native animated module; asking for it logs a warning on
 * every animation and falls back to JS anyway. Saying so up front keeps the
 * console clean and changes nothing about how the web build moves.
 */
export const nativeDriver = Platform.OS !== "web";

export const motion = {
  /**
   * Strong ease-out: `cubic-bezier(0.23, 1, 0.32, 1)`.
   *
   * The built-in easings are too weak to read as deliberate at these durations.
   */
  easeOut: Easing.bezier(0.23, 1, 0.32, 1),
  /** The iOS drawer curve, from Ionic — used where a surface slides rather than fades. */
  easeDrawer: Easing.bezier(0.32, 0.72, 0, 1),

  /** Press feedback. Fast enough to feel like the finger caused it. */
  press: 120,
  /** A chip, a chevron, a colour. */
  quick: 180,
  /** A panel swapping its contents. */
  swap: 220,
  /** Closing a sheet. Deliberately shorter than the spring that opened it. */
  exit: 230,

  /**
   * The sheet's opening spring.
   *
   * `bounce` in Apple's terms is about 0.12 here: enough that the surface
   * settles rather than stops, not enough to look springy. A drawer holding a
   * form should feel weighted, not playful.
   */
  sheetOpen: { tension: 62, friction: 11 },
  /** Snapping back after a drag that did not go far enough to dismiss. */
  sheetSettle: { tension: 80, friction: 12 },

  /** Drag past this fraction of the sheet's height and release: dismiss. */
  dismissRatio: 0.28,
  /**
   * Or flick faster than this, in px/ms, at any distance.
   *
   * Requiring the distance alone punishes the gesture people actually make,
   * which is a short fast flick rather than a long slow drag.
   */
  dismissVelocity: 0.55,
  /**
   * Resistance on an upward drag, where there is nowhere to go.
   *
   * Nothing in the world hits an invisible wall — it slows down first. Blocking
   * the drag outright feels broken in a way that a stiff drag does not.
   */
  overdrag: 0.14,
} as const;

/**
 * Whether the person has asked their device for less movement.
 *
 * Reduced motion is not *no* motion. Opacity still carries "this arrived" and
 * removing it would cost comprehension for no benefit; what goes is travel —
 * the slide, the rise, the stagger. Callers use this to drop movement and keep
 * the fade.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (alive) setReduced(value);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);

  return reduced;
}
