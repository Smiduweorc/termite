import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "../composables/useAuth";
import BoardsPanel from "./BoardsPanel.vue";

const listBoards = vi.fn();
const byId = vi.fn();
const createBoard = vi.fn();
const addBucket = vi.fn();
const updateBucket = vi.fn();
const deleteBucket = vi.fn();
const addTask = vi.fn();
const updateTask = vi.fn();
const moveTask = vi.fn();
const deleteTask = vi.fn();

const AT = "2026-01-01T00:00:00.000Z";
const BOARD = "44444444-4444-4444-8444-444444444444";

const currentUser = { value: null as CurrentUser | null };

vi.mock("../composables/useAuth", () => ({
	useAuth: () => ({ user: currentUser }),
}));

vi.mock("../lib/trpc", () => ({
	trpc: {
		board: {
			list: { query: (...args: unknown[]) => listBoards(...args) },
			byId: { query: (...args: unknown[]) => byId(...args) },
			create: { mutate: (...args: unknown[]) => createBoard(...args) },
			addBucket: { mutate: (...args: unknown[]) => addBucket(...args) },
			updateBucket: { mutate: (...args: unknown[]) => updateBucket(...args) },
			deleteBucket: { mutate: (...args: unknown[]) => deleteBucket(...args) },
			addTask: { mutate: (...args: unknown[]) => addTask(...args) },
			updateTask: { mutate: (...args: unknown[]) => updateTask(...args) },
			moveTask: { mutate: (...args: unknown[]) => moveTask(...args) },
			deleteTask: { mutate: (...args: unknown[]) => deleteTask(...args) },
		},
	},
}));

function card(id: string, title: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		boardId: BOARD,
		bucketId: "col-1",
		title,
		description: null,
		done: false,
		doneAt: null,
		position: 65536,
		feedbackId: null,
		releaseId: null,
		createdAt: AT,
		updatedAt: AT,
		...overrides,
	};
}

function column(id: string, title: string, tasks: ReturnType<typeof card>[], extra = {}) {
	return {
		id,
		boardId: BOARD,
		title,
		position: 65536,
		wipLimit: null,
		isDone: false,
		isDefault: id === "col-1",
		createdAt: AT,
		updatedAt: AT,
		tasks,
		...extra,
	};
}

/** Five columns, none of them called "Done" - which is the point. */
function board(overrides: Record<string, unknown> = {}) {
	return {
		id: BOARD,
		title: "0.2 merge window",
		description: null,
		isPublic: true,
		createdAt: AT,
		updatedAt: AT,
		buckets: [
			column("col-1", "To do", [card("task-1", "Write the RSS template")]),
			column("col-2", "In the branch", [
				card("task-2", "Fix the overflow", { bucketId: "col-2" }),
			]),
			column("col-3", "Waiting on upstream", []),
			column("col-4", "Needs a repro", []),
			column("col-5", "Shipped", []),
		],
		...overrides,
	};
}

function maintainer(): CurrentUser {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		email: "maintainer@example.com",
		name: "Maintainer",
		role: "admin",
		createdAt: AT,
		updatedAt: AT,
	} as CurrentUser;
}

