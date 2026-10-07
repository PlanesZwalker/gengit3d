# GenGit3D

3D git commit-graph visualizer. Parses `git log` into a graph (nodes = commits,
edges = parent→child, lanes = branches) and renders it with **three.js** +
OrbitControls.

Standalone and self-contained: the only runtime dependency is `three`.

Built from scratch — no dependency on the separate GenGit (LLM-token DAG) project.

## Install

```bash
npm install        # pulls three.js
```

## Usage

```bash
# 1) parse a repo into a graph.json (defaults to current dir)
node bin/gengit3d.js parse --repo /path/to/repo --out gengit3d.graph.json
node bin/gengit3d.js parse --max 200          # limit commits

# 2) serve the 3D viewer
node bin/gengit3d.js serve --port 8080

# or do both (parse current repo -> serve from this folder)
node bin/gengit3d.js
```

Open <http://localhost:8080/> — drag to rotate, scroll to zoom, hover a node for
commit info, click a node for the full commit panel.

## Architecture

```
git log --pretty=format:...  --topo-order
        │
        ▼
src/gitlog.js     → parseGitLog(): nodes/edges/branches + depth + real branch assignment
        │
        ▼
src/layout3d.js   → layoutGraphForView(): 6 layouts
        │
        ▼
src/scene.js      → three.js: spheres (branch-colored) + tube edges + OrbitControls
        │
        ▼
index.html        → importmap three from CDN, fetch graph.json, render
```

```
GenGit3D/
  package.json
  bin/gengit3d.js     CLI (parse / serve / clean)
  src/gitlog.js       git log parser -> graph JSON
  src/layout3d.js     deterministic 3D layout dispatcher (6 views)
  src/scene.js        three.js scene (nodes/edges/OrbitControls/raycast/tooltip)
  src/themes.js       6 light+dark themes (scene + HTML chrome)
  src/branch-colors.js  OKLab farthest-point color assignment
  src/similar-commits.js  similar-commit edge detection (cherry-picks, same subject)
  index.html          web viewer (importmap three from CDN)
  entrypoint.sh       container entrypoint (parse then serve)
  Dockerfile          node:20-alpine + git
```

## Vues multiples

6 modes d'affichage, sélectionnables via le sélecteur `view` dans la barre du haut
(ou le paramètre `?view=` dans l'API). Chaque vue réutilise le même graphe mais
change le layout 3D :

| Vue | Description | Layout |
|-----|-------------|--------|
| `topological` | Branches heuristiques (défaut) | Cylindrique, angle = branche |
| `chronological` | Timeline pure | Linéaire, x = date |
| `author` | Groupé par auteur | Cylindrique, angle = auteur |
| `radial` | Cercles concentriques par date | Rayon = jour |
| `queue` | Colonnes comme `git log --graph` | x = branche, y = date |
| `real-branches` | Vraies branches git | Cylindrique, angle = branche réelle |

**Implémentation** (`src/layout3d.js`) : `layoutGraphForView(graph, view)` dispatche
vers la fonction de layout correspondante ; chaque vue mute `node.x/y/z` en place.
L'axe `y` est la date réelle (timeline monotone) quand disponible.

La vue `real-branches` lit les vraies refs git (`git rev-list` par ref ; la première
ref — locale avant remote — qui atteint un commit le possède) au lieu d'une
heuristique de topologie BFS.

## Clic sur un commit → détails + timeline

**Timeline** : l'axe vertical `y` est la **date réelle** des commits (pas la profondeur
topologique) → timeline monotone, plus ancien en bas. 7 graduations datées
(`CSS2DRenderer`). Repli sur la profondeur si les dates manquent (`graph.axis.mode`).

**Clic sur un commit** → panneau de détails :

| Bloc | Contenu |
|------|---------|
| En-tête | hash court + sujet |
| Meta | auteur, email, date, committer (si différent), parents |
| Message | corps du commit |
| Stats | nb fichiers, `+ajouts` / `-suppressions` |
| Fichiers | liste avec `+N/-N` par fichier |
| Diff | patch colorisé (additions vertes, suppressions rouges) |

Le clic est distingué d'un drag d'orbite (delta > 4 px ⇒ pas un clic). Le commit
sélectionné est entouré d'un halo (`wireframe`) et sa sphère est agrandie ×1.7.

## API

Serveur (`bin/gengit3d.js serve`) expose :

| Route | Rôle |
|---|---|
| `GET /api/graph?repo=<path>&max=<n>&view=<v>` | parse un repo **local** à la volée |
| `GET /api/clone?url=<git-url>&depth=<n>&max=<n>` | clone un repo **distant** (shallow si depth>0) puis parse |
| `GET /api/repos?root=<dir>&depth=<n>` | liste les repos git sous `root` (défaut `GENGIT3D_REPO`) |
| `GET /api/commit?repo=<path>&hash=<sha>&patch=1&maxPatch=<chars>` | métadonnées + fichiers + patch optionnel |

