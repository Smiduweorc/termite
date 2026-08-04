<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import AdminPanel from "./components/AdminPanel.vue";
import AuthPanel from "./components/AuthPanel.vue";
import PostsPanel from "./components/PostsPanel.vue";
import { useAuth } from "./composables/useAuth";
import { trpc } from "./lib/trpc";

const { user, ready, load, logout } = useAuth();

const status = ref("checking...");

const isAdmin = computed(() => user.value?.role === "admin");

onMounted(async () => {
	// Restores the session from the httpOnly cookie, refreshing it if the short-lived
	// access token has already lapsed. Until it settles we render neither the login form
	// nor the app - otherwise a signed-in user gets a flash of "please sign in".
	await load();

	try {
		const { status: ok } = await trpc.health.ping.query();

		status.value = ok;
	} catch {
		status.value = "unreachable - is the backend running?";
	}
});
</script>

<template>
	<main>
		<header>
			<div>
				<h1>BEVD</h1>
				<p>Bun, Elysia, Vue, and Drizzle - tRPC and gRPC, with JWT auth.</p>
				<p class="status">backend: {{ status }}</p>
			</div>

			<div v-if="user" class="session">
				<span>
					{{ user.name }}
					<span class="role">{{ user.role }}</span>
				</span>
				<button type="button" @click="logout">Sign out</button>
			</div>
		</header>

		<template v-if="ready">
			<AuthPanel v-if="!user" />

			<AdminPanel v-if="isAdmin" />

			<!-- Keyed on the user: signing in or out rebuilds the panel, which reloads the
			     list. What you are allowed to see just changed, so ask again. -->
			<PostsPanel :key="user?.id ?? 'anonymous'" />
		</template>
	</main>
</template>

<style scoped>
main {
	max-width: 42rem;
	margin: 0 auto;
	padding: 3rem 1.5rem;
	display: grid;
	gap: 2rem;
}

header {
	display: flex;
	justify-content: space-between;
	align-items: flex-start;
	gap: 1rem;
}

h1 {
	margin: 0;
}

header p {
	margin: 0.25rem 0 0;
	color: var(--muted);
}

.status {
	font-family: ui-monospace, monospace;
	font-size: 0.85rem;
}

.session {
	display: flex;
	align-items: center;
	gap: 0.75rem;
	white-space: nowrap;
}

.role {
	margin-left: 0.25rem;
	padding: 0.1rem 0.45rem;
	border-radius: 999px;
	background: var(--border);
	font-size: 0.75rem;
}
</style>
