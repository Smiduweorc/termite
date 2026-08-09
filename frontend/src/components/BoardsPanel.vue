<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useAuth } from "../composables/useAuth";
import { trpc } from "../lib/trpc";

type BoardSummary = Awaited<ReturnType<typeof trpc.board.list.query>>[number];
type BoardContents = Awaited<ReturnType<typeof trpc.board.byId.query>>;
type Column = BoardContents["buckets"][number];
type Card = Column["tasks"][number];

const { user } = useAuth();

const boards = ref<BoardSummary[]>([]);
const board = ref<BoardContents | null>(null);
const view = ref<"kanban" | "list">("kanban");
const error = ref<string | null>(null);
const busy = ref(false);

const newBoardTitle = ref("");
const newColumnTitle = ref("");
const newCardTitle = ref<Record<string, string>>({});

/** The card currently under the pointer, for the drag. Null when nothing is moving. */
const dragging = ref<string | null>(null);

const isMaintainer = computed(() => user.value?.role === "admin");

/**
 * The list view is the kanban view flattened - same cards, same order, read top to
 * bottom instead of left to right. There is no second ordering to keep in step, which
 * is why dragging in one is visible in the other.
 */
const flatCards = computed(() =>
	(board.value?.buckets ?? []).flatMap((column) =>
		column.tasks.map((task) => ({ task, column })),
	),
);

const doneColumn = computed(() => board.value?.buckets.find((column) => column.isDone) ?? null);

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

const loadBoards = () =>
	run(async () => {
		boards.value = await trpc.board.list.query();

		const first = boards.value[0];

		if (first && !board.value) {
			board.value = await trpc.board.byId.query({ id: first.id });
		}
	});

const open = (summary: BoardSummary) =>
	run(async () => {
		board.value = await trpc.board.byId.query({ id: summary.id });
	});

const createBoard = () =>
	run(async () => {
		board.value = await trpc.board.create.mutate({ title: newBoardTitle.value });
		newBoardTitle.value = "";
		boards.value = await trpc.board.list.query();
	});

const addColumn = () =>
	run(async () => {
		if (!board.value) return;

		board.value = await trpc.board.addBucket.mutate({
			boardId: board.value.id,
			title: newColumnTitle.value,
		});

		newColumnTitle.value = "";
	});

const addCard = (column: Column) =>
	run(async () => {
		if (!board.value) return;

		const title = newCardTitle.value[column.id]?.trim();

		if (!title) return;

		board.value = await trpc.board.addTask.mutate({
			boardId: board.value.id,
			bucketId: column.id,
			title,
		});

		newCardTitle.value[column.id] = "";
	});

const toggleDone = (card: Card) =>
	run(async () => {
		board.value = await trpc.board.updateTask.mutate({ id: card.id, done: !card.done });
	});

const removeCard = (card: Card) =>
	run(async () => {
		const id = board.value?.id;

		if (!id) return;

		// Deleting a card is the one mutation that answers with just the id, so the
		// board is re-read rather than patched.
		await trpc.board.deleteTask.mutate({ id: card.id });
		board.value = await trpc.board.byId.query({ id });
	});

/** Mark this column as the done one, or unmark it - a board is allowed to have neither. */
const toggleDoneColumn = (column: Column) =>
	run(async () => {
		board.value = await trpc.board.updateBucket.mutate({
			id: column.id,
			isDone: !column.isDone,
		});
	});

const removeColumn = (column: Column) =>
	run(async () => {
		// The server moves the cards to the default column rather than deleting them,
		// which is worth saying out loud before the click.
		if (
			column.tasks.length > 0 &&
			!window.confirm(
				`Move ${column.tasks.length} card(s) out of "${column.title}" and delete it?`,
			)
		) {
			return;
		}

		board.value = await trpc.board.deleteBucket.mutate({ id: column.id });
	});

/**
 * The drop.
 *
 * `afterTaskId` is the card the dropped one should sit under - the server takes the
 * midpoint between it and whatever follows, so only the moved row changes. Dropping on
 * a column rather than a card means "put it at the end", which is that column's last
 * card; dropping on the header means the top, which is no anchor at all.
 */
const drop = (column: Column, afterTaskId: string | null) =>
	run(async () => {
		const id = dragging.value;

		dragging.value = null;

		if (!id || id === afterTaskId) return;

		board.value = await trpc.board.moveTask.mutate({
			id,
			bucketId: column.id,
			...(afterTaskId ? { afterTaskId } : {}),
		});
	});

/** The keyboard's version of a drag: shift a card one column left or right. */
const shift = (card: Card, column: Column, direction: -1 | 1) =>
	run(async () => {
		const columns = board.value?.buckets ?? [];
		const index = columns.findIndex((other) => other.id === column.id);
		const target = columns[index + direction];

		if (!target) return;

		const last = target.tasks.at(-1);

		board.value = await trpc.board.moveTask.mutate({
			id: card.id,
			bucketId: target.id,
			...(last ? { afterTaskId: last.id } : {}),
		});
	});

