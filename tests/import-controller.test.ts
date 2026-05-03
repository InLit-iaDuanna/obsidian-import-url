import {describe, expect, it, vi} from "vitest";
import {ImportController} from "../src/import-controller";
import {DEFAULT_SETTINGS} from "../src/settings";
import {ImportHistoryEntry, JobRunResult} from "../src/types";
import {createFakeApp} from "./helpers";

function makeProcessingEntry(overrides: Partial<ImportHistoryEntry> = {}): ImportHistoryEntry {
	return {
		id: "history-processing",
		url: "https://example.com/article",
		host: "example.com",
		apiBaseUrl: "https://api.openai.com/v1",
		model: "gpt-4o",
		submittedAt: "2026-04-20T10:00:00.000Z",
		status: "processing",
		progressStage: "fetching",
		progressPercent: 45,
		progressMessage: "正在抓取",
		progressUpdatedAt: "2026-04-20T10:01:00.000Z",
		historyNotePath: "我的知识库/状态/历史记录/existing-record.md",
		...overrides,
	};
}

function createPluginStub(entries: ImportHistoryEntry[] = []) {
	const {app, vault, workspace} = createFakeApp();
	const plugin = {
		app,
		settings: {
			...DEFAULT_SETTINGS,
			model: "gpt-4o",
			recentImports: entries,
		},
		saveSettings: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
	};

	return {plugin, vault, workspace};
}

describe("import controller", () => {
	it("migrates a stale GPT default model when the DeepSeek API address is configured", () => {
		const {plugin} = createPluginStub();
		const controller = new ImportController(plugin as never);

		const migrated = controller.loadStoredSettings({
			...DEFAULT_SETTINGS,
			apiBaseUrl: "https://api.deepseek.com",
			model: "gpt-5.4",
			customModels: ["deepseek-v4-flash"],
		});

		expect(migrated).toBe(true);
		expect(plugin.settings.model).toBe("deepseek-v4-flash");
	});

	it("persists selected models to settings and config.toml", async () => {
		const {plugin, vault} = createPluginStub();
		const controller = new ImportController(plugin as never);
		controller.loadStoredSettings({
			...DEFAULT_SETTINGS,
			model: "deepseek-v4-flash",
		});
		await vault.create(DEFAULT_SETTINGS.configTomlPath, [
			"model_provider = \"DeepSeek\"",
			"model = \"deepseek-v4-flash\"",
			"review_model = \"deepseek-v4-flash\"",
			"",
			"[model_providers.DeepSeek]",
			"base_url = \"https://api.deepseek.com\"",
		].join("\n"));

		await controller.persistModelSelection("deepseek-v4-pro");

		expect(plugin.settings.model).toBe("deepseek-v4-pro");
		expect(plugin.saveSettings).toHaveBeenCalled();
		expect(vault.read(DEFAULT_SETTINGS.configTomlPath)).toContain("model = \"deepseek-v4-pro\"");
		expect(vault.read(DEFAULT_SETTINGS.configTomlPath)).toContain("review_model = \"deepseek-v4-pro\"");
	});

	it("adds missing image config to an existing config.toml during initialization", async () => {
		const {plugin, vault} = createPluginStub();
		const controller = new ImportController(plugin as never);
		await vault.create(DEFAULT_SETTINGS.configTomlPath, [
			"model_provider = \"DeepSeek\"",
			"model = \"deepseek-v4-flash\"",
			"",
			"[model_providers.DeepSeek]",
			"base_url = \"https://api.deepseek.com\"",
		].join("\n"));

		await controller.ensureConfigTomlReady();

		const content = vault.read(DEFAULT_SETTINGS.configTomlPath);
		expect(content).toContain("model = \"deepseek-v4-flash\"");
		expect(content).toContain("[images]");
		expect(content).toContain("attachment_folder = \"我的知识库/附件/图片\"");
		expect(content).toContain("ocr_max_images = 8");
	});

	it("marks stale processing entries failed before starting a replacement import", async () => {
		const staleEntry = makeProcessingEntry();
		const {plugin} = createPluginStub([staleEntry]);
		const controller = new ImportController(plugin as never);
		const jobResult: JobRunResult = {
			status: "complete",
			url: "https://example.com/article",
			model: "gpt-4o",
			title: "Imported title",
			notePath: "我的知识库/成文/final-note.md",
			sourceType: "webpage",
		};
		const run = vi.fn<() => Promise<JobRunResult>>().mockResolvedValue(jobResult);

		vi.spyOn(controller as never, "refreshEffectiveSettings").mockResolvedValue(plugin.settings);
		(controller as unknown as {jobRunner: {isBusy: () => boolean; run: typeof run}}).jobRunner = {
			isBusy: () => false,
			run,
		};

		await (controller as unknown as {startImport: (rawUrl: string, model: string) => Promise<void>}).startImport(
			"https://example.com/article#section",
			"gpt-4o",
		);

		expect(run).toHaveBeenCalledTimes(1);

		const updatedStaleEntry = plugin.settings.recentImports.find((entry) => entry.id === staleEntry.id);
		expect(updatedStaleEntry?.status).toBe("failed");
		expect(updatedStaleEntry?.progressStage).toBe("failed");
		expect(updatedStaleEntry?.progressMessage).toBe("上一次导入没有完成。");
		expect(updatedStaleEntry?.errorMessage).toBe("上一次导入没有完成。");

		const replacementEntry = plugin.settings.recentImports.find((entry) => entry.id !== staleEntry.id);
		expect(replacementEntry?.status).toBe("complete");
		expect(replacementEntry?.notePath).toBe("我的知识库/成文/final-note.md");
	});

	it("treats the current in-memory run as active instead of marking it stale", async () => {
		const activeEntry = makeProcessingEntry({
			id: "history-active",
			historyNotePath: "我的知识库/状态/历史记录/current-record.md",
		});
		const {plugin} = createPluginStub([activeEntry]);
		const controller = new ImportController(plugin as never);
		const run = vi.fn();
		const openVaultPath = vi.spyOn(controller as never, "openVaultPath").mockResolvedValue(true);

		vi.spyOn(controller as never, "refreshEffectiveSettings").mockResolvedValue(plugin.settings);
		(controller as unknown as {jobRunner: {isBusy: () => boolean; run: typeof run}}).jobRunner = {
			isBusy: () => true,
			run,
		};
		(controller as unknown as {activeRunHistoryId: string | null}).activeRunHistoryId = activeEntry.id;

		await (controller as unknown as {startImport: (rawUrl: string, model: string) => Promise<void>}).startImport(
			"https://example.com/article",
			"gpt-4o",
		);

		expect(run).not.toHaveBeenCalled();
		expect(openVaultPath).toHaveBeenCalledWith("我的知识库/状态/历史记录/current-record.md");
		expect(plugin.settings.recentImports[0]?.status).toBe("processing");
		expect(plugin.saveSettings).not.toHaveBeenCalled();
	});
});