```bash
curl "http://localhost:8083/api/graph?repo=/repo&view=chronological"
curl "http://localhost:8083/api/clone?url=https://github.com/octocat/Hello-World.git&depth=50"
curl "http://localhost:8083/api/commit?repo=/repo&hash=<sha>&maxPatch=2000"
```

- Le `hash` est validé (`^[0-9a-f]{4,40}$`) — pas d'injection d'arguments git.
- Le patch est **tronqué** (`maxPatch`, défaut 60 000 car., plafond 400 000) et
  `patchTruncated` le signale.
- `git show -s --format=%P` est appelé **séparément** de `%b` : le corps du message
  peut casser un split naïf.
- Commits de merge : `--numstat` peut être vide → « (no files — merge commit?) ».
- Sécurité clone : seuls les schémas `https:// git:// ssh:// git@host: file://` sont acceptés.

## Thèmes (light + dark)

Six thèmes dans `src/themes.js` (sélecteur `theme` dans la barre du haut, choix
persistant via `localStorage`). Chaque thème contrôle **à la fois** la scène three.js
(fond, brouillard, palette, lumières, recul de la longue traîne) **et** le chrome HTML
(variables CSS).

| Clé | Type | Fond |
|-----|------|------|
| `midnight` | dark | `#0b0b10` |
| `slate` | dark | `#141a24` |
| `neon` | dark | `#06060a` |
| `daylight` | light | `#eef2f8` (défaut) |
| `paper` | light | `#f6f1e7` |
| `solarized` | light | `#fdf6e3` |

**Règle de lisibilité** — sur un fond **clair**, deux pièges rendent le graphe
illisible, tous deux corrigés dans `themes.js` :

1. **Le brouillard doit converger vers un ton MOYEN, pas vers le fond clair.** Sinon les
   brins lointains s'éclaircissent vers le blanc et disparaissent. D'où un champ
   `fogColor` distinct de `background` sur les thèmes clairs (`0x6b7688` pour `daylight`).
2. **La longue traîne recule vers un gris moyen** (plus foncé que le fond), pas vers une
   teinte claire : `recede: 0x55606f`, `recedeAmount: 0.45`.

Ajouter un thème = une entrée dans `THEMES` ; le `<select>` et le chrome suivent.

## Filtrage des branches

Le panneau de légende permet de filtrer les branches par nom (recherche) et par date.
Les branches masquées tombent à une opacité de 0.1 (pas grisées).

## Stash + empty-branch tips

Les commits stash et les branches vides sont affichés comme des nœuds synthétiques
avec des arêtes en pointillés.

## N'importe quel repo

Tapez un chemin local ou une git URL dans l'interface, sans redémarrer le CLI.

## Docker

```bash
docker build -t gengit3d:latest .
# monter un repo pour que le graphe soit généré au démarrage :
docker run -d --name gengit3d -p 8083:8080 \
  -v /path/to/repo:/repo:ro gengit3d:latest
# → http://localhost:8083/
```

- `node:20-alpine` + `git` (requis pour lancer `git log` — sans git, `parse`/`start`
  plantent avec `spawn git ENOENT`).
- **`gengit3d.graph.json` est gitignoré** (artefact généré ~7 Mo). L'`entrypoint.sh`
  le génère au démarrage depuis le repo monté, puis lance `serve` → un checkout
  propre est fonctionnel sans aucun fichier de graphe committé.
- Variables d'environnement de l'entrypoint :

  | Var | Défaut | Rôle |
  |-----|--------|------|
  | `GENGIT3D_REPO` | `/repo` | repo à parser au démarrage |
  | `GENGIT3D_OUT` | `/app/gengit3d.graph.json` | chemin du graphe généré |
  | `GENGIT3D_PARSE` | `1` | `0` = ne pas parser (servir le graphe existant) |
  | `GENGIT3D_MAX` | `0` | limite de commits (`0` = tous) |
  | `PORT` | `8080` | port HTTP |

- `HEALTHCHECK` : sonde `GET /gengit3d.graph.json` (healthy uniquement quand un graphe
  est réellement servi, pas juste la coquille HTML).

## Notes / limitations

- three.js est chargé depuis un CDN via importmap ; pour un usage 100 % hors-ligne,
  vendorer `three.module.js` localement.
- `relax()` (passe de force) est optionnel et désactivé par défaut.
- `index.html` fait un `fetch('./gengit3d.graph.json')` → il faut un serveur HTTP
  (pas `file://`).
