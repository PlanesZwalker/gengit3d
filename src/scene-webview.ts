// scene-webview.ts — adaptation de scene.js pour le webview VS Code.
//
// scene.js original utilise des imports `three/addons/...` qui ne se résolvent
// pas dans un bundle esbuild sans configuration d'alias. Cette version utilise
// des imports relatifs explicites vers node_modules/three/examples/jsm/.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { AfterimagePass } from 'three/examples/jsm/postprocessing/AfterimagePass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { VignetteShader } from 'three/examples/jsm/shaders/VignetteShader.js';
import { BrightnessContrastShader } from 'three/examples/jsm/shaders/BrightnessContrastShader.js';
import { HorizontalTiltShiftShader } from 'three/examples/jsm/shaders/HorizontalTiltShiftShader.js';
import { VerticalTiltShiftShader } from 'three/examples/jsm/shaders/VerticalTiltShiftShader.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { ConvolutionShader } from 'three/examples/jsm/shaders/ConvolutionShader.js';
import { getTheme } from './themes.js';
import { assignBranchColors } from './branch-colors.js';

/**
 * Build and render the graph into a container element.
 * @param {HTMLElement} container
 * @param {object} graph  output of gitlog.parseGitLog (post-layout)
 * @param {object|string} [opts]  { themeName, onSelect, autoRotate, timeline }
 *                                (a bare string is accepted as themeName)
 */
