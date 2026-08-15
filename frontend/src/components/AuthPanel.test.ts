import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AuthPanel from "./AuthPanel.vue";

const login = vi.fn();
const forgotPassword = vi.fn();

vi.mock("../composables/useAuth", () => ({
	useAuth: () => ({ login }),
}));

vi.mock("../lib/trpc", () => ({
	trpc: {
		auth: {
			forgotPassword: { mutate: (...args: unknown[]) => forgotPassword(...args) },
		},
	},
}));

describe("AuthPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		login.mockResolvedValue(undefined);
		forgotPassword.mockResolvedValue({ ok: true });
	});

	it("signs in with the entered credentials", async () => {
		const wrapper = mount(AuthPanel);

		await wrapper.find('input[type="email"]').setValue("alice@example.com");
		await wrapper.find('input[type="password"]').setValue("password123");
		await wrapper.find("form").trigger("submit");
		await flushPromises();

		expect(login).toHaveBeenCalledWith("alice@example.com", "password123");
	});

	it("offers no way to register, because there is none", async () => {
		const wrapper = mount(AuthPanel);

		const tabs = wrapper.findAll(".tabs button").map((tab) => tab.text());

		// Sign in, or ask for a link back in. An account cannot be created from here by
		// anyone, which is the whole change.
		expect(tabs).toEqual(["Sign in", "Forgot password"]);
	});

	it("asks for a reset link, and says nothing about whether the account exists", async () => {
		const wrapper = mount(AuthPanel);

		await wrapper.findAll(".tabs button")[1]?.trigger("click");

		// The password field is gone in this mode - there is nothing to prove yet.
		expect(wrapper.find('input[type="password"]').exists()).toBe(false);

		await wrapper.find('input[type="email"]').setValue("alice@example.com");
		await wrapper.find("form").trigger("submit");
		await flushPromises();

		expect(forgotPassword).toHaveBeenCalledWith({ email: "alice@example.com" });
		expect(wrapper.find('[role="status"]').text()).toBe(
			"If that address has an account, a reset link is on its way.",
		);
		expect(login).not.toHaveBeenCalled();
	});

	it("shows the server's message when sign-in fails", async () => {
		// Deliberately the same message for a wrong password and an unknown account.
		login.mockRejectedValue(new Error("Invalid email or password"));

		const wrapper = mount(AuthPanel);

		await wrapper.find('input[type="email"]').setValue("alice@example.com");
		await wrapper.find('input[type="password"]').setValue("wrongpassword");
		await wrapper.find("form").trigger("submit");
		await flushPromises();

		expect(wrapper.find('[role="alert"]').text()).toBe("Invalid email or password");
	});

	it("clears the password field after a successful sign-in", async () => {
		const wrapper = mount(AuthPanel);
		const password = wrapper.find<HTMLInputElement>('input[type="password"]');

		await wrapper.find('input[type="email"]').setValue("alice@example.com");
		await password.setValue("password123");
		await wrapper.find("form").trigger("submit");
		await flushPromises();

		expect(password.element.value).toBe("");
	});
});
