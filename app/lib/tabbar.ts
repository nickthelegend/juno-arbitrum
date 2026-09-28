import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * How tall the bottom tab bar is, including what the system reserves under it.
 *
 * Android draws apps edge to edge, so the gesture bar sits on top of the
 * app's last few points. The tab bar used a fixed 70 there and its icons ran
 * under the gesture line. It now adds the bottom inset, and everything that
 * sits above the bar — the reel dock, the comment composer — asks this for
 * the height rather than assuming one.
 *
 * iOS keeps its measured 86, which already clears the home indicator.
 */
export function useTabBarHeight(): { height: number; paddingBottom: number } {
  const insets = useSafeAreaInsets();
  if (Platform.OS === "ios") return { height: 86, paddingBottom: 26 };
  return { height: 70 + insets.bottom, paddingBottom: 10 + insets.bottom };
}
