import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AuthPanel from "./AuthPanel.vue";

const login = vi.fn();
const register = vi.fn();

vi.mock("../composables/useAuth", () => ({
	useAuth: () => ({ login, register }),
}));

describe("AuthPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		login.mockResolvedValue(undefined);
		register.mockResolvedValue(undefined);
	});

	it("signs in with the entered credentials", async () => {
		const wrapper = mount(AuthPanel);

		await wrapper.find('input[type="email"]').setValue("alice@example.com");
		await wrapper.find('input[type="password"]').setValue("password123");
		await wrapper.find("form").trigger("submit");
		await flushPromises();

		expect(login).toHaveBeenCalledWith("alice@example.com", "password123");
		expect(register).not.toHaveBeenCalled();
	});

	it("registers when switched to the register tab", async () => {
		const wrapper = mount(AuthPanel);

		await wrapper.findAll(".tabs button")[1]?.trigger("click");

		await wrapper.find('input[type="email"]').setValue("new@example.com");
		await wrapper.find('input[placeholder="Name"]').setValue("New Person");
		await wrapper.find('input[type="password"]').setValue("password123");
		await wrapper.find("form").trigger("submit");
		await flushPromises();

		expect(register).toHaveBeenCalledWith("new@example.com", "New Person", "password123");
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
