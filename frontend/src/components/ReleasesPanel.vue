<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useAuth } from "../composables/useAuth";
import { trpc } from "../lib/trpc";

type Release = Awaited<ReturnType<typeof trpc.release.list.query>>[number];
type Status = Release["status"];

const { user } = useAuth();

const releases = ref<Release[]>([]);
const error = ref<string | null>(null);
const busy = ref(false);

const version = ref("");
const name = ref("");
const plannedFor = ref("");

const isMaintainer = computed(() => user.value?.role === "admin");

const STATUS_LABEL: Record<Status, string> = {
	planned: "planned",
	merge_window: "merge window open",
	released: "released",
};

/** Dates arrive as ISO strings - tRPC serializes with plain JSON, so they are not Dates. */
function formatDate(value: string | null): string {
	if (!value) return "no date yet";

	return new Date(value).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

function when(release: Release): string {
	return release.releasedAt
		? `shipped ${formatDate(release.releasedAt)}`
		: `due ${formatDate(release.plannedFor)}`;
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
		releases.value = await trpc.release.list.query({});
	});

const create = () =>
	run(async () => {
		await trpc.release.create.mutate({
			version: version.value,
			...(name.value ? { name: name.value } : {}),
			// <input type="date"> gives "2026-08-09"; the server wants something Date can
			// parse, and midnight UTC is a fine reading of "that day".
			...(plannedFor.value ? { plannedFor: new Date(plannedFor.value).toISOString() } : {}),
		});

		version.value = "";
		name.value = "";
		plannedFor.value = "";

		// Reload rather than push: where a release lands depends on its date.
		await load();
	});

const setStatus = (release: Release, status: Status) =>
	run(async () => {
		await trpc.release.update.mutate({ id: release.id, status });
		await load();
	});

/**
 * The merge window closes. Everything aimed at this release ships with it, in one
 * step - which is the whole model, so it is worth an "are you sure".
 */
const ship = (release: Release) =>
	run(async () => {
		const ok = window.confirm(
			`Ship ${release.version}? Its ${release.itemCount} item(s) will be marked shipped.`,
		);

		if (!ok) return;

		await trpc.release.ship.mutate({ id: release.id });
		await load();
	});

const remove = (release: Release) =>
	run(async () => {
		await trpc.release.delete.mutate({ id: release.id });
		await load();
	});

onMounted(load);
</script>

<template>
	<section class="calendar">
		<form v-if="isMaintainer" class="composer panel" @submit.prevent="create">
			<input
				v-model="version"
				placeholder="Version (0.4, 2026.1, ...)"
				required
				maxlength="40"
				class="version-input"
			/>
			<input v-model="name" placeholder="Name (optional)" maxlength="80" />
			<input v-model="plannedFor" type="date" aria-label="Planned for" />
			<button type="submit" class="primary" :disabled="busy">Plan a release</button>
		</form>

		<p v-if="error" class="error" role="alert">{{ error }}</p>

		<p v-if="!releases.length && !busy" class="empty">
			No releases planned. This project ships when it ships.
		</p>

		<ol class="releases">
			<li v-for="release in releases" :key="release.id" class="panel" :class="release.status">
				<div class="what">
					<div class="head">
						<!-- A version is data, so it is set in the data face. -->
						<span class="version">{{ release.version }}</span>
						<span v-if="release.name" class="name">{{ release.name }}</span>
						<span class="status" :class="release.status">
							{{ STATUS_LABEL[release.status] }}
						</span>
					</div>

					<p class="when">{{ when(release) }} &middot; {{ release.itemCount }} item(s)</p>

					<p v-if="release.notes" class="notes">{{ release.notes }}</p>
				</div>

				<div v-if="isMaintainer" class="actions">
					<button
						v-if="release.status === 'planned'"
						type="button"
						:disabled="busy"
						@click="setStatus(release, 'merge_window')"
					>
						Open window
					</button>

					<button
						v-if="release.status !== 'released'"
						type="button"
						class="primary"
						:disabled="busy"
						@click="ship(release)"
					>
						Ship it
					</button>

					<!-- Shipped releases are history; the server refuses to delete them,
					     so do not offer a button that only earns a 409. -->
					<button
						v-if="release.status !== 'released'"
						type="button"
						class="quiet"
						:disabled="busy"
						@click="remove(release)"
					>
						Cancel
					</button>
				</div>
			</li>
		</ol>
	</section>
</template>

<style scoped>
.calendar {
	display: grid;
	gap: 1.25rem;
}

.composer {
	display: flex;
	gap: 0.75rem;
	flex-wrap: wrap;
	padding: 1.25rem;
}

.composer input {
	flex: 1;
	min-width: 9rem;
}

.version-input {
	font-family: var(--font-mono);
}

.releases {
	display: grid;
	gap: 0.75rem;
	margin: 0;
	padding: 0;
	list-style: none;
}

.releases li {
	display: flex;
	justify-content: space-between;
	gap: 1.25rem;
	padding: 1.1rem 1.25rem;
	flex-wrap: wrap;
}

/*
 * The window that is open right now is the one thing a reader came for, so it gets a
 * surface a step out of the dark - depth by tone, not a bright bar stuck to its edge.
 */
.releases li.merge_window {
	background: var(--raised);
	border-color: var(--comment);
}

.head {
	display: flex;
	align-items: baseline;
	gap: 0.7rem;
	flex-wrap: wrap;
}

.version {
	font-family: var(--font-mono);
	font-size: 1.15rem;
	font-weight: 500;
	color: var(--fg-strong);
}

.name {
	font-family: var(--font-display);
	font-variation-settings: "SOFT" 30, "WONK" 1;
	font-size: 1.05rem;
	color: var(--fg);
}

.status {
	color: var(--muted);
	font-size: 0.85rem;
}

.status.merge_window {
	color: var(--accent);
}

.when {
	margin: 0.4rem 0 0;
	color: var(--muted);
	font-size: 0.85rem;
}

.notes {
	margin: 0.5rem 0 0;
	max-width: 42rem;
	color: var(--muted);
	white-space: pre-wrap;
}

.actions {
	display: flex;
	gap: 0.5rem;
	align-items: flex-start;
	flex-wrap: wrap;
}
</style>
