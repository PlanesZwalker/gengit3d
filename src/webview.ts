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
import { layoutGraphForView } from './layout3d.js';

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
    branchName?: string;
    depth: number;
    x: number;
    y: number;
    z: number;
    isTip?: boolean;
    tipType?: string;
    tags?: string[];
    churn?: number;
    files?: string[];
    remote?: boolean;
}

interface GraphBranch {
    id: string;
    name: string;
    commits: number;
    color?: number;
    reach: number;
    local?: boolean;
    remote?: boolean;
}

interface Graph {
    nodes: GraphNode[];
    edges: Array<{ source: string; target: string; dashed?: boolean }>;
    branches: GraphBranch[];
    similarEdges: Array<{ from: string; to: string; type: string }>;
    head?: string;
    axis?: { mode: string; tMin: number; tMax: number; times?: number[]; vtimes?: number[]; orient?: string };
    source?: { kind: string; repo?: string; url?: string; file?: string };
    now?: { branch?: string; detached?: boolean; ahead?: number | null; behind?: number | null; dirty?: number; lastDate?: string };
}

interface ExtensionConfig {
    defaultView: string;
    defaultTheme: string;
    maxCommits: number;
    autoRotate: boolean;
    edgeOpacity?: number | null;
    nodeSize?: number | null;
    nodeSpacing?: number | null;
    themeNames: string[];
    viewNames: string[];
}

// ── State ─────────────────────────────────────────────────────────────────────

let currentGraph: Graph | null = null;
let nodeByIdMap = new Map<string, GraphNode>();
let replaySorted: any[] = []; // nœuds triés par _tk — dwell par commit
let currentScene: any = null;
let currentTheme: string = DEFAULT_THEME;
let currentView: string = 'topological';
let branchVisibility = new Map<string, boolean>();
let authorVisibility = new Map<string, boolean>();
let authorList: Array<{ name: string; commits: number }> = [];
let legendPage = 0;
let currentBranch = ''; // branche check outée (pour le badge ● et le bouton checkout)
let searchDebounce: ReturnType<typeof setTimeout> | null = null;
let currentFx = 'none'; // post-processing effect (persiste entre les redraws)
let replayP = 1; // progression du replay historique (0→1)
let replayPlaying = false;
let replayLastT = 0;
let periodStart = 0; // fenêtre de lecture choisie par l'utilisateur
let periodEnd = 1;
let refreshMovieStops: (() => void) | null = null; // le film s'adapte aux filtres en live

const authorMode = () => currentView === 'author';

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

// acquireVsCodeApi() throws if called more than once: acquire it a single time.
let vscodeApi: ReturnType<NonNullable<typeof window.acquireVsCodeApi>> | null | undefined;

function getVsCodeApi() {
    if (vscodeApi === undefined) {
        vscodeApi = typeof window.acquireVsCodeApi === 'function' ? window.acquireVsCodeApi() : null;
    }
    return vscodeApi;
}

function postToHost(msg: any): boolean {
    const api = getVsCodeApi();
    if (api) {
        api.postMessage(msg);
        return true;
    }
    return false;
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
    // Mise à jour en place (couleurs/lumières) — jamais de rebuild de scène ici
    if (currentScene && currentScene.setTheme) {
        currentScene.setTheme(name);
    } else if (rerender && currentGraph) {
        draw(currentGraph, null);
    }
}

// ── Scene ─────────────────────────────────────────────────────────────────────

