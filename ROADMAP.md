# GenGit3D Roadmap

3D git commit-graph visualizer — standalone three.js viewer + VS Code extension.

_Moved here 2026-11-12 from `GLSL_DISCORD/docs/24-roadmap/roadmap.md` — the
project was split into this dedicated repo on 2026-10-06._

## Done

- Standalone three.js visualizer (gitlog + layout3d + scene) — PR #202
- VS Code extension: webview panel, 6 layouts, 6 themes, branch/author
  filters, commit detail panel with diff, animated camera fits,
  post-processing fx (bloom/trails), status bar + activity bar + SCM /
  editor / explorer entry points
- Toolbar sliders: edge opacity, node size, node spacing (persisted to
  `gengit3d.*` settings); selection halo + hover glow scale with node size;
  spacing rides the camera along the time axis live + reframes on release
  (was: graph left the frustum → "black render"); persisted spacing applies
  pre-bbox so the opening view is framed for the stored value
- GitGraph parity: "uncommitted changes" node (amber tip, dashed edge to
  HEAD, click → working-tree status + diff) in webview + standalone API;
  branch checkout button (⎇, hover in legend) via `git switch`, ● marker on
  the current branch; curated post-processing fx (legibility-first: bloom,
  trails, FXAA, sharpen, vignette, contrast+, tilt-shift, DoF)
- Top-bar fix: status line flows below the wrapping toolbar; stats HUD
  moved bottom-left
- History replay ("movie"): bottom-center scrubber — ▶ plays the graph
  building itself chronologically (commits pop in commit order, edges
  appear when both ends exist, uncommitted node pops last), slider
  scrubs a period, date label tracks the compressed timeline; camera
  follows the reveal front (centroid of a sliding window, `cam` toggle,
  grab-to-release); follow distance is aspect-compensated (pulls back on
  narrow/split panels so the horizontal FOV keeps the same span) and the
  look-at leads the front slightly so incoming commits stay in frame;
  movie labels — EVERY revealed commit carries an ephemeral tag next to
  its node (pool of 8, ~2.8 s fade, glyph + hash + subject + author);
  event-driven playback — DWELL 1.5 s on EVERY commit (a `▸` accent-
  bordered tag pins to the commit being presented) then a fast ~200 ms
  glide to the next; bursts dwell their members sequentially; speed
  selector ¼×–4× scales the dwell;
  period selection via date inputs + [ ] mark in/out
- Split panels: ⧉ clones the panel into ViewColumn.Beside (same view,
  theme, file mode); each panel then independent; tab title shows the
  layout (and file basename in file mode)
- File history mode: `git log --all --follow -- <file>` via
  `gengit3d.fileHistory` (explorer + editor context/title menus,
  "File History in 3D Graph"); edges rewired to nearest in-set ancestor
  via rev-list --parents BFS (no dangling edges); branch legend filtered
  to present branches; stash/empty tips dropped; uncommitted node only
  when the file itself is dirty; `file: <name> ✕` badge → clearFile →
  back to full graph; survives refresh/checkout/split
- Node shapes by commit type (webview): ● commit · ◆ merge (octahedron) ·
  ▲ root (tetrahedron) · ■ uncommitted (cube) · ▶ stash (cone) ·
  ◇ empty-branch tip (torus); hover glow + selection halo take the node's
  shape; type glyph in tooltip; shape key in the bottom help line;
  one InstancedMesh per shape (≤6 draw calls, instanceId→node map for
  raycast)
- "Instant read" features (webview):
  - commit-weight encoding via `--numstat` (one extra git pass):
    node radius ∝ log(churn), edge thickness ∝ log(churn)
  - `colors:` selector — branch | author (stable hash hue) | age
    (blue old → orange recent over the repo timespan)
  - NOW HUD — `⎇ branch · ↑a ↓b upstream · N dirty · last commit <age>`
  - always-on labels toggle — merges (◆ hash) + tags (⚐ name),
    ~24 nearest to camera, pooled divs
  - remote-owned commits (refs/remotes/*) desaturated in branch mode
  - hotspot on selection — commits sharing files with the selected commit
    (Jaccard, top 40) stay lit, everything else fades to background
  - movie subtitle banner — `date — subject · author` bottom-center
    during dwell, readable even off-screen nodes

## Pending

| Task | Notes |
| ---- | ----- |
| Wire `tips` toggle in webview | `setTipsVisible` exists in the scene API, no UI |
| Date filter in webview legend | `setDateFilter` exists but only hides edges — must also scale-0 filtered node spheres |
| Spacing slider for standalone viewer | port `setSpacing` to `scene.js` + `index.html` (feature parity) |
| fx parity for standalone viewer | webview fx beyond bloom/trails need extra passes/shaders vendored into `vendor/three/` |
| Shape parity for standalone viewer | `scene.js` uses visible/hidden dual meshes with slot compaction — port = per-shape ×2 meshes across 3 filter fns |
| README sync | add `gengit3d.nodeSpacing`, fix `nodeSize` range (0.2–3, not 0–1), controls table |
| Version bump → 0.2.0 | `.vsix` still named 0.1.0 — upgrades are invisible |
| Auto-refresh on git changes | watcher on `.git/HEAD` + refs → re-parse |
| Repo-state preview at commit | "what was the tree here" — `git show` browse / checkout preview panel |
| Layout/scene test coverage | only parser tests today (7 tests) |

## On hold

- Agent/branch/task 3D extension (registry.json + worktree merge) — held:
  low ROI vs text k=v; LLM-blind
