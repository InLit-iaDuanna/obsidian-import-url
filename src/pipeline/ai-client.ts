import {Fetcher, TimeoutError} from "./fetcher";
import {
	ImportUrlPluginSettings,
	MODEL_MAX_OUTPUT_TOKENS,
	OpenAiResponsesApiResponse,
	PipelineError,
	StructuredDigest,
	WikiConceptDraft,
	WebpagePromptMetadata,
} from "../types";
import {PROMPT_VERSION, getPdfUserPrompt, getSystemPrompt, getWebpageUserPrompt} from "../prompts/digest-prompt";

export const DEFAULT_API_BASE_URL = "https://api.deepseek.com";
const RETRY_DELAYS_MS = [2000, 5000];
const PDF_DOWNLOAD_ERROR_PATTERN = /could not download|fetch failed|download failed|\b403\b|\b404\b/i;
const UPSTREAM_FAILURE_PATTERN = /upstream request failed|model not found|no such model|unsupported model/i;
const UNSUPPORTED_RESPONSES_PATTERN = /unsupported.*responses|responses.*(?:not supported|unsupported|not found)|unknown.*responses|invalid.*responses|unknown parameter.*(?:input|instructions|metadata|text)|unsupported parameter.*(?:input|instructions|metadata|text)|method not allowed/i;
const COMPAT_FALLBACK_MAX_CONTENT_TOKENS = 12000;

type WireApi = "responses" | "chat_completions";

interface RequestCandidate {
	wireApi: WireApi;
	requestUrl: string;
}

interface ApiEndpointInfo {
	baseUrl: string;
	explicitWireApi?: WireApi;
}

interface ApiBaseCandidate {
	baseUrl: string;
	isPreferred: boolean;
}

interface OpenAiChatCompletionsMessagePart {
	type?: string;
	text?: string;
	refusal?: string;
	[key: string]: unknown;
}

interface OpenAiChatCompletionsMessage {
	role?: string;
	content?: string | OpenAiChatCompletionsMessagePart[] | null;
	refusal?: string | null;
	[key: string]: unknown;
}

interface OpenAiChatCompletionsChoice {
	message?: OpenAiChatCompletionsMessage;
	delta?: {
		content?: string;
		[key: string]: unknown;
	};
	text?: string;
	finish_reason?: string | null;
	[key: string]: unknown;
}

interface OpenAiChatCompletionsResponse {
	choices?: OpenAiChatCompletionsChoice[];
	error?: {
		message?: string;
		type?: string;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

interface ServerSentEvent {
	event?: string;
	data: string;
}

export const STRUCTURED_DIGEST_REQUIRED_FIELDS = [
	"title",
	"summary",
	"keyPoints",
	"keyFacts",
	"actionItems",
	"fullOrganizedMarkdown",
	"concepts",
	"suggestedTags",
	"warnings",
] as const satisfies ReadonlyArray<keyof StructuredDigest>;

export const DIGEST_SCHEMA = {
	type: "object",
	properties: {
		title: {type: "string"},
		summary: {type: "string"},
		keyPoints: {type: "array", items: {type: "string"}},
		keyFacts: {type: "array", items: {type: "string"}},
		actionItems: {type: "array", items: {type: "string"}},
		fullOrganizedMarkdown: {type: "string"},
		concepts: {
			type: "array",
			items: {
				type: "object",
				properties: {
					title: {type: "string"},
					aliases: {type: "array", items: {type: "string"}},
					summary: {type: "string"},
					evidence: {type: "array", items: {type: "string"}},
					relatedConcepts: {type: "array", items: {type: "string"}},
					confidence: {type: "number"},
				},
				required: ["title", "aliases", "summary", "evidence", "relatedConcepts", "confidence"],
				additionalProperties: false,
			},
		},
		suggestedTags: {type: "array", items: {type: "string"}},
		warnings: {type: "array", items: {type: "string"}},
	},
	required: [...STRUCTURED_DIGEST_REQUIRED_FIELDS],
	additionalProperties: false,
} as const;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		window.setTimeout(resolve, ms);
	});
}

function estimateMarkdownTokens(markdown: string): number {
	return Math.ceil(markdown.length / 4);
}

function truncateForCompatibility(markdown: string, maxTokens: number): string {
	if (estimateMarkdownTokens(markdown) <= maxTokens) {
		return markdown;
	}

	const hardLimit = maxTokens * 4;
	const sliced = markdown.slice(0, hardLimit);
	const boundary = sliced.lastIndexOf("\n\n");
	return (boundary >= 0 ? sliced.slice(0, boundary) : sliced).trimEnd();
}

function uniqueWarnings(warnings: string[]): string[] {
	return [...new Set(warnings.map((warning) => warning.trim()).filter(Boolean))];
}

function isGpt5FamilyModel(model: string): boolean {
	return /^gpt-5(?:$|[.-])/iu.test(model.trim());
}

function getApiEndpointInfo(apiBaseUrl: string): ApiEndpointInfo {
	const trimmed = apiBaseUrl.trim();
	const normalized = (trimmed || DEFAULT_API_BASE_URL).replace(/\/+$/u, "");

	if (normalized.endsWith("/responses")) {
		return {
			baseUrl: normalized.replace(/\/responses$/u, ""),
			explicitWireApi: "responses",
		};
	}

	if (normalized.endsWith("/chat/completions")) {
		return {
			baseUrl: normalized.replace(/\/chat\/completions$/u, ""),
			explicitWireApi: "chat_completions",
		};
	}

	return {baseUrl: normalized};
}

