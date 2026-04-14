import {describe, expect, it} from "vitest";
import {
	formatCustomModelsInput,
	formatModelApiBaseUrlsInput,
	getModelOptions,
	normalizeCustomModels,
	parseCustomModelsInput,
	parseModelApiBaseUrlsInput,
	resolveModelApiBaseUrl,
} from "../src/model-catalog";
import {DEFAULT_SETTINGS} from "../src/settings";

describe("model catalog", () => {
	it("merges built-in, custom, and current models without duplicates", () => {
		const options = getModelOptions({
			...DEFAULT_SETTINGS,
			model: "my-special-model",
			customModels: ["gpt-5.1", "my-special-model", "another-model"],
		});

		expect(options.some((option) => option.id === "gpt-5.1")).toBe(true);
		expect(options.some((option) => option.id === "another-model")).toBe(true);
		expect(options.filter((option) => option.id === "my-special-model")).toHaveLength(1);
	});

	it("normalizes custom model input", () => {
		expect(parseCustomModelsInput("gpt-5.1\n\nfoo , bar, foo")).toEqual(["gpt-5.1", "foo", "bar"]);
		expect(formatCustomModelsInput(normalizeCustomModels([" foo ", "foo", "bar"]))).toBe("foo\nbar");
	});

	it("parses and resolves per-model API base URLs", () => {
		const rules = parseModelApiBaseUrlsInput("gpt-5.4 | https://api.example.com/v1\n gpt-4o = https://api.openai.com/v1 ");
		expect(formatModelApiBaseUrlsInput(rules)).toBe("gpt-5.4 | https://api.example.com/v1\ngpt-4o | https://api.openai.com/v1");
		expect(resolveModelApiBaseUrl({
			...DEFAULT_SETTINGS,
			apiBaseUrl: "https://fallback.example/v1",
			modelApiBaseUrls: rules,
		}, "gpt-5.4")).toBe("https://api.example.com/v1");
		expect(resolveModelApiBaseUrl({
			...DEFAULT_SETTINGS,
			apiBaseUrl: "https://fallback.example/v1",
			modelApiBaseUrls: rules,
		}, "o3")).toBe("https://fallback.example/v1");
	});
});
