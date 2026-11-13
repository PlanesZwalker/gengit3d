// scene.js — three.js scene for the git commit graph.
// Renders commits as solid spheres (colored by branch) and parent links as
// tube edges, so the cloud reads as volumetric matter rather than a flat plane.
// Adds a dated timeline axis and click-to-inspect selection.
// Runs in the browser only (imports 'three', a browser/ESM build).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { getTheme } from './themes.js';
import { assignBranchColors } from './branch-colors.js';

/**
 * Build and render the graph into a container element.
 * @param {HTMLElement} container
 * @param {object} graph  output of gitlog.parseGitLog (post-layout)
 * @param {object|string} [opts]  { themeName, onSelect, autoRotate, timeline }
 *                                (a bare string is accepted as themeName)
 */
export function renderGraph(container, graph, opts) {
    if (typeof opts === 'string') opts = { themeName: opts };
    opts = opts || {};
    const theme = getTheme(opts.themeName);
    const showTimeline = opts.timeline !== false;
    const onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : null;

    // assign a distinct color to every branch (mutates branch.color)
    // avoidHex: colors also stay maximally distant from the theme background
    const branchColorMap = assignBranchColors(graph, { avoidHex: theme.background, palette: theme.palette });

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
    const fitDist = (maxDim / 2 / Math.tan((camera.fov * Math.PI) / 360)) * 1.25;
    camera.position.set(center.x + fitDist * 0.55, center.y + fitDist * 0.35, center.z + fitDist * 0.9);
    camera.lookAt(center);
    const homePos = camera.position.clone();
    const homeTarget = center.clone();

    // depth fog tuned to the actual cloud size. On light themes the fog colour is
    // a MID tone (not the pale background) so distant strands stay readable.
    const fogCol = theme.fogColor != null ? theme.fogColor : theme.background;
    scene.fog = new THREE.Fog(fogCol, maxDim * theme.fog[0], maxDim * theme.fog[1]);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    // CSS2D overlay for crisp HTML timeline labels (respects theme via CSS)
    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(width, height);
    Object.assign(labelRenderer.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' });
    container.appendChild(labelRenderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = !!opts.autoRotate; // off by default so the timeline stays put
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
    function flyTo(toPos, toTgt, dur = 750) {
        camAnim.active = true;
        camAnim.t0 = performance.now();
        camAnim.dur = dur;
        camAnim.fromPos.copy(camera.position);
        camAnim.toPos.copy(toPos);
        camAnim.fromTgt.copy(controls.target);
        camAnim.toTgt.copy(toTgt);
        controls.enabled = false;
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
    function frameNodes(nodes) {
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
    const FIT_DIRS = {
        top: new THREE.Vector3(0.02, 1, 0.02),
        front: new THREE.Vector3(0.02, 0.12, 1),
        side: new THREE.Vector3(1, 0.12, 0.02),
        iso: new THREE.Vector3(0.55, 0.35, 0.9),
    };
    // last node-level filter applied by the toolbar — used by fit 'visible'
    let lastNodeFilter = null;

    // intro: swoop in from far out instead of popping into existence
    if (opts.intro !== false) {
        const dirV = homePos.clone().sub(homeTarget).normalize();
        camera.position.copy(homeTarget).addScaledVector(dirV, fitDist * 3.4);
        flyTo(homePos, homeTarget, 1100);
    }

    // lights — key + fill + rim so spheres read as solid matter (per theme)
    scene.add(new THREE.AmbientLight(theme.lights.ambient[0], theme.lights.ambient[1]));
    const key = new THREE.DirectionalLight(theme.lights.key[0], theme.lights.key[1]);
    key.position.set(1, 1.4, 1.2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(theme.lights.fill[0], theme.lights.fill[1]);
    fill.position.set(-1.2, -0.4, -1);
    scene.add(fill);
    const rim = new THREE.PointLight(theme.lights.rim[0], theme.lights.rim[1], maxDim * 6);
    rim.position.set(0, maxDim * 0.6, maxDim * 0.9);
    scene.add(rim);

    const nodeById = new Map(graph.nodes.map(n => [n.id, n]));
    const colorOf = branchId => branchColorMap.get(branchId) ?? 0x4f9dff;
    // Synthetic tip nodes (stash/empty-branch) get a distinct color
    const TIP_COLORS = { stash: 0xff8c42, 'empty-branch': 0x8b93a7, uncommitted: 0xf2c14e };
    const tipColorOf = n => {
        if (n.isTip && n.tipType) return TIP_COLORS[n.tipType] ?? 0xff8c42;
        return null;
    };

    // prominence: the big branches keep their colour, the long tail recedes
    const branchesSorted = [...graph.branches].sort((a, b) => b.commits - a.commits);
    const rankOf = new Map(branchesSorted.map((b, i) => [b.id, i]));
    const PROMINENT = 36;
    const RECEDE = new THREE.Color(theme.recede);
    const colorCache = new Map();
    const isMajor = branchId => (rankOf.get(branchId) ?? 9999) < PROMINENT;
    const tintOf = branchId => {
        let c = colorCache.get(branchId);
        if (c) return c;
        c = new THREE.Color(colorOf(branchId));
        if (!isMajor(branchId)) c.lerp(RECEDE, theme.recedeAmount); // long tail -> toward background
        colorCache.set(branchId, c);
        return c;
    };
    // Node-level color override for synthetic tips
    const nodeColorOf = n => {
        const tipC = tipColorOf(n);
        if (tipC !== null) return new THREE.Color(tipC);
        return tintOf(n.branch);
    };
    // white per-vertex colour so USE_COLOR * instanceColor tints correctly
    // (without it three.js reads a default (0,0,0) attribute -> black meshes)
    const whiteAttr = geo =>
        geo.setAttribute(
            'color',
            new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 3).fill(1), 3)
        );

    // ---- edges as tubes (real geometry, catches light -> matter) ----
    // Two meshes: visible (opacity 1.0) and hidden (opacity 0.1) for filtering
    // Dashed edges (stash/empty-branch tips) use THREE.Line + LineDashedMaterial
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
    const MAX_EDGE_INSTANCES = 120000;
    const solidEdges = graph.edges.filter(e => !e.dashed);
    const dashedEdges = graph.edges.filter(e => e.dashed);
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
        m.compose(mid, q, new THREE.Vector3(1, len, 1));
        edgesVisible.setMatrixAt(ei, m);
        edgesVisible.setColorAt(ei, tintOf(s.branch));
        ei++;
    }
    edgesVisible.count = ei;
    edgesHidden.count = 0;
    edgesVisible.instanceMatrix.needsUpdate = true;
    edgesVisible.instanceColor.needsUpdate = true;
    edgeGroup.add(edgesVisible);
    edgeGroup.add(edgesHidden);

    // ---- dashed edges (stash/empty-branch tips) ----
    const dashedGroup = new THREE.Group();
    const dashedMat = new THREE.LineDashedMaterial({
        color: 0xff8c42,
        dashSize: 4,
        gapSize: 3,
        transparent: true,
        opacity: 0.7,
    });
    if (dashedEdges.length > 0) {
        const positions = new Float32Array(dashedEdges.length * 6);
        let pi = 0;
        for (const e of dashedEdges) {
            const s = nodeById.get(e.source);
            const t = nodeById.get(e.target);
            if (!s || !t) continue;
            positions[pi++] = s.x; positions[pi++] = s.y; positions[pi++] = s.z;
            positions[pi++] = t.x; positions[pi++] = t.y; positions[pi++] = t.z;
        }
        if (pi > 0) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, pi), 3));
            const seg = new THREE.LineSegments(geo, dashedMat);
            seg.computeLineDistances();
            dashedGroup.add(seg);
        }
    }
    edgeGroup.add(dashedGroup);
    scene.add(edgeGroup);

    // ---- nodes as instanced spheres (one draw call, real volume) ----
    // Two meshes: visible (opacity 1.0) and hidden (opacity 0.1) for filtering
    // LOD: reduce sphere segments for large graphs to keep FPS acceptable
    const nodeSegments = graph.nodes.length > 20000 ? 8 : graph.nodes.length > 5000 ? 10 : 14;
    const nodeRings = graph.nodes.length > 20000 ? 6 : graph.nodes.length > 5000 ? 8 : 12;
    const nodeGeo = whiteAttr(new THREE.SphereGeometry(1, nodeSegments, nodeRings));
    const nodeMatVisible = new THREE.MeshStandardMaterial({
        roughness: 0.32,
        metalness: 0.25,
        vertexColors: true,
        transparent: true,
        opacity: 1.0,
    });
    const nodeMatHidden = new THREE.MeshStandardMaterial({
        roughness: 0.32,
        metalness: 0.25,
        vertexColors: true,
        transparent: true,
        opacity: 0.1,
    });
    const nodesVisible = new THREE.InstancedMesh(nodeGeo, nodeMatVisible, graph.nodes.length);
    const nodesHidden = new THREE.InstancedMesh(nodeGeo, nodeMatHidden, graph.nodes.length);
    nodesVisible.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    nodesHidden.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    nodesVisible.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(graph.nodes.length * 3), 3);
    nodesHidden.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(graph.nodes.length * 3), 3);
    // radius scales with how busy a commit is (merge hubs look heavier)
    const childCount = new Map();
    for (const e of graph.edges) childCount.set(e.target, (childCount.get(e.target) || 0) + 1);
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const idq = new THREE.Quaternion();
    const baseRadius = n => {
        if (n.isTip) return 3.5; // synthetic tips are slightly larger
        return 2.2 + Math.min(childCount.get(n.id) || 0, 6) * 0.5;
    };
    // slot↔node maps: filters compact visible instances, so a raycast slot is
    // NOT the node index — keep the mapping fresh in every filter function
    const slotToNode = new Int32Array(graph.nodes.length);
    const nodeToSlot = new Int32Array(graph.nodes.length);
    const writeNodeMatrix = i => {
        const slot = nodeToSlot[i];
        if (slot < 0 || slot >= nodesVisible.count) return; // node is filtered out
        const n = graph.nodes[i];
        const r = baseRadius(n) * (i === selectedIndex ? 1.7 : 1);
        pos.set(n.x, n.y, n.z);
        scl.set(r, r, r);
        m.compose(pos, idq, scl);
        nodesVisible.setMatrixAt(slot, m);
    };
    let selectedIndex = -1;
    graph.nodes.forEach((n, i) => {
        const r = baseRadius(n);
        pos.set(n.x, n.y, n.z);
        scl.set(r, r, r);
        m.compose(pos, idq, scl);
        nodesVisible.setMatrixAt(i, m);
        nodesVisible.setColorAt(i, nodeColorOf(n));
        slotToNode[i] = i;
        nodeToSlot[i] = i;
        n._r = r;
    });
    nodesVisible.count = graph.nodes.length;
    nodesHidden.count = 0;
    nodesVisible.instanceMatrix.needsUpdate = true;
    nodesVisible.instanceColor.needsUpdate = true;
    scene.add(nodesVisible);
    scene.add(nodesHidden);

    // ---- selection marker (halo around the clicked commit) ----
    const selMat = new THREE.MeshBasicMaterial({
        color: theme.selection,
        transparent: true,
        opacity: 0.85,
        wireframe: true,
    });
    const selection = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), selMat);
    selection.visible = false;
    selection.userData.baseR = 1; // base radius, pulsed in animate()
    scene.add(selection);

    // ---- hover glow: soft halo tracking the commit under the cursor ----
    const hoverMat = new THREE.MeshBasicMaterial({
        color: theme.selection,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
    });
    const hoverGlow = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), hoverMat);
    hoverGlow.visible = false;
    scene.add(hoverGlow);

    // ---- timeline axis along the layout's time dimension ----
    const horizontal = graph.axis && graph.axis.orient === 'x';
    let vMin = Infinity,
        vMax = -Infinity;
    for (const n of graph.nodes) {
        const v = horizontal ? n.x : n.y;
        if (v < vMin) vMin = v;
        if (v > vMax) vMax = v;
    }
    if (!isFinite(vMin)) {
        vMin = -1;
        vMax = 1;
    }
    const axisGroup = new THREE.Group();
    if (showTimeline) {
        const mk = v => (horizontal ? new THREE.Vector3(v, 0, 0) : new THREE.Vector3(0, v, 0));
        const axisGeo = new THREE.BufferGeometry().setFromPoints([mk(vMin), mk(vMax)]);
        axisGroup.add(
            new THREE.Line(axisGeo, new THREE.LineBasicMaterial({ color: theme.axis, transparent: true, opacity: 0.9 }))
        );

        // ticks map linearly onto the data range; date labels adapt to span
        const isTime = graph.axis && graph.axis.mode === 'time';
        const tMin = isTime ? graph.axis.tMin : 0, tMax = isTime ? graph.axis.tMax : 1;
        const spanMs = tMax - tMin;
        const day = 86400000;
        // compressed visual scale -> real date (inverse of layout's t2v)
        const vts = graph.axis && graph.axis.vtimes, tss = graph.axis && graph.axis.times;
        const vMax = vts && vts.length ? vts[vts.length - 1] : 0;
        const v2t = v => {
            if (!vts || !tss || !vMax) return tMin + spanMs * v;
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
        const fmtTick = t => {
            if (!isTime) {
                const byV = [...graph.nodes].filter(n => n.date).sort((p, r) => (horizontal ? p.x - r.x : p.y - r.y));
                return (byV[Math.round(t * (byV.length - 1))]?.date || '').slice(0, 10);
            }
            const d = new Date(vMax ? v2t(t * vMax) : tMin + spanMs * t);
            return spanMs > 730 * day ? d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
                 : spanMs > 45 * day ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
                 : spanMs > 2 * day ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
                 : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        };
        const TICKS = 7;
        const tickGeo = whiteAttr(new THREE.SphereGeometry(1.4, 8, 6));
        const tickMat = new THREE.MeshBasicMaterial({ color: theme.axis });
        const ticks = new THREE.InstancedMesh(tickGeo, tickMat, TICKS);
        let ti = 0;
        for (let k = 0; k < TICKS; k++) {
            const t = k / (TICKS - 1);
            const v = vMin + (vMax - vMin) * t;
            pos.copy(mk(v));
            scl.set(1, 1, 1);
            m.compose(pos, idq, scl);
            ticks.setMatrixAt(ti++, m);
            const el = document.createElement('div');
            el.className = 'gengit3d-tick';
            el.textContent = fmtTick(t);
            const label = new CSS2DObject(el);
            label.position.copy(mk(v)).add(horizontal ? new THREE.Vector3(0, -8, 0) : new THREE.Vector3(8, 0, 0));
            axisGroup.add(label);
        }
        ticks.count = ti;
        ticks.instanceMatrix.needsUpdate = true;
        axisGroup.add(ticks);
        scene.add(axisGroup);
    }

    // raycaster for hover tooltips + click selection
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const tooltip =
        document.getElementById('gengit3d-tooltip') ||
        (() => {
            const el = document.createElement('div');
            el.id = 'gengit3d-tooltip';
            el.style.cssText =
                'position:absolute;pointer-events:none;padding:4px 8px;border-radius:4px;font:12px monospace;display:none;z-index:10;';
            document.body.appendChild(el);
            return el;
        })();
    // tooltip colours come from the theme (dark tooltip on light themes and vice-versa)
    tooltip.style.background = theme.ui.tooltipBg;
    tooltip.style.color = theme.ui.tooltipText;
    tooltip.style.border = '1px solid ' + theme.ui.border;

    function pick(ev) {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        const hits = raycaster.intersectObject(nodesVisible, false);
        if (hits.length) {
            const idx = slotToNode[hits[0].instanceId];
            return graph.nodes[idx] ? { idx, node: graph.nodes[idx] } : null;
        }
        return null;
    }

    function onMove(ev) {
        const hit = pick(ev);
        if (hit) {
            tooltip.style.display = 'block';
            tooltip.style.left = ev.clientX + 12 + 'px';
            tooltip.style.top = ev.clientY + 12 + 'px';
            tooltip.textContent = `${hit.node.short} ${hit.node.author}: ${hit.node.subject.slice(0, 60)}`;
            document.body.style.cursor = 'pointer';
            hoverGlow.position.set(hit.node.x, hit.node.y, hit.node.z);
            hoverGlow.userData.baseS = hit.node._r * 1.9 + 1;
            hoverGlow.scale.setScalar(hoverGlow.userData.baseS);
            hoverGlow.visible = true;
            return;
        }
        tooltip.style.display = 'none';
        document.body.style.cursor = 'default';
        hoverGlow.visible = false;
    }
    renderer.domElement.addEventListener('mousemove', onMove);

    function select(idx) {
        const prev = selectedIndex;
        selectedIndex = idx;
        if (prev >= 0 && prev !== idx) writeNodeMatrix(prev); // shrink the old pick back
        if (idx < 0) {
            selection.visible = false;
        } else {
            const n = graph.nodes[idx];
            selection.visible = true;
            selection.position.set(n.x, n.y, n.z);
            const rr = baseRadius(n) * 2.4;
            selection.userData.baseR = rr;
            selection.scale.set(rr, rr, rr);
            writeNodeMatrix(idx);
        }
        nodesVisible.instanceMatrix.needsUpdate = true;
    }

    function onClick(ev) {
        const hit = pick(ev);
        if (!hit) return;
        select(hit.idx);
        api.fitView('selection'); // auto-zoom on the clicked commit
        if (onSelect) onSelect(hit.node, { repo: graph.source?.repo || graph.repoDir || null });
    }
    // distinguish a click from an orbit drag
    let downX = 0,
        downY = 0;
    renderer.domElement.addEventListener('pointerdown', ev => {
        downX = ev.clientX;
        downY = ev.clientY;
    });
    renderer.domElement.addEventListener('pointerup', ev => {
        if (Math.abs(ev.clientX - downX) > 4 || Math.abs(ev.clientY - downY) > 4) return; // was a drag
        onClick(ev);
    });

    // ---- branch tip labels: the LAST commit of every branch, tagged with
    // name + hash + subject — the graph's landmarks. On by default (toolbar
    // "tips" checkbox), capped at the ~32 nearest to the camera. Branches
    // sharing the same tip commit stack vertically to stay readable.
    const TL_MAX = 32;
    let tipLabelsOn = true;
    const tipEntries = [];
    for (const br of graph.branches) {
        const n = br.tip ? nodeById.get(br.tip) : null;
        if (!n) continue; // tip outside the rendered graph (maxCommits, orphan ref)
        const hex = n.isTip && n.tipType ? (TIP_COLORS[n.tipType] ?? 0xff8c42) : colorOf(br.id);
        tipEntries.push({ br, n, css: '#' + hex.toString(16).padStart(6, '0') });
    }
    const tlDivs = [];
    for (let i = 0; i < Math.min(TL_MAX, tipEntries.length); i++) {
        const el = document.createElement('div');
        el.style.cssText =
            'position:fixed;pointer-events:none;background:var(--overlay);color:var(--text);' +
            'padding:2px 8px;border-radius:5px;font:10px monospace;z-index:9;display:none;' +
            'border:1px solid var(--border);border-left-width:3px;max-width:280px;opacity:.95;';
        const nm = document.createElement('div'); // branch name (coloured)
        nm.style.cssText = 'font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        const sb = document.createElement('div'); // hash · subject (description)
        sb.style.cssText = 'color:var(--muted);font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        el.append(nm, sb);
        document.body.appendChild(el);
        tlDivs.push({ el, nm, sb, text: '' });
    }
    const tipProj = new THREE.Vector3();
    function updateTipLabels() {
        if (!tipLabelsOn) {
            for (const d of tlDivs) if (d.el.style.display !== 'none') d.el.style.display = 'none';
            return;
        }
        const rect = renderer.domElement.getBoundingClientRect();
        const cands = [];
        for (const e of tipEntries) {
            const n = e.n;
            if (lastNodeFilter && !lastNodeFilter(n)) continue; // filtered out (ghosted)
            tipProj.set(n.x, n.y, n.z).project(camera);
            if (tipProj.z > 1) continue; // behind the camera
            const x = (tipProj.x * 0.5 + 0.5) * rect.width;
            const y = (-tipProj.y * 0.5 + 0.5) * rect.height;
            if (x < -60 || x > rect.width + 60 || y < -30 || y > rect.height + 30) continue;
            cands.push({ e, x, y, z: tipProj.z });
        }
        cands.sort((pa, pb) => pa.z - pb.z);
        const stacked = new Map();
        for (let i = 0; i < tlDivs.length; i++) {
            const d = tlDivs[i];
            const c = cands[i];
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

    // resize
    function onResize() {
        const w = container.clientWidth || 800;
        const h = container.clientHeight || 600;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        labelRenderer.setSize(w, h);
        if (composer) composer.setSize(w, h);
    }
    window.addEventListener('resize', onResize);

    // ---- post-processing effects (bloom / trails), built lazily ----
    let composer = null;
    let bloomPass = null;
    // on light themes the pale background is already bright — soften bloom
    // so the whole canvas doesn't wash out
    const bgLuma = () => {
        const hsl = { h: 0, s: 0, l: 0 };
        new THREE.Color(theme.background).getHSL(hsl);
        return hsl.l;
    };
    function disposeComposer() {
        if (!composer) return;
        for (const p of composer.passes) p.dispose?.();
        composer.dispose?.();
        composer = null;
        bloomPass = null;
    }
    function setEffect(mode) {
        if (mode === 'none' || !mode) {
            disposeComposer();
            return;
        }
        disposeComposer();
        composer = new EffectComposer(renderer);
        composer.addPass(new RenderPass(scene, camera));
        if (mode === 'bloom') {
            bloomPass = new UnrealBloomPass(
                new THREE.Vector2(width, height),
                bgLuma() > 0.5 ? 0.4 : 0.85,
                0.55,
                0.72
            );
            composer.addPass(bloomPass);
        } else if (mode === 'trails') {
            composer.addPass(new AfterimagePass(0.92));
        }
        composer.addPass(new OutputPass()); // correct colour space through the chain
        composer.setSize(container.clientWidth || width, container.clientHeight || height);
    }

    // animate
    let raf = 0;
    function animate() {
        raf = requestAnimationFrame(animate);
        stepCamAnim();
        updateTipLabels(); // branch tip cards (last commit of each branch)
        if (!camAnim.active) controls.update();
        const t = performance.now() * 0.001;
        if (selection.visible) {
            const r = selection.userData.baseR * (1 + 0.12 * Math.sin(t * 4.2));
            selection.scale.setScalar(r);
            selMat.opacity = 0.6 + 0.3 * (0.5 + 0.5 * Math.sin(t * 4.2));
        }
        if (hoverGlow.visible) {
            hoverGlow.scale.setScalar(hoverGlow.userData.baseS * (1 + 0.15 * Math.sin(t * 5.5)));
        }
        if (composer) composer.render();
        else renderer.render(scene, camera);
        labelRenderer.render(scene, camera);
    }
    animate();

    // stats overlay
    const stats = document.getElementById('gengit3d-stats');
    if (stats) {
        stats.textContent = `commits: ${graph.nodes.length} | branches: ${graph.branches.length} | edges: ${graph.edges.length} | head: ${graph.head?.slice(0, 7) ?? '?'}`;
    }

    // Store base matrices for filtering (avoid re-reading from InstancedMesh)
    const baseNodeMatrices = new Float32Array(graph.nodes.length * 16);
    const baseEdgeMatrices = new Float32Array(nEdges * 16);
    for (let i = 0; i < graph.nodes.length; i++) {
        nodesVisible.getMatrixAt(i, m);
        m.toArray(baseNodeMatrices, i * 16);
    }
    for (let i = 0; i < ei; i++) {
        edgesVisible.getMatrixAt(i, m);
        m.toArray(baseEdgeMatrices, i * 16);
    }

    const api = {
        scene,
        camera,
        renderer,
        controls,
        nodes: nodesVisible,
        edges: edgesVisible,
        nodesHidden,
        edgesHidden,
        labelRenderer,
        theme: opts.themeName || 'midnight',
        select,
        setAutoRotate(on) {
            controls.autoRotate = !!on;
        },
        toggleTimeline(on) {
            axisGroup.visible = !!on;
        },
        /**
         * Show/hide synthetic tip nodes (stash/empty-branch) and their dashed edges.
         * @param {boolean} visible
         */
        setTipsVisible(visible) {
            lastNodeFilter = n => visible || !n.isTip;
            // Filter nodes: hide synthetic tips
            let vi = 0,
                hi = 0;
            for (let i = 0; i < graph.nodes.length; i++) {
                const n = graph.nodes[i];
                const isTip = n.isTip;
                const show = visible || !isTip;
                m.fromArray(baseNodeMatrices, i * 16);
                if (show) {
                    nodesVisible.setMatrixAt(vi, m);
                    nodesVisible.setColorAt(vi, nodeColorOf(n));
                    slotToNode[vi] = i;
                    nodeToSlot[i] = vi;
                    vi++;
                } else {
                    nodesHidden.setMatrixAt(hi, m);
                    nodesHidden.setColorAt(hi, nodeColorOf(n));
                    nodeToSlot[i] = -1;
                    hi++;
                }
            }
            nodesVisible.count = vi;
            nodesHidden.count = hi;
            nodesVisible.instanceMatrix.needsUpdate = true;
            nodesVisible.instanceColor.needsUpdate = true;
            nodesHidden.instanceMatrix.needsUpdate = true;
            nodesHidden.instanceColor.needsUpdate = true;
            // Filter edges: hide dashed edges
            let evi = 0,
                ehi = 0;
            for (let i = 0; i < ei; i++) {
                const e = graph.edges[i];
                const isDashed = e.dashed;
                const show = visible || !isDashed;
                const s = nodeById.get(e.source);
                if (!s) continue;
                m.fromArray(baseEdgeMatrices, i * 16);
                if (show) {
                    edgesVisible.setMatrixAt(evi, m);
                    edgesVisible.setColorAt(evi, tintOf(s.branch));
                    evi++;
                } else {
                    edgesHidden.setMatrixAt(ehi, m);
                    edgesHidden.setColorAt(ehi, tintOf(s.branch));
                    ehi++;
                }
            }
            edgesVisible.count = evi;
            edgesHidden.count = ehi;
            edgesVisible.instanceMatrix.needsUpdate = true;
            edgesVisible.instanceColor.needsUpdate = true;
            edgesHidden.instanceMatrix.needsUpdate = true;
            edgesHidden.instanceColor.needsUpdate = true;
            // Toggle dashed line group visibility
            dashedGroup.visible = visible;
        },
        /**
         * Filter branches by visibility. Nodes/edges of hidden branches are
         * moved to the hidden mesh (opacity 0.1); visible ones stay in the
         * visible mesh (opacity 1.0).
         * @param {Set<string>|null} visibleBranchIds  null = show all
         */
        setBranchFilter(visibleBranchIds) {
            lastNodeFilter = n => !visibleBranchIds || visibleBranchIds.has(n.branch);
            let vi = 0,
                hi = 0;
            for (let i = 0; i < graph.nodes.length; i++) {
                const n = graph.nodes[i];
                const isVisible = !visibleBranchIds || visibleBranchIds.has(n.branch);
                m.fromArray(baseNodeMatrices, i * 16);
                if (isVisible) {
                    nodesVisible.setMatrixAt(vi, m);
                    nodesVisible.setColorAt(vi, tintOf(n.branch));
                    slotToNode[vi] = i;
                    nodeToSlot[i] = vi;
                    vi++;
                } else {
                    nodesHidden.setMatrixAt(hi, m);
                    nodesHidden.setColorAt(hi, tintOf(n.branch));
                    nodeToSlot[i] = -1;
                    hi++;
                }
            }
            nodesVisible.count = vi;
            nodesHidden.count = hi;
            nodesVisible.instanceMatrix.needsUpdate = true;
            nodesVisible.instanceColor.needsUpdate = true;
            nodesHidden.instanceMatrix.needsUpdate = true;
            nodesHidden.instanceColor.needsUpdate = true;
            // edges
            let evi = 0,
                ehi = 0;
            for (let i = 0; i < ei; i++) {
                const e = graph.edges[i];
                const s = nodeById.get(e.source);
                if (!s) continue;
                m.fromArray(baseEdgeMatrices, i * 16);
                const isVisible = !visibleBranchIds || visibleBranchIds.has(s.branch);
                if (isVisible) {
                    edgesVisible.setMatrixAt(evi, m);
                    edgesVisible.setColorAt(evi, tintOf(s.branch));
                    evi++;
                } else {
                    edgesHidden.setMatrixAt(ehi, m);
                    edgesHidden.setColorAt(ehi, tintOf(s.branch));
                    ehi++;
                }
            }
            edgesVisible.count = evi;
            edgesHidden.count = ehi;
            edgesVisible.instanceMatrix.needsUpdate = true;
            edgesVisible.instanceColor.needsUpdate = true;
            edgesHidden.instanceMatrix.needsUpdate = true;
            edgesHidden.instanceColor.needsUpdate = true;
        },
        /**
         * Filter nodes/edges by date range. Nodes outside [minDate, maxDate]
         * are moved to the hidden mesh (opacity 0.1).
         * @param {number|null} minDate  timestamp ms, or null
         * @param {number|null} maxDate  timestamp ms, or null
         */
        setDateFilter(minDate, maxDate) {
            lastNodeFilter = n => {
                const t = Date.parse(n.date);
                return !Number.isFinite(t) || ((!minDate || t >= minDate) && (!maxDate || t <= maxDate));
            };
            let vi = 0,
                hi = 0;
            for (let i = 0; i < graph.nodes.length; i++) {
                const n = graph.nodes[i];
                const t = Date.parse(n.date);
                const inRange = !Number.isFinite(t) || ((!minDate || t >= minDate) && (!maxDate || t <= maxDate));
                m.fromArray(baseNodeMatrices, i * 16);
                if (inRange) {
                    nodesVisible.setMatrixAt(vi, m);
                    nodesVisible.setColorAt(vi, tintOf(n.branch));
                    slotToNode[vi] = i;
                    nodeToSlot[i] = vi;
                    vi++;
                } else {
                    nodesHidden.setMatrixAt(hi, m);
                    nodesHidden.setColorAt(hi, tintOf(n.branch));
                    nodeToSlot[i] = -1;
                    hi++;
                }
            }
            nodesVisible.count = vi;
            nodesHidden.count = hi;
            nodesVisible.instanceMatrix.needsUpdate = true;
            nodesVisible.instanceColor.needsUpdate = true;
            nodesHidden.instanceMatrix.needsUpdate = true;
            nodesHidden.instanceColor.needsUpdate = true;
            // edges
            let evi = 0,
                ehi = 0;
            for (let i = 0; i < ei; i++) {
                const e = graph.edges[i];
                const s = nodeById.get(e.source);
                if (!s) continue;
                const t = Date.parse(s.date);
                const inRange = !Number.isFinite(t) || ((!minDate || t >= minDate) && (!maxDate || t <= maxDate));
                m.fromArray(baseEdgeMatrices, i * 16);
                if (inRange) {
                    edgesVisible.setMatrixAt(evi, m);
                    edgesVisible.setColorAt(evi, tintOf(s.branch));
                    evi++;
                } else {
                    edgesHidden.setMatrixAt(ehi, m);
                    edgesHidden.setColorAt(ehi, tintOf(s.branch));
                    ehi++;
                }
            }
            edgesVisible.count = evi;
            edgesHidden.count = ehi;
            edgesVisible.instanceMatrix.needsUpdate = true;
            edgesVisible.instanceColor.needsUpdate = true;
            edgesHidden.instanceMatrix.needsUpdate = true;
            edgesHidden.instanceColor.needsUpdate = true;
        },
        /**
         * Frame the graph with an animated camera flight.
         * @param {'visible'|'all'|'selection'|'top'|'front'|'side'|'iso'} mode
         *   visible/all keep the current view direction; top/front/side/iso
         *   jump to a canonical axis; selection flies to the clicked commit.
         */
        fitView(mode = 'visible') {
            const curDir = () => camera.position.clone().sub(controls.target).normalize();
            if (mode === 'selection') {
                if (selectedIndex < 0) return; // nothing selected — keep the shot
                const nd = graph.nodes[selectedIndex];
                const c = new THREE.Vector3(nd.x, nd.y, nd.z);
                const d = Math.max(maxDim * 0.12, 60);
                flyTo(c.clone().addScaledVector(curDir(), d), c, 650);
                return;
            }
            const pool =
                mode === 'all' ? graph.nodes
                : lastNodeFilter ? graph.nodes.filter(lastNodeFilter)
                : graph.nodes;
            const frame = frameNodes(pool.length ? pool : graph.nodes);
            if (!frame) return;
            const dirV = FIT_DIRS[mode] ? FIT_DIRS[mode].clone().normalize() : curDir();
            flyTo(frame.center.clone().addScaledVector(dirV, frame.dist), frame.center);
        },
        resetCamera() {
            api.fitView('visible');
        },
        setEffect(mode) {
            setEffect(mode);
        },
        /**
         * Show/hide the branch tip labels (last-commit cards).
         * @param {boolean} on
         */
        setTipLabelsVisible(on) {
            tipLabelsOn = !!on;
            if (!tipLabelsOn) for (const d of tlDivs) d.el.style.display = 'none';
        },
        dispose() {
            cancelAnimationFrame(raf);
            disposeComposer();
            for (const d of tlDivs) d.el.remove(); // appended to body, not container
            controls.dispose();
            renderer.dispose();
        },
    };
    // Expose handles for debugging/inspection from the browser dev tools.
    // NOTE: this runs in the browser — never reference `process.env` here
    // (Node globals are undefined in a page and throw a ReferenceError).
    window.__gengit3d = api;
    return api;
}
