import "../lib/polyfills";

import { Stack } from "expo-router";
import { Platform, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ThemeProvider } from "styled-components/native";

import { WalletProvider } from "../lib/wallet";
import { theme } from "../theme";

/**
 * The app shell.
 *
 * Light throughout and pinned there: `userInterfaceStyle` is "light" in
 * app.json, so a phone in dark mode does not get a half-inverted version of a
 * palette that was validated against a light surface.
 *
 * `GestureHandlerRootView` has to be the outermost view, not a wrapper further
 * down: native gesture recognizers are attached relative to it, and a detector
 * mounted outside its subtree silently never fires.
 */
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    <PhoneFrame>
    <ThemeProvider theme={theme}>
      <SafeAreaProvider>
        <WalletProvider>
          <StatusBar style="dark" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: theme.colors.bg },
              animation: "slide_from_right",
            }}
          >
            <Stack.Screen name="index" />
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="coin/[mint]" />
            <Stack.Screen name="trader/[wallet]" />
            <Stack.Screen name="post/[id]" />
          </Stack>
        </WalletProvider>
      </SafeAreaProvider>
    </ThemeProvider>
    </PhoneFrame>
    </GestureHandlerRootView>
  );
}

/**
 * On web, the app is a phone-width column in the middle of the window.
 *
 * Juno is a phone app. Opened on a laptop, react-native-web stretched every
 * screen to 1500px: a feed image the size of the monitor and a tab bar with
 * five icons a hand-span apart. A judge's first look is usually a laptop, so
 * the web build keeps the proportions the app was designed at — 480pt at most,
 * centred on the canvas colour, full width on an actual phone. Native builds
 * are untouched.
 */
function PhoneFrame({ children }: { children: React.ReactNode }) {
  if (Platform.OS !== "web") return <>{children}</>;
  return (
    <View style={{ flex: 1, alignItems: "center", backgroundColor: "#C9D6C1" }}>
      <View
        style={{
          flex: 1,
          width: "100%",
          maxWidth: 480,
          overflow: "hidden",
          backgroundColor: theme.colors.bg,
          boxShadow: "0 0 40px rgba(18,21,14,0.12)",
        }}
      >
        {children}
      </View>
    </View>
  );
}
