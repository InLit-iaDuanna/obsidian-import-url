import {describe, expect, it, vi} from "vitest";
import {
	AiClient,
	DEFAULT_API_BASE_URL,
	DIGEST_SCHEMA,
	STRUCTURED_DIGEST_REQUIRED_FIELDS,
	buildChatCompletionsApiUrl,
	buildResponsesApiUrl,
	extractOutputText,
	parseStructuredDigestResponse,
} from "../src/pipeline/ai-client";
import {Fetcher} from "../src/pipeline/fetcher";
import {DEFAULT_SETTINGS} from "../src/settings";
import {createResponse} from "./helpers";

const sampleDigest = {
	title: "示例标题",
	summary: "一句话总结",
	keyPoints: ["要点 1"],
	keyFacts: ["事实 1"],
	actionItems: ["行动 1"],
	fullOrganizedMarkdown: "# 正文",
	suggestedTags: ["tag-a"],
	warnings: [],
};

function createCompletedBody(payload: unknown): string {
	return JSON.stringify({
		status: "completed",
		output: [
			{
				type: "message",
				role: "assistant",
				content: [
					{
						type: "output_text",
						text: JSON.stringify(payload),
					},
				],
			},
		],
	});
}

function createChatCompletionBody(payload: unknown): string {
	return JSON.stringify({
		choices: [
			{
				message: {
					role: "assistant",
					content: JSON.stringify(payload),
				},
			},
		],
	});
}

function createChatCompletionEmptyBody(): string {
	return JSON.stringify({
		id: "resp_test",
		object: "chat.completion",
		choices: [
			{
				index: 0,
				message: {
					role: "assistant",
				},
				finish_reason: "stop",
			},
		],
	});
}

function createChatCompletionStreamBody(text: string): string {
	return [
		`data: ${JSON.stringify({
			id: "resp_test",
			object: "chat.completion.chunk",
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
					},
					finish_reason: null,
				},
			],
		})}`,
		"",
		`data: ${JSON.stringify({
			id: "resp_test",
			object: "chat.completion.chunk",
			choices: [
				{
					index: 0,
					delta: {
						content: text,
					},
					finish_reason: null,
				},
			],
		})}`,
		"",
		"data: [DONE]",
		"",
	].join("\n");
}

type PostJsonFn = Fetcher["postJson"];
type PostJsonStreamFn = Fetcher["postJsonStream"];
type PostJsonMock = ReturnType<typeof vi.fn<PostJsonFn>>;
type PostJsonStreamMock = ReturnType<typeof vi.fn<PostJsonStreamFn>>;

function createPostJsonMock(): PostJsonMock {
	return vi.fn<PostJsonFn>();
}

function createPostJsonStreamMock(): PostJsonStreamMock {
	return vi.fn<PostJsonStreamFn>();
}

function createFetcherMock(input: {
	postJson: PostJsonMock;
	postJsonStream?: PostJsonStreamMock;
}): Fetcher {
	return {
		postJson: input.postJson,
		postJsonStream: input.postJsonStream ?? createPostJsonStreamMock(),
	} as unknown as Fetcher;
}