const moveToColumn = (card: Card, columnId: string) =>
	run(async () => {
		const target = board.value?.buckets.find((column) => column.id === columnId);
		const last = target?.tasks.at(-1);

		board.value = await trpc.board.moveTask.mutate({
			id: card.id,
			bucketId: columnId,
			...(last ? { afterTaskId: last.id } : {}),
		});
	});

onMounted(loadBoards);
</script>

<template>
	<section class="boards">
		<div class="bar">
			<div class="picker">
				<button
					v-for="summary in boards"
					:key="summary.id"
					type="button"
					:class="{ here: summary.id === board?.id }"
					@click="open(summary)"
				>
					{{ summary.title }}
					<span v-if="!summary.isPublic" class="unlisted">unlisted</span>
				</button>
			</div>

			<div class="views">
				<button type="button" :class="{ here: view === 'kanban' }" @click="view = 'kanban'">
					Kanban
				</button>
				<button type="button" :class="{ here: view === 'list' }" @click="view = 'list'">
					List
				</button>
			</div>
		</div>

		<form v-if="isMaintainer" class="new-board" @submit.prevent="createBoard">
			<input v-model="newBoardTitle" placeholder="New board" required maxlength="120" />
			<button type="submit" :disabled="busy">Add board</button>
		</form>

		<p v-if="error" class="error" role="alert">{{ error }}</p>

		<p v-if="!boards.length && !busy" class="empty">
			No boards yet.
			<span v-if="!isMaintainer">The maintainer has not published one.</span>
		</p>

		<template v-if="board">
			<p v-if="board.description" class="description">{{ board.description }}</p>

			<!-- Kanban: as many columns as the board has, in the order it puts them.
			     Nothing here assumes three, and nothing assumes one of them is "done". -->
			<div v-if="view === 'kanban'" class="kanban">
				<div
					v-for="column in board.buckets"
					:key="column.id"
					class="column panel"
					:class="{ 'is-done': column.isDone }"
					@dragover.prevent
					@drop="drop(column, column.tasks.at(-1)?.id ?? null)"
				>
					<header @dragover.prevent @drop.stop="drop(column, null)">
						<strong>{{ column.title }}</strong>
						<span class="count">
							{{ column.tasks.length
							}}<template v-if="column.wipLimit">/{{ column.wipLimit }}</template>
						</span>

						<div v-if="isMaintainer" class="column-actions">
							<button
								type="button"
								class="quiet"
								:title="
									column.isDone
										? 'Stop treating this as done'
										: 'Treat this as done'
								"
								@click="toggleDoneColumn(column)"
							>
								{{ column.isDone ? "✓ done column" : "mark done" }}
							</button>
							<button type="button" class="quiet" @click="removeColumn(column)">
								remove
							</button>
						</div>
					</header>

					<ul>
						<li
							v-for="card in column.tasks"
							:key="card.id"
							class="card"
							:class="{ ticked: card.done, lifting: dragging === card.id }"
							:draggable="isMaintainer"
							@dragstart="dragging = card.id"
							@dragend="dragging = null"
							@dragover.prevent
							@drop.stop="drop(column, card.id)"
						>
							<label>
								<input
									type="checkbox"
									:checked="card.done"
									:disabled="!isMaintainer || busy"
									@change="toggleDone(card)"
								/>
								<span>{{ card.title }}</span>
							</label>

							<p v-if="card.description" class="card-body">{{ card.description }}</p>

							<div v-if="isMaintainer" class="card-actions">
								<button
									type="button"
									class="quiet"
									aria-label="Move one column left"
									@click="shift(card, column, -1)"
								>
									←
								</button>
								<button
									type="button"
									class="quiet"
									aria-label="Move one column right"
									@click="shift(card, column, 1)"
								>
									→
								</button>
								<button type="button" class="quiet" @click="removeCard(card)">
									delete
								</button>
							</div>
						</li>
					</ul>

					<form v-if="isMaintainer" class="new-card" @submit.prevent="addCard(column)">
						<input
							v-model="newCardTitle[column.id]"
							placeholder="Add a card"
							maxlength="200"
						/>
					</form>
				</div>

				<form v-if="isMaintainer" class="new-column" @submit.prevent="addColumn">
					<input v-model="newColumnTitle" placeholder="New column" required maxlength="80" />
					<button type="submit" :disabled="busy">Add</button>
				</form>
			</div>

			<!-- List: the same cards, flattened. Same order, same positions. -->
			<ul v-else class="list">
				<li
					v-for="{ task, column } in flatCards"
					:key="task.id"
					class="panel"
					:class="{ ticked: task.done }"
				>
					<label>
						<input
							type="checkbox"
							:checked="task.done"
							:disabled="!isMaintainer || busy"
							@change="toggleDone(task)"
						/>
						<span>{{ task.title }}</span>
					</label>

					<select
						v-if="isMaintainer"
						:value="column.id"
						:disabled="busy"
						aria-label="Column"
						@change="moveToColumn(task, ($event.target as HTMLSelectElement).value)"
					>
						<option v-for="option in board.buckets" :key="option.id" :value="option.id">
							{{ option.title }}
						</option>
					</select>

					<span v-else class="column-name">{{ column.title }}</span>
				</li>
			</ul>

			<p v-if="isMaintainer && !doneColumn" class="hint">
				No column is marked as done on this board, which is fine - the checkbox is
				enough. Mark one and the two stay in step.
			</p>
		</template>
	</section>