function uniqueBaseUrls(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function getApiBaseCandidates(apiBaseUrl: string): ApiBaseCandidate[] {
	const endpoint = getApiEndpointInfo(apiBaseUrl);
	const bases: ApiBaseCandidate[] = [
		{
			baseUrl: endpoint.baseUrl,
			isPreferred: true,
		},
	];

	try {
		const parsed = new URL(endpoint.baseUrl);
		const pathname = parsed.pathname.replace(/\/+$/u, "");
		if (!pathname || pathname === "/") {
			bases.push({
				baseUrl: `${parsed.origin}/v1`,
				isPreferred: false,
			});
		}
	} catch {
		// Keep the provided base URL only when it is not a valid absolute URL.
	}

	return uniqueBaseUrls(bases.map((candidate) => candidate.baseUrl)).map((baseUrl) => ({
		baseUrl,
		isPreferred: baseUrl === endpoint.baseUrl,
	}));
}

export function buildResponsesApiUrl(apiBaseUrl: string): string {
	const endpoint = getApiEndpointInfo(apiBaseUrl);
	return `${endpoint.baseUrl}/responses`;
}

export function buildChatCompletionsApiUrl(apiBaseUrl: string): string {
	const endpoint = getApiEndpointInfo(apiBaseUrl);
	return `${endpoint.baseUrl}/chat/completions`;
}

function getRequestCandidates(
	apiBaseUrl: string,
	_mode: "webpage" | "pdf" | "test",
): RequestCandidate[] {
	const baseCandidates = getApiBaseCandidates(apiBaseUrl);
	const chatCandidates = baseCandidates.map((candidate) => ({
		wireApi: "chat_completions" as const,
		requestUrl: buildChatCompletionsApiUrl(candidate.baseUrl),
		isPreferred: candidate.isPreferred,
	}));

	return uniqueBaseUrls([
		...chatCandidates.filter((candidate) => candidate.isPreferred).map((candidate) => candidate.requestUrl),
		...chatCandidates.filter((candidate) => !candidate.isPreferred).map((candidate) => candidate.requestUrl),
	]).map((requestUrl) => ({
		wireApi: "chat_completions",
		requestUrl,
	}));
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isWikiConceptDraft(value: unknown): value is WikiConceptDraft {
	if (!isRecord(value)) {
		return false;
	}

	return typeof value.title === "string"
		&& isStringArray(value.aliases)
		&& typeof value.summary === "string"
		&& isStringArray(value.evidence)
		&& isStringArray(value.relatedConcepts)
		&& typeof value.confidence === "number"
		&& Number.isFinite(value.confidence)
		&& Object.keys(value).length === 6;
}

function isWikiConceptDraftArray(value: unknown): value is WikiConceptDraft[] {
	return Array.isArray(value) && value.every((item) => isWikiConceptDraft(item));
}

function normalizeJsonText(rawText: string): string {
	const trimmed = rawText.trim();
	const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
	return fencedMatch?.[1]?.trim() || trimmed;
}

function getStructuredDigestJsonInstructions(): string {
	return [
		"你必须只返回一个 JSON object，不要输出 Markdown 代码块，不要附加解释。",
		"JSON 必须且只能包含这些字段：",
		"- title: string",
		"- summary: string",
		"- keyPoints: string[]",
		"- keyFacts: string[]",
		"- actionItems: string[]",
		"- fullOrganizedMarkdown: string",
		"- concepts: array of objects with title, aliases, summary, evidence, relatedConcepts, confidence",
		"- suggestedTags: string[]",
		"- warnings: string[]",
		"concepts 中每个对象必须且只能包含：title string、aliases string[]、summary string、evidence string[]、relatedConcepts string[]、confidence number。",
	].join("\n");
}

function getConnectionTestJsonInstructions(): string {
	return [
		"Return exactly one JSON object.",
		"Do not wrap the JSON in markdown fences.",
		"The JSON must be: {\"ok\":true,\"model\":\"<model>\"}.",
	].join("\n");
}

function getChatCompletionTokenLimit(limit: number, model: string): Record<string, number> {
	if (isGpt5FamilyModel(model)) {
		return {
			max_completion_tokens: limit,
		};
	}

	return {
		max_tokens: limit,
	};
}

function parseStructuredDigestText(rawText: string, isPdf: boolean): StructuredDigest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(normalizeJsonText(rawText));
		} catch {
			throw new PipelineError({
				stage: "ai_parse",
				errorMessage: "模型接口返回的结构化整理结果不是有效 JSON。",
				suggestion: isPdf ? getPdfSuggestion(rawText) : "模型返回了非 JSON 内容。请重试，或切换到更稳定支持结构化输出的模型。",
			});
		}

	if (!validateStructuredDigest(parsed)) {
		throw new PipelineError({
			stage: "ai_parse",
			errorMessage: "模型接口返回的 JSON 不符合结构化整理 schema。",
			suggestion: isPdf ? getPdfSuggestion(rawText) : "模型返回的 JSON 不符合预期 schema。请切换模型，或检查接口是否支持 JSON 输出。",
		});
	}

	return parsed;
}

export function validateStructuredDigest(payload: unknown): payload is StructuredDigest {
	if (!payload || typeof payload !== "object") {
		return false;
	}

	const candidate = payload as Record<string, unknown>;
	return typeof candidate.title === "string"
		&& typeof candidate.summary === "string"
		&& typeof candidate.fullOrganizedMarkdown === "string"
		&& isStringArray(candidate.keyPoints)
		&& isStringArray(candidate.keyFacts)
		&& isStringArray(candidate.actionItems)
		&& isWikiConceptDraftArray(candidate.concepts)
		&& isStringArray(candidate.suggestedTags)
		&& isStringArray(candidate.warnings)
		&& Object.keys(candidate).length === STRUCTURED_DIGEST_REQUIRED_FIELDS.length;
}

