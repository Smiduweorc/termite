<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useAuth } from "../composables/useAuth";
import { trpc } from "../lib/trpc";

// No hand-written interfaces: the types come back from the router.
type Item = Awaited<ReturnType<typeof trpc.feedback.list.query>>[number];
type Release = Awaited<ReturnType<typeof trpc.release.list.query>>[number];
type Kind = Item["kind"];
type Status = Item["status"];

const { user } = useAuth();

const items = ref<Item[]>([]);
const releases = ref<Release[]>([]);
const error = ref<string | null>(null);
const busy = ref(false);

const sort = ref<"top" | "new">("top");
const kindFilter = ref<Kind | "">("");
const statusFilter = ref<Status | "">("open");

const kind = ref<Kind>("idea");
const title = ref("");
const body = ref("");
const authorName = ref("");

/**
 * The maintainer. Everything gated on this is a courtesy - the same rule is enforced in
 * feedback.service.ts, so a curious visitor calling the procedure directly gets a 403
 * rather than a triage control.
 */
const isMaintainer = computed(() => user.value?.role === "admin");

/** Null for a visitor, which is most of them. Named so the template never touches the ref. */
const filingAs = computed(() => user.value?.name ?? null);

function releaseFor(item: Item): Release | undefined {
	return releases.value.find((release) => release.id === item.releaseId);
}

/**
 * Where an item stands, as a sentence rather than a coloured chip.
 *
 * "planned for 0.2" says more than a pill reading PLANNED, and it costs the page one
 * short phrase instead of another rounded label. Open items say nothing at all, because
 * open is the resting state and a badge announcing it would be noise on every row.
 */
function standing(item: Item): string {
	const version = releaseFor(item)?.version;

	if (item.status === "planned") return version ? `planned for ${version}` : "planned";
	if (item.status === "shipped") return version ? `shipped in ${version}` : "shipped";
	if (item.status === "declined") return "declined";

	return "";
}

function attribution(item: Item): string {
	if (item.authorId) return "a signed-in contributor";

	return item.authorName ? item.authorName : "anonymous";
}

async function run(action: () => Promise<void>) {
	busy.value = true;
	error.value = null;

	try {
		await action();
	} catch (cause) {
		error.value = cause instanceof Error ? cause.message : "Something went wrong";
	} finally {
		busy.value = false;
	}
}

const load = () =>
	run(async () => {
		items.value = await trpc.feedback.list.query({
			sort: sort.value,
			...(kindFilter.value ? { kind: kindFilter.value } : {}),
			...(statusFilter.value ? { status: statusFilter.value } : {}),
		});
	});

const loadReleases = () =>
	run(async () => {
		releases.value = await trpc.release.list.query({});
	});

const submit = () =>
	run(async () => {
		const item = await trpc.feedback.submit.mutate({
			kind: kind.value,
			title: title.value,
			body: body.value,
			...(authorName.value ? { authorName: authorName.value } : {}),
		});

		// A filed item is open, so it only belongs in the list the visitor is currently
		// looking at if that list would have it. Otherwise reload and let the filter decide.
		if (statusFilter.value === "" || statusFilter.value === "open") {
			items.value = [item, ...items.value];
		}

		title.value = "";
		body.value = "";
	});

function replace(updated: Item) {
	items.value = items.value.map((item) => (item.id === updated.id ? updated : item));
}

const toggleVote = (item: Item) =>
	run(async () => {
		// The server owns the count; the response is what the UI trusts, not a local ++.
		replace(
			item.viewerHasVoted
				? await trpc.feedback.unvote.mutate({ id: item.id })
				: await trpc.feedback.vote.mutate({ id: item.id }),
		);
	});

const setStatus = (item: Item, status: Status) =>
	run(async () => {
		replace(await trpc.feedback.edit.mutate({ id: item.id, status }));
	});

const assign = (item: Item, releaseId: string) =>
	run(async () => {
		// Putting an item in a window plans it; the server does that bookkeeping.
		replace(await trpc.feedback.edit.mutate({ id: item.id, releaseId: releaseId || null }));
	});

const decline = (item: Item) =>
	run(async () => {
		const note = window.prompt("Why? Shown on the board.");

		if (note === null) return;

		replace(
			await trpc.feedback.edit.mutate({
				id: item.id,
				status: "declined",
				maintainerNote: note || null,
			}),
		);
	});

