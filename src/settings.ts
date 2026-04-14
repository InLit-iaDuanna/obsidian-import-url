import {App, Notice, PluginSettingTab, Setting} from "obsidian";
import ImportUrlPlugin from "./main";
import {ImportUrlPluginSettings} from "./types";
import {
	formatCustomModelsInput,
	formatModelApiBaseUrlsInput,
	getModelOptions,
	parseCustomModelsInput,
	parseModelApiBaseUrlsInput,
	resolveModelApiBaseUrl,
} from "./model-catalog";
import {AiClient} from "./pipeline/ai-client";
import {Fetcher} from "./pipeline/fetcher";

interface SecretStorageLike {
	get?: (key: string) => Promise<string | null> | string | null;
	getSecret?: (key: string) => Promise<string | null> | string | null;
	set?: (key: string, value: string) => Promise<void> | void;
	setSecret?: (key: string, value: string) => Promise<void> | void;
	remove?: (key: string) => Promise<void> | void;
	removeSecret?: (key: string) => Promise<void> | void;
}

export const DEFAULT_SETTINGS: ImportUrlPluginSettings = {
	openAiSecretName: "import-url-openai-api-key",
	apiBaseUrl: "https://api.openai.com/v1",
	model: "gpt-4o",
	customModels: [],
	modelApiBaseUrls: [],
	configTomlPath: "Inbox/Clippings/import-url.config.toml",
	outputFolder: "Inbox/Clippings",
	processingFolder: "Inbox/Clippings/_processing",
	failedFolder: "Inbox/Clippings/_failed",
	historyFolder: "Inbox/Clippings/History",
	defaultLanguage: "zh-CN",
	fetchTimeoutMs: 30000,
	aiTimeoutMs: 120000,
	maxContentTokens: 30000,
	siteJsonFallbackEnabled: true,
	readerFallbackEnabled: false,
	browserRenderFallbackEnabled: false,
	openNoteAfterCreate: true,
	recentImports: [],
};

export function getSecretStorage(app: App): SecretStorageLike | null {
	const appWithSecretStorage = app as App & {secretStorage?: SecretStorageLike};
	return appWithSecretStorage.secretStorage ?? null;
}

async function maybeAwait<T>(value: Promise<T> | T): Promise<T> {
	return Promise.resolve(value);
}

export async function readSecretValue(app: App, key: string): Promise<string | null> {
	const secretStorage = getSecretStorage(app);
	if (!secretStorage) {
		return null;
	}

	if (typeof secretStorage.get === "function") {
		return maybeAwait(secretStorage.get(key));
	}

	if (typeof secretStorage.getSecret === "function") {
		return maybeAwait(secretStorage.getSecret(key));
	}

	return null;
}

export async function writeSecretValue(app: App, key: string, value: string): Promise<boolean> {
	const secretStorage = getSecretStorage(app);
	if (!secretStorage) {
		return false;
	}

	if (typeof secretStorage.set === "function") {
		await maybeAwait(secretStorage.set(key, value));
		return true;
	}

	if (typeof secretStorage.setSecret === "function") {
		await maybeAwait(secretStorage.setSecret(key, value));
		return true;
	}

	return false;
}

export async function removeSecretValue(app: App, key: string): Promise<boolean> {
	const secretStorage = getSecretStorage(app);
	if (!secretStorage) {
		return false;
	}

	if (typeof secretStorage.remove === "function") {
		await maybeAwait(secretStorage.remove(key));
		return true;
	}

	if (typeof secretStorage.removeSecret === "function") {
		await maybeAwait(secretStorage.removeSecret(key));
		return true;
	}

	return false;
}

export class ImportUrlSettingTab extends PluginSettingTab {
	plugin: ImportUrlPlugin;
	private secretDraft = "";
	private apiBaseUrlDraft = "";