export function renderGraph(container: HTMLElement, graph: any, opts: any) {
    if (typeof opts === 'string') opts = { themeName: opts };
    opts = opts || {};
    let theme = getTheme(opts.themeName);
    const showTimeline = opts.timeline !== false;
    const onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : null;

    // assign a distinct color to every branch (mutates branch.color)
    // avoidHex: colors also stay maximally distant from the theme background
    // (re-computed in setTheme — each theme has its own curated palette)
    let branchColorMap = assignBranchColors(graph, { avoidHex: theme.background, palette: theme.palette });

    // Espacement persisté : étirer l'axe du temps AVANT le bbox / cadrage
    // caméra — sinon la vue d'ouverture est calculée pour un graphe à 100 %
    // et l'utilisateur ouvre sur un écran quasi vide ("black render").
    const initSpacing = opts.spacing || 1;
    if (initSpacing !== 1) {
        const h0 = graph.axis?.orient === 'x';
        for (const n of graph.nodes) {
            if (h0) n.x *= initSpacing;
            else n.y *= initSpacing;
        }
    }

    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(theme.background);

    const camera = new THREE.PerspectiveCamera(55, width / height, 1, 40000);

    // frame the whole graph: compute bbox of node positions
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const n of graph.nodes) box.expandByPoint(v.set(n.x, n.y, n.z));
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const maxDim = Math.max(size.x, size.y, size.z, 10);
    const spacingBaseDim = maxDim / initSpacing; // taille "à 100 %" pour le fog/rim
    const fitDist = (maxDim / 2 / Math.tan((camera.fov * Math.PI) / 360)) * 1.25;
    camera.position.set(center.x + fitDist * 0.55, center.y + fitDist * 0.35, center.z + fitDist * 0.9);
    camera.lookAt(center);
    const homePos = camera.position.clone();
    const homeTarget = center.clone();

    // depth fog tuned to the actual cloud size
    const fogCol = theme.fogColor != null ? theme.fogColor : theme.background;
    scene.fog = new THREE.Fog(fogCol, maxDim * theme.fog[0], maxDim * theme.fog[1]);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    // CSS2D overlay for crisp HTML timeline labels
    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(width, height);
    Object.assign(labelRenderer.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' });
    container.appendChild(labelRenderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = !!opts.autoRotate;
    controls.autoRotateSpeed = 0.45;
    controls.target.copy(center);

    // ---- camera flights: smooth fly-to used by every fit mode + intro ----
    const camAnim = {
        active: false,
        t0: 0,
        dur: 0,
        fromPos: new THREE.Vector3(),
        toPos: new THREE.Vector3(),
        fromTgt: new THREE.Vector3(),
        toTgt: new THREE.Vector3(),
    };
    function flyTo(toPos: THREE.Vector3, toTgt: THREE.Vector3, dur = 750) {
        camAnim.active = true;
        camAnim.t0 = performance.now();
        camAnim.dur = dur;
        camAnim.fromPos.copy(camera.position);
        camAnim.toPos.copy(toPos);
        camAnim.fromTgt.copy(controls.target);
        camAnim.toTgt.copy(toTgt);
        controls.enabled = false; // no fighting the flight
    }
    function stepCamAnim() {
        if (!camAnim.active) return;
        let k = (performance.now() - camAnim.t0) / camAnim.dur;
        if (k >= 1) k = 1;
        const e = 1 - Math.pow(1 - k, 3); // easeOutCubic
        camera.position.lerpVectors(camAnim.fromPos, camAnim.toPos, e);
        controls.target.lerpVectors(camAnim.fromTgt, camAnim.toTgt, e);
        camera.lookAt(controls.target);
        if (k === 1) {
            camAnim.active = false;
            controls.enabled = true;
        }
    }

    // Framing = bounding sphere of a node set → center + camera distance
    function frameNodes(nodes: any[]) {
        if (!nodes.length) return null;
        const b = new THREE.Box3();
        const tv = new THREE.Vector3();
        for (const n of nodes) b.expandByPoint(tv.set(n.x, n.y, n.z));
        const c = b.getCenter(new THREE.Vector3());
        const s = b.getSize(new THREE.Vector3());
        const r = Math.max(Math.max(s.x, s.y, s.z) * 0.5, 10);
        return { center: c, dist: (r / Math.tan((camera.fov * Math.PI) / 360)) * 1.35 };
    }
    // view directions (slight offsets keep OrbitControls off the poles)
    const FIT_DIRS: Record<string, THREE.Vector3> = {
        top: new THREE.Vector3(0.02, 1, 0.02),
        front: new THREE.Vector3(0.02, 0.12, 1),
        side: new THREE.Vector3(1, 0.12, 0.02),
        iso: new THREE.Vector3(0.55, 0.35, 0.9),
    };

    // intro: swoop in from far out instead of popping into existence
    if (opts.intro !== false) {
        const dirV = homePos.clone().sub(homeTarget).normalize();
        camera.position.copy(homeTarget).addScaledVector(dirV, fitDist * 3.4);
        flyTo(homePos, homeTarget, 1100);
    }

    // lights
    const ambient = new THREE.AmbientLight(theme.lights.ambient[0], theme.lights.ambient[1]);
    scene.add(ambient);
    const key = new THREE.DirectionalLight(theme.lights.key[0], theme.lights.key[1]);
    key.position.set(1, 1.4, 1.2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(theme.lights.fill[0], theme.lights.fill[1]);
    fill.position.set(-1.2, -0.4, -1);
    scene.add(fill);
    const rim = new THREE.PointLight(theme.lights.rim[0], theme.lights.rim[1], maxDim * 6);
    rim.position.set(0, maxDim * 0.6, maxDim * 0.9);
    scene.add(rim);

    const nodeById = new Map(graph.nodes.map((n: any) => [n.id, n]));
    const colorOf = (branchId: string) => branchColorMap.get(branchId) ?? 0x4f9dff;
    const TIP_COLORS: Record<string, number> = { stash: 0xff8c42, 'empty-branch': 0x8b93a7, uncommitted: 0xf2c14e };
    const tipColorOf = (n: any) => {
        if (n.isTip && n.tipType) return TIP_COLORS[n.tipType] ?? 0xff8c42;
        return null;
    };

    // prominence: the big branches keep their colour, the long tail recedes
    const branchesSorted = [...graph.branches].sort((a: any, b: any) => b.commits - a.commits);
    const rankOf = new Map(branchesSorted.map((b: any, i: number) => [b.id, i]));
    const PROMINENT = 36;
    let RECEDE = new THREE.Color(theme.recede);
    const colorCache = new Map();
    const isMajor = (branchId: string) => (rankOf.get(branchId) ?? 9999) < PROMINENT;
    const tintOf = (branchId: string) => {
        let c = colorCache.get(branchId);
        if (c) return c;
        c = new THREE.Color(colorOf(branchId));
        if (!isMajor(branchId)) c.lerp(RECEDE, theme.recedeAmount);
        colorCache.set(branchId, c);
        return c;
    };
    // Colorisation — 3 modes : branche (défaut), auteur (hash → teinte
    // stable), âge (bleu ancien → orange récent). Les nœuds "remote-only"
    // (appartiennent à refs/remotes/*) sont désaturés en mode branche.
    let colorMode: 'branch' | 'author' | 'age' = 'branch';
    let hotspotSet: Set<string> | null = null; // ids "liés" — le reste s'éteint
    const authorColorCache = new Map<string, THREE.Color>();
    const authorColorOf = (name: string) => {
        let c = authorColorCache.get(name);
        if (!c) {
            let h = 0;
            for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
            c = new THREE.Color().setHSL((h % 360) / 360, 0.62, 0.55);
            authorColorCache.set(name, c);
        }
        return c;
    };
    const ageColorOf = (n: any) => {
        const t0 = graph.axis?.tMin ?? 0, t1 = graph.axis?.tMax ?? 1;
        const k = Math.min(Math.max(((Date.parse(n.date) || 0) - t0) / (t1 - t0 || 1), 0), 1);
        return new THREE.Color().setHSL(0.62 - 0.55 * k, 0.72, 0.55); // bleu → orange
    };
    const bgFade = new THREE.Color(theme.background);
    const nodeColorOf = (n: any) => {
        const tipC = tipColorOf(n);
        const c = tipC !== null
            ? new THREE.Color(tipC)
            : colorMode === 'author'
                ? authorColorOf(n.author || '').clone()
                : colorMode === 'age'
                    ? ageColorOf(n)
                    : tintOf(n.branch).clone();
        if (n.remote && colorMode === 'branch' && tipC === null) c.lerp(RECEDE, 0.55);
        if (hotspotSet && !hotspotSet.has(n.id)) c.lerp(bgFade, 0.78);
        return c;
    };
    // Encodage "poids" : churn (lignes touchées) → taille du nœud +
    // épaisseur de l'arête entrante. Log-scalé et borné — un énorme merge
    // ne doit pas écraser le graphe.
    const churnScale = (n: any) => 1 + Math.min(1.0, Math.log1p(n.churn || 0) / Math.log1p(2500));
    const edgeW = (n: any) => 0.6 + 0.7 * Math.min(1, Math.log1p(n.churn || 0) / Math.log1p(3000));

    // white per-vertex colour
    const whiteAttr = (geo: any) =>
        geo.setAttribute(
            'color',
            new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 3).fill(1), 3)
        );

    // ---- edges as tubes ----
    const edgeGroup = new THREE.Group();
    const up = new THREE.Vector3(0, 1, 0);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const mid = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const m = new THREE.Matrix4();
    const edgeGeo = whiteAttr(new THREE.CylinderGeometry(0.5, 0.5, 1, graph.nodes.length > 20000 ? 4 : 6, 1, true));
    const edgeMatVisible = new THREE.MeshStandardMaterial({
        roughness: 0.75,
        metalness: 0.2,
        vertexColors: true,
        transparent: true,
        opacity: theme.edgeOpacity,
    });
    const edgeMatHidden = new THREE.MeshStandardMaterial({
        roughness: 0.75,
        metalness: 0.2,
        vertexColors: true,
        transparent: true,
        opacity: 0.1,
    });
    // Opacité des liens — pilotée par le slider UI, persiste entre les thèmes.
    let edgeOpacity = theme.edgeOpacity;
    // Taille des sphères de commit — multiplicateur du rayon de base (1.6).
    let nodeScale = 1;
    // Espacement — multiplie les positions depuis les coordonnées de base
    // stockées ci-dessous (jamais en cumul, sinon dérive d'arrondi). Les
    // positions actuelles incluent déjà initSpacing → on les ramène à 100 %.
    let spacing = initSpacing;
    const horizBase = graph.axis?.orient === 'x';
    for (const n of graph.nodes) {
        n.bx = horizBase ? n.x / initSpacing : n.x;
        n.by = horizBase ? n.y : n.y / initSpacing;
        n.bz = n.z;
    }
    // Clé de révélation "movie" : position normalisée le long de l'axe du
    // temps (y, ou x en chronological). Cap 0.97 → tout est visible à p=1 ;
    // le nœud uncommitted pop en dernier (c'est le travail le plus récent).
    let replayP = 1;
    {
        const horiz = graph.axis?.orient === 'x';
        let tMin = Infinity, tMax = -Infinity;
        for (const n of graph.nodes) {
            const c = horiz ? n.bx : n.by;
            if (c < tMin) tMin = c;
            if (c > tMax) tMax = c;
        }
        const span = tMax - tMin || 1;
        for (const n of graph.nodes) {
            const c = horiz ? n.bx : n.by;
            n._tk = n.tipType === 'uncommitted' ? 0.97 : Math.min((c - tMin) / span, 0.97);
        }
    }
    // Pop-in : la sphère grandit quand le front de lecture la dépasse.
    const REPLAY_W = 0.03;
    const replayK = (n: any) => {
        const k = (replayP - (n._tk ?? 0)) / REPLAY_W;
        return k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k);
    };
    // Caméra "film" : focus = centroïde des nœuds en train de pop. Le front
    // de lecture saute de branche en branche à chaque frame ; suivre un nœud
    // unique ferait fouetter la caméra autour du cylindre — la moyenne sur
    // une fenêtre glissante lisse ce travelling.
    const sortedByKey = [...graph.nodes].sort((a: any, b: any) => (a._tk ?? 0) - (b._tk ?? 0));
    const focusPos = new THREE.Vector3();
    let replayFollow = false;
    let followDist = 60; // distance de zoom, adaptée à la longueur moyenne des arêtes
    // FOV vertical fixe : l'horizontal dépend de l'aspect. Sous ~1.6 (panneau
    // étroit, split), on recule pour conserver la même ampleur visible.
    const followDistEff = () => followDist * Math.min(2.5, Math.max(1, 1.6 / camera.aspect));
    // Distance "lecture" : pendant le dwell la caméra serre sur le commit
    // présenté — ~1/3 de la distance contexte, assez proche pour que la
    // sphère et son étiquette soient lisibles.
    const presentDist = () =>
        Math.min(Math.max(followDist * 0.35, 16), 60) * Math.min(2.0, Math.max(1, 1.6 / camera.aspect));
    // Direction du temps : +y en cylindrique, +x en chronological (les plus
    // récents sont du côté positif — vérif. dans layout3d timePos).
    const axisDir = graph.axis?.orient === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const tmpTarget = new THREE.Vector3();
    // Nœud au front de lecture (dernier révélé) + flag "lecture en cours" —
    // les étiquettes "film" s'accrochent aux commits révélés.
    let frontNode: any = null;
    let frontIdx = -1; // index dans sortedByKey du front
    let movieLive = false;
    let presentNode: any = null; // commit "en cours de lecture" (dwell)
    function updateReplayFocus() {
        const W = 0.04;
        let lo = 0, hi = sortedByKey.length - 1, idx = -1;
        while (lo <= hi) {
            const m = (lo + hi) >> 1;
            if ((sortedByKey[m]._tk ?? 0) <= replayP) { idx = m; lo = m + 1; }
            else hi = m - 1;
        }
        frontIdx = idx;
        frontNode = idx >= 0 ? sortedByKey[idx] : null;
        if (idx < 0) return;
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for (let i = idx; i >= 0; i--) {
            const n: any = sortedByKey[i];
            if ((n._tk ?? 0) < replayP - W) break;
            sx += n.x;
            sy += n.y;
            sz += n.z;
            cnt++;
        }
        if (cnt) focusPos.set(sx / cnt, sy / cnt, sz / cnt);
    }
    const MAX_EDGE_INSTANCES = 120000;
    const solidEdges = graph.edges.filter((e: any) => !e.dashed);
    const dashedEdges = graph.edges.filter((e: any) => e.dashed);
    const nEdges = Math.min(solidEdges.length, MAX_EDGE_INSTANCES);
    const edgesVisible = new THREE.InstancedMesh(edgeGeo, edgeMatVisible, nEdges);
    const edgesHidden = new THREE.InstancedMesh(edgeGeo, edgeMatHidden, nEdges);
    edgesVisible.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    edgesHidden.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    edgesVisible.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(nEdges * 3), 3);
    edgesHidden.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(nEdges * 3), 3);
    let ei = 0;
    for (const e of solidEdges) {
        if (ei >= nEdges) break;
        const s = nodeById.get(e.source);
        const t = nodeById.get(e.target);
        if (!s || !t) continue;
        a.set(s.x, s.y, s.z);
        b.set(t.x, t.y, t.z);
        dir.subVectors(b, a);
        const len = dir.length() || 0.001;
        mid.addVectors(a, b).multiplyScalar(0.5);
        q.setFromUnitVectors(up, dir.clone().normalize());
        m.compose(mid, q, new THREE.Vector3(edgeW(s), len, edgeW(s)));
        edgesVisible.setMatrixAt(ei, m);
        edgesVisible.setColorAt(ei, nodeColorOf(s));
        ei++;
    }
    edgesVisible.count = ei;
    edgesHidden.count = 0;
    edgesVisible.instanceMatrix.needsUpdate = true;
    edgesVisible.instanceColor.needsUpdate = true;
    edgeGroup.add(edgesVisible);
    edgeGroup.add(edgesHidden);

    // remplit un buffer de segments (x,y,z par paire) depuis les positions
    // COURANTES des nœuds — réutilisé par setSpacing pour reconstruire les
    // lignes sans recréer la géométrie. Retourne le nb de sommets écrits.
    const fillSegPositions = (pairs: any[], aKey: string, bKey: string, attr: THREE.BufferAttribute) => {
        let pi = 0;
        for (const e of pairs) {
            const s = nodeById.get(e[aKey]);
            const t = nodeById.get(e[bKey]);
            if (!s || !t) continue;
            if (Math.max(s._tk ?? 0, t._tk ?? 0) > replayP) continue; // replay : pas encore révélée
            attr.setXYZ(pi++, s.x, s.y, s.z);
            attr.setXYZ(pi++, t.x, t.y, t.z);
        }
        attr.needsUpdate = true;
        return pi;
    };

    // ---- dashed edges ----
    const dashedGroup = new THREE.Group();
    const dashedMat = new THREE.LineDashedMaterial({
        color: 0xff8c42,
        dashSize: 4,
        gapSize: 3,
        transparent: true,
        opacity: 0.7,
    });
    let dashSeg: THREE.LineSegments | null = null;
    if (dashedEdges.length > 0) {
        const geo = new THREE.BufferGeometry();
        const attr = new THREE.BufferAttribute(new Float32Array(dashedEdges.length * 6), 3);
        geo.setAttribute('position', attr);
        geo.setDrawRange(0, fillSegPositions(dashedEdges, 'source', 'target', attr));
        dashSeg = new THREE.LineSegments(geo, dashedMat);
        dashSeg.computeLineDistances();
        dashedGroup.add(dashSeg);
    }
    scene.add(dashedGroup);

    // ---- nodes as instanced spheres ----
    // ---- node shapes by commit type ----
    // La silhouette porte l'info structurelle : merge = losange (jonction),
    // root = pyramide (origine), uncommitted = cube (brut), stash = cône
    // (rangement à part), empty-branch = anneau (simple marqueur de ref).
    const nodeShapeOf = (n: any): string =>
          n.id === 'uncommitted' ? 'uncommitted'
        : n.isTip ? (n.tipType === 'stash' ? 'stash' : 'empty')
        : (n.parents?.length ?? 0) >= 2 ? 'merge'
        : (n.parents?.length ?? 0) === 0 ? 'root'
        : 'normal';
    const SHAPE_GEO: Record<string, () => THREE.BufferGeometry> = {
        normal: () => new THREE.SphereGeometry(1.6, 12, 10),
        merge: () => new THREE.OctahedronGeometry(2.1),
        root: () => new THREE.TetrahedronGeometry(2.4),
        uncommitted: () => new THREE.BoxGeometry(2.5, 2.5, 2.5),
        stash: () => new THREE.ConeGeometry(1.8, 3.2, 9),
        empty: () => new THREE.TorusGeometry(1.5, 0.55, 8, 18),
    };
    // Halo de la même forme que le nœud (×factor) — hover et sélection.
    const haloGeoFor = (n: any, factor: number) => {
        const g = SHAPE_GEO[nodeShapeOf(n)]();
        g.scale(factor, factor, factor);
        return g;
    };

    const nodeMat = new THREE.MeshStandardMaterial({
        roughness: 0.55,
        metalness: 0.25,
        vertexColors: true,
    });
    // Un InstancedMesh PAR forme — même coût qu'avant par instance, ≤6 draw
    // calls. userData.nodeIndex : instanceId local → index dans graph.nodes.
    const buckets = new Map<string, number[]>();
    graph.nodes.forEach((n: any, i: number) => {
        const s = nodeShapeOf(n);
        let b = buckets.get(s);
        if (!b) buckets.set(s, (b = []));
        b.push(i);
    });
    const shapeMeshes: THREE.InstancedMesh[] = [];
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    for (const [shape, idxs] of buckets) {
        const mesh = new THREE.InstancedMesh(whiteAttr(SHAPE_GEO[shape]()), nodeMat, idxs.length);
        mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(idxs.length * 3), 3);
        for (let j = 0; j < idxs.length; j++) {
            const n = graph.nodes[idxs[j]];
            m4.makeTranslation(n.x, n.y, n.z);
            mesh.setMatrixAt(j, m4);
            col.copy(nodeColorOf(n));
            mesh.setColorAt(j, col);
        }
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;
        mesh.userData.nodeIndex = idxs;
        scene.add(mesh);
        shapeMeshes.push(mesh);
    }
    // instanceId (local au mesh) → index dans graph.nodes
    const hitNode = (hit: any) => {
        if (hit.instanceId === undefined) return undefined;
        return (hit.object.userData.nodeIndex as number[])[hit.instanceId];
    };

    // ---- similar-commit edges (dashed lines) ----
    let simMat: THREE.LineDashedMaterial | null = null;
    let simSeg: THREE.LineSegments | null = null;
    if (graph.similarEdges && graph.similarEdges.length > 0) {
        simMat = new THREE.LineDashedMaterial({
            color: 0x8b93a7,
            dashSize: 2,
            gapSize: 2,
            transparent: true,
            opacity: 0.4,
        });
        const geo = new THREE.BufferGeometry();
        const attr = new THREE.BufferAttribute(new Float32Array(graph.similarEdges.length * 6), 3);
        geo.setAttribute('position', attr);
        geo.setDrawRange(0, fillSegPositions(graph.similarEdges, 'from', 'to', attr));
        simSeg = new THREE.LineSegments(geo, simMat);
        simSeg.computeLineDistances();
        scene.add(simSeg);
    }

    // Rebuild des segments (tips + similaires) après un changement d'espacement.
    function rebuildSegs() {
        if (dashSeg) {
            const attr = dashSeg.geometry.getAttribute('position') as THREE.BufferAttribute;
            dashSeg.geometry.setDrawRange(0, fillSegPositions(dashedEdges, 'source', 'target', attr));
            dashSeg.computeLineDistances();
        }
        if (simSeg) {
            const attr = simSeg.geometry.getAttribute('position') as THREE.BufferAttribute;
            simSeg.geometry.setDrawRange(0, fillSegPositions(graph.similarEdges, 'from', 'to', attr));
            simSeg.computeLineDistances();
        }
    }

    // ---- timeline axis ----
    let axisMat: THREE.LineBasicMaterial | null = null;
    let axisGroup: THREE.Group | null = null;
    if (showTimeline && graph.axis) {
        axisGroup = new THREE.Group();
        axisMat = new THREE.LineBasicMaterial({ color: theme.axis, transparent: true, opacity: 0.35 });
        const horizontal = graph.axis.orient === 'x';
        const main = (v: number) => (horizontal ? new THREE.Vector3(v, 0, 0) : new THREE.Vector3(0, v, 0));
        const cross = (v: number) => (horizontal ? new THREE.Vector3(0, v, 0) : new THREE.Vector3(v, 0, 0));

        // ticks map to the real data extent on the time axis, padded slightly
        let aMin = Infinity, aMax = -Infinity;
        for (const n of graph.nodes) {
            const v = horizontal ? n.x : n.y;
            if (v < aMin) aMin = v;
            if (v > aMax) aMax = v;
        }
        if (!isFinite(aMin) || aMax - aMin < 1) { aMin = -maxDim * 0.5; aMax = maxDim * 0.5; }
        const pad = (aMax - aMin) * 0.06;
        const lo = aMin - pad, hi = aMax + pad;

        const axisGeo = new THREE.BufferGeometry().setFromPoints([main(lo), main(hi)]);
        axisGroup.add(new THREE.Line(axisGeo, axisMat));

        // date format adapts to the span so ticks stay meaningful/distinct
        const spanMs = (graph.axis.tMax ?? 0) - (graph.axis.tMin ?? 0);
        const day = 86400000;
        const fmtDate = (d: Date) =>
            spanMs > 730 * day ? d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
            : spanMs > 45 * day ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
            : spanMs > 2 * day ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
            : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

        // ticks are evenly spaced in COMPRESSED visual space; label each with
        // the real date it corresponds to (invert the layout's times->vtimes
        // scale). Without the scale (older graphs) fall back to linear dates.
        const vts = graph.axis.vtimes, tss = graph.axis.times;
        const vMax = vts && vts.length ? vts[vts.length - 1] : 0;
        const v2t = (v: number) => {
            if (!vts || !tss || !vMax) return graph.axis.tMin + spanMs * (v / (vMax || 1));
            if (v <= 0) return tss[0];
            if (v >= vMax) return tss[tss.length - 1];
            let lo = 0, hi = vts.length - 1;
            while (hi - lo > 1) {
                const mid = (lo + hi) >> 1;
                if (vts[mid] <= v) lo = mid;
                else hi = mid;
            }
            const f = (v - vts[lo]) / (vts[hi] - vts[lo] || 1);
            return tss[lo] + (tss[hi] - tss[lo]) * f;
        };

        const tickCount = 8;
        const tickLen = maxDim * 0.02;
        const labelOff = maxDim * 0.05;
        for (let i = 0; i <= tickCount; i++) {
            const t = i / tickCount;
            const pos = aMin + (aMax - aMin) * t;
            const tickGeo = new THREE.BufferGeometry().setFromPoints([
                main(pos).add(cross(-tickLen)), main(pos).add(cross(tickLen)),
            ]);
            axisGroup.add(new THREE.Line(tickGeo, axisMat));

            const labelDiv = document.createElement('div');
            labelDiv.className = 'gengit3d-tick';
            if (graph.axis.mode === 'time' && graph.axis.tMin && graph.axis.tMax) {
                labelDiv.textContent = fmtDate(new Date(vMax ? v2t(t * vMax) : graph.axis.tMin + spanMs * t));
            } else {
                labelDiv.textContent = `${Math.round(t * 100)}%`;
            }
            const label = new CSS2DObject(labelDiv);
            // horizontal axis: labels below; vertical axis: labels on the right
            label.position.copy(main(pos).add(cross(horizontal ? -labelOff : labelOff)));
            axisGroup.add(label);
        }
        scene.add(axisGroup);
    }

    // ---- selection highlight ----
    let selectedNode: any = null;
    let hoverNode: any = null;
    const highlightMat = new THREE.MeshBasicMaterial({ color: theme.selection, transparent: true, opacity: 0.3 });
    let highlightMesh: THREE.Mesh | null = null;

    // ---- hover glow: soft halo tracking the commit under the cursor ----
    const hoverMat = new THREE.MeshBasicMaterial({
        color: theme.selection,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
    });
    const hoverGlow = new THREE.Mesh(new THREE.SphereGeometry(3.2, 14, 10), hoverMat);
    hoverGlow.visible = false;
    scene.add(hoverGlow);

    // ---- raycasting for click selection ----
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let mouseDownPos = { x: 0, y: 0 };

    renderer.domElement.addEventListener('pointerdown', (e) => {
        mouseDownPos = { x: e.clientX, y: e.clientY };
        // L'utilisateur reprend la main sur la caméra — le film continue
        // (les nœuds continuent de pop) mais le suivi s'arrête.
        replayFollow = false;
    });

    renderer.domElement.addEventListener('pointerup', (e) => {
        // Only treat as click if pointer didn't move much (not a drag)
        const dx = e.clientX - mouseDownPos.x;
        const dy = e.clientY - mouseDownPos.y;
        if (Math.sqrt(dx * dx + dy * dy) > 5) return;

        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(shapeMeshes);
        if (intersects.length > 0) {
            const idx = hitNode(intersects[0]);
            if (idx !== undefined && idx < graph.nodes.length) {
                const node = graph.nodes[idx];
                selectedNode = node;
                if (highlightMesh) {
                    scene.remove(highlightMesh);
                    highlightMesh.geometry.dispose();
                }
                highlightMesh = new THREE.Mesh(haloGeoFor(node, 1.6), highlightMat);
                highlightMesh.position.set(node.x, node.y, node.z);
                scene.add(highlightMesh);
                // Pas d'auto-zoom : la caméra reste là où l'utilisateur
                // l'a mise — le panneau détail s'ouvre, le cadre ne bouge pas.
                if (onSelect) {
                    onSelect(node, { repo: graph.source?.repo });
                }
            }
        } else {
            selectedNode = null;
            if (highlightMesh) {
                scene.remove(highlightMesh);
                highlightMesh.geometry.dispose();
                highlightMesh = null;
            }
        }
    });

    // ---- hover tooltip : vraie carte de lecture — glyphe+hash+tag,
    // sujet, auteur·date·branche, churn·fichiers ----
    const glyphOf = (n: any) =>
        ({ merge: '◆', root: '▲', uncommitted: '■', stash: '▶', empty: '◇' } as any)[nodeShapeOf(n)] || '●';
    const mkCard = (cssBase: string) => {
        const el = document.createElement('div');
        el.style.cssText = cssBase;
        const t = document.createElement('div'); // titre : glyphe + hash + tag
        t.style.cssText = 'color:var(--accent);font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        const s = document.createElement('div'); // sujet complet
        s.style.cssText = 'margin-top:2px;white-space:normal;line-height:1.35;';
        const m = document.createElement('div'); // auteur · date · branche
        m.style.cssText = 'margin-top:5px;color:var(--muted);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        const x = document.createElement('div'); // churn · fichiers
        x.style.cssText = 'color:var(--muted);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        el.append(t, s, m, x);
        document.body.appendChild(el);
        return { el, t, s, m, x };
    };
    const fillCard = (l: { t: HTMLElement; s: HTMLElement; m: HTMLElement; x: HTMLElement }, n: any) => {
        const d = n.date ? new Date(n.date) : null;
        const dateTxt = d && !isNaN(d.getTime())
            ? d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
            : '';
        l.t.textContent = `${glyphOf(n)} ${n.short}` + (n.tags?.length ? `  ⚐ ${n.tags[0]}` : '');
        l.s.textContent = n.subject;
        l.m.textContent = `${n.author}${dateTxt ? ' · ' + dateTxt : ''}` + (n.branch ? ` · ${n.branch}` : '');
        l.x.textContent = n.churn
            ? `Δ ${n.churn} lines · ${n.files?.length || 0} file(s)`
            : n.files?.length ? `${n.files.length} file(s)` : '';
        l.x.style.display = l.x.textContent ? '' : 'none';
    };
    const tooltipCard = mkCard(
        'position:fixed;pointer-events:none;background:var(--panel);color:var(--text);' +
        'padding:7px 10px;border-radius:8px;font:11px monospace;z-index:10;display:none;' +
        'max-width:340px;border:1px solid var(--border);box-shadow:0 4px 18px #0008;'
    );
    const tooltipDiv = tooltipCard.el;

    renderer.domElement.addEventListener('pointermove', (e) => {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(shapeMeshes);
        if (intersects.length > 0) {
            const idx = hitNode(intersects[0]);
            if (idx !== undefined && idx < graph.nodes.length) {
                const node = graph.nodes[idx];
                tooltipDiv.style.display = 'block';
                tooltipDiv.style.left = (e.clientX + 12) + 'px';
                tooltipDiv.style.top = (e.clientY + 12) + 'px';
                fillCard(tooltipCard, node);
                hoverNode = node;
                // Le glow épouse la forme du nœud (losange, cube…)
                const shape = nodeShapeOf(node);
                if (hoverGlow.userData.shape !== shape) {
                    hoverGlow.geometry.dispose();
                    hoverGlow.geometry = haloGeoFor(node, 2.0);
                    hoverGlow.userData.shape = shape;
                }
                hoverGlow.position.set(node.x, node.y, node.z);
                hoverGlow.visible = true;
            }
        } else {
            tooltipDiv.style.display = 'none';
            hoverGlow.visible = false;
            hoverNode = null;
        }
    });

    // ---- étiquettes "film" : CHAQUE commit révélé porte un tag éphémère
    // (~2.8 s), pas seulement le front — sinon les rafales de pops
    // simultanés sont illisibles. Pool de 8 divs recyclées (borne le clutter).
    const MTIP_MAX = 8;
    const MTIP_LIFE = 2800; // ms — fondu sur les 800 derniers
    const mtipPool: { el: HTMLDivElement; node: any; born: number }[] = [];
    const mtipDivs: HTMLDivElement[] = [];
    for (let i = 0; i < MTIP_MAX; i++) {
        const el = document.createElement('div');
        el.style.cssText =
            'position:fixed;pointer-events:none;background:var(--overlay);color:var(--text);' +
            'padding:2px 7px;border-radius:4px;font:10px monospace;z-index:9;display:none;' +
            'max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
            'border:1px solid var(--border);';
        document.body.appendChild(el);
        mtipDivs.push(el);
        mtipPool.push({ el, node: null, born: 0 });
    }
    // Tag "en cours de lecture" — épinglé au commit du dwell courant,
    // bordure accent, pas de fade : c'est LUI qu'on est censé lire.
    const presentCard = mkCard(
        'position:fixed;pointer-events:none;background:var(--panel);color:var(--text);' +
        'padding:6px 12px;border-radius:8px;font:12px monospace;z-index:10;display:none;' +
        'max-width:420px;border:1px solid var(--accent);box-shadow:0 2px 12px #0009;'
    );
    const presentEl = presentCard.el;
    let presentShown: any = null;
    let movieGlow = false; // true si le halo a été posé par le film

    // ---- Étiquettes permanentes : merges + tags — les "story beats" du
    // repo. Pool borné : les ~24 plus proches de la caméra, jamais plus.
    const NL_MAX = 24;
    let labelsOn = false;
    const nlDivs: HTMLDivElement[] = [];
    for (let i = 0; i < NL_MAX; i++) {
        const el = document.createElement('div');
        el.style.cssText =
            'position:fixed;pointer-events:none;background:var(--overlay);color:var(--text);' +
            'padding:1px 6px;border-radius:4px;font:10px monospace;z-index:8;display:none;' +
            'white-space:nowrap;border:1px solid var(--border);opacity:.92;';
        document.body.appendChild(el);
        nlDivs.push(el);
    }
    const labeled = graph.nodes.filter(
        (n: any) => (n.parents?.length ?? 0) >= 2 || (n.tags && n.tags.length)
    );
    function updateNodeLabels() {
        if (!labelsOn) {
            for (const el of nlDivs) if (el.style.display !== 'none') el.style.display = 'none';
            return;
        }
        const rect = renderer.domElement.getBoundingClientRect();
        const cands: { n: any; x: number; y: number; z: number }[] = [];
        for (const n of labeled) {
            if (!nodeVisible(n) || replayK(n) <= 0) continue;
            _tipProj.set(n.x, n.y, n.z).project(camera);
            if (_tipProj.z > 1) continue;
            const x = (_tipProj.x * 0.5 + 0.5) * rect.width;
            const y = (-_tipProj.y * 0.5 + 0.5) * rect.height;
            if (x < -40 || x > rect.width + 40 || y < -20 || y > rect.height + 20) continue;
            cands.push({ n, x, y, z: _tipProj.z });
        }
        cands.sort((pa, pb) => pa.z - pb.z);
        for (let i = 0; i < NL_MAX; i++) {
            const el = nlDivs[i];
            const c = cands[i];
            if (!c) {
                if (el.style.display !== 'none') el.style.display = 'none';
                continue;
            }
            const txt = c.n.tags?.length ? `⚐ ${c.n.tags[0]}` : `◆ ${c.n.short}`;
            if (el.textContent !== txt) el.textContent = txt;
            el.style.display = 'block';
            el.style.left = rect.left + c.x + 10 + 'px';
            el.style.top = rect.top + c.y - 22 + 'px';
        }
    }

    // ---- Étiquettes de tips de branches : le DERNIER commit de chaque
    // branche, étiqueté nom + hash + sujet — les repères du graphe. On par
    // défaut (toggle "tips" de la barre), bornées aux ~32 plus proches de
    // la caméra. Plusieurs branches sur le même tip se décalent en pile.
    const TL_MAX = 32;
    let tipLabelsOn = true;
    const tipEntries: { br: any; n: any; css: string }[] = [];
    for (const br of graph.branches) {
        const n: any = br.tip ? nodeById.get(br.tip) : null;
        if (!n) continue; // tip hors du graphe rendu (maxCommits, ref orpheline)
        const hex = n.isTip && n.tipType ? (TIP_COLORS[n.tipType] ?? 0xff8c42) : colorOf(br.id);
        tipEntries.push({ br, n, css: '#' + hex.toString(16).padStart(6, '0') });
    }
    const tlDivs: { el: HTMLDivElement; nm: HTMLDivElement; sb: HTMLDivElement; text: string }[] = [];
    for (let i = 0; i < Math.min(TL_MAX, tipEntries.length); i++) {
        const el = document.createElement('div');
        el.style.cssText =
            'position:fixed;pointer-events:none;background:var(--overlay);color:var(--text);' +
            'padding:2px 8px;border-radius:5px;font:10px monospace;z-index:9;display:none;' +
            'border:1px solid var(--border);border-left-width:3px;max-width:280px;opacity:.95;';
        const nm = document.createElement('div'); // nom de branche (couleur)
        nm.style.cssText = 'font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        const sb = document.createElement('div'); // hash · sujet (description)
        sb.style.cssText = 'color:var(--muted);font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        el.append(nm, sb);
        document.body.appendChild(el);
        tlDivs.push({ el, nm, sb, text: '' });
    }
    function updateTipLabels() {
        if (!tipLabelsOn) {
            for (const d of tlDivs) if (d.el.style.display !== 'none') d.el.style.display = 'none';
            return;
        }
        const rect = renderer.domElement.getBoundingClientRect();
        const tlc: { e: any; x: number; y: number; z: number }[] = [];
        for (const e of tipEntries) {
            const n = e.n;
            if (lastBranchSet && !lastBranchSet.has(e.br.id)) continue;
            if (lastAuthorSet && !lastAuthorSet.has(n.author)) continue;
            if (replayK(n) <= 0) continue; // pas encore révélé par le film
            _tipProj.set(n.x, n.y, n.z).project(camera);
            if (_tipProj.z > 1) continue; // derrière la caméra
            const x = (_tipProj.x * 0.5 + 0.5) * rect.width;
            const y = (-_tipProj.y * 0.5 + 0.5) * rect.height;
            if (x < -60 || x > rect.width + 60 || y < -30 || y > rect.height + 30) continue;
            tlc.push({ e, x, y, z: _tipProj.z });
        }
        tlc.sort((pa, pb) => pa.z - pb.z);
        const stacked = new Map<string, number>();
        for (let i = 0; i < tlDivs.length; i++) {
            const d = tlDivs[i];
            const c = tlc[i];
            if (!c) {
                if (d.el.style.display !== 'none') d.el.style.display = 'none';
                continue;
            }
            const row = stacked.get(c.e.n.id) || 0;
            stacked.set(c.e.n.id, row + 1);
            const txt = `⎇ ${c.e.br.name}|${c.e.n.short} · ${c.e.n.subject}`;
            if (d.text !== txt) {
                d.text = txt;
                const cut = txt.indexOf('|');
                d.nm.textContent = txt.slice(0, cut);
                d.sb.textContent = txt.slice(cut + 1);
                d.nm.style.color = c.e.css;
                d.el.style.borderLeftColor = c.e.css;
            }
            d.el.style.display = 'block';
            d.el.style.left = rect.left + c.x + 12 + 'px';
            d.el.style.top = rect.top + c.y - 14 + row * 32 + 'px';
        }
    }

    let lastFrontIdx = -1;
    let mtipCursor = -1;
    const _tipProj = new THREE.Vector3();
    function updateMovieTip() {
        updateNodeLabels(); // labels permanentes merges/tags (si activées)
        updateTipLabels(); // cartes de tips de branches (derniers commits)
        const now = performance.now();
        // Tag du commit présenté (dwell) — toujours affiché tant qu'il est
        // devant la caméra ; texte mis à jour seulement au changement de nœud.
        if (movieLive && presentNode) {
            // Halo pulsant sur le nœud présenté — on sait quelle sphère lire
            const pshape = nodeShapeOf(presentNode);
            if (hoverGlow.userData.shape !== pshape) {
                hoverGlow.geometry.dispose();
                hoverGlow.geometry = haloGeoFor(presentNode, 2.0);
                hoverGlow.userData.shape = pshape;
            }
            hoverGlow.position.set(presentNode.x, presentNode.y, presentNode.z);
            hoverGlow.visible = true;
            movieGlow = true;
            _tipProj.set(presentNode.x, presentNode.y, presentNode.z).project(camera);
            if (_tipProj.z <= 1) {
                if (presentShown !== presentNode) {
                    presentShown = presentNode;
                    fillCard(presentCard, presentNode);
                    presentCard.t.textContent = '▸ ' + presentCard.t.textContent;
                }
                const rect = renderer.domElement.getBoundingClientRect();
                const x = rect.left + (_tipProj.x * 0.5 + 0.5) * rect.width;
                const y = rect.top + (-_tipProj.y * 0.5 + 0.5) * rect.height;
                presentEl.style.display = 'block';
                presentEl.style.left = Math.min(Math.max(x + 16, 6), Math.max(rect.width - 400, 6)) + 'px';
                presentEl.style.top = Math.min(Math.max(y - 48, 6), Math.max(rect.height - 56, 6)) + 'px';
            } else {
                presentEl.style.display = 'none';
            }
        } else {
            presentEl.style.display = 'none';
            presentShown = null;
            if (movieGlow) {
                hoverGlow.visible = false;
                movieGlow = false;
            }
        }
        if (!movieLive || frontIdx < 0) {
            if (lastFrontIdx >= 0) {
                for (const s of mtipPool) {
                    s.node = null;
                    s.el.style.display = 'none';
                }
                lastFrontIdx = -1;
            }
            return;
        }
        if (frontIdx < lastFrontIdx) {
            // retour en arrière / redémarrage : purge — un tag sur un nœud
            // pas encore révélé flotterait sur du vide
            for (const s of mtipPool) {
                s.node = null;
                s.el.style.display = 'none';
            }
            lastFrontIdx = -1;
        }
        // Un tag par nœud nouvellement révélé depuis la frame précédente —
        // le commit présenté porte déjà son tag dédié, pas de doublon.
        for (let i = lastFrontIdx + 1; i <= frontIdx; i++) {
            if (sortedByKey[i] === presentNode) continue;
            const slot = mtipPool[(++mtipCursor) % MTIP_MAX];
            slot.node = sortedByKey[i];
            slot.born = now;
            const glyph = { merge: '◆', root: '▲', uncommitted: '■', stash: '▶', empty: '◇' }[nodeShapeOf(slot.node)] || '●';
            const d = slot.node.date ? new Date(slot.node.date) : null;
            const dateTxt = d && !isNaN(d.getTime())
                ? ' · ' + d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
                : '';
            slot.el.textContent = `${glyph} ${slot.node.short} ${slot.node.subject} — ${slot.node.author}${dateTxt}`;
        }
        lastFrontIdx = frontIdx;
        const rect = renderer.domElement.getBoundingClientRect();
        for (const s of mtipPool) {
            if (!s.node) continue;
            const age = now - s.born;
            if (age > MTIP_LIFE) {
                s.node = null;
                s.el.style.display = 'none';
                continue;
            }
            _tipProj.set(s.node.x, s.node.y, s.node.z).project(camera);
            if (_tipProj.z > 1) {
                s.el.style.display = 'none'; // derrière la caméra
                continue;
            }
            const x = rect.left + (_tipProj.x * 0.5 + 0.5) * rect.width;
            const y = rect.top + (-_tipProj.y * 0.5 + 0.5) * rect.height;
            s.el.style.opacity = age > MTIP_LIFE - 800 ? String((MTIP_LIFE - age) / 800) : '1';
            s.el.style.display = 'block';
            s.el.style.left = Math.min(Math.max(x + 12, 6), Math.max(rect.width - 270, 6)) + 'px';
            s.el.style.top = Math.min(Math.max(y - 8, 6), Math.max(rect.height - 30, 6)) + 'px';
        }
    }

    // ---- node/edge filter + re-tint helper ----
    // Filtres composables : branche + auteur. Un nœud n'est visible que s'il
    // passe les deux ; une arête que si ses deux bouts le sont.
    let lastBranchSet: Set<string> | null = null;
    let lastAuthorSet: Set<string> | null = null;
    const NV = new THREE.Vector3();
    const IDQ = new THREE.Quaternion();
    const SCL = new THREE.Vector3();
    const ZERO = new THREE.Vector3(0, 0, 0);
    const nodeVisible = (n: any) =>
        (!lastBranchSet || lastBranchSet.has(n.branch)) &&
        (!lastAuthorSet || lastAuthorSet.has(n.author));
    function applyEdgeFilter() {
        // Hide commit spheres on filtered-out nodes (scale-0 instances) ;
        // replayP < 1 : les nœuds pas encore "lus" grandissent de 0 → plein.
        for (const sm of shapeMeshes) {
            const idxs = sm.userData.nodeIndex as number[];
            for (let j = 0; j < idxs.length; j++) {
                const n = graph.nodes[idxs[j]];
                const rv = replayK(n);
                const s = nodeVisible(n) ? nodeScale * rv * churnScale(n) : 0;
                m4.compose(NV.set(n.x, n.y, n.z), IDQ, SCL.set(s, s, s));
                sm.setMatrixAt(j, m4);
            }
            sm.instanceMatrix.needsUpdate = true;
        }
        let vi = 0;
        let lenSum = 0, lenCnt = 0;
        for (const e of solidEdges) {
            if (vi >= nEdges) break;
            const s = nodeById.get(e.source);
            const t = nodeById.get(e.target);
            if (!s || !t || !nodeVisible(s) || !nodeVisible(t)) continue;
            if (Math.max(s._tk ?? 0, t._tk ?? 0) > replayP) continue; // arête révélée quand ses 2 bouts le sont
            a.set(s.x, s.y, s.z);
            b.set(t.x, t.y, t.z);
            dir.subVectors(b, a);
            const len = dir.length() || 0.001;
            lenSum += len;
            lenCnt++;
            mid.addVectors(a, b).multiplyScalar(0.5);
            q.setFromUnitVectors(up, dir.clone().normalize());
            m.compose(mid, q, new THREE.Vector3(edgeW(s), len, edgeW(s)));
            edgesVisible.setMatrixAt(vi, m);
            edgesVisible.setColorAt(vi, nodeColorOf(s));
            vi++;
        }
        edgesHidden.count = 0;
        edgesVisible.count = vi;
        edgesVisible.instanceMatrix.needsUpdate = true;
        edgesVisible.instanceColor.needsUpdate = true;
        // Zoom caméra du film : ~2.5 espacements de commits, borné
        if (lenCnt) followDist = Math.min(Math.max((lenSum / lenCnt) * 2.5, 12), 120);
        updateReplayFocus();
    }

    // Re-tint complet — mode couleur / hotspot / thème : nœuds via
    // nodeColorOf (tient compte de colorMode + remote + hotspot), arêtes
    // reconstruites par applyEdgeFilter.
    function retintNow() {
        for (const sm of shapeMeshes) {
            const idxs = sm.userData.nodeIndex as number[];
            for (let j = 0; j < idxs.length; j++) {
                col.copy(nodeColorOf(graph.nodes[idxs[j]]));
                sm.setColorAt(j, col);
            }
            sm.instanceColor.needsUpdate = true;
        }
        applyEdgeFilter();
    }

    // ---- post-processing effects, built lazily ----
    let composer: EffectComposer | null = null;
    let bloomPass: UnrealBloomPass | null = null;
    // on light themes the pale background is already bright — soften bloom
    // so the whole canvas doesn't wash out
    const bgLuma = () => {
        const hsl = { h: 0, s: 0, l: 0 };
        new THREE.Color(theme.background).getHSL(hsl);
        return hsl.l;
    };
    // Uniforms 'resolution' des ShaderPass — certains attendent la taille du
    // buffer (abs), d'autres le texel (inv). Resynchronisés au resize.
    const resSyncs: { u: { value: any }; mode: 'abs' | 'inv' }[] = [];
    function syncFxRes() {
        const sz = renderer.getDrawingBufferSize(new THREE.Vector2());
        for (const r of resSyncs) {
            if (r.mode === 'inv') r.u.value.set(1 / sz.x, 1 / sz.y);
            else r.u.value.set(sz.x, sz.y);
        }
    }
    function shaderFx(shader: any, uniforms: Record<string, any> = {}, resName?: string, resMode: 'abs' | 'inv' = 'abs') {
        const p = new ShaderPass(shader);
        for (const [k, v] of Object.entries(uniforms)) {
            if (p.uniforms[k]) p.uniforms[k].value = v;
        }
        if (resName && p.uniforms[resName]) resSyncs.push({ u: p.uniforms[resName], mode: resMode });
        return p;
    }
    // Sharpen = ConvolutionShader avec un kernel 3×3 (defines propres, on ne
    // touche pas au module three partagé). uImageIncrement = texel (inv).
    const SHARPEN_SHADER = {
        ...ConvolutionShader,
        defines: { KERNEL_SIZE_FLOAT: '9.0', KERNEL_SIZE_INT: '9' },
    };
    // Effets orientés LISIBILITÉ : chaque passe doit préserver l'information
    // du graphe (couleurs de branches, lisibilité des nœuds). Pas de gimmicks
    // qui détruisent l'image (glitch, kaléidoscope, pixelisation…).
    const FX_BUILDERS: Record<string, () => any[]> = {
        bloom: () => {
            const strength = bgLuma() > 0.5 ? 0.4 : 0.85;
            bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), strength, 0.55, 0.72);
            return [bloomPass];
        },
        trails: () => [new AfterimagePass(0.92)],
        fxaa: () => [shaderFx(FXAAShader, {}, 'resolution', 'inv')],
        sharpen: () => [
            shaderFx(
                SHARPEN_SHADER,
                { cKernel: [0, -0.35, 0, -0.35, 2.4, -0.35, 0, -0.35, 0] },
                'uImageIncrement',
                'inv'
            ),
        ],
        vignette: () => [shaderFx(VignetteShader, { offset: 1.25, darkness: 1.4 })],
        contrast: () => [shaderFx(BrightnessContrastShader, { brightness: 0.02, contrast: 0.4 })],
        tiltshift: () => [
            shaderFx(HorizontalTiltShiftShader, { h: 0.008, r: 0.5 }),
            shaderFx(VerticalTiltShiftShader, { v: 0.008, r: 0.5 }),
        ],
        bokeh: () => [
            new BokehPass(scene, camera, {
                focus: camera.position.distanceTo(controls.target),
                aperture: 0.00018,
                maxblur: 0.012,
            }),
        ],
    };
    function disposeComposer() {
        if (!composer) return;
        for (const p of composer.passes) (p as any).dispose?.();
        (composer as any).dispose?.();
        composer = null;
        bloomPass = null;
        resSyncs.length = 0;
    }
    function setEffect(mode: string) {
        if (mode === 'none' || !mode) {
            disposeComposer();
            return;
        }
        disposeComposer();
        const build = FX_BUILDERS[mode];
        if (!build) return;
        composer = new EffectComposer(renderer);
        composer.addPass(new RenderPass(scene, camera));
        for (const p of build()) composer.addPass(p);
        composer.addPass(new OutputPass()); // correct colour space through the chain
        composer.setSize(container.clientWidth || width, container.clientHeight || height);
        syncFxRes();
    }

    // ---- animation loop ----
    let animationId: number;
    function animate() {
        animationId = requestAnimationFrame(animate);
        stepCamAnim();
        updateMovieTip();
        if (replayFollow && !camAnim.active) {
            // Glide vers le commit en cours : pendant le dwell la cible EST
            // le commit présenté (zoom lecture) ; sinon le centroïde du
            // front (avec un lead vers les commits à venir). La distance
            // converge vers eff — recul compensé si le panneau est étroit.
            const presenting = !!presentNode;
            const eff = presenting ? presentDist() : followDistEff();
            const px = controls.target.x, py = controls.target.y, pz = controls.target.z;
            if (presenting) tmpTarget.set(presentNode.x, presentNode.y, presentNode.z);
            else tmpTarget.copy(focusPos);
            tmpTarget.addScaledVector(axisDir, eff * (presenting ? 0.05 : 0.15));
            // Lerp plus rapide en mode lecture : le dwell de 1,5 s doit
            // laisser du temps "stable" pour lire, pas tout passer en vol.
            controls.target.lerp(tmpTarget, presenting ? 0.12 : 0.06);
            camera.position.x += controls.target.x - px;
            camera.position.y += controls.target.y - py;
            camera.position.z += controls.target.z - pz;
            const d = camera.position.distanceTo(controls.target);
            // Converge dans les 2 sens : pendant le suivi la caméra est au
            // film — un drag souris ou un décochage de 'cam' rend la main.
            if (Math.abs(d - eff) > eff * 0.02) {
                const nd = d + (eff - d) * (presenting ? 0.10 : 0.05);
                camera.position.sub(controls.target).multiplyScalar(nd / d).add(controls.target);
            }
        }
        if (!camAnim.active) controls.update();
        const t = performance.now() * 0.001;
        if (highlightMesh) {
            const s = 1 + 0.14 * Math.sin(t * 4.2);
            highlightMesh.scale.setScalar(s * nodeScale);
            highlightMat.opacity = 0.22 + 0.14 * (0.5 + 0.5 * Math.sin(t * 4.2));
        }
        if (hoverGlow.visible) hoverGlow.scale.setScalar((1 + 0.18 * Math.sin(t * 5.5)) * nodeScale);
        if (composer) composer.render();
        else renderer.render(scene, camera);
        labelRenderer.render(scene, camera);
    }
    animate();

    // ---- resize handler ----
    function onResize() {
        const w = container.clientWidth || 800;
        const h = container.clientHeight || 600;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        labelRenderer.setSize(w, h);
        if (composer) {
            composer.setSize(w, h);
            syncFxRes();
        }
    }
    window.addEventListener('resize', onResize);

    // ---- public API ----
    const api = {
        dispose() {
            cancelAnimationFrame(animationId);
            disposeComposer();
            window.removeEventListener('resize', onResize);
            renderer.forceContextLoss(); // libère vraiment le contexte WebGL
            renderer.dispose();
            // CSS2DRenderer n'a pas de dispose() avant three r167 — un appel
            // direct tuait draw() au 2e rendu (panel blanc au changement de vue)
            (labelRenderer as any).dispose?.();
            tooltipDiv.remove();
            presentEl.remove();
            for (const d of mtipDivs) d.remove();
            for (const d of nlDivs) d.remove();
            for (const d of tlDivs) d.el.remove();
            if (highlightMesh) {
                highlightMesh.geometry.dispose();
            }
            scene.traverse((obj: any) => {
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) {
                    if (Array.isArray(obj.material)) {
                        obj.material.forEach((m: any) => m.dispose());
                    } else {
                        obj.material.dispose();
                    }
                }
            });
        },
        setAutoRotate(val: boolean) {
            controls.autoRotate = val;
        },
        setTheme(name: string) {
            // Mise à jour EN PLACE — pas de rebuild de scène (sinon nouveau
            // contexte WebGL à chaque changement de thème → freeze/context loss)
            theme = getTheme(name);
            scene.background = new THREE.Color(theme.background);
            const fogCol = theme.fogColor ?? theme.background;
            scene.fog = new THREE.Fog(fogCol, maxDim * theme.fog[0], maxDim * theme.fog[1]);
            ambient.color.set(theme.lights.ambient[0]);
            ambient.intensity = theme.lights.ambient[1];
            key.color.set(theme.lights.key[0]);
            key.intensity = theme.lights.key[1];
            fill.color.set(theme.lights.fill[0]);
            fill.intensity = theme.lights.fill[1];
            rim.color.set(theme.lights.rim[0]);
            rim.intensity = theme.lights.rim[1];
            edgeMatVisible.opacity = edgeOpacity; // conserve le réglage utilisateur
            if (axisMat) axisMat.color.set(theme.axis);
            highlightMat.color.set(theme.selection);
            hoverMat.color.set(theme.selection);
            if (bloomPass) bloomPass.strength = bgLuma() > 0.5 ? 0.4 : 0.85;
            // re-tint : recede + palette branches dépendent du thème
            RECEDE = new THREE.Color(theme.recede);
            colorCache.clear();
            branchColorMap = assignBranchColors(graph, { avoidHex: theme.background, palette: theme.palette });
            for (const sm of shapeMeshes) {
                const idxs = sm.userData.nodeIndex as number[];
                for (let j = 0; j < idxs.length; j++) {
                    col.copy(nodeColorOf(graph.nodes[idxs[j]]));
                    sm.setColorAt(j, col);
                }
                sm.instanceColor.needsUpdate = true;
            }
            applyEdgeFilter();
        },
        setBranchFilter(visible: Set<string> | null) {
            lastBranchSet = visible;
            applyEdgeFilter();
        },
        setAuthorFilter(visible: Set<string> | null) {
            lastAuthorSet = visible;
            applyEdgeFilter();
        },
        setEdgeOpacity(v: number) {
            edgeOpacity = v;
            edgeMatVisible.opacity = v;
            dashedMat.opacity = 0.7 * v;
            if (simMat) simMat.opacity = 0.4 * v;
        },
        setNodeSize(v: number) {
            nodeScale = v;
            applyEdgeFilter();
        },
        setReplay(p: number, live = false, presentId?: string) {
            movieLive = !!live;
            presentNode = presentId !== undefined ? (nodeById.get(presentId) ?? null) : presentNode;
            if (p === replayP) return;
            replayP = p;
            applyEdgeFilter();
            rebuildSegs();
            updateReplayFocus(); // frontNode suivi par le tooltip "film"
        },
        setReplayFollow(v: boolean) {
            replayFollow = !!v;
            if (replayFollow) updateReplayFocus();
        },
        setSpacing(v: number) {
            const k = spacing ? v / spacing : 1; // ratio appliqué à la caméra
            spacing = v;
            // Espacement ENTRE commits : on étire uniquement l'axe du temps
            // (y, ou x en vue chronological) — les positions des branches en
            // xz ne bougent pas, l'environnement ne gonfle pas.
            const horiz = graph.axis?.orient === 'x';
            for (const n of graph.nodes) {
                n.x = horiz ? n.bx * v : n.bx;
                n.y = horiz ? n.by : n.by * v;
                n.z = n.bz;
            }
            applyEdgeFilter(); // rebuild nœuds + arêtes visibles
            rebuildSegs(); // tips + liens similaires
            // L'axe est construit sur les positions à initSpacing → échelle
            // relative v/initSpacing (évite un double étirement au 1er load)
            const av = v / initSpacing;
            if (axisGroup) axisGroup.scale.set(horiz ? av : 1, horiz ? 1 : av, 1);
            (scene.fog as THREE.Fog).near = spacingBaseDim * theme.fog[0] * v;
            (scene.fog as THREE.Fog).far = spacingBaseDim * theme.fog[1] * v;
            rim.distance = spacingBaseDim * 6 * v;
            // La caméra "monte" avec l'étirement : translation pure le long
            // de l'axe du temps — le quartier regardé reste cadré au lieu
            // de voir le graphe sortir de l'écran ("black render" à 800 %).
            if (k !== 1 && !camAnim.active) {
                const d = horiz ? controls.target.x * (k - 1) : controls.target.y * (k - 1);
                if (horiz) {
                    controls.target.x *= k;
                    camera.position.x += d;
                } else {
                    controls.target.y *= k;
                    camera.position.y += d;
                }
            }
            if (highlightMesh && selectedNode) {
                highlightMesh.position.set(selectedNode.x, selectedNode.y, selectedNode.z);
            }
            if (hoverGlow.visible && hoverNode) {
                hoverGlow.position.set(hoverNode.x, hoverNode.y, hoverNode.z);
            }
        },
        /**
         * Frame the graph with an animated camera flight.
         * @param {'visible'|'all'|'selection'|'top'|'front'|'side'|'iso'} mode
         *   visible/all keep the current view direction; top/front/side/iso
         *   jump to a canonical axis; selection flies to the clicked commit.
         */
        fitView(mode: string = 'visible') {
            const curDir = () => camera.position.clone().sub(controls.target).normalize();
            if (mode === 'selection') {
                if (!selectedNode) return; // nothing selected — keep the shot
                const c = new THREE.Vector3(selectedNode.x, selectedNode.y, selectedNode.z);
                const d = Math.max(maxDim * 0.12, 60);
                flyTo(c.clone().addScaledVector(curDir(), d), c, 650);
                return;
            }
            let center: THREE.Vector3;
            let dist: number;
            if (mode === 'visible') {
                // Cadre les commits VISIBLES (filtres branches/auteurs inclus) :
                // centre = barycentre, rayon = 95e percentile (robuste aux outliers).
                let n = 0, cx = 0, cy = 0, cz = 0;
                for (const nd of graph.nodes) {
                    if (!nodeVisible(nd)) continue;
                    n++;
                    cx += nd.x;
                    cy += nd.y;
                    cz += nd.z;
                }
                if (!n) {
                    flyTo(homePos, homeTarget);
                    return;
                }
                cx /= n;
                cy /= n;
                cz /= n;
                const ds: number[] = [];
                for (const nd of graph.nodes) {
                    if (nodeVisible(nd)) ds.push(Math.hypot(nd.x - cx, nd.y - cy, nd.z - cz));
                }
                ds.sort((a, b) => a - b);
                const r = Math.max(ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.95))], 10);
                center = new THREE.Vector3(cx, cy, cz);
                dist = (r / Math.tan((camera.fov * Math.PI) / 360)) * 1.35;
            } else {
                const pool = mode === 'all' ? graph.nodes : graph.nodes.filter(nodeVisible);
                const frame = frameNodes(pool.length ? pool : graph.nodes);
                if (!frame) return;
                center = frame.center;
                dist = frame.dist;
            }
            const dirV = FIT_DIRS[mode] ? FIT_DIRS[mode].clone().normalize() : curDir();
            flyTo(center.clone().addScaledVector(dirV, dist), center);
        },
        resetCamera() {
            api.fitView('visible');
        },
        setEffect(mode: string) {
            setEffect(mode);
        },
        setDateFilter(from: number | null, to: number | null) {
            // Filter nodes by date range
            if (from === null && to === null) {
                edgesVisible.count = ei;
                edgesVisible.instanceMatrix.needsUpdate = true;
                return;
            }
            let vi = 0;
            for (let i = 0; i < solidEdges.length; i++) {
                const e = solidEdges[i];
                const s = nodeById.get(e.source);
                const t = nodeById.get(e.target);
                if (!s || !t) continue;
                const sTime = Date.parse(s.date);
                const tTime = Date.parse(t.date);
                if (from !== null && (sTime < from || tTime < from)) continue;
                if (to !== null && (sTime > to || tTime > to)) continue;
                a.set(s.x, s.y, s.z);
                b.set(t.x, t.y, t.z);
                dir.subVectors(b, a);
                const len = dir.length() || 0.001;
                mid.addVectors(a, b).multiplyScalar(0.5);
                q.setFromUnitVectors(up, dir.clone().normalize());
                m.compose(mid, q, new THREE.Vector3(edgeW(s), len, edgeW(s)));
                edgesVisible.setMatrixAt(vi, m);
                edgesVisible.setColorAt(vi, nodeColorOf(s));
                vi++;
            }
            edgesVisible.count = vi;
            edgesVisible.instanceMatrix.needsUpdate = true;
            edgesVisible.instanceColor.needsUpdate = true;
        },
        setTipsVisible(visible: boolean) {
            dashedGroup.visible = visible;
        },
        setColorMode(mode: string) {
            if (mode !== 'branch' && mode !== 'author' && mode !== 'age') return;
            if (mode === colorMode) return;
            colorMode = mode;
            retintNow();
        },
        setHotspot(ids: string[] | null) {
            hotspotSet = ids && ids.length ? new Set(ids) : null;
            retintNow();
        },
        setLabelsVisible(on: boolean) {
            labelsOn = !!on;
            if (!labelsOn) for (const el of nlDivs) el.style.display = 'none';
        },
        setTipLabelsVisible(on: boolean) {
            tipLabelsOn = !!on;
            if (!tipLabelsOn) for (const d of tlDivs) d.el.style.display = 'none';
        },
    };
    return api;
}
