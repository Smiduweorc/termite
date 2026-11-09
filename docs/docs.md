# Documentation

## The model

There are four moving parts and that is the whole thing:

1. The board. Anyone posts an idea or a bug. No account, no email, no signup form.
2. Votes. Anyone raises a hand. Posting something counts as your vote, and you can take it back.
3. Releases. The maintainer plans a version, opens its merge window, pulls items into it, and ships. Everything in the window ships with it, in one step.
4. Task boards. The maintainer's own list or kanban for the work itself, private unless they publish it.

An item is `open`, `planned`, `shipped` or `declined`. That is the entire lifecycle. There is no "in progress", because nobody owes you a status update on a side project. `declined` carries a reason and stays on the board, so the same request does not arrive four more times.

A release is `planned`, `merge_window` or `released`. Planned releases can have no date at all, because "eventually" is a real answer and a fake date is not.

## Who can do what

| who                    | read | post | vote | edit their own wording | triage, plan, ship |
| ---------------------- | ---- | ---- | ---- | ---------------------- | ------------------ |
| passer-by (no account) | yes  | yes  | yes  | no                     | no                 |
| signed-in              | yes  | yes  | yes  | yes                    | no                 |
| maintainer (admin)     | yes  | yes  | yes  | yes                    | yes                |

Accounts exist because someone has to be the maintainer. A visitor never needs one, and the sign-in form is behind a link, not in front of the board.

Anonymous voters are a random token in an httpOnly cookie, stored only as a hash (`src/lib/voter.ts`). This is a show of hands, not an election: clearing cookies buys another vote, and stopping that would mean collecting things a feedback board has no business collecting. A signed-in person votes as their account instead, so their vote follows them between devices.

## Accounts

There is no sign-up, over tRPC or gRPC. Nothing on the public board needs an account.

A maintainer creates an account. It has no usable password until the person opens the one-time link sent to their address, so nobody, including the maintainer who created it, ever holds a password for someone else's account.

```sh
# The first maintainer, on a machine with no maintainer yet. Prints a one-time link;
# no password is typed into a shell or stored in history.
bun run admin:create you@example.com "Your Name"
```

Run it again on an existing account and it re-keys that one: promoted to admin if needed, fresh link, every outstanding link burned. That is the recovery path when you are locked out.

Forgotten passwords work the way you would expect, with two details: the reply is the same whether or not the address has an account, so the form can't be used to check who has one, and setting a password does not sign you in. You sign in with it afterwards.

Links are stored as SHA-256 hashes, are single-use, and burn any earlier outstanding link for the same person. Invites last seven days; resets last an hour.

Two addresses that reach one mailbox are one account. `John.Doe+termite@googlemail.com` and `johndoe@gmail.com` are the same inbox. [`@grml/nomadic`](https://www.npmjs.com/package/@grml/nomadic) turns each address into a canonical form using per-provider rules, and the unique index is on that form. The address as typed is kept for sending and display. Unknown domains are only lowercased, because on someone's own mail server `+` may be an ordinary character, and merging two real mailboxes is worse than one person having two accounts.

### Mail

SMTP is optional. With `SMTP_HOST` unset the app still runs and writes invite and reset links to the log instead of sending them, which is fine for a small board where you are the only account. Set the SMTP variables in `backend/.env.example` for anything where the log is not just yours.

## Task boards

The board tells you what people want. Task boards are where the maintainer tracks what they are doing about it, as a list or a kanban. Both show the same cards in the same order. Cards can link back to the request they came from and to the release they are aimed at.

Boards are private until published. A published board is readable by anyone and editable by nobody but the maintainer.

Columns are yours: any number, named whatever the work is called ("waiting on upstream", "needs a repro", "in the branch"). There is no mandatory done column. A card's `done` is a checkbox on the card, and by default no column means anything in particular.

If you want one, mark a column as done and the two stay in step: ticking a card sends it there, dragging it out un-ticks it. Unmark it and the board goes back to having no finish line. At most one done column and one default column per board, enforced by partial unique indexes. Columns can carry a WIP limit. Deleting a column moves its cards to the default column.

### Copying, and templates

The same work comes back every release (the same three chores before every tag, the same column of checks), so anything on a board can be copied:

| what       | where the copy goes                      | what comes with it                                                |
| ---------- | ---------------------------------------- | ----------------------------------------------------------------- |
| a card     | directly under the one it came from      | description, and the request and release it is linked to          |
| a column   | immediately to the right of the original | its WIP limit, and its cards unless you say `includeTasks: false` |
| a board    | a new board of its own                   | every column and card                                             |
| a template | a new board of its own                   | every column and card                                             |

A card or a column can also be copied onto another board by naming a column (`duplicateTask`) or a board (`duplicateBucket`) to land on, which is how a card is pulled off a template and onto the board you are working on.

Copies are named `"... (copy)"` unless you pass a title. A copied card counts against the target column's WIP limit like any other card; a copied _column_ does not, because its cards already fit where they came from. A copied card keeps whether it was ticked off, except that landing in a column marked as done ticks it, the same way dragging it there would.

A template is a board with `isTemplate` set, kept to be copied. It is edited with the same controls and listed on its own shelf instead of among the boards. Starting from one is the same copy that duplicates a board:

- `board.saveAsTemplate` copies the board you are on and files the copy as a template. The live board is untouched, so this is safe in the middle of a release.
- `board.useTemplate` starts a new board from one. The template stays a template.
- `board.duplicate` on a template gives another template; on a board, another board.
- `board.update({ isTemplate })` promotes a board or demotes a template, if you decide the shelf was wrong.

A copy is never published, even if the original was.

### How the ordering works

Cards are ordered by a floating-point `position`, not by 0,1,2,3. Dropping a card between two neighbours gives it the midpoint of their positions, so a drag writes one row. With integer ranks it would renumber everything below the drop, and two people dragging at once would interleave into an order neither asked for. This is fractional indexing, the same idea as Jira's LexoRank and Figma's fractional indices, done with the numeric type Postgres already sorts.

Halving a gap has a limit: split the same seam ~50 times and the midpoint stops being distinguishable. `src/lib/position.ts` detects that and the service renumbers that one column back onto clean spacing before placing the card. There is a test that drops a card into the same seam 80 times and checks the order still holds.

## The API

The board is a tRPC router (`feedback.*`, `release.*`, `board.*`, `auth.*`, `user.*`). The feedback, release and account services are also exposed over gRPC (`backend/proto/`) for scripts: closing a merge window from a release script, mirroring the board into a changelog, creating an account from a provisioning job. Reading is public on both; triage is the maintainer's.

Two differences between the transports:

- gRPC has no cookies, so an anonymous caller there can read and post but cannot vote. Voting anonymously is a browser thing.
- Task boards are tRPC-only. They are a drag-and-drop surface for one person.
