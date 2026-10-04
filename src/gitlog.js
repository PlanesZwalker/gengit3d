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
 * Get real branch tips from git refs.
 * @param {string} repoDir
 * @returns {Promise<Map<string, string>>} hash -> branch name
 */
export async function getBranchTips(repoDir) {
    const { stdout } = await execFileP('git', [
        'for-each-ref',
        '--format=%(objectname) %(refname:short)',
        'refs/heads', 'refs/remotes',
    ], { cwd: repoDir, maxBuffer: 16 * 1024 * 1024 });
    const tips = new Map();
    for (const line of stdout.split('\n')) {
        const [hash, ...nameParts] = line.trim().split(' ');
        if (!hash || !nameParts.length) continue;
        let name = nameParts.join(' ');
        // Normalize: origin/branch -> branch, keep local branches as-is
        if (name.startsWith('origin/') && name !== 'origin/HEAD') {
            name = name.slice(7);
        }
        // Only keep the first tip per branch name (local preferred over remote)
        if (!tips.has(name)) {
            tips.set(name, hash);
        }
    }
    return tips;
}

/**
 * Get branch assignment for each commit using git log with refs.
 * @param {string} repoDir
 * @returns {Promise<Map<string, string>>} hash -> branch name
 */
export async function getCommitBranches(repoDir) {
    const { stdout } = await execFileP('git', [
        'log', '--all',
        '--format=%H %D',
        '--date=iso-strict',
    ], { cwd: repoDir, maxBuffer: 256 * 1024 * 1024 });
    const commitBranches = new Map();
    for (const line of stdout.split('\n')) {
        const spaceIdx = line.indexOf(' ');
        if (spaceIdx < 0) continue;
        const hash = line.slice(0, spaceIdx);
        const refsRaw = line.slice(spaceIdx + 1).trim();
        if (!refsRaw) continue;
        // Parse refs: "HEAD -> dev, origin/dev, origin/master"
        const refs = refsRaw.split(',').map((r) => r.trim()).filter(Boolean);
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
        if (branchName) {
            commitBranches.set(hash, branchName);
        }
    }
    return commitBranches;
}

/**
 * Get children map from git rev-list.
 * @param {string} repoDir
 * @returns {Promise<Map<string, string[]>>} hash -> array of child hashes
 */
export async function getChildrenMap(repoDir) {
    const { stdout } = await execFileP('git', [
        'rev-list', '--all', '--children',
    ], { cwd: repoDir, maxBuffer: 256 * 1024 * 1024 });
    const childrenOf = new Map();
    for (const line of stdout.split('\n')) {
        const parts = line.trim().split(' ');
        if (parts.length < 1) continue;
        const hash = parts[0];
        const children = parts.slice(1);
        childrenOf.set(hash, children);
    }
    return childrenOf;
}

/**
 * Get all commits for each branch using git rev-list.
 * Much faster than git branch --contains for each commit.
 * @param {string} repoDir
 * @returns {Promise<Map<string, string>>} hash -> branch name
 */
export async function getCommitsByBranch(repoDir) {
    // 1. Get branch tips
    const { stdout: tipsStdout } = await execFileP('git', [
        'for-each-ref',
        '--format=%(refname:short) %(objectname)',
        'refs/heads', 'refs/remotes',
    ], { cwd: repoDir, maxBuffer: 16 * 1024 * 1024 });
    
    const tips = new Map(); // hash -> branch name
    for (const line of tipsStdout.split('\n')) {
        const spaceIdx = line.indexOf(' ');
        if (spaceIdx < 0) continue;
        const name = line.slice(0, spaceIdx).trim();
        const hash = line.slice(spaceIdx + 1).trim();
        if (!name || !hash) continue;
        let normalizedName = name;
        if (name.startsWith('origin/') && name !== 'origin/HEAD') {
            normalizedName = name.slice(7);
        }
        tips.set(hash, normalizedName);
    }
    
    // 2. Get children map: hash -> [child1, child2, ...]
    const { stdout: childrenStdout } = await execFileP('git', [
        'rev-list', '--all', '--children',
    ], { cwd: repoDir, maxBuffer: 256 * 1024 * 1024 });
    
    const childrenMap = new Map();
    for (const line of childrenStdout.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 1) continue;
        const hash = parts[0];
        const children = parts.slice(1);
        childrenMap.set(hash, children);
    }
    
    // 3. BFS from tips: each commit inherits branch from its nearest tip
    const branchCommits = new Map(); // hash -> branch name
    const queue = [];
    for (const [hash, name] of tips) {
        branchCommits.set(hash, name);
        queue.push(hash);
    }
    
    while (queue.length > 0) {
        const hash = queue.shift();
        const branch = branchCommits.get(hash);
        const children = childrenMap.get(hash) || [];
        for (const child of children) {
            if (!branchCommits.has(child)) {
                branchCommits.set(child, branch);
                queue.push(child);
            }
        }
    }
    
    return branchCommits;
}

/**
 * Parse raw git log text into a graph structure.
 * @param {string} raw
 * @param {string} repoDir
 * @param {Map<string, string>} [commitBranches] hash -> branch name (from getCommitBranches)
 * @param {Map<string, string[]>} [childrenMap] hash -> array of child hashes (from getChildrenMap)
 * @returns {{nodes:object[], edges:object[], branches:object[], head:string|null, repoDir:string}}
 */
export function parseGitLog(raw, repoDir = '', commitBranches = null, childrenMap = null) {
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

    // branch assignment: use real git branches if available, fallback to topological heuristic
    const branchColor = {};
    if (commitBranches && commitBranches.size > 0) {
        // Direct assignment: each commit gets its branch from commitBranches
        for (const n of nodes) {
            n.branch = commitBranches.get(n.id) || 'unknown';
        }
        // Fill branchColor for color assignment
        let colorIdx = 0;
        for (const n of nodes) {
            if (!(n.branch in branchColor)) {
                branchColor[n.branch] = colorIdx++;
            }
        }
    } else {
        // Fallback: topological heuristic (original algorithm)
        const children = new Map();
        for (const n of nodes) children.set(n.id, []);
        for (const e of edges) {
            if (children.has(e.target)) children.get(e.target).push(e.source);
        }
        const isParentOfSomeone = new Set(edges.map((e) => e.source));
        const tips = nodes.filter((n) => !isParentOfSomeone.has(n.id));
        let branchCounter = 0;
        const branchNameFor = (tip) => {
            const key = tip.branch || `branch_${branchCounter++}`;
            if (!(key in branchColor)) branchColor[key] = branchCounter - 1;
            return key;
        };
        const visited = new Set();
        const assignBranch = (node, branchId) => {
            if (!node || visited.has(node.id)) return;
            visited.add(node.id);
            node.branch = branchId;
            const kids = children.get(node.id) || [];
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
        for (const n of nodes) if (!n.branch) n.branch = 'branch_0';
    }

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
    const commitBranches = await getCommitsByBranch(repoDir);
    return parseGitLog(raw, repoDir, commitBranches);
}
