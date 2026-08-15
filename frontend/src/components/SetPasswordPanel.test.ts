import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SetPasswordPanel from "./SetPasswordPanel.vue";

const setPassword = vi.fn();

vi.mock("../lib/trpc", () => ({
	trpc: { auth: { setPassword: { mutate: (...args: unknown[]) => setPassword(...args) } } },
}));

describe("SetPasswordPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setPassword.mockResolvedValue({ ok: true });
	});

	async function fill(wrapper: ReturnType<typeof mount>, first: string, second: string) {
		const fields = wrapper.findAll('input[type="password"]');

		await fields[0]?.setValue(first);
		await fields[1]?.setValue(second);
		await wrapper.find("form").trigger("submit");
		await flushPromises();
	}

	it("sends the token from the link with the chosen password", async () => {
		const wrapper = mount(SetPasswordPanel, { props: { token: "a-one-time-token" } });

		await fill(wrapper, "a-new-password", "a-new-password");

		expect(setPassword).toHaveBeenCalledWith({
			token: "a-one-time-token",
			password: "a-new-password",
		});
		expect(wrapper.emitted("done")).toHaveLength(1);
	});

	it("catches a typo before spending the link on it", async () => {
		const wrapper = mount(SetPasswordPanel, { props: { token: "a-one-time-token" } });

		await fill(wrapper, "a-new-password", "a-new-passwrod");

		// The link works once, so a mismatch has to be caught here rather than burned.
		expect(setPassword).not.toHaveBeenCalled();
		expect(wrapper.find('[role="alert"]').text()).toBe("Passwords do not match");
	});

	it("shows what the server said about a dead link", async () => {
		setPassword.mockRejectedValue(new Error("That link is invalid, expired or already used"));

		const wrapper = mount(SetPasswordPanel, { props: { token: "stale" } });

		await fill(wrapper, "a-new-password", "a-new-password");

		expect(wrapper.find('[role="alert"]').text()).toBe(
			"That link is invalid, expired or already used",
		);
		expect(wrapper.emitted("done")).toBeUndefined();
	});
});