describe("BoardsPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		currentUser.value = null;
		listBoards.mockResolvedValue([{ id: BOARD, title: "0.2 merge window", isPublic: true }]);
		byId.mockResolvedValue(board());
	});

	it("draws whatever columns the board has, however many that is", async () => {
		const wrapper = mount(BoardsPanel);
		await flushPromises();

		const titles = wrapper.findAll(".column header strong").map((node) => node.text());

		// Not three, not four with a mandatory Done - five, named after the work.
		expect(titles).toEqual([
			"To do",
			"In the branch",
			"Waiting on upstream",
			"Needs a repro",
			"Shipped",
		]);
	});

	it("shows a published board to a visitor with nothing to click", async () => {
		const wrapper = mount(BoardsPanel);
		await flushPromises();

		expect(wrapper.text()).toContain("Write the RSS template");
		expect(wrapper.find(".card-actions").exists()).toBe(false);
		expect(wrapper.find(".new-column").exists()).toBe(false);
		expect(wrapper.find<HTMLInputElement>(".card input[type=checkbox]").element.disabled).toBe(
			true,
		);
	});

	it("moves a card between columns and tells the server where it landed", async () => {
		currentUser.value = maintainer();
		moveTask.mockResolvedValue(board());

		const wrapper = mount(BoardsPanel);
		await flushPromises();

		// The keyboard's version of a drag: one column to the right.
		const rightwards = wrapper.findAll(".card-actions button")[1];
		await rightwards?.trigger("click");
		await flushPromises();

		// Under the last card already in that column, which is where a drop at the end
		// of a column belongs.
		expect(moveTask).toHaveBeenCalledWith({
			id: "task-1",
			bucketId: "col-2",
			afterTaskId: "task-2",
		});
	});

	it("drops a card under the card it was dropped on", async () => {
		currentUser.value = maintainer();
		moveTask.mockResolvedValue(board());

		const wrapper = mount(BoardsPanel);
		await flushPromises();

		const cards = wrapper.findAll(".card");

		await cards[0]?.trigger("dragstart");
		await cards[1]?.trigger("drop");
		await flushPromises();

		// The anchor is the card underneath the pointer; the server takes the midpoint
		// between it and whatever follows.
		expect(moveTask).toHaveBeenCalledWith({
			id: "task-1",
			bucketId: "col-2",
			afterTaskId: "task-2",
		});
	});

	it("ticks a card off without moving it when no column is marked done", async () => {
		currentUser.value = maintainer();
		updateTask.mockResolvedValue(board());

		const wrapper = mount(BoardsPanel);
		await flushPromises();

		await wrapper.find(".card input[type=checkbox]").setValue(true);
		await flushPromises();

		expect(updateTask).toHaveBeenCalledWith({ id: "task-1", done: true });
		// And the board says so: no done column here, so the checkbox is the whole story.
		expect(wrapper.text()).toContain("No column is marked as done");
	});

	it("marks a column as done, and can unmark it again", async () => {
		currentUser.value = maintainer();
		updateBucket.mockResolvedValue(board());

		const wrapper = mount(BoardsPanel);
		await flushPromises();

		const markDone = wrapper
			.findAll(".column-actions button")
			.find((button) => button.text() === "mark done");

		await markDone?.trigger("click");
		await flushPromises();

		expect(updateBucket).toHaveBeenCalledWith({ id: "col-1", isDone: true });
	});

	it("offers to unmark the done column, so a board can have none", async () => {
		currentUser.value = maintainer();

		const withDone = board();
		withDone.buckets[4] = column("col-5", "Shipped", [], { isDone: true });
		byId.mockResolvedValue(withDone);
		updateBucket.mockResolvedValue(board());

		const wrapper = mount(BoardsPanel);
		await flushPromises();

		const unmark = wrapper
			.findAll(".column-actions button")
			.find((button) => button.text() === "✓ done column");

		await unmark?.trigger("click");
		await flushPromises();

		expect(updateBucket).toHaveBeenCalledWith({ id: "col-5", isDone: false });
	});

	it("shows the same cards flattened in the list view", async () => {
		const wrapper = mount(BoardsPanel);
		await flushPromises();

		await wrapper.findAll(".views button")[1]?.trigger("click");
		await flushPromises();

		const rows = wrapper.findAll(".list li").map((row) => row.text());

		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain("Write the RSS template");
		// One ordering, two renderings - the list shows which column each card is in
		// rather than inventing an order of its own.
		expect(rows[0]).toContain("To do");
		expect(rows[1]).toContain("In the branch");
	});

	it("surfaces a refused move instead of pretending it worked", async () => {
		currentUser.value = maintainer();
		moveTask.mockRejectedValue(new Error('"In the branch" is at its limit of 3'));

		const wrapper = mount(BoardsPanel);
		await flushPromises();

		await wrapper.findAll(".card-actions button")[1]?.trigger("click");
		await flushPromises();

		expect(wrapper.find('[role="alert"]').text()).toBe('"In the branch" is at its limit of 3');
	});
});