	constructor(app: App, plugin: ImportUrlPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		containerEl.createEl("h2", {text: "Import URL"});

		new Setting(containerEl)
			.setName("openAiSecretName")
			.setDesc("用于系统安全存储中 OpenAI API key 的键名。")
			.addText((text) => {
				text.setPlaceholder(DEFAULT_SETTINGS.openAiSecretName)
					.setValue(this.plugin.settings.openAiSecretName)
					.onChange(async (value) => {
						this.plugin.settings.openAiSecretName = value.trim() || DEFAULT_SETTINGS.openAiSecretName;
						await this.plugin.saveSettings();
					});
			});

		this.buildApiKeySetting(containerEl);
		this.buildConfigTomlSetting(containerEl);
		this.buildApiBaseUrlSetting(containerEl);
		this.buildModelSettings(containerEl);
		this.buildConnectionTestSetting(containerEl);
		this.buildTextSetting(containerEl, "outputFolder", "成功笔记写入目录。");
		this.buildTextSetting(containerEl, "processingFolder", "处理中临时笔记目录。");
		this.buildTextSetting(containerEl, "failedFolder", "失败笔记目录。");
		this.buildTextSetting(containerEl, "historyFolder", "导入历史写入目录。这里的笔记会在 Obsidian 文件列表里可见。");
		this.buildTextSetting(containerEl, "defaultLanguage", "输出语言，默认 zh-CN。");
		this.buildNumberSetting(containerEl, "fetchTimeoutMs", "网页抓取的逻辑超时时间（毫秒）。");
		this.buildNumberSetting(containerEl, "aiTimeoutMs", "OpenAI 请求的逻辑超时时间（毫秒）。");
		this.buildNumberSetting(containerEl, "maxContentTokens", "发送给模型前允许的最大内容 token 估算值。");
		this.buildSiteJsonFallbackSetting(containerEl);
		this.buildReaderFallbackSetting(containerEl);
		this.buildBrowserRenderFallbackSetting(containerEl);

		new Setting(containerEl)
			.setName("openNoteAfterCreate")
			.setDesc("成功转正后自动打开最终笔记。")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.openNoteAfterCreate)
					.onChange(async (value) => {
						this.plugin.settings.openNoteAfterCreate = value;
						await this.plugin.saveSettings();
					});
			});
	}

	private buildReaderFallbackSetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("readerFallbackEnabled")
			.setDesc("网页直连抓取超时后，改用公开阅读代理 r.jina.ai 获取正文。会把原始 URL 发送给第三方服务，默认关闭。")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.readerFallbackEnabled)
					.onChange(async (value) => {
						this.plugin.settings.readerFallbackEnabled = value;
						await this.plugin.saveSettings();
					});
			});
	}

	private buildSiteJsonFallbackSetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("siteJsonFallbackEnabled")
			.setDesc("对支持的站点优先尝试专用 JSON 接口回退，例如 Discourse 主题页的 .json。默认开启。")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.siteJsonFallbackEnabled)
					.onChange(async (value) => {
						this.plugin.settings.siteJsonFallbackEnabled = value;
						await this.plugin.saveSettings();
					});
			});
	}

	private buildBrowserRenderFallbackSetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("browserRenderFallbackEnabled")
			.setDesc("当前面几种方式都失败时，尝试使用本地桌面浏览器渲染页面再提取正文。当前仅在桌面 macOS 上可用，可能会短暂打开 Safari，默认关闭。")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.browserRenderFallbackEnabled)
					.onChange(async (value) => {
						this.plugin.settings.browserRenderFallbackEnabled = value;
						await this.plugin.saveSettings();
					});
			});
	}

	private buildModelSettings(containerEl: HTMLElement): void {
		const modelOptions = getModelOptions(this.plugin.settings);

		new Setting(containerEl)
			.setName("model")
			.setDesc("默认模型。导入弹窗里也可以临时切换，并记住最后一次使用。")
			.addDropdown((dropdown) => {
				for (const option of modelOptions) {
					dropdown.addOption(option.id, option.label);
				}

					dropdown.setValue(this.plugin.settings.model)
						.onChange(async (value) => {
							this.plugin.settings.model = value;
							await this.plugin.saveSettings();
							this.display();
						});
				});

		new Setting(containerEl)
			.setName("customModels")
			.setDesc("额外模型 ID，每行一个。会同步出现在设置页和导入弹窗中。")
			.addTextArea((textArea) => {
				textArea.setPlaceholder("gpt-5.1\nmy-compatible-model")
					.setValue(formatCustomModelsInput(this.plugin.settings.customModels))
					.onChange(async (value) => {
						this.plugin.settings.customModels = parseCustomModelsInput(value);
						const availableModels = getModelOptions(this.plugin.settings).map((option) => option.id);
						if (!availableModels.includes(this.plugin.settings.model)) {
							this.plugin.settings.model = availableModels[0] ?? DEFAULT_SETTINGS.model;
						}
						await this.plugin.saveSettings();
					});
				textArea.inputEl.rows = 5;
				textArea.inputEl.addClass("import-url-textarea");
			});

		new Setting(containerEl)
			.setName("modelApiBaseUrls")
			.setDesc("为特定模型指定单独的 API 地址。每行一个，格式：model-id | https://example.com/v1")
			.addTextArea((textArea) => {
				textArea.setPlaceholder("gpt-5.4 | https://api.example.com/v1\nclaude-sonnet-4 | https://example.com/v1")
					.setValue(formatModelApiBaseUrlsInput(this.plugin.settings.modelApiBaseUrls))
					.onChange(async (value) => {
						this.plugin.settings.modelApiBaseUrls = parseModelApiBaseUrlsInput(value);
						await this.plugin.saveSettings();
					});
				textArea.inputEl.rows = 5;
				textArea.inputEl.addClass("import-url-textarea");
			});
	}

	private buildApiKeySetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("OpenAI API key")
			.setDesc("密钥通过系统安全存储保存，部分移动设备可能会触发生物识别或系统认证。")
			.addText((text) => {
				text.setPlaceholder("sk-...")
					.onChange((value) => {
						this.secretDraft = value.trim();
					});
				text.inputEl.type = "password";
			})
			.addButton((button) => {
				button.setButtonText("Save")
					.setCta()
					.onClick(async () => {
						if (!this.secretDraft) {
							new Notice("请先输入 OpenAI API key。", 4000);
							return;
						}

						const saved = await writeSecretValue(this.app, this.plugin.settings.openAiSecretName, this.secretDraft);
						if (!saved) {
							new Notice("当前环境未暴露可写的 Secret storage 接口。", 5000);
							return;
						}

						this.secretDraft = "";
						new Notice("OpenAI API key 已保存。", 3000);
						this.display();
					});
			})
			.addExtraButton((button) => {
				button.setIcon("cross")
					.setTooltip("Clear API key")
					.onClick(async () => {
						const removed = await removeSecretValue(this.app, this.plugin.settings.openAiSecretName);
						if (!removed) {
							new Notice("当前环境未暴露可写的 Secret storage 接口。", 5000);
							return;
						}

						this.secretDraft = "";
						new Notice("已清除 OpenAI API key。", 3000);
						this.display();
					});
			});
	}

	private buildApiBaseUrlSetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("apiBaseUrl")
			.setDesc("API 地址。可填 OpenAI-compatible 的 /v1 基础地址，或完整 /responses /chat/completions 地址；插件会优先尝试 Responses，再自动兼容 chat/completions。")
			.addText((text) => {
				text.setPlaceholder(DEFAULT_SETTINGS.apiBaseUrl)
					.setValue(this.plugin.settings.apiBaseUrl)
					.onChange((value) => {
						this.apiBaseUrlDraft = value.trim();
					});
			})
			.addButton((button) => {
				button.setButtonText("Save")
					.setCta()
					.onClick(async () => {
						const nextValue = this.apiBaseUrlDraft || this.plugin.settings.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl;
						this.plugin.settings.apiBaseUrl = nextValue;
						await this.plugin.saveSettings();
						new Notice(`API 地址已保存：${nextValue}`, 3500);
						this.display();
					});
				});
	}

	private buildConfigTomlSetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("config.toml")
			.setDesc("可直接在 Obsidian 里编辑的可见配置文件。导入前会优先读取这份 TOML 覆盖模型和 API 地址。")
			.addText((text) => {
				text.setPlaceholder(DEFAULT_SETTINGS.configTomlPath)
					.setValue(this.plugin.settings.configTomlPath)
					.onChange(async (value) => {
						this.plugin.settings.configTomlPath = value.trim() || DEFAULT_SETTINGS.configTomlPath;
						await this.plugin.saveSettings();
						await this.plugin.ensureConfigTomlReady();
					});
			})
			.addButton((button) => {
				button.setButtonText("Open")
					.onClick(() => {
						void this.plugin.openConfigToml();
					});
			});
	}

	private buildConnectionTestSetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("连接测试")
			.setDesc("测试当前生效的模型和接口地址。若 config.toml 有覆盖，这里会优先使用 config.toml，并在需要时自动从 Responses 回退到 chat/completions。")
			.addButton((button) => {
				button.setButtonText("Test")
					.setCta()
					.onClick(async () => {
						button.setDisabled(true);
						button.setButtonText("Testing...");

						try {
							const effectiveSettings = await this.plugin.getEffectiveSettings();
							const model = effectiveSettings.model;
							const resolvedApiBaseUrl = resolveModelApiBaseUrl(effectiveSettings, model) || DEFAULT_SETTINGS.apiBaseUrl;
							const apiKey = (await readSecretValue(this.app, this.plugin.settings.openAiSecretName))?.trim();
							if (!apiKey) {
								new Notice("请先保存可用的 API key。", 4000);
								return;
							}

							const fetcher = new Fetcher(this.plugin.settings.fetchTimeoutMs, this.plugin.settings.aiTimeoutMs);
							const client = new AiClient(fetcher, {
								...effectiveSettings,
								model,
								apiBaseUrl: resolvedApiBaseUrl,
							}, apiKey);
							const result = await client.testConnection();
							new Notice(`连接成功：${model} @ ${result.requestUrl}`, 5000);
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							new Notice(`连接失败：${message}`, 7000);
						} finally {
							button.setDisabled(false);
							button.setButtonText("Test");
						}
					});
			});
	}

	private buildTextSetting(
		containerEl: HTMLElement,
		key: "outputFolder" | "processingFolder" | "failedFolder" | "historyFolder" | "defaultLanguage",
		description: string,
	): void {
		new Setting(containerEl)
			.setName(key)
			.setDesc(description)
			.addText((text) => {
				text.setValue(this.plugin.settings[key])
					.onChange(async (value) => {
						this.plugin.settings[key] = value.trim();
						await this.plugin.saveSettings();
					});
			});
	}

	private buildNumberSetting(
		containerEl: HTMLElement,
		key: "fetchTimeoutMs" | "aiTimeoutMs" | "maxContentTokens",
		description: string,
	): void {
		new Setting(containerEl)
			.setName(key)
			.setDesc(description)
			.addText((text) => {
				text.inputEl.type = "number";
				text.setValue(String(this.plugin.settings[key]))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (Number.isFinite(parsed) && parsed > 0) {
							this.plugin.settings[key] = parsed;
							await this.plugin.saveSettings();
						}
					});
			});
	}
}
