// themes.js — colour themes for GenGit3D (light + dark).
//
// Each theme controls BOTH the three.js scene (background, fog, branch palette,
// lights, how the long-tail branches recede) AND the HTML chrome (CSS custom
// properties). Palettes are chosen per background so branch colours stay
// readable: saturated/bright on dark backgrounds, deeper/darker on light ones.
//
// Consumed by:
//   - src/scene.js  : renderGraph(container, graph, themeName)
//   - index.html    : applyTheme(name) -> sets CSS vars on :root, then re-renders

export const THEMES = {
    midnight: {
        label: 'Midnight (dark)',
        dark: true,
        background: 0x0b0b10,
        fog: [0.45, 2.1],
        fogColor: 0x0b0b10,
        palette: [0x4f9dff, 0x57c785, 0xff8c42, 0xe05c75, 0xb583ff, 0xf2c14e],
        recede: 0x1a1e2e,
        recedeAmount: 0.8,
        axis: 0x2a3350,
        selection: 0xffffff,
        edgeOpacity: 0.9,
        lights: { ambient: [0xffffff, 0.5], key: [0xffffff, 1.2], fill: [0x88aaff, 0.55], rim: [0xff9a5c, 0.9] },
        ui: {
            bg: '#0b0b10', panel: '#16171c', border: '#2a2c36', text: '#e0e0e0',
            muted: '#8b93a7', accent: '#4f9dff', input: '#0d0e12',
            btn: '#2a3550', btnBorder: '#3a4a70', btnText: '#dbe6ff',
            overlay: '#000000aa', tooltipBg: '#000000cc', tooltipText: '#ffffff',
            diffAdd: '#7ee787', diffDel: '#ff7b72', diffHunk: '#79c0ff',
            err: '#e05c75', busy: '#f2c14e',
        },
    },

    slate: {
        label: 'Slate (dark)',
        dark: true,
        background: 0x141a24,
        fog: [0.5, 2.2],
        fogColor: 0x141a24,
        palette: [0x5aa9ff, 0x4fd08a, 0xffa14f, 0xff6b81, 0xc08bff, 0xffd166],
        recede: 0x2a3852,
        recedeAmount: 0.78,
        axis: 0x33425c,
        selection: 0xffffff,
        edgeOpacity: 0.95,
        lights: { ambient: [0xffffff, 0.55], key: [0xffffff, 1.15], fill: [0x9ecbff, 0.6], rim: [0xffb37a, 0.8] },
        ui: {
            bg: '#141a24', panel: '#1c2534', border: '#2e3a4d', text: '#e6ecf5',
            muted: '#93a2ba', accent: '#5aa9ff', input: '#101722',
            btn: '#28405f', btnBorder: '#3b587f', btnText: '#e2efff',
            overlay: '#0b1018cc', tooltipBg: '#0b1018e6', tooltipText: '#f2f6fc',
            diffAdd: '#7ee787', diffDel: '#ff9aa2', diffHunk: '#79c0ff',
            err: '#ff7d94', busy: '#ffd166',
        },
    },

    neon: {
        label: 'Neon (dark)',
        dark: true,
        background: 0x06060a,
        fog: [0.55, 2.4],
        fogColor: 0x06060a,
        palette: [0x00e5ff, 0x39ff88, 0xff9f1c, 0xff3d7f, 0xb14aff, 0xffe600],
        recede: 0x1c1c2b,
        recedeAmount: 0.85,
        axis: 0x1f3a4d,
        selection: 0xffffff,
        edgeOpacity: 1.0,
        lights: { ambient: [0xffffff, 0.6], key: [0xffffff, 1.35], fill: [0x66e0ff, 0.7], rim: [0xff4fd8, 1.1] },
        ui: {
            bg: '#06060a', panel: '#0f1018', border: '#252a3d', text: '#e8f6ff',
            muted: '#8fa3c8', accent: '#00e5ff', input: '#090a12',
            btn: '#10233a', btnBorder: '#1f4f7a', btnText: '#d6f6ff',
            overlay: '#000000cc', tooltipBg: '#000000e6', tooltipText: '#eaffff',
            diffAdd: '#39ff88', diffDel: '#ff4d7d', diffHunk: '#00e5ff',
            err: '#ff4d7d', busy: '#ffe600',
        },
    },

    daylight: {
        label: 'Daylight (light)',
        dark: false,
        background: 0xeef2f8,
        // light bg: fog converges to a MID tone (NOT the pale bg), otherwise the
        // distant strands fade to near-white and become unreadable.
        fog: [1.1, 3.2],
        fogColor: 0x6b7688,
        palette: [0x1d6fd6, 0x1f8a4c, 0xd2691e, 0xc0392b, 0x6b3fa0, 0xa97700],
        // on a LIGHT background the long tail must recede toward a MID tone
        // (darker than the bg) or it washes out and disappears
        recede: 0x55606f,
        recedeAmount: 0.45,
        axis: 0x9aa7bd,
        selection: 0x0b3d91,
        edgeOpacity: 1.0,
        lights: { ambient: [0xffffff, 0.95], key: [0xffffff, 0.95], fill: [0xbfd4ff, 0.45], rim: [0xffd0a0, 0.45] },
        ui: {
            bg: '#eef2f8', panel: '#ffffff', border: '#c7d0df', text: '#1a2230',
            muted: '#5b6779', accent: '#1d6fd6', input: '#f7f9fc',
            btn: '#1d6fd6', btnBorder: '#1559ad', btnText: '#ffffff',
            overlay: '#ffffffcc', tooltipBg: '#1a2230f2', tooltipText: '#ffffff',
            diffAdd: '#0a7d32', diffDel: '#b3202f', diffHunk: '#1d6fd6',
            err: '#b3202f', busy: '#8a6d00',
        },
    },

    paper: {
        label: 'Paper (light)',
        dark: false,
        background: 0xf6f1e7,
        fog: [1.1, 3.2],
        fogColor: 0x7a7260,
        palette: [0x1a5fb4, 0x2a7d4f, 0xb45309, 0xa3271e, 0x5e3a8c, 0x8a6100],
        recede: 0x5f5847,
        recedeAmount: 0.45,
        axis: 0xa89e88,
        selection: 0x6b3f00,
        edgeOpacity: 1.0,
        lights: { ambient: [0xfff6e8, 1.0], key: [0xffffff, 0.9], fill: [0xd8c9b0, 0.4], rim: [0xe8b98a, 0.45] },
        ui: {
            bg: '#f6f1e7', panel: '#fffaf0', border: '#d3c8b4', text: '#2b2418',
            muted: '#6d6353', accent: '#1a5fb4', input: '#fbf7ef',
            btn: '#8a6100', btnBorder: '#6f4e00', btnText: '#fff8ea',
            overlay: '#fffaf0cc', tooltipBg: '#2b2418f2', tooltipText: '#fff8ea',
            diffAdd: '#2a7d4f', diffDel: '#a3271e', diffHunk: '#1a5fb4',
            err: '#a3271e', busy: '#8a6100',
        },
    },

    solarized: {
        label: 'Solarized (light)',
        dark: false,
        background: 0xfdf6e3,
        fog: [1.1, 3.2],
        fogColor: 0x7a7461,
        palette: [0x268bd2, 0x859900, 0xcb4b16, 0xdc322f, 0x6c71c4, 0xb58900],
        recede: 0x5f5a48,
        recedeAmount: 0.45,
        axis: 0xb9b09a,
        selection: 0x073642,
        edgeOpacity: 1.0,
        lights: { ambient: [0xfffdf3, 1.0], key: [0xffffff, 0.9], fill: [0xdfd6bd, 0.4], rim: [0xe0b98a, 0.45] },
        ui: {
            bg: '#fdf6e3', panel: '#fffbf0', border: '#ded8c3', text: '#073642',
            muted: '#657b83', accent: '#268bd2', input: '#fffdf5',
            btn: '#268bd2', btnBorder: '#1c6fa8', btnText: '#fdf6e3',
            overlay: '#fffbf0cc', tooltipBg: '#073642f2', tooltipText: '#fdf6e3',
            diffAdd: '#859900', diffDel: '#dc322f', diffHunk: '#268bd2',
            err: '#dc322f', busy: '#b58900',
        },
    },
};

export const DEFAULT_THEME = 'midnight';

/** Resolve a theme by name, falling back to the default. */
export function getTheme(name) {
    return THEMES[name] || THEMES[DEFAULT_THEME];
}
