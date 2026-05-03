import {App, PluginManifest} from "obsidian";
import {describe, expect, it, vi} from "vitest";
import {ImportController} from "../src/import-controller";
import ImportUrlPlugin from "../src/main";

describe("plugin commands", () => {
	it("registers stable command IDs and sentence-case names", async () => {
		const plugin = new ImportUrlPlugin({} as App, {} as PluginManifest);
		const commandRegistry = plugin as unknown as {
			commands: Array<{id: string; name: string; callback: () => void}>;
			settingTabs: unknown[];
			views: Array<{type: string}>;
		};

		vi.spyOn(plugin, "loadSettings").mockResolvedValue(undefined);
		vi.spyOn(ImportController.prototype, "initialize").mockResolvedValue(undefined);

		await plugin.onload();

		expect(commandRegistry.commands.map((command) => command.id)).toEqual([
			"import",
			"import-from-clipboard",
			"open-config",
			"open-wiki-index",
			"open-wiki-manager",
			"rebuild-wiki-concept-graph",
			"cleanup-legacy-wiki-links",
			"approve-current-wiki-candidate",
			"reject-current-wiki-candidate",
		]);
		expect(commandRegistry.commands.map((command) => command.name)).toEqual([
			"从 URL 导入",
			"从剪贴板导入",
			"打开配置文件",
			"打开知识库索引",
			"打开知识库管理",
			"重建知识库真实关联",
			"清理旧图谱链接",
			"批准当前知识库候选页",
			"拒绝当前知识库候选页",
		]);
		expect(commandRegistry.settingTabs).toHaveLength(1);
		expect(commandRegistry.views.map((view) => view.type)).toEqual(["import-url-wiki-manager"]);
	});
});