function getPdfSuggestion(message: string): string {
	if (PDF_DOWNLOAD_ERROR_PATTERN.test(message)) {
		return "PDF 内容无法提取。请确认该链接在浏览器中无需登录即可直接下载，且不受地域限制、临时签名或反爬策略影响。";
	}

	return "请确认该 PDF 链接是公开、直达、无需登录的下载地址。";
}

function defaultAiCallSuggestion(isPdf: boolean, model: string, requestUrl: string): string {
	if (isPdf) {
		return "请确认 PDF 链接公开可访问，且文本可以在本地提取后发送给当前模型接口。";
	}

	return `AI 接口调用失败。请检查模型 ${model} 是否可用，并确认接口 ${requestUrl} 支持当前请求格式。`;
}

function defaultAiParseSuggestion(isPdf: boolean, model: string, requestUrl: string): string {
	if (isPdf) {
		return "模型已返回结果，但结构化解析失败。请重试，或切换到更稳定支持 JSON 输出的接口。";
	}

	return `模型已响应，但返回内容不符合结构化输出要求。请重试，或确认模型 ${model} 在接口 ${requestUrl} 上支持 JSON 输出。`;
}

function getApiErrorMessage(responseText: string): string {
	try {
		const parsed = JSON.parse(responseText) as {error?: {message?: string}};
		return parsed.error?.message
			|| (typeof (parsed as {message?: unknown}).message === "string" ? (parsed as {message?: string}).message : "")
			|| responseText;
	} catch {
		return responseText;
	}
}

function summarizeResponseShape(payload: unknown): string {
	if (!isRecord(payload)) {
		return `响应类型：${payload === null ? "null" : typeof payload}。`;
	}

	const topLevelKeys = Object.keys(payload).slice(0, 8);
	const segments = [
		`顶层字段：${topLevelKeys.length > 0 ? topLevelKeys.join(", ") : "无"}。`,
	];

	for (const key of ["data", "result", "response", "message"] as const) {
		const nested = payload[key];
		if (isRecord(nested)) {
			const nestedKeys = Object.keys(nested).slice(0, 8);
			segments.push(`${key} 字段：${nestedKeys.length > 0 ? nestedKeys.join(", ") : "无"}。`);
		}
	}

	return segments.join(" ");
}

function summarizeResponsePreview(payload: unknown, maxLength = 280): string {
	try {
		const serialized = JSON.stringify(payload);
		if (!serialized) {
			return "";
		}

		return serialized.length <= maxLength
			? serialized
			: `${serialized.slice(0, maxLength)}...`;
	} catch {
		return "";
	}
}

function parseServerSentEvents(rawText: string): ServerSentEvent[] {
	const events: ServerSentEvent[] = [];
	let currentEvent: string | undefined;
	let currentDataLines: string[] = [];

	const flush = (): void => {
		if (currentDataLines.length === 0) {
			currentEvent = undefined;
			return;
		}

		events.push({
			event: currentEvent,
			data: currentDataLines.join("\n"),
		});
		currentEvent = undefined;
		currentDataLines = [];
	};

	for (const line of rawText.split(/\r?\n/u)) {
		if (!line.trim()) {
			flush();
			continue;
		}

		if (line.startsWith("event:")) {
			currentEvent = line.slice("event:".length).trim();
			continue;
		}

		if (line.startsWith("data:")) {
			currentDataLines.push(line.slice("data:".length).trimStart());
		}
	}

	flush();
	return events;
}

function extractChatCompletionStreamText(rawText: string): string {
	let result = "";

	for (const event of parseServerSentEvents(rawText)) {
		if (!event.data || event.data === "[DONE]") {
			continue;
		}

		try {
			const payload = JSON.parse(event.data) as OpenAiChatCompletionsResponse;
			for (const choice of payload.choices ?? []) {
				const delta = choice.delta as Record<string, unknown> | undefined;
				if (typeof delta?.content === "string") {
					result += delta.content;
				}
			}
		} catch {
			// Ignore malformed stream chunks and let final empty-result handling report failure.
		}
	}

	return result;
}

function extractResponsesStreamText(rawText: string): string {
	let result = "";
	let sawDelta = false;
	let lastCompletedText = "";

	for (const event of parseServerSentEvents(rawText)) {
		if (!event.data || event.data === "[DONE]") {
			continue;
		}

		try {
			const payload = JSON.parse(event.data) as Record<string, unknown>;
			const type = typeof payload.type === "string" ? payload.type : event.event;
			if (type === "response.output_text.delta" && typeof payload.delta === "string") {
				sawDelta = true;
				result += payload.delta;
				continue;
			}

			if (type === "response.output_text.done" && typeof payload.text === "string") {
				lastCompletedText = payload.text;
				continue;
			}

			if (type === "response.content_part.done" && isRecord(payload.part) && typeof payload.part.text === "string") {
				lastCompletedText = payload.part.text;
			}
		} catch {
			// Ignore malformed stream chunks and let final empty-result handling report failure.
		}
	}

	return sawDelta ? result : lastCompletedText;
}

function getResponseHeader(headers: Record<string, string> | undefined, key: string): string | undefined {
	if (!headers) {
		return undefined;
	}

	const direct = headers[key];
	if (typeof direct === "string" && direct.trim()) {
		return direct.trim();
	}

	const match = Object.entries(headers).find(([headerKey]) => headerKey.toLowerCase() === key.toLowerCase());
	return match?.[1]?.trim() || undefined;
}

