import { readFileSync } from "node:fs";

/**
 * On Connect brand images, from apps/admin/assets (shipped with the image:
 * see "files" in package.json). Read once at startup, so a missing file
 * fails at boot instead of on the first page.
 *
 * The icon is green and white on a transparent background: on a light
 * browser tab bar the white part disappears. The favicon is therefore an
 * SVG that puts the icon on the panel's dark rounded square; the plain PNG
 * stays as a fallback for browsers without SVG favicons.
 */

const read = (name: string): Buffer => readFileSync(new URL(`../assets/${name}`, import.meta.url));

export const LOGO_PNG = read("logo.png");
export const ICON_PNG = read("icon.png");

/** icon.png is 348x375: centered in a 64x64 dark tile with some padding. */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" rx="14" fill="#101214"/>
<image href="data:image/png;base64,${ICON_PNG.toString("base64")}" x="12" y="10" width="40" height="44" preserveAspectRatio="xMidYMid meet"/>
</svg>`;
