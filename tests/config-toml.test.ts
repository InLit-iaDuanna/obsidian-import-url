import {describe, expect, it} from "vitest";
import {applyConfigTomlOverrides, parseImportUrlConfigToml, renderDefaultConfigToml} from "../src/config-toml";
import {DEFAULT_SETTINGS} from "../src/settings";

describe("config toml", () => {
	it("parses provider-style config snippets", () => {
		const parsed = parseImportUrlConfigToml(`
model_provider = "OpenAI"
model = "gpt-5.4"
review_model = "gpt-5.4"
model_reasoning_effort = "xhigh"
disable_response_storage = true

[model_providers.OpenAI]
name = "OpenAI"
base_url = "https://api.example.com/v1"
wire_api = "responses"
requires_openai_auth = true
		`);

		expect(parsed).toEqual({
			modelProvider: "OpenAI",
			model: "gpt-5.4",
			reviewModel: "gpt-5.4",
			modelReasoningEffort: "xhigh",
			disableResponseStorage: true,
			openAiBaseUrl: "https://api.example.com/v1",
			wireApi: "responses",
			requiresOpenAiAuth: true,
		});
	});

	it("applies config overrides onto plugin settings", () => {
		const effective = applyConfigTomlOverrides(DEFAULT_SETTINGS, {
			modelProvider: "OpenAI",
			model: "gpt-5.4",
			openAiBaseUrl: "https://api.example.com/v1",
			wireApi: "responses",
		});

		expect(effective.model).toBe("gpt-5.4");
		expect(effective.apiBaseUrl).toBe("https://api.example.com/v1");
		expect(effective.customModels).toContain("gpt-5.4");
		expect(effective.modelApiBaseUrls).toContainEqual({
			model: "gpt-5.4",
			apiBaseUrl: "https://api.example.com/v1",
		});
	});

	it("supports chat completions wire_api overrides in config.toml", () => {
		const effective = applyConfigTomlOverrides(DEFAULT_SETTINGS, {
			modelProvider: "OpenAI",
			model: "gpt-5.4",
			openAiBaseUrl: "https://api.example.com/v1",
			wireApi: "chat_completions",
		});

		expect(effective.apiBaseUrl).toBe("https://api.example.com/v1/chat/completions");
		expect(effective.modelApiBaseUrls).toContainEqual({
			model: "gpt-5.4",
			apiBaseUrl: "https://api.example.com/v1/chat/completions",
		});
	});

	it("renders a visible editable config template", () => {
		const content = renderDefaultConfigToml({
			model: "gpt-4o",
			apiBaseUrl: "https://api.openai.com/v1",
		});

		expect(content).toContain("model = \"gpt-4o\"");
		expect(content).toContain("base_url = \"https://api.openai.com/v1\"");
		expect(content).toContain("wire_api = \"responses\"");
	});
});
