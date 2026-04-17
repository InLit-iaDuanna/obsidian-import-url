import {App, PluginManifest} from "obsidian";
import {describe, expect, it, vi} from "vitest";
import ImportUrlPlugin from "../src/main";
import {DEFAULT_SETTINGS} from "../src/settings";

describe("plugin commands", () => {
	it("registers stable command IDs and sentence-case names", async () => {
		const plugin = new ImportUrlPlugin({} as App, {} as PluginManifest);
		const commandRegistry = plugin as unknown as {
			commands: Array<{id: string; name: string; callback: () => void}>;
			settingTabs: unknown[];
		};
		const internalMethods = plugin as unknown as {
			tryEnsureConfigTomlReady: () => Promise<void>;
			refreshEffectiveSettings: () => Promise<typeof DEFAULT_SETTINGS>;
		};

		vi.spyOn(plugin, "loadSettings").mockResolvedValue(undefined);
		vi.spyOn(internalMethods, "tryEnsureConfigTomlReady").mockResolvedValue(undefined);
		vi.spyOn(internalMethods, "refreshEffectiveSettings").mockResolvedValue(DEFAULT_SETTINGS);

		await plugin.onload();

		expect(commandRegistry.commands.map((command) => command.id)).toEqual(["import", "open-config"]);
		expect(commandRegistry.commands.map((command) => command.name)).toEqual(["Import from URL", "Open config file"]);
		expect(commandRegistry.settingTabs).toHaveLength(1);
	});
});