function buildAiCallFailure(
	httpStatus: number,
	message: string,
	isPdf: boolean,
	context: {
		model: string;
		apiBaseUrl: string;
		requestUrl: string;
		wireApi: WireApi;
		headers?: Record<string, string>;
	},
): PipelineError {
	let suggestion: string;
	if (isPdf) {
		suggestion = getPdfSuggestion(message);
	} else if (httpStatus === 401) {
		suggestion = "接口已收到请求，但模型接口密钥无效或未正确传递。请重新保存密钥后再试。";
	} else if (httpStatus === 404 || httpStatus === 405) {
		suggestion = context.wireApi === "responses"
			? `当前接口 ${context.requestUrl} 不可用。请检查模型接口地址是否正确。`
			: `当前接口 ${context.requestUrl} 不可用。请检查是否应填写完整的 /chat/completions 地址，或为模型 ${context.model} 单独配置接口地址。`;
	} else if (httpStatus === 429) {
		suggestion = `当前接口对模型 ${context.model} 限流了。请稍后重试，或切换到其它模型 / 网关。`;
	} else if ([500, 502, 503, 504].includes(httpStatus) || UPSTREAM_FAILURE_PATTERN.test(message)) {
		suggestion = `兼容网关已收到请求，但上游模型调用失败。请检查模型 ${context.model} 是否在该地址可用；如果不同模型需要不同地址，请在设置里为它单独配置接口地址。`;
	} else if (context.wireApi === "responses" && UNSUPPORTED_RESPONSES_PATTERN.test(message)) {
		suggestion = "当前接口不支持该请求格式。请使用支持 chat/completions JSON 输出的模型接口地址。";
	} else {
		suggestion = defaultAiCallSuggestion(isPdf, context.model, context.requestUrl);
	}

	return new PipelineError({
		stage: "ai_call",
		httpStatus,
		errorMessage: message,
		suggestion,
		model: context.model,
		apiBaseUrl: context.apiBaseUrl,
		requestUrl: context.requestUrl,
		requestId: getResponseHeader(context.headers, "x-request-id"),
	});
}

export function extractOutputText(response: OpenAiResponsesApiResponse): string {
	const texts: string[] = [];

	for (const item of response.output ?? []) {
		if (item.type !== "message" || item.role !== "assistant") {
			continue;
		}

		for (const part of item.content ?? []) {
			if (part.type === "output_text" && typeof part.text === "string") {
				texts.push(part.text);
			}
		}
	}

	return texts.join("");
}

function hasRefusal(response: OpenAiResponsesApiResponse): boolean {
	for (const item of response.output ?? []) {
		if (item.type !== "message" || item.role !== "assistant") {
			continue;
		}

		for (const part of item.content ?? []) {
			if (part.type === "refusal") {
				return true;
			}
		}
	}

	return false;
}

function extractChatCompletionText(response: OpenAiChatCompletionsResponse): string {
	const content = response.choices?.[0]?.message?.content;
	if (typeof content === "string") {
		return content;
	}

	if (Array.isArray(content)) {
		return content
			.map((part) => extractUnknownText(part))
			.join("");
	}

	const firstChoice = response.choices?.[0];
	const fromMessage = extractUnknownText(firstChoice?.message);
	if (fromMessage) {
		return fromMessage;
	}

	const fromChoiceText = extractUnknownText(firstChoice?.text);
	if (fromChoiceText) {
		return fromChoiceText;
	}

	return "";
}

function hasChatCompletionRefusal(response: OpenAiChatCompletionsResponse): boolean {
	const message = response.choices?.[0]?.message;
	if (!message) {
		return false;
	}

	if (typeof message.refusal === "string" && message.refusal.trim()) {
		return true;
	}

	if (!Array.isArray(message.content)) {
		return false;
	}

	return message.content.some((part) => part.type === "refusal" || (typeof part.refusal === "string" && part.refusal.trim()));
}

function extractUnknownText(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}

	if (Array.isArray(value)) {
		return value.map((item) => extractUnknownText(item)).join("");
	}

	if (!isRecord(value)) {
		return "";
	}

	for (const key of ["content", "text", "value", "output_text", "reasoning_content", "message", "response"] as const) {
		const extracted = extractUnknownText(value[key]);
		if (extracted) {
			return extracted;
		}
	}

	return "";
}

function normalizeChatCompletionsResponse(response: OpenAiChatCompletionsResponse): OpenAiChatCompletionsResponse {
	let current: unknown = response;
	const seen = new Set<unknown>();

	while (isRecord(current) && !seen.has(current)) {
		seen.add(current);

		if (Array.isArray(current.choices)) {
			return current as OpenAiChatCompletionsResponse;
		}

		const syntheticContent = extractUnknownText(current);
		if (syntheticContent) {
			return {
				choices: [
					{
						message: {
							role: "assistant",
							content: syntheticContent,
						},
					},
				],
				error: isRecord(current.error) ? current.error as OpenAiChatCompletionsResponse["error"] : undefined,
			};
		}

		if (isRecord(current.data)) {
			current = current.data;
			continue;
		}

		if (isRecord(current.result)) {
			current = current.result;
			continue;
		}

		if (isRecord(current.response)) {
			current = current.response;
			continue;
		}

		break;
	}

	return response;
}

