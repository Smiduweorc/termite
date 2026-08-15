<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useAuth } from "../composables/useAuth";
import { trpc } from "../lib/trpc";

type ManagedUser = Awaited<ReturnType<typeof trpc.user.list.query>>[number];

const { user: currentUser } = useAuth();

const users = ref<ManagedUser[]>([]);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);

const newEmail = ref("");
const newName = ref("");
const newIsAdmin = ref(false);

/**
 * Hiding this component from non-admins is a courtesy, not a control. Every procedure it
 * calls is an adminProcedure, and the service checks the role again underneath - so a
 * curious user poking at the console gets a 403, not a user list.
 */
async function run(action: () => Promise<void>) {
	busy.value = true;
	error.value = null;
	notice.value = null;

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
		users.value = await trpc.user.list.query();
	});

/**
 * The only way an account comes into being - there is no sign-up form anywhere.
 *
 * No password is set here, by anyone: the server mails a one-time link and the person
 * chooses their own. So there is nothing to communicate, and nothing to leak.
 */
const create = () =>
	run(async () => {
		const created = await trpc.user.create.mutate({
			email: newEmail.value,
			name: newName.value,
			...(newIsAdmin.value ? { role: "admin" as const } : {}),
		});

		users.value = [...users.value, created];
		notice.value = `Invite sent to ${created.email}.`;
		newEmail.value = "";
		newName.value = "";
		newIsAdmin.value = false;
	});

const resendInvite = (target: ManagedUser) =>
	run(async () => {
		await trpc.user.resendInvite.mutate({ userId: target.id });
		notice.value = `New link sent to ${target.email}. The old one no longer works.`;
	});

const setRole = (target: ManagedUser, role: "user" | "admin") =>
	run(async () => {
		const updated = await trpc.user.setRole.mutate({ userId: target.id, role });

		users.value = users.value.map((u) => (u.id === updated.id ? updated : u));
	});

const remove = (target: ManagedUser) =>
	run(async () => {
		await trpc.user.delete.mutate({ userId: target.id });

		users.value = users.value.filter((u) => u.id !== target.id);
	});

onMounted(load);
</script>

<template>
	<section class="admin panel">
		<h2 class="section-title">Users</h2>

		<form class="invite" @submit.prevent="create">
			<input v-model="newEmail" type="email" placeholder="Email" required />
			<input v-model="newName" placeholder="Name" required maxlength="100" />
			<label class="as-admin">
				<input v-model="newIsAdmin" type="checkbox" />
				maintainer
			</label>
			<button type="submit" class="primary" :disabled="busy">Send invite</button>
		</form>

		<p class="hint">Creating an account emails a one-time link to set a password.</p>

		<p v-if="error" class="error" role="alert">{{ error }}</p>
		<p v-if="notice" class="notice" role="status">{{ notice }}</p>

		<ul>
			<li v-for="managed in users" :key="managed.id">
				<div>
					<strong>{{ managed.name }}</strong>
					<span class="role">{{ managed.role }}</span>
					<p>{{ managed.email }}</p>
				</div>

				<div class="actions">
					<button type="button" class="quiet" :disabled="busy" @click="resendInvite(managed)">
						Resend invite
					</button>

					<!-- The server refuses to let the last admin demote themselves, so
					     do not offer the button that would only earn a 400. -->
					<template v-if="managed.id !== currentUser?.id">
						<button
							v-if="managed.role === 'user'"
							type="button"
							class="quiet"
							:disabled="busy"
							@click="setRole(managed, 'admin')"
						>
							Make admin
						</button>
						<button
							v-else
							type="button"
							class="quiet"
							:disabled="busy"
							@click="setRole(managed, 'user')"
						>
							Demote
						</button>

						<button type="button" class="quiet" :disabled="busy" @click="remove(managed)">
							Delete
						</button>
					</template>

					<span v-else class="you">you</span>
				</div>
			</li>
		</ul>
	</section>
</template>

<style scoped>
.admin {
	display: grid;
	gap: 1rem;
	padding: 1.5rem;
}

ul {
	display: grid;
	gap: 0.6rem;
	margin: 0;
	padding: 0;
	list-style: none;
}

li {
	display: flex;
	justify-content: space-between;
	gap: 1rem;
	align-items: center;
	flex-wrap: wrap;
	padding: 0.6rem 0.75rem;
	background: var(--raised);
	border-radius: var(--cut-tight);
}

li strong {
	color: var(--fg-strong);
	font-weight: 500;
}

li p {
	margin: 0.15rem 0 0;
	color: var(--muted);
	font-size: 0.85rem;
}

/* The role is a fact about the account, so it is set in the data face. */
.role {
	margin-left: 0.5rem;
	color: var(--muted);
	font-family: var(--font-mono);
	font-size: 0.75rem;
}

.actions {
	display: flex;
	gap: 0.4rem;
	align-items: center;
	flex-wrap: wrap;
}

.invite {
	display: flex;
	gap: 0.5rem;
	flex-wrap: wrap;
	align-items: center;
}

.invite input[type="email"],
.invite input:not([type]) {
	flex: 1;
	min-width: 10rem;
}

.as-admin {
	display: flex;
	align-items: center;
	gap: 0.4rem;
	color: var(--muted);
	font-size: 0.85rem;
	cursor: pointer;
}

.you {
	color: var(--muted);
	font-size: 0.82rem;
}
</style>
