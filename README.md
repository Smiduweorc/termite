# Termite

![Logo](./assets/logo.png)

Termite is a simple self-hostable, open source, feedback board of sorts and a release tracker for both non-technical and technical audiences and is made for people who ship software in versions. Not in an endless stream like some corporate projects.

> Read as Smiduweorc-termite, like how apache tools are read.

## Problem

If you maintain a small project (OSS, indie, side project or whatnot) and you have a small audience, you may or may not have ran into something similar:
- Every tracker is built for corporate teams.
	- AGILE is forced (random but agile is really mostly implemented as a variant of waterfall IRL)
	- Corporate slop is forced
	- AI is bolted
- These systems are made usually for customers as well so they typically have a lot of restrictions as business requirements of who can report what
	- Honestly fine, but maybe not a trait for some OSS communities
	- Account creation reqiured, which can cause the loss of feedback

None of these matches how small projects actually work. Most small projects don't ship constantly and are sometimes just maintainence only once being feature complete. There may be an occasional feature but even so it usually happens in bursts.

## What termite IS
Termite is a simple public board where anyone can drop an idea or a bug report. The community can upvote what matters to them and the maintainer decides what they want to add on their own schedule in their merge window.

It is a less enterprise solution and a more communal town hall system with a release calendar loosely taped to it.

## TERMITE IS NOT FOR YOU IF YOU
- **need sprint boards (go away, far away)**
- **story points (go away)**
- **burndown charts (go away)**
- **have sprints (go away)**
- **want AI features (go further away)**
- **want managing teams + assignees + permissions tiers or SLAs (NOPE)**
- **a glorified social media in a corporate environement with profiles (NOPE)**
- **batch-and-ship rhythm (termite is made for release cycles. if you do not have one, the model we have is just plainly not for you)**
- **backlog that is long living (termite is also made for projects that may or may not reach feature completeness)**

## Extra Lore

### Upcoming features:
- Announcements
- Configurations for scheduled releases and more
- Basic word filter that is configurable

### Original Use Case:
A few friends of mine were working on a project that needed some project tracking and the single todo list in the repo was not cutting it anymore. So we started turning to various solutions but they each had their own complicated solution. One thing that we liked was vikunja, however, some things were too complicated for us feature wise and there were some things that seemed to be premium only, which no disrespect was all within their right to do so and was not actually too bad, but just wasn't for us since we only needed a simple solution that we can self host.

That said, we eventually decided to make our own, that is protected behind a VPN (wireguard) so that only specific users that we want in our project can make requests and more. So yes we don't expect people to actually use this since it is super niche and we only needed something simple that was in a controlled environment where we did not need to worry too much about safety. (Tldr it is an internal forum)