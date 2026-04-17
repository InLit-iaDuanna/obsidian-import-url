import {App, Setting} from "obsidian";
import {describe, expect, it, vi} from "vitest";
import ImportUrlPlugin from "../src/main";
import {DEFAULT_SETTINGS, ImportUrlSettingTab} from "../src/settings";

interface MockSetting {
	name: string;
	isHeading: boolean;
}

describe("settings tab", () => {
	it("renders grouped sections and polished labels", () => {
		const settingCtor = Setting as unknown as typeof Setting & {instances: MockSetting[]};
		settingCtor.instances = [];

		const plugin = {
			settings: {...DEFAULT_SETTINGS},
			saveSettings: vi.fn().mockResolvedValue(undefined),
			ensureConfigTomlReady: vi.fn().mockResolvedValue(undefined),
			openConfigToml: vi.fn().mockResolvedValue(undefined),
			getEffectiveSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
		} as unknown as ImportUrlPlugin;

		const tab = new ImportUrlSettingTab({} as App, plugin);
		tab.display();

		const headings = settingCtor.instances.filter((item) => item.isHeading).map((item) => item.name);
		expect(headings).toEqual(["Connection", "Models", "Output", "Fallbacks"]);

		const labels = settingCtor.instances.map((item) => item.name);
		expect(labels).toContain("Test connection");
		expect(labels).toContain("Model-specific API addresses");
		expect(labels).toContain("Browser render fallback (experimental)");
	});
});
