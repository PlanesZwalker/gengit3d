// scene-webview.ts — adaptation de scene.js pour le webview VS Code.
//
// scene.js original utilise des imports `three/addons/...` qui ne se résolvent
// pas dans un bundle esbuild sans configuration d'alias. Cette version utilise
// des imports relatifs explicites vers node_modules/three/examples/jsm/.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
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
    const theme = getTheme(opts.themeName);
    const showTimeline = opts.timeline !== false;
    const onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : null;

    // assign a distinct color to every branch (mutates branch.color)
    const branchColorMap = assignBranchColors(graph);

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

    // lights
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

    const nodeById = new Map(graph.nodes.map((n: any) => [n.id, n]));
    const colorOf = (branchId: string) => branchColorMap.get(branchId) ?? 0x4f9dff;
    const TIP_COLORS: Record<string, number> = { stash: 0xff8c42, 'empty-branch': 0x8b93a7 };
    const tipColorOf = (n: any) => {
        if (n.isTip && n.tipType) return TIP_COLORS[n.tipType] ?? 0xff8c42;
        return null;
    };

    // prominence: the big branches keep their colour, the long tail recedes
    const branchesSorted = [...graph.branches].sort((a: any, b: any) => b.commits - a.commits);
    const rankOf = new Map(branchesSorted.map((b: any, i: number) => [b.id, i]));
    const PROMINENT = 36;
    const RECEDE = new THREE.Color(theme.recede);
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
    const nodeColorOf = (n: any) => {
        const tipC = tipColorOf(n);
        if (tipC !== null) return new THREE.Color(tipC);
        return tintOf(n.branch);
    };

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

    // ---- dashed edges ----
    const dashedGroup = new THREE.Group();
    const dashedMat = new THREE.LineDashedMaterial({
        color: 0xff8c42,
        dashSize: 4,
        gapSize: 3,
        transparent: true,
        opacity: 0.7,
    });
    for (const e of dashedEdges) {
        const s = nodeById.get(e.source);
        const t = nodeById.get(e.target);
        if (!s || !t) continue;
        const points = [new THREE.Vector3(s.x, s.y, s.z), new THREE.Vector3(t.x, t.y, t.z)];
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        const line = new THREE.Line(geo, dashedMat);
        line.computeLineDistances();
        dashedGroup.add(line);
    }
    scene.add(dashedGroup);

    // ---- nodes as instanced spheres ----
    const nodeGeo = whiteAttr(new THREE.SphereGeometry(1.6, 12, 10));
    const nodeMat = new THREE.MeshStandardMaterial({
        roughness: 0.55,
        metalness: 0.25,
        vertexColors: true,
    });
    const nodesMesh = new THREE.InstancedMesh(nodeGeo, nodeMat, graph.nodes.length);
    nodesMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    nodesMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(graph.nodes.length * 3), 3);
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    for (let i = 0; i < graph.nodes.length; i++) {
        const n = graph.nodes[i];
        m4.makeTranslation(n.x, n.y, n.z);
        nodesMesh.setMatrixAt(i, m4);
        col.copy(nodeColorOf(n));
        nodesMesh.setColorAt(i, col);
    }
    nodesMesh.instanceMatrix.needsUpdate = true;
    nodesMesh.instanceColor.needsUpdate = true;
    scene.add(nodesMesh);

    // ---- similar-commit edges (dashed lines) ----
    if (graph.similarEdges && graph.similarEdges.length > 0) {
        const simMat = new THREE.LineDashedMaterial({
            color: 0x8b93a7,
            dashSize: 2,
            gapSize: 2,
            transparent: true,
            opacity: 0.4,
        });
        for (const se of graph.similarEdges) {
            const s = nodeById.get(se.from);
            const t = nodeById.get(se.to);
            if (!s || !t) continue;
            const points = [new THREE.Vector3(s.x, s.y, s.z), new THREE.Vector3(t.x, t.y, t.z)];
            const geo = new THREE.BufferGeometry().setFromPoints(points);
            const line = new THREE.Line(geo, simMat);
            line.computeLineDistances();
            scene.add(line);
        }
    }

    // ---- timeline axis ----
    if (showTimeline && graph.axis) {
        const axisGroup = new THREE.Group();
        const axisMat = new THREE.LineBasicMaterial({ color: theme.axis, transparent: true, opacity: 0.35 });
        const yMin = -maxDim * 0.6;
        const yMax = maxDim * 0.6;
        const axisPoints = [new THREE.Vector3(0, yMin, 0), new THREE.Vector3(0, yMax, 0)];
        const axisGeo = new THREE.BufferGeometry().setFromPoints(axisPoints);
        const axisLine = new THREE.Line(axisGeo, axisMat);
        axisGroup.add(axisLine);

        // tick marks
        const tickCount = 8;
        for (let i = 0; i <= tickCount; i++) {
            const t = i / tickCount;
            const y = yMin + (yMax - yMin) * t;
            const tickPoints = [new THREE.Vector3(-maxDim * 0.02, y, 0), new THREE.Vector3(maxDim * 0.02, y, 0)];
            const tickGeo = new THREE.BufferGeometry().setFromPoints(tickPoints);
            const tickLine = new THREE.Line(tickGeo, axisMat);
            axisGroup.add(tickLine);

            // CSS2D label
            const labelDiv = document.createElement('div');
            labelDiv.className = 'gengit3d-tick';
            if (graph.axis.mode === 'time' && graph.axis.tMin && graph.axis.tMax) {
                const date = new Date(graph.axis.tMin + (graph.axis.tMax - graph.axis.tMin) * t);
                labelDiv.textContent = date.toLocaleDateString();
            } else {
                labelDiv.textContent = `${Math.round(t * 100)}%`;
            }
            const label = new CSS2DObject(labelDiv);
            label.position.set(maxDim * 0.05, y, 0);
            axisGroup.add(label);
        }
        scene.add(axisGroup);
    }

    // ---- selection highlight ----
    let selectedNode: any = null;
    const highlightMat = new THREE.MeshBasicMaterial({ color: theme.selection, transparent: true, opacity: 0.3 });
    let highlightMesh: THREE.Mesh | null = null;

    // ---- raycasting for click selection ----
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let mouseDownPos = { x: 0, y: 0 };

    renderer.domElement.addEventListener('pointerdown', (e) => {
        mouseDownPos = { x: e.clientX, y: e.clientY };
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
        const intersects = raycaster.intersectObject(nodesMesh);
        if (intersects.length > 0) {
            const idx = intersects[0].instanceId;
            if (idx !== undefined && idx < graph.nodes.length) {
                const node = graph.nodes[idx];
                selectedNode = node;
                if (highlightMesh) {
                    scene.remove(highlightMesh);
                    highlightMesh.geometry.dispose();
                }
                highlightMesh = new THREE.Mesh(
                    new THREE.SphereGeometry(2.5, 16, 12),
                    highlightMat
                );
                highlightMesh.position.set(node.x, node.y, node.z);
                scene.add(highlightMesh);
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

    // ---- hover tooltip ----
    const tooltipDiv = document.createElement('div');
    tooltipDiv.style.cssText = 'position:fixed;pointer-events:none;background:var(--overlay);color:var(--text);padding:4px 8px;border-radius:4px;font:11px monospace;z-index:10;display:none;max-width:300px;';
    document.body.appendChild(tooltipDiv);

    renderer.domElement.addEventListener('pointermove', (e) => {
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObject(nodesMesh);
        if (intersects.length > 0) {
            const idx = intersects[0].instanceId;
            if (idx !== undefined && idx < graph.nodes.length) {
                const node = graph.nodes[idx];
                tooltipDiv.style.display = 'block';
                tooltipDiv.style.left = (e.clientX + 12) + 'px';
                tooltipDiv.style.top = (e.clientY + 12) + 'px';
                tooltipDiv.textContent = `${node.short} ${node.subject}`;
            }
        } else {
            tooltipDiv.style.display = 'none';
        }
    });

    // ---- animation loop ----
    let animationId: number;
    function animate() {
        animationId = requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
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
    }
    window.addEventListener('resize', onResize);

    // ---- public API ----
    return {
        dispose() {
            cancelAnimationFrame(animationId);
            window.removeEventListener('resize', onResize);
            renderer.dispose();
            labelRenderer.dispose();
            tooltipDiv.remove();
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
            const t = getTheme(name);
            scene.background = new THREE.Color(t.background);
            scene.fog = new THREE.Fog(t.fogColor ?? t.background, maxDim * t.fog[0], maxDim * t.fog[1]);
        },
        setBranchFilter(visible: Set<string> | null) {
            // Re-render with filtered branches
            if (!visible) {
                edgesHidden.count = 0;
                edgesVisible.count = ei;
                edgesVisible.instanceMatrix.needsUpdate = true;
                return;
            }
            // Hide edges connected to hidden branches
            let vi = 0;
            for (let i = 0; i < solidEdges.length; i++) {
                const e = solidEdges[i];
                const s = nodeById.get(e.source);
                const t = nodeById.get(e.target);
                if (!s || !t) continue;
                if (!visible.has(s.branch) || !visible.has(t.branch)) continue;
                a.set(s.x, s.y, s.z);
                b.set(t.x, t.y, t.z);
                dir.subVectors(b, a);
                const len = dir.length() || 0.001;
                mid.addVectors(a, b).multiplyScalar(0.5);
                q.setFromUnitVectors(up, dir.clone().normalize());
                m.compose(mid, q, new THREE.Vector3(1, len, 1));
                edgesVisible.setMatrixAt(vi, m);
                edgesVisible.setColorAt(vi, tintOf(s.branch));
                vi++;
            }
            edgesVisible.count = vi;
            edgesVisible.instanceMatrix.needsUpdate = true;
            edgesVisible.instanceColor.needsUpdate = true;
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
                m.compose(mid, q, new THREE.Vector3(1, len, 1));
                edgesVisible.setMatrixAt(vi, m);
                edgesVisible.setColorAt(vi, tintOf(s.branch));
                vi++;
            }
            edgesVisible.count = vi;
            edgesVisible.instanceMatrix.needsUpdate = true;
            edgesVisible.instanceColor.needsUpdate = true;
        },
        setTipsVisible(visible: boolean) {
            dashedGroup.visible = visible;
        },
    };
}
