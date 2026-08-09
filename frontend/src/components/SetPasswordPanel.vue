<script setup lang="ts">
import { ref } from "vue";
import { trpc } from "../lib/trpc";

/**
 * Where an invite or reset link lands.
 *
 * The token comes out of the query string (see App.vue) and goes straight back to the
 * server - it is never stored, and the URL is cleaned up afterwards so the credential
 * does not sit in the address bar, the history, or the next screenshot.
 */
const props = defineProps<{ token: string }>();
const emit = defineEmits<{ done: []; dismiss: [] }>();

const password = ref("");
const confirmation = ref("");
const error = ref<string | null>(null);
const busy = ref(false);

async function submit() {
	if (password.value !== confirmation.value) {
		error.value = "Those two do not match";

		return;
	}

	busy.value = true;
	error.value = null;

	try {
		await trpc.auth.setPassword.mutate({ token: props.token, password: password.value });

		// Setting a password does not sign you in - the server hands back no session on
		// purpose - so the next step is the ordinary login form.
		emit("done");
	} catch (cause) {
		error.value = cause instanceof Error ? cause.message : "That link did not work";
	} finally {
		busy.value = false;
		password.value = "";
		confirmation.value = "";
	}
}
</script>

<template>
	<section class="set-password panel">
		<h2 class="section-title">Choose a password</h2>

		<form @submit.prevent="submit">
			<input
				v-model="password"
				type="password"
				placeholder="New password"
				required
				minlength="8"
				autocomplete="new-password"
			/>
			<input
				v-model="confirmation"
				type="password"
				placeholder="Again, to be sure"
				required
				minlength="8"
				autocomplete="new-password"
			/>

			<div class="actions">
				<button type="submit" class="primary" :disabled="busy">Set password</button>
				<button type="button" class="quiet" @click="emit('dismiss')">Cancel</button>
			</div>
		</form>

		<p v-if="error" class="error" role="alert">{{ error }}</p>

		<p class="hint">The link works once. If it has expired, ask for another one.</p>
	</section>
</template>

<style scoped>
/*
 * The one screen that is genuinely a door: someone followed a link out of their inbox
 * to get here. It carries the amber edge because it is the only place in the app where
 * that means "this is the thing you came to do".
 */
.set-password {
	display: grid;
	gap: 1rem;
	padding: 1.5rem;
	max-width: 26rem;
	border-color: var(--accent);
}

form {
	display: grid;
	gap: 0.75rem;
}

.actions {
	display: flex;
	gap: 0.75rem;
	align-items: center;
}

.actions .quiet {
	padding: 0.5rem 0.25rem;
	font-size: 0.9rem;
}
</style>
