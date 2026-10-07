// webview.ts — point d'entrée du webview GenGit3D (côté navigateur)
//
// Responsabilités :
//   - Charger three.js + les addons (OrbitControls, CSS2DRenderer)
//   - Lire le graphe injecté par l'extension host (window.__GENGIT3D_GRAPH__)
//   - Initialiser la scène 3D (renderGraph depuis scene.js)
//   - Gérer l'UI (bar, legend, detail panel, theme/view selectors)
//   - Communiquer avec l'extension host via postMessage

import { renderGraph } from './scene-webview.js';
import { THEMES, DEFAULT_THEME, getTheme } from './themes.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface GraphNode {
    id: string;
    short: string;
    subject: string;
    author: string;
    email: string;
    date: string;
    parents: string[];
    branch: string;
    depth: number;
    x: number;
    y: number;
    z: number;
    isTip?: boolean;
    tipType?: string;
}

interface GraphBranch {
    id: string;
    name: string;
    commits: number;
    color?: number;
    reach: number;
}

interface Graph {
    nodes: GraphNode[];
    edges: Array<{ source: string; target: string; dashed?: boolean }>;
    branches: GraphBranch[];
    similarEdges: Array<{ from: string; to: string; type: string }>;
    head?: string;
    axis?: { mode: string; tMin: number; tMax: number };
    source?: { kind: string; repo?: string; url?: string };
}

interface ExtensionConfig {
    defaultView: string;
    defaultTheme: string;
    maxCommits: number;
    autoRotate: boolean;
    themeNames: string[];
    viewNames: string[];
}

// ── State ─────────────────────────────────────────────────────────────────────

let currentGraph: Graph | null = null;
let currentScene: any = null;
let currentTheme: string = DEFAULT_THEME;
let currentView: string = 'topological';
let branchVisibility = new Map<string, boolean>();
let legendPage = 0;
let searchDebounce: ReturnType<typeof setTimeout> | null = null;

