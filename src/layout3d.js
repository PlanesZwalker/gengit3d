// layout3d.js — assign 3D coordinates to git graph nodes.
//
// Strategy (deterministic, zero-dep, volumetric):
//   - y axis  = commit depth (time / generation), history grows UPWARD.
//   - xz plane = branch position around a cylinder (angle + radius), so each
//                branch is a distinct vertical strand with real depth separation.
//
// Branches are sorted by size. The most significant ones get evenly spaced
// angular slots on an inner radius; the long tail of tiny/fragment branches is
// spread on an outer ring so it reads as a background halo instead of a solid
// wall. Per-commit wobble (hash-based, deterministic) gives each strand organic
// volume so the render is clearly 3D rather than a flat plane.
//
// Deterministic: the same repo always renders the same shape (good for diffing).

/**
 * Compute layout coordinates for a graph produced by gitlog.parseGitLog.
 * Mutates node.x/y/z (+ node.lane, node.angle, node.radius) in place.
 * @param {object} graph
 * @param {object} [opts]
 * @param {number} [opts.height=300]        vertical extent of the time axis (y)
 * @param {number} [opts.radiusMajor=120]   radius for the prominent branches
 * @param {number} [opts.radiusMinor=195]   radius for the long-tail branches
 * @param {number} [opts.prominentCount=24] branches given a dedicated angular slot
 * @param {number} [opts.angleWobble=0.16]  per-commit angular spread (radians)
 * @param {number} [opts.radiusWobble=10]   per-commit radial spread
 */
export function layoutGraph(
    graph,
    {
        height = 300,
        radiusMajor = 100,
        radiusMinor = 250,
        prominentCount = 36,
        angleWobble = 0.05,
        radiusWobble = 5,
    } = {}
) {
    const branches = [...graph.branches].sort((a, b) => b.commits - a.commits);
    const nBranches = branches.length || 1;
    const nProminent = Math.min(prominentCount, nBranches);
    const GOLDEN = Math.PI * (3 - Math.sqrt(5)); // ~2.39996 rad

    // assign each branch an angle + radius. Golden-angle spacing keeps strands
    // from lining up, and concentric shells add radial separation so branches
    // are distinguishable even at similar angles. The long tail of tiny
    // branches is pushed far out into a faint halo, away from the main strands.
    const posOf = new Map();
    branches.forEach((b, rank) => {
        let angle, radius;
        if (rank < nProminent) {
            angle = rank * GOLDEN;
            radius = radiusMajor + (rank % 6) * 38; // 6 inner shells (120..310)
        } else {
            const k = rank - nProminent;
            angle = (k + 0.5) * GOLDEN;
            radius = radiusMinor + (k % 5) * 10; // outer halo (350..390)
        }
        posOf.set(b.id, { angle, radius });
    });

    const maxDepth = graph.nodes.reduce((m, n) => Math.max(m, n.depth), 0) || 1;

    // y axis: prefer the REAL commit DATE so the vertical axis is a true,
    // monotonic timeline. Fall back to topological depth when dates are absent.
    const times = graph.nodes
        .map((n) => Date.parse(n.date))
        .filter((t) => Number.isFinite(t));
    let tMin = Infinity, tMax = -Infinity;
    for (const t of times) { if (t < tMin) tMin = t; if (t > tMax) tMax = t; }
    const useTime = times.length === graph.nodes.length && tMax > tMin;
    graph.axis = { mode: useTime ? 'time' : 'depth', tMin, tMax };

    for (const n of graph.nodes) {
        const p = posOf.get(n.branch) || { angle: 0, radius: radiusMinor };
        const h1 = hash01(n.id);
        const h2 = hash01(n.id + '#r');
        const angle = p.angle + (h1 - 0.5) * 2 * angleWobble;
        const radius = p.radius + (h2 - 0.5) * 2 * radiusWobble;
        n.angle = angle;
        n.radius = radius;
        n.x = Math.cos(angle) * radius;
        n.z = Math.sin(angle) * radius;
        // history grows upward: oldest at the bottom, newest at the top
        if (useTime) {
            n.y = ((Date.parse(n.date) - tMin) / (tMax - tMin) - 0.5) * height;
        } else {
            n.y = (n.depth / maxDepth - 0.5) * height;
        }
        n.lane = n.lane ?? 0; // legacy field kept for compatibility
    }

    return graph;
}

// cheap deterministic 0..1 hash from string
function hash01(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 100000) / 100000;
}

/**
 * Optional light relaxation: nudges nodes apart within the same depth band so
 * dense columns breathe. Operates on the xz plane (radial), preserving the
 * vertical time axis. Opt-in via `--relax`.
 * @param {object} graph
 * @param {object} [opts]
 */
export function relax(graph, { iterations = 20, repel = 0.6 } = {}) {
    for (let it = 0; it < iterations; it++) {
        const cols = new Map();
        for (const n of graph.nodes) {
            if (!cols.has(n.depth)) cols.set(n.depth, []);
            cols.get(n.depth).push(n);
        }
        for (const [, col] of cols) {
            if (col.length < 2) continue;
            for (let i = 0; i < col.length; i++) {
                for (let j = i + 1; j < col.length; j++) {
                    const a = col[i],
                        b = col[j];
                    let dx = b.x - a.x,
                        dz = b.z - a.z;
                    const d2 = dx * dx + dz * dz;
                    const minD = 6;
                    if (d2 < minD * minD) {
                        const d = Math.sqrt(d2) || 0.001;
                        const push = ((minD - d) / d) * repel * 0.5;
                        dx *= push;
                        dz *= push;
                        b.x += dx;
                        b.z += dz;
                        a.x -= dx;
                        a.z -= dz;
                    }
                }
            }
        }
    }
    return graph;
}
