// extension.ts — point d'entrée de l'extension GenGit3D (côté Node / Extension Host)
//
// Responsabilités :
//   - Enregistrer les commandes "GenGit3D: Open 3D Graph" et "Open 3D Graph for Current File"
//   - Parser le git log du workspace (ou du fichier courant)
//   - Créer un WebviewPanel et lui envoyer le graphe JSON
//   - Gérer les messages du webview (changement de thème, vue, repo, etc.)

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { buildGraph } from './gitlog.js';
import { layoutGraphForView } from './layout3d.js';
import { buildSimilarEdges } from './similar-commits.js';
import { THEMES, DEFAULT_THEME } from './themes.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function getConfig() {
    const cfg = vscode.workspace.getConfiguration('gengit3d');
    return {
        defaultView: cfg.get<string>('defaultView', 'topological'),
        defaultTheme: cfg.get<string>('defaultTheme', 'neon'),
        maxCommits: cfg.get<number>('maxCommits', 5000),
        autoRotate: cfg.get<boolean>('autoRotate', false),
        edgeOpacity: cfg.get<number | null>('edgeOpacity', null),
        nodeSize: cfg.get<number | null>('nodeSize', null),
        nodeSpacing: cfg.get<number | null>('nodeSpacing', null),
    };
}

/** Trouve le repo git racine à partir d'un chemin de fichier ou dossier. */
async function findRepoRoot(startPath: string): Promise<string | null> {
    const fs = await import('node:fs');
    const path = await import('node:path');

    let dir = startPath;
    try {
        if (!fs.statSync(dir).isDirectory()) {
            dir = path.dirname(dir);
        }
    } catch {
        // fsPath invalide (schéma non-file : git:, output:, vscode-userdata:…)
        return null;
    }

    while (true) {
        const gitDir = path.join(dir, '.git');
        if (fs.existsSync(gitDir)) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

/** Parse le graphe git d'un repo et le prépare pour le webview. */
async function parseRepo(repoDir: string, maxCommits: number, view: string, file?: string | null) {
    const graph = await buildGraph(repoDir, { max: maxCommits, file: file || undefined });
    graph.similarEdges = buildSimilarEdges(graph);
    layoutGraphForView(graph, view);
    graph.source = { kind: 'local', repo: repoDir, file: file || undefined };
    return graph;
}

const execFileP = promisify(execFile);
const SHA_RE = /^[0-9a-f]{4,40}$/i;
const MAX_PATCH = 60000;

/** Détails d'un commit (métadonnées + fichiers + patch tronqué), même format que GET /api/commit. */
async function getCommitDetails(repoDir: string, hash: string) {
    if (!SHA_RE.test(hash)) throw new Error(`invalid commit hash: ${hash}`);
    const git = (args: string[], maxBuffer = 64 * 1024 * 1024) =>
        execFileP('git', args, { cwd: repoDir, maxBuffer, timeout: 30000 }).then(r => r.stdout);

    const US = '\x1f';
    const fmt = ['%H', '%h', '%an', '%ae', '%ad', '%cn', '%ce', '%cd', '%s', '%b'].join(US);
    const meta = await git(['show', '-s', `--format=${fmt}`, '--date=iso-strict', hash]);
    const [full, short, author, email, date, committer, committerEmail, commitDate, subject, body] = meta.split(US);
    const parents = (await git(['show', '-s', '--format=%P', hash])).trim().split(/\s+/).filter(Boolean);
    const files = (await git(['show', '--numstat', '--format=', hash]))
        .split('\n')
        .filter(Boolean)
        .map(line => {
            const [add, del, ...rest] = line.split('\t');
            return {
                added: add === '-' ? null : parseInt(add, 10),
                deleted: del === '-' ? null : parseInt(del, 10),
                path: rest.join('\t'),
            };
        });
    let patch = await git(['show', '--patch', '--no-color', '--format=', hash], 128 * 1024 * 1024);
    const patchTruncated = patch.length > MAX_PATCH;
    if (patchTruncated) patch = patch.slice(0, MAX_PATCH);

    return {
        repo: repoDir,
        hash: full,
        short,
        author,
        email,
        date,
        committer,
        committerEmail,
        commitDate,
        subject,
        body: (body || '').trim(),
        parents,
        files,
        stats: {
            files: files.length,
            added: files.reduce((s, f) => s + (f.added || 0), 0),
            deleted: files.reduce((s, f) => s + (f.deleted || 0), 0),
        },
        patch,
        patchTruncated,
    };
}

/** Détails du working tree (uncommitted node) — même format que getCommitDetails. */
async function getWorkingTreeDetails(repoDir: string) {
    const git = (args: string[], maxBuffer = 64 * 1024 * 1024) =>
        execFileP('git', args, { cwd: repoDir, maxBuffer, timeout: 30000 }).then(r => r.stdout);

    const status = await git(['status', '--porcelain=v1', '-uall']);
    const numstat = await git(['diff', 'HEAD', '--numstat']).catch(() => '');
    const counts = new Map(
        numstat.split('\n').filter(Boolean).map(line => {
            const [a, d, ...rest] = line.split('\t');
            return [rest.join('\t'), { added: a === '-' ? null : parseInt(a, 10), deleted: d === '-' ? null : parseInt(d, 10) }];
        })
    );
    const files = status.split('\n').filter(Boolean).map(line => {
        const path = line.slice(3);
        return { path, status: line.slice(0, 2).trim(), ...(counts.get(path) ?? { added: null, deleted: null }) };
    });
    let patch = await git(['diff', 'HEAD', '--no-color'], 128 * 1024 * 1024).catch(() => '');
    const patchTruncated = patch.length > MAX_PATCH;
    if (patchTruncated) patch = patch.slice(0, MAX_PATCH);

    return {
        repo: repoDir,
        hash: 'uncommitted',
        short: '○',
        author: '(working tree)',
        email: '',
        date: new Date().toISOString(),
        committer: '',
        committerEmail: '',
        commitDate: '',
        subject: 'Uncommitted changes',
        body: '',
        parents: [],
        files,
        stats: {
            files: files.length,
            added: files.reduce((s, f) => s + (f.added || 0), 0),
            deleted: files.reduce((s, f) => s + (f.deleted || 0), 0),
        },
        patch,
        patchTruncated,
    };
}

/** Génère le HTML du webview avec le graphe injecté. */
function getWebviewContent(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    graph: any,
    config: ReturnType<typeof getConfig>
): string {
    const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js')
    );

    // CSP stricte : seuls les scripts portant le nonce s'exécutent, pas de requêtes externes
    const nonce = randomBytes(16).toString('base64');
    const csp = [
        `default-src 'none'`,
        `script-src ${webview.cspSource} 'nonce-${nonce}'`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `img-src ${webview.cspSource} data:`,
        `font-src ${webview.cspSource}`,
        `connect-src 'none'`,
    ].join('; ');

    const themeNames = Object.keys(THEMES);
    const viewNames = ['topological', 'chronological', 'author', 'radial', 'queue', 'real-branches'];

    // Sérialiser le graphe de façon sûre (échapper les </script>)
    // null → le webview demande le graphe via postMessage ('requestGraph')
    const graphJson = graph ? JSON.stringify(graph).replace(/<\/script>/gi, '<\\/script>') : 'null';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>GenGit3D</title>
  <style>
    :root {
      --bg: #0b0b10; --panel: #16171c; --border: #2a2c36; --text: #e0e0e0;
      --muted: #8b93a7; --accent: #4f9dff; --input: #0d0e12;
      --btn: #2a3550; --btn-border: #3a4a70; --btn-text: #dbe6ff;
      --overlay: #000000aa; --err: #e05c75; --busy: #f2c14e;
      --diff-add: #7ee787; --diff-del: #ff7b72; --diff-hunk: #79c0ff;
    }
    html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; overflow: hidden; }
    #app { position: fixed; inset: 0; }
    #gengit3d-topwrap { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); z-index: 6; display: flex; flex-direction: column; align-items: center; gap: 8px; max-width: 96vw; pointer-events: none; }
    #gengit3d-bar { display: flex; gap: 4px; align-items: center; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 5px 8px; box-shadow: 0 6px 22px #0006; flex-wrap: wrap; max-width: 96vw; justify-content: center; backdrop-filter: blur(10px); pointer-events: auto; }
    #gengit3d-bar .brand { display: flex; align-items: center; padding: 0 3px; user-select: none; }
    #gengit3d-bar .group { display: flex; gap: 4px; align-items: center; }
    #gengit3d-bar .sep { width: 1px; align-self: stretch; background: var(--border); margin: 0 4px; }
    #gengit3d-author-wrap { display: contents; }
    #gengit3d-bar select, #gengit3d-bar button { height: 24px; box-sizing: border-box; background: var(--input); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 0 8px; font: 11px monospace; cursor: pointer; transition: border-color .12s ease, background .12s ease; }
    #gengit3d-bar select:hover, #gengit3d-bar button:hover { border-color: var(--accent); background: var(--btn); }
    #gengit3d-bar select:focus, #gengit3d-bar button:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
    #gengit3d-bar .icon-btn { width: 26px; padding: 0; text-align: center; flex-shrink: 0; }
    #gengit3d-bar label { font: 10px monospace; color: var(--muted); white-space: nowrap; display: flex; align-items: center; gap: 5px; }
    #gengit3d-bar input[type="checkbox"] { accent-color: var(--accent); margin: 0; }
    #gengit3d-bar input[type="range"] { accent-color: var(--accent); width: 72px; cursor: pointer; margin: 0; }
    #gengit3d-bar .val { font: 10px monospace; color: var(--muted); min-width: 30px; text-align: right; }
    #gengit3d-bar.collapsed > *:not(#gengit3d-bar-toggle) { display: none; }
    #gengit3d-stats { position: fixed; bottom: 34px; left: 10px; font: 12px monospace; background: var(--overlay); color: var(--text); padding: 6px 10px; border-radius: 6px; z-index: 5; border: 1px solid var(--border); }
    #gengit3d-now { position: fixed; bottom: 64px; left: 10px; font: 11px monospace; background: var(--overlay); color: var(--text); padding: 5px 10px; border-radius: 6px; z-index: 5; border: 1px solid var(--border); max-width: 60vw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #gengit3d-subtitle { position: fixed; bottom: 66px; left: 50%; transform: translateX(-50%); font: 12px monospace; background: var(--panel); color: var(--text); padding: 5px 14px; border-radius: 8px; z-index: 6; border: 1px solid var(--border); max-width: 80vw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: 0 4px 16px #0006; display: none; }
    #gengit3d-filebadge { position: fixed; bottom: 62px; left: 10px; font: 12px monospace; background: var(--overlay); color: var(--accent); padding: 5px 10px; border-radius: 6px; z-index: 5; border: 1px solid var(--accent); }
    #gengit3d-filebadge b { color: var(--text); }
    #gengit3d-filebadge #gengit3d-clearfile { cursor: pointer; margin-left: 8px; opacity: .7; }
    #gengit3d-filebadge #gengit3d-clearfile:hover { opacity: 1; }
    #gengit3d-status { font: 11px monospace; color: var(--muted); background: var(--overlay); padding: 4px 10px; border-radius: 5px; max-width: 90vw; }
    #gengit3d-status.busy { color: var(--busy); }
    #gengit3d-status.err { color: var(--err); }
    #gengit3d-help { position: fixed; bottom: 10px; left: 10px; font: 11px monospace; color: var(--muted); z-index: 5; }
    #gengit3d-loading { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; font: 16px monospace; color: var(--muted); z-index: 4; text-align: center; padding: 0 20px; }
    #gengit3d-scrub { position: fixed; bottom: 10px; left: 50%; transform: translateX(-50%); z-index: 6; display: flex; gap: 8px; align-items: center; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 6px 12px; box-shadow: 0 6px 22px #0006; backdrop-filter: blur(10px); }
    #gengit3d-scrub button { height: 24px; background: var(--input); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 0 10px; font: 12px monospace; cursor: pointer; }
    #gengit3d-scrub button:hover { border-color: var(--accent); background: var(--btn); }
    #gengit3d-scrub input[type="range"] { width: 220px; accent-color: var(--accent); cursor: pointer; }
    #gengit3d-scrub input[type="date"] { background: var(--input); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 1px 4px; font: 11px monospace; color-scheme: dark; width: 112px; }
    #gengit3d-scrub input[type="date"]:disabled { opacity: 0.4; }
    #gengit3d-scrub .scrub-opt { display: flex; align-items: center; gap: 3px; font: 11px monospace; color: var(--muted); cursor: pointer; }
    #gengit3d-scrub .scrub-opt input { margin: 0; accent-color: var(--accent); cursor: pointer; }
    #gengit3d-scrub .scrub-speed { background: var(--input); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 1px 4px; font: 11px monospace; cursor: pointer; }
    #gengit3d-scrub span { font: 11px monospace; color: var(--muted); min-width: 90px; text-align: center; }
    .err { color: var(--err); }
    #gengit3d-legend { position: fixed; top: 0; left: 0; height: 100%; width: 280px; max-width: 80vw; background: var(--panel); border-right: 1px solid var(--border); z-index: 7; display: flex; flex-direction: column; transform: translateX(-100%); transition: transform .18s ease; box-shadow: 6px 0 24px #0004; }
    #gengit3d-legend.open { transform: translateX(0); }
    #gengit3d-legend header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--border); }
    #gengit3d-legend header .h { font: 12px monospace; color: var(--muted); }
    #gengit3d-legend header button { background: transparent; color: var(--text); border: 1px solid var(--border); border-radius: 5px; padding: 3px 9px; font: 12px monospace; cursor: pointer; }
    #gengit3d-legend .search { padding: 8px 12px; border-bottom: 1px solid var(--border); }
    #gengit3d-legend .search input { width: 100%; background: var(--input); color: var(--text); border: 1px solid var(--border); border-radius: 5px; padding: 5px 8px; font: 11px monospace; outline: none; box-sizing: border-box; }
    #gengit3d-legend .bulk { display: flex; gap: 6px; padding: 6px 12px; border-bottom: 1px solid var(--border); }
    #gengit3d-legend .bulk button { flex: 1; background: var(--btn); color: var(--btn-text); border: 1px solid var(--btn-border); border-radius: 4px; padding: 4px 6px; font: 10px monospace; cursor: pointer; }
    #gengit3d-legend .list { overflow-y: auto; flex: 1; padding: 4px 0; }
    #gengit3d-legend .list .item { display: flex; align-items: center; gap: 6px; padding: 3px 12px; font: 11px monospace; cursor: pointer; }
    #gengit3d-legend .list .item:hover { background: var(--input); }
    #gengit3d-legend .list .item input[type="checkbox"] { margin: 0; accent-color: var(--accent); }
    #gengit3d-legend .list .item .swatch { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; }
    #gengit3d-legend .list .item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); cursor: pointer; }
    #gengit3d-legend .list .item .name:hover { text-decoration: underline; }
    #gengit3d-legend .list .item .count { color: var(--muted); font-size: 10px; }
    #gengit3d-legend .list .item .checkout { background: transparent; border: none; color: var(--accent); cursor: pointer; font: 12px monospace; padding: 0 3px; visibility: hidden; }
    #gengit3d-legend .list .item:hover .checkout { visibility: visible; }
    #gengit3d-legend .list .item .checkout:hover { filter: brightness(1.3); }
    #gengit3d-legend .list .item .current-badge { color: var(--accent); font-size: 10px; padding: 0 3px; }
    #gengit3d-detail .files .st { color: var(--busy); min-width: 20px; flex-shrink: 0; }
    #gengit3d-legend .list .item.hidden-branch .name { text-decoration: line-through; opacity: 0.5; }
    #gengit3d-legend .list .item.hidden-branch .swatch { opacity: 0.3; }
    #gengit3d-legend .empty { color: var(--muted); font: 11px monospace; padding: 12px; }
    #gengit3d-detail { position: fixed; top: 0; right: 0; height: 100%; width: 420px; max-width: 92vw; background: var(--panel); border-left: 1px solid var(--border); z-index: 7; display: flex; flex-direction: column; transform: translateX(100%); transition: transform .18s ease; box-shadow: -6px 0 24px #0004; }
    #gengit3d-detail.open { transform: translateX(0); }
    #gengit3d-detail header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--border); }
    #gengit3d-detail header .h { font: 12px monospace; color: var(--muted); }
    #gengit3d-detail header button { background: transparent; color: var(--text); border: 1px solid var(--border); border-radius: 5px; padding: 3px 9px; font: 12px monospace; cursor: pointer; }
    #gengit3d-detail .body { overflow: auto; padding: 12px; flex: 1; }
    #gengit3d-detail h2 { font: 14px/1.4 monospace; margin: 0 0 8px; color: var(--text); }
    #gengit3d-detail .meta { font: 11px/1.7 monospace; color: var(--muted); margin-bottom: 10px; }
    #gengit3d-detail .meta b { color: var(--text); font-weight: 600; }
    #gengit3d-detail .stat { font: 11px monospace; margin: 8px 0; color: var(--text); }
    #gengit3d-detail .files { list-style: none; padding: 0; margin: 6px 0 12px; }
    #gengit3d-detail .files li { font: 11px monospace; display: flex; gap: 8px; padding: 2px 0; border-bottom: 1px dashed var(--border); }
    #gengit3d-detail .files .p { flex: 1; word-break: break-all; color: var(--text); }
    #gengit3d-detail .files .a { color: var(--diff-add); }
    #gengit3d-detail .files .d { color: var(--diff-del); }
    #gengit3d-detail pre.diff { font: 11px/1.45 monospace; white-space: pre-wrap; word-break: break-word; margin: 0; padding: 8px; background: var(--input); border: 1px solid var(--border); border-radius: 6px; max-height: 46vh; overflow: auto; }
    #gengit3d-detail pre.diff .add { color: var(--diff-add); }
    #gengit3d-detail pre.diff .del { color: var(--diff-del); }
    #gengit3d-detail pre.diff .hunk { color: var(--diff-hunk); }
    #gengit3d-detail .msg { font: 11px/1.6 monospace; white-space: pre-wrap; color: var(--text); background: var(--input); border: 1px solid var(--border); border-radius: 6px; padding: 8px; margin-bottom: 10px; }
    #gengit3d-detail .empty { color: var(--muted); font: 12px monospace; }
  </style>
</head>
<body>
  <div id="app"></div>

  <div id="gengit3d-topwrap">
  <div id="gengit3d-bar">
    <button id="gengit3d-bar-toggle" class="icon-btn" title="collapse/expand the toolbar">–</button>
    <svg class="brand" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="3" r="2.4" fill="var(--accent)"/><circle cx="4" cy="13" r="2.4" fill="var(--accent)" opacity=".65"/><circle cx="12" cy="13" r="2.4" fill="var(--accent)" opacity=".65"/><path d="M8 5.4v3M8 8.4 4.7 11M8 8.4l3.3 2.6" stroke="var(--accent)" stroke-width="1.2" fill="none"/></svg>
    <div class="sep"></div>
    <div class="group">
      <select id="gengit3d-view" title="graph layout view">
        ${viewNames.map(v => `<option value="${v}">${v}</option>`).join('\n        ')}
      </select>
      <select id="gengit3d-theme" title="colour theme">
        ${themeNames.map(t => `<option value="${t}">${THEMES[t].label}</option>`).join('\n        ')}
      </select>
      <select id="gengit3d-colors" title="node colouring — branch palette / author hash / commit age (blue=old, orange=recent)">
        <option value="branch">colors: branch</option>
        <option value="author">colors: author</option>
        <option value="age">colors: age</option>
      </select>
    </div>
    <div class="sep"></div>
    <div class="group">
      <select id="gengit3d-branch" title="isolate a single branch">
        <option value="">all branches</option>
      </select>
      <span id="gengit3d-author-wrap" style="display:none">
        <select id="gengit3d-author" title="isolate a single author">
          <option value="">all authors</option>
        </select>
      </span>
    </div>
    <div class="sep"></div>
    <div class="group">
      <label title="opacity of the links between commits">edges <input id="gengit3d-edge-opacity" type="range" min="5" max="100" step="5" value="70" /> <span id="gengit3d-edge-opacity-val" class="val">70%</span></label>
      <label title="commit sphere size">nodes <input id="gengit3d-node-size" type="range" min="20" max="300" step="10" value="100" /> <span id="gengit3d-node-size-val" class="val">100%</span></label>
      <label title="space between commits along the timeline">space <input id="gengit3d-spacing" type="range" min="25" max="800" step="5" value="100" /> <span id="gengit3d-spacing-val" class="val">100%</span></label>
    </div>
    <div class="sep"></div>
    <div class="group">
      <select id="gengit3d-fit-mode" title="camera framing — animated fly-to">
        <option value="">fit ▸</option>
        <option value="visible">visible</option>
        <option value="all">all</option>
        <option value="selection">selection</option>
        <option value="top">top</option>
        <option value="front">front</option>
        <option value="side">side</option>
        <option value="iso">iso</option>
      </select>
      <select id="gengit3d-fx" title="post-processing effect — legibility first">
        <option value="none">fx: off</option>
        <option value="bloom">fx: bloom</option>
        <option value="trails">fx: trails</option>
        <option value="fxaa">fx: antialias</option>
        <option value="sharpen">fx: sharpen</option>
        <option value="vignette">fx: vignette</option>
        <option value="contrast">fx: contrast+</option>
        <option value="tiltshift">fx: tilt-shift</option>
        <option value="bokeh">fx: depth of field</option>
      </select>
      <label title="rotate the view automatically"><input id="gengit3d-rotate" type="checkbox" /> rotate</label>
      <label title="always-on labels for merges and tags (nearest ~24)"><input id="gengit3d-labels" type="checkbox" /> labels</label>
      <label title="last commit of every branch — branch name + hash + subject"><input id="gengit3d-tips" type="checkbox" checked /> tips</label>
      <button id="gengit3d-fit" class="icon-btn" title="frame the visible commits">⌂</button>
    </div>
    <div class="sep"></div>
    <div class="group">
      <button id="gengit3d-legend-toggle" title="show/hide branch legend">Branches</button>
      <button id="gengit3d-split" class="icon-btn" title="duplicate this view into a new column — each panel keeps its own view &amp; selection">⧉</button>
      <button id="gengit3d-refresh" class="icon-btn" title="re-parse the repo">↻</button>
    </div>
  </div>
  <div id="gengit3d-status"></div>
  </div>

  <div id="gengit3d-filebadge" style="display:none"></div>
  <div id="gengit3d-now" style="display:none"></div>
  <div id="gengit3d-subtitle"></div>
  <div id="gengit3d-stats">loading…</div>
  <div id="gengit3d-help">drag: rotate · scroll: zoom · right-drag: pan · click a commit: details + zoom · click a branch name: solo · shapes: ● commit ◆ merge ▲ root ■ uncommitted ◇ ref tip</div>
  <div id="gengit3d-loading">loading graph…</div>

  <div id="gengit3d-scrub">
    <button id="gengit3d-play" title="play the history movie — camera follows the playhead">▶</button>
    <input id="gengit3d-scrubber" type="range" min="0" max="1000" value="1000" title="history timeline — drag to explore a period" />
    <label class="scrub-opt" title="camera follows the playhead during playback"><input id="gengit3d-cam" type="checkbox" checked />cam</label>
    <select id="gengit3d-speed" title="playback speed" class="scrub-speed"><option value="0.25">¼×</option><option value="0.5">½×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select>
    <span id="gengit3d-scrub-date"></span>
    <input id="gengit3d-from" type="date" title="period start" />
    <input id="gengit3d-to" type="date" title="period end" />
    <button id="gengit3d-mark-in" title="set period start at playhead">[</button>
    <button id="gengit3d-mark-out" title="set period end at playhead">]</button>
    <button id="gengit3d-clear-period" title="clear period">✕</button>
  </div>

  <aside id="gengit3d-legend">
    <header>
      <span class="h">branches</span>
      <button id="gengit3d-legend-close" title="close">✕</button>
    </header>
    <div class="search">
      <input id="gengit3d-legend-search" type="text" placeholder="filter branches…" spellcheck="false" />
    </div>
    <div class="bulk">
      <button id="gengit3d-legend-all">All</button>
      <button id="gengit3d-legend-none">None</button>
      <button id="gengit3d-legend-top">Top 10</button>
    </div>
    <div class="list" id="gengit3d-legend-list"><div class="empty">No graph loaded.</div></div>
  </aside>

  <aside id="gengit3d-detail">
    <header>
      <span class="h">commit details</span>
      <button id="gengit3d-detail-close" title="close">✕</button>
    </header>
    <div class="body" id="gengit3d-detail-body"><div class="empty">Click a commit sphere to see its details.</div></div>
  </aside>

  <script nonce="${nonce}">
    // Données injectées par l'extension host
    window.__GENGIT3D_GRAPH__ = ${graphJson};
    window.__GENGIT3D_CONFIG__ = ${JSON.stringify({ ...config, themeNames, viewNames })};
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

// ── Vue latérale (Activity Bar) ───────────────────────────────────────────────

class SidebarProvider implements vscode.WebviewViewProvider {
    resolveWebviewView(view: vscode.WebviewView) {
        view.webview.options = { enableScripts: true };

        const nonce = randomBytes(16).toString('base64');
        const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`;

        view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); padding: 10px 12px; }
    h2 { font-size: 13px; font-weight: 600; margin: 0 0 4px; }
    .desc { color: var(--vscode-descriptionForeground); margin: 0 0 12px; line-height: 1.4; }
    button {
      display: block; width: 100%; margin-bottom: 8px; padding: 6px 10px; border: none; border-radius: 3px;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      font-family: inherit; font-size: 12px; cursor: pointer; text-align: center;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .hint { margin-top: 14px; font-size: 11px; line-height: 1.5; color: var(--vscode-descriptionForeground); }
    .hint code { font-size: 10px; }
  </style>
</head>
<body>
  <h2>3D git commit graph</h2>
  <p class="desc">Explore your repository history as an interactive 3D scene.</p>
  <button id="open">Open 3D Graph</button>
  <button id="openFile" class="secondary">Graph for Current File</button>
  <p class="hint">
    Also available via <code>Ctrl+Shift+P</code> → "GenGit3D", the status-bar
    button (bottom-left), the Source Control title bar, and right-click menus.
  </p>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('open').addEventListener('click', () => vscode.postMessage({ type: 'open' }));
    document.getElementById('openFile').addEventListener('click', () => vscode.postMessage({ type: 'openFile' }));
  </script>
</body>
</html>`;

        view.webview.onDidReceiveMessage(msg => {
            if (msg?.type === 'open') {
                vscode.commands.executeCommand('gengit3d.open');
            } else if (msg?.type === 'openFile') {
                vscode.commands.executeCommand('gengit3d.openFile');
            }
        });
    }
}

// ── Activation ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    const cfg = getConfig();

    // ── Status bar button (comme GitGraph) ────────────────────────────────────
    const statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100  // priorité (à gauche)
    );
    statusBarItem.name = 'GenGit3D';
    statusBarItem.text = '$(graph) GenGit3D';
    statusBarItem.tooltip = 'Open GenGit3D — 3D git commit graph';
    statusBarItem.command = 'gengit3d.open';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // ── Vue latérale dans l'Activity Bar (point d'entrée visible) ────────────
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'gengit3d.sidebar',
            new SidebarProvider(),
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // Commande : ouvrir le graphe 3D (workspace courant)
    const openCmd = vscode.commands.registerCommand('gengit3d.open', async (uri?: vscode.Uri) => {
        try {
        // N'accepter que les URIs file:// — activeTextEditor peut être un
        // schéma non-fichier (git:, output:, vscode-userdata:…) dont le fsPath
        // est invalide et ferait échouer silencieusement statSync.
        const asFile = (u?: vscode.Uri) => (u && u.scheme === 'file' ? u : undefined);
        let targetUri = asFile(uri)
            || asFile(vscode.window.activeTextEditor?.document.uri)
            || vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!targetUri) {
            // Rien d'ouvert : proposer un sélecteur de dossier plutôt qu'une erreur
            const picked = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                openLabel: 'Visualize in 3D',
                title: 'GenGit3D — pick a git repository folder',
            });
            targetUri = picked?.[0];
            if (!targetUri) return;
        }

        const repoDir = await findRepoRoot(targetUri.fsPath);
        if (!repoDir) {
            vscode.window.showErrorMessage(`GenGit3D: no git repository found above ${targetUri.fsPath}`);
            return;
        }

        await openGraphPanel(context, repoDir);
        } catch (err: any) {
            // Ne jamais laisser une commande échouer silencieusement
            vscode.window.showErrorMessage(`GenGit3D: ${err.message || err}`);
        }
    });

    // Commande : historique 3D d'un fichier (éditeur courant ou uri passée
    // par un menu contextuel — explorer, onglet d'éditeur, etc.)
    const openFileHistory = async (uri?: vscode.Uri) => {
        try {
        const u = uri && uri.scheme === 'file' ? uri : vscode.window.activeTextEditor?.document.uri;
        if (!u || u.scheme !== 'file') {
            vscode.window.showErrorMessage('GenGit3D: no file selected for history.');
            return;
        }

        const repoDir = await findRepoRoot(u.fsPath);
        if (!repoDir) {
            vscode.window.showErrorMessage(`GenGit3D: no git repository found above ${u.fsPath}`);
            return;
        }

        const rel = path.relative(repoDir, u.fsPath).split(path.sep).join('/');
        if (rel.startsWith('..')) {
            vscode.window.showErrorMessage('GenGit3D: file is outside the repository.');
            return;
        }

        await openGraphPanel(context, repoDir, { file: rel });
        } catch (err: any) {
            vscode.window.showErrorMessage(`GenGit3D: ${err.message || err}`);
        }
    };

    const openFileCmd = vscode.commands.registerCommand('gengit3d.openFile', async () => {
        await openFileHistory();
    });

    const fileHistoryCmd = vscode.commands.registerCommand('gengit3d.fileHistory', async (uri?: vscode.Uri) => {
        await openFileHistory(uri);
    });

    context.subscriptions.push(openCmd, openFileCmd, fileHistoryCmd);
}