export function parseStructuredDigestResponse(response: OpenAiResponsesApiResponse, isPdf: boolean): StructuredDigest {
	if (response.status !== "completed") {
			throw new PipelineError({
				stage: "ai_parse",
				errorMessage: `模型接口响应状态为 ${response.status ?? "unknown"}${response.error?.message ? `：${response.error.message}` : ""}。`,
				suggestion: isPdf ? getPdfSuggestion(response.error?.message ?? "") : "模型返回了未完成状态。请重试，或切换到更稳定支持 JSON 输出的模型。",
			});
		}

	if (hasRefusal(response)) {
			throw new PipelineError({
				stage: "ai_parse",
				errorMessage: "模型接口返回了拒绝消息，而不是结构化输出。",
				suggestion: isPdf ? getPdfSuggestion("") : "模型拒绝了结构化输出请求。请切换模型，或检查接口是否支持当前请求格式。",
			});
		}

	const rawText = extractOutputText(response);
	if (!rawText) {
			throw new PipelineError({
				stage: "ai_parse",
				errorMessage: "模型接口没有返回可解析的 output_text 内容。",
				suggestion: isPdf ? getPdfSuggestion("") : "接口没有返回可解析的文本结果。请重试，或检查该模型是否支持 JSON 输出。",
			});
		}

	return parseStructuredDigestText(rawText, isPdf);
}

function parseStructuredDigestChatCompletionsResponse(
	response: OpenAiChatCompletionsResponse,
	isPdf: boolean,
): StructuredDigest {
	const normalized = normalizeChatCompletionsResponse(response);

	if (hasChatCompletionRefusal(normalized)) {
			throw new PipelineError({
				stage: "ai_parse",
				errorMessage: "模型接口返回了拒绝消息，而不是结构化输出。",
				suggestion: isPdf ? getPdfSuggestion("") : "模型拒绝了结构化输出请求。请切换模型，或检查接口是否支持当前请求格式。",
			});
		}

	const rawText = extractChatCompletionText(normalized);
	if (!rawText) {
			const preview = summarizeResponsePreview(response);
			throw new PipelineError({
				stage: "ai_parse",
				errorMessage: `模型接口没有返回可解析的 assistant message 内容。${summarizeResponseShape(response)}${preview ? ` 预览：${preview}` : ""}`,
				suggestion: isPdf ? getPdfSuggestion("") : "接口没有返回可解析的文本结果。请重试，或检查该模型是否兼容 chat/completions 结构化输出。",
			});
		}

	return parseStructuredDigestText(rawText, isPdf);
}

function enrichPipelineErrorContext(
	error: PipelineError,
	context: {
		model: string;
		apiBaseUrl: string;
		requestUrl: string;
	},
): PipelineError {
	return new PipelineError({
		...error.failureInfo,
		model: error.failureInfo.model ?? context.model,
		apiBaseUrl: error.failureInfo.apiBaseUrl ?? context.apiBaseUrl,
		requestUrl: error.failureInfo.requestUrl ?? context.requestUrl,
	});
}

function isMissingAssistantOutputError(error: unknown): error is PipelineError {
	return error instanceof PipelineError
		&& error.failureInfo.stage === "ai_parse"
		&& /no assistant output_text payload|no assistant message content|没有返回可解析的 output_text|没有返回可解析的 assistant message/iu.test(error.failureInfo.errorMessage);
}

export class AiClient {
	private readonly fetcher: Fetcher;
	private readonly settings: ImportUrlPluginSettings;
	private readonly apiKey: string;

	constructor(fetcher: Fetcher, settings: ImportUrlPluginSettings, apiKey: string) {
		this.fetcher = fetcher;
		this.settings = settings;
		this.apiKey = apiKey;
	}

	private buildSamplingOptions(): Record<string, unknown> {
		// GPT-5.4 docs state temperature/top_p/logprobs require reasoning effort = none.
		// This plugin does not expose reasoning controls, so omit temperature for GPT-5 family models.
		if (isGpt5FamilyModel(this.settings.model)) {
			return {};
		}

		return {
			temperature: 0.2,
		};
	}

	async testConnection(): Promise<{requestUrl: string}> {
		const candidates = getRequestCandidates(this.settings.apiBaseUrl, "test");
		let lastError: unknown = null;

		for (let index = 0; index < candidates.length; index += 1) {
			const candidate = candidates[index]!;

			try {
				await this.runConnectionTest(candidate);
				return {requestUrl: candidate.requestUrl};
			} catch (error) {
				lastError = error;
				const hasMoreCandidates = index < candidates.length - 1;
				if (!hasMoreCandidates || !this.shouldTryAlternateWireApi(error, candidate.wireApi)) {
					throw error;
				}
			}
		}

		if (lastError instanceof Error) {
			throw lastError;
		}

		throw new Error("连接测试失败。");
	}

	async digestWebpage(params: {
		metadata: WebpagePromptMetadata;
		markdown: string;
		warnings: string[];
	}): Promise<StructuredDigest> {
		const candidates = getRequestCandidates(this.settings.apiBaseUrl, "webpage");
		let lastError: unknown = null;

		for (let index = 0; index < candidates.length; index += 1) {
			const candidate = candidates[index]!;

			try {
				return await this.runWebpageRequest(candidate, params);
			} catch (error) {
				lastError = error;
				const hasMoreCandidates = index < candidates.length - 1;
				if (!hasMoreCandidates || !this.shouldTryAlternateWireApi(error, candidate.wireApi)) {
					throw error;
				}
			}
		}

		throw lastError instanceof Error ? lastError : new Error("Webpage digest request failed.");
	}

	async digestPdf(params: {
		sourceUrl: string;
		sourceTitle: string;
		markdown: string;
		warnings: string[];
	}): Promise<StructuredDigest> {
		const candidates = getRequestCandidates(this.settings.apiBaseUrl, "pdf");
		let lastError: unknown = null;

		for (let index = 0; index < candidates.length; index += 1) {
			const candidate = candidates[index]!;

			try {
				const body = this.buildPdfRequestBody(params);
				return await this.runRequest(candidate.requestUrl, body, candidate.wireApi, true);
			} catch (error) {
				lastError = error;
				const hasMoreCandidates = index < candidates.length - 1;
				if (!hasMoreCandidates || !this.shouldTryAlternateWireApi(error, candidate.wireApi)) {
					throw error;
				}
			}
		}

		throw lastError instanceof Error ? lastError : new Error("PDF 内容整理请求失败。");
	}

