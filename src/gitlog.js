// gitlog.js — parse `git log` raw output into a graph (nodes/edges/branches).
// No third-party deps: shells out to `git log` with a stable format.
//
// Format per commit (NUL-separated fields, record separated by '\x1e'):
//   %H  %P  %an  %ae  %ad  %s
//   hash | parents | author name | author email | author date (iso) | subject

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const execFileP = promisify(execFile);

// Find git executable: prefer PATH, fall back to common Windows locations
function findGit() {
    const candidates = [
        'C:\\Program Files\\Git\\cmd\\git.exe',
        'C:\\Program Files\\Git\\mingw64\\bin\\git.exe',
        'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
    ];
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    return 'git';
}

const GIT = findGit();

const FIELD_SEP = '\x1f'; // unit separator
const RECORD_SEP = '\x1e'; // record separator

/**
 * Run `git log` in `repoDir` and return raw formatted output.
 * @param {string} repoDir
 * @param {object} opts
 * @param {number} [opts.max] max commits (0 = all)
 */
export async function rawGitLog(repoDir, { max = 0, file = null } = {}) {
    const args = [
        'log',
        '--all',
        `--pretty=format:%H${FIELD_SEP}%P${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%ad${FIELD_SEP}%s${FIELD_SEP}%D%x1e`,
        '--date=iso-strict',
        '--topo-order',
    ];
    if (file) args.push('--follow'); // suit les renommées (pathspec unique)
    if (max > 0) args.push(`-n${max}`);
    if (file) args.push('--', file);
    const { stdout } = await execFileP(GIT, args, {
        cwd: repoDir,
        maxBuffer: 256 * 1024 * 1024,
    });
    return stdout;
}

/**
 * File-history mode: rebuild display edges through non-file commits.
 * `git log -- <file>` keeps real %P parents — most of them are absent from
 * the filtered set, which would leave a disconnected strand. Rewire each
 * commit to its nearest ancestor(s) that ARE in the set (same idea as git's
 * own history simplification). Full parent map comes from rev-list.
 */
async function simplifyForFile(repoDir, graph) {
    const { stdout } = await execFileP(GIT, ['rev-list', '--all', '--parents'], {
        cwd: repoDir,
        maxBuffer: 256 * 1024 * 1024,
    });
    const parentsMap = new Map();
    for (const line of stdout.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts[0]) parentsMap.set(parts[0], parts.slice(1));
    }
    const inSet = new Set(graph.nodes.map(n => n.id));
    // BFS le long des ancêtres, en s'arrêtant au premier nœud du set sur
    // chaque chemin — les merges gardent leurs 2 branches simplifiées.
    const nearestInSet = id => {
        const found = [];
        const seen = new Set();
        const q = [...(parentsMap.get(id) || [])];
        let guard = 500000; // borne de sécurité pour les énormes repos
        while (q.length && guard-- > 0) {
            const h = q.shift();
            if (seen.has(h)) continue;
            seen.add(h);
            if (inSet.has(h)) {
                found.push(h);
                continue; // ne pas traverser un nœud du set
            }
            q.push(...(parentsMap.get(h) || []));
        }
        return found;
    };
    graph.edges = [];
    for (const n of graph.nodes) {
        for (const t of nearestInSet(n.id)) graph.edges.push({ source: n.id, target: t });
    }
    // Légende : seules les branches réellement présentes dans l'historique
    // du fichier (les tips stash/empty-branch sont filtrés par l'appelant).
    const present = new Set(graph.nodes.map(n => n.branch));
    graph.branches = graph.branches.filter(b => present.has(b.id) || present.has(b.name));
}

/**
 * Per-commit churn + touched files in ONE pass:
 *   `git log --all --format=%H --numstat`
 * Each record: hash line, then `adds\tdels\tpath` lines ('-' for binaries).
 * Merges produce no numstat output -> churn 0, files [].
 * @returns {Promise<Map<string,{churn:number,files:string[]}>>}
 */