const remove = (item: Item) =>
	run(async () => {
		await trpc.feedback.delete.mutate({ id: item.id });

		items.value = items.value.filter((other) => other.id !== item.id);
	});

// Filters are server-side: what "top" means depends on the whole board, not on the
// twenty rows that happen to be loaded.
watch([sort, kindFilter, statusFilter], load);

onMounted(async () => {
	await load();
	await loadReleases();
});
</script>

<template>
	<section class="board">
		<form class="composer panel" @submit.prevent="submit">
			<!--
				Two words, and the one you are filing is simply the one set in the
				brighter ink. No pills, no segmented control drawn as a toggle.
			-->
			<div class="kinds">
				<button
					type="button"
					:class="{ chosen: kind === 'idea' }"
					:aria-pressed="kind === 'idea'"
					@click="kind = 'idea'"
				>
					An idea
				</button>
				<button
					type="button"
					:class="{ chosen: kind === 'bug' }"
					:aria-pressed="kind === 'bug'"
					@click="kind = 'bug'"
				>
					A bug
				</button>
			</div>

			<input v-model="title" placeholder="Title" required maxlength="200" />
			<textarea v-model="body" placeholder="Details" required rows="3" />

			<div class="composer-footer">
				<input
					v-if="!filingAs"
					v-model="authorName"
					placeholder="Your name (optional)"
					maxlength="80"
				/>
				<span v-else class="hint">Filing as {{ filingAs }}</span>

				<button type="submit" class="primary" :disabled="busy">Post to the board</button>
			</div>

			<p class="hint">No account needed. Posting counts as your vote.</p>
		</form>

		<div class="filters">
			<select v-model="statusFilter" aria-label="Status">
				<option value="">Everything</option>
				<option value="open">Open</option>
				<option value="planned">Planned</option>
				<option value="shipped">Shipped</option>
				<option value="declined">Declined</option>
			</select>

			<select v-model="kindFilter" aria-label="Kind">
				<option value="">Ideas and bugs</option>
				<option value="idea">Ideas</option>
				<option value="bug">Bugs</option>
			</select>

			<select v-model="sort" aria-label="Sort">
				<option value="top">Most wanted</option>
				<option value="new">Newest</option>
			</select>
		</div>

		<p v-if="error" class="error" role="alert">{{ error }}</p>

		<p v-if="!items.length && !busy" class="empty">No ideas or bugs yet.</p>

		<ul class="items">
			<li v-for="item in items" :key="item.id" class="panel">
				<!--
					The vote. A gnawed key with the tally in the data face, centred both
					ways and proven so, and the wedge above it cut by hand rather than
					lifted from an icon set. Amber only when it is yours.
				-->
				<button
					type="button"
					class="vote"
					:class="{ voted: item.viewerHasVoted }"
					:disabled="busy"
					:aria-pressed="item.viewerHasVoted"
					:aria-label="`${item.votes} ${item.votes === 1 ? 'vote' : 'votes'}`"
					@click="toggleVote(item)"
				>
					<svg viewBox="0 0 22 12" class="wedge" aria-hidden="true">
						<path
							d="M1.6 10.4C4.9 4.6 7.9 1.5 11 1.5c3.2 0 6.2 3.1 9.4 8.9"
							fill="none"
							stroke="currentColor"
							stroke-width="2.4"
							stroke-linecap="round"
							stroke-linejoin="round"
						/>
					</svg>
					<span class="count">{{ item.votes }}</span>
				</button>

				<div class="item">
					<div class="head">
						<h3 class="title">{{ item.title }}</h3>
						<span v-if="standing(item)" class="standing" :class="item.status">
							{{ standing(item) }}
						</span>
					</div>

					<p class="body">{{ item.body }}</p>

					<p v-if="item.maintainerNote" class="note">
						<span class="who">The maintainer said</span>
						{{ item.maintainerNote }}
					</p>

					<p class="meta">
						<span class="kind">{{ item.kind }}</span>
						<span class="sep" aria-hidden="true">&middot;</span>
						filed by {{ attribution(item) }}
					</p>

					<div v-if="isMaintainer" class="triage">
						<select
							:value="item.releaseId ?? ''"
							:disabled="busy"
							aria-label="Merge window"
							@change="assign(item, ($event.target as HTMLSelectElement).value)"
						>
							<option value="">No window</option>
							<option v-for="release in releases" :key="release.id" :value="release.id">
								{{ release.version }}
							</option>
						</select>

						<button
							v-if="item.status !== 'declined'"
							type="button"
							class="quiet"
							:disabled="busy"
							@click="decline(item)"
						>
							Decline
						</button>
						<button
							v-else
							type="button"
							class="quiet"
							:disabled="busy"
							@click="setStatus(item, 'open')"
						>
							Reopen
						</button>

						<button type="button" class="quiet" :disabled="busy" @click="remove(item)">
							Delete
						</button>
					</div>
				</div>
			</li>
		</ul>
	</section>
