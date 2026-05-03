import {describe, expect, it, vi} from "vitest";
import {BaiduImageOcrClient} from "../src/pipeline/image-ocr";
import {Fetcher} from "../src/pipeline/fetcher";
import {DEFAULT_SETTINGS} from "../src/settings";
import {createResponse} from "./helpers";

describe("image OCR clients", () => {
	it("calls Baidu access-token and OCR endpoints with base64 image data", async () => {
		const postJson = vi.fn<Fetcher["postJson"]>().mockResolvedValue(createResponse(200, JSON.stringify({
			access_token: "token-123",
		})));
		const postForm = vi.fn<Fetcher["postForm"]>().mockResolvedValue(createResponse(200, JSON.stringify({
			words_result: [
				{words: "第一行文字"},
				{words: "第二行文字"},
			],
		})));
		const fetcher = {
			postJson,
			postForm,
		} as unknown as Fetcher;
		const client = new BaiduImageOcrClient(fetcher, {
			...DEFAULT_SETTINGS,
			imageOcrProvider: "baidu",
			imageOcrApiBaseUrl: "https://aip.baidubce.com",
		}, "baidu-api-key", "baidu-secret-key");

		await expect(client.ocrImage({
			imageDataUrl: "data:image/png;base64,aGVsbG8=",
			image: {
				index: 1,
				url: "https://example.com/image.png",
				alt: "示例图",
				title: "",
				caption: "",
			},
			sourceUrl: "https://example.com/article",
			sourceTitle: "文章",
		})).resolves.toEqual({
			text: "第一行文字\n第二行文字",
		});

		expect(postJson).toHaveBeenCalledWith(
			"https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=baidu-api-key&client_secret=baidu-secret-key",
			{},
			{Accept: "application/json"},
		);
		expect(postForm).toHaveBeenCalledWith(
			"https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic?access_token=token-123",
			expect.objectContaining({
				image: "aGVsbG8=",
				language_type: "CHN_ENG",
			}),
		);
	});

	it("tests Baidu credentials by fetching an access token without uploading an image", async () => {
		const postJson = vi.fn<Fetcher["postJson"]>().mockResolvedValue(createResponse(200, JSON.stringify({
			access_token: "token-123",
		})));
		const postForm = vi.fn<Fetcher["postForm"]>();
		const fetcher = {
			postJson,
			postForm,
		} as unknown as Fetcher;
		const client = new BaiduImageOcrClient(fetcher, {
			...DEFAULT_SETTINGS,
			imageOcrProvider: "baidu",
			imageOcrApiBaseUrl: "https://aip.baidubce.com",
		}, "baidu-api-key", "baidu-secret-key");

		await expect(client.testConnection()).resolves.toEqual({
			requestUrl: "https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=baidu-api-key&client_secret=baidu-secret-key",
		});

		expect(postJson).toHaveBeenCalledTimes(1);
		expect(postForm).not.toHaveBeenCalled();
	});
});
