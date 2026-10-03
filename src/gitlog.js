// gitlog.js — parse `git log` raw output into a graph (nodes/edges/branches).
// No third-party deps: shells out to `git log` with a stable format.
//
// Format per commit (NUL-separated fields, record separated by '\x1e'):
//   %H  %P  %an  %ae  %ad  %s
//   hash | parents | author name | author email | author date (iso) | subject

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const FIELD_SEP = '\x1f'; // unit separator
const RECORD_SEP = '\x1e'; // record separator

/**
 * Run `git log` in `repoDir` and return raw formatted output.
 * @param {string} repoDir
 * @param {object} opts
 * @param {number} [opts.max] max commits (0 = all)
 */
export async function rawGitLog(repoDir, { max = 0 } = {}) {
    const args = [
        'log',
        `--pretty=format:%H${FIELD_SEP}%P${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%ad${FIELD_SEP}%s${FIELD_SEP}%D%x1e`,
        '--date=iso-strict',
        '--topo-order',
    ];
    if (max > 0) args.push(`-n${max}`);
    const { stdout } = await execFileP('git', args, {
        cwd: repoDir,
        maxBuffer: 256 * 1024 * 1024,
    });
    return stdout;
}

/**
 * Parse raw git log text into a graph structure.
 * @returns {{nodes:object[], edges:object[], branches:object[], head:string|null, repoDir:string}}
 */
export function parseGitLog(raw, repoDir = '') {
    const records = raw.split(RECORD_SEP).filter((r) => r.trim().length > 0);
    const nodes = [];
    const edges = [];
    const byHash = new Map();
    let head = null;

    for (const rec of records) {
        const [hash, parentsRaw, author, email, date, subject, refsRaw] = rec
            .replace(/^\n+/, '')
            .split(FIELD_SEP)
            .map((s) => s.replace(/\n+$/, ''));
        if (!hash) continue;
        if (head === null) head = hash; // first row is HEAD
        const parents = (parentsRaw || '').split(/\s+/).filter(Boolean);
        // extract branch name from refs (e.g. "HEAD -> dev, origin/dev" -> "dev")
        const refs = (refsRaw || '').split(',').map((r) => r.trim()).filter(Boolean);
        let branchName = null;
        for (const r of refs) {
            const m = r.match(/HEAD\s*->\s*(\S+)/);
            if (m) { branchName = m[1]; break; }
        }
        if (!branchName) {
            for (const r of refs) {
                if (r.startsWith('origin/') && !r.endsWith('HEAD')) { branchName = r.slice(7); break; }
            }
        }
        if (!branchName) {
            for (const r of refs) {
                if (r !== 'HEAD' && !r.startsWith('tag:')) { branchName = r.replace(/^refs\//, ''); break; }
            }
        }
        const node = {
            id: hash,
            short: hash.slice(0, 7),
            author,
            email,
            date,
            subject: subject || '(no subject)',
            parents,
            branchName,
            // layout fields filled later:
            depth: -1,
            branch: null,
            x: 0, y: 0, z: 0,
        };
        nodes.push(node);
        byHash.set(hash, node);
        for (const p of parents) {
            edges.push({ source: hash, target: p });
        }
    }

    // depth = longest path from a root (no parents) — topological via memo.
    const depthCache = new Map();
    const getDepth = (n) => {
        if (depthCache.has(n.id)) return depthCache.get(n.id);
        if (!n.parents || n.parents.length === 0) {
            depthCache.set(n.id, 0);
            return 0;
        }
        let d = 0;
        for (const p of n.parents) {
            const pn = byHash.get(p);
            if (pn) d = Math.max(d, getDepth(pn) + 1);
            else d = Math.max(d, 1); // parent not in set (shallow/clipped)
        }
        depthCache.set(n.id, d);
        return d;
    };
    for (const n of nodes) n.depth = getDepth(n);

    // branch assignment: a node starts a branch if it has >1 child OR is a head ref.
    // We compute children map, then label lane per commit via simple heuristic:
    //   - root of a branch = node whose children count diverges, or first commit.
    //   - propagate branch id down the first-parent chain.
    const children = new Map();
    for (const n of nodes) children.set(n.id, []);
    for (const e of edges) {
        if (children.has(e.target)) children.get(e.target).push(e.source);
    }
    // Find branch heads = commits that are heads of refs (we approximate: nodes that
    // are not a parent of any other node in this set, i.e. real tips; plus HEAD).
    const isParentOfSomeone = new Set(edges.map((e) => e.source));
    const tips = nodes.filter((n) => !isParentOfSomeone.has(n.id));
    // Assign branches by first-parent walk from each tip.
    let branchCounter = 0;
    const branchColor = {};
    const branchNameFor = (tip) => {
        const key = tip.branch || `branch_${branchCounter++}`;
        if (!(key in branchColor)) branchColor[key] = branchCounter - 1;
        return key;
    };
    // Walk: each tip seeds a branch; when a node has multiple children (merge fan-out),
    // the secondary children start new branches.
    const visited = new Set();
    const assignBranch = (node, branchId) => {
        if (!node || visited.has(node.id)) return;
        visited.add(node.id);
        node.branch = branchId;
        const kids = children.get(node.id) || [];
        // first kid continues branch; rest spawn new branches
        kids.forEach((kidId, idx) => {
            const kid = byHash.get(kidId);
            if (!kid) return;
            if (idx === 0) assignBranch(kid, branchId);
            else assignBranch(kid, `branch_${branchCounter++}`);
        });
    };
    for (const tip of tips.length ? tips : nodes.slice(0, 1)) {
        assignBranch(tip, branchNameFor(tip));
    }
    // any unvisited (cycles/orphans) get default branch
    for (const n of nodes) if (!n.branch) n.branch = 'branch_0';

    // branch summary
    const branchMap = new Map();
    for (const n of nodes) {
        if (!branchMap.has(n.branch)) {
            branchMap.set(n.branch, { id: n.branch, name: n.branchName || n.branch, color: (branchColor[n.branch] ?? 0) % 6, commits: 0, tip: null });
        }
        const b = branchMap.get(n.branch);
        b.commits++;
        if (!b.tip) { b.tip = n.id; if (n.branchName) b.name = n.branchName; }
    }
    const branches = [...branchMap.values()];

    return { nodes, edges, branches, head, repoDir, generatedAt: new Date().toISOString() };
}

/**
 * Convenience: parse the repo directly.
 */
export async function buildGraph(repoDir, opts = {}) {
    const raw = await rawGitLog(repoDir, opts);
    return parseGitLog(raw, repoDir);
}
