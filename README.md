# Termite

![Logo](./assets/logo.png)

Termite is a simple self-hostable, open source, feedback board of sorts and a release tracker for both non-technical and technical audiences and is made for people who ship software in versions. Not in an endless stream like some corporate projects.

> Read as Smiduweorc-termite, like how apache tools are read.

## Problem

If you maintain a small project (OSS, indie, side project or whatnot) and you have a small audience, you may or may not have run into something similar:

- Every tracker is built for corporate teams.
  - AGILE is forced (random but agile is really mostly implemented as a variant of waterfall IRL)
  - Corporate slop is forced
  - AI is bolted
- These systems are made usually for customers as well so they typically have a lot of restrictions as business requirements of who can report what
  - Honestly fine, but maybe not a trait for some OSS communities
  - Account creation required, which can cause the loss of feedback

None of these matches how small projects actually work. Most small projects don't ship constantly and are sometimes just maintenance only once being feature complete. There may be an occasional feature but even so it usually happens in bursts.

## What termite IS

Termite is a simple public board where anyone can drop an idea or a bug report. The community can upvote what matters to them and the maintainer decides what they want to add on their own schedule in their merge window.

It is a less enterprise solution and a more communal town hall system with a release calendar loosely taped to it.

## TERMITE IS NOT FOR YOU IF YOU

- need sprint boards (go away, far away)
- story points (go away)
- burndown charts (go away)
- have sprints (go away)
- want AI features (go further away)
- want managing teams + assignees + permissions tiers or SLAs (NOPE)
- a glorified social media in a corporate environment with profiles (NOPE)
- batch-and-ship rhythm (termite is made for release cycles. if you do not have one, the model we have is just plainly not for you)
- backlog that is long living (termite is also made for projects that may or may not reach feature completeness)

## Self-hosting

Termite publishes two images per release, both `linux/amd64` and `linux/arm64`:

| Image                         | What it is                                     |
| ----------------------------- | ---------------------------------------------- |
| `smiduweorc/termite-backend`  | Elysia (REST + tRPC) on 3000, gRPC on 50051    |
| `smiduweorc/termite-frontend` | The Vue board, built and served by nginx on 80 |

```sh
curl -O https://raw.githubusercontent.com/Smiduweorc/termite/master/docker-compose.release.yml
curl -o .env https://raw.githubusercontent.com/Smiduweorc/termite/master/.env.release.example

# JWT_SECRET, POSTGRES_PASSWORD, and the two public URLs are required.
openssl rand -base64 48   # use as JWT_SECRET
$EDITOR .env

docker compose -f docker-compose.release.yml up -d
docker compose -f docker-compose.release.yml exec backend bun run admin:create you@example.com "Your Name"
```

`admin:create` prints a one-time link to set the first maintainer's password (see [Accounts](./docs/docs.md#accounts)).

The `migrate` service applies the schema before the backend starts, so a fresh volume
and an upgrade both work without a manual step.

### The two URLs

`PUBLIC_APP_URL` and `PUBLIC_API_URL` are the only settings that need real thought. Both
are resolved by the browser, so neither can be a compose service name.

They must also be the same site. Termite's session cookies are `SameSite=Lax` with no
`none` option, and always `Secure`:

- `board.example.com` + `api.example.com`: fine.
- one proxy serving `/` and `/trpc` from one host: fine, and simplest.
- `board.example.com` + `api.somewhere-else.net`: the refresh cookie is dropped and
  people are logged out. There is no setting that fixes this; use a subdomain.

Anything other than `http://localhost` has to be https, because the cookies are `Secure`.

### Configuring the frontend image

Vite inlines `import.meta.env` at build time, so a prebuilt image cannot carry a useful
`VITE_API_URL`. The frontend image instead rewrites a placeholder in `index.html` from
`$API_URL` when the container starts. That means `API_URL` is read when the container is created, not
on restart:

```sh
docker compose -f docker-compose.release.yml up -d --force-recreate frontend
```

### Image tags

Each release publishes as `1.1.0`, `1.1`, `1` and `latest`. A prerelease (`1.1.0-rc.1`)
publishes under its exact version only and never moves `latest`.

## Type checking .vue files

The frontend is type-checked with TypeScript 7.1 (beta) and `tsc` itself, not `vue-tsc`. TypeScript 7 is a native compiler that no longer exposes the JavaScript API `vue-tsc` patches into, so `vue-tsc` cannot run on it. Instead, `frontend/tsconfig.json` registers `@vue/content-mapper` (Vue Language Tools v4, alpha) as a `contentMappers` plugin, and `tsc --runExternalCode` runs it to check the `<script>` blocks and templates of every `.vue` file.

What this means in practice:

- `bun run typecheck` and `bun run build` in `frontend/` use `tsc --runExternalCode`. There is no `vue-tsc` dependency.
- The packages are pinned to prerelease versions: `typescript` 7.1.0-beta in the root `package.json`, and `@vue/content-mapper` 4.0.0-alpha.0 in `frontend/package.json`.
- The alpha is stricter than `vue-tsc` 3: undeclared directives and attributes are reported, and a leftover top-level `vueCompilerOptions` is silently ignored. Declare `GlobalDirectives` and `GlobalComponents` where needed.
- Editor support is not ready. Keep an older TypeScript in your editor if go-to-definition into `.vue` files misbehaves.

**We will move to the proper stable release on 24 November 2026**, replacing these prerelease pins with the stable TypeScript and Vue Language Tools versions.

## Extra Lore

### Upcoming features:

- Announcements
- Configurations for scheduled releases and more
- Basic word filter that is configurable
### Original Use Case:

A few friends of mine were working on a project that needed some project tracking and the single todo list in the repo was not cutting it anymore. So we started turning to various solutions but they each had their own complicated solution. One thing that we liked was vikunja, however, some things were too complicated for us feature wise and there were some things that seemed to be premium only, which no disrespect was all within their right to do so and was not actually too bad, but just wasn't for us since we only needed a simple solution that we can self host.

That said, we eventually decided to make our own, that is protected behind a VPN (wireguard) so that only specific users that we want in our project can make requests and more. So yes we don't expect people to actually use this since it is super niche and we only needed something simple that was in a controlled environment where we did not need to worry too much about safety. (Tldr it is an internal forum)
