import {App, TFile} from "obsidian";
import {normalizeCustomModels, normalizeModelApiBaseUrls} from "./model-catalog";
import {ImportUrlPluginSettings} from "./types";

export interface ImportUrlConfigToml {
	modelProvider?: string;
	model?: string;
	reviewModel?: string;
	modelReasoningEffort?: string;
	disableResponseStorage?: boolean;
	modelApiBaseUrl?: string;
	wireApi?: string;
	requiresOpenAiAuth?: boolean;
	outputFolder?: string;
	originalFolder?: string;
	processingFolder?: string;
	failedFolder?: string;
	historyFolder?: string;
	wikiEnabled?: boolean;
	wikiFolder?: string;
	wikiSourcesFolder?: string;
	wikiCandidatesFolder?: string;
	wikiConceptsFolder?: string;
	wikiIndexPath?: string;
}

interface ModelProviderConfig {
	baseUrl?: string;
	wireApi?: string;
	requiresApiAuth?: boolean;
}

const MODEL_PROVIDER_SECTION_PREFIX = "model_providers.";

function unquoteTomlKey(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function parseModelProviderSectionName(section: string): string | null {
	if (!section.startsWith(MODEL_PROVIDER_SECTION_PREFIX)) {
		return null;
	}

	const providerName = unquoteTomlKey(section.slice(MODEL_PROVIDER_SECTION_PREFIX.length));
	return providerName || null;
}

function getModelProviderConfig(
	providers: Map<string, ModelProviderConfig>,
	selectedProvider: string | undefined,
): ModelProviderConfig | undefined {
	const selected = selectedProvider?.trim();
	if (selected) {
		return providers.get(selected);
	}

	const defaultProvider = providers.get("DeepSeek") ?? providers.get("OpenAI");
	if (defaultProvider) {
		return defaultProvider;
	}

	for (const provider of providers.values()) {
		return provider;
	}

	return undefined;
}

function stripInlineComment(line: string): string {
	let result = "";
	let quote: "\"" | "'" | null = null;

	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if ((char === "\"" || char === "'") && line[index - 1] !== "\\") {
			if (quote === char) {
				quote = null;
			} else if (quote === null) {
				quote = char;
			}
		}

		if (char === "#" && quote === null) {
			break;
		}

		result += char;
	}

	return result.trim();
}

function parseTomlValue(rawValue: string): string | boolean | number {
	const trimmed = rawValue.trim();
	if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}

	if (trimmed === "true") {
		return true;
	}

	if (trimmed === "false") {
		return false;
	}

	const numeric = Number(trimmed);
	if (Number.isFinite(numeric)) {
		return numeric;
	}

	return trimmed;
}

