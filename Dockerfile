FROM node:20-alpine

# git is required by bin/gengit3d.js to run `git log` (parse / default start mode).
RUN apk add --no-cache git

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bin/ ./bin/
COPY src/ ./src/
COPY index.html ./

# gengit3d.graph.json is generated at build time via:
#   node bin/gengit3d.js parse --repo /path/to/repo
# For now, copy the pre-generated one if present, else generate at runtime.
COPY gengit3d.graph.json* ./

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://localhost:8080/ || exit 1

CMD ["node", "bin/gengit3d.js", "serve", "--port", "8080"]
