import {describe, expect, it, vi} from "vitest";
import {PDF_PREFLIGHT_MAX_BYTES, PipelineError, UserInputError} from "../src/types";
import {parseHttpUrl, validateUrl} from "../src/pipeline/url-validator";
import {createResponse} from "./helpers";

describe("url-validator", () => {
	it("rejects invalid URLs before creating notes", () => {
		expect(() => parseHttpUrl("not-a-url")).toThrow(UserInputError);
		expect(() => parseHttpUrl("file:///tmp/foo")).toThrow(UserInputError);
	});

	it("detects PDFs from HEAD content-type", async () => {
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {
				"Content-Type": "application/pdf",
				"Content-Length": "1024",
			})),
		} as any;

		const result = await validateUrl(new URL("https://example.com/download?id=1"), fetcher);
		expect(result.sourceType).toBe("pdf");
	});

	it("keeps .pdf URLs as PDF when HEAD fails", async () => {
		const fetcher = {
			headUrl: vi.fn().mockRejectedValue(new Error("405")),
		} as any;

		const result = await validateUrl(new URL("https://example.com/file.pdf"), fetcher);
		expect(result.sourceType).toBe("pdf");
	});

	it("rejects over-large PDFs during preflight", async () => {
		const fetcher = {
			headUrl: vi.fn().mockResolvedValue(createResponse(200, "", {
				"Content-Type": "application/pdf",
				"Content-Length": String(PDF_PREFLIGHT_MAX_BYTES + 1),
			})),
		} as any;

		await expect(validateUrl(new URL("https://example.com/huge.pdf"), fetcher)).rejects.toMatchObject({
			failureInfo: {
				stage: "preflight",
			},
		});
	});
});
