import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "../composables/useAuth";
import ReleasesPanel from "./ReleasesPanel.vue";

const list = vi.fn();
const create = vi.fn();
const update = vi.fn();
const ship = vi.fn();
const remove = vi.fn();

const AT = "2026-01-01T00:00:00.000Z";
const RELEASE = "22222222-2222-4222-8222-222222222222";

const currentUser = { value: null as CurrentUser | null };

vi.mock("../composables/useAuth", () => ({
	useAuth: () => ({ user: currentUser }),
}));

vi.mock("../lib/trpc", () => ({
	trpc: {
		release: {
			list: { query: (...args: unknown[]) => list(...args) },
			create: { mutate: (...args: unknown[]) => create(...args) },
			update: { mutate: (...args: unknown[]) => update(...args) },
			ship: { mutate: (...args: unknown[]) => ship(...args) },
			delete: { mutate: (...args: unknown[]) => remove(...args) },
		},
	},
}));

function release(overrides: Record<string, unknown> = {}) {
	return {
		id: RELEASE,
		version: "0.2",
		name: "Merge window",
		status: "merge_window",
		notes: null,
		plannedFor: AT,
		releasedAt: null,
		itemCount: 2,
		createdAt: AT,
		updatedAt: AT,
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

describe("ReleasesPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		currentUser.value = null;
		list.mockResolvedValue([release()]);
	});

	it("publishes the calendar to anyone, with no controls attached", async () => {
		const wrapper = mount(ReleasesPanel);
		await flushPromises();

		expect(wrapper.text()).toContain("0.2");
		expect(wrapper.text()).toContain("merge window open");
		expect(wrapper.text()).toContain("2 item(s)");
		expect(wrapper.find(".actions").exists()).toBe(false);
		expect(wrapper.find("form").exists()).toBe(false);
	});

	it("says so plainly when there is no date", async () => {
		list.mockResolvedValue([release({ plannedFor: null, status: "planned" })]);

		const wrapper = mount(ReleasesPanel);
		await flushPromises();

		// "Eventually" is an honest answer for a side project, and better than a fake date.
		expect(wrapper.find(".when").text()).toContain("no date yet");
	});

	it("lets the maintainer plan one", async () => {
		currentUser.value = maintainer();
		create.mockResolvedValue(release({ version: "0.3" }));

		const wrapper = mount(ReleasesPanel);
		await flushPromises();

		await wrapper.find('input[placeholder="Version"]').setValue("0.3");
		await wrapper.find("form").trigger("submit");
		await flushPromises();

		expect(create).toHaveBeenCalledWith({ version: "0.3" });
		// Reloaded rather than pushed: where a release lands depends on its date.
		expect(list).toHaveBeenCalledTimes(2);
	});

	it("ships a window once it is confirmed, and not before", async () => {
		currentUser.value = maintainer();
		// happy-dom has no confirm(), so it is stubbed rather than spied on.
		const confirm = vi.fn().mockReturnValue(false);
		vi.stubGlobal("confirm", confirm);

		const wrapper = mount(ReleasesPanel);
		await flushPromises();

		const shipButton = wrapper
			.findAll(".actions button")
			.find((button) => button.text() === "Ship it");

		await shipButton?.trigger("click");
		await flushPromises();

		expect(ship).not.toHaveBeenCalled();

		confirm.mockReturnValue(true);
		await shipButton?.trigger("click");
		await flushPromises();

		expect(ship).toHaveBeenCalledWith({ id: RELEASE });

		vi.unstubAllGlobals();
	});

	it("offers no cancel button on a release that already shipped", async () => {
		currentUser.value = maintainer();
		list.mockResolvedValue([release({ status: "released", releasedAt: AT, plannedFor: null })]);

		const wrapper = mount(ReleasesPanel);
		await flushPromises();

		const labels = wrapper.findAll(".actions button").map((button) => button.text());

		// The server refuses to delete history, so do not offer a button that only 409s.
		expect(labels).not.toContain("Cancel");
		expect(labels).not.toContain("Ship it");
		expect(wrapper.find(".when").text()).toContain("shipped");
	});

	it("surfaces a rejected mutation", async () => {
		currentUser.value = maintainer();
		update.mockRejectedValue(new Error("Release 0.2 has already shipped"));
		list.mockResolvedValue([release({ status: "planned" })]);

		const wrapper = mount(ReleasesPanel);
		await flushPromises();

		const openWindow = wrapper
			.findAll(".actions button")
			.find((button) => button.text() === "Open window");

		await openWindow?.trigger("click");
		await flushPromises();

		expect(wrapper.find('[role="alert"]').text()).toBe("Release 0.2 has already shipped");
	});
});
