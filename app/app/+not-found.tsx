import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button, Placeholder } from "../components/kit";
import { theme } from "../theme";

/**
 * Any address the app does not have.
 *
 * Without this file expo-router renders its developer screen — "Unmatched
 * Route" and a link to a sitemap of every route in the project — which is a
 * tool for building the app, not something anyone using it should meet.
 */
export default function NotFound() {
  const router = useRouter();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <Placeholder
        title="Nothing here"
        detail="This page does not exist. The feed does."
        action={<Button label="Go to the feed" onPress={() => router.replace("/(tabs)/social" as never)} />}
      />
    </SafeAreaView>
  );
}