function draw(graph: Graph, label: string | null) {
    currentGraph = graph;
    nodeByIdMap = new Map(graph.nodes.map((n) => [n.id, n]));
    const app = document.getElementById('app')!;
    const loading = document.getElementById('gengit3d-loading')!;
    const stats = document.getElementById('gengit3d-stats')!;

    if (currentScene && currentScene.dispose) {
        currentScene.dispose();
    }
    app.innerHTML = '';
    loading.style.display = 'none';
    updateFileBadge(graph);

    const rotateEl = document.getElementById('gengit3d-rotate') as HTMLInputElement;
    const spaceSlider0 = document.getElementById('gengit3d-spacing') as HTMLInputElement | null;
    currentScene = renderGraph(app, graph, {
        themeName: currentTheme,
        autoRotate: rotateEl?.checked ?? false,
        onSelect: showCommitDetails,
        // Espacement appliqué AVANT le cadrage initial (bbox/caméra) — sinon
        // la vue d'ouverture est taillée pour 100 % et le graphe semble vide.
        spacing: spaceSlider0 ? Number(spaceSlider0.value) / 100 : 1,
    });
    // Le slider d'opacité est la source de vérité — réappliquer au nouveau
    // renderer (chaque draw() repart de theme.edgeOpacity sinon).
    const edgeSlider = document.getElementById('gengit3d-edge-opacity') as HTMLInputElement | null;
    if (edgeSlider && currentScene.setEdgeOpacity) {
        currentScene.setEdgeOpacity(Number(edgeSlider.value) / 100);
    }
    const nodeSlider = document.getElementById('gengit3d-node-size') as HTMLInputElement | null;
    if (nodeSlider && currentScene.setNodeSize) {
        currentScene.setNodeSize(Number(nodeSlider.value) / 100);
    }
    const spaceSlider = document.getElementById('gengit3d-spacing') as HTMLInputElement | null;
    if (spaceSlider && currentScene.setSpacing) {
        currentScene.setSpacing(Number(spaceSlider.value) / 100);
    }
    // Nœuds triés par clé de révélation (posée par le renderer) — un stop
    // PAR COMMIT pour le dwell du movie.
    replaySorted = [...graph.nodes].sort((a: any, b: any) => (a._tk ?? 0) - (b._tk ?? 0));
    // L'effet post-processing est un état : réappliquer au nouveau renderer
    if (currentScene.setEffect) currentScene.setEffect(currentFx);
    // Idem pour le mode couleur + les labels merges/tags (états UI)
    const colSel0 = document.getElementById('gengit3d-colors') as HTMLSelectElement | null;
    if (colSel0 && currentScene.setColorMode) currentScene.setColorMode(colSel0.value);
    const labEl0 = document.getElementById('gengit3d-labels') as HTMLInputElement | null;
    if (labEl0 && currentScene.setLabelsVisible) currentScene.setLabelsVisible(labEl0.checked);
    const tipEl0 = document.getElementById('gengit3d-tips') as HTMLInputElement | null;
    if (tipEl0 && currentScene.setTipLabelsVisible) currentScene.setTipLabelsVisible(tipEl0.checked);
    const flatEl0 = document.getElementById('gengit3d-flat') as HTMLInputElement | null;
    if (flatEl0 && currentScene.setFlat) currentScene.setFlat(flatEl0.checked);
    const sumEl0 = document.getElementById('gengit3d-summary') as HTMLInputElement | null;
    if (sumEl0 && currentScene.setSummaryZoom) currentScene.setSummaryZoom(sumEl0.checked);
    updateNowHud(graph);
    // Replay : un nouveau graphe repart affiché en entier (p = 1), période
    // réinitialisée sur toute la frise, suivi caméra coupé
    replayP = 1;
    replayPlaying = false;
    periodStart = 0;
    periodEnd = 1;
    const playBtn = document.getElementById('gengit3d-play');
    if (playBtn) playBtn.textContent = '▶';
    const scrub = document.getElementById('gengit3d-scrubber') as HTMLInputElement | null;
    if (scrub) scrub.value = '1000';
    if (currentScene.setReplayFollow) currentScene.setReplayFollow(false);
    if (currentScene.setReplay) currentScene.setReplay(1);
    const sd = document.getElementById('gengit3d-scrub-date');
    if (sd) sd.textContent = replayDateLabel(1);
    // Bornes du sélecteur de période = plage de dates du graphe
    const ax: any = graph.axis;
    const hasTime = ax?.mode === 'time' && ax.times?.length;
    for (const id of ['gengit3d-from', 'gengit3d-to']) {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (!el) continue;
        el.value = '';
        el.disabled = !hasTime;
        if (hasTime) {
            el.min = localISODate(ax.tMin);
            el.max = localISODate(ax.tMax);
        }
    }

    buildLegend(graph);
    updateStats(graph);
    if (label) setStatus(label);
}

/** Badge "file: <name> ✕" en bas à gauche — indique le mode historique de
 *  fichier et permet de revenir au graphe complet (message clearFile). */
function updateFileBadge(graph: Graph) {
    const fb = document.getElementById('gengit3d-filebadge');
    if (!fb) return;
    const file = graph.source?.file;
    if (!file) {
        fb.style.display = 'none';
        fb.textContent = '';
        return;
    }
    const base = file.split('/').pop() || file;
    fb.style.display = '';
    fb.innerHTML = `file: <b title="${esc(file)}">${esc(base)}</b> <span id="gengit3d-clearfile" title="back to full history">✕</span>`;
}

// ── "NOW" HUD — l'état courant du repo en une ligne : HEAD, ahead/behind
// vs upstream, fichiers modifiés, âge du dernier commit.
function updateNowHud(graph: Graph) {
    const el = document.getElementById('gengit3d-now');
    if (!el) return;
    const now: any = graph.now;
    if (!now || !now.branch) {
        el.style.display = 'none';
        return;
    }
    const parts = [`⎇ ${esc(now.detached ? 'detached HEAD' : now.branch)}`];
    if (now.ahead != null || now.behind != null) {
        parts.push(`↑${now.ahead ?? 0} ↓${now.behind ?? 0} upstream`);
    }
    if (now.dirty) parts.push(`${now.dirty} dirty`);
    if (now.lastDate) {
        const age = Date.now() - Date.parse(now.lastDate);
        if (isFinite(age) && age >= 0) parts.push(`last commit ${relAge(age)} ago`);
    }
    el.style.display = '';
    el.innerHTML = parts.join(' · ');
}

