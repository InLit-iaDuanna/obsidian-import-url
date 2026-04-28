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
		};

		vi.spyOn(plugin, "loadSettings").mockResolvedValue(undefined);
		vi.spyOn(ImportController.prototype, "initialize").mockResolvedValue(undefined);

		await plugin.onload();

		expect(commandRegistry.commands.map((command) => command.id)).toEqual(["import", "import-from-clipboard", "open-config"]);
		expect(commandRegistry.commands.map((command) => command.name)).toEqual(["Import from URL", "Import from clipboard", "Open config file"]);
		expect(commandRegistry.settingTabs).toHaveLength(1);
	});
});