async function openGraphPanel(
    context: vscode.ExtensionContext,
    repoDir: string,
    opts: { column?: vscode.ViewColumn; seedView?: string; seedTheme?: string; file?: string } = {}
) {
    const cfg = getConfig();
    // Vue/thème "seeds" : un clone (bouton ⧉) démarre sur les réglages du
    // panneau source, ensuite chaque panneau vit sa vie (vue, filtres…).
    const seedView = opts.seedView || cfg.defaultView;
    const seedTheme = opts.seedTheme || cfg.defaultTheme;
    const cfgForWebview = { ...cfg, defaultView: seedView, defaultTheme: seedTheme };
    // Mode historique de fichier : le titre porte le nom du fichier
    let panelFile = opts.file || null;
    const fileBase = panelFile ? panelFile.split('/').pop() : null;
    const titleFor = (view: string) => (fileBase ? `GenGit3D — ${fileBase} · ${view}` : `GenGit3D — ${view}`);

    const panel = vscode.window.createWebviewPanel(
        'gengit3d',
        titleFor(seedView),
        opts.column ?? vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
        }
    );

    // Afficher la coquille UI immédiatement (graphe null → "waiting for graph data…")
    // puis livrer le graphe via postMessage une fois parsé — évite un panneau
    // noir "gelé" pendant le parse sur les gros repos.
    panel.webview.html = getWebviewContent(panel.webview, context.extensionUri, null, cfgForWebview);
    let currentView = seedView;

    const initialGraph = parseRepo(repoDir, cfg.maxCommits, seedView, panelFile);
    // Évite un rejet non géré si le webview ne demande jamais le graphe
    initialGraph.catch(() => {});

    // Gérer les messages du webview
    panel.webview.onDidReceiveMessage(async (msg) => {
        switch (msg.type) {
            case 'ready': {
                // Le webview est prêt, on peut envoyer des mises à jour si nécessaire
                break;
            }
            case 'requestGraph': {
                // Le webview demande le graphe (toujours, maintenant : l'injection
                // inline envoie null et le graphe arrive par postMessage une fois
                // le parse terminé — pas de panneau noir pendant le git log)
                try {
                    const graph = await initialGraph;
                    panel.webview.postMessage({ type: 'graphData', graph, config: { ...cfgForWebview, themeNames: Object.keys(THEMES), viewNames: ['topological', 'chronological', 'author', 'radial', 'queue', 'real-branches'] } });
                } catch (err: any) {
                    panel.webview.postMessage({ type: 'error', message: err.message });
                }
                break;
            }
            case 'changeView': {
                // Le webview re-layout déjà côté client (x/y/z seulement) — on
                // mémorise juste la vue pour qu'un 'refresh' la conserve.
                currentView = msg.view;
                // L'onglet reflète la vue du panneau — indispensable avec
                // plusieurs panneaux ouverts côte à côte (split ⧉).
                panel.title = titleFor(msg.view);
                break;
            }
            case 'split': {
                // Clone du panneau dans la colonne d'à côté : même repo, même
                // vue et thème ; ensuite les deux panneaux sont indépendants
                // (vues différentes, sélections branches/auteurs séparées).
                try {
                    await openGraphPanel(context, repoDir, {
                        column: vscode.ViewColumn.Beside,
                        seedView: msg.view,
                        seedTheme: msg.theme,
                        file: msg.file || panelFile || undefined,
                    });
                } catch (err: any) {
                    panel.webview.postMessage({ type: 'error', message: `split failed: ${err.message || err}` });
                }
                break;
            }
            case 'clearFile': {
                // Quitter le mode historique de fichier → re-parse complet
                panelFile = null;
                try {
                    const newGraph = await parseRepo(repoDir, cfg.maxCommits, currentView, null);
                    panel.title = titleFor(currentView);
                    panel.webview.postMessage({ type: 'updateGraph', graph: newGraph });
                } catch (err: any) {
                    panel.webview.postMessage({ type: 'error', message: err.message });
                }
                break;
            }
            case 'setEdgeOpacity': {
                // Persiste le réglage du slider dans les settings utilisateur
                if (typeof msg.value === 'number' && msg.value > 0 && msg.value <= 1) {
                    await vscode.workspace
                        .getConfiguration('gengit3d')
                        .update('edgeOpacity', msg.value, vscode.ConfigurationTarget.Global);
                }
                break;
            }
            case 'setNodeSize': {
                if (typeof msg.value === 'number' && msg.value > 0 && msg.value <= 3) {
                    await vscode.workspace
                        .getConfiguration('gengit3d')
                        .update('nodeSize', msg.value, vscode.ConfigurationTarget.Global);
                }
                break;
            }
            case 'setSpacing': {
                if (typeof msg.value === 'number' && msg.value >= 0.25 && msg.value <= 8) {
                    await vscode.workspace
                        .getConfiguration('gengit3d')
                        .update('nodeSpacing', msg.value, vscode.ConfigurationTarget.Global);
                }
                break;
            }
            case 'changeTheme': {
                // Le thème est géré côté webview (pas de re-parse nécessaire)
                break;
            }
            case 'refresh': {
                // Re-parser le repo
                try {
                    const newGraph = await parseRepo(repoDir, cfg.maxCommits, currentView, panelFile);
                    panel.webview.postMessage({ type: 'updateGraph', graph: newGraph });
                } catch (err: any) {
                    panel.webview.postMessage({ type: 'error', message: err.message });
                }
                break;
            }
            case 'checkout': {
                // Checkout d'une branche locale (bouton ⎇ dans la légende)
                const name = String(msg.branch || '');
                if (!/^\w[\w.\-/]*$/.test(name) || name.includes('..')) {
                    panel.webview.postMessage({ type: 'error', message: `invalid branch name: ${name}` });
                    break;
                }
                try {
                    await execFileP('git', ['switch', name], { cwd: repoDir, timeout: 30000 });
                    const newGraph = await parseRepo(repoDir, cfg.maxCommits, currentView, panelFile);
                    panel.webview.postMessage({ type: 'updateGraph', graph: newGraph });
                } catch (err: any) {
                    panel.webview.postMessage({ type: 'error', message: err.stderr || err.message });
                }
                break;
            }
            case 'getCommitDetails': {
                // Toujours le repo du panel : on ne fait pas confiance au chemin envoyé par le webview
                try {
                    const data = msg.hash === 'uncommitted'
                        ? await getWorkingTreeDetails(repoDir)
                        : await getCommitDetails(repoDir, String(msg.hash || ''));
                    panel.webview.postMessage({ type: 'commitDetails', data });
                } catch (err: any) {
                    panel.webview.postMessage({ type: 'commitDetails', data: null });
                    panel.webview.postMessage({ type: 'error', message: err.message });
                }
                break;
            }
            case 'showCommit': {
                // Afficher un commit dans le détail (déjà géré côté webview)
                break;
            }
            case 'openFile': {
                // Ouvrir un fichier dans l'éditeur
                if (msg.filePath) {
                    const doc = await vscode.workspace.openTextDocument(msg.filePath);
                    await vscode.window.showTextDocument(doc);
                }
                break;
            }
        }
    }, undefined, context.subscriptions);
}

export function deactivate() {}
