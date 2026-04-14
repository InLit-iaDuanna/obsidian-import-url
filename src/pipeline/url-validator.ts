import {PDF_PREFLIGHT_MAX_BYTES, PipelineError, SourceType, ValidatedUrl} from "../types";
import {Fetcher} from "./fetcher";
import {UserInputError} from "../types";

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		normalized[key.toLowerCase()] = value;
	}
	return normalized;
}

function parseContentLength(value?: string): number | undefined {
	if (!value) {
		return undefined;
	}

	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseHttpUrl(rawUrl: string): URL {
	const trimmed = rawUrl.trim();
	if (!trimmed) {
		throw new UserInputError("请输入合法的 http(s) URL。");
	}

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new UserInputError("请输入合法的 http(s) URL。");
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new UserInputError("仅支持 http 或 https URL。");
	}

	return url;
}

export function isPdfCandidate(url: URL): boolean {
	return url.pathname.toLowerCase().endsWith(".pdf");
}

export async function validateUrl(url: URL, fetcher: Fetcher): Promise<ValidatedUrl> {
	const explicitPdf = isPdfCandidate(url);
	let headResult: ValidatedUrl["head"];

	try {
		const response = await fetcher.headUrl(url.toString());
		const headers = normalizeHeaders(response.headers);
		headResult = {
			status: response.status,
			headers,
			contentType: headers["content-type"]?.toLowerCase(),
			contentLength: parseContentLength(headers["content-length"]),
		};
	} catch {
		headResult = undefined;
	}

	const headSaysPdf = headResult?.contentType?.includes("application/pdf") ?? false;
	const sourceType: SourceType = headSaysPdf || explicitPdf ? "pdf" : "webpage";

	if (sourceType === "pdf" && headResult?.contentLength && headResult.contentLength > PDF_PREFLIGHT_MAX_BYTES) {
		throw new PipelineError({
			stage: "preflight",
			errorMessage: `PDF exceeds preflight size limit (${PDF_PREFLIGHT_MAX_BYTES} bytes).`,
			httpStatus: headResult.status,
			suggestion: "该 PDF 超过 50 MB 预检上限，请改用更小的公开直达 PDF 链接。",
		});
	}

	return {
		url: url.toString(),
		host: url.host || "source",
		sourceType,
		head: headResult,
	};
}
