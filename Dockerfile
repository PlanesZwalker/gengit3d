FROM node:20-alpine

# git is required by bin/gengit3d.js to run `git log` (parse / default start mode).
RUN apk add --no-cache git

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bin/ ./bin/
COPY src/ ./src/
COPY index.html ./
COPY entrypoint.sh ./

# gengit3d.graph.json is gitignored (7 MB generated artifact) and NOT baked in.
# entrypoint.sh parses the mounted repo (GENGIT3D_REPO, default /repo) at startup
# so the viewer is functional on a clean checkout. A pre-generated graph, if present
# in the build context, is copied as a fallback.
COPY gengit3d.graph.json* ./

RUN chmod +x entrypoint.sh

EXPOSE 8080

# Healthy only once a graph is actually served (not just the HTML shell).
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s \
  CMD wget -qO- http://localhost:8080/gengit3d.graph.json >/dev/null 2>&1 || exit 1

ENTRYPOINT ["./entrypoint.sh"]
