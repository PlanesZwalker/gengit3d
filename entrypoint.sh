#!/bin/sh
# entrypoint.sh — GenGit3D container entrypoint.
#
# Generates gengit3d.graph.json from a mounted git repo, then serves the viewer.
# This removes the dependency on the (gitignored, build-time) gengit3d.graph.json:
# on a clean checkout the image has no graph, so we parse it at startup instead.
#
# Env:
#   GENGIT3D_REPO  repo to parse           (default /repo)
#   GENGIT3D_OUT   graph output path       (default /app/gengit3d.graph.json)
#   GENGIT3D_PARSE 1=parse at start, 0=skip (default 1)
#   GENGIT3D_MAX   max commits to parse    (default 0 = all)
#   PORT           HTTP port               (default 8080)

GRAPH="${GENGIT3D_OUT:-/app/gengit3d.graph.json}"
REPO="${GENGIT3D_REPO:-/repo}"
MAX="${GENGIT3D_MAX:-0}"

if [ "${GENGIT3D_PARSE:-1}" = "1" ]; then
    if [ -d "$REPO/.git" ]; then
        echo "[entrypoint] generating graph from $REPO (max=$MAX) ..."
        if node /app/bin/gengit3d.js parse --repo "$REPO" --out "$GRAPH" --max "$MAX"; then
            echo "[entrypoint] graph written to $GRAPH"
        else
            echo "[entrypoint] WARN: parse failed; keeping existing $GRAPH if present"
        fi
    else
        echo "[entrypoint] no git repo at $REPO; skipping parse (mount a repo there)"
    fi
fi

if [ ! -f "$GRAPH" ]; then
    echo "[entrypoint] WARN: no $GRAPH — viewer will report 'failed to load gengit3d.graph.json'"
fi

exec node /app/bin/gengit3d.js serve --port "${PORT:-8080}"
