import {describe, expect, it} from "vitest";
import {applyImportUrlGraphColorGroups} from "../src/graph-colors";
import {createFakeApp, FAKE_CONFIG_DIR} from "./helpers";

const graphPath = `${FAKE_CONFIG_DIR}/graph.json`;

describe("graph color groups", () => {
	it("writes import-url color groups into Obsidian graph config", async () => {
		const {app, vault} = createFakeApp();

		const result = await applyImportUrlGraphColorGroups(app);

		expect(result).toEqual({
			graphPath,
			added: 6,
			updated: 0,
			unchanged: 0,
			total: 6,
			preserved: 0,
		});
		const config = JSON.parse(vault.read(graphPath)) as {
			"collapse-color-groups": boolean;
			colorGroups: Array<{query: string; color: {a: number; rgb: number}}>;
		};
		expect(config["collapse-color-groups"]).toBe(false);
		expect(config.colorGroups.map((group) => group.query)).toEqual([
			"tag:#import-url/concept",
			"tag:#import-url/candidate",
			"tag:#import-url/article",
			"tag:#import-url/original",
			"tag:#import-url/source OR tag:#import-url/history OR tag:#import-url/processing OR tag:#import-url/failed OR tag:#import-url/index",
			"-tag:#import-url/generated",
		]);
		expect(config.colorGroups[0]?.color).toEqual({a: 1, rgb: 0x2fb344});
	});

	it("updates existing import-url groups while preserving user groups", async () => {
		const {app, vault} = createFakeApp();
		await vault.create(graphPath, JSON.stringify({
			"collapse-color-groups": true,
			colorGroups: [
				{query: "path:Projects", color: {a: 1, rgb: 0x111111}},
				{query: "tag:#import-url/concept", color: {a: 1, rgb: 0}},
			],
		}));

		const result = await applyImportUrlGraphColorGroups(app);

		expect(result.added).toBe(5);
		expect(result.updated).toBe(1);
		expect(result.preserved).toBe(1);
		const config = JSON.parse(vault.read(graphPath)) as {
			colorGroups: Array<{query: string; color: {a: number; rgb: number}}>;
		};
		expect(config.colorGroups[0]).toEqual({query: "path:Projects", color: {a: 1, rgb: 0x111111}});
		expect(config.colorGroups.find((group) => group.query === "tag:#import-url/concept")?.color.rgb).toBe(0x2fb344);
	});
});
