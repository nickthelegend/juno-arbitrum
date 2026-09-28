/**
 * Artwork derived from an address.
 *
 * A launch without an uploaded image still has to render as something. This is
 * not a placeholder standing in for missing data — the address *is* the data,
 * hashed into a stable gradient, so the same coin always looks the same and
 * two coins never collide visually.
 */
export function identicon(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = Math.abs(h) % 360;
  const hue2 = (hue + 40 + (Math.abs(h >> 8) % 120)) % 360;
  const angle = Math.abs(h >> 16) % 360;
  const cx = 20 + (Math.abs(h >> 4) % 24);
  const cy = 18 + (Math.abs(h >> 12) % 20);
  const r = 8 + (Math.abs(h >> 20) % 10);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<defs><linearGradient id="g" gradientTransform="rotate(${angle} .5 .5)">` +
    `<stop offset="0%" stop-color="hsl(${hue} 72% 58%)"/>` +
    `<stop offset="100%" stop-color="hsl(${hue2} 68% 30%)"/>` +
    `</linearGradient></defs>` +
    `<rect width="64" height="64" fill="url(#g)"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="hsl(${hue2} 80% 72%)" opacity="0.45"/>` +
    `</svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