declare const window: Window & {
    __GENGIT3D_GRAPH__: Graph;
    __GENGIT3D_CONFIG__: ExtensionConfig;
    acquireVsCodeApi?: () => {
        postMessage: (msg: any) => void;
        getState: () => any;
        setState: (state: any) => void;
    };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s: string): string {
    return String(s).replace(/[<>"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function setStatus(msg: string, kind: string = '') {
    const el = document.getElementById('gengit3d-status') as HTMLElement;
    if (el) {
        el.textContent = msg;
        el.className = kind;
    }
}

function getVsCodeApi() {
    if (typeof window.acquireVsCodeApi === 'function') {
        return window.acquireVsCodeApi();
    }
    return null;
}

function postToHost(msg: any) {
    const api = getVsCodeApi();
    if (api) {
        api.postMessage(msg);
    }
}

// ── Theme ─────────────────────────────────────────────────────────────────────

function applyChrome(name: string) {
    const ui = getTheme(name).ui;
    const r = document.documentElement.style;
    r.setProperty('--bg', ui.bg);
    r.setProperty('--panel', ui.panel);
    r.setProperty('--border', ui.border);
    r.setProperty('--text', ui.text);
    r.setProperty('--muted', ui.muted);
    r.setProperty('--accent', ui.accent);
    r.setProperty('--input', ui.input);
    r.setProperty('--btn', ui.btn);
    r.setProperty('--btn-border', ui.btnBorder);
    r.setProperty('--btn-text', ui.btnText);
    r.setProperty('--overlay', ui.overlay);
    r.setProperty('--err', ui.err);
    r.setProperty('--busy', ui.busy);
    if (ui.diffAdd) r.setProperty('--diff-add', ui.diffAdd);
    if (ui.diffDel) r.setProperty('--diff-del', ui.diffDel);
    if (ui.diffHunk) r.setProperty('--diff-hunk', ui.diffHunk);
    document.documentElement.setAttribute('data-theme', name);
}

function setTheme(name: string, rerender: boolean = true) {
    if (!THEMES[name]) name = DEFAULT_THEME;
    currentTheme = name;
    applyChrome(name);
    if (rerender && currentGraph) {
        draw(currentGraph, null);
    }
}

// ── Scene ─────────────────────────────────────────────────────────────────────

function draw(graph: Graph, label: string | null) {
    currentGraph = graph;
    const app = document.getElementById('app')!;
    const loading = document.getElementById('gengit3d-loading')!;
    const stats = document.getElementById('gengit3d-stats')!;

    if (currentScene && currentScene.dispose) {
        currentScene.dispose();
    }
    app.innerHTML = '';
    loading.style.display = 'none';

    const rotateEl = document.getElementById('gengit3d-rotate') as HTMLInputElement;
    currentScene = renderGraph(app, graph, {
        themeName: currentTheme,
        autoRotate: rotateEl?.checked ?? false,
        onSelect: showCommitDetails,
    });

    buildLegend(graph);
    updateStats(graph);
    if (label) setStatus(label);
}

function updateStats(graph: Graph) {
    const stats = document.getElementById('gengit3d-stats')!;
    const nEdges = graph.edges?.length ?? 0;
    const nBranches = graph.branches?.length ?? 0;
    stats.textContent = `${graph.nodes.length} commits · ${nBranches} branches · ${nEdges} edges`;
}

// ── Branch legend ─────────────────────────────────────────────────────────────

function buildLegend(graph: Graph) {
    branchVisibility = new Map();
    const branches = [...graph.branches].sort((a, b) => b.commits - a.commits);
    branches.forEach((b) => branchVisibility.set(b.id, true));
    legendPage = 0;
    renderLegendList(graph, '');
    updateBranchFilter();
}

function renderLegendList(graph: Graph, filter: string) {
    const legendList = document.getElementById('gengit3d-legend-list')!;
    const branches = [...graph.branches].sort((a, b) => b.commits - a.commits);
    const q = filter.toLowerCase();
    const filtered = q ? branches.filter((b) => b.name.toLowerCase().includes(q)) : branches;
    if (!filtered.length) {
        legendList.innerHTML = '<div class="empty">No branches match.</div>';
        return;
    }
    const PAGE_SIZE = 50;
    const page = legendPage;
    const slice = filtered.slice(0, (page + 1) * PAGE_SIZE);
    const hasMore = filtered.length > (page + 1) * PAGE_SIZE;
    legendList.innerHTML = slice.map((b) => {
        const visible = branchVisibility.get(b.id) !== false;
        const colorHex = '#' + (b.color ?? 0x4f9dff).toString(16).padStart(6, '0');
        const isStash = /^stash@\{\d+\}$/.test(b.name);
        const isEmpty = b.reach > 0 && b.commits <= 1;
        const tipBadge = isStash ? '<span class="tip-badge stash">stash</span>' : (isEmpty ? '<span class="tip-badge empty">empty</span>' : '');
        return `<div class="item${visible ? '' : ' hidden-branch'}" data-branch="${esc(b.id)}">` +
            `<input type="checkbox" ${visible ? 'checked' : ''} />` +
            `<span class="swatch" style="background:${colorHex}"></span>` +
            `<span class="name" title="${esc(b.name)}">${esc(b.name)}</span>` +
            tipBadge +
            `<span class="count">${b.commits}</span></div>`;
    }).join('') + (hasMore ? `<div class="item load-more" style="justify-content:center;color:var(--muted);cursor:pointer;">Show more (${filtered.length - (page + 1) * PAGE_SIZE} more)</div>` : '');

    // Event delegation
    legendList.querySelectorAll('.item[data-branch]').forEach((el) => {
        const bid = (el as HTMLElement).dataset.branch!;
        el.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).tagName === 'INPUT') return;
            const cb = el.querySelector('input') as HTMLInputElement;
            cb.checked = !cb.checked;
            toggleBranch(bid, cb.checked);
        });
        el.querySelector('input')!.addEventListener('change', (e) => {
            e.stopPropagation();
            toggleBranch(bid, (e.target as HTMLInputElement).checked);
        });
    });
    const loadMore = legendList.querySelector('.load-more');
    if (loadMore) {
        loadMore.addEventListener('click', () => {
            legendPage++;
            renderLegendList(graph, filter);
        });
    }
}

