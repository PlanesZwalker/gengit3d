// scene.js — three.js scene for the git commit graph.
// Renders commits as solid spheres (colored by branch) and parent links as
// tube edges, so the cloud reads as volumetric matter rather than a flat plane.
// Adds a dated timeline axis and click-to-inspect selection.
// Runs in the browser only (imports 'three', a browser/ESM build).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { getTheme } from './themes.js';

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
    const PALETTE = theme.palette;
    const showTimeline = opts.timeline !== false;
    const onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : null;

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
    const fitDist = (maxDim / 2) / Math.tan((camera.fov * Math.PI) / 360) * 1.25;
    camera.position.set(center.x + fitDist * 0.55, center.y + fitDist * 0.35, center.z + fitDist * 0.9);
    camera.lookAt(center);

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
    controls.autoRotate = !!opts.autoRotate;   // off by default so the timeline stays put
    controls.autoRotateSpeed = 0.45;
    controls.target.copy(center);

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

    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    const colorOf = (branchId) => PALETTE[(graph.branches.find((b) => b.id === branchId)?.color ?? 0) % PALETTE.length];

    // prominence: the big branches keep their colour, the long tail recedes
    const branchesSorted = [...graph.branches].sort((a, b) => b.commits - a.commits);
    const rankOf = new Map(branchesSorted.map((b, i) => [b.id, i]));
    const PROMINENT = 36;
    const RECEDE = new THREE.Color(theme.recede);
    const colorCache = new Map();
    const isMajor = (branchId) => (rankOf.get(branchId) ?? 9999) < PROMINENT;
    const tintOf = (branchId) => {
        let c = colorCache.get(branchId);
        if (c) return c;
        c = new THREE.Color(colorOf(branchId));
        if (!isMajor(branchId)) c.lerp(RECEDE, theme.recedeAmount); // long tail -> toward background
        colorCache.set(branchId, c);
        return c;
    };
    // white per-vertex colour so USE_COLOR * instanceColor tints correctly
    // (without it three.js reads a default (0,0,0) attribute -> black meshes)
    const whiteAttr = (geo) => geo.setAttribute(
        'color',
        new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 3).fill(1), 3),
    );

    // ---- edges as tubes (real geometry, catches light -> matter) ----
    const edgeGroup = new THREE.Group();
    const up = new THREE.Vector3(0, 1, 0);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const mid = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const m = new THREE.Matrix4();
    const edgeGeo = whiteAttr(new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1, true));
    const edgeMat = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.2, vertexColors: true, transparent: true, opacity: theme.edgeOpacity });
    const MAX_EDGE_INSTANCES = 120000;
    const nEdges = Math.min(graph.edges.length, MAX_EDGE_INSTANCES);
    const edges = new THREE.InstancedMesh(edgeGeo, edgeMat, nEdges);
    edges.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    edges.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(nEdges * 3), 3);
    let ei = 0;
    for (const e of graph.edges) {
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
        edges.setMatrixAt(ei, m);
        // colour the edge by the SOURCE commit's branch -> strands stay traceable
        edges.setColorAt(ei, tintOf(s.branch));
        ei++;
    }
    edges.count = ei;
    edges.instanceMatrix.needsUpdate = true;
    edges.instanceColor.needsUpdate = true;
    edgeGroup.add(edges);
    scene.add(edgeGroup);

    // ---- nodes as instanced spheres (one draw call, real volume) ----
    const nodeGeo = whiteAttr(new THREE.SphereGeometry(1, 14, 12));
    const nodeMat = new THREE.MeshStandardMaterial({ roughness: 0.32, metalness: 0.25, vertexColors: true });
    const nodes = new THREE.InstancedMesh(nodeGeo, nodeMat, graph.nodes.length);
    nodes.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    nodes.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(graph.nodes.length * 3), 3);
    // radius scales with how busy a commit is (merge hubs look heavier)
    const childCount = new Map();
    for (const e of graph.edges) childCount.set(e.target, (childCount.get(e.target) || 0) + 1);
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const idq = new THREE.Quaternion();
    const baseRadius = (n) => 2.2 + Math.min(childCount.get(n.id) || 0, 6) * 0.5;
    const writeNodeMatrix = (i) => {
        const n = graph.nodes[i];
        const r = baseRadius(n) * (i === selectedIndex ? 1.7 : 1);
        pos.set(n.x, n.y, n.z);
        scl.set(r, r, r);
        m.compose(pos, idq, scl);
        nodes.setMatrixAt(i, m);
    };
    let selectedIndex = -1;
    graph.nodes.forEach((n, i) => {
        const r = baseRadius(n);
        pos.set(n.x, n.y, n.z);
        scl.set(r, r, r);
        m.compose(pos, idq, scl);
        nodes.setMatrixAt(i, m);
        nodes.setColorAt(i, tintOf(n.branch));
        n._r = r;
    });
    nodes.instanceMatrix.needsUpdate = true;
    nodes.instanceColor.needsUpdate = true;
    scene.add(nodes);

    // ---- selection marker (halo around the clicked commit) ----
    const selMat = new THREE.MeshBasicMaterial({ color: theme.selection, transparent: true, opacity: 0.85, wireframe: true });
    const selection = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), selMat);
    selection.visible = false;
    scene.add(selection);

    // ---- timeline axis (vertical, history grows upward) with dated ticks ----
    let yMin = Infinity, yMax = -Infinity;
    for (const n of graph.nodes) { if (n.y < yMin) yMin = n.y; if (n.y > yMax) yMax = n.y; }
    if (!isFinite(yMin)) { yMin = -1; yMax = 1; }
    const axisGroup = new THREE.Group();
    if (showTimeline) {
        const axisGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, yMin, 0), new THREE.Vector3(0, yMax, 0),
        ]);
        axisGroup.add(new THREE.Line(axisGeo, new THREE.LineBasicMaterial({ color: theme.axis, transparent: true, opacity: 0.9 })));

        // sort nodes by y to map a tick to the nearest commit's date
        const byY = [...graph.nodes].filter((n) => n.date).sort((p, r) => p.y - r.y);
        const fmtDate = (iso) => (iso || '').slice(0, 10);
        const TICKS = 7;
        const tickGeo = whiteAttr(new THREE.SphereGeometry(1.4, 8, 6));
        const tickMat = new THREE.MeshBasicMaterial({ color: theme.axis });
        const ticks = new THREE.InstancedMesh(tickGeo, tickMat, TICKS);
        let ti = 0;
        for (let k = 0; k < TICKS; k++) {
            const y = yMin + ((yMax - yMin) * k) / (TICKS - 1);
            pos.set(0, y, 0); scl.set(1, 1, 1);
            m.compose(pos, idq, scl);
            ticks.setMatrixAt(ti++, m);
            // nearest commit by y -> its date
            let near = byY[0];
            for (const n of byY) { if (Math.abs(n.y - y) < Math.abs(near.y - y)) near = n; }
            const el = document.createElement('div');
            el.className = 'gengit3d-tick';
            el.textContent = fmtDate(near && near.date);
            const label = new CSS2DObject(el);
            label.position.set(0, y, 0);
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
    const tooltip = document.getElementById('gengit3d-tooltip') || (() => {
        const el = document.createElement('div');
        el.id = 'gengit3d-tooltip';
        el.style.cssText = 'position:absolute;pointer-events:none;padding:4px 8px;border-radius:4px;font:12px monospace;display:none;z-index:10;';
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
        const hits = raycaster.intersectObject(nodes, false);
        if (hits.length) {
            const idx = hits[0].instanceId;
            return graph.nodes[idx] ? { idx, node: graph.nodes[idx] } : null;
        }
        return null;
    }

    function onMove(ev) {
        const hit = pick(ev);
        if (hit) {
            tooltip.style.display = 'block';
            tooltip.style.left = (ev.clientX + 12) + 'px';
            tooltip.style.top = (ev.clientY + 12) + 'px';
            tooltip.textContent = `${hit.node.short} ${hit.node.author}: ${hit.node.subject.slice(0, 60)}`;
            document.body.style.cursor = 'pointer';
            return;
        }
        tooltip.style.display = 'none';
        document.body.style.cursor = 'default';
    }
    renderer.domElement.addEventListener('mousemove', onMove);

    function select(idx) {
        selectedIndex = idx;
        if (idx < 0) {
            selection.visible = false;
        } else {
            const n = graph.nodes[idx];
            selection.visible = true;
            selection.position.set(n.x, n.y, n.z);
            const rr = baseRadius(n) * 2.4;
            selection.scale.set(rr, rr, rr);
            writeNodeMatrix(idx);
            nodes.instanceMatrix.needsUpdate = true;
        }
    }

    function onClick(ev) {
        const hit = pick(ev);
        if (!hit) return;
        select(hit.idx);
        if (onSelect) onSelect(hit.node, { repo: graph.source?.repo || graph.repoDir || null });
    }
    // distinguish a click from an orbit drag
    let downX = 0, downY = 0;
    renderer.domElement.addEventListener('pointerdown', (ev) => { downX = ev.clientX; downY = ev.clientY; });
    renderer.domElement.addEventListener('pointerup', (ev) => {
        if (Math.abs(ev.clientX - downX) > 4 || Math.abs(ev.clientY - downY) > 4) return; // was a drag
        onClick(ev);
    });

    // resize
    function onResize() {
        const w = container.clientWidth || 800;
        const h = container.clientHeight || 600;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        labelRenderer.setSize(w, h);
    }
    window.addEventListener('resize', onResize);

    // animate
    let raf = 0;
    function animate() {
        raf = requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
        labelRenderer.render(scene, camera);
    }
    animate();

    // stats overlay
    const stats = document.getElementById('gengit3d-stats');
    if (stats) {
        stats.textContent = `commits: ${graph.nodes.length} | branches: ${graph.branches.length} | edges: ${graph.edges.length} | head: ${graph.head?.slice(0, 7) ?? '?'}`;
    }

    const api = {
        scene, camera, renderer, controls, nodes, edges, labelRenderer,
        theme: opts.themeName || 'midnight',
        select,
        setAutoRotate(on) { controls.autoRotate = !!on; },
        toggleTimeline(on) { axisGroup.visible = !!on; },
        dispose() { cancelAnimationFrame(raf); controls.dispose(); renderer.dispose(); },
    };
    // Expose handles for debugging/inspection from the browser dev tools.
    // NOTE: this runs in the browser — never reference `process.env` here
    // (Node globals are undefined in a page and throw a ReferenceError).
    window.__gengit3d = api;
    return api;
}
