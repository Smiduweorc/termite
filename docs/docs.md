# Documentation
## The model

There are four moving parts and that is the whole thing:

1. **The board.** Anyone posts an idea or a bug. No account, no email, no signup form.
2. **Votes.** Anyone raises a hand. Posting something counts as your vote, and you can take it back.
3. **Releases.** The maintainer plans a version, opens its merge window, pulls items into it, and ships. Everything in the window ships with it, in one step.
4. **Task boards.** The maintainer's own surface for the work itself, as a list or a kanban, private unless they publish it.

An item is `open`, `planned`, `shipped` or `declined`. That is the entire lifecycle - there is no "in progress", because nobody owes you a status update on a side project. `declined` carries a reason and stays on the board, so the same request does not arrive four more times.

A release is `planned`, `merge_window` or `released`. Planned releases can have no date at all, because "eventually" is an honest answer and a fake date is not.

## Who can do what

| who | read | post | vote | edit their own wording | triage, plan, ship |
| --- | --- | --- | --- | --- | --- |
| passer-by (no account) | yes | yes | yes | no | no |
| signed-in | yes | yes | yes | yes | no |
| maintainer (admin) | yes | yes | yes | yes | yes |

Accounts exist for exactly one reason: someone has to be the maintainer. A visitor never needs one, and the sign-in form is tucked behind a link rather than put in front of the board.

Anonymous voters are a random token in an httpOnly cookie, stored only as a hash (`src/lib/voter.ts`). This is a show of hands, not an election - clearing cookies buys another vote, and the alternative is collecting things a feedback board has no business collecting. A signed-in person votes as their account instead, so their vote follows them between devices.

## Accounts

**There is no sign-up.** No register procedure exists over either transport - not guarded, absent. Nothing on the public board needs an account, so self-service registration would only ever have produced accounts nobody asked for.

An account is created by a maintainer, gets no usable password, and is activated by a one-time link sent to its address. Nobody - including the maintainer who created it - ever holds a password for someone else's account.

```sh
# The first maintainer, on a machine with no maintainer yet. Prints a one-time link;
# no password is typed into a shell or stored in history.
bun run admin:create you@example.com "Your Name"
```

Run it again on an existing account and it re-keys that one: promoted to admin if needed, fresh link, every outstanding link burned. That is the recovery path when you are locked out.

Forgotten passwords work the way you would expect, with two deliberate details: the reply is identical whether or not the address has an account (otherwise the form answers "does this person have an account here?" for anyone who asks), and setting a password does **not** hand back a session - proving you can read an inbox is enough to set a password, not enough to be signed in.

Links are stored as SHA-256 hashes, are single-use, and burn any earlier outstanding link for the same person. Invites last seven days; resets last an hour.

Two addresses that reach one mailbox are one account. `John.Doe+termite@googlemail.com` and `johndoe@gmail.com` are the same inbox, and without saying so they would be two accounts, two invites and two resets for one person. [`@grml/nomadic`](https://www.npmjs.com/package/@grml/nomadic) resolves each address to a canonical form using per-provider rules; that form is the identity and carries the unique index, while the address as typed is kept for sending and display. Unknown domains get lowercasing only - on someone's own mail server `+` may be an ordinary character, and collapsing two real mailboxes into one account is a worse failure than letting one person hold two.

### Mail

SMTP is optional. With `SMTP_HOST` unset the app still runs and writes invite and reset links to the log instead of sending them, which is a reasonable way to run a small self-hosted board where you are the only account. Set the SMTP variables in `backend/.env.example` for anything where the log is not just yours.

## Task boards

The board tells you what people want. This is where the maintainer tracks what they are actually doing about it - as a **list** or a **kanban**, which are two renderings of the same cards in the same order, not two orderings to keep in step. Cards can link back to the request they came from and to the release they are aimed at.

Boards are private until published. A published board is readable by anyone and editable by nobody but the maintainer.

**The columns are yours.** Any number of them, named after whatever the work is actually called - "waiting on upstream", "needs a repro", "in the branch". There is no fixed set, and there is **no mandatory done column**: a card's `done` is a checkbox on the card, and by default no column means anything in particular.

If you want one, mark a column as done and the two stay in step in both directions - ticking a card sends it there, dragging it out un-ticks it. Unmark it and the board goes back to having no finish line. At most one done column and one default column per board, enforced by partial unique indexes rather than by convention. Columns can carry a WIP limit; deleting a column moves its cards to the default one rather than deleting work.

### How the ordering works

Cards are ordered by a floating-point `position`, not by 0,1,2,3. Dropping a card between two neighbours gives it the midpoint of their positions, so a drag writes **one row** - with integer ranks it would renumber everything below the drop, and two people dragging at once would interleave into an order neither asked for. This is fractional indexing, the same idea as Jira's LexoRank and Figma's fractional indices, done with the numeric type Postgres already sorts.

Halving a gap has a limit: split the same seam ~50 times and the midpoint stops being distinguishable. `src/lib/position.ts` detects that and the service renumbers that one column back onto clean spacing before placing the card. There is a test that drops a card into the same seam 160 times and checks the order still holds.

## Running it

```sh
bun install
cp backend/.env.example backend/.env    # set JWT_SECRET: openssl rand -base64 48
bun run db:up                           # postgres in docker
bun run db:migrate
bun run admin:create you@example.com "Your Name"   # prints your one-time set-password link
bun run dev                             # api on :3000, board on :5173
```

`bun run db:seed` is optional and for development: it leaves a board with a shipped release behind it, an open merge window, a task board whose columns are not the usual three, and two accounts - `maintainer@example.com` (admin) and `contributor@example.com`, both `password123`. Seeded accounts are the one place a password is set directly; every other account gets one through a link.

```sh
bun run test        # backend runs against PGlite - no database needed
bun run typecheck
bun run lint
```

## The API

The board is a tRPC router (`feedback.*`, `release.*`, `board.*`, `auth.*`, `user.*`). The feedback, release and account services are also exposed over gRPC (`backend/proto/`) for scripts - closing a merge window from a release script, mirroring the board into a changelog, creating an account from a provisioning job. Reading is public on both; triage is the maintainer's.

Two differences between the transports, both deliberate:

- gRPC has no cookies, so an anonymous caller there can read and post but cannot vote - there is nothing to attribute the vote to. Voting anonymously is a browser thing.
- Task boards are tRPC-only. They are a drag-and-drop surface for one person, and a proto for them would be API surface nobody asked for.