	private async runConnectionTest(candidate: RequestCandidate): Promise<void> {
		const requestBody = this.buildConnectionTestRequestBody(candidate.wireApi);
		const response = await this.fetcher.postJson(
			candidate.requestUrl,
			requestBody,
			this.buildAuthHeaders(),
		);

		if (response.status >= 400) {
			throw buildAiCallFailure(response.status, getApiErrorMessage(response.text), false, {
				model: this.settings.model,
				apiBaseUrl: this.settings.apiBaseUrl,
				requestUrl: candidate.requestUrl,
				wireApi: candidate.wireApi,
				headers: response.headers,
			});
		}

		try {
			this.parseConnectionTestResponse(response.text, candidate);
		} catch (error) {
			if (!isMissingAssistantOutputError(error)) {
				throw error;
			}

			const streamText = await this.runStreamingRequest(candidate.requestUrl, requestBody, candidate.wireApi, false);
			this.parseConnectionTestPayload(streamText, candidate);
		}
	}

	private parseConnectionTestResponse(responseText: string, candidate: RequestCandidate): void {
		let parsed: OpenAiResponsesApiResponse | OpenAiChatCompletionsResponse;
		try {
			parsed = JSON.parse(responseText) as OpenAiResponsesApiResponse | OpenAiChatCompletionsResponse;
			} catch {
				throw new PipelineError({
					stage: "ai_parse",
					errorMessage: "连接测试收到了非 JSON 响应体。",
					suggestion: defaultAiParseSuggestion(false, this.settings.model, candidate.requestUrl),
				model: this.settings.model,
				apiBaseUrl: this.settings.apiBaseUrl,
				requestUrl: candidate.requestUrl,
			});
		}

		const rawText = candidate.wireApi === "responses"
			? this.extractConnectionTestTextFromResponses(parsed as OpenAiResponsesApiResponse, candidate.requestUrl)
			: this.extractConnectionTestTextFromChatCompletions(parsed as OpenAiChatCompletionsResponse, candidate.requestUrl);
		this.parseConnectionTestPayload(rawText, candidate);
	}

	private parseConnectionTestPayload(rawText: string, candidate: RequestCandidate): void {
		let payload: unknown;

		try {
			payload = JSON.parse(normalizeJsonText(rawText));
			} catch {
				throw new PipelineError({
					stage: "ai_parse",
					errorMessage: "连接测试返回了无效 JSON 内容。",
					suggestion: defaultAiParseSuggestion(false, this.settings.model, candidate.requestUrl),
				model: this.settings.model,
				apiBaseUrl: this.settings.apiBaseUrl,
				requestUrl: candidate.requestUrl,
			});
		}

		const connectionPayload = payload as {ok?: unknown; model?: unknown};
		if (connectionPayload.ok !== true || typeof connectionPayload.model !== "string") {
				throw new PipelineError({
					stage: "ai_parse",
					errorMessage: "连接测试返回的 JSON 缺少预期的 ok/model 字段。",
					suggestion: defaultAiParseSuggestion(false, this.settings.model, candidate.requestUrl),
				model: this.settings.model,
				apiBaseUrl: this.settings.apiBaseUrl,
				requestUrl: candidate.requestUrl,
			});
		}
	}

	private extractConnectionTestTextFromResponses(response: OpenAiResponsesApiResponse, requestUrl: string): string {
			if (response.status !== "completed") {
				throw new PipelineError({
					stage: "ai_parse",
					errorMessage: `连接测试响应状态为 ${response.status ?? "unknown"}${response.error?.message ? `：${response.error.message}` : ""}。`,
					suggestion: defaultAiParseSuggestion(false, this.settings.model, requestUrl),
				model: this.settings.model,
				apiBaseUrl: this.settings.apiBaseUrl,
				requestUrl,
			});
		}

		if (hasRefusal(response)) {
				throw new PipelineError({
					stage: "ai_parse",
					errorMessage: "连接测试被模型拒绝。",
					suggestion: defaultAiParseSuggestion(false, this.settings.model, requestUrl),
				model: this.settings.model,
				apiBaseUrl: this.settings.apiBaseUrl,
				requestUrl,
			});
		}

		const rawText = extractOutputText(response);
		if (!rawText) {
				throw new PipelineError({
					stage: "ai_parse",
					errorMessage: "连接测试没有返回可解析的 output_text 内容。",
					suggestion: defaultAiParseSuggestion(false, this.settings.model, requestUrl),
				model: this.settings.model,
				apiBaseUrl: this.settings.apiBaseUrl,
				requestUrl,
			});
		}

		return rawText;
	}

	private extractConnectionTestTextFromChatCompletions(
		response: OpenAiChatCompletionsResponse,
		requestUrl: string,
	): string {
		if (hasChatCompletionRefusal(response)) {
				throw new PipelineError({
					stage: "ai_parse",
					errorMessage: "连接测试被模型拒绝。",
					suggestion: defaultAiParseSuggestion(false, this.settings.model, requestUrl),
				model: this.settings.model,
				apiBaseUrl: this.settings.apiBaseUrl,
				requestUrl,
			});
		}

		const rawText = extractChatCompletionText(response);
		if (!rawText) {
				throw new PipelineError({
					stage: "ai_parse",
					errorMessage: "连接测试没有返回可解析的 assistant message 内容。",
					suggestion: defaultAiParseSuggestion(false, this.settings.model, requestUrl),
				model: this.settings.model,
				apiBaseUrl: this.settings.apiBaseUrl,
				requestUrl,
			});
		}

		return rawText;
	}