export async function getNumstat(repoDir) {
    const { stdout } = await execFileP(
        GIT,
        ['log', '--all', '--format=%H', '--numstat', '--date=iso-strict'],
        { cwd: repoDir, maxBuffer: 256 * 1024 * 1024 }
    );
    const map = new Map();
    let cur = null;
    for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        const m = line.match(/^([0-9-]+)\t([0-9-]+)\t(.+)$/);
        if (m && cur) {
            const adds = m[1] === '-' ? 0 : Number(m[1]) || 0;
            const dels = m[2] === '-' ? 0 : Number(m[2]) || 0;
            cur.churn += adds + dels;
            if (cur.files.length < 200) {
                // rename syntaxes: "a => b", "{a => b}/c" — keep the new path
                let p = m[3];
                const rm = p.match(/\{?[^{}]*=>\s*([^{}]+)\}?/);
                if (rm) p = rm[1].trim();
                cur.files.push(p);
            }
            continue;
        }
        if (/^[0-9a-f]{40}$/.test(line.trim())) {
            cur = { churn: 0, files: [] };
            map.set(line.trim(), cur);
        }
    }
    return map;
}

/**
 * "What's happening now" snapshot for the HUD: HEAD branch, ahead/behind
 * vs upstream, dirty file count. All fields degrade gracefully.
 */
export async function getNowInfo(repoDir) {
    const now = { branch: '', detached: false, ahead: null, behind: null, dirty: 0 };
    try {
        const { stdout } = await execFileP(GIT, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir });
        now.branch = stdout.trim();
        now.detached = now.branch === 'HEAD';
    } catch { /* non-repo */ }
    try {
        const { stdout } = await execFileP(
            GIT, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], { cwd: repoDir }
        );
        const [a, b] = stdout.trim().split(/\s+/).map(Number);
        now.ahead = a || 0;
        now.behind = b || 0;
    } catch { /* no upstream configured */ }
    try {
        const wt = await getWorkingTreeStatus(repoDir);
        now.dirty = wt.files.length;
    } catch { /* status failed */ }
    return now;
}

/**
 * Get real branch tips from git refs.
 * @param {string} repoDir
 * @returns {Promise<Map<string, string>>} hash -> branch name
 */
