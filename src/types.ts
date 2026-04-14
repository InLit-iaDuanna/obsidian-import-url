export type SourceType = "webpage" | "pdf";
export type JobStatus = "processing" | "complete" | "failed";
export type FailureStage = "preflight" | "fetch" | "extract" | "ai_call" | "ai_parse" | "save";
export type JobProgressStage = "queued" | "preflight" | "fetching" | "extracting" | "ai_call" | "saving" | "complete" | "failed";

export interface ModelApiBaseUrlRule {
	model: string;
	apiBaseUrl: string;
}

export interface ImportUrlPluginSettings {
	openAiSecretName: string;
	apiBaseUrl: string;
	model: string;
	customModels: string[];
	modelApiBaseUrls: ModelApiBaseUrlRule[];
	configTomlPath: string;
	outputFolder: string;
	processingFolder: string;
	failedFolder: string;
	historyFolder: string;
	defaultLanguage: string;
	fetchTimeoutMs: number;
	aiTimeoutMs: number;
	maxContentTokens: number;
	siteJsonFallbackEnabled: boolean;
	readerFallbackEnabled: boolean;
	browserRenderFallbackEnabled: boolean;
	openNoteAfterCreate: boolean;
	recentImports: ImportHistoryEntry[];
}

export interface ModelOption {
	id: string;
	label: string;
	description: string;
}

export interface ImportHistoryEntry {
	id: string;
	url: string;
	host: string;
	apiBaseUrl: string;
	model: string;
	submittedAt: string;
	status: JobStatus;
	progressStage: JobProgressStage;
	progressPercent: number;
	progressMessage: string;
	progressUpdatedAt: string;
	title?: string;
	notePath?: string;
	historyNotePath?: string;
	sourceType?: SourceType;
	errorMessage?: string;
}

export interface StructuredDigest {
	title: string;
	summary: string;
	keyPoints: string[];
	keyFacts: string[];
	actionItems: string[];
	fullOrganizedMarkdown: string;
	suggestedTags: string[];
	warnings: string[];
}

export interface FailureInfo {
	stage: FailureStage;
	errorMessage: string;
	httpStatus?: number;
	suggestion: string;
	model?: string;
	apiBaseUrl?: string;
	requestUrl?: string;
	requestId?: string;
}

export interface HeadProbeResult {
	status: number;
	headers: Record<string, string>;
	contentType?: string;
	contentLength?: number;
}

export interface ValidatedUrl {
	url: string;
	host: string;
	sourceType: SourceType;
	head?: HeadProbeResult;
}

export interface WebpageExtractionResult {
	title: string;
	byline: string;
	excerpt: string;
	markdown: string;
	warnings: string[];
}

export interface WebpagePromptMetadata {
	sourceUrl: string;
	sourceTitle: string;
	byline: string;
	excerpt: string;
}

export interface OpenAiResponsesOutputContent {
	type?: string;
	text?: string;
	[key: string]: unknown;
}

export interface OpenAiResponsesOutputItem {
	type?: string;
	role?: string;
	content?: OpenAiResponsesOutputContent[];
	[key: string]: unknown;
}

export interface OpenAiResponsesApiResponse {
	status?: string;
	output?: OpenAiResponsesOutputItem[];
	error?: {
		message?: string;
		type?: string;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

export interface JobRunOptions {
	rawUrl: string;
	model?: string;
	apiBaseUrl?: string;
	historyId?: string;
}

export interface JobRunResult {
	status: "complete" | "failed";
	url: string;
	model: string;
	title: string;
	notePath: string;
	sourceType: SourceType;
	failure?: FailureInfo;
}

export interface JobProgressEvent {
	historyId?: string;
	url: string;
	model: string;
	stage: JobProgressStage;
	progressPercent: number;
	message: string;
	sourceType?: SourceType;
	title?: string;
}

export class UserInputError extends Error {}

export class PipelineError extends Error {
	readonly failureInfo: FailureInfo;

	constructor(failureInfo: FailureInfo) {
		super(failureInfo.errorMessage);
		this.name = "PipelineError";
		this.failureInfo = failureInfo;
	}
}

export const OPENAI_MAX_OUTPUT_TOKENS = 6000;
export const PDF_PREFLIGHT_MAX_BYTES = 50 * 1024 * 1024;