function toggleBranch(branchId: string, visible: boolean) {
    branchVisibility.set(branchId, visible);
    const el = document.querySelector(`.item[data-branch="${CSS.escape(branchId)}"]`);
    if (el) el.classList.toggle('hidden-branch', !visible);
    updateBranchFilter();
}

function updateBranchFilter() {
    if (!currentScene || !currentScene.setBranchFilter) return;
    const visible = new Set<string>();
    for (const [bid, v] of branchVisibility) {
        if (v) visible.add(bid);
    }
    const allVisible = visible.size === branchVisibility.size;
    currentScene.setBranchFilter(allVisible ? null : visible);
}

// ── Commit details ─────────────────────────────────────────────────────────────

function colorizePatch(text: string): string {
    return esc(text).split('\n').map((line) => {
        if (line.startsWith('+')) return '<span class="add">' + line + '</span>';
        if (line.startsWith('-')) return '<span class="del">' + line + '</span>';
        if (line.startsWith('@@')) return '<span class="hunk">' + line + '</span>';
        return line;
    }).join('\n');
}

function openDetail() {
    document.getElementById('gengit3d-detail')!.classList.add('open');
}

function closeDetail() {
    document.getElementById('gengit3d-detail')!.classList.remove('open');
}

function showCommitDetails(node: GraphNode, ctx: any) {
    openDetail();
    const detailBody = document.getElementById('gengit3d-detail-body')!;
    const repo = ctx?.repo || currentGraph?.source?.repo;
    detailBody.innerHTML = '<div class="empty">loading ' + esc(node.short) + ' …</div>';
    if (!repo) {
        detailBody.innerHTML = '<div class="empty">no repo source</div>';
        return;
    }
    // Demander les détails du commit à l'extension host
    postToHost({ type: 'getCommitDetails', hash: node.id, repo });
}

// ── Message handler ───────────────────────────────────────────────────────────

function handleHostMessage(msg: any) {
    switch (msg.type) {
        case 'updateGraph':
            draw(msg.graph, `updated: ${msg.graph.nodes.length} commits, ${msg.graph.branches.length} branches`);
            break;
        case 'commitDetails':
            displayCommitDetails(msg.data);
            break;
        case 'error':
            setStatus('error: ' + msg.message, 'err');
            break;
    }
}

function displayCommitDetails(d: any) {
    const detailBody = document.getElementById('gengit3d-detail-body')!;
    if (!d) {
        detailBody.innerHTML = '<div class="empty err">commit not found</div>';
        return;
    }
    const files = (d.files || []).map((f: any) =>
        `<li><span class="a">+${f.added ?? '–'}</span><span class="d">-${f.deleted ?? '–'}</span><span class="p">${esc(f.path)}</span></li>`
    ).join('');
    detailBody.innerHTML =
        `<h2>${esc(d.short)} — ${esc(d.subject)}</h2>` +
        `<div class="meta"><b>author</b> ${esc(d.author)} &lt;${esc(d.email)}&gt;<br>` +
        `<b>date</b> ${esc(d.date)}<br>` +
        (d.committer && d.committer !== d.author ? `<b>committer</b> ${esc(d.committer)}<br>` : '') +
        `<b>parents</b> ${d.parents.length ? d.parents.map((p: string) => esc(p.slice(0, 10))).join(', ') : '(root)'}</div>` +
        (d.body ? `<div class="msg">${esc(d.body)}</div>` : '') +
        `<div class="stat">${d.stats.files} file(s) · <span style="color:var(--diff-add)">+${d.stats.added}</span> / <span style="color:var(--diff-del)">-${d.stats.deleted}</span></div>` +
        `<ul class="files">${files || '<li class="p">(no files — merge commit?)</li>'}</ul>` +
        (d.patch ? `<pre class="diff">${colorizePatch(d.patch)}</pre>` + (d.patchTruncated ? '<div class="empty">… patch truncated</div>' : '') : '');
}

