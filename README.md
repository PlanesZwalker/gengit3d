# GenGit3D

3D git commit graph visualizer. Parses `git log` into a graph (nodes = commits,
edges = parent→child, lanes = branches) and renders it in **three.js** with
OrbitControls. Standalone — lives under `pipeline/` and is decoupled from the
GLSL_DISCORD bot.

Built from scratch: no dependency on the existing GenGit (LLM-token DAG) project.

## Install

```bash
cd pipeline/GenGit3D
npm install        # pulls three.js
```

## Usage

```bash
# 1) parse a repo into a graph.json (defaults to current dir)
node bin/gengit3d.js parse --repo /path/to/repo --out gengit3d.graph.json
node bin/gengit3d.js parse --max 200          # limit commits

# 2) serve the 3D viewer
node bin/gengit3d.js serve --port 8080

# or do both (parse GLSL_DISCORD -> serve from this folder)
node bin/gengit3d.js
```

Open http://localhost:8080/ — drag to rotate, scroll to zoom, hover a node for
commit info.

## Pipeline

```
git log --pretty=format:...  --topo-order
        │
        ▼
src/gitlog.js     → parseGitLog(): nodes/edges/branches + depth + lane
        │
        ▼
src/layout3d.js   → layoutGraph(): x=depth, y=branch lane, z=jitter (+ relax())
        │
        ▼
src/scene.js      → three.js: spheres (branch-colored) + line edges + OrbitControls
        │
        ▼
index.html        → importmap three from CDN, fetch graph.json, render
```

## Files

```
GenGit3D/
  package.json
  bin/gengit3d.js     CLI (parse / serve)
  src/gitlog.js       git log parser -> graph JSON
  src/layout3d.js     deterministic 3D lane layout (+ optional force relax)
  src/scene.js        three.js scene (nodes/edges/OrbitControls/raycast tooltip)
  index.html          web viewer (importmap three from CDN)
```

## Notes / limitations

- Branch lanes are assigned by a first-parent walk from tips; merge fan-out
  spawns new lanes. Heuristic, not ref-name aware (no `git show-ref` yet).
- three.js is loaded from CDN via importmap in the browser; for fully offline
  use, vendor `three.module.js` locally.
- `relax()` (force pass) is optional and off by default.
