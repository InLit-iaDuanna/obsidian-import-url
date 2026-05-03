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

export const DEFAULT_API_SECRET_NAME = "import-url-deepseek-api-key";
export const LEGACY_OPENAI_SECRET_NAME = "import-url-openai-api-key";
export const DEFAULT_DEEPSEEK_API_BASE_URL = "https://api.deepseek.com";

interface SecretStorageLike {
	get?: (key: string) => Promise<string | null> | string | null;
	getSecret?: (key: string) => Promise<string | null> | string | null;
	set?: (key: string, value: string) => Promise<void> | void;
	setSecret?: (key: string, value: string) => Promise<void> | void;
	remove?: (key: string) => Promise<void> | void;
	removeSecret?: (key: string) => Promise<void> | void;
}

export const DEFAULT_SETTINGS: ImportUrlPluginSettings = {
	openAiSecretName: DEFAULT_API_SECRET_NAME,
	apiBaseUrl: DEFAULT_DEEPSEEK_API_BASE_URL,
	model: "",
	customModels: [],
	modelApiBaseUrls: [],
	configTomlPath: "我的知识库/导入URL配置.toml",
	outputFolder: "我的知识库/成文",
	originalFolder: "我的知识库/原文",
	processingFolder: "我的知识库/状态/处理中",
	failedFolder: "我的知识库/状态/失败记录",
	historyFolder: "我的知识库/状态/历史记录",
	wikiFolder: "我的知识库/概念库",
	wikiSourcesFolder: "我的知识库/概念库/来源",
	wikiCandidatesFolder: "我的知识库/概念库/待入库",
	wikiConceptsFolder: "我的知识库/概念库/已入库",
	wikiIndexPath: "我的知识库/概念库/索引.md",
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

export async function readApiKeyValue(app: App, key: string): Promise<string | null> {
	const candidateKeys = [key, DEFAULT_API_SECRET_NAME, LEGACY_OPENAI_SECRET_NAME];
	for (const candidateKey of [...new Set(candidateKeys)]) {
		const value = (await readSecretValue(app, candidateKey))?.trim();
		if (value) {
			return value;
		}
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

		new Setting(containerEl)
			.setName("模型接口")
			.setHeading();

		this.buildEffectiveSettingsSummary(containerEl);

		new Setting(containerEl)
			.setName("密钥存储名称")
			.setDesc("用于在 Obsidian 安全存储中读写模型 API 密钥的名称。通常保持默认即可。")
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
		this.buildConnectionTestSetting(containerEl);

		new Setting(containerEl)
			.setName("模型")
			.setHeading();
		this.buildModelSettings(containerEl);

		new Setting(containerEl)
			.setName("输出")
			.setHeading();
		this.buildTextSetting(containerEl, "outputFolder", "AI 整理目录", "模型整理后的成文笔记目录。");
		this.buildTextSetting(containerEl, "originalFolder", "原文目录", "抓取到的原文 Markdown 单独保存到这里。");
		this.buildTextSetting(containerEl, "processingFolder", "处理中目录", "导入过程中的临时笔记目录。");
		this.buildTextSetting(containerEl, "failedFolder", "失败记录目录", "导入失败时写入诊断笔记的目录。");
		this.buildTextSetting(containerEl, "historyFolder", "历史记录目录", "可见导入历史记录笔记的目录。");
		this.buildTextSetting(containerEl, "wikiFolder", "知识库根目录", "生成知识库文件的根目录。");
		this.buildTextSetting(containerEl, "wikiSourcesFolder", "来源记录目录", "每次导入的来源记录目录。");
		this.buildTextSetting(containerEl, "wikiCandidatesFolder", "待入库目录", "待审核概念页目录。");
		this.buildTextSetting(containerEl, "wikiConceptsFolder", "已入库目录", "批准后的正式概念页目录。");
		this.buildTextSetting(containerEl, "wikiIndexPath", "知识库索引路径", "自动生成的知识库索引笔记路径。");
		this.buildTextSetting(containerEl, "defaultLanguage", "默认语言", "写入生成笔记 frontmatter 的语言值。");
		this.buildNumberSetting(containerEl, "fetchTimeoutMs", "抓取超时（毫秒）", "网页或 PDF 抓取的逻辑超时时间。");
		this.buildNumberSetting(containerEl, "aiTimeoutMs", "模型超时（毫秒）", "模型接口请求的逻辑超时时间。");
		this.buildNumberSetting(containerEl, "maxContentTokens", "最大内容 token", "发送给模型前保留的估算最大 token 数。");

		new Setting(containerEl)
			.setName("抓取兜底")
			.setHeading();
		this.buildSiteJsonFallbackSetting(containerEl);
		this.buildReaderFallbackSetting(containerEl);
		this.buildBrowserRenderFallbackSetting(containerEl);

		new Setting(containerEl)
			.setName("自动打开新笔记")
			.setDesc("导入成功后自动打开最终生成的笔记。")
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
			.setName("阅读模式兜底")
			.setDesc("直接抓取失败或只抓到脚本壳时尝试 r.jina.ai 阅读模式。它会把来源 URL 发送给第三方服务，默认关闭。")
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
			.setName("站点 JSON 兜底")
			.setDesc("对支持的页面优先尝试站点 JSON 接口，例如 Discourse 主题的 `.json` 路由，默认开启。")
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
			.setName("浏览器渲染兜底（实验）")
			.setDesc("其他方式失败时尝试桌面浏览器渲染。此功能仅桌面端可用，目前仅支持 macOS，默认关闭。")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.browserRenderFallbackEnabled)
					.onChange(async (value) => {
						this.plugin.settings.browserRenderFallbackEnabled = value;
						await this.plugin.saveSettings();
					});
			});
	}

	private buildModelSettings(containerEl: HTMLElement): void {
		const modelPlaceholder = "deepseek-v4-pro";

		new Setting(containerEl)
			.setName("默认模型")
			.setDesc("新导入默认使用的模型 ID。可以填写账号可用模型，也可以在导入弹窗中临时选择。")
			.addText((text) => {
				text.setPlaceholder(modelPlaceholder)
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						await this.plugin.persistModelSelection(value.trim());
					});
			});

		new Setting(containerEl)
			.setName("自定义模型")
			.setDesc("额外模型列表，每行一个。它们会出现在设置页和导入弹窗中。")
			.addTextArea((textArea) => {
				textArea.setPlaceholder("每行填写一个模型 ID。")
					.setValue(formatCustomModelsInput(this.plugin.settings.customModels))
					.onChange(async (value) => {
						this.plugin.settings.customModels = parseCustomModelsInput(value);
						const availableModels = getModelOptions(this.plugin.settings).map((option) => option.id);
						if (this.plugin.settings.model && !availableModels.includes(this.plugin.settings.model)) {
							this.plugin.settings.model = availableModels[0] ?? DEFAULT_SETTINGS.model;
						}
						await this.plugin.saveSettings();
					});
				textArea.inputEl.rows = 5;
				textArea.inputEl.addClass("import-url-textarea");
			});

		new Setting(containerEl)
			.setName("按模型配置 API 地址")
			.setDesc("为不同模型设置不同 API base URL，每行一个：model-id | https://example.com")
			.addTextArea((textArea) => {
				textArea.setPlaceholder("deepseek-v4-pro | https://api.deepseek.com\ndeepseek-v4-flash | https://api.deepseek.com")
					.setValue(formatModelApiBaseUrlsInput(this.plugin.settings.modelApiBaseUrls))
					.onChange(async (value) => {
						this.plugin.settings.modelApiBaseUrls = parseModelApiBaseUrlsInput(value);
						await this.plugin.saveSettings();
					});
				textArea.inputEl.rows = 5;
				textArea.inputEl.addClass("import-url-textarea");
			});
	}

	private buildEffectiveSettingsSummary(containerEl: HTMLElement): void {
		const setting = new Setting(containerEl)
			.setName("当前生效配置")
			.setDesc("正在读取 config.toml 覆盖项...");

		setting
			.addButton((button) => {
				button.setButtonText("刷新")
					.onClick(() => {
						this.display();
					});
			})
			.addButton((button) => {
				button.setButtonText("打开配置")
					.onClick(() => {
						void this.plugin.openConfigToml();
					});
			});

		void this.renderEffectiveSettingsSummary(setting);
	}

	private async renderEffectiveSettingsSummary(setting: Setting): Promise<void> {
		try {
			const effectiveSettings = await this.plugin.getEffectiveSettings();
			const model = effectiveSettings.model.trim();
			const apiBaseUrl = resolveModelApiBaseUrl(effectiveSettings, model) || effectiveSettings.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl;
			const savedModel = this.plugin.settings.model.trim();
			const savedApiBaseUrl = resolveModelApiBaseUrl(this.plugin.settings, savedModel) || this.plugin.settings.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl;
			const isRuntimeOverridden = model !== savedModel || apiBaseUrl !== savedApiBaseUrl;
			const sourceHint = isRuntimeOverridden
				? "config.toml 已覆盖设置页中的运行时配置。"
				: "当前使用设置页保存的运行时配置。";

			setting.setDesc(this.buildDescriptionFragment([
				`当前模型：${model || "未设置"}`,
				`当前 API 地址：${apiBaseUrl || "未设置"}`,
				`${sourceHint} 如果导入行为和设置页不同，请检查配置文件。`,
			]));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setting.setDesc(`读取当前生效配置失败：${message}`);
		}
	}

	private buildDescriptionFragment(lines: string[]): DocumentFragment {
		const fragment = document.createDocumentFragment();
		for (const line of lines) {
			const lineEl = document.createElement("div");
			lineEl.textContent = line;
			fragment.appendChild(lineEl);
		}
		return fragment;
	}

	private buildApiKeySetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("API 密钥")
			.setDesc("保存在 Obsidian 安全存储中。部分移动设备可能会要求生物识别或系统认证。")
			.addText((text) => {
				text.setPlaceholder("例如：sk-...")
					.onChange((value) => {
						this.secretDraft = value.trim();
					});
				text.inputEl.type = "password";
			})
			.addButton((button) => {
				button.setButtonText("保存")
					.setCta()
					.onClick(async () => {
						if (!this.secretDraft) {
							new Notice("请先输入 API 密钥。", 4000);
							return;
						}

						const saved = await writeSecretValue(this.app, this.plugin.settings.openAiSecretName, this.secretDraft);
						if (!saved) {
							new Notice("当前环境无法写入 Obsidian 安全存储。", 5000);
							return;
						}

						this.secretDraft = "";
						new Notice("API 密钥已保存。", 3000);
						this.display();
					});
			})
			.addExtraButton((button) => {
				button.setIcon("cross")
					.setTooltip("清除 API 密钥")
					.onClick(async () => {
						const removed = await removeSecretValue(this.app, this.plugin.settings.openAiSecretName);
						if (!removed) {
							new Notice("当前环境无法写入 Obsidian 安全存储。", 5000);
							return;
						}

						this.secretDraft = "";
						new Notice("API 密钥已清除。", 3000);
						this.display();
					});
			});
	}

	private buildApiBaseUrlSetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("模型 API 地址")
			.setDesc("设置模型接口的 API base URL。DeepSeek 使用 https://api.deepseek.com。")
			.addText((text) => {
				text.setPlaceholder(DEFAULT_SETTINGS.apiBaseUrl)
					.setValue(this.plugin.settings.apiBaseUrl)
					.onChange((value) => {
						this.apiBaseUrlDraft = value.trim();
					});
			})
			.addButton((button) => {
				button.setButtonText("保存")
					.setCta()
					.onClick(async () => {
						const nextValue = this.apiBaseUrlDraft || this.plugin.settings.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl;
						this.plugin.settings.apiBaseUrl = nextValue;
						await this.plugin.saveSettings();
						new Notice(`模型 API 地址已保存：${nextValue}`, 3500);
						this.display();
					});
			});
	}

	private buildConfigTomlSetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("配置文件路径")
			.setDesc("Vault 内可见的 `config.toml` 路径。导入运行时会优先读取该文件，并应用模型和 API 地址覆盖。")
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
				button.setButtonText("打开")
					.onClick(() => {
						void this.plugin.openConfigToml();
					});
			});
	}

	private buildConnectionTestSetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("测试连接")
			.setDesc("测试当前实际生效的模型和 API 地址。若 `config.toml` 中存在覆盖项，会先应用覆盖项。")
			.addButton((button) => {
				button.setButtonText("测试")
					.setCta()
					.onClick(async () => {
						button.setDisabled(true);
						button.setButtonText("测试中...");

						try {
							const effectiveSettings = await this.plugin.getEffectiveSettings();
							const model = effectiveSettings.model;
							if (!model.trim()) {
								new Notice("请先填写模型 ID，再测试连接。", 4000);
								return;
							}
							const resolvedApiBaseUrl = resolveModelApiBaseUrl(effectiveSettings, model) || DEFAULT_SETTINGS.apiBaseUrl;
							const apiKey = (await readApiKeyValue(this.app, this.plugin.settings.openAiSecretName))?.trim();
							if (!apiKey) {
								new Notice("请先保存 API 密钥，再测试连接。", 4000);
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
							button.setButtonText("测试");
						}
					});
			});
	}

	private buildTextSetting(
		containerEl: HTMLElement,
		key: "outputFolder" | "originalFolder" | "processingFolder" | "failedFolder" | "historyFolder" | "wikiFolder" | "wikiSourcesFolder" | "wikiCandidatesFolder" | "wikiConceptsFolder" | "wikiIndexPath" | "defaultLanguage",
		name: string,
		description: string,
	): void {
		new Setting(containerEl)
			.setName(name)
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
		name: string,
		description: string,
	): void {
		new Setting(containerEl)
			.setName(name)
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
