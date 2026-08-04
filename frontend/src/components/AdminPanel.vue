<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useAuth } from "../composables/useAuth";
import { trpc } from "../lib/trpc";

type ManagedUser = Awaited<ReturnType<typeof trpc.user.list.query>>[number];

const { user: currentUser } = useAuth();

const users = ref<ManagedUser[]>([]);
const error = ref<string | null>(null);
const busy = ref(false);

/**
 * Hiding this component from non-admins is a courtesy, not a control. Every procedure it
 * calls is an adminProcedure, and the service checks the role again underneath - so a
 * curious user poking at the console gets a 403, not a user list.
 */
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
		users.value = await trpc.user.list.query();
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
	<section class="admin">
		<h2>Users <span class="badge">admin only</span></h2>

		<p v-if="error" class="error" role="alert">{{ error }}</p>

		<ul>
			<li v-for="managed in users" :key="managed.id">
				<div>
					<strong>{{ managed.name }}</strong>
					<span class="role">{{ managed.role }}</span>
					<p>{{ managed.email }}</p>
				</div>

				<div class="actions">
					<!-- The server refuses to let the last admin demote themselves, so
					     do not offer the button that would only earn a 400. -->
					<template v-if="managed.id !== currentUser?.id">
						<button
							v-if="managed.role === 'user'"
							type="button"
							:disabled="busy"
							@click="setRole(managed, 'admin')"
						>
							Make admin
						</button>
						<button
							v-else
							type="button"
							:disabled="busy"
							@click="setRole(managed, 'user')"
						>
							Demote
						</button>

						<button type="button" :disabled="busy" @click="remove(managed)">
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
	border: 1px dashed var(--border);
	border-radius: 8px;
}

h2 {
	margin: 0;
	font-size: 1.1rem;
}

ul {
	display: grid;
	gap: 0.75rem;
	margin: 0;
	padding: 0;
	list-style: none;
}

li {
	display: flex;
	justify-content: space-between;
	gap: 1rem;
	align-items: center;
}

li p {
	margin: 0.2rem 0 0;
	color: var(--muted);
	font-size: 0.9rem;
}

.actions {
	display: flex;
	gap: 0.5rem;
	align-items: center;
}

.role,
.badge {
	margin-left: 0.5rem;
	padding: 0.1rem 0.45rem;
	border-radius: 999px;
	background: var(--border);
	font-size: 0.75rem;
}

.you {
	color: var(--muted);
	font-size: 0.85rem;
}

.error {
	margin: 0;
	color: #f87171;
}
</style>
