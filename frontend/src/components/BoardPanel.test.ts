import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "../composables/useAuth";
import BoardPanel from "./BoardPanel.vue";

const list = vi.fn();
const submit = vi.fn();
const edit = vi.fn();
const remove = vi.fn();
const vote = vi.fn();
const unvote = vi.fn();
const listReleases = vi.fn();

const MAINTAINER = "11111111-1111-4111-8111-111111111111";
const ITEM = "99999999-9999-4999-8999-999999999999";

// Stands in for whoever is signed in - which, for most visitors, is nobody.
const currentUser = { value: null as CurrentUser | null };

vi.mock("../composables/useAuth", () => ({
	useAuth: () => ({ user: currentUser }),
}));

vi.mock("../lib/trpc", () => ({
	trpc: {
		feedback: {
			list: { query: (...args: unknown[]) => list(...args) },
			submit: { mutate: (...args: unknown[]) => submit(...args) },
			edit: { mutate: (...args: unknown[]) => edit(...args) },
			delete: { mutate: (...args: unknown[]) => remove(...args) },
			vote: { mutate: (...args: unknown[]) => vote(...args) },
			unvote: { mutate: (...args: unknown[]) => unvote(...args) },
		},
		release: {
			list: { query: (...args: unknown[]) => listReleases(...args) },
		},
	},
}));

// Timestamps are ISO strings, not Dates. tRPC serializes with plain JSON, so a Date the
// server returns arrives as a string - and the inferred client types say exactly that.
const AT = "2026-01-01T00:00:00.000Z";

function item(overrides: Record<string, unknown> = {}) {
	return {
		id: ITEM,
		kind: "idea",
		title: "RSS feed for releases",
		body: "So I can follow along without opening the site.",
		status: "open",
		authorId: null,
		authorName: "wren",
		releaseId: null,
		maintainerNote: null,
		votes: 3,
		viewerHasVoted: false,
		createdAt: AT,
		updatedAt: AT,
		...overrides,
	};
}

function user(overrides: Record<string, unknown> = {}): CurrentUser {
	return {
		id: MAINTAINER,
		email: "maintainer@example.com",
		name: "Maintainer",
		role: "user",
		createdAt: AT,
		updatedAt: AT,
		...overrides,
	} as CurrentUser;
}

describe("BoardPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		currentUser.value = null;
		list.mockResolvedValue([item()]);
		listReleases.mockResolvedValue([]);
	});

	it("offers the composer to a visitor with no account", async () => {
		const wrapper = mount(BoardPanel);
		await flushPromises();

		// The point of the whole thing: no sign-in wall in front of the form.
		expect(wrapper.find("form").exists()).toBe(true);
		expect(wrapper.find('input[placeholder="Your name (optional)"]').exists()).toBe(true);
		expect(wrapper.text()).toContain("No account needed");
	});

	it("files what the visitor typed, with the kind they picked", async () => {
		submit.mockResolvedValue(item({ id: "fresh", title: "Dark mode", votes: 1 }));

		const wrapper = mount(BoardPanel);
		await flushPromises();

		await wrapper.findAll(".kinds button")[1]?.trigger("click");
		await wrapper.find('input[placeholder="One line: what is it?"]').setValue("Dark mode");
		await wrapper.find("textarea").setValue("Follow the system theme");
		await wrapper.find('input[placeholder="Your name (optional)"]').setValue("wren");
		await wrapper.find("form").trigger("submit");
		await flushPromises();

		expect(submit).toHaveBeenCalledWith({
			kind: "bug",
			title: "Dark mode",
			body: "Follow the system theme",
			authorName: "wren",
		});

		expect(wrapper.findAll(".items .title").map((n) => n.text())).toEqual([
			"Dark mode",
			"RSS feed for releases",
		]);
	});

	it("votes, and trusts the server's count rather than counting locally", async () => {
		vote.mockResolvedValue(item({ votes: 4, viewerHasVoted: true }));

		const wrapper = mount(BoardPanel);
		await flushPromises();

		expect(wrapper.find(".vote .count").text()).toBe("3");

		await wrapper.find(".vote").trigger("click");
		await flushPromises();

		expect(vote).toHaveBeenCalledWith({ id: ITEM });
		expect(wrapper.find(".vote .count").text()).toBe("4");
		expect(wrapper.find(".vote").classes()).toContain("voted");
	});

	it("takes a vote back on a second click", async () => {
		list.mockResolvedValue([item({ votes: 4, viewerHasVoted: true })]);
		unvote.mockResolvedValue(item({ votes: 3, viewerHasVoted: false }));

		const wrapper = mount(BoardPanel);
		await flushPromises();

		await wrapper.find(".vote").trigger("click");
		await flushPromises();

		expect(unvote).toHaveBeenCalledWith({ id: ITEM });
		expect(wrapper.find(".vote .count").text()).toBe("3");
	});

	it("hides triage from visitors and from ordinary accounts", async () => {
		const wrapper = mount(BoardPanel);
		await flushPromises();

		expect(wrapper.find(".triage").exists()).toBe(false);

		currentUser.value = user();

		const signedIn = mount(BoardPanel);
		await flushPromises();

		expect(signedIn.find(".triage").exists()).toBe(false);
	});

	it("gives the maintainer the triage controls", async () => {
		currentUser.value = user({ role: "admin" });
		listReleases.mockResolvedValue([
			{
				id: "release-1",
				version: "0.2",
				name: null,
				status: "merge_window",
				notes: null,
				plannedFor: AT,
				releasedAt: null,
				itemCount: 0,
				createdAt: AT,
				updatedAt: AT,
			},
		]);
		edit.mockResolvedValue(item({ status: "planned", releaseId: "release-1" }));

		const wrapper = mount(BoardPanel);
		await flushPromises();

		expect(wrapper.find(".triage").exists()).toBe(true);

		await wrapper.find(".triage select").setValue("release-1");
		await flushPromises();

		expect(edit).toHaveBeenCalledWith({ id: ITEM, releaseId: "release-1" });
		expect(wrapper.text()).toContain("planned");
	});

	it("asks the server again when the filter changes", async () => {
		const wrapper = mount(BoardPanel);
		await flushPromises();

		expect(list).toHaveBeenCalledWith({ sort: "top", status: "open" });

		await wrapper.findAll("select")[1]?.setValue("bug");
		await flushPromises();

		// Filtering is the server's job: "most wanted" is a fact about the whole board,
		// not about the rows that happen to be loaded.
		expect(list).toHaveBeenLastCalledWith({ sort: "top", status: "open", kind: "bug" });
	});

	it("surfaces a rejected mutation instead of swallowing it", async () => {
		vote.mockRejectedValue(new Error("No voter identity for this request"));

		const wrapper = mount(BoardPanel);
		await flushPromises();

		await wrapper.find(".vote").trigger("click");
		await flushPromises();

		expect(wrapper.find('[role="alert"]').text()).toBe("No voter identity for this request");
	});

	it("shows the maintainer's answer on a declined item", async () => {
		list.mockResolvedValue([
			item({ status: "declined", maintainerNote: "Not what this is for." }),
		]);

		const wrapper = mount(BoardPanel);
		await flushPromises();

		expect(wrapper.find(".note").text()).toContain("Not what this is for.");
	});
});
