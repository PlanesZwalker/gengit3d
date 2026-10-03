// scene.js — three.js scene for the git commit graph.
// Renders commits as solid spheres (colored by branch) and parent links as
// tube edges, so the cloud reads as volumetric matter rather than a flat plane.
// Runs in the browser only (imports 'three', a browser/ESM build).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const BRANCH_PALETTE = [
    0x4f9dff, // blue
    0x57c785, // green
    0xff8c42, // orange
    0xe05c75, // red
    0xb583ff, // purple
    0xf2c14e, // yellow
];

/**
 * Build and render the graph into a container element.
 * @param {HTMLElement} container
 * @param {object} graph  output of gitlog.parseGitLog (post-layout)
 */
export function renderGraph(container, graph) {
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0b10);

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

    // depth fog tuned to the actual cloud size so far strands visibly recede
    scene.fog = new THREE.Fog(0x0b0b10, maxDim * 0.45, maxDim * 2.1);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = true; // slow orbit reveals the volume
    controls.autoRotateSpeed = 0.45;
    controls.target.copy(center);

    // lights — key + fill + rim so spheres read as solid matter
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(1, 1.4, 1.2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.55);
    fill.position.set(-1.2, -0.4, -1);
    scene.add(fill);
    const rim = new THREE.PointLight(0xff9a5c, 0.9, maxDim * 6);
    rim.position.set(0, maxDim * 0.6, maxDim * 0.9);
    scene.add(rim);

    const nodeById = new Map(graph.nodes.map(n => [n.id, n]));
    const colorOf = branchId =>
        BRANCH_PALETTE[(graph.branches.find(b => b.id === branchId)?.color ?? 0) % BRANCH_PALETTE.length];

    // prominence: the big branches keep their colour, the long tail recedes
    const branchesSorted = [...graph.branches].sort((a, b) => b.commits - a.commits);
    const rankOf = new Map(branchesSorted.map((b, i) => [b.id, i]));
    const PROMINENT = 36;
    const RECEDE = new THREE.Color(0x1a1e2e);
    const colorCache = new Map();
    const isMajor = branchId => (rankOf.get(branchId) ?? 9999) < PROMINENT;
    const tintOf = branchId => {
        let c = colorCache.get(branchId);
        if (c) return c;
        c = new THREE.Color(colorOf(branchId));
        if (!isMajor(branchId)) c.lerp(RECEDE, 0.8); // long tail -> near-background
        colorCache.set(branchId, c);
        return c;
    };
    // white per-vertex colour so USE_COLOR * instanceColor tints correctly
    // (without it three.js reads a default (0,0,0) attribute -> black meshes)
    const whiteAttr = geo =>
        geo.setAttribute(
            'color',
            new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 3).fill(1), 3)
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
    const edgeMat = new THREE.MeshStandardMaterial({
        roughness: 0.75,
        metalness: 0.2,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
    });
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
    graph.nodes.forEach((n, i) => {
        const hub = childCount.get(n.id) || 0;
        const r = 2.2 + Math.min(hub, 6) * 0.5;
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

    // raycaster for hover tooltips
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const tooltip =
        document.getElementById('gengit3d-tooltip') ||
        (() => {
            const el = document.createElement('div');
            el.id = 'gengit3d-tooltip';
            el.style.cssText =
                'position:absolute;pointer-events:none;background:#000c;color:#fff;padding:4px 8px;border-radius:4px;font:12px monospace;display:none;z-index:10;';
            document.body.appendChild(el);
            return el;
        })();

    function onMove(ev) {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        const hits = raycaster.intersectObject(nodes, false);
        if (hits.length) {
            const idx = hits[0].instanceId;
            const n = graph.nodes[idx];
            if (n) {
                tooltip.style.display = 'block';
                tooltip.style.left = ev.clientX + 12 + 'px';
                tooltip.style.top = ev.clientY + 12 + 'px';
                tooltip.textContent = `${n.short} ${n.author}: ${n.subject.slice(0, 60)}`;
                document.body.style.cursor = 'pointer';
                return;
            }
        }
        tooltip.style.display = 'none';
        document.body.style.cursor = 'default';
    }
    renderer.domElement.addEventListener('mousemove', onMove);

    // resize
    function onResize() {
        const w = container.clientWidth || 800;
        const h = container.clientHeight || 600;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    }
    window.addEventListener('resize', onResize);

    // animate
    let raf = 0;
    function animate() {
        raf = requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
    }
    animate();

    // stats overlay
    const stats = document.getElementById('gengit3d-stats');
    if (stats) {
        stats.textContent = `commits: ${graph.nodes.length} | branches: ${graph.branches.length} | edges: ${graph.edges.length} | head: ${graph.head?.slice(0, 7) ?? '?'}`;
    }

    // Expose handles for debugging/inspection from the browser dev tools.
    // NOTE: this runs in the browser — never reference `process.env` here
    // (Node globals are undefined in a page and throw a ReferenceError).
    window.__gengit3d = { scene, camera, renderer, controls, nodes, edges };

    return {
        scene,
        camera,
        renderer,
        controls,
        dispose() {
            cancelAnimationFrame(raf);
            controls.dispose();
            renderer.dispose();
        },
    };
}
