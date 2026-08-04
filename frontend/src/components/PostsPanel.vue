<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useAuth } from "../composables/useAuth";
import { trpc } from "../lib/trpc";

// No hand-written Post interface: the type comes back from the router.
type Post = Awaited<ReturnType<typeof trpc.post.list.query>>[number];

const { user } = useAuth();

const posts = ref<Post[]>([]);
const title = ref("");
const body = ref("");
const error = ref<string | null>(null);
const loading = ref(false);

const signedIn = computed(() => user.value !== null);

/**
 * The same rule the server enforces in post.service.ts: your own, or you are an admin.
 *
 * This only decides which buttons to draw. The server does not trust it - deleting
 * someone else's post from the console still comes back FORBIDDEN.
 */
function canEdit(post: Post): boolean {
	const current = user.value;

	if (!current) return false;

	return current.role === "admin" || current.id === post.authorId;
}

async function run(action: () => Promise<void>) {
	loading.value = true;
	error.value = null;

	try {
		await action();
	} catch (cause) {
		error.value = cause instanceof Error ? cause.message : "Something went wrong";
	} finally {
		loading.value = false;
	}
}

// Anonymous callers get published posts; signed-in ones also see their own drafts.
// Reloading after sign-in is what makes those drafts appear.
const load = () =>
	run(async () => {
		posts.value = await trpc.post.list.query({ limit: 20 });
	});

const create = () =>
	run(async () => {
		const post = await trpc.post.create.mutate({ title: title.value, body: body.value });

		posts.value = [post, ...posts.value];
		title.value = "";
		body.value = "";
	});

const togglePublished = (post: Post) =>
	run(async () => {
		const updated = await trpc.post.update.mutate({ id: post.id, published: !post.published });

		posts.value = posts.value.map((p) => (p.id === updated.id ? updated : p));
	});

const remove = (post: Post) =>
	run(async () => {
		await trpc.post.delete.mutate({ id: post.id });

		posts.value = posts.value.filter((p) => p.id !== post.id);
	});

onMounted(load);
</script>

<template>
	<section class="panel">
		<form v-if="signedIn" class="composer" @submit.prevent="create">
			<input v-model="title" placeholder="Title" required maxlength="200" />
			<textarea v-model="body" placeholder="Body" required rows="3" />
			<button type="submit" :disabled="loading">Create post</button>
		</form>

		<p v-else class="hint">Sign in to write a post. Drafts are visible only to you.</p>

		<p v-if="error" class="error" role="alert">{{ error }}</p>

		<p v-if="!posts.length && !loading" class="empty">
			No posts yet. Run <code>bun run db:seed</code>, or write one.
		</p>

		<ul class="posts">
			<li v-for="post in posts" :key="post.id">
				<div>
					<strong>{{ post.title }}</strong>
					<span :class="['badge', post.published ? 'live' : 'draft']">
						{{ post.published ? "published" : "draft" }}
					</span>
					<p>{{ post.body }}</p>
				</div>

				<div v-if="canEdit(post)" class="actions">
					<button type="button" :disabled="loading" @click="togglePublished(post)">
						{{ post.published ? "Unpublish" : "Publish" }}
					</button>
					<button type="button" :disabled="loading" @click="remove(post)">Delete</button>
				</div>
			</li>
		</ul>
	</section>
</template>

<style scoped>
.panel {
	display: grid;
	gap: 1.5rem;
}

.composer {
	display: grid;
	gap: 0.75rem;
}

.posts {
	display: grid;
	gap: 0.75rem;
	padding: 0;
	list-style: none;
}

.posts li {
	display: flex;
	justify-content: space-between;
	gap: 1rem;
	padding: 1rem;
	border: 1px solid var(--border);
	border-radius: 8px;
}

.posts p {
	margin: 0.35rem 0 0;
	color: var(--muted);
}

.actions {
	display: flex;
	gap: 0.5rem;
	align-items: flex-start;
}

.badge {
	margin-left: 0.5rem;
	padding: 0.1rem 0.45rem;
	border-radius: 999px;
	font-size: 0.75rem;
}

.badge.live {
	background: #16653480;
}

.badge.draft {
	background: #78350f80;
}

.error {
	color: #f87171;
}

.empty,
.hint {
	color: var(--muted);
}
</style>
