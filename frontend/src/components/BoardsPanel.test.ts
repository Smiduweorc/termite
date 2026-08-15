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
const duplicateBoard = vi.fn();
const saveAsTemplate = vi.fn();
const useTemplate = vi.fn();
const duplicateBucket = vi.fn();
const duplicateTask = vi.fn();

const AT = "2026-01-01T00:00:00.000Z";
const BOARD = "44444444-4444-4444-8444-444444444444";
const TEMPLATE = "55555555-5555-4555-8555-555555555555";

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
			duplicate: { mutate: (...args: unknown[]) => duplicateBoard(...args) },
			saveAsTemplate: { mutate: (...args: unknown[]) => saveAsTemplate(...args) },
			useTemplate: { mutate: (...args: unknown[]) => useTemplate(...args) },
			duplicateBucket: { mutate: (...args: unknown[]) => duplicateBucket(...args) },
			duplicateTask: { mutate: (...args: unknown[]) => duplicateTask(...args) },
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
		isTemplate: false,
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
		listBoards.mockResolvedValue([
			{ id: BOARD, title: "0.2 merge window", isPublic: true, isTemplate: false },
		]);
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

	it("copies a card without saying where it goes", async () => {
		currentUser.value = maintainer();
		duplicateTask.mockResolvedValue(board());

		const wrapper = mount(BoardsPanel);
		await flushPromises();

		const copy = wrapper
			.findAll(".card-actions button")
			.find((button) => button.text() === "copy");

		await copy?.trigger("click");
		await flushPromises();

		// Where the copy lands is the server's business - under the card it came from.
		expect(duplicateTask).toHaveBeenCalledWith({ id: "task-1" });
	});

	it("copies a column, cards and all", async () => {
		currentUser.value = maintainer();
		duplicateBucket.mockResolvedValue(board());

		const wrapper = mount(BoardsPanel);
		await flushPromises();

		const copy = wrapper
			.findAll(".column-actions button")
			.find((button) => button.text() === "copy");

		await copy?.trigger("click");
		await flushPromises();

		expect(duplicateBucket).toHaveBeenCalledWith({ id: "col-1" });
	});

	it("offers a visitor nothing to copy, and no shelf of the maintainer's shapes", async () => {
		listBoards.mockResolvedValue([
			{ id: BOARD, title: "0.2 merge window", isPublic: true, isTemplate: false },
			{ id: TEMPLATE, title: "Release checklist", isPublic: true, isTemplate: true },
		]);

		const wrapper = mount(BoardsPanel);
		await flushPromises();

		expect(wrapper.find(".board-actions").exists()).toBe(false);
		expect(wrapper.findAll("button").some((button) => button.text() === "copy")).toBe(false);
		// Templates are scaffolding for the person who builds boards, not for the person
		// who reads them - so a visitor is not shown the shelf at all.
		expect(wrapper.find(".shelf").exists()).toBe(false);
		expect(wrapper.text()).not.toContain("Release checklist");
	});

	it("keeps templates off the board picker and names the board it starts", async () => {
		currentUser.value = maintainer();
		listBoards.mockResolvedValue([
			{ id: BOARD, title: "0.2 merge window", isPublic: true, isTemplate: false },
			{ id: TEMPLATE, title: "Release checklist", isPublic: false, isTemplate: true },
		]);
		useTemplate.mockResolvedValue(board({ title: "0.3 merge window" }));

		const wrapper = mount(BoardsPanel);
		await flushPromises();

		// A template is not a board you work on, so it is not among them.
		expect(wrapper.findAll(".picker button").map((button) => button.text())).toEqual([
			"0.2 merge window",
		]);
		expect(wrapper.find(".shelf").text()).toContain("Release checklist");

		const start = wrapper
			.findAll(".template button")
			.find((button) => button.text() === "start a board");

		await start?.trigger("click");
		await flushPromises();

		// The name is asked for in the page, in this app's own field. There is no
		// window.prompt to stub, which is the point.
		const field = wrapper.find(".naming input");

		expect(field.exists()).toBe(true);

		await field.setValue("0.3 merge window");
		await wrapper.find(".naming").trigger("submit");
		await flushPromises();

		expect(useTemplate).toHaveBeenCalledWith({ id: TEMPLATE, title: "0.3 merge window" });
		// The field has done its job and stands down.
		expect(wrapper.find(".naming").exists()).toBe(false);
	});

	it("lets an unnamed board keep the title of the template it came from", async () => {
		currentUser.value = maintainer();
		listBoards.mockResolvedValue([
			{ id: BOARD, title: "0.2 merge window", isPublic: true, isTemplate: false },
			{ id: TEMPLATE, title: "Release checklist", isPublic: false, isTemplate: true },
		]);
		useTemplate.mockResolvedValue(board({ title: "Release checklist" }));

		const wrapper = mount(BoardsPanel);
		await flushPromises();

		const start = wrapper
			.findAll(".template button")
			.find((button) => button.text() === "start a board");

		await start?.trigger("click");
		await flushPromises();

		await wrapper.find(".naming").trigger("submit");
		await flushPromises();

		// Blank is not an error - the server keeps the template's own name.
		expect(useTemplate).toHaveBeenCalledWith({ id: TEMPLATE });
	});

	it("saves the open board as a template and leaves it open", async () => {
		currentUser.value = maintainer();
		saveAsTemplate.mockResolvedValue(board({ isTemplate: true }));

		const wrapper = mount(BoardsPanel);
		await flushPromises();

		const save = wrapper
			.findAll(".board-actions button")
			.find((button) => button.text() === "Save as template");

		await save?.trigger("click");
		await flushPromises();

		expect(saveAsTemplate).toHaveBeenCalledWith({ id: BOARD });
		expect(wrapper.find('[role="status"]').text()).toContain(
			'Kept "0.2 merge window" as a template',
		);
		// The board being worked on is still the one on screen; only the shelf changed.
		expect(wrapper.find(".kanban").exists()).toBe(true);
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
