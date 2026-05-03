import {ImportUrlPluginSettings, ModelApiBaseUrlRule, ModelOption} from "./types";

const BUILTIN_MODEL_OPTIONS: ModelOption[] = [
	{id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", description: "质量优先，适合知识库编译、概念抽取和长文整理。"},
	{id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", description: "速度和成本优先，适合大量 URL 导入。"},
];

function cleanModelId(modelId: string): string {
	return modelId.trim();
}

function cleanApiBaseUrl(apiBaseUrl: string): string {
	return apiBaseUrl.trim();
}

export function normalizeCustomModels(models: string[]): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];

	for (const model of models) {
		const cleaned = cleanModelId(model);
		if (!cleaned || seen.has(cleaned)) {
			continue;
		}
		seen.add(cleaned);
		normalized.push(cleaned);
	}

	return normalized;
}

export function parseCustomModelsInput(input: string): string[] {
	return normalizeCustomModels(input.split(/\r?\n|,/));
}

export function formatCustomModelsInput(models: string[]): string {
	return normalizeCustomModels(models).join("\n");
}

export function normalizeModelApiBaseUrls(rules: ModelApiBaseUrlRule[]): ModelApiBaseUrlRule[] {
	const normalized = new Map<string, string>();

	for (const rule of rules) {
		const model = cleanModelId(rule.model);
		const apiBaseUrl = cleanApiBaseUrl(rule.apiBaseUrl);
		if (!model || !apiBaseUrl) {
			continue;
		}

		normalized.set(model, apiBaseUrl);
	}

	return [...normalized.entries()].map(([model, apiBaseUrl]) => ({
		model,
		apiBaseUrl,
	}));
}

export function parseModelApiBaseUrlsInput(input: string): ModelApiBaseUrlRule[] {
	return normalizeModelApiBaseUrls(
		input
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				const separatorIndex = line.includes("|") ? line.indexOf("|") : line.indexOf("=");
				if (separatorIndex === -1) {
					return {
						model: "",
						apiBaseUrl: "",
					};
				}

				return {
					model: line.slice(0, separatorIndex).trim(),
					apiBaseUrl: line.slice(separatorIndex + 1).trim(),
				};
			}),
	);
}

export function formatModelApiBaseUrlsInput(rules: ModelApiBaseUrlRule[]): string {
	return normalizeModelApiBaseUrls(rules)
		.map((rule) => `${rule.model} | ${rule.apiBaseUrl}`)
		.join("\n");
}

export function resolveModelApiBaseUrl(
	settings: Pick<ImportUrlPluginSettings, "apiBaseUrl" | "modelApiBaseUrls">,
	modelId: string,
): string {
	const model = cleanModelId(modelId);
	const override = normalizeModelApiBaseUrls(settings.modelApiBaseUrls).find((rule) => rule.model === model);
	return override?.apiBaseUrl ?? cleanApiBaseUrl(settings.apiBaseUrl);
}

export function getModelOptions(settings: Pick<ImportUrlPluginSettings, "model" | "customModels">): ModelOption[] {
	const options = [...BUILTIN_MODEL_OPTIONS];
	const seen = new Set(options.map((option) => option.id));

	for (const customModel of normalizeCustomModels(settings.customModels)) {
		if (seen.has(customModel)) {
			continue;
		}

		options.push({
			id: customModel,
			label: customModel,
			description: "自定义模型名称",
		});
		seen.add(customModel);
	}

	const currentModel = cleanModelId(settings.model);
	if (currentModel && !seen.has(currentModel)) {
		options.unshift({
			id: currentModel,
			label: `${currentModel} (当前)`,
			description: "当前已保存但不在预设中的模型。",
		});
	}

	return options;
}

export function getPrimaryModel(modelId: string, fallback: string): string {
	const cleaned = cleanModelId(modelId);
	return cleaned || fallback;
}
