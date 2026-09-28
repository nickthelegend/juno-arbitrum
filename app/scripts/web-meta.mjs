/**
 * Give the exported web build a title, a description and a link preview.
 *
 * `expo export --platform web` writes an index.html titled "Juno" with no
 * description and no Open Graph tags, so the demo link pasted anywhere — a
 * submission form, a DM to a judge — unfurled as a bare URL. This runs after
 * the export and adds them. The image is the landing site's own share card.
 */
import { readFileSync, writeFileSync } from "node:fs";

const file = new URL("../dist/index.html", import.meta.url);
const app = process.env.EXPO_PUBLIC_APP_URL ?? "https://juno-app-chi.vercel.app";
const title = "Juno — every post is a market";
const description =
  "Post a photo or a reel and it launches its own Meteora bonding curve on Solana. Buy into posts you believe in; creators earn the fees. Pre-IPO trackers marked against Tessera.";
const image = "https://juno-landing-beta.vercel.app/opengraph-image";

const tags = [
  `<meta name="description" content="${description}" />`,
  `<meta name="theme-color" content="#DCE7D5" />`,
  `<meta property="og:type" content="website" />`,
  `<meta property="og:url" content="${app}" />`,
  `<meta property="og:title" content="${title}" />`,
  `<meta property="og:description" content="${description}" />`,
  `<meta property="og:image" content="${image}" />`,
  `<meta name="twitter:card" content="summary_large_image" />`,
  `<meta name="twitter:title" content="${title}" />`,
  `<meta name="twitter:description" content="${description}" />`,
  `<meta name="twitter:image" content="${image}" />`,
].join("\n    ");

let html = readFileSync(file, "utf8");
html = html.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);
if (!html.includes('property="og:title"')) html = html.replace("</head>", `    ${tags}\n  </head>`);
writeFileSync(file, html);
console.log("web meta written");
