// extension.ts — point d'entrée de l'extension GenGit3D (côté Node / Extension Host)
//
// Responsabilités :
//   - Enregistrer les commandes "GenGit3D: Open 3D Graph" et "Open 3D Graph for Current File"
//   - Parser le git log du workspace (ou du fichier courant)
//   - Créer un WebviewPanel et lui envoyer le graphe JSON
//   - Gérer les messages du webview (changement de thème, vue, repo, etc.)

import * as vscode from 'vscode';
import { buildGraph } from './gitlog.js';
import { layoutGraphForView } from './layout3d.js';
import { buildSimilarEdges } from './similar-commits.js';
import { THEMES, DEFAULT_THEME } from './themes.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function getConfig() {
    const cfg = vscode.workspace.getConfiguration('gengit3d');
    return {
        defaultView: cfg.get<string>('defaultView', 'topological'),
        defaultTheme: cfg.get<string>('defaultTheme', 'daylight'),
        maxCommits: cfg.get<number>('maxCommits', 5000),
        autoRotate: cfg.get<boolean>('autoRotate', false),
    };
}

/** Trouve le repo git racine à partir d'un chemin de fichier ou dossier. */
async function findRepoRoot(startPath: string): Promise<string | null> {
    const fs = await import('node:fs');
    const path = await import('node:path');

    let dir = startPath;
    if (!fs.statSync(dir).isDirectory()) {
        dir = path.dirname(dir);
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
async function parseRepo(repoDir: string, maxCommits: number, view: string) {
    const graph = await buildGraph(repoDir, { max: maxCommits });
    graph.similarEdges = buildSimilarEdges(graph);
    layoutGraphForView(graph, view);
    return graph;
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

    // CSP stricte : pas de scripts inline, pas de requêtes externes
    const csp = [
        `default-src 'none'`,
        `script-src ${webview.cspSource}`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `img-src ${webview.cspSource} data:`,
        `font-src ${webview.cspSource}`,
        `connect-src 'none'`,
    ].join('; ');

    const themeNames = Object.keys(THEMES);
    const viewNames = ['topological', 'chronological', 'author', 'radial', 'queue', 'real-branches'];

    // Sérialiser le graphe de façon sûre (échapper les </script>)
    const graphJson = JSON.stringify(graph).replace(/<\/script>/gi, '<\\/script>');

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
    #gengit3d-bar { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); z-index: 6; display: flex; gap: 6px; align-items: center; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 6px; box-shadow: 0 4px 18px #0004; flex-wrap: wrap; max-width: 95vw; }
    #gengit3d-bar select, #gengit3d-bar button { background: var(--input); color: var(--text); border: 1px solid var(--border); border-radius: 5px; padding: 6px 9px; font: 12px monospace; cursor: pointer; }
    #gengit3d-bar button:hover { filter: brightness(1.12); }
    #gengit3d-bar label { font: 11px monospace; color: var(--muted); }
    #gengit3d-bar input[type="checkbox"] { accent-color: var(--accent); }
    #gengit3d-stats { position: fixed; top: 10px; left: 10px; font: 12px monospace; background: var(--overlay); color: var(--text); padding: 6px 10px; border-radius: 6px; z-index: 5; border: 1px solid var(--border); }
    #gengit3d-status { position: fixed; top: 58px; left: 50%; transform: translateX(-50%); z-index: 6; font: 11px monospace; color: var(--muted); background: var(--overlay); padding: 4px 10px; border-radius: 5px; max-width: 90vw; }
    #gengit3d-status.busy { color: var(--busy); }
    #gengit3d-status.err { color: var(--err); }
    #gengit3d-help { position: fixed; bottom: 10px; left: 10px; font: 11px monospace; color: var(--muted); z-index: 5; }
    #gengit3d-loading { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; font: 16px monospace; color: var(--muted); z-index: 4; text-align: center; padding: 0 20px; }
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
    #gengit3d-legend .list .item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
    #gengit3d-legend .list .item .count { color: var(--muted); font-size: 10px; }
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

  <div id="gengit3d-bar">
    <label for="gengit3d-theme">theme</label>
    <select id="gengit3d-theme" title="colour theme">
      ${themeNames.map(t => `<option value="${t}">${THEMES[t].label}</option>`).join('\n      ')}
    </select>
    <label for="gengit3d-view">view</label>
    <select id="gengit3d-view" title="graph layout view">
      ${viewNames.map(v => `<option value="${v}">${v}</option>`).join('\n      ')}
    </select>
    <label title="rotate the view automatically"><input id="gengit3d-rotate" type="checkbox" /> rotate</label>
    <button id="gengit3d-legend-toggle" title="show/hide branch legend">Branches</button>
    <button id="gengit3d-refresh" title="re-parse the repo">↻</button>
  </div>

  <div id="gengit3d-stats">loading…</div>
  <div id="gengit3d-status"></div>
  <div id="gengit3d-help">drag: rotate · scroll: zoom · right-drag: pan · click a commit: details · hover: info</div>
  <div id="gengit3d-loading">loading graph…</div>

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

  <script>
    // Données injectées par l'extension host
    window.__GENGIT3D_GRAPH__ = ${graphJson};
    window.__GENGIT3D_CONFIG__ = ${JSON.stringify({ ...config, themeNames, viewNames })};
  </script>
  <script src="${scriptUri}"></script>
</body>
</html>`;
}

// ── Activation ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    const cfg = getConfig();

    // ── Status bar button (comme GitGraph) ────────────────────────────────────
    const statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100  // priorité (à gauche)
    );
    statusBarItem.text = '$(graph) GenGit3D';
    statusBarItem.tooltip = 'Open GenGit3D — 3D git commit graph';
    statusBarItem.command = 'gengit3d.open';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Commande : ouvrir le graphe 3D (workspace courant)
    const openCmd = vscode.commands.registerCommand('gengit3d.open', async (uri?: vscode.Uri) => {
        const targetUri = uri || vscode.window.activeTextEditor?.document.uri;
        if (!targetUri) {
            vscode.window.showErrorMessage('GenGit3D: no file or folder selected. Open a file first, or right-click a folder in the Explorer.');
            return;
        }

        const repoDir = await findRepoRoot(targetUri.fsPath);
        if (!repoDir) {
            vscode.window.showErrorMessage(`GenGit3D: no git repository found above ${targetUri.fsPath}`);
            return;
        }

        await openGraphPanel(context, repoDir);
    });

    // Commande : ouvrir le graphe 3D pour le fichier courant
    const openFileCmd = vscode.commands.registerCommand('gengit3d.openFile', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('GenGit3D: no active editor.');
            return;
        }

        const repoDir = await findRepoRoot(editor.document.uri.fsPath);
        if (!repoDir) {
            vscode.window.showErrorMessage(`GenGit3D: no git repository found above ${editor.document.uri.fsPath}`);
            return;
        }

        await openGraphPanel(context, repoDir);
    });

    context.subscriptions.push(openCmd, openFileCmd);
}

async function openGraphPanel(context: vscode.ExtensionContext, repoDir: string) {
    const cfg = getConfig();

    const panel = vscode.window.createWebviewPanel(
        'gengit3d',
        'GenGit3D',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
        }
    );

    // Parser le graphe
    let graph: any;
    try {
        graph = await parseRepo(repoDir, cfg.maxCommits, cfg.defaultView);
    } catch (err: any) {
        vscode.window.showErrorMessage(`GenGit3D: failed to parse git log: ${err.message}`);
        return;
    }

    panel.webview.html = getWebviewContent(panel.webview, context.extensionUri, graph, cfg);

    // Gérer les messages du webview
    panel.webview.onDidReceiveMessage(async (msg) => {
        switch (msg.type) {
            case 'ready': {
                // Le webview est prêt, on peut envoyer des mises à jour si nécessaire
                break;
            }
            case 'changeView': {
                // Changer de vue (layout) — re-parser avec la nouvelle vue
                try {
                    const newGraph = await parseRepo(repoDir, cfg.maxCommits, msg.view);
                    panel.webview.postMessage({ type: 'updateGraph', graph: newGraph });
                } catch (err: any) {
                    panel.webview.postMessage({ type: 'error', message: err.message });
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
                    const newGraph = await parseRepo(repoDir, cfg.maxCommits, cfg.defaultView);
                    panel.webview.postMessage({ type: 'updateGraph', graph: newGraph });
                } catch (err: any) {
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
