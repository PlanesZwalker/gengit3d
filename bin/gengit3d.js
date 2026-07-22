#!/usr/bin/env node
// bin/gengit3d.js — CLI for GenGit3D.
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
//   serve  : static server hosting index.html + graph.json
//   (no args) : parse then serve
//
// Usage:
//   node bin/gengit3d.js parse  [--repo <dir>] [--out graph.json] [--max N]
//   node bin/gengit3d.js serve  [--port 8080] [--dir .]
//   node bin/gengit3d.js        [--repo <dir>]

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import http from 'node:http';
import { buildGraph } from '../src/gitlog.js';
import { layoutGraph, relax } from '../src/layout3d.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

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

async function cmdParse(opts) {
  const repo = resolve(toNative(opts.repo) || process.cwd());
  console.log(`[gengit3d] parsing git log in ${repo} ...`);
  const graph = await buildGraph(repo, { max: opts.max || 0 });
  layoutGraph(graph);
  if (opts.relax) relax(graph);
  // strip heavy fields for browser? keep nodes lightweight
  const outPath = opts.out ? resolve(opts.out) : join(repo, 'gengit3d.graph.json');
  await writeFile(outPath, JSON.stringify(graph));
  console.log(`[gengit3d] wrote ${outPath}`);
  console.log(`[gengit3d] commits=${graph.nodes.length} branches=${graph.branches.length} edges=${graph.edges.length} head=${graph.head?.slice(0,7)}`);
  return outPath;
}

async function cmdServe(opts) {
  const dir = resolve(toNative(opts.dir) || ROOT);
  const port = opts.port || 8080;
  const server = http.createServer(async (req, res) => {
    let url = req.url.split('?')[0];
    if (url === '/') url = '/index.html';
    const filePath = join(dir, url);
    // prevent path traversal
    if (!filePath.startsWith(dir)) { res.writeHead(403); return res.end('forbidden'); }
    try {
      const data = await readFile(filePath);
      const ext = filePath.split('.').pop();
      const mime = {
        html: 'text/html', json: 'application/json', js: 'text/javascript',
        css: 'text/css', ico: 'image/x-icon',
      }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    } catch {
      res.writeHead(404); res.end('not found — run `gengit3d parse` first to generate gengit3d.graph.json');
    }
  });
  server.listen(port, () => {
    console.log(`[gengit3d] serving ${dir} at http://localhost:${port}`);
    console.log(`[gengit3d] open http://localhost:${port}/ to view the 3D git graph`);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'all';
  const opts = parseArgs(args.slice(1));
  if (cmd === 'parse') { await cmdParse(opts); return; }
  if (cmd === 'serve') { await cmdServe(opts); return; }
  // 'all' / default: parse into ROOT then serve
  const outPath = await cmdParse({ ...opts, out: join(ROOT, 'gengit3d.graph.json') });
  await cmdServe({ ...opts, dir: ROOT });
}

main().catch((e) => { console.error(e); process.exit(1); });
