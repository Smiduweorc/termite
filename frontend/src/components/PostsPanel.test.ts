import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "../composables/useAuth";
import PostsPanel from "./PostsPanel.vue";

const list = vi.fn();
const create = vi.fn();
const update = vi.fn();
const remove = vi.fn();

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

// Stands in for whoever is signed in. The tests set it before mounting.
const currentUser = { value: null as CurrentUser | null };

vi.mock("../composables/useAuth", () => ({
	useAuth: () => ({ user: currentUser }),
}));

vi.mock("../lib/trpc", () => ({
	trpc: {
		post: {
			list: { query: (...args: unknown[]) => list(...args) },
			create: { mutate: (...args: unknown[]) => create(...args) },
			update: { mutate: (...args: unknown[]) => update(...args) },
			delete: { mutate: (...args: unknown[]) => remove(...args) },
		},
	},
}));

// Timestamps are ISO strings, not Dates. tRPC serializes with plain JSON, so a Date the
// server returns arrives as a string - and the inferred client types say exactly that.
// (Add superjson as a transformer on both ends if you want real Dates back.)
const AT = "2026-01-01T00:00:00.000Z";

function post(overrides: Record<string, unknown> = {}) {
	return {
		id: "99999999-9999-4999-8999-999999999999",
		title: "Hello",
		body: "World",
		published: true,
		authorId: ALICE,
		createdAt: AT,
		updatedAt: AT,
		...overrides,
	};
}

function user(overrides: Record<string, unknown> = {}): CurrentUser {
	return {
		id: ALICE,
		email: "alice@example.com",
		name: "Alice",
		role: "user",
		createdAt: AT,
		updatedAt: AT,
		...overrides,
	} as CurrentUser;
}

describe("PostsPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		currentUser.value = null;
		list.mockResolvedValue([post()]);
	});

	it("hides the composer from anonymous visitors", async () => {
		const wrapper = mount(PostsPanel);
		await flushPromises();

		expect(wrapper.find("form").exists()).toBe(false);
		expect(wrapper.text()).toContain("Sign in to write a post");
		expect(wrapper.find(".actions").exists()).toBe(false);
	});

	it("shows edit controls on your own post", async () => {
		currentUser.value = user();

		const wrapper = mount(PostsPanel);
		await flushPromises();

		expect(wrapper.find("form").exists()).toBe(true);
		expect(wrapper.find(".actions").exists()).toBe(true);
	});

	it("hides edit controls on someone else's post", async () => {
		currentUser.value = user({ id: BOB, name: "Bob", email: "bob@example.com" });

		const wrapper = mount(PostsPanel);
		await flushPromises();

		// Bob may write his own posts...
		expect(wrapper.find("form").exists()).toBe(true);
		// ...but not touch Alice's.
		expect(wrapper.find(".actions").exists()).toBe(false);
	});

	it("shows edit controls on anyone's post for an admin", async () => {
		currentUser.value = user({ id: BOB, name: "Root", role: "admin" });

		const wrapper = mount(PostsPanel);
		await flushPromises();

		expect(wrapper.find(".actions").exists()).toBe(true);
	});

	it("creates a post and puts it at the top", async () => {
		currentUser.value = user();
		create.mockResolvedValue(
			post({ id: "33333333-3333-4333-8333-333333333333", title: "Fresh" }),
		);

		const wrapper = mount(PostsPanel);
		await flushPromises();

		await wrapper.find("input").setValue("Fresh");
		await wrapper.find("textarea").setValue("Body");
		await wrapper.find("form").trigger("submit");
		await flushPromises();

		expect(create).toHaveBeenCalledWith({ title: "Fresh", body: "Body" });
		expect(wrapper.findAll("li strong").map((n) => n.text())).toEqual(["Fresh", "Hello"]);
	});

	it("surfaces a rejected mutation instead of swallowing it", async () => {
		currentUser.value = user();
		update.mockRejectedValue(new Error("That post belongs to someone else"));

		const wrapper = mount(PostsPanel);
		await flushPromises();

		await wrapper.find("li .actions button").trigger("click");
		await flushPromises();

		expect(wrapper.find('[role="alert"]').text()).toBe("That post belongs to someone else");
	});
});
