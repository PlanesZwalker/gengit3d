#!/usr/bin/env node
// bin/gengit3d.js — CLI + HTTP server for GenGit3D.
//
// MSYS/git-bash path quirk: on Windows the shell passes POSIX paths like
// /c/Users/... but the git.exe binary + Node fs expect native C:\Users\...
// Normalize any leading /<drive>/ to <drive>:\ before use.

function toNative(p) {
    if (!p) return p;
    const m = /^[/\\]([a-zA-Z])[/\\]/.exec(p);
    if (m) return m[1].toUpperCase() + ':\\' + p.slice(3).replace(/\//g, '\\');
    return p;
}
//   parse  : git log -> graph.json in repo (or --out)
//   serve  : static server + /api/graph (parse any repo on demand)
//   (no args) : parse then serve
//
// Usage:
//   node bin/gengit3d.js parse  [--repo <dir>] [--out graph.json] [--max N]
//   node bin/gengit3d.js serve  [--port 8080] [--dir .]
//   node bin/gengit3d.js        [--repo <dir>]
//
// HTTP API:
//   GET /api/graph?repo=<path>&max=<n>       parse a LOCAL repo on demand
//   GET /api/clone?url=<git-url>&depth=<n>   clone a REMOTE repo, then parse
//   GET /gengit3d.graph.json                 last generated graph (static)

import { writeFile, readFile, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { buildGraph } from '../src/gitlog.js';
import { layoutGraph, relax } from '../src/layout3d.js';
import { buildSimilarEdges } from '../src/similar-commits.js';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Where remote clones land. Kept out of the served dir on purpose.
const CLONE_ROOT = join(tmpdir(), 'gengit3d-clones');

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--repo') out.repo = argv[++i];
        else if (a === '--out') out.out = argv[++i];
        else if (a === '--max') out.max = parseInt(argv[++i], 10);
        else if (a === '--port') out.port = parseInt(argv[++i], 10);
        else if (a === '--dir') out.dir = argv[++i];
        else if (a === '--relax') out.relax = true;
    }
    return out;
}

/** Build the graph for a repo dir: parse -> similar edges -> layout. */
async function makeGraph(repo, { max = 0, relax: doRelax = false } = {}) {
    const graph = await buildGraph(repo, { max });
    graph.similarEdges = buildSimilarEdges(graph);
    layoutGraph(graph);
    if (doRelax) relax(graph);
    return graph;
}

/** True when `dir` is (inside) a git working tree. */
async function isGitRepo(dir) {
    if (!dir || !existsSync(dir)) return false;
    try {
        await execFileP('git', ['rev-parse', '--git-dir'], { cwd: dir, timeout: 10000 });
        return true;
    } catch {
        return false;
    }
}

async function cmdParse(opts) {
    const repo = resolve(toNative(opts.repo) || process.cwd());
    console.log(`[gengit3d] parsing git log in ${repo} ...`);
    const graph = await makeGraph(repo, { max: opts.max || 0, relax: opts.relax });
    console.log(`[gengit3d] similarEdges=${graph.similarEdges.length}`);
    const outPath = opts.out ? resolve(opts.out) : join(repo, 'gengit3d.graph.json');
    await writeFile(outPath, JSON.stringify(graph));
    console.log(`[gengit3d] wrote ${outPath}`);
    console.log(`[gengit3d] commits=${graph.nodes.length} branches=${graph.branches.length} edges=${graph.edges.length} head=${graph.head?.slice(0, 7)}`);
    return outPath;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    res.end(body);
}

const ALLOWED_URL = /^(https?:\/\/|git:\/\/|ssh:\/\/|git@[\w.-]+:|file:\/\/)/i;

async function handleGraph(res, q) {
    const repo = resolve(toNative(q.get('repo') || ''));
    const max = parseInt(q.get('max') || '0', 10) || 0;
    if (!repo) return sendJson(res, 400, { error: 'missing ?repo=<path>' });
    if (!(await isGitRepo(repo))) return sendJson(res, 400, { error: `not a git repository: ${repo}` });
    try {
        const graph = await makeGraph(repo, { max });
        sendJson(res, 200, { ...graph, source: { kind: 'local', repo } });
    } catch (e) {
        sendJson(res, 500, { error: `parse failed: ${e.message}` });
    }
}

