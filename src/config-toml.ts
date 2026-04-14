import {App, TFile} from "obsidian";
import {normalizeCustomModels, normalizeModelApiBaseUrls} from "./model-catalog";
import {ImportUrlPluginSettings} from "./types";

export interface ImportUrlConfigToml {
	modelProvider?: string;
	model?: string;
	reviewModel?: string;
	modelReasoningEffort?: string;
	disableResponseStorage?: boolean;
	openAiBaseUrl?: string;
	wireApi?: string;
	requiresOpenAiAuth?: boolean;
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

		if (currentSection === "model_providers.OpenAI") {
			if (key === "base_url" && typeof value === "string") {
				result.openAiBaseUrl = value;
			} else if (key === "wire_api" && typeof value === "string") {
				result.wireApi = value;
			} else if (key === "requires_openai_auth" && typeof value === "boolean") {
				result.requiresOpenAiAuth = value;
			}
		}
	}

	return result;
}

export function renderDefaultConfigToml(settings: Pick<ImportUrlPluginSettings, "apiBaseUrl" | "model">): string {
	return [
		"# Import URL config.toml",
		"# 这个文件放在 Vault 里，方便你直接编辑。",
		"# 修改后下次打开导入弹窗或开始导入时会自动生效。",
		"",
		"model_provider = \"OpenAI\"",
		`model = \"${settings.model}\"`,
		`review_model = \"${settings.model}\"`,
		"model_reasoning_effort = \"high\"",
		"disable_response_storage = true",
		"",
		"[model_providers.OpenAI]",
		"name = \"OpenAI\"",
		`base_url = \"${settings.apiBaseUrl}\"`,
		"wire_api = \"responses\"",
		"requires_openai_auth = true",
		"",
	].join("\n");
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

	const normalizedWireApi = config.wireApi?.trim().toLowerCase();
	if (
		config.modelProvider === "OpenAI"
		&& typeof config.openAiBaseUrl === "string"
		&& config.openAiBaseUrl.trim()
	) {
		const rawBaseUrl = config.openAiBaseUrl.trim().replace(/\/+$/u, "");
		next.apiBaseUrl = normalizedWireApi === "chat_completions" || normalizedWireApi === "chat/completions" || normalizedWireApi === "chat"
			? (rawBaseUrl.endsWith("/chat/completions") ? rawBaseUrl : `${rawBaseUrl}/chat/completions`)
			: rawBaseUrl;
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

	return next;
}

export async function readImportUrlConfigToml(app: App, path: string): Promise<ImportUrlConfigToml | null> {
	const existing = app.vault.getAbstractFileByPath(path);
	if (!(existing instanceof TFile)) {
		return null;
	}

	const vaultWithCachedRead = app.vault as typeof app.vault & {
		cachedRead?: (file: TFile) => Promise<string>;
	};
	const content = typeof vaultWithCachedRead.cachedRead === "function"
		? await vaultWithCachedRead.cachedRead(existing)
		: "";
	return parseImportUrlConfigToml(content);
}