export function parseImportUrlConfigToml(content: string): ImportUrlConfigToml {
	const result: ImportUrlConfigToml = {};
	const providers = new Map<string, ModelProviderConfig>();
	let currentSection = "";

	for (const rawLine of content.split(/\r?\n/)) {
		const line = stripInlineComment(rawLine);
		if (!line) {
			continue;
		}

		if (line.startsWith("[") && line.endsWith("]")) {
			currentSection = line.slice(1, -1).trim();
			continue;
		}

		const separatorIndex = line.indexOf("=");
		if (separatorIndex === -1) {
			continue;
		}

		const key = line.slice(0, separatorIndex).trim();
		const value = parseTomlValue(line.slice(separatorIndex + 1));

		if (currentSection === "") {
			if (key === "model_provider" && typeof value === "string") {
				result.modelProvider = value;
			} else if (key === "model" && typeof value === "string") {
				result.model = value;
			} else if (key === "review_model" && typeof value === "string") {
				result.reviewModel = value;
			} else if (key === "model_reasoning_effort" && typeof value === "string") {
				result.modelReasoningEffort = value;
			} else if (key === "disable_response_storage" && typeof value === "boolean") {
				result.disableResponseStorage = value;
			}
			continue;
		}

		const providerName = parseModelProviderSectionName(currentSection);
		if (providerName) {
			const provider = providers.get(providerName) ?? {};
			if (key === "base_url" && typeof value === "string") {
				provider.baseUrl = value;
			} else if (key === "wire_api" && typeof value === "string") {
				provider.wireApi = value;
			} else if ((key === "requires_openai_auth" || key === "requires_api_auth") && typeof value === "boolean") {
				provider.requiresApiAuth = value;
			}
			providers.set(providerName, provider);
		}

		if (currentSection === "output") {
			if (key === "articles_folder" && typeof value === "string") {
				result.outputFolder = value;
			} else if (key === "originals_folder" && typeof value === "string") {
				result.originalFolder = value;
			} else if (key === "processing_folder" && typeof value === "string") {
				result.processingFolder = value;
			} else if (key === "failed_folder" && typeof value === "string") {
				result.failedFolder = value;
			} else if (key === "history_folder" && typeof value === "string") {
				result.historyFolder = value;
			}
		}

		if (currentSection === "wiki") {
			if (key === "enabled" && typeof value === "boolean") {
				result.wikiEnabled = value;
			} else if (key === "folder" && typeof value === "string") {
				result.wikiFolder = value;
			} else if (key === "sources_folder" && typeof value === "string") {
				result.wikiSourcesFolder = value;
			} else if (key === "candidates_folder" && typeof value === "string") {
				result.wikiCandidatesFolder = value;
			} else if (key === "concepts_folder" && typeof value === "string") {
				result.wikiConceptsFolder = value;
			} else if (key === "index_path" && typeof value === "string") {
				result.wikiIndexPath = value;
			}
		}
	}

	const selectedProvider = getModelProviderConfig(providers, result.modelProvider);
	if (selectedProvider?.baseUrl) {
		result.modelApiBaseUrl = selectedProvider.baseUrl;
	}
	if (selectedProvider?.wireApi) {
		result.wireApi = selectedProvider.wireApi;
	}
	if (typeof selectedProvider?.requiresApiAuth === "boolean") {
		result.requiresOpenAiAuth = selectedProvider.requiresApiAuth;
	}

	return result;
}

export function renderDefaultConfigToml(settings: Pick<ImportUrlPluginSettings, "apiBaseUrl" | "model" | "outputFolder" | "originalFolder" | "processingFolder" | "failedFolder" | "historyFolder" | "wikiFolder" | "wikiSourcesFolder" | "wikiCandidatesFolder" | "wikiConceptsFolder" | "wikiIndexPath">): string {
	return [
		"# Import URL 配置文件",
		"# 这个文件放在 Vault 里，方便你直接编辑。",
		"# 修改后下次打开导入弹窗或开始导入时会自动生效。",
		"",
		"model_provider = \"DeepSeek\"",
		`model = "${settings.model}"`,
		`review_model = "${settings.model}"`,
		"model_reasoning_effort = \"high\"",
		"disable_response_storage = true",
		"",
		"[model_providers.DeepSeek]",
		"name = \"DeepSeek\"",
		`base_url = "${settings.apiBaseUrl}"`,
		"wire_api = \"chat_completions\"",
		"requires_api_auth = true",
		"",
		"[output]",
		`articles_folder = "${settings.outputFolder}"`,
		`originals_folder = "${settings.originalFolder}"`,
		`processing_folder = "${settings.processingFolder}"`,
		`failed_folder = "${settings.failedFolder}"`,
		`history_folder = "${settings.historyFolder}"`,
		"",
		"[wiki]",
		"enabled = true",
		`folder = "${settings.wikiFolder}"`,
		`sources_folder = "${settings.wikiSourcesFolder}"`,
		`candidates_folder = "${settings.wikiCandidatesFolder}"`,
		`concepts_folder = "${settings.wikiConceptsFolder}"`,
		`index_path = "${settings.wikiIndexPath}"`,
		"",
	].join("\n");
}

function quoteTomlString(value: string): string {
	return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"")}"`;
}

function upsertRootTomlValue(lines: string[], key: string, line: string): string[] {
	const next = [...lines];
	const index = next.findIndex((rawLine) => {
		const parsed = stripInlineComment(rawLine);
		return new RegExp(`^${key}\\s*=`, "u").test(parsed);
	});

	if (index !== -1) {
		next[index] = line;
		return next;
	}

	next.push(line);
	return next;
}

