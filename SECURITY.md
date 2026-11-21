# Security Policy

## Supported versions

Security fixes go to the latest release only, as a patch release, and
publish new `smiduweorc/termite-backend` and `smiduweorc/termite-frontend`
images. If you self-host, pull the new images to pick a fix up.

Published advisories are listed in [ADVISORIES.md](./ADVISORIES.md).

## Reporting a vulnerability

Report it privately through GitHub: the "Report a vulnerability" button
under the Security tab of
[Smiduweorc/termite](https://github.com/Smiduweorc/termite/security/advisories/new).
That opens a private advisory only the maintainers can see. Please don't open
a public issue for it.

Useful to include: the version or image tag, the request that gets through,
which account or role it needs, and whether it needs a particular setting in
`.env`.

## What to expect

Termite is maintained by one person, as a side project. There is no
response-time promise. What is promised:

- every report gets read, and an answer saying whether it is accepted;
- an accepted report gets a fix, a test that reproduces it, a GitHub security
  advisory, and a release note, in that release;
- you are credited in the advisory, unless you'd rather not be.

Termite is built for a small, trusted group running it behind a VPN (see
"Original Use Case" in the [README](./README.md#original-use-case)). A report
that only matters on an instance exposed to the open internet is still
welcome, but it is likely to be answered by a documentation change.
