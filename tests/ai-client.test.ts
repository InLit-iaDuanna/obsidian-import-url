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
	concepts: [
		{
			title: "示例概念",
			aliases: ["概念别名"],
			summary: "概念摘要",
			evidence: ["来源证据"],
			relatedConcepts: ["相关概念"],
			confidence: 0.82,
		},
	],
	suggestedTags: ["tag-a"],
	warnings: [],
};

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

	it("builds PDF requests from locally extracted text", async () => {
		const postJson = createPostJsonMock().mockResolvedValue(createResponse(200, createChatCompletionBody(sampleDigest)));
		const client = new AiClient(createFetcherMock({postJson}), DEFAULT_SETTINGS, "sk-test");

		await client.digestPdf({
			sourceUrl: "https://example.com/file.pdf",
			sourceTitle: "Paper",
			markdown: "PDF text",
			warnings: [],
		});

		const firstCall = postJson.mock.calls[0];
		expect(firstCall).toBeDefined();
		const body = firstCall?.[1] as {
			messages: Array<{role: string; content: string}>;
			response_format?: {type: string};
		};
		expect(body.messages[1]?.content).toContain("PDF text");
		expect(body.response_format).toEqual({type: "json_object"});
	});

	it("retries 429 and 500 responses with fixed backoff", async () => {
		vi.useFakeTimers();
		const postJson = createPostJsonMock()
			.mockResolvedValueOnce(createResponse(429, JSON.stringify({error: {message: "busy"}})))
			.mockResolvedValueOnce(createResponse(500, JSON.stringify({error: {message: "server error"}})))
			.mockResolvedValueOnce(createResponse(200, createChatCompletionBody(sampleDigest)));

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

	it("builds model API URLs from custom or default base URLs", () => {
		expect(buildResponsesApiUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/responses");
		expect(buildResponsesApiUrl("https://openrouter.ai/api/v1/")).toBe("https://openrouter.ai/api/v1/responses");
		expect(buildResponsesApiUrl("https://example.com/custom/responses")).toBe("https://example.com/custom/responses");
		expect(buildResponsesApiUrl("https://example.com/custom/chat/completions")).toBe("https://example.com/custom/responses");
		expect(buildChatCompletionsApiUrl("https://example.com/custom/responses")).toBe("https://example.com/custom/chat/completions");
		expect(buildResponsesApiUrl("")).toBe(`${DEFAULT_API_BASE_URL}/responses`);
	});

	it("uses chat JSON for connection tests", async () => {
		const postJson = createPostJsonMock()
			.mockResolvedValueOnce(createResponse(200, createChatCompletionBody({
				ok: true,
				model: "deepseek-v4-pro",
			})));
		const client = new AiClient(createFetcherMock({postJson}), {
			...DEFAULT_SETTINGS,
			model: "deepseek-v4-pro",
		}, "sk-test");

		await expect(client.testConnection()).resolves.toEqual({
			requestUrl: "https://api.deepseek.com/chat/completions",
		});
		expect(postJson).toHaveBeenCalledTimes(1);
		const body = postJson.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(body.response_format).toEqual({type: "json_object"});
	});

	it("maps PDF text failures to the fixed suggestion", async () => {
		const postJson = createPostJsonMock().mockResolvedValue(
			createResponse(400, JSON.stringify({error: {message: "could not download file (403)"}})),
		);
		const client = new AiClient(createFetcherMock({postJson}), DEFAULT_SETTINGS, "sk-test");

		await expect(client.digestPdf({
			sourceUrl: "https://example.com/private.pdf",
			sourceTitle: "Private PDF",
			markdown: "PDF text",
			warnings: [],
		})).rejects.toMatchObject({
			failureInfo: {
				suggestion: "PDF 内容无法提取。请确认该链接在浏览器中无需登录即可直接下载，且不受地域限制、临时签名或反爬策略影响。",
			},
		});
	});

	it("uses the configured custom chat URL", async () => {
		const postJson = createPostJsonMock().mockResolvedValue(createResponse(200, createChatCompletionBody(sampleDigest)));
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

		expect(postJson.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/chat/completions");
	});

	it("uses chat completions for webpage digests", async () => {
		const postJson = createPostJsonMock()
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

		expect(postJson).toHaveBeenCalledTimes(1);
		expect(postJson.mock.calls[0]?.[0]).toBe("https://api.deepseek.com/chat/completions");
		const body = postJson.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(body.response_format).toEqual({type: "json_object"});
	});

	it("uses streaming fallback when chat completions omit assistant content", async () => {
		const postJsonStream = createPostJsonStreamMock().mockImplementation(async () => createResponse(
			200,
			createChatCompletionStreamBody(JSON.stringify(sampleDigest)),
		));
		const postJson = createPostJsonMock().mockResolvedValue(createResponse(200, createChatCompletionEmptyBody()));
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
		expect(postJsonStream.mock.calls[0]?.[0]).toBe("https://api.example.com/chat/completions");
	});

	it("parses chat completions wrapped inside a data envelope", async () => {
		const postJson = createPostJsonMock()
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

	it("tries the bare chat completions path before /v1 for bare base URLs", async () => {
		const postJson = createPostJsonMock()
			.mockResolvedValueOnce(createResponse(404, JSON.stringify({error: {message: "chat path unavailable"}})))
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

		expect(postJson.mock.calls[0]?.[0]).toBe("https://api.example.com/chat/completions");
		expect(postJson.mock.calls[1]?.[0]).toBe("https://api.example.com/v1/chat/completions");
		const fallbackBody = postJson.mock.calls[1]?.[1] as Record<string, unknown>;
		expect(fallbackBody.response_format).toEqual({type: "json_object"});
	});

	it("includes deterministic sampling for DeepSeek requests", async () => {
		const postJson = createPostJsonMock().mockResolvedValue(createResponse(200, createChatCompletionBody(sampleDigest)));
		const client = new AiClient(createFetcherMock({postJson}), {
			...DEFAULT_SETTINGS,
			model: "deepseek-v4-pro",
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
		expect(body.temperature).toBe(0.2);
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
				suggestion: "兼容网关已收到请求，但上游模型调用失败。请检查模型 gpt-5.4 是否在该地址可用；如果不同模型需要不同地址，请在设置里为它单独配置接口地址。",
			},
		});
		await vi.runAllTimersAsync();
		await assertion;
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
			.mockResolvedValueOnce(createResponse(200, createChatCompletionBody(sampleDigest)));
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
			messages: Array<{content: string}>;
		};
		const fallbackBody = postJson.mock.calls[3]?.[1] as {
			metadata?: Record<string, unknown>;
			messages: Array<{content: string}>;
		};
		expect(firstBody.metadata).toBeUndefined();
		expect(typeof firstBody.messages[1]?.content).toBe("string");
		expect(fallbackBody.metadata).toBeUndefined();
		const firstContent = firstBody.messages[1]?.content ?? "";
		const fallbackText = fallbackBody.messages[1]?.content ?? "";
		expect(fallbackText.length).toBeLessThan(firstContent.length);
		expect(fallbackText).toContain("为兼容当前模型网关");
	});
});
