// branch-colors.js — generate visually distinct colors for every branch.
//
// Strategy: farthest-point sampling in OKLab (perceptually uniform) space.
// This guarantees that the minimum pairwise distance between any two branch
// colors is maximized, so every branch is clearly distinguishable.
//
// For N branches, we generate a large candidate pool and greedily pick the
// N colors that maximize the minimum distance to already-picked colors.

/**
 * Convert sRGB (0..255) to OKLab L,a,b.
 * OKLab is perceptually uniform: equal distances = equal perceived differences.
 */
function srgbToOklab(r, g, b) {
    // sRGB -> linear
    const lin = (c) => {
        c /= 255;
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const lr = lin(r), lg = lin(g), lb = lin(b);
    // linear -> LMS
    const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
    const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
    const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
    // LMS -> OKLab
    const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
    return {
        L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    };
}

/**
 * Euclidean distance in OKLab space.
 */
function oklabDist(c1, c2) {
    const dL = c1.L - c2.L, da = c1.a - c2.a, db = c1.b - c2.b;
    return Math.sqrt(dL * dL + da * da + db * db);
}

/**
 * Convert sRGB (0..255) to HSL (h: 0..360, s/l: 0..1).
 */
function srgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
    return [h, s, l];
}

/**
 * Force a color to be "flashy": high saturation, lightness inside a band that
 * stays readable against the theme background. Keeps the original hue;
 * near-gray colors (achromatic) get a real hue assigned.
 */
function vividHex(hex, dark, fallbackHue = 0) {
    let [h, s, l] = srgbToHsl((hex >> 16) & 255, (hex >> 8) & 255, hex & 255);
    if (s < 0.15) h = ((fallbackHue % 360) + 360) % 360;
    s = Math.max(s, 0.9);
    l = dark ? Math.min(Math.max(l, 0.58), 0.72)
             : Math.min(Math.max(l, 0.40), 0.55);
    const [r, g, b] = hslToSrgb(h, s, l);
    return (r << 16) | (g << 8) | b;
}

/**
 * Convert HSL to sRGB (0..255).
 */
function hslToSrgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r, g, b;
    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * Generate `count` visually distinct colors using farthest-point sampling
 * in OKLab space. Returns array of 0xRRGGBB integers.
 *
 * @param {number} count
 * @returns {number[]}
 */
export function generateBranchColors(count, { avoidHex = null, seedHexes = [] } = {}) {
    if (count <= 0) return [];
    const dark = avoidHex === null ? true
        : srgbToOklab((avoidHex >> 16) & 255, (avoidHex >> 8) & 255, avoidHex & 255).L < 0.55;
    if (count === 1) return [vividHex(0x4f9dff, dark, 210)];

    // Generate a large candidate pool in HSL space — flashy only: high
    // saturation, lightness inside the band that pops against the theme
    // background (bright on dark themes, deeper on light themes).
    const POOL_SIZE = Math.max(2000, count * 50);
    const candidates = [];
    for (let i = 0; i < POOL_SIZE; i++) {
        const hue = (i * 137.508) % 360;
        const sat = 0.82 + 0.18 * ((i * 7) % 100) / 100; // 0.82..1.00
        const light = dark
            ? 0.55 + 0.25 * ((i * 13) % 100) / 100       // 0.55..0.80
            : 0.38 + 0.17 * ((i * 13) % 100) / 100;      // 0.38..0.55
        const [r, g, b] = hslToSrgb(hue, sat, light);
        const lab = srgbToOklab(r, g, b);
        candidates.push({ r, g, b, lab, hex: (r << 16) | (g << 8) | b });
    }

    // Farthest-point sampling: greedily pick colors that maximize min distance.
    // distLabs is seeded with the background + theme palette so generated
    // colours stay distinct from both (background = readability, palette =
    // no near-duplicate of the curated hues already taken by major branches).
    const picked = [];
    const distLabs = [];
    const labOf = (hex) => srgbToOklab((hex >> 16) & 255, (hex >> 8) & 255, hex & 255);
    if (avoidHex !== null) distLabs.push(labOf(avoidHex));
    for (const h of seedHexes) distLabs.push(labOf(h));
    const seedSet = new Set(seedHexes);

    // With no seeds, start from a mid-blue-ish candidate for a pleasant default.
    // With seeds (bg/palette), the loop below picks the first colour by distance
    // too — avoids always emitting the same dark #5c2323 on dark themes.
    if (distLabs.length === 0) {
        const startIdx = candidates.findIndex(c => c.hex === 0x4f9dff);
        const start = startIdx >= 0 ? startIdx : 0;
        picked.push(candidates[start].hex);
        distLabs.push(candidates[start].lab);
    }

    while (picked.length < count) {
        let bestIdx = -1, bestMinDist = -1;
        for (let i = 0; i < candidates.length; i++) {
            if (picked.includes(candidates[i].hex) || seedSet.has(candidates[i].hex)) continue;
            // min distance to any already-picked color
            let minDist = Infinity;
            for (const pl of distLabs) {
                const d = oklabDist(candidates[i].lab, pl);
                if (d < minDist) minDist = d;
            }
            if (minDist > bestMinDist) {
                bestMinDist = minDist;
                bestIdx = i;
            }
        }
        if (bestIdx < 0) break;
        picked.push(candidates[bestIdx].hex);
        distLabs.push(candidates[bestIdx].lab);
    }

    return picked;
}

/**
 * Assign a distinct color to each branch in the graph.
 * Mutates `branch.color` to a hex integer.
 * Major branches (by commit count) get the most distinct hues.
 * @param {object} graph
 * @param {object} [opts]
 * @param {number} [opts.prominentCount=36] number of "major" branches
 * @returns {Map<number, number>} branchId -> color hex
 */
export function assignBranchColors(graph, { prominentCount = 36, avoidHex = null, palette = null } = {}) {
    const branches = [...graph.branches].sort((a, b) => b.commits - a.commits);
    const n = branches.length;
    const dark = avoidHex === null ? true
        : srgbToOklab((avoidHex >> 16) & 255, (avoidHex >> 8) & 255, avoidHex & 255).L < 0.55;
    let colors;
    if (palette && palette.length > 0) {
        // Curated theme hues for the major branches — vivid-boosted so every
        // sphere pops (keeps hue, forces saturation/lightness; achromatic
        // entries like mono grays get a real hue). Extras seeded to stay
        // distinct from the boosted palette + background.
        const vivid = palette.map((c, i) => vividHex(c, dark, i * 61 + 15));
        const extra = n > vivid.length
            ? generateBranchColors(n - vivid.length, { avoidHex, seedHexes: vivid })
            : [];
        colors = vivid.slice(0, n).concat(extra);
    } else {
        colors = generateBranchColors(n, { avoidHex });
    }

    const map = new Map();
    branches.forEach((b, i) => {
        b.color = colors[i];
        map.set(b.id, colors[i]);
    });
    return map;
}