function relAge(ms: number): string {
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d`;
    const mo = Math.floor(d / 30);
    if (mo < 12) return `${mo}mo`;
    return `${Math.floor(mo / 12)}y`;
}

// ── Hotspot : commits touchant les mêmes fichiers que la sélection —
// le reste du graphe s'éteint. Vide si le commit n'a pas de numstat.
function applyHotspot(node: GraphNode | null) {
    if (!currentScene || !currentScene.setHotspot) return;
    if (!node || !node.files?.length || !currentGraph) {
        currentScene.setHotspot(null);
        return;
    }
    const mine = new Set(node.files);
    const scored: Array<[number, string]> = [];
    for (const n of currentGraph.nodes) {
        if (n.id === node.id || !n.files?.length) continue;
        let inter = 0;
        for (const f of n.files) if (mine.has(f)) inter++;
        if (inter) scored.push([inter / (mine.size + n.files.length - inter), n.id]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    currentScene.setHotspot([node.id, ...scored.slice(0, 40).map((s) => s[1])]);
}

function updateStats(graph: Graph) {
    const stats = document.getElementById('gengit3d-stats')!;
    const nEdges = graph.edges?.length ?? 0;
    const nBranches = graph.branches?.length ?? 0;
    stats.textContent = `${graph.nodes.length} commits · ${nBranches} branches · ${nEdges} edges`;
}

/** Un nœud est visible s'il passe le filtre branches ET le filtre auteurs. */
function nodePassesFilters(n: GraphNode): boolean {
    if (branchVisibility.get(n.branch) === false) return false;
    if (authorMode() && authorVisibility.get(n.author) === false) return false;
    return true;
}

/** Stats relatives aux filtres courants : "visible / total" par métrique. */
function updateStatsForFilter() {
    if (!currentGraph) return;
    const anyFiltered =
        [...branchVisibility.values()].some((v) => !v) ||
        (authorMode() && [...authorVisibility.values()].some((v) => !v));
    if (!anyFiltered) {
        updateStats(currentGraph);
        return;
    }
    const stats = document.getElementById('gengit3d-stats')!;
    const totalN = currentGraph.nodes.length;
    const totalB = currentGraph.branches.length;
    const totalE = currentGraph.edges?.length ?? 0;
    let nc = 0,
        ne = 0;
    const visBranches = new Set<string>(),
        visAuthors = new Set<string>();
    for (const n of currentGraph.nodes) {
        if (!nodePassesFilters(n)) continue;
        nc++;
        visBranches.add(n.branch);
        visAuthors.add(n.author);
    }
    for (const e of currentGraph.edges) {
        const s = nodeByIdMap.get(e.source);
        const t = nodeByIdMap.get(e.target);
        if (s && t && nodePassesFilters(s) && nodePassesFilters(t)) ne++;
    }
    const parts = [`${nc} / ${totalN} commits`];
    if (authorMode()) parts.push(`${visAuthors.size} / ${authorList.length} authors`);
    else parts.push(`${visBranches.size} / ${totalB} branches`);
    parts.push(`${ne} / ${totalE} edges`);
    stats.textContent = parts.join(' · ');
}

// ── Branch legend ─────────────────────────────────────────────────────────────

function buildLegend(graph: Graph) {
    branchVisibility = new Map();
    const branches = [...graph.branches].sort((a, b) => b.commits - a.commits);
    branches.forEach((b) => branchVisibility.set(b.id, true));
    // Auteurs (vue 'author') — comptage des commits par auteur
    const authorCount = new Map<string, number>();
    for (const n of graph.nodes) authorCount.set(n.author, (authorCount.get(n.author) || 0) + 1);
    authorList = [...authorCount.entries()]
        .map(([name, commits]) => ({ name, commits }))
        .sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
    authorVisibility = new Map(authorList.map((a) => [a.name, true]));
    legendPage = 0;
    // Branche courante : lue sur le nœud HEAD (refs "HEAD -> dev")
    currentBranch = (graph.head ? nodeByIdMap.get(graph.head)?.branchName : null) || '';
    // Remplir les sélecteurs de la barre (filtre rapide)
    const sel = document.getElementById('gengit3d-branch') as HTMLSelectElement | null;
    if (sel) {
        sel.innerHTML = '<option value="">all branches</option>' +
            branches.map((b) => `<option value="${esc(b.id)}">${esc(b.name)} (${b.commits})</option>`).join('');
        sel.value = '';
    }
    const asel = document.getElementById('gengit3d-author') as HTMLSelectElement | null;
    if (asel) {
        asel.innerHTML = '<option value="">all authors</option>' +
            authorList.map((a) => `<option value="${esc(a.name)}">${esc(a.name)} (${a.commits})</option>`).join('');
        asel.value = '';
    }
    updateAuthorUI();
    renderLegendList(graph, '');
    updateBranchFilter();
}

/** Bascule les libellés du panneau/toolbar selon la vue (branches vs auteurs). */
function updateAuthorUI() {
    const am = authorMode();
    const title = document.querySelector('#gengit3d-legend .h');
    if (title) title.textContent = am ? 'authors' : 'branches';
    const search = document.getElementById('gengit3d-legend-search') as HTMLInputElement | null;
    if (search) search.placeholder = am ? 'filter authors…' : 'filter branches…';
    const toggle = document.getElementById('gengit3d-legend-toggle');
    if (toggle) {
        toggle.textContent = am ? 'Authors' : 'Branches';
        toggle.title = am ? 'show/hide author list' : 'show/hide branch legend';
    }
    const awrap = document.getElementById('gengit3d-author-wrap');
    if (awrap) awrap.style.display = am ? '' : 'none';
}

/** Couleur de pastille déterministe pour un auteur (cosmétique, liste). */
function authorSwatch(name: string): string {
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `hsl(${h}, 85%, 62%)`;
}

function soloBranch(bid: string) {
    for (const [b] of branchVisibility) branchVisibility.set(b, b === bid);
    legendPage = 0;
    if (currentGraph) {
        const legendSearch = document.getElementById('gengit3d-legend-search') as HTMLInputElement;
        renderLegendList(currentGraph, legendSearch?.value || '');
    }
    updateBranchFilter();
}

function soloAuthor(name: string) {
    for (const [a] of authorVisibility) authorVisibility.set(a, a === name);
    legendPage = 0;
    if (currentGraph) {
        const legendSearch = document.getElementById('gengit3d-legend-search') as HTMLInputElement;
        renderLegendList(currentGraph, legendSearch?.value || '');
    }
    updateBranchFilter();
}

function toggleAuthor(name: string, visible: boolean) {
    authorVisibility.set(name, visible);
    const el = document.querySelector(`.item[data-author="${CSS.escape(name)}"]`);
    if (el) el.classList.toggle('hidden-branch', !visible);
    updateBranchFilter();
}

function renderLegendList(graph: Graph, filter: string) {
    const legendList = document.getElementById('gengit3d-legend-list')!;
    const q = filter.toLowerCase();
    const am = authorMode();
    const branches = [...graph.branches].sort((a, b) => b.commits - a.commits);
    const filtered = am
        ? (q ? authorList.filter((a) => a.name.toLowerCase().includes(q)) : authorList)
        : (q ? branches.filter((b) => b.name.toLowerCase().includes(q)) : branches);
    if (!filtered.length) {
        legendList.innerHTML = `<div class="empty">No ${am ? 'authors' : 'branches'} match.</div>`;
        return;
    }
    const PAGE_SIZE = 50;
    const page = legendPage;
    const slice = filtered.slice(0, (page + 1) * PAGE_SIZE);
    const hasMore = filtered.length > (page + 1) * PAGE_SIZE;
    const key = am ? 'author' : 'branch';
    legendList.innerHTML = slice.map((item: any) => {
        const id = am ? item.name : item.id;
        const name = item.name;
        const visible = am ? authorVisibility.get(name) !== false : branchVisibility.get(id) !== false;
        const color = am ? authorSwatch(name) : '#' + (item.color ?? 0x4f9dff).toString(16).padStart(6, '0');
        const isStash = !am && /^stash@\{\d+\}$/.test(name);
        const isEmpty = !am && item.reach > 0 && item.commits <= 1;
        const tipBadge = isStash ? '<span class="tip-badge stash">stash</span>' : (isEmpty ? '<span class="tip-badge empty">empty</span>' : '');
        // Checkout (façon GitGraph) : branches locales uniquement ; la branche
        // courante affiche ● au lieu du bouton.
        const isCurrent = !am && name === currentBranch;
        const canCheckout = !am && item.local && !isStash;
        const checkoutBtn = canCheckout
            ? (isCurrent
                ? '<span class="current-badge" title="currently checked out">●</span>'
                : `<button class="checkout" data-checkout="${esc(name)}" title="checkout ${esc(name)}">⎇</button>`)
            : '';
        return `<div class="item${visible ? '' : ' hidden-branch'}" data-${key}="${esc(id)}">` +
            `<input type="checkbox" ${visible ? 'checked' : ''} />` +
            `<span class="swatch" style="background:${color}"></span>` +
            `<span class="name" title="${esc(name)} — click to isolate this ${am ? 'author' : 'branch'}">${esc(name)}</span>` +
            tipBadge +
            checkoutBtn +
            `<span class="count">${item.commits}</span></div>`;
    }).join('') + (hasMore ? `<div class="item load-more" style="justify-content:center;color:var(--muted);cursor:pointer;">Show more (${filtered.length - (page + 1) * PAGE_SIZE} more)</div>` : '');

    // Event delegation
    legendList.querySelectorAll(`.item[data-${key}]`).forEach((el) => {
        const el2 = el as HTMLElement;
        const id = am ? el2.dataset.author! : el2.dataset.branch!;
        const toggle = (v: boolean) => (am ? toggleAuthor(id, v) : toggleBranch(id, v));
        const solo = () => (am ? soloAuthor(id) : soloBranch(id));
        el2.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).tagName === 'INPUT') return;
            if ((e.target as HTMLElement).closest('.checkout')) return;
            const cb = el2.querySelector('input') as HTMLInputElement;
            cb.checked = !cb.checked;
            toggle(cb.checked);
        });
        el2.querySelector('.checkout')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const name = (e.currentTarget as HTMLElement).dataset.checkout!;
            setStatus(`switching to ${name}…`, 'busy');
            postToHost({ type: 'checkout', branch: name });
        });
        el2.querySelector('input')!.addEventListener('change', (e) => {
            e.stopPropagation();
            toggle((e.target as HTMLInputElement).checked);
        });
        // Click sur le nom → isoler (solo)
        el2.querySelector('.name')!.addEventListener('click', (e) => {
            e.stopPropagation();
            solo();
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
    currentScene.setBranchFilter(visible.size === branchVisibility.size ? null : visible);
    // Filtre auteur : actif seulement en vue 'author' (sinon on force "tous")
    if (currentScene.setAuthorFilter) {
        let aSet: Set<string> | null = null;
        if (authorMode()) {
            aSet = new Set<string>();
            for (const [a, v] of authorVisibility) {
                if (v) aSet.add(a);
            }
            if (aSet.size === authorVisibility.size) aSet = null;
        }
        currentScene.setAuthorFilter(aSet);
    }
    updateStatsForFilter();
    // Garder les sélecteurs de la barre en synchro avec les checkboxes
    const sel = document.getElementById('gengit3d-branch') as HTMLSelectElement | null;
    if (sel) sel.value = visible.size === 1 ? [...visible][0] : '';
    const asel = document.getElementById('gengit3d-author') as HTMLSelectElement | null;
    if (asel) {
        const visAuthors = [...authorVisibility.entries()].filter(([, v]) => v).map(([a]) => a);
        asel.value = authorMode() && visAuthors.length === 1 ? visAuthors[0] : '';
    }
    // Le film suit les filtres : s'il joue, ses stops sont reconstruits
    // pour ne visiter que les commits encore visibles.
    refreshMovieStops?.();
}

/** Timestamp réel correspondant à la progression du replay (échelle compressée). */
function progressToTime(p: number): number | null {
    const ax: any = currentGraph?.axis;
    if (!(ax?.mode === 'time' && ax.times?.length && ax.vtimes?.length)) return null;
    const tss = ax.times, vts = ax.vtimes;
    const vMax = vts[vts.length - 1];
    const v = p * vMax;
    if (v <= 0) return tss[0];
    if (v >= vMax) return tss[tss.length - 1];
    let lo = 0, hi = vts.length - 1;
    while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (vts[m] <= v) lo = m;
        else hi = m;
    }
    const f = (v - vts[lo]) / (vts[hi] - vts[lo] || 1);
    return tss[lo] + (tss[hi] - tss[lo]) * f;
}

/** Date → progression du replay (inverse de l'échelle compressée times→vtimes). */
function dateToProgress(iso: string, endOfDay: boolean): number {
    const ax: any = currentGraph?.axis;
    if (!ax?.times?.length || !ax?.vtimes?.length) return endOfDay ? 1 : 0;
    const tss = ax.times, vts = ax.vtimes;
    // 'T00:00:00' force le parsing en heure locale (sans heure → UTC, ce qui
    // décalerait la borne d'un jour selon le fuseau)
    const t = new Date(iso + 'T00:00:00').getTime() + (endOfDay ? 86399999 : 0);
    if (t <= tss[0]) return 0;
    if (t >= tss[tss.length - 1]) return 1;
    let lo = 0, hi = tss.length - 1;
    while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (tss[m] <= t) lo = m;
        else hi = m;
    }
    const f = (t - tss[lo]) / (tss[hi] - tss[lo] || 1);
    const v = vts[lo] + f * (vts[hi] - vts[lo]);
    return v / vts[vts.length - 1];
}

function localISODate(t: number): string {
    const d = new Date(t);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Date réelle correspondant à la progression du replay (échelle compressée → date). */
function replayDateLabel(p: number): string {
    const t = progressToTime(p);
    if (t != null) {
        return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    }
    return `${Math.round(p * 100)}%`;
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
    applyHotspot(null);
}

function showCommitDetails(node: GraphNode, ctx: any) {
    openDetail();
    applyHotspot(node);
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
        case 'graphData':
            // Réponse au fallback requestGraph : l'injection avait été bloquée
            window.__GENGIT3D_GRAPH__ = msg.graph;
            if (msg.config) window.__GENGIT3D_CONFIG__ = msg.config;
            if (!currentGraph) boot();
            break;
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
        `<li>${f.status ? `<span class="st">${esc(f.status)}</span>` : ''}<span class="a">+${f.added ?? '–'}</span><span class="d">-${f.deleted ?? '–'}</span><span class="p">${esc(f.path)}</span></li>`
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
    // Toolbar collapse/expand
    const bar = document.getElementById('gengit3d-bar')!;
    const barToggle = document.getElementById('gengit3d-bar-toggle') as HTMLButtonElement | null;
    if (barToggle) {
        barToggle.addEventListener('click', () => {
            const collapsed = bar.classList.toggle('collapsed');
            barToggle.textContent = collapsed ? '☰' : '–';
            barToggle.title = collapsed ? 'expand the toolbar' : 'collapse the toolbar';
        });
    }

    // Theme selector
    const themeSel = document.getElementById('gengit3d-theme') as HTMLSelectElement;
    themeSel.value = currentTheme;
    themeSel.addEventListener('change', () => setTheme(themeSel.value));

    // View selector
    const viewSel = document.getElementById('gengit3d-view') as HTMLSelectElement;
    viewSel.value = currentView;
    viewSel.addEventListener('change', () => {
        currentView = viewSel.value;
        // Re-layout 100% côté client : le layout ne touche que x/y/z, inutile
        // de re-parser git (~2s sur un gros repo). Le host est juste informé
        // pour que 'refresh' conserve la même vue.
        if (currentGraph) {
            layoutGraphForView(currentGraph, currentView);
            draw(currentGraph, `${currentGraph.nodes.length} commits, ${currentGraph.branches.length} branches · ${currentView}`);
        }
        postToHost({ type: 'changeView', view: currentView });
    });

    // Rotate checkbox
    const rotateEl = document.getElementById('gengit3d-rotate') as HTMLInputElement;
    rotateEl.addEventListener('change', () => {
        if (currentScene && currentScene.setAutoRotate) {
            currentScene.setAutoRotate(rotateEl.checked);
        }
    });

    // Edge opacity slider — init from persisted config (or theme default),
    // live-update the scene and write the value back to user settings.
    const edgeSlider = document.getElementById('gengit3d-edge-opacity') as HTMLInputElement | null;
    const edgeVal = document.getElementById('gengit3d-edge-opacity-val') as HTMLElement | null;
    if (edgeSlider) {
        const cfgOpacity = window.__GENGIT3D_CONFIG__?.edgeOpacity;
        const initial = typeof cfgOpacity === 'number' ? cfgOpacity : getTheme(currentTheme).edgeOpacity;
        edgeSlider.value = String(Math.round(initial * 100));
        if (edgeVal) edgeVal.textContent = edgeSlider.value + '%';
        edgeSlider.addEventListener('input', () => {
            if (edgeVal) edgeVal.textContent = edgeSlider.value + '%';
            if (currentScene && currentScene.setEdgeOpacity) {
                currentScene.setEdgeOpacity(Number(edgeSlider.value) / 100);
            }
        });
        edgeSlider.addEventListener('change', () => {
            postToHost({ type: 'setEdgeOpacity', value: Number(edgeSlider.value) / 100 });
        });
    }

    // Node size slider — same live + persist pattern
    const nodeSlider = document.getElementById('gengit3d-node-size') as HTMLInputElement | null;
    const nodeVal = document.getElementById('gengit3d-node-size-val') as HTMLElement | null;
    if (nodeSlider) {
        const cfgSize = window.__GENGIT3D_CONFIG__?.nodeSize;
        nodeSlider.value = String(Math.round((typeof cfgSize === 'number' ? cfgSize : 1) * 100));
        if (nodeVal) nodeVal.textContent = nodeSlider.value + '%';
        nodeSlider.addEventListener('input', () => {
            if (nodeVal) nodeVal.textContent = nodeSlider.value + '%';
            if (currentScene && currentScene.setNodeSize) {
                currentScene.setNodeSize(Number(nodeSlider.value) / 100);
            }
        });
        nodeSlider.addEventListener('change', () => {
            postToHost({ type: 'setNodeSize', value: Number(nodeSlider.value) / 100 });
        });
    }

    // Spacing slider — same live + persist pattern
    const spaceSlider = document.getElementById('gengit3d-spacing') as HTMLInputElement | null;
    const spaceVal = document.getElementById('gengit3d-spacing-val') as HTMLElement | null;
    if (spaceSlider) {
        const cfgSpace = window.__GENGIT3D_CONFIG__?.nodeSpacing;
        spaceSlider.value = String(Math.round((typeof cfgSpace === 'number' ? cfgSpace : 1) * 100));
        if (spaceVal) spaceVal.textContent = spaceSlider.value + '%';
        spaceSlider.addEventListener('input', () => {
            if (spaceVal) spaceVal.textContent = spaceSlider.value + '%';
            if (currentScene && currentScene.setSpacing) {
                currentScene.setSpacing(Number(spaceSlider.value) / 100);
            }
        });
        spaceSlider.addEventListener('change', () => {
            postToHost({ type: 'setSpacing', value: Number(spaceSlider.value) / 100 });
            // Recadrage animé au relâché : pendant le drag on voit l'effet
            // local de l'espacement ; au lâché on ré-embarque tout le graphe
            // (sinon l'étirement sort du frustum → écran quasi noir).
            if (currentScene && currentScene.fitView) currentScene.fitView('visible');
        });
    }

    // Replay — "movie" de l'historique : les commits pop dans l'ordre
    // chronologique, la caméra suit le front de lecture. La période
    // optionnelle borne la lecture ; le slider couvre alors cette fenêtre.
    const playBtn = document.getElementById('gengit3d-play') as HTMLButtonElement | null;
    const scrubEl = document.getElementById('gengit3d-scrubber') as HTMLInputElement | null;
    const scrubDate = document.getElementById('gengit3d-scrub-date');
    const fromEl = document.getElementById('gengit3d-from') as HTMLInputElement | null;
    const toEl = document.getElementById('gengit3d-to') as HTMLInputElement | null;
    const sliderToP = () => periodStart + (Number(scrubEl ? scrubEl.value : 1000) / 1000) * (periodEnd - periodStart);
    const pToSlider = (p: number) => Math.round(Math.min(Math.max((p - periodStart) / Math.max(periodEnd - periodStart, 0.0001), 0), 1) * 1000);
    const camEl = document.getElementById('gengit3d-cam') as HTMLInputElement | null;
    const setFollow = (v: boolean) => {
        const on = v && (camEl ? camEl.checked : true);
        if (currentScene && currentScene.setReplayFollow) currentScene.setReplayFollow(on);
    };
    camEl?.addEventListener('change', () => {
        // Décocher pendant la lecture rend la caméra immédiatement libre
        if (!camEl.checked && currentScene && currentScene.setReplayFollow) currentScene.setReplayFollow(false);
    });
    const subEl = document.getElementById('gengit3d-subtitle');
    const applyReplay = (live = false) => {
        // Le tag "en cours de lecture" s'épingle au commit du dwell courant
        const presentId = live ? stopNodes[stopIdx]?.id : undefined;
        if (currentScene && currentScene.setReplay) currentScene.setReplay(replayP, live, presentId);
        if (scrubEl) scrubEl.value = String(pToSlider(replayP));
        if (scrubDate) scrubDate.textContent = replayDateLabel(replayP);
        // Sous-titre "piste audio" du film : lisible même si le nœud sort
        // de l'écran — date — sujet — auteur du commit présenté.
        if (subEl) {
            const pn = live ? stopNodes[stopIdx] : null;
            if (pn) {
                const d = pn.date ? new Date(pn.date) : null;
                const dt = d && !isNaN(d.getTime())
                    ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
                    : '';
                subEl.textContent = `${dt} — ${pn.subject} · ${pn.author}`;
                subEl.style.display = '';
            } else {
                subEl.style.display = 'none';
            }
        }
    };
    const speedEl = document.getElementById('gengit3d-speed') as HTMLSelectElement | null;
    let replaySpeed = speedEl ? Number(speedEl.value) || 1 : 1;
    speedEl?.addEventListener('change', () => {
        replaySpeed = Number(speedEl.value) || 1;
    });
    // Mode couleur (branch/author/age) + labels merges/tags persistants
    const colSel = document.getElementById('gengit3d-colors') as HTMLSelectElement | null;
    colSel?.addEventListener('change', () => {
        if (currentScene && currentScene.setColorMode) currentScene.setColorMode(colSel.value);
    });
    const labEl = document.getElementById('gengit3d-labels') as HTMLInputElement | null;
    labEl?.addEventListener('change', () => {
        if (currentScene && currentScene.setLabelsVisible) currentScene.setLabelsVisible(labEl.checked);
    });
    const tipEl = document.getElementById('gengit3d-tips') as HTMLInputElement | null;
    tipEl?.addEventListener('change', () => {
        if (currentScene && currentScene.setTipLabelsVisible) currentScene.setTipLabelsVisible(tipEl.checked);
    });
    const flatEl = document.getElementById('gengit3d-flat') as HTMLInputElement | null;
    flatEl?.addEventListener('change', () => {
        if (currentScene && currentScene.setFlat) currentScene.setFlat(flatEl.checked);
    });
    const sumEl = document.getElementById('gengit3d-summary') as HTMLInputElement | null;
    sumEl?.addEventListener('change', () => {
        if (currentScene && currentScene.setSummaryZoom) currentScene.setSummaryZoom(sumEl.checked);
    });
    const keyBtn = document.getElementById('gengit3d-key') as HTMLButtonElement | null;
    keyBtn?.addEventListener('click', () => {
        const hud = document.getElementById('gengit3d-key-hud');
        if (hud) hud.style.display = hud.style.display === 'none' ? 'block' : 'none';
    });
    // Playback événementiel : on DWELL ~1,5 s sur CHAQUE commit (le temps
    // de lire son étiquette — tag dédié épinglé au nœud), puis TRAVEL
    // rapide vers le suivant. Les commits d'une même vague (_tk identique)
    // enchaînent les dwells sans travel.
    let stopNodes: any[] = []; // nœuds de la fenêtre triés par _tk
    let stopIdx = 0;
    let replayPhase: 'dwell' | 'travel' = 'dwell';
    let phaseLeft = 0;
    const DWELL_MS = 1500;
    const buildStops = () => {
        // Le film respecte TOUTES les options actives : période choisie +
        // filtres branches/auteurs — on ne dwell que sur les commits visibles.
        stopNodes = replaySorted.filter(
            (n) =>
                (n._tk ?? 0) > periodStart + 1e-6 &&
                (n._tk ?? 0) <= periodEnd + 1e-9 &&
                nodePassesFilters(n)
        );
    };
    // Changer un filtre ou la période pendant la lecture reconstruit les
    // stops sans perdre la position — on repart en travel vers le prochain
    // commit visible (ou on s'arrête proprement s'il n'en reste plus).
    const refreshStops = () => {
        if (!replayPlaying) return;
        buildStops();
        stopIdx = stopNodes.findIndex((n) => (n._tk ?? 0) > replayP + 1e-6);
        if (stopIdx < 0 || stopIdx >= stopNodes.length) {
            replayPlaying = false;
            setFollow(false);
            if (subEl) subEl.style.display = 'none';
            if (playBtn) playBtn.textContent = '▶';
            applyReplay(false);
            return;
        }
        replayPhase = 'travel';
        replayLastT = performance.now();
    };
    refreshMovieStops = refreshStops; // hook pour updateBranchFilter()
    function stepReplay(t: number) {
        if (!replayPlaying) return;
        const dt = Math.min(t - replayLastT, 120); // ms
        replayLastT = t;
        if (replayPhase === 'dwell') {
            phaseLeft -= dt;
            if (phaseLeft <= 0) {
                stopIdx++;
                if (stopIdx >= stopNodes.length) {
                    replayPlaying = false;
                    replayP = periodEnd;
                    setFollow(false);
                    if (playBtn) playBtn.textContent = '▶';
                } else {
                    replayPhase = 'travel';
                }
            }
        } else {
            // Glide rapide vers la prochaine clé (~200 ms ressenti ; instant
            // entre commits d'une même vague puisque la cible est atteinte)
            const target = stopNodes[stopIdx]?._tk ?? periodEnd;
            replayP += (target - replayP) * Math.min(dt * 0.02 * replaySpeed, 1);
            if (target - replayP < 1e-4) {
                replayP = target;
                replayPhase = 'dwell';
                phaseLeft = DWELL_MS / replaySpeed;
            }
        }
        applyReplay(replayPlaying); // live → les étiquettes suivent le front
        if (replayPlaying) requestAnimationFrame(stepReplay);
    }
    const syncPeriod = () => {
        const s = fromEl && fromEl.value ? dateToProgress(fromEl.value, false) : 0;
        const e = toEl && toEl.value ? dateToProgress(toEl.value, true) : 1;
        periodStart = Math.min(s, e);
        periodEnd = Math.max(s, e);
        if (periodEnd - periodStart < 0.001) periodEnd = Math.min(periodStart + 0.001, 1);
        if (replayP < periodStart || replayP > periodEnd) replayP = periodStart;
        applyReplay();
        refreshStops(); // la fenêtre a bougé — les stops suivent en live
    };
    if (playBtn && scrubEl) {
        playBtn.addEventListener('click', () => {
            replayPlaying = !replayPlaying;
            if (!replayPlaying && subEl) subEl.style.display = 'none';
            // Repartir du début de la fenêtre si le playhead est dehors/fini
            if (replayPlaying && (replayP >= periodEnd || replayP < periodStart)) replayP = periodStart;
            setFollow(replayPlaying);
            playBtn.textContent = replayPlaying ? '⏸' : '▶';
            if (replayPlaying) {
                buildStops();
                stopIdx = stopNodes.findIndex((n) => (n._tk ?? 0) > replayP + 1e-6);
                if (stopIdx < 0 || stopIdx >= stopNodes.length) {
                    // Tout déjà révélé dans la fenêtre — rien à jouer
                    replayPlaying = false;
                    replayP = periodEnd;
                    setFollow(false);
                    playBtn.textContent = '▶';
                    applyReplay(false);
                    return;
                }
                replayPhase = 'travel';
                replayLastT = performance.now();
                requestAnimationFrame(stepReplay);
            }
        });
        scrubEl.addEventListener('input', () => {
            replayPlaying = false;
            if (subEl) subEl.style.display = 'none';
            setFollow(false);
            if (playBtn) playBtn.textContent = '▶';
            replayP = sliderToP();
            applyReplay();
        });
    }
    fromEl?.addEventListener('change', syncPeriod);
    toEl?.addEventListener('change', syncPeriod);
    document.getElementById('gengit3d-mark-in')?.addEventListener('click', () => {
        const t = progressToTime(replayP);
        if (t != null && fromEl) {
            fromEl.value = localISODate(t);
            syncPeriod();
        }
    });
    document.getElementById('gengit3d-mark-out')?.addEventListener('click', () => {
        const t = progressToTime(replayP);
        if (t != null && toEl) {
            toEl.value = localISODate(t);
            syncPeriod();
        }
    });
    document.getElementById('gengit3d-clear-period')?.addEventListener('click', () => {
        if (fromEl) fromEl.value = '';
        if (toEl) toEl.value = '';
        periodStart = 0;
        periodEnd = 1;
        applyReplay();
    });

    // Fit / reset camera button — quick re-frame of the visible commits
    const fitBtn = document.getElementById('gengit3d-fit');
    if (fitBtn) {
        fitBtn.addEventListener('click', () => {
            if (currentScene && currentScene.fitView) currentScene.fitView('visible');
        });
    }

    // Fit selector — menu d'actions (revient sur "fit ▸" après le vol caméra)
    const fitSel = document.getElementById('gengit3d-fit-mode') as HTMLSelectElement | null;
    if (fitSel) {
        fitSel.addEventListener('change', () => {
            if (currentScene && currentScene.fitView && fitSel.value) {
                currentScene.fitView(fitSel.value);
            }
            fitSel.value = '';
        });
    }

    // Post-processing effect selector — état, persiste entre les redraws
    const fxSel = document.getElementById('gengit3d-fx') as HTMLSelectElement | null;
    if (fxSel) {
        fxSel.addEventListener('change', () => {
            currentFx = fxSel.value || 'none';
            if (currentScene && currentScene.setEffect) currentScene.setEffect(currentFx);
        });
    }

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

    // Legend bulk buttons (operate on branches OR authors depending on view)
    const setAll = (v: boolean) => {
        const map = authorMode() ? authorVisibility : branchVisibility;
        for (const [k] of map) map.set(k, v);
        legendPage = 0;
        if (currentGraph) renderLegendList(currentGraph, legendSearch.value);
        updateBranchFilter();
    };
    document.getElementById('gengit3d-legend-all')!.addEventListener('click', () => setAll(true));
    document.getElementById('gengit3d-legend-none')!.addEventListener('click', () => setAll(false));
    document.getElementById('gengit3d-legend-top')!.addEventListener('click', () => {
        if (!currentGraph) return;
        const map = authorMode() ? authorVisibility : branchVisibility;
        const items = authorMode()
            ? authorList
            : [...currentGraph.branches].sort((a, b) => b.commits - a.commits).map((b) => ({ name: b.id }));
        const top10 = new Set(items.slice(0, 10).map((i) => i.name));
        for (const [k] of map) map.set(k, top10.has(k));
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

    // Split button — clone ce panneau dans la colonne d'à côté avec la vue
    // et le thème courants ; chaque panneau garde ensuite sa propre sélection
    document.getElementById('gengit3d-split')?.addEventListener('click', () => {
        postToHost({ type: 'split', view: currentView, theme: currentTheme, file: currentGraph?.source?.file });
    });

    // Badge fichier — le ✕ rend la main au graphe complet (délégation : le
    // badge est réécrit par updateFileBadge à chaque draw())
    document.getElementById('gengit3d-filebadge')?.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).id === 'gengit3d-clearfile') postToHost({ type: 'clearFile' });
    });

    // Branch selector (quick isolate)
    const branchSel = document.getElementById('gengit3d-branch') as HTMLSelectElement;
    branchSel.addEventListener('change', () => {
        if (!branchSel.value) {
            for (const [bid] of branchVisibility) branchVisibility.set(bid, true);
            legendPage = 0;
            if (currentGraph) renderLegendList(currentGraph, legendSearch.value);
            updateBranchFilter();
        } else {
            soloBranch(branchSel.value);
        }
    });

    // Author selector (quick isolate — author view only)
    const authorSel = document.getElementById('gengit3d-author') as HTMLSelectElement | null;
    if (authorSel) {
        authorSel.addEventListener('change', () => {
            if (!authorSel.value) {
                for (const [a] of authorVisibility) authorVisibility.set(a, true);
                legendPage = 0;
                if (currentGraph) renderLegendList(currentGraph, legendSearch.value);
                updateBranchFilter();
            } else {
                soloAuthor(authorSel.value);
            }
        });
    }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

function boot() {
    const graph = window.__GENGIT3D_GRAPH__;
    const config = window.__GENGIT3D_CONFIG__;

    if (!graph) {
        // Le graphe arrive via postMessage ('graphData') une fois le parse
        // terminé côté host — le parse peut prendre plusieurs secondes sur un
        // gros repo, donc pas de timeout court ici.
        if (postToHost({ type: 'requestGraph' })) {
            setStatus('parsing git log…', 'busy');
            // Sécurité : si graphData n'arrive pas (course perdue côté host),
            // relancer la demande une fois plutôt que rester bloqué.
            setTimeout(() => {
                if (!currentGraph) postToHost({ type: 'requestGraph' });
            }, 10000);
        } else {
            setStatus('no graph data received from extension host', 'err');
        }
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
