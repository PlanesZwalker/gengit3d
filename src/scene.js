// scene.js — three.js scene for the git commit graph.
// Renders commits as spheres (colored by branch), parent links as lines,
// and wires OrbitControls for navigation. Runs in the browser only
// (imports 'three' which is a browser/ESM build).

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
    scene.background = new THREE.Color(0x121214);

    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 200000);

    // frame the whole graph: compute bbox of node positions
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const n of graph.nodes) box.expandByPoint(v.set(n.x, n.y, n.z));
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const maxDim = Math.max(size.x, size.y, size.z, 10);
    const fitDist = (maxDim / 2) / Math.tan((camera.fov * Math.PI) / 360) * 1.4;
    camera.position.set(center.x, center.y, center.z + fitDist);
    camera.lookAt(center);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    // lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(10, 20, 30);
    scene.add(dir);

    // edges
    const positions = [];
    const colorArr = [];
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    const cTmp = new THREE.Color();
    for (const e of graph.edges) {
        const s = nodeById.get(e.source);
        const t = nodeById.get(e.target);
        if (!s || !t) continue;
        positions.push(s.x, s.y, s.z, t.x, t.y, t.z);
        const col = BRANCH_PALETTE[(graph.branches.find((b) => b.id === s.branch)?.color ?? 0) % BRANCH_PALETTE.length];
        cTmp.setHex(col);
        colorArr.push(cTmp.r, cTmp.g, cTmp.b, cTmp.r, cTmp.g, cTmp.b);
    }
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    edgeGeo.setAttribute('color', new THREE.Float32BufferAttribute(colorArr, 3));
    const edgeMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55 });
    scene.add(new THREE.LineSegments(edgeGeo, edgeMat));

    // nodes
    const nodeGeo = new THREE.SphereGeometry(0.6, 16, 16);
    const nodeGroup = new THREE.Group();
    for (const n of graph.nodes) {
        const col = BRANCH_PALETTE[(graph.branches.find((b) => b.id === n.branch)?.color ?? 0) % BRANCH_PALETTE.length];
        const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.4, metalness: 0.1 });
        const mesh = new THREE.Mesh(nodeGeo, mat);
        mesh.position.set(n.x, n.y, n.z);
        mesh.userData = n; // for raycasting / tooltip
        nodeGroup.add(mesh);
    }
    scene.add(nodeGroup);

    // raycaster for click/hover tooltips
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const tooltip = document.getElementById('gengit3d-tooltip') || (() => {
        const el = document.createElement('div');
        el.id = 'gengit3d-tooltip';
        el.style.cssText = 'position:absolute;pointer-events:none;background:#000a;color:#fff;padding:4px 8px;border-radius:4px;font:12px monospace;display:none;z-index:10;';
        document.body.appendChild(el);
        return el;
    })();

    function onMove(ev) {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        const hits = raycaster.intersectObjects(nodeGroup.children);
        if (hits.length) {
            const n = hits[0].object.userData;
            tooltip.style.display = 'block';
            tooltip.style.left = (ev.clientX + 12) + 'px';
            tooltip.style.top = (ev.clientY + 12) + 'px';
            tooltip.textContent = `${n.short} ${n.author}: ${n.subject.slice(0, 60)}`;
            document.body.style.cursor = 'pointer';
        } else {
            tooltip.style.display = 'none';
            document.body.style.cursor = 'default';
        }
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

    return {
        scene, camera, renderer, controls,
        dispose() { cancelAnimationFrame(raf); controls.dispose(); renderer.dispose(); },
    };
}

// Expose for debugging/inspection (dev only)
if (process.env.NODE_ENV !== 'production') {
    window.__gengit3d_scene = scene;
    window.__gengit3d_renderer = renderer;
    window.__gengit3d_camera = camera;
}