/** List directories under a root that are git working trees (for the UI picker). */
async function handleRepos(res, q) {
    const root = resolve(toNative(q.get('root') || '') || process.env.GENGIT3D_REPO || process.cwd());
    const depth = Math.min(3, Math.max(1, parseInt(q.get('depth') || '2', 10) || 2));
    const found = [];
    const seen = new Set();
    async function walk(dir, level) {
        if (level > depth || found.length >= 60 || seen.has(dir)) return;
        seen.add(dir);
        if (await isGitRepo(dir)) { found.push(dir); return; } // don't descend into a repo
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'jenkins_home') continue;
            await walk(join(dir, e.name), level + 1);
        }
    }
    try { await walk(root, 1); } catch { /* ignore */ }
    sendJson(res, 200, { root, repos: found });
}

async function handleClone(res, q) {
    const url = (q.get('url') || '').trim();
    const depth = Math.max(0, parseInt(q.get('depth') || '500', 10) || 0);
    const max = parseInt(q.get('max') || '0', 10) || 0;
    if (!url) return sendJson(res, 400, { error: 'missing ?url=<git-url>' });
    if (!ALLOWED_URL.test(url)) return sendJson(res, 400, { error: `unsupported url scheme: ${url}` });

    const name = basename(url.replace(/\.git$/, '')).replace(/[^\w.-]/g, '_') || 'repo';
    const dest = join(CLONE_ROOT, `${name}-${Date.now()}`);
    await mkdir(CLONE_ROOT, { recursive: true });
    const args = ['clone', '--quiet'];
    if (depth > 0) args.push('--depth', String(depth));
    args.push(url, dest);
    try {
        await execFileP('git', args, { timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
        return sendJson(res, 500, { error: `git clone failed: ${(e.stderr || e.message || '').toString().slice(0, 400)}` });
    }
    try {
        const graph = await makeGraph(dest, { max });
        sendJson(res, 200, { ...graph, source: { kind: 'clone', url, depth, repo: dest } });
    } catch (e) {
        sendJson(res, 500, { error: `parse failed: ${e.message}` });
    }
}

async function cmdServe(opts) {
    const dir = resolve(toNative(opts.dir) || ROOT);
    const port = opts.port || 8080;
    const server = http.createServer(async (req, res) => {
        const u = new URL(req.url, 'http://localhost');
        const pathname = u.pathname;

        // ── API ──
        if (pathname === '/api/graph') return handleGraph(res, u.searchParams);
        if (pathname === '/api/clone') return handleClone(res, u.searchParams);
        if (pathname === '/api/repos') return handleRepos(res, u.searchParams);

        // ── static ──
        let url = pathname === '/' ? '/index.html' : pathname;
        const filePath = join(dir, url);
        if (!filePath.startsWith(dir)) { res.writeHead(403); return res.end('forbidden'); }
        try {
            const data = await readFile(filePath);
            const ext = filePath.split('.').pop();
            const mime = {
                html: 'text/html', json: 'application/json', js: 'text/javascript',
                css: 'text/css', ico: 'image/x-icon', svg: 'image/svg+xml',
            }[ext] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
            res.end(data);
        } catch {
            res.writeHead(404); res.end('not found');
        }
    });
    server.listen(port, () => {
        console.log(`[gengit3d] serving ${dir} at http://localhost:${port}`);
        console.log(`[gengit3d] open http://localhost:${port}/ — enter a repo path or git URL to render it`);
        console.log(`[gengit3d] API: /api/graph?repo=<path>  |  /api/clone?url=<git-url>`);
    });
}

async function main() {
    const args = process.argv.slice(2);
    const cmd = args[0] || 'all';
    const opts = parseArgs(args.slice(1));
    if (cmd === 'parse') { await cmdParse(opts); return; }
    if (cmd === 'serve') { await cmdServe(opts); return; }
    if (cmd === 'clean') { await rm(CLONE_ROOT, { recursive: true, force: true }); console.log(`[gengit3d] removed ${CLONE_ROOT}`); return; }
    // 'all' / default: parse into ROOT then serve
    if (opts.repo) await cmdParse({ ...opts, out: join(ROOT, 'gengit3d.graph.json') });
    await cmdServe({ ...opts, dir: ROOT });
}

main().catch((e) => { console.error(e); process.exit(1); });