</template>

<style scoped>
.boards {
	display: grid;
	gap: 1.25rem;
}

.bar {
	display: flex;
	justify-content: space-between;
	gap: 1rem;
	flex-wrap: wrap;
	align-items: baseline;
}

.picker,
.views {
	display: flex;
	gap: 1.25rem;
	flex-wrap: wrap;
	align-items: baseline;
}

/* Which board, and which view, are stated in the ink - no capsules, no sliding bar. */
.picker button,
.views button {
	padding: 0.15rem 0;
	border: none;
	border-radius: 0;
	background: none;
	color: var(--muted);
	font-family: var(--font-display);
	font-variation-settings: "SOFT" 30, "WONK" 1;
	font-size: 1.05rem;
}

.picker button:hover:not(:disabled),
.views button:hover:not(:disabled) {
	color: var(--fg);
}

.picker button.here,
.views button.here {
	color: var(--fg-strong);
	font-weight: 600;
}

.unlisted {
	margin-left: 0.4rem;
	color: var(--muted);
	font-family: var(--font-sans);
	font-size: 0.72rem;
	font-weight: 400;
}

.new-board,
.new-column {
	display: flex;
	gap: 0.5rem;
}

.description {
	margin: 0;
	color: var(--muted);
}

.kanban {
	display: flex;
	gap: 0.75rem;
	align-items: flex-start;
	overflow-x: auto;
	padding-bottom: 0.75rem;
}

.column {
	flex: 0 0 16rem;
	display: grid;
	gap: 0.6rem;
	padding: 0.85rem;
	align-content: start;
}

/* The column that means "finished", when a board has decided it has one. */
.column.is-done header strong {
	color: var(--accent);
}

.column header {
	display: flex;
	align-items: baseline;
	gap: 0.5rem;
	flex-wrap: wrap;
}

.column header strong {
	font-family: var(--font-display);
	font-variation-settings: "SOFT" 30, "WONK" 1;
	font-size: 1rem;
	font-weight: 600;
	color: var(--fg-strong);
}

.count {
	margin-left: auto;
	color: var(--muted);
	font-family: var(--font-mono);
	font-size: 0.78rem;
	font-variant-numeric: tabular-nums;
}

.column-actions {
	flex: 1 0 100%;
	display: flex;
	gap: 0.35rem;
}

.column ul,
.list {
	display: grid;
	gap: 0.5rem;
	margin: 0;
	padding: 0;
	list-style: none;
}

.card {
	padding: 0.55rem 0.65rem;
	background: var(--raised);
	border: 1px solid transparent;
	border-radius: var(--cut-b);
	cursor: grab;
	transition:
		border-color 140ms ease,
		opacity 140ms ease;
}

.card:hover {
	border-color: var(--border);
}

/* While a card is in the air it stays legible, just clearly picked up. */
.card.lifting {
	opacity: 0.55;
	border-color: var(--comment);
	cursor: grabbing;
}

.card-body {
	margin: 0.35rem 0 0;
	color: var(--muted);
	font-size: 0.85rem;
}

/*
 * A checkbox next to a title that may wrap: aligned to the top so it stays with the
 * first line, then nudged down by the gap between the line box and the cap height so it
 * sits optically on that line rather than floating above it.
 */
.card label,
.list label {
	display: flex;
	gap: 0.55rem;
	align-items: flex-start;
	cursor: pointer;
}

.card label input[type="checkbox"],
.list label input[type="checkbox"] {
	flex: 0 0 auto;
	margin-top: 0.28em;
}

.ticked > label span,
.ticked label span {
	color: var(--muted);
	/* The browser centres a line-through on the x-height; the only job here is to keep
	   it fine enough that it reads as struck rather than redacted. */
	text-decoration: line-through;
	text-decoration-thickness: 1px;
}

.card-actions {
	display: flex;
	gap: 0.3rem;
	margin-top: 0.45rem;
}

.list li {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 0.75rem;
	padding: 0.7rem 0.9rem;
}

.column-name {
	color: var(--muted);
	font-size: 0.85rem;
}

.new-card input,
.new-column input {
	width: 100%;
	font-size: 0.9rem;
}

.new-column {
	flex: 0 0 12rem;
}
</style>
