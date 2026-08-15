# The frontend is a static bundle, so this stage is pure scaffolding: it produces
# frontend/dist, and nothing else from it - not bun, not node_modules - survives into the
# image that ships.
FROM oven/bun:1.3-alpine AS build
WORKDIR /app

COPY package.json bun.lock ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

# No --production here, unlike the backend image: vite and its plugin chain are
# devDependencies, and dist/ cannot be produced without them.
#
# --ignore-scripts for the same reason it is on the backend image, by a different route:
# lefthook *is* installed here, so the root's `prepare` would run and then fail against a
# context with no .git in it (see .dockerignore). Git hooks are a developer-machine
# concern and have no business in a build stage.
RUN bun install --frozen-lockfile --ignore-scripts

COPY frontend ./frontend

# `build:dist` is `vite build` alone - deliberately not the `build` script, which prefixes
# it with `vue-tsc --noEmit`.
#
# Type-checking here would be a second run of a gate that has already passed: release.yml
# calls the CI workflow, which runs typecheck and build across both workspaces, before any
# image is built. Repeating it inside the image buys nothing and costs the whole backend
# source tree in the build context - src/lib/trpc.ts imports AppRouter, so vue-tsc needs
# the server on disk even though @vue/tsconfig sets verbatimModuleSyntax and the type-only
# import is erased before vite ever resolves it.
#
# Dropping it keeps this image's context to the frontend alone, which is the separation
# the two-image split is for.
RUN bun run --cwd frontend build:dist

FROM nginx:1.29-alpine AS runtime

COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# nginx's entrypoint runs everything in this directory before exec'ing nginx. The 40-
# prefix keeps it after the image's own envsubst hooks, which is where a config rewrite
# belongs.
COPY frontend/docker-entrypoint.sh /docker-entrypoint.d/40-termite-config.sh
RUN chmod +x /docker-entrypoint.d/40-termite-config.sh

# Where the *browser* reaches the backend, so it is a public address, not a compose
# service name: this URL is resolved by the user's machine, never from inside the
# network. Read at container start rather than baked at build time - see
# docker-entrypoint.sh for why that distinction is the entire reason this image works.
ENV API_URL=http://localhost:3000

EXPOSE 80

# No USER: nginx's master needs root to bind :80 and to rewrite index.html, then drops
# its workers to the unprivileged nginx user on its own. Running the master as nginx
# would need the unprivileged variant and a port change, which is a surprise this
# project does not need.