// ── UI wiring ─────────────────────────────────────────────────────────────────

function initUI() {
    // Theme selector
    const themeSel = document.getElementById('gengit3d-theme') as HTMLSelectElement;
    themeSel.value = currentTheme;
    themeSel.addEventListener('change', () => setTheme(themeSel.value));

    // View selector
    const viewSel = document.getElementById('gengit3d-view') as HTMLSelectElement;
    viewSel.value = currentView;
    viewSel.addEventListener('change', () => {
        currentView = viewSel.value;
        postToHost({ type: 'changeView', view: currentView });
    });

    // Rotate checkbox
    const rotateEl = document.getElementById('gengit3d-rotate') as HTMLInputElement;
    rotateEl.addEventListener('change', () => {
        if (currentScene && currentScene.setAutoRotate) {
            currentScene.setAutoRotate(rotateEl.checked);
        }
    });

    // Legend toggle
    const legend = document.getElementById('gengit3d-legend')!;
    document.getElementById('gengit3d-legend-toggle')!.addEventListener('click', () => {
        legend.classList.toggle('open');
    });
    document.getElementById('gengit3d-legend-close')!.addEventListener('click', () => {
        legend.classList.remove('open');
    });

    // Legend search
    const legendSearch = document.getElementById('gengit3d-legend-search') as HTMLInputElement;
    legendSearch.addEventListener('input', () => {
        if (searchDebounce) clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
            legendPage = 0;
            if (currentGraph) renderLegendList(currentGraph, legendSearch.value);
        }, 150);
    });

    // Legend bulk buttons
    document.getElementById('gengit3d-legend-all')!.addEventListener('click', () => {
        for (const [bid] of branchVisibility) branchVisibility.set(bid, true);
        legendPage = 0;
        if (currentGraph) renderLegendList(currentGraph, legendSearch.value);
        updateBranchFilter();
    });
    document.getElementById('gengit3d-legend-none')!.addEventListener('click', () => {
        for (const [bid] of branchVisibility) branchVisibility.set(bid, false);
        legendPage = 0;
        if (currentGraph) renderLegendList(currentGraph, legendSearch.value);
        updateBranchFilter();
    });
    document.getElementById('gengit3d-legend-top')!.addEventListener('click', () => {
        if (!currentGraph) return;
        const branches = [...currentGraph.branches].sort((a, b) => b.commits - a.commits);
        const top10 = new Set(branches.slice(0, 10).map((b) => b.id));
        for (const [bid] of branchVisibility) branchVisibility.set(bid, top10.has(bid));
        legendPage = 0;
        renderLegendList(currentGraph, legendSearch.value);
        updateBranchFilter();
    });

    // Detail close
    document.getElementById('gengit3d-detail-close')!.addEventListener('click', closeDetail);

    // Refresh button
    document.getElementById('gengit3d-refresh')!.addEventListener('click', () => {
        postToHost({ type: 'refresh' });
    });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

function boot() {
    const graph = window.__GENGIT3D_GRAPH__;
    const config = window.__GENGIT3D_CONFIG__;

    if (!graph) {
        setStatus('no graph data received from extension host', 'err');
        return;
    }

    currentTheme = config?.defaultTheme || DEFAULT_THEME;
    currentView = config?.defaultView || 'topological';

    initUI();
    applyChrome(currentTheme);
    draw(graph, `${graph.nodes.length} commits, ${graph.branches.length} branches`);

    // Notifier l'extension host que le webview est prêt
    postToHost({ type: 'ready' });
}

// Attendre que le DOM soit prêt
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}

// Écouter les messages de l'extension host
window.addEventListener('message', (event) => {
    handleHostMessage(event.data);
});