describe("ai-client", () => {
	it("keeps schema keys aligned with required digest fields", () => {
		expect(DIGEST_SCHEMA.required).toEqual([...STRUCTURED_DIGEST_REQUIRED_FIELDS]);
		expect(Object.keys(DIGEST_SCHEMA.properties).sort()).toEqual([...STRUCTURED_DIGEST_REQUIRED_FIELDS].sort());
	});

	it("extracts assistant output_text from response.output", () => {
		const text = extractOutputText({
			status: "completed",
			output: [
				{
					type: "message",
					role: "assistant",
					content: [
						{type: "output_text", text: "{\"a\":1}"},
						{type: "output_text", text: "{\"b\":2}"},
					],
				},
			],
		});

		expect(text).toBe("{\"a\":1}{\"b\":2}");
	});

	it("fails when response.status is not completed", () => {
		expect(() => parseStructuredDigestResponse({
			status: "incomplete",
			error: {message: "cut off"},
		}, false)).toThrowError(/incomplete/);
	});

	it("builds PDF requests with input_file file_url", async () => {
		const postJson = createPostJsonMock().mockResolvedValue(createResponse(200, createCompletedBody(sampleDigest)));
		const client = new AiClient(createFetcherMock({postJson}), DEFAULT_SETTINGS, "sk-test");

		await client.digestPdf({
			sourceUrl: "https://example.com/file.pdf",
			sourceTitle: "Paper",
		});

		const firstCall = postJson.mock.calls[0];
		expect(firstCall).toBeDefined();
		const body = firstCall?.[1] as {
			input: Array<{content: Array<{type: string; file_url: string}>}>;
			store?: boolean;
		};
		expect(body.input[0]?.content[0]).toEqual({
			type: "input_file",
			file_url: "https://example.com/file.pdf",
		});
		expect(body.store).toBe(false);
	});

	it("retries 429 and 500 responses with fixed backoff", async () => {
		vi.useFakeTimers();
		const postJson = createPostJsonMock()
			.mockResolvedValueOnce(createResponse(429, JSON.stringify({error: {message: "busy"}})))
			.mockResolvedValueOnce(createResponse(500, JSON.stringify({error: {message: "server error"}})))
			.mockResolvedValueOnce(createResponse(200, createCompletedBody(sampleDigest)));

		const client = new AiClient(createFetcherMock({postJson}), DEFAULT_SETTINGS, "sk-test");
		const promise = client.digestWebpage({
			metadata: {
				sourceUrl: "https://example.com/post",
				sourceTitle: "Post",
				byline: "",
				excerpt: "",
			},
			markdown: "body",
			warnings: [],
		});

		await vi.runAllTimersAsync();
		await expect(promise).resolves.toEqual(sampleDigest);
		expect(postJson).toHaveBeenCalledTimes(3);
	});

	it("builds the responses API URL from custom or default base URLs", () => {
		expect(buildResponsesApiUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/responses");
		expect(buildResponsesApiUrl("https://openrouter.ai/api/v1/")).toBe("https://openrouter.ai/api/v1/responses");
		expect(buildResponsesApiUrl("https://example.com/custom/responses")).toBe("https://example.com/custom/responses");
		expect(buildResponsesApiUrl("https://example.com/custom/chat/completions")).toBe("https://example.com/custom/responses");
		expect(buildChatCompletionsApiUrl("https://example.com/custom/responses")).toBe("https://example.com/custom/chat/completions");
		expect(buildResponsesApiUrl("")).toBe(`${DEFAULT_API_BASE_URL}/responses`);
	});

	it("falls back to chat completions in connection tests when responses is unsupported", async () => {
		const postJson = createPostJsonMock()
			.mockResolvedValueOnce(createResponse(404, JSON.stringify({error: {message: "responses not supported"}})))
			.mockResolvedValueOnce(createResponse(200, createChatCompletionBody({
				ok: true,
				model: "gpt-4o",
			})));
		const client = new AiClient(createFetcherMock({postJson}), DEFAULT_SETTINGS, "sk-test");

		await expect(client.testConnection()).resolves.toEqual({
			requestUrl: "https://api.openai.com/v1/chat/completions",
		});
		expect(postJson).toHaveBeenCalledTimes(2);
		expect(postJson.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses");
		expect(postJson.mock.calls[1]?.[0]).toBe("https://api.openai.com/v1/chat/completions");
	});

	it("maps PDF download failures to the fixed suggestion", async () => {
		const postJson = createPostJsonMock().mockResolvedValue(
			createResponse(400, JSON.stringify({error: {message: "could not download file (403)"}})),
		);
		const client = new AiClient(createFetcherMock({postJson}), DEFAULT_SETTINGS, "sk-test");

		await expect(client.digestPdf({
			sourceUrl: "https://example.com/private.pdf",
			sourceTitle: "Private PDF",
		})).rejects.toMatchObject({
			failureInfo: {
				suggestion: "OpenAI 无法直接下载此 PDF。请确认该链接在浏览器中无需登录即可直接下载，且不受地域限制、临时签名或反爬策略影响。",
			},
		});
	});

	it("uses the configured custom responses URL", async () => {
		const postJson = createPostJsonMock().mockResolvedValue(createResponse(200, createCompletedBody(sampleDigest)));
		const client = new AiClient(createFetcherMock({postJson}), {
			...DEFAULT_SETTINGS,
			apiBaseUrl: "https://openrouter.ai/api/v1",
		}, "sk-test");

		await client.digestWebpage({
			metadata: {
				sourceUrl: "https://example.com/post",
				sourceTitle: "Post",
				byline: "",
				excerpt: "",
			},
			markdown: "body",
			warnings: [],
		});

		expect(postJson.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/responses");
	});

	it("falls back to chat completions for webpage digests when responses is unsupported", async () => {
		const postJson = createPostJsonMock()
			.mockResolvedValueOnce(createResponse(404, JSON.stringify({error: {message: "responses not supported"}})))
			.mockResolvedValueOnce(createResponse(200, createChatCompletionBody(sampleDigest)));
		const client = new AiClient(createFetcherMock({postJson}), DEFAULT_SETTINGS, "sk-test");

		await expect(client.digestWebpage({
			metadata: {
				sourceUrl: "https://example.com/post",
				sourceTitle: "Post",
				byline: "",
				excerpt: "",
			},
			markdown: "body",
			warnings: [],
		})).resolves.toEqual(sampleDigest);

		expect(postJson).toHaveBeenCalledTimes(2);
		expect(postJson.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses");
		expect(postJson.mock.calls[1]?.[0]).toBe("https://api.openai.com/v1/chat/completions");
	});

	it("uses streaming fallback when chat completions omit assistant content", async () => {
		let postCount = 0;
		const postJsonStream = createPostJsonStreamMock().mockImplementation(async () => createResponse(
			200,
			createChatCompletionStreamBody(JSON.stringify(sampleDigest)),
		));
		const postJson = createPostJsonMock().mockImplementation(async () => {
			postCount += 1;
			return postCount === 1
				? createResponse(404, JSON.stringify({error: {message: "responses not supported"}}))
				: createResponse(200, createChatCompletionEmptyBody());
		});
		const client = new AiClient(createFetcherMock({
			postJson,
			postJsonStream,
		}), {
			...DEFAULT_SETTINGS,
			apiBaseUrl: "https://api.example.com",
		}, "sk-test");

		await expect(client.digestWebpage({
			metadata: {
				sourceUrl: "https://example.com/post",
				sourceTitle: "Post",
				byline: "",
				excerpt: "",
			},
			markdown: "body",
			warnings: [],
		})).resolves.toEqual(sampleDigest);

		expect(postJsonStream).toHaveBeenCalledTimes(1);
		expect(postJsonStream.mock.calls[0]?.[0]).toBe("https://api.example.com/v1/chat/completions");
	});

	it("parses chat completions wrapped inside a data envelope", async () => {
		const postJson = createPostJsonMock()
			.mockResolvedValueOnce(createResponse(404, JSON.stringify({error: {message: "responses not supported"}})))
			.mockResolvedValueOnce(createResponse(200, JSON.stringify({
				code: 0,
				data: {
					choices: [
						{
							message: {
								role: "assistant",
								content: JSON.stringify(sampleDigest),
							},
						},
					],
				},
			})));
		const client = new AiClient(createFetcherMock({postJson}), DEFAULT_SETTINGS, "sk-test");

		await expect(client.digestWebpage({
			metadata: {
				sourceUrl: "https://example.com/post",
				sourceTitle: "Post",
				byline: "",
				excerpt: "",
			},
			markdown: "body",
			warnings: [],
		})).resolves.toEqual(sampleDigest);
	});

	it("falls back to reasoning content when compatible chat responses omit content", async () => {
		const postJson = createPostJsonMock()
			.mockResolvedValueOnce(createResponse(404, JSON.stringify({error: {message: "responses not supported"}})))
			.mockResolvedValueOnce(createResponse(200, JSON.stringify({
				choices: [
					{
						message: {
							role: "assistant",
							content: null,
							reasoning_content: JSON.stringify(sampleDigest),
						},
					},
				],
			})));
		const client = new AiClient(createFetcherMock({postJson}), DEFAULT_SETTINGS, "sk-test");

		await expect(client.digestWebpage({
			metadata: {
				sourceUrl: "https://example.com/post",
				sourceTitle: "Post",
				byline: "",
				excerpt: "",
			},
			markdown: "body",
			warnings: [],
		})).resolves.toEqual(sampleDigest);
	});

	it("tries /v1 chat completions for bare compatible base URLs", async () => {
		const postJson = createPostJsonMock()
			.mockResolvedValueOnce(createResponse(404, JSON.stringify({error: {message: "responses not supported"}})))
			.mockResolvedValueOnce(createResponse(200, createChatCompletionBody(sampleDigest)));
		const client = new AiClient(createFetcherMock({postJson}), {
			...DEFAULT_SETTINGS,
			apiBaseUrl: "https://api.example.com",
		}, "sk-test");

		await expect(client.digestWebpage({
			metadata: {
				sourceUrl: "https://example.com/post",
				sourceTitle: "Post",
				byline: "",
				excerpt: "",
			},
			markdown: "body",
			warnings: [],
		})).resolves.toEqual(sampleDigest);

		expect(postJson.mock.calls[0]?.[0]).toBe("https://api.example.com/responses");
		expect(postJson.mock.calls[1]?.[0]).toBe("https://api.example.com/v1/chat/completions");
		const fallbackBody = postJson.mock.calls[1]?.[1] as Record<string, unknown>;
		expect(fallbackBody.response_format).toBeUndefined();
	});

	it("omits temperature for gpt-5 family requests", async () => {
		const postJson = createPostJsonMock().mockResolvedValue(createResponse(200, createCompletedBody(sampleDigest)));
		const client = new AiClient(createFetcherMock({postJson}), {
			...DEFAULT_SETTINGS,
			model: "gpt-5.4",
		}, "sk-test");

		await client.digestWebpage({
			metadata: {
				sourceUrl: "https://example.com/post",
				sourceTitle: "Post",
				byline: "",
				excerpt: "",
			},
			markdown: "body",
			warnings: [],
		});

		const body = postJson.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(body.temperature).toBeUndefined();
	});

	it("adds actionable suggestion for upstream 502 failures", async () => {
		vi.useFakeTimers();
		const postJson = createPostJsonMock().mockResolvedValue(
			createResponse(502, JSON.stringify({error: {message: "Upstream request failed"}})),
		);
		const client = new AiClient(createFetcherMock({postJson}), {
			...DEFAULT_SETTINGS,
			model: "gpt-5.4",
			apiBaseUrl: "https://api.example.com",
		}, "sk-test");

		const promise = client.digestWebpage({
			metadata: {
				sourceUrl: "https://example.com/post",
				sourceTitle: "Post",
				byline: "",
				excerpt: "",
			},
			markdown: "body",
			warnings: [],
		});

		const assertion = expect(promise).rejects.toMatchObject({
			failureInfo: {
				stage: "ai_call",
				httpStatus: 502,
				model: "gpt-5.4",
				apiBaseUrl: "https://api.example.com",
				requestUrl: "https://api.example.com/v1/chat/completions",
			},
		});
		await vi.runAllTimersAsync();
		await assertion;
		await promise.catch((error: unknown) => {
			const suggestion = (error as {failureInfo?: {suggestion?: string}}).failureInfo?.suggestion ?? "";
			expect(suggestion).toContain("不同模型需要不同地址");
		});
	});

	it("captures request id from upstream error headers", async () => {
		const postJson = createPostJsonMock().mockResolvedValue(
			createResponse(401, JSON.stringify({error: {message: "bad key"}}), {
				"x-request-id": "req_123",
			}),
		);
		const client = new AiClient(createFetcherMock({postJson}), DEFAULT_SETTINGS, "sk-test");

		await expect(client.digestWebpage({
			metadata: {
				sourceUrl: "https://example.com/post",
				sourceTitle: "Post",
				byline: "",
				excerpt: "",
			},
			markdown: "body",
			warnings: [],
		})).rejects.toMatchObject({
			failureInfo: {
				requestId: "req_123",
			},
		});
	});

	it("includes request context in ai_parse failures", async () => {
		const postJson = createPostJsonMock()
			.mockResolvedValueOnce(createResponse(200, JSON.stringify({
				unexpected: {
					shape: true,
				},
			})));
		const postJsonStream = createPostJsonStreamMock().mockImplementation(async () => (
			createResponse(200, "data: [DONE]\n\n")
		));
		const client = new AiClient(createFetcherMock({postJson, postJsonStream}), {
			...DEFAULT_SETTINGS,
			apiBaseUrl: "https://api.example.com/v1/chat/completions",
		}, "sk-test");

		await expect(client.digestWebpage({
			metadata: {
				sourceUrl: "https://example.com/post",
				sourceTitle: "Post",
				byline: "",
				excerpt: "",
			},
			markdown: "body",
			warnings: [],
		})).rejects.toMatchObject({
			failureInfo: {
				stage: "ai_parse",
				apiBaseUrl: "https://api.example.com/v1/chat/completions",
				requestUrl: "https://api.example.com/v1/chat/completions",
			},
		});
	});

	it("retries webpage requests with a compatibility fallback after upstream 502 failures", async () => {
		vi.useFakeTimers();
		const postJson = createPostJsonMock()
			.mockResolvedValueOnce(createResponse(502, JSON.stringify({error: {message: "Upstream request failed"}})))
			.mockResolvedValueOnce(createResponse(502, JSON.stringify({error: {message: "Upstream request failed"}})))
			.mockResolvedValueOnce(createResponse(502, JSON.stringify({error: {message: "Upstream request failed"}})))
			.mockResolvedValueOnce(createResponse(200, createCompletedBody(sampleDigest)));
		const client = new AiClient(createFetcherMock({postJson}), DEFAULT_SETTINGS, "sk-test");

		const promise = client.digestWebpage({
			metadata: {
				sourceUrl: "https://example.com/post",
				sourceTitle: "Post",
				byline: "Byline",
				excerpt: "Excerpt",
			},
			markdown: "A".repeat(70000),
			warnings: [],
		});

		await vi.runAllTimersAsync();
		await expect(promise).resolves.toEqual(sampleDigest);
		expect(postJson).toHaveBeenCalledTimes(4);

		const firstBody = postJson.mock.calls[0]?.[1] as {
			metadata?: Record<string, unknown>;
			input: Array<{content: string}>;
		};
		const fallbackBody = postJson.mock.calls[3]?.[1] as {
			metadata?: Record<string, unknown>;
			input: Array<{content: Array<{type: string; text: string}>}>;
		};
		expect(firstBody.metadata).toEqual({
			prompt_version: "2",
			source_type: "webpage",
		});
		expect(typeof firstBody.input[0]?.content).toBe("string");
		expect(fallbackBody.metadata).toBeUndefined();
		expect(Array.isArray(fallbackBody.input[0]?.content)).toBe(true);
		expect(fallbackBody.input[0]?.content[0]).toMatchObject({
			type: "input_text",
		});
		const firstContent = firstBody.input[0]?.content ?? "";
		const fallbackText = fallbackBody.input[0]?.content[0]?.text ?? "";
		expect(fallbackText.length).toBeLessThan(firstContent.length);
		expect(fallbackText).toContain("为兼容当前 API 网关");
	});
});