</template>

<style scoped>
.board {
	display: grid;
	gap: 1.25rem;
}

.composer {
	display: grid;
	gap: 0.75rem;
	padding: 1.25rem;
}

.composer-footer {
	display: flex;
	gap: 0.75rem;
	align-items: center;
	justify-content: space-between;
	flex-wrap: wrap;
}

.composer-footer input {
	flex: 1;
	min-width: 12rem;
}

.kinds {
	display: flex;
	gap: 1rem;
}

/* Choosing is a change of ink and weight, not a filled capsule. */
.kinds button {
	padding: 0.15rem 0;
	border: none;
	border-radius: 0;
	background: none;
	color: var(--muted);
	font-family: var(--font-display);
	font-variation-settings: "SOFT" 30, "WONK" 1;
	font-size: 1.1rem;
}

.kinds button:hover:not(:disabled) {
	color: var(--fg);
}

.kinds button.chosen {
	color: var(--fg-strong);
	font-weight: 600;
}

.filters {
	display: flex;
	gap: 0.5rem;
	flex-wrap: wrap;
}

.items {
	display: grid;
	gap: 0.75rem;
	margin: 0;
	padding: 0;
	list-style: none;
}

.items li {
	display: flex;
	gap: 1rem;
	padding: 1.1rem 1.25rem;
	align-items: flex-start;
}

/*
 * The vote key. Fixed width so every row's text starts on the same line, and the
 * contents centred on both axes - the wedge optically, the number mathematically.
 */
.vote {
	flex: 0 0 auto;
	width: 3.4rem;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 0.25rem;
	padding: 0.5rem 0;
	border-radius: var(--cut-b);
	color: var(--muted);
	line-height: 1;
}

.vote .wedge {
	width: 1.15rem;
	height: 0.7rem;
	display: block;
}

.vote .count {
	font-family: var(--font-mono);
	font-size: 1rem;
	font-weight: 500;
	color: var(--fg-strong);
	font-variant-numeric: tabular-nums;
}

.vote:hover:not(:disabled) {
	color: var(--fg);
}

.vote.voted {
	border-color: var(--accent);
	color: var(--accent);
}

.vote.voted .count {
	color: var(--accent);
}

.item {
	flex: 1;
	min-width: 0;
}

.head {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 0.75rem;
	flex-wrap: wrap;
}

.title {
	font-size: 1.15rem;
	font-weight: 600;
	line-height: 1.25;
}

/* Where it stands, said in words. Amber only for the one state that is a promise. */
.standing {
	font-size: 0.85rem;
	color: var(--muted);
	white-space: nowrap;
}

.standing.planned {
	color: var(--accent);
}

.standing.shipped {
	color: var(--fg);
}

.body {
	margin: 0.4rem 0 0;
	color: var(--muted);
	white-space: pre-wrap;
}

/*
 * The maintainer's answer, set on the raised surface so it reads as a reply pinned to
 * the item rather than more of the same paragraph. No decorative rule down its side.
 */
.note {
	margin: 0.7rem 0 0;
	padding: 0.6rem 0.75rem;
	background: var(--raised);
	border-radius: var(--cut-tight);
	color: var(--fg);
	font-size: 0.9rem;
}

.note .who {
	display: block;
	color: var(--muted);
	font-size: 0.78rem;
}

.meta {
	margin: 0.6rem 0 0;
	color: var(--muted);
	font-size: 0.82rem;
}

.meta .kind {
	color: var(--muted);
}

.meta .sep {
	margin: 0 0.4rem;
}

.triage {
	display: flex;
	gap: 0.6rem;
	align-items: center;
	margin-top: 0.75rem;
	flex-wrap: wrap;
}

@media (max-width: 34rem) {
	.items li {
		padding: 1rem;
		gap: 0.75rem;
	}
}
</style>