export function updateConfigTomlModel(content: string, model: string): string {
	const normalizedModel = model.trim();
	const modelLine = `model = ${quoteTomlString(normalizedModel)}`;
	const reviewModelLine = `review_model = ${quoteTomlString(normalizedModel)}`;
	const hasTrailingNewline = /\r?\n$/u.test(content);
	const lines = content.split(/\r?\n/u);
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}

	const firstSectionIndex = lines.findIndex((line) => {
		const parsed = stripInlineComment(line);
		return parsed.startsWith("[") && parsed.endsWith("]");
	});
	const rootLines = firstSectionIndex === -1 ? lines : lines.slice(0, firstSectionIndex);
	const sectionLines = firstSectionIndex === -1 ? [] : lines.slice(firstSectionIndex);
	const updatedRootLines = upsertRootTomlValue(
		upsertRootTomlValue(rootLines, "model", modelLine),
		"review_model",
		reviewModelLine,
	);
	const updated = [...updatedRootLines, ...sectionLines].join("\n");
	return hasTrailingNewline ? `${updated}\n` : updated;
}

export function applyConfigTomlOverrides(
	settings: ImportUrlPluginSettings,
	config: ImportUrlConfigToml | null,
): ImportUrlPluginSettings {
	if (!config) {
		return {
			...settings,
			customModels: normalizeCustomModels(settings.customModels),
			modelApiBaseUrls: normalizeModelApiBaseUrls(settings.modelApiBaseUrls),
		};
	}

	const next: ImportUrlPluginSettings = {
		...settings,
		customModels: normalizeCustomModels(settings.customModels),
		modelApiBaseUrls: normalizeModelApiBaseUrls(settings.modelApiBaseUrls),
	};

	if (typeof config.model === "string" && config.model.trim()) {
		next.model = config.model.trim();
		next.customModels = normalizeCustomModels([...next.customModels, next.model]);
	}

	if (typeof config.modelApiBaseUrl === "string" && config.modelApiBaseUrl.trim()) {
		const rawBaseUrl = config.modelApiBaseUrl.trim().replace(/\/+$/u, "");
		next.apiBaseUrl = rawBaseUrl;
		const targetModel = (config.model?.trim() || next.model).trim();
		if (targetModel) {
			next.modelApiBaseUrls = normalizeModelApiBaseUrls([
				...next.modelApiBaseUrls,
				{
					model: targetModel,
					apiBaseUrl: next.apiBaseUrl,
				},
			]);
		}
	}

	if (config.outputFolder?.trim()) {
		next.outputFolder = config.outputFolder.trim();
	}
	if (config.originalFolder?.trim()) {
		next.originalFolder = config.originalFolder.trim();
	}
	if (config.processingFolder?.trim()) {
		next.processingFolder = config.processingFolder.trim();
	}
	if (config.failedFolder?.trim()) {
		next.failedFolder = config.failedFolder.trim();
	}
	if (config.historyFolder?.trim()) {
		next.historyFolder = config.historyFolder.trim();
	}

	if (config.wikiFolder?.trim()) {
		next.wikiFolder = config.wikiFolder.trim();
	}
	if (config.wikiSourcesFolder?.trim()) {
		next.wikiSourcesFolder = config.wikiSourcesFolder.trim();
	}
	if (config.wikiCandidatesFolder?.trim()) {
		next.wikiCandidatesFolder = config.wikiCandidatesFolder.trim();
	}
	if (config.wikiConceptsFolder?.trim()) {
		next.wikiConceptsFolder = config.wikiConceptsFolder.trim();
	}
	if (config.wikiIndexPath?.trim()) {
		next.wikiIndexPath = config.wikiIndexPath.trim();
	}

	return next;
}

export async function readImportUrlConfigToml(app: App, path: string): Promise<ImportUrlConfigToml | null> {
	const existing = app.vault.getAbstractFileByPath(path);
	if (!(existing instanceof TFile)) {
		return null;
	}

	const vaultWithCachedRead = app.vault as typeof app.vault & {
		cachedRead?: (file: TFile) => Promise<string>;
		read?: (file: TFile) => Promise<string>;
	};
	let content = "";
	if (typeof vaultWithCachedRead.cachedRead === "function") {
		content = await vaultWithCachedRead.cachedRead(existing);
	} else if (typeof vaultWithCachedRead.read === "function") {
		content = await vaultWithCachedRead.read(existing);
	}
	return parseImportUrlConfigToml(content);
}
