import {describe, expect, it} from "vitest";
import {applyConfigTomlOverrides, ensureConfigTomlImagesSection, parseImportUrlConfigToml, readImportUrlConfigToml, renderDefaultConfigToml, updateConfigTomlModel} from "../src/config-toml";
import {DEFAULT_SETTINGS} from "../src/settings";
import {createFakeApp} from "./helpers";

describe("config toml", () => {
	it("parses provider-style config snippets", () => {
		const parsed = parseImportUrlConfigToml(`
model_provider = "DeepSeek"
model = "deepseek-v4-pro"
review_model = "deepseek-v4-pro"
model_reasoning_effort = "xhigh"
disable_response_storage = true

[model_providers.DeepSeek]
name = "DeepSeek"
base_url = "https://api.deepseek.com"
wire_api = "chat_completions"
requires_api_auth = true

[output]
articles_folder = "我的知识库/成文"
originals_folder = "我的知识库/原文"
processing_folder = "我的知识库/状态/处理中"
failed_folder = "我的知识库/状态/失败记录"
history_folder = "我的知识库/状态/历史记录"

[wiki]
enabled = true
folder = "我的知识库/概念库"
sources_folder = "我的知识库/概念库/来源"
candidates_folder = "我的知识库/概念库/待入库"
concepts_folder = "我的知识库/概念库/已入库"
index_path = "我的知识库/概念库/索引.md"

[images]
download_enabled = true
attachment_folder = "我的知识库/附件/图片"
ocr_enabled = true
ocr_provider = "baidu"
ocr_api_base_url = "https://vision.example.com/v1"
ocr_model = "vision-model"
ocr_secret_name = "import-url-image-ocr-api-key"
ocr_baidu_api_key_secret_name = "baidu-api"
ocr_baidu_secret_key_secret_name = "baidu-secret"
ocr_max_images = 4
		`);

		expect(parsed).toEqual({
			modelProvider: "DeepSeek",
			model: "deepseek-v4-pro",
			reviewModel: "deepseek-v4-pro",
			modelReasoningEffort: "xhigh",
			disableResponseStorage: true,
			modelApiBaseUrl: "https://api.deepseek.com",
			wireApi: "chat_completions",
			requiresApiAuth: true,
			outputFolder: "我的知识库/成文",
			originalFolder: "我的知识库/原文",
			processingFolder: "我的知识库/状态/处理中",
			failedFolder: "我的知识库/状态/失败记录",
			historyFolder: "我的知识库/状态/历史记录",
			wikiEnabled: true,
			wikiFolder: "我的知识库/概念库",
			wikiSourcesFolder: "我的知识库/概念库/来源",
			wikiCandidatesFolder: "我的知识库/概念库/待入库",
			wikiConceptsFolder: "我的知识库/概念库/已入库",
			wikiIndexPath: "我的知识库/概念库/索引.md",
			imageDownloadEnabled: true,
			imageAttachmentFolder: "我的知识库/附件/图片",
			imageOcrEnabled: true,
			imageOcrProvider: "baidu",
			imageOcrApiBaseUrl: "https://vision.example.com/v1",
			imageOcrModel: "vision-model",
			imageOcrSecretName: "import-url-image-ocr-api-key",
			imageOcrBaiduApiKeySecretName: "baidu-api",
			imageOcrBaiduSecretKeySecretName: "baidu-secret",
			imageOcrMaxImages: 4,
		});
	});

	it("applies config overrides onto plugin settings", () => {
		const effective = applyConfigTomlOverrides(DEFAULT_SETTINGS, {
			modelProvider: "DeepSeek",
			model: "deepseek-v4-pro",
			modelApiBaseUrl: "https://api.deepseek.com",
			wireApi: "chat_completions",
		});

		expect(effective.model).toBe("deepseek-v4-pro");
		expect(effective.apiBaseUrl).toBe("https://api.deepseek.com");
		expect(effective.customModels).toContain("deepseek-v4-pro");
		expect(effective.modelApiBaseUrls).toContainEqual({
			model: "deepseek-v4-pro",
			apiBaseUrl: "https://api.deepseek.com",
		});
	});

	it("supports legacy provider config overrides", () => {
		const effective = applyConfigTomlOverrides(DEFAULT_SETTINGS, {
			modelProvider: "OpenAI",
			model: "gpt-5.4",
			modelApiBaseUrl: "https://api.example.com/v1",
			wireApi: "chat_completions",
		});

		expect(effective.apiBaseUrl).toBe("https://api.example.com/v1");
		expect(effective.modelApiBaseUrls).toContainEqual({
			model: "gpt-5.4",
			apiBaseUrl: "https://api.example.com/v1",
		});
	});

	it("supports custom selected provider config overrides", () => {
		const parsed = parseImportUrlConfigToml(`
model_provider = "CustomGateway"
model = "custom-model"

[model_providers.DeepSeek]
base_url = "https://api.deepseek.com"

[model_providers.CustomGateway]
base_url = "https://gateway.example.com/api"
wire_api = "chat_completions"
requires_api_auth = true
		`);
		const effective = applyConfigTomlOverrides(DEFAULT_SETTINGS, parsed);

		expect(parsed.modelApiBaseUrl).toBe("https://gateway.example.com/api");
		expect(effective.model).toBe("custom-model");
		expect(effective.apiBaseUrl).toBe("https://gateway.example.com/api");
		expect(effective.modelApiBaseUrls).toContainEqual({
			model: "custom-model",
			apiBaseUrl: "https://gateway.example.com/api",
		});
	});

	it("keeps legacy auth field parsing compatible with the generic API auth name", () => {
		const parsed = parseImportUrlConfigToml(`
model_provider = "LegacyGateway"
model = "custom-model"

[model_providers.LegacyGateway]
base_url = "https://gateway.example.com/api"
requires_openai_auth = true
		`);

		expect(parsed.requiresApiAuth).toBe(true);
	});

	it("does not let unselected provider sections override the selected provider", () => {
		const parsed = parseImportUrlConfigToml(`
model_provider = "CustomGateway"
model = "custom-model"

[model_providers.CustomGateway]
base_url = "https://gateway.example.com/api"
wire_api = "chat_completions"

[model_providers.DeepSeek]
base_url = "https://api.deepseek.com"
wire_api = "chat_completions"
		`);

		expect(parsed.modelApiBaseUrl).toBe("https://gateway.example.com/api");
	});

	it("defaults to the DeepSeek provider section when no provider is selected", () => {
		const parsed = parseImportUrlConfigToml(`
model = "deepseek-v4-flash"

[model_providers.OpenAI]
base_url = "https://legacy.example.com/v1"

[model_providers.DeepSeek]
base_url = "https://api.deepseek.com"
wire_api = "chat_completions"
		`);

		expect(parsed.modelApiBaseUrl).toBe("https://api.deepseek.com");
		expect(parsed.wireApi).toBe("chat_completions");
	});

	it("supports quoted provider section names", () => {
		const parsed = parseImportUrlConfigToml(`
model_provider = "Custom Gateway"
model = "custom-model"

[model_providers."Custom Gateway"]
base_url = "https://gateway.example.com/api"
wire_api = "chat_completions"
		`);

		expect(parsed.modelApiBaseUrl).toBe("https://gateway.example.com/api");
	});

	it("renders a visible editable config template", () => {
		const content = renderDefaultConfigToml(DEFAULT_SETTINGS);

		expect(content).toContain("model_provider = \"DeepSeek\"");
		expect(content).toContain("base_url = \"https://api.deepseek.com\"");
		expect(content).toContain("wire_api = \"chat_completions\"");
		expect(content).toContain("[output]");
		expect(content).toContain("articles_folder = \"我的知识库/成文\"");
		expect(content).toContain("originals_folder = \"我的知识库/原文\"");
		expect(content).toContain("processing_folder = \"我的知识库/状态/处理中\"");
		expect(content).toContain("failed_folder = \"我的知识库/状态/失败记录\"");
		expect(content).toContain("history_folder = \"我的知识库/状态/历史记录\"");
		expect(content).toContain("[wiki]");
		expect(content).toContain("[images]");
		expect(content).toContain("download_enabled = true");
		expect(content).toContain("attachment_folder = \"我的知识库/附件/图片\"");
		expect(content).toContain("ocr_enabled = false");
		expect(content).toContain("ocr_provider = \"openai-compatible\"");
		expect(content).toContain("ocr_secret_name = \"import-url-image-ocr-api-key\"");
		expect(content).toContain("ocr_baidu_api_key_secret_name = \"import-url-baidu-ocr-api-key\"");
		expect(content).toContain("ocr_baidu_secret_key_secret_name = \"import-url-baidu-ocr-secret-key\"");
	});

	it("updates the saved default model in config.toml without touching provider sections", () => {
		const content = updateConfigTomlModel([
			"# 导入 URL 配置文件",
			"model_provider = \"DeepSeek\"",
			"model = \"gpt-5.4\"",
			"review_model = \"gpt-5.4\"",
			"",
			"[model_providers.DeepSeek]",
			"base_url = \"https://api.deepseek.com\"",
		].join("\n"), "deepseek-v4-flash");

		expect(content).toContain("model = \"deepseek-v4-flash\"");
		expect(content).toContain("review_model = \"deepseek-v4-flash\"");
		expect(content).toContain("[model_providers.DeepSeek]");
		expect(content).toContain("base_url = \"https://api.deepseek.com\"");
		expect(content).not.toContain("gpt-5.4");
	});

	it("adds image settings to older config.toml files without changing existing sections", () => {
		const content = ensureConfigTomlImagesSection([
			"# 导入 URL 配置文件",
			"model_provider = \"DeepSeek\"",
			"model = \"deepseek-v4-flash\"",
			"",
			"[model_providers.DeepSeek]",
			"base_url = \"https://api.deepseek.com\"",
			"",
			"[output]",
			"articles_folder = \"我的知识库/成文\"",
		].join("\n"), DEFAULT_SETTINGS);

		expect(content).toContain("model = \"deepseek-v4-flash\"");
		expect(content).toContain("[model_providers.DeepSeek]");
		expect(content).toContain("[output]");
		expect(content).toContain("[images]");
		expect(content).toContain("download_enabled = true");
		expect(content).toContain("attachment_folder = \"我的知识库/附件/图片\"");
		expect(content).toContain("ocr_enabled = false");
		expect(content).toContain("ocr_provider = \"openai-compatible\"");
		expect(content).toContain("ocr_secret_name = \"import-url-image-ocr-api-key\"");
		expect(content).toContain("ocr_baidu_api_key_secret_name = \"import-url-baidu-ocr-api-key\"");
		expect(content).toContain("ocr_baidu_secret_key_secret_name = \"import-url-baidu-ocr-secret-key\"");
		expect(content).toContain("ocr_max_images = 8");
	});

	it("preserves existing image settings while adding only missing image keys", () => {
		const content = ensureConfigTomlImagesSection([
			"model_provider = \"DeepSeek\"",
			"",
			"[images]",
			"download_enabled = false",
			"attachment_folder = \"自定义/图片\"",
			"ocr_enabled = true",
			"ocr_model = \"custom-vision\"",
			"",
			"[wiki]",
			"enabled = true",
		].join("\n"), DEFAULT_SETTINGS);

		expect(content).toContain("download_enabled = false");
		expect(content).toContain("attachment_folder = \"自定义/图片\"");
		expect(content).toContain("ocr_enabled = true");
		expect(content).toContain("ocr_model = \"custom-vision\"");
		expect(content).toContain("ocr_api_base_url = \"\"");
		expect(content).toContain("ocr_secret_name = \"import-url-image-ocr-api-key\"");
		expect(content).toContain("ocr_max_images = 8");
		expect(content).toContain("[wiki]");
		expect(content.match(/download_enabled =/gu)).toHaveLength(1);
	});

	it("reads config files from compatible vault file objects", async () => {
		const {app, vault} = createFakeApp();
		await vault.create("我的知识库/导入URL配置.toml", [
			"model_provider = \"DeepSeek\"",
			"model = \"deepseek-v4-pro\"",
			"",
			"[model_providers.DeepSeek]",
			"base_url = \"https://api.deepseek.com\"",
			"wire_api = \"chat_completions\"",
		].join("\n"));

		const parsed = await readImportUrlConfigToml(app, "我的知识库/导入URL配置.toml");

		expect(parsed?.model).toBe("deepseek-v4-pro");
		expect(parsed?.modelApiBaseUrl).toBe("https://api.deepseek.com");
	});
});
