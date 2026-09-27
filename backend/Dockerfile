FROM oven/bun:1.4-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
# --production drops devDependencies: vitest, drizzle-kit, the frontend's build chain.
# None of it runs in this image.
#
# --ignore-scripts is what makes that survivable. The root package.json has
# `"prepare": "lefthook install"`, bun runs it after every install, and lefthook is itself
# a devDependency - so --production removes the binary and then tries to execute it,
# exiting 127. Nothing is lost by skipping it: bun does not run dependencies' lifecycle
# scripts unless they are listed in trustedDependencies, and none are, so the root's git
# hooks were the only script here. A container has no .git to hook anyway.
RUN bun install --frozen-lockfile --production --ignore-scripts

# There is no bundling step, on purpose. Bun runs TypeScript directly, so the container
# executes the same src/ the tests execute.
#
# `bun build` is not an option here: it cannot bundle a native addon. @node-rs/argon2
# picks its .node binary through a runtime platform check, and the bundler rewrites those
# requires to paths relative to the *original* package directory in node_modules. The
# binary is emitted into dist/, nothing can load it from there, and the build still exits
# 0 - a green CI shipping an image that dies on the first line. Running from source
# sidesteps the whole class of bug.
FROM oven/bun:1.4-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Both halves of the install are needed, and it is not obvious why.
#
# bun does not hoist workspace dependencies to the root. /app/node_modules holds the root
# package's own devDependencies plus the real package store in /app/node_modules/.bun/;
# every dependency *the backend declares* appears only as a symlink in
# /app/backend/node_modules, pointing at ../../node_modules/.bun/<pkg>@<hash>/...
#
# Copy the root alone and the store ships without the links that name it: bun resolving
# `pino` from /app/backend/src walks up, finds no /app/backend/node_modules, reaches
# /app/node_modules, and fails - inside an image that is 300MB of packages it cannot see.
#
# The links are relative, so both trees have to land at the same relative offsets they had
# in the deps stage. They do, which is what makes this work.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
# .dockerignore is what keeps node_modules, dist/ and a local .env out of this layer -
# which is also why the symlink tree has to come from the deps stage on the next line
# rather than from the build context.
COPY backend ./backend
COPY --from=deps /app/backend/node_modules ./backend/node_modules

# The backend package root: CMD is relative to it. Nothing else depends on the cwd -
# proto/ is resolved relative to its own source file, not from here.
WORKDIR /app/backend
USER bun
# 3000 is REST + tRPC, 50051 is gRPC.
EXPOSE 3000 50051
CMD ["bun", "run", "src/index.ts"]
