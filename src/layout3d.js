// layout3d.js — assign 3D coordinates to git graph nodes.
//
// Strategy (dagre/force-style, lightweight, zero-dep):
//   - x axis  = commit depth (time / generation). depth already computed in gitlog.js.
//   - y axis  = branch lane (each branch gets its own horizontal row).
//   - z axis  = small jitter per commit to avoid exact overlaps + readable depth.
//
// This is a deterministic lane layout (not a physics sim) so the same repo
// always renders the same graph — good for debugging. A force relaxation pass
// is available as `relax()` if you want organic spacing later.

/**
 * Compute layout coordinates for a graph produced by gitlog.parseGitLog.
 * Mutates node.x/y/z in place and returns the graph.
 * @param {object} graph
 * @param {object} [opts]
 * @param {number} [opts.laneGap=3]  distance between branch lanes
 * @param {number} [opts.depthGap=2] distance between commits along x
 * @param {number} [opts.zJitter=0.6] random-ish z spread
 * @param {number} [opts.maxLanes=64] distinct lanes; extra branches share last lane
 */
export function layoutGraph(graph, { laneGap = 3, depthGap = 2, zJitter = 0.6, maxLanes = 64 } = {}) {
  // assign lane index per branch id: biggest branches get low lanes, the rest
  // share the last ("misc") lane so the graph stays readable.
  const sorted = [...graph.branches].sort((a, b) => b.commits - a.commits);
  const laneOf = new Map();
  sorted.forEach((b, i) => {
    laneOf.set(b.id, i < maxLanes - 1 ? i : maxLanes - 1);
  });
  const maxDepth = graph.nodes.reduce((m, n) => Math.max(m, n.depth), 0) || 1;

  for (const n of graph.nodes) {
    const lane = laneOf.get(n.branch) ?? maxLanes - 1;
    n.lane = lane;
    n.x = (maxDepth - n.depth) * depthGap; // newest commit near x=0
    n.y = lane * laneGap;
    // deterministic pseudo-jitter from hash so layout is stable
    const h = hash01(n.id);
    n.z = (h - 0.5) * 2 * zJitter;
  }

  // center the cloud around origin for nicer OrbitControls default view
  let cx = 0, cy = 0, cz = 0;
  for (const n of graph.nodes) { cx += n.x; cy += n.y; cz += n.z; }
  const k = graph.nodes.length || 1;
  cx /= k; cy /= k; cz /= k;
  for (const n of graph.nodes) { n.x -= cx; n.y -= cy; n.z -= cz; }

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
 * Optional spring relaxation (force-directed) on top of the lane layout.
 * Pushes overlapping nodes apart along y within the same depth column.
 * @param {object} graph
 * @param {object} [opts]
 */
export function relax(graph, { iterations = 30, repel = 0.8 } = {}) {
  for (let it = 0; it < iterations; it++) {
    // group by depth column
    const cols = new Map();
    for (const n of graph.nodes) {
      const d = n.depth;
      if (!cols.has(d)) cols.set(d, []);
      cols.get(d).push(n);
    }
    for (const [, col] of cols) {
      // sort by y, spread apart if too close
      col.sort((a, b) => a.y - b.y);
      for (let i = 1; i < col.length; i++) {
        const a = col[i - 1], b = col[i];
        const minGap = 2.2;
        if (b.y - a.y < minGap) {
          const shift = (minGap - (b.y - a.y)) * repel;
          b.y += shift;
        }
      }
    }
  }
  return graph;
}
