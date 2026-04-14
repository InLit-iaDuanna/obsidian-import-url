import {ImportUrlPluginSettings, ModelApiBaseUrlRule, ModelOption} from "./types";

const BUILTIN_MODEL_OPTIONS: ModelOption[] = [
	{id: "gpt-5.1", label: "GPT-5.1", description: "当前旗舰，适合复杂整理任务。"},
	{id: "gpt-5", label: "GPT-5", description: "上一代旗舰，推理和长任务表现稳。"},
	{id: "gpt-5-mini", label: "GPT-5 mini", description: "速度和成本更平衡，适合日常导入。"},
	{id: "gpt-5-nano", label: "GPT-5 nano", description: "超低成本，适合轻量摘要。"},
	{id: "gpt-4.1", label: "GPT-4.1", description: "稳定的长上下文非推理模型。"},
	{id: "gpt-4.1-mini", label: "GPT-4.1 mini", description: "更便宜的 GPT-4.1 选择。"},
	{id: "gpt-4.1-nano", label: "GPT-4.1 nano", description: "快速便宜，适合大量试跑。"},
	{id: "gpt-4o", label: "GPT-4o", description: "通用稳妥的多模态模型。"},
	{id: "gpt-4o-mini", label: "GPT-4o mini", description: "便宜且足够通用。"},
	{id: "o3", label: "o3", description: "更强推理，适合难内容整理。"},
	{id: "o3-mini", label: "o3-mini", description: "轻量推理，支持 Structured Outputs。"},
	{id: "o4-mini", label: "o4-mini", description: "成本友好的推理模型。"},
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
			description: "自定义模型 ID",
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