export async function getBranchTips(repoDir) {
    const { stdout } = await execFileP(
        GIT,
        ['for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads', 'refs/remotes'],
        { cwd: repoDir, maxBuffer: 16 * 1024 * 1024 }
    );
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
    const { stdout } = await execFileP(GIT, ['log', '--all', '--format=%H %D', '--date=iso-strict'], {
        cwd: repoDir,
        maxBuffer: 256 * 1024 * 1024,
    });
    const commitBranches = new Map();
    for (const line of stdout.split('\n')) {
        const spaceIdx = line.indexOf(' ');
        if (spaceIdx < 0) continue;
        const hash = line.slice(0, spaceIdx);
        const refsRaw = line.slice(spaceIdx + 1).trim();
        if (!refsRaw) continue;
        // Parse refs: "HEAD -> dev, origin/dev, origin/master"
        const refs = refsRaw
            .split(',')
            .map(r => r.trim())
            .filter(Boolean);
        let branchName = null;
        for (const r of refs) {
            const m = r.match(/HEAD\s*->\s*(\S+)/);
            if (m) {
                branchName = m[1];
                break;
            }
        }
        if (!branchName) {
            for (const r of refs) {
                if (r.startsWith('origin/') && !r.endsWith('HEAD')) {
                    branchName = r.slice(7);
                    break;
                }
            }
        }
        if (!branchName) {
            for (const r of refs) {
                if (r !== 'HEAD' && !r.startsWith('tag:')) {
                    branchName = r.replace(/^refs\//, '');
                    break;
                }
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
    const { stdout } = await execFileP(GIT, ['rev-list', '--all', '--children'], {
        cwd: repoDir,
        maxBuffer: 256 * 1024 * 1024,
    });
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
 * List all stashes with their hash and message.
 * @param {string} repoDir
 * @returns {Promise<Array<{name:string,hash:string,message:string}>>}
 */
export async function getStashes(repoDir) {
    const { stdout } = await execFileP(GIT, ['stash', 'list', '--format=%H%x1f%gd%x1f%s'], {
        cwd: repoDir,
        maxBuffer: 16 * 1024 * 1024,
    });
    const stashes = [];
    for (const line of stdout.split('\n')) {
        const [hash, name, ...msgParts] = line.trim().split(FIELD_SEP);
        if (!hash || !name) continue;
        stashes.push({ name, hash, message: msgParts.join(FIELD_SEP) || '(no message)' });
    }
    return stashes;
}

/**
 * Get all commits for each branch using git rev-list.
 * Reads the truth from git refs (zero topology heuristic): the first ref
 * (local refs before remotes) that reaches a commit owns it.
 * @param {string} repoDir
 * @returns {Promise<{hashToBranch: Map<string,string>, branchCommits: Map<string,number>, branches: Array<{name:string,hash:string}>}>}
 */
export async function getCommitsByBranch(repoDir) {
    // 1. Real branch refs. Drop the */HEAD symref alias; keep local refs first
    //    so `dev` wins over `origin/dev`.
    const { stdout: tipsStdout } = await execFileP(
        'git',
        ['for-each-ref', '--format=%(refname) %(refname:short) %(objectname)', 'refs/heads', 'refs/remotes'],
        { cwd: repoDir, maxBuffer: 16 * 1024 * 1024 }
    );

    const branches = [];
    const seen = new Set();
    for (const line of tipsStdout.split('\n')) {
        const [full, name, hash] = line.trim().split(' ');
        if (!full || !name || !hash) continue;
        if (full.endsWith('/HEAD')) continue; // origin/HEAD symref alias
        if (seen.has(name)) continue;
        seen.add(name);
        branches.push({
            name,
            hash,
            local: full.startsWith('refs/heads/'),
            remote: full.startsWith('refs/remotes/'),
        });
    }

    // 1b. Stashes: each stash is a separate "branch" so it shows in the legend.
    //     Stash commits are often already reachable from other branches, so
    //     they may end up with 0 rendered commits — that's expected.
    const stashes = await getStashes(repoDir);
    for (const s of stashes) {
        if (!seen.has(s.name)) {
            seen.add(s.name);
            branches.push({ name: s.name, hash: s.hash });
        }
    }

    // 2. For each branch, list reachable commits. First ref to claim a commit wins.
    const hashToBranch = new Map();
    const branchCommits = new Map();
    for (const br of branches) {
        let revList;
        try {
            const { stdout } = await execFileP(GIT, ['rev-list', br.name], {
                cwd: repoDir,
                maxBuffer: 256 * 1024 * 1024,
            });
            revList = stdout.split('\n').filter(Boolean);
        } catch {
            continue; // unreachable / invalid ref
        }
        branchCommits.set(br.name, revList.length);
        for (const hash of revList) {
            if (!hashToBranch.has(hash)) hashToBranch.set(hash, br.name);
        }
    }

    return { hashToBranch, branchCommits, branches };
}

/**
 * Parse raw git log text into a graph structure.
 * @param {string} raw
 * @param {string} repoDir
 * @param {object} [opts]
 * @param {Map<string,string>} [opts.hashToBranch] hash -> branch name (from getCommitsByBranch)
 * @param {Map<string,number>} [opts.branchCommits] branch -> reachable commit count
 * @param {Array<{name:string,hash:string}>} [opts.branches] real refs (for-each-ref order)
 * @returns {{nodes:object[], edges:object[], branches:object[], head:string|null, repoDir:string}}
 */
export function parseGitLog(
    raw,
    repoDir = '',
    { hashToBranch = new Map(), branchCommits = new Map(), branches: realBranches = [] } = {}
) {
    const records = raw.split(RECORD_SEP).filter(r => r.trim().length > 0);
    const nodes = [];
    const edges = [];
    const byHash = new Map();
    let head = null;

    for (const rec of records) {
        const [hash, parentsRaw, author, email, date, subject, refsRaw] = rec
            .replace(/^\n+/, '')
            .split(FIELD_SEP)
            .map(s => s.replace(/\n+$/, ''));
        if (!hash) continue;
        if (head === null) head = hash; // first row is HEAD
        const parents = (parentsRaw || '').split(/\s+/).filter(Boolean);
        // extract branch name from refs (e.g. "HEAD -> dev, origin/dev" -> "dev")
        const refs = (refsRaw || '')
            .split(',')
            .map(r => r.trim())
            .filter(Boolean);
        let branchName = null;
        for (const r of refs) {
            const m = r.match(/HEAD\s*->\s*(\S+)/);
            if (m) {
                branchName = m[1];
                break;
            }
        }
        if (!branchName) {
            for (const r of refs) {
                if (r.startsWith('origin/') && !r.endsWith('HEAD')) {
                    branchName = r.slice(7);
                    break;
                }
            }
        }
        if (!branchName) {
            for (const r of refs) {
                if (r !== 'HEAD' && !r.startsWith('tag:')) {
                    branchName = r.replace(/^refs\//, '');
                    break;
                }
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
            tags: refs.filter(r => r.startsWith('tag:')).map(r => r.slice(4).trim()),
            churn: 0, // +files — filled by buildGraph via getNumstat
            files: [],
            // layout fields filled later:
            depth: -1,
            branch: null,
            remote: false, // owned by a refs/remotes/* branch
            x: 0,
            y: 0,
            z: 0,
        };
        nodes.push(node);
        byHash.set(hash, node);
        for (const p of parents) {
            edges.push({ source: hash, target: p });
        }
    }

    // depth = longest path from a root (no parents) — topological via memo.
    const depthCache = new Map();
    const getDepth = n => {
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

    // branch assignment: read the truth from git refs (no topology heuristic).
    // Each commit is assigned to the first ref (local before remote) that reaches it.
    const branchColor = {};
    const remoteSet = new Set(realBranches.filter(b => b.remote).map(b => b.name));
    if (hashToBranch.size > 0) {
        for (const n of nodes) {
            n.branch = hashToBranch.get(n.id) || 'unknown';
            n.remote = remoteSet.has(n.branch);
        }
        let colorIdx = 0;
        for (const n of nodes) {
            if (!(n.branch in branchColor)) branchColor[n.branch] = colorIdx++;
        }
    } else {
        // Fallback: topological heuristic (only when git refs are unavailable)
        const children = new Map();
        for (const n of nodes) children.set(n.id, []);
        for (const e of edges) {
            if (children.has(e.target)) children.get(e.target).push(e.source);
        }
        const isParentOfSomeone = new Set(edges.map(e => e.source));
        const tips = nodes.filter(n => !isParentOfSomeone.has(n.id));
        let branchCounter = 0;
        const branchNameFor = tip => {
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

    // branch summary — one entry per REAL ref (even 0 rendered commits),
    // plus synthetic buckets (e.g. 'unknown') that actually own nodes.
    // `commits` = nodes rendered on this branch (legend sort + layout prominence).
    // `reach`   = total commits reachable from the ref tip.
    const branchMap = new Map();
    realBranches.forEach((br, i) => {
        branchMap.set(br.name, {
            id: br.name,
            name: br.name,
            color: i % 6,
            commits: 0,
            reach: branchCommits.get(br.name) ?? 0,
            tip: br.hash,
            local: !!br.local,
            remote: !!br.remote,
        });
    });
    for (const n of nodes) {
        let b = branchMap.get(n.branch);
        if (!b) {
            b = {
                id: n.branch,
                name: n.branch,
                color: (branchColor[n.branch] ?? 0) % 6,
                commits: 0,
                reach: 0,
                tip: null,
                local: false,
                remote: false,
            };
            branchMap.set(n.branch, b);
        }
        b.commits++;
        if (!b.tip) b.tip = n.id;
    }

    // ── Synthetic tip nodes for stashes and 0-commit branches ──
    // These refs point to commits already owned by other branches, so they
    // have 0 rendered nodes. We add a synthetic tip node + dashed edge so
    // they are visible in the 3D graph.
    const isStashName = name => /^stash@\{\d+\}$/.test(name);
    const nodeHashes = new Set(nodes.map(n => n.id));
    const syntheticTips = [];
    for (const br of realBranches) {
        const b = branchMap.get(br.name);
        if (!b) continue;
        // Only add synthetic tip if the branch has 0 rendered commits AND
        // its tip commit is already in the graph (owned by another branch).
        if (b.commits === 0 && nodeHashes.has(br.hash)) {
            const tipCommit = byHash.get(br.hash);
            const tipNode = {
                id: br.hash,
                short: br.hash.slice(0, 7),
                author: tipCommit ? tipCommit.author : '(ref)',
                email: tipCommit ? tipCommit.email : '',
                date: tipCommit ? tipCommit.date : '',
                subject: isStashName(br.name) ? `stash: ${br.name}` : `empty branch: ${br.name}`,
                parents: tipCommit ? tipCommit.parents : [],
                branchName: br.name,
                depth: tipCommit ? tipCommit.depth : 0,
                branch: br.name,
                x: 0,
                y: 0,
                z: 0,
                isTip: true,
                tipType: isStashName(br.name) ? 'stash' : 'empty-branch',
            };
            syntheticTips.push(tipNode);
            // Dashed edge from tip to its parent (the commit it points to)
            if (tipCommit && tipCommit.parents.length > 0) {
                edges.push({ source: br.hash, target: tipCommit.parents[0], dashed: true });
            }
            b.commits = 1; // count the synthetic tip
            b.tip = br.hash;
        }
    }
    // Add synthetic tips to nodes array
    for (const tip of syntheticTips) {
        nodes.push(tip);
        byHash.set(tip.id, tip);
    }

    const branches = [...branchMap.values()];

    return { nodes, edges, branches, head, repoDir, generatedAt: new Date().toISOString() };
}

/**
 * Working tree status (`git status --porcelain=v1 -uall`).
 * Returns the list of changed files with their XY status codes — empty when
 * the tree is clean or status fails (non-repo dir, bare repo, …).
 * @param {string} repoDir
 * @returns {Promise<{files:Array<{status:string,path:string}>}>}
 */
export async function getWorkingTreeStatus(repoDir) {
    const { stdout } = await execFileP(GIT, ['status', '--porcelain=v1', '-uall'], {
        cwd: repoDir,
        maxBuffer: 16 * 1024 * 1024,
    });
    const files = [];
    for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        files.push({ status: line.slice(0, 2).trim(), path: line.slice(3) });
    }
    return { files };
}

/**
 * Convenience: parse the repo directly.
 * Appends a synthetic "uncommitted changes" node (dashed edge to HEAD) when
 * the working tree is dirty — like GitGraph's top-of-graph marker.
 */
export async function buildGraph(repoDir, opts = {}) {
    const file = typeof opts.file === 'string' && opts.file ? opts.file : null;
    const raw = await rawGitLog(repoDir, { ...opts, file });
    const { hashToBranch, branchCommits, branches } = await getCommitsByBranch(repoDir);
    const graph = parseGitLog(raw, repoDir, { hashToBranch, branchCommits, branches });

    // Churn + touched files (one numstat pass) — drive node size / edge
    // thickness / hotspot highlighting. Failures degrade to churn 0.
    try {
        const stats = await getNumstat(repoDir);
        for (const n of graph.nodes) {
            const s = stats.get(n.id);
            if (s) { n.churn = s.churn; n.files = s.files; }
        }
    } catch { /* numstat unavailable */ }

    // "NOW" snapshot for the HUD (HEAD, ahead/behind, dirty count).
    try {
        graph.now = await getNowInfo(repoDir);
        const headNode = graph.head ? graph.nodes.find(n => n.id === graph.head) : null;
        if (headNode) graph.now.lastDate = headNode.date;
    } catch { /* HUD degrades to plain stats */ }

    if (file) {
        // Retirer les tips synthétiques (stash/empty-branch) — hors sujet
        // dans l'historique d'un fichier — puis recâbler les arêtes.
        graph.nodes = graph.nodes.filter(n => !n.isTip);
        await simplifyForFile(repoDir, graph);
        graph.file = file;
    }

    try {
        const wt = await getWorkingTreeStatus(repoDir);
        const headNode = graph.head ? graph.nodes.find(n => n.id === graph.head) : null;
        // En mode fichier, le nœud uncommitted n'apparaît que si le fichier
        // lui-même est modifié dans le working tree.
        const fileDirty = !file || wt.files.some(f => f.path === file || f.path.endsWith('/' + file));
        if (wt.files.length && headNode && fileDirty) {
            graph.nodes.push({
                id: 'uncommitted',
                short: '○',
                author: '(working tree)',
                email: '',
                date: headNode.date, // same timeline slot as HEAD
                subject: `${wt.files.length} uncommitted change(s)`,
                parents: [graph.head],
                branchName: headNode.branchName,
                depth: headNode.depth + 1,
                branch: headNode.branch, // rides with the checked-out branch
                x: 0,
                y: 0,
                z: 0,
                isTip: true,
                tipType: 'uncommitted',
            });
            graph.edges.push({ source: 'uncommitted', target: graph.head, dashed: true });
            graph.hasUncommitted = true;
        }
    } catch {
        // status failed (non-repo dir, etc.) — graph works fine without the node
    }
    return graph;
}
