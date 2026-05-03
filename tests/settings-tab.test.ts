import {App, Setting} from "obsidian";
import {describe, expect, it, vi} from "vitest";
import ImportUrlPlugin from "../src/main";
import {DEFAULT_SETTINGS, ImportUrlSettingTab} from "../src/settings";

interface MockSetting {
	name: string;
	description: string;
	isHeading: boolean;
}

describe("settings tab", () => {
	it("renders grouped sections and polished labels", async () => {
		const settingCtor = Setting as unknown as typeof Setting & {instances: MockSetting[]};
		settingCtor.instances = [];
		const effectiveSettings = {
			...DEFAULT_SETTINGS,
			model: "deepseek-v4-flash",
			apiBaseUrl: "https://api.deepseek.com",
		};

		const plugin = {
			settings: {...DEFAULT_SETTINGS},
			saveSettings: vi.fn().mockResolvedValue(undefined),
			ensureConfigTomlReady: vi.fn().mockResolvedValue(undefined),
			openConfigToml: vi.fn().mockResolvedValue(undefined),
			getEffectiveSettings: vi.fn().mockResolvedValue(effectiveSettings),
		} as unknown as ImportUrlPlugin;

		const tab = new ImportUrlSettingTab({} as App, plugin);
		tab.display();
		await Promise.resolve();

		const headings = settingCtor.instances.filter((item) => item.isHeading).map((item) => item.name);
		expect(headings).toEqual(["模型接口", "模型", "输出", "抓取兜底"]);

		const labels = settingCtor.instances.map((item) => item.name);
		expect(labels).toContain("当前生效配置");
		expect(labels).toContain("测试连接");
		expect(labels).toContain("模型 API 地址");
		expect(labels).toContain("按模型配置 API 地址");
		expect(labels).toContain("AI 整理目录");
		expect(labels).toContain("原文目录");
		expect(labels).toContain("待入库目录");
		expect(labels).toContain("已入库目录");
		expect(labels).toContain("浏览器渲染兜底（实验）");

		const effectiveSetting = settingCtor.instances.find((item) => item.name === "当前生效配置");
		expect(effectiveSetting?.description).toContain("deepseek-v4-flash");
		expect(effectiveSetting?.description).toContain("https://api.deepseek.com");
	});
});
