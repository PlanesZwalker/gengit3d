// similar-commits.js — detect commits that share the same normalized subject.
// These are likely cherry-picks, parallel fixes, or repeated merge messages
// across branches (or within the same branch). Produces dashed links in the scene.
//
// Groups commits by normalized subject (lowercase, whitespace-collapsed) and links
// all pairs that are NOT already parent↔child in the parent graph.

/** Normalize a commit subject for comparison: lowercase, collapse whitespace. */
function normSubject(s) {
  if (!s) return '';
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Build "similar" edges between commits sharing the same normalized subject.
 * Edges are { from, to, type:'similar' } — the renderer draws them all dashed;
 * caller can inspect source nodes' branch fields to distinguish cross-branch vs intra-branch.
 *
 * Skips pairs that are already parent↔child (no need to duplicate existing edges).
 */
export function buildSimilarEdges(graph) {
  // group commits by normalized subject only (not email) to catch parallel fixes
  // with different authors/emails and repeated merge-template messages.
  const groups = new Map();
  for (const n of graph.nodes) {
    const key = normSubject(n.subject);
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(n);
  }

  const out = [];
  const seen = new Set();
  for (const [, commits] of groups) {
    if (commits.length < 2) continue;
    for (let i = 0; i < commits.length; i++) {
      for (let j = i + 1; j < commits.length; j++) {
        const a = commits[i];
        const b = commits[j];
        // skip pairs that are already parent↔child (would duplicate existing edge)
        const aParentOfB = a.parents && a.parents.includes(b.id);
        const bParentOfA = b.parents && b.parents.includes(a.id);
        if (aParentOfB || bParentOfA) continue;

        const from = a.id < b.id ? a.id : b.id;
        const to = a.id < b.id ? b.id : a.id;
        const edgeKey = from + '\x01' + to;
        if (seen.has(edgeKey)) continue;
        seen.add(edgeKey);
        out.push({ from, to, type: 'similar' });
      }
    }
  }
  return out;
}
