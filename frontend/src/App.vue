<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import AdminPanel from "./components/AdminPanel.vue";
import AuthPanel from "./components/AuthPanel.vue";
import BoardPanel from "./components/BoardPanel.vue";
import BoardsPanel from "./components/BoardsPanel.vue";
import ReleasesPanel from "./components/ReleasesPanel.vue";
import SetPasswordPanel from "./components/SetPasswordPanel.vue";
import TermiteMark from "./components/TermiteMark.vue";
import { useAuth } from "./composables/useAuth";

const { user, ready, load, logout } = useAuth();

const tab = ref<"board" | "releases" | "tasks">("board");

/**
 * Sign-in is a drawer, not a gate. Nothing on the board needs an account, and putting a
 * login form in front of a feedback board is how a project stops hearing from people -
 * so the form only appears for the one person who actually needs it.
 */
const showSignIn = ref(false);

/**
 * The token out of an invite or reset link.
 *
 * It is read once and then stripped from the address bar: it is a one-time credential,
 * and leaving it in the URL leaves it in the history, in the next screenshot, and in
 * whatever the browser syncs. Reading it before `load()` matters too - someone resetting
 * a password may well already have a stale session.
 */
const linkToken = ref<string | null>(null);

const isAdmin = computed(() => user.value?.role === "admin");
const signedInName = computed(() => user.value?.name ?? null);
const signedInRole = computed(() => user.value?.role ?? null);

function afterPasswordSet() {
	linkToken.value = null;
	showSignIn.value = true;
}

onMounted(async () => {
	const token = new URLSearchParams(window.location.search).get("token");

	if (token) {
		linkToken.value = token;
		window.history.replaceState({}, "", window.location.pathname);
	}

	// Restores the session from the httpOnly cookie, refreshing it if the short-lived
	// access token has already lapsed. Until it settles we render nothing that depends on
	// who you are - otherwise a signed-in maintainer gets a flash of the visitor's view.
	await load();
});
</script>

<template>
	<div class="shell">
		<header class="masthead">
			<div class="masthead-inner">
				<div class="identity">
					<TermiteMark :size="46" alt="Termite" />

					<div>
						<h1>Termite</h1>
						<p class="tagline">
							Build software, not an endless backlog.
						</p>
					</div>
				</div>

				<div class="who">
					<template v-if="signedInName">
						<span class="name">
							{{ signedInName }}
							<span class="role">{{ signedInRole }}</span>
						</span>
						<button type="button" class="quiet" @click="logout">Sign out</button>
					</template>

					<button
						v-else-if="ready"
						type="button"
						class="quiet"
						@click="showSignIn = !showSignIn"
					>
						Maintainer sign-in
					</button>
				</div>
			</div>
		</header>

		<main>
			<template v-if="ready">
				<SetPasswordPanel
					v-if="linkToken"
					:token="linkToken"
					@done="afterPasswordSet"
					@dismiss="linkToken = null"
				/>

				<AuthPanel v-if="!user && showSignIn" />

				<!--
					The nav is the three rooms of the app. The current one is stated in
					the type - weight and ink - rather than marked with a dot or a
					sliding bar underneath it.
				-->
				<nav class="rooms" aria-label="Sections">
					<button
						type="button"
						:class="{ here: tab === 'board' }"
						:aria-current="tab === 'board' ? 'page' : undefined"
						@click="tab = 'board'"
					>
						Board
					</button>
					<button
						type="button"
						:class="{ here: tab === 'releases' }"
						:aria-current="tab === 'releases' ? 'page' : undefined"
						@click="tab = 'releases'"
					>
						Releases
					</button>
					<button
						type="button"
						:class="{ here: tab === 'tasks' }"
						:aria-current="tab === 'tasks' ? 'page' : undefined"
						@click="tab = 'tasks'"
					>
						Tasks
					</button>
				</nav>

				<!-- Keyed on the user: signing in or out rebuilds the panel, which
				     reloads. What you are allowed to do just changed, so ask again. -->
				<BoardPanel v-show="tab === 'board'" :key="`board-${user?.id ?? 'anonymous'}`" />
				<ReleasesPanel
					v-show="tab === 'releases'"
					:key="`releases-${user?.id ?? 'anonymous'}`"
				/>
				<BoardsPanel v-show="tab === 'tasks'" :key="`tasks-${user?.id ?? 'anonymous'}`" />

				<AdminPanel v-if="isAdmin" />
			</template>
		</main>

		<footer>
			<TermiteMark :size="22" />
			<p>Termite - made with <3 by smiduweorc.</p>
		</footer>
	</div>
</template>

<style scoped>
.shell {
	min-height: 100vh;
	display: flex;
	flex-direction: column;
}

/*
 * The mark, the name and whoever is signed in, on the same surface as everything else.
 * No rule under it and nothing drawn behind it: the page is one continuous field of
 * wood, and the header is separated from the content by space alone. Padding is generous
 * on every side so no word ever arrives at an edge without a gutter.
 */
.masthead-inner {
	max-width: 60rem;
	margin: 0 auto;
	padding: 2.75rem 1.5rem 2.25rem;
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 1.5rem;
	flex-wrap: wrap;
}

.identity {
	display: flex;
	align-items: center;
	gap: 1rem;
}

h1 {
	font-size: clamp(2.1rem, 5vw, 2.9rem);
	letter-spacing: -0.015em;
	margin: 0;
}

.tagline {
	margin: 0.35rem 0 0;
	max-width: 30rem;
	color: var(--muted);
	font-size: 0.95rem;
}

.who {
	display: flex;
	align-items: center;
	gap: 0.75rem;
	padding-top: 0.5rem;
	white-space: nowrap;
}

.name {
	color: var(--fg-strong);
	font-size: 0.9rem;
}

/* The role is data about the account, so it is set in the data face, not in a chip. */
.role {
	margin-left: 0.4rem;
	color: var(--muted);
	font-family: var(--font-mono);
	font-size: 0.75rem;
}

main {
	flex: 1;
	width: 100%;
	max-width: 60rem;
	margin: 0 auto;
	padding: 2rem 1.5rem 4rem;
	display: grid;
	gap: 1.75rem;
	align-content: start;
}

/*
 * No rail under the tabs and no marker beneath the current one. Which room you are in
 * is carried by the ink and the weight of the word itself, which is the only thing a
 * hairline under it would have been standing in for.
 */
.rooms {
	display: flex;
	gap: 1.5rem;
}

.rooms button {
	padding: 0.35rem 0;
	border: none;
	border-radius: 0;
	background: none;
	color: var(--muted);
	font-family: var(--font-display);
	font-variation-settings: "SOFT" 30, "WONK" 1;
	font-size: 1.05rem;
}

.rooms button:hover:not(:disabled) {
	color: var(--fg);
}

.rooms button.here {
	color: var(--fg-strong);
	font-weight: 600;
}

footer {
	display: flex;
	align-items: center;
	gap: 0.6rem;
	max-width: 60rem;
	width: 100%;
	margin: 0 auto;
	/* Separated by space and by the mark, not by a drawn line. */
	padding: 0.5rem 1.5rem 2.5rem;
	color: var(--muted);
	font-size: 0.85rem;
}

footer p {
	margin: 0;
}

@media (max-width: 40rem) {
	.masthead-inner {
		padding: 2rem 1.25rem 1.75rem;
	}

	main {
		padding: 1.5rem 1.25rem 3rem;
	}

	.rooms {
		gap: 1.1rem;
	}
}
</style>