	private async runWebpageRequest(
		candidate: RequestCandidate,
		params: {
			metadata: WebpagePromptMetadata;
			markdown: string;
			warnings: string[];
		},
	): Promise<StructuredDigest> {
		const primaryBody = this.buildWebpageRequestBody(params, false, candidate.wireApi);
		try {
			return await this.runRequest(candidate.requestUrl, primaryBody, candidate.wireApi, false);
		} catch (error) {
			if (!this.shouldRetryWithCompatibilityFallback(error)) {
				throw error;
			}

			const fallbackBody = this.buildWebpageRequestBody(params, true, candidate.wireApi);
			return this.runRequest(candidate.requestUrl, fallbackBody, candidate.wireApi, false);
		}
	}

	private async runRequest(
		requestUrl: string,
		body: unknown,
		wireApi: WireApi,
		isPdf: boolean,
	): Promise<StructuredDigest> {
		let lastError: unknown;

		for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
			try {
				const response = await this.fetcher.postJson(
					requestUrl,
					body,
					this.buildAuthHeaders(),
				);

				if ([429, 500, 502, 503, 504].includes(response.status)) {
					throw buildAiCallFailure(response.status, getApiErrorMessage(response.text), isPdf, {
						model: this.settings.model,
						apiBaseUrl: this.settings.apiBaseUrl,
						requestUrl,
						wireApi,
						headers: response.headers,
					});
				}

				if (response.status >= 400) {
					throw buildAiCallFailure(response.status, getApiErrorMessage(response.text), isPdf, {
						model: this.settings.model,
						apiBaseUrl: this.settings.apiBaseUrl,
						requestUrl,
						wireApi,
						headers: response.headers,
					});
				}

				try {
					const parsedResponse = JSON.parse(response.text) as OpenAiResponsesApiResponse | OpenAiChatCompletionsResponse;
					return wireApi === "responses"
						? parseStructuredDigestResponse(parsedResponse as OpenAiResponsesApiResponse, isPdf)
						: parseStructuredDigestChatCompletionsResponse(parsedResponse as OpenAiChatCompletionsResponse, isPdf);
				} catch (error) {
					if (!isMissingAssistantOutputError(error)) {
						throw error;
					}

					const streamText = await this.runStreamingRequest(requestUrl, body, wireApi, isPdf);
					return parseStructuredDigestText(streamText, isPdf);
				}
			} catch (error) {
				lastError = error instanceof PipelineError
					? enrichPipelineErrorContext(error, {
						model: this.settings.model,
						apiBaseUrl: this.settings.apiBaseUrl,
						requestUrl,
					})
					: error;

				const retryable = error instanceof TimeoutError
					|| (lastError instanceof PipelineError
						&& lastError.failureInfo.stage === "ai_call"
						&& lastError.failureInfo.httpStatus !== undefined
						&& [429, 500, 502, 503, 504].includes(lastError.failureInfo.httpStatus));

				const retryDelay = RETRY_DELAYS_MS[attempt];
				if (!retryable || retryDelay === undefined) {
					break;
				}

				await sleep(retryDelay);
			}
		}

		if (lastError instanceof TimeoutError) {
			throw new PipelineError({
				stage: "ai_call",
				errorMessage: lastError.message,
				suggestion: defaultAiCallSuggestion(isPdf, this.settings.model, requestUrl),
				model: this.settings.model,
				apiBaseUrl: this.settings.apiBaseUrl,
				requestUrl,
			});
		}

		if (lastError instanceof SyntaxError) {
			throw new PipelineError({
				stage: "ai_parse",
				errorMessage: "模型接口返回了非 JSON 响应体。",
				suggestion: defaultAiParseSuggestion(isPdf, this.settings.model, requestUrl),
				model: this.settings.model,
				apiBaseUrl: this.settings.apiBaseUrl,
				requestUrl,
			});
		}

		if (lastError instanceof PipelineError) {
			throw lastError;
		}

