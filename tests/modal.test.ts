import {App} from "obsidian";
import {describe, expect, it, vi} from "vitest";
import {ImportUrlModal} from "../src/modal";
import {ImportHistoryEntry, ModelOption} from "../src/types";

const defaultModelOptions: ModelOption[] = [
	{id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", description: "速度优先"},
	{id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", description: "质量优先"},
];

function createHistoryEntry(): ImportHistoryEntry {
	return {
		id: "history-1",
		url: "https://example.com/post",
		host: "example.com",
		apiBaseUrl: "https://api.deepseek.com",
		model: "deepseek-v4-pro",
		submittedAt: "2026-04-16T10:00:00.000Z",
		status: "failed",
		progressStage: "failed",
		progressPercent: 100,
		progressMessage: "导入失败",
		progressUpdatedAt: "2026-04-16T10:01:00.000Z",
		errorMessage: "测试失败",
	};
}

describe("import modal", () => {
	it("submits typed URLs with the currently selected model", async () => {
		const onSubmit = vi.fn<(rawUrl: string, model: string) => Promise<void>>().mockResolvedValue(undefined);
		const modal = new ImportUrlModal({} as App, {
			isBusy: () => false,
			modelOptions: defaultModelOptions,
			initialModel: "deepseek-v4-flash",
			recentImports: [],
			resolveApiBaseUrl: () => "https://api.deepseek.com",
			openVaultPath: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
			onModelChange: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
			onClearRecentImports: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
			onSubmit,
		});

		modal.onOpen();
		const input = modal.contentEl.querySelector("input");
		if (!input) {
			throw new Error("Expected modal input to exist.");
		}
		input.value = "https://example.com/article";

		(modal as unknown as {handleSubmit: () => void}).handleSubmit();
		expect(onSubmit).toHaveBeenCalledWith("https://example.com/article", "deepseek-v4-flash");
	});

	it("re-runs a history entry with its original URL and model", () => {
		const onSubmit = vi.fn<(rawUrl: string, model: string) => Promise<void>>().mockResolvedValue(undefined);
		const modal = new ImportUrlModal({} as App, {
			isBusy: () => false,
			modelOptions: defaultModelOptions,
			initialModel: "deepseek-v4-flash",
			recentImports: [createHistoryEntry()],
			resolveApiBaseUrl: () => "https://api.deepseek.com",
			openVaultPath: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
			onModelChange: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
			onClearRecentImports: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
			onSubmit,
		});

		modal.onOpen();
		const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
		const rerunButton = buttons.find((button) => button.textContent === "重新导入");
		if (!rerunButton) {
			throw new Error("Expected 重新导入 button to exist.");
		}

		rerunButton.click();
		expect(onSubmit).toHaveBeenCalledWith("https://example.com/post", "deepseek-v4-pro");
	});

	it("persists model changes when a model pill is selected", () => {
		const onModelChange = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		const modal = new ImportUrlModal({} as App, {
			isBusy: () => false,
			modelOptions: defaultModelOptions,
			initialModel: "deepseek-v4-flash",
			recentImports: [],
			resolveApiBaseUrl: () => "https://api.deepseek.com",
			openVaultPath: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
			onModelChange,
			onClearRecentImports: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
			onSubmit: vi.fn<(rawUrl: string, model: string) => Promise<void>>().mockResolvedValue(undefined),
		});

		modal.onOpen();
		const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
		const proButton = buttons.find((button) => button.textContent === "DeepSeek V4 Pro");
		if (!proButton) {
			throw new Error("Expected DeepSeek V4 Pro button to exist.");
		}

		proButton.click();
		expect(onModelChange).toHaveBeenCalledWith("deepseek-v4-pro");
	});

	it("does not persist model changes when the selected model pill is clicked again", () => {
		const onModelChange = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		const modal = new ImportUrlModal({} as App, {
			isBusy: () => false,
			modelOptions: defaultModelOptions,
			initialModel: "deepseek-v4-flash",
			recentImports: [],
			resolveApiBaseUrl: () => "https://api.deepseek.com",
			openVaultPath: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
			onModelChange,
			onClearRecentImports: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
			onSubmit: vi.fn<(rawUrl: string, model: string) => Promise<void>>().mockResolvedValue(undefined),
		});

		modal.onOpen();
		const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
		const flashButton = buttons.find((button) => button.textContent === "DeepSeek V4 Flash");
		if (!flashButton) {
			throw new Error("Expected DeepSeek V4 Flash button to exist.");
		}

		flashButton.click();
		expect(onModelChange).not.toHaveBeenCalled();
	});

	it("shows an empty model state when no model options are available", () => {
		const modal = new ImportUrlModal({} as App, {
			isBusy: () => false,
			modelOptions: [],
			initialModel: "",
			recentImports: [],
			resolveApiBaseUrl: () => "https://api.deepseek.com",
			openVaultPath: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
			onModelChange: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
			onClearRecentImports: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
			onSubmit: vi.fn<(rawUrl: string, model: string) => Promise<void>>().mockResolvedValue(undefined),
		});

		modal.onOpen();

		expect(modal.contentEl.textContent).toContain("还没有可选模型");
		expect(modal.contentEl.querySelector(".import-url-model-empty")).not.toBeNull();
	});

	it("clears recent imports from the modal toolbar", () => {
		const onClearRecentImports = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
		const modal = new ImportUrlModal({} as App, {
			isBusy: () => false,
			modelOptions: defaultModelOptions,
			initialModel: "deepseek-v4-flash",
			recentImports: [createHistoryEntry()],
			resolveApiBaseUrl: () => "https://api.deepseek.com",
			openVaultPath: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
			onModelChange: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
			onClearRecentImports,
			onSubmit: vi.fn<(rawUrl: string, model: string) => Promise<void>>().mockResolvedValue(undefined),
		});

		modal.onOpen();
		const buttons = Array.from(modal.contentEl.querySelectorAll("button"));
		const clearButton = buttons.find((button) => button.textContent === "清空列表");
		if (!clearButton) {
			throw new Error("Expected 清空列表 button to exist.");
		}

		clearButton.click();
		expect(onClearRecentImports).toHaveBeenCalledTimes(1);
	});

	it("renders import context as scannable fields", () => {
		const modal = new ImportUrlModal({} as App, {
			isBusy: () => false,
			modelOptions: defaultModelOptions,
			initialModel: "deepseek-v4-flash",
			recentImports: [createHistoryEntry()],
			resolveApiBaseUrl: () => "https://api.deepseek.com",
			openVaultPath: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
			onModelChange: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
			onClearRecentImports: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
			onSubmit: vi.fn<(rawUrl: string, model: string) => Promise<void>>().mockResolvedValue(undefined),
		});

		modal.onOpen();
		const input = modal.contentEl.querySelector("input");
		if (!input) {
			throw new Error("Expected modal input to exist.");
		}
		input.value = "https://example.com/post";
		(modal as unknown as {updateSummary: (rawUrl: string) => void}).updateSummary(input.value);

		const summaryFields = Array.from(modal.contentEl.querySelectorAll(".import-url-summary-field"));
		const summaryText = summaryFields.map((field) => field.textContent).join("\n");
		expect(summaryText).toContain("来源example.com");
		expect(summaryText).toContain("类型网页");
		expect(summaryText).toContain("模型DeepSeek V4 Flash");
		expect(summaryText).toContain("APIhttps://api.deepseek.com");
		expect(summaryText).toContain("最近失败");
		expect(summaryText).toContain("deepseek-v4-pro");
		expect(modal.contentEl.querySelector(".import-url-summary-actions")?.textContent).toContain("切换到 deepseek-v4-pro");
	});
});
