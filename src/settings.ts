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

		new Setting(containerEl)
			.setName("Connection")
			.setHeading();

		new Setting(containerEl)
			.setName("Secret key name")
			.setDesc("Key name used to read and write the API key in Obsidian secret storage.")
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
			.setName("Models")
			.setHeading();
		this.buildModelSettings(containerEl);

		new Setting(containerEl)
			.setName("Output")
			.setHeading();
		this.buildTextSetting(containerEl, "outputFolder", "Output folder", "Folder for completed notes.");
		this.buildTextSetting(containerEl, "processingFolder", "Processing folder", "Folder for temporary processing notes.");
		this.buildTextSetting(containerEl, "failedFolder", "Failed folder", "Folder for failed import notes.");
		this.buildTextSetting(containerEl, "historyFolder", "History folder", "Folder for visible import history notes.");
		this.buildTextSetting(containerEl, "defaultLanguage", "Default language", "Language value stored in generated frontmatter.");
		this.buildNumberSetting(containerEl, "fetchTimeoutMs", "Fetch timeout (ms)", "Logical timeout for webpage fetching.");
		this.buildNumberSetting(containerEl, "aiTimeoutMs", "AI timeout (ms)", "Logical timeout for model requests.");
		this.buildNumberSetting(containerEl, "maxContentTokens", "Max content tokens", "Estimated max tokens sent to the model before truncation.");

		new Setting(containerEl)
			.setName("Fallbacks")
			.setHeading();
		this.buildSiteJsonFallbackSetting(containerEl);
		this.buildReaderFallbackSetting(containerEl);
		this.buildBrowserRenderFallbackSetting(containerEl);

		new Setting(containerEl)
			.setName("Open created note")
			.setDesc("Open the final note automatically after a successful import.")
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
			.setName("Reader fallback")
			.setDesc("If direct fetch fails, try r.jina.ai reader mode. This sends the source URL to a third-party service. Off by default.")
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
			.setName("Site JSON fallback")
			.setDesc("Prefer site-specific JSON endpoints on supported pages, such as Discourse topic `.json` routes. On by default.")
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
			.setName("Browser render fallback (experimental)")
			.setDesc("If other methods fail, try desktop browser rendering. This is desktop-only and currently macOS-only. Off by default.")
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
			.setName("Default model")
			.setDesc("Default model for new imports. You can still switch per import from the modal.")
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
			.setName("Custom models")
			.setDesc("Extra model entries, one per line. These appear in both settings and the import modal.")
			.addTextArea((textArea) => {
				textArea.setPlaceholder("Enter one model name per line.")
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
			.setName("Model-specific API addresses")
			.setDesc("Set a custom API base URL per model. One per line: model-id | https://example.com/v1")
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
			.setName("API key")
			.setDesc("Stored in Obsidian secret storage. Some mobile devices may prompt for biometric or system authentication.")
			.addText((text) => {
				text.setPlaceholder("Example: sk-...")
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
								new Notice("Enter an API key first.", 4000);
								return;
							}

							const saved = await writeSecretValue(this.app, this.plugin.settings.openAiSecretName, this.secretDraft);
							if (!saved) {
								new Notice("Secret storage is not writable in this environment.", 5000);
								return;
							}

							this.secretDraft = "";
							new Notice("API key saved.", 3000);
							this.display();
						});
				})
			.addExtraButton((button) => {
				button.setIcon("cross")
						.setTooltip("Clear API key")
						.onClick(async () => {
							const removed = await removeSecretValue(this.app, this.plugin.settings.openAiSecretName);
							if (!removed) {
								new Notice("Secret storage is not writable in this environment.", 5000);
								return;
							}

							this.secretDraft = "";
							new Notice("API key cleared.", 3000);
							this.display();
						});
				});
	}

	private buildApiBaseUrlSetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Default API base URL")
			.setDesc("Set a compatible API base URL. Responses is tried first, then chat completions is used as an automatic fallback.")
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
							new Notice(`API base URL saved: ${nextValue}`, 3500);
							this.display();
						});
				});
	}

	private buildConfigTomlSetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Config file path")
			.setDesc("Path to a visible `config.toml` file in your vault. Runtime imports read this file first and apply model and API URL overrides.")
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
			.setName("Test connection")
			.setDesc("Test the currently effective model and API URL. If `config.toml` overrides are present, they are applied before testing.")
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
								new Notice("Save an API key before running a connection test.", 4000);
								return;
							}

							const fetcher = new Fetcher(this.plugin.settings.fetchTimeoutMs, this.plugin.settings.aiTimeoutMs);
							const client = new AiClient(fetcher, {
								...effectiveSettings,
								model,
								apiBaseUrl: resolvedApiBaseUrl,
							}, apiKey);
							const result = await client.testConnection();
							new Notice(`Connection successful: ${model} @ ${result.requestUrl}`, 5000);
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							new Notice(`Connection failed: ${message}`, 7000);
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
