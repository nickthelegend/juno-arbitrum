const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

/**
 * Metro, with the package-exports fixes Privy's SDKs need, and the shared
 * contract config one directory up.
 *
 * ## `@config/*`
 *
 * The ABIs and addresses live in `../config` so the contracts, the server and
 * this app read one copy. Metro only bundles files under a watched folder, so
 * `../config` is watched, and `@config/<file>` resolves to it (the same alias
 * `tsconfig.json` declares for `tsc`). `config/` imports nothing, so it needs
 * no `node_modules` of its own.
 *
 * ## Package exports
 *
 * Metro resolves package `exports` with the `react-native` and `require`
 * conditions. For these packages that picks a build that cannot run in Hermes:
 * `jose` resolves to its Node build (which imports `util` and `zlib`), and
 * `isows` and `zustand@4` export shapes Metro mis-resolves. The browser build
 * of `jose` and the classic `main` field of the other two work.
 */
const projectRoot = __dirname;
const configDir = path.resolve(projectRoot, "../config");

const config = getDefaultConfig(projectRoot);

/**
 * Optional peers `@privy-io/react-auth` imports for features Juno does not
 * use (card on-ramp and the like). They are not installed, so they resolve to
 * an empty module instead of failing the web bundle.
 */
const UNUSED_OPTIONAL_PEERS = new Set(["@stripe/stripe-js"]);

config.watchFolders = [...(config.watchFolders ?? []), configDir];

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith("@config/")) {
    const file = path.join(configDir, moduleName.slice("@config/".length));
    return context.resolveRequest(context, file, platform);
  }
  if (UNUSED_OPTIONAL_PEERS.has(moduleName)) {
    return { type: "empty" };
  }
  if (moduleName === "jose") {
    return context.resolveRequest({ ...context, unstable_conditionNames: ["browser"] }, moduleName, platform);
  }
  if (moduleName === "isows" || moduleName.startsWith("zustand")) {
    return context.resolveRequest({ ...context, unstable_enablePackageExports: false }, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