		throw new PipelineError({
			stage: "ai_call",
			errorMessage: lastError instanceof Error ? lastError.message : "未知模型接口请求失败。",
			suggestion: defaultAiCallSuggestion(isPdf, this.settings.model, requestUrl),
			model: this.settings.model,
			apiBaseUrl: this.settings.apiBaseUrl,
			requestUrl,
		});
	}

	private async runStreamingRequest(
		requestUrl: string,
		body: unknown,
		wireApi: WireApi,
		isPdf: boolean,
	): Promise<string> {
		const streamBody = isRecord(body)
			? {
				...body,
				stream: true,
			}
			: body;
		const response = await this.fetcher.postJsonStream(
			requestUrl,
			streamBody,
			this.buildAuthHeaders(),
		);

		if (response.status >= 400) {
			throw buildAiCallFailure(response.status, getApiErrorMessage(response.text), isPdf, {
				model: this.settings.model,
				apiBaseUrl: this.settings.apiBaseUrl,
				requestUrl,
				wireApi,
				headers: response.headers,
			});
		}

		const streamText = wireApi === "responses"
			? extractResponsesStreamText(response.text)
			: extractChatCompletionStreamText(response.text);
		if (streamText.trim()) {
			return streamText;
		}

		throw new PipelineError({
			stage: "ai_parse",
			errorMessage: `Streaming fallback returned no text. ${summarizeResponsePreview(response.text)}`,
			suggestion: defaultAiParseSuggestion(isPdf, this.settings.model, requestUrl),
			model: this.settings.model,
			apiBaseUrl: this.settings.apiBaseUrl,
			requestUrl,
		});
	}

	private buildAuthHeaders(): Record<string, string> {
		return {
			Accept: "application/json",
			Authorization: `Bearer ${this.apiKey}`,
		};
	}

	private shouldRetryWithCompatibilityFallback(error: unknown): boolean {
		return error instanceof PipelineError
			&& error.failureInfo.stage === "ai_call"
			&& (
				(error.failureInfo.httpStatus !== undefined && [500, 502, 503, 504].includes(error.failureInfo.httpStatus))
				|| UPSTREAM_FAILURE_PATTERN.test(error.failureInfo.errorMessage)
			);
	}

	private shouldTryAlternateWireApi(error: unknown, wireApi: WireApi): boolean {
		if (wireApi === "chat_completions") {
			return error instanceof PipelineError
				&& error.failureInfo.stage === "ai_call"
				&& error.failureInfo.httpStatus !== undefined
				&& [404, 405, 500, 502, 503, 504].includes(error.failureInfo.httpStatus);
		}

		if (wireApi !== "responses") {
			return false;
		}

		if (!(error instanceof PipelineError)) {
			return error instanceof SyntaxError;
		}

		if (error.failureInfo.stage === "ai_parse") {
			return true;
		}

		if (error.failureInfo.stage !== "ai_call") {
			return false;
		}

		const status = error.failureInfo.httpStatus;
		return (status !== undefined && [400, 404, 405, 415, 422, 500, 501, 502, 503, 504].includes(status))
			|| UNSUPPORTED_RESPONSES_PATTERN.test(error.failureInfo.errorMessage)
			|| UPSTREAM_FAILURE_PATTERN.test(error.failureInfo.errorMessage);
	}

	private buildConnectionTestRequestBody(wireApi: WireApi): Record<string, unknown> {
		if (wireApi === "chat_completions") {
			return {
				model: this.settings.model,
				messages: [
					{
						role: "system",
						content: getConnectionTestJsonInstructions(),
					},
					{
						role: "user",
						content: "Respond with a JSON object like {\"ok\":true,\"model\":\"<model>\"}.",
					},
				],
				response_format: {type: "json_object"},
				...getChatCompletionTokenLimit(80, this.settings.model),
				...this.buildSamplingOptions(),
			};
		}

		const schema = {
			type: "object",
			properties: {
				ok: {type: "boolean"},
				model: {type: "string"},
			},
			required: ["ok", "model"],
			additionalProperties: false,
		};

		return {
			model: this.settings.model,
			instructions: "Return a tiny JSON object for connection verification.",
			input: [
				{
					role: "user",
					content: "Respond with a JSON object like {\"ok\":true,\"model\":\"<model>\"}.",
				},
			],
			text: {
				format: {
					type: "json_schema",
					name: "connection_test",
					schema,
					strict: true,
				},
			},
			truncation: "disabled",
			max_output_tokens: 80,
			store: false,
			...this.buildSamplingOptions(),
		};
	}

	private buildPdfRequestBody(params: {
		sourceUrl: string;
		sourceTitle: string;
		markdown: string;
		warnings: string[];
	}): Record<string, unknown> {
		return {
			model: this.settings.model,
			messages: [
				{
					role: "system",
					content: `${getSystemPrompt(this.settings.defaultLanguage)}\n${getStructuredDigestJsonInstructions()}`,
				},
				{
					role: "user",
					content: getPdfUserPrompt(params.sourceUrl, params.sourceTitle, params.markdown, params.warnings),
				},
			],
			response_format: {type: "json_object"},
			...getChatCompletionTokenLimit(MODEL_MAX_OUTPUT_TOKENS, this.settings.model),
			...this.buildSamplingOptions(),
		};
	}

	private buildWebpageRequestBody(
		params: {
			metadata: WebpagePromptMetadata;
			markdown: string;
			warnings: string[];
		},
		compatibilityFallback: boolean,
		wireApi: WireApi,
	): Record<string, unknown> {
		const warnings = compatibilityFallback
			? uniqueWarnings([
				...params.warnings,
				"为兼容当前模型网关，已在重试时进一步缩短输入并简化请求结构。",
			])
			: params.warnings;
		const markdown = compatibilityFallback
			? truncateForCompatibility(params.markdown, Math.min(this.settings.maxContentTokens, COMPAT_FALLBACK_MAX_CONTENT_TOKENS))
			: params.markdown;
		const prompt = getWebpageUserPrompt(params.metadata, markdown, warnings);

		if (wireApi === "chat_completions") {
			return {
				model: this.settings.model,
				messages: [
					{
						role: "system",
						content: `${getSystemPrompt(this.settings.defaultLanguage)}\n${getStructuredDigestJsonInstructions()}`,
					},
					{
						role: "user",
						content: prompt,
					},
				],
				response_format: {type: "json_object"},
				...getChatCompletionTokenLimit(MODEL_MAX_OUTPUT_TOKENS, this.settings.model),
				...this.buildSamplingOptions(),
			};
		}

		return {
			model: this.settings.model,
			instructions: getSystemPrompt(this.settings.defaultLanguage),
			input: [
				compatibilityFallback
					? {
						role: "user",
						content: [
							{
								type: "input_text",
								text: prompt,
							},
						],
					}
					: {
						role: "user",
						content: prompt,
					},
			],
			text: {
				format: {
					type: "json_schema",
					name: "structured_digest",
					schema: DIGEST_SCHEMA,
					strict: true,
				},
			},
			truncation: "disabled",
			max_output_tokens: MODEL_MAX_OUTPUT_TOKENS,
			store: false,
			...this.buildSamplingOptions(),
			...(compatibilityFallback
				? {}
				: {
					metadata: {
						prompt_version: PROMPT_VERSION,
						source_type: "webpage",
					},
				}),
		};
	}
}
