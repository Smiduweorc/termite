<script setup lang="ts">
import { ref } from "vue";
import { useAuth } from "../composables/useAuth";
import { trpc } from "../lib/trpc";

/**
 * Sign in, or ask for a way back in. There is no third tab.
 * accounts are created by a maintainer and picked up through an
 * emailed link. The board itself never needed one, so there is nothing for a visitor to
 * sign up to and no form here that pretends otherwise.
 */
const { login } = useAuth();

const mode = ref<"login" | "forgot">("login");
const email = ref("");
const password = ref("");
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);

async function submit() {
	busy.value = true;
	error.value = null;
	notice.value = null;

	try {
		if (mode.value === "login") {
			await login(email.value, password.value);
			password.value = "";

			return;
		}

		await trpc.auth.forgotPassword.mutate({ email: email.value });

		// Deliberately the same message whether or not that address has an account -
		// the server will not say, and neither will this.
		notice.value = "If that address has an account, a reset link is on its way.";
	} catch (cause) {
		// The server says "Invalid email or password" for both a wrong password and an
		// unknown account - deliberately. Show what it said, do not try to be helpful.
		error.value = cause instanceof Error ? cause.message : "Could not sign in";
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<section class="auth panel">
		<div class="tabs">
			<button type="button" :class="{ active: mode === 'login' }" @click="mode = 'login'">
				Sign in
			</button>
			<button type="button" :class="{ active: mode === 'forgot' }" @click="mode = 'forgot'">
				Forgot password
			</button>
		</div>

		<form @submit.prevent="submit">
			<input v-model="email" type="email" placeholder="Email" required autocomplete="email" />

			<input
				v-if="mode === 'login'"
				v-model="password"
				type="password"
				placeholder="Password"
				required
				minlength="8"
				autocomplete="current-password"
			/>

			<button type="submit" class="primary" :disabled="busy">
				{{ mode === "login" ? "Sign in" : "Email me a link" }}
			</button>
		</form>

		<p v-if="error" class="error" role="alert">{{ error }}</p>
		<p v-if="notice" class="notice" role="status">{{ notice }}</p>
	</section>
</template>

<style scoped>
.auth {
	display: grid;
	gap: 1rem;
	padding: 1.5rem;
	max-width: 26rem;
}

.tabs {
	display: flex;
	gap: 1.25rem;
	align-items: baseline;
}

/* Which mode you are in is the brighter word, not a filled tab. */
.tabs button {
	padding: 0.15rem 0;
	border: none;
	border-radius: 0;
	background: none;
	color: var(--muted);
	font-family: var(--font-display);
	font-variation-settings: "SOFT" 30, "WONK" 1;
	font-size: 1.05rem;
}

.tabs button:hover:not(:disabled) {
	color: var(--fg);
}

.tabs .active {
	color: var(--fg-strong);
	font-weight: 600;
}

form {
	display: grid;
	gap: 0.75rem;
}
</style>
