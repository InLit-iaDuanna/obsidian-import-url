import {vi} from "vitest";

export class App {}
export class TAbstractFile {
	path = "";
}

export class TFile extends TAbstractFile {
	content = "";
}

export class Notice {
	message: string;
	timeout?: number;

	constructor(message: string, timeout?: number) {
		this.message = message;
		this.timeout = timeout;
	}
}

export class Plugin {
	app: App;
	readonly commands: Array<{id: string; name: string; callback: () => void}> = [];
	readonly settingTabs: PluginSettingTab[] = [];
	readonly ribbonIcons: Array<{icon: string; title: string; callback: () => void}> = [];
	readonly views: Array<{type: string; viewCreator: (leaf: WorkspaceLeaf) => View}> = [];

	constructor(app: App) {
		this.app = app;
	}

	addRibbonIcon(icon: string, title: string, callback: () => void): void {
		this.ribbonIcons.push({icon, title, callback});
	}

	addCommand(command: {id: string; name: string; callback: () => void}): void {
		this.commands.push(command);
	}

	addSettingTab(tab: PluginSettingTab): void {
		this.settingTabs.push(tab);
	}

	registerView(type: string, viewCreator: (leaf: WorkspaceLeaf) => View): void {
		this.views.push({type, viewCreator});
	}

	async loadData(): Promise<unknown> {
		return null;
	}

	async saveData(_data: unknown): Promise<void> {}
}

export class PluginSettingTab {
	app: App;
	plugin: Plugin;
	containerEl = document.createElement("div");

	constructor(app: App, plugin: Plugin) {
		this.app = app;
		this.plugin = plugin;
	}
}

export class WorkspaceLeaf {
	view: View | null = null;

	async openFile(): Promise<void> {}

	async setViewState(): Promise<void> {}
}

export abstract class View {
	contentEl = document.createElement("div");
	containerEl = document.createElement("div");

	constructor(public leaf: WorkspaceLeaf) {}

	protected async onOpen(): Promise<void> {}
	protected async onClose(): Promise<void> {}
	abstract getViewType(): string;
	abstract getDisplayText(): string;
	getIcon(): string { return ""; }
}

export abstract class ItemView extends View {
	contentEl = document.createElement("div");

	addAction(): HTMLElement {
		return document.createElement("button");
	}
}

export class Setting {
	static instances: Setting[] = [];
	name = "";
	description = "";
	isHeading = false;

	constructor(public containerEl: HTMLElement) {
		Setting.instances.push(this);
	}
	setName(name: string): this {
		this.name = name;
		return this;
	}
	setDesc(desc: string | DocumentFragment): this {
		this.description = typeof desc === "string" ? desc : desc.textContent ?? "";
		return this;
	}
	setHeading(): this {
		this.isHeading = true;
		return this;
	}
	addText(callback: (component: TextComponent) => void): this {
		callback(new TextComponent(this.containerEl));
		return this;
	}
	addButton(callback: (component: ButtonComponent) => void): this {
		callback(new ButtonComponent(this.containerEl));
		return this;
	}
	addExtraButton(callback: (component: ButtonComponent) => void): this {
		callback(new ButtonComponent(this.containerEl));
		return this;
	}
	addToggle(callback: (component: ToggleComponent) => void): this {
		callback(new ToggleComponent(this.containerEl));
		return this;
	}
	addDropdown(callback: (component: DropdownComponent) => void): this {
		callback(new DropdownComponent(this.containerEl));
		return this;
	}
	addTextArea(callback: (component: TextAreaComponent) => void): this {
		callback(new TextAreaComponent(this.containerEl));
		return this;
	}
}

export class Modal {
	contentEl = document.createElement("div");
	constructor(public app: App) {}
	open(): void {
		const self = this as unknown as {onOpen?: () => void};
		if (typeof self.onOpen === "function") {
			self.onOpen();
		}
	}
	close(): void {
		const self = this as unknown as {onClose?: () => void};
		if (typeof self.onClose === "function") {
			self.onClose();
		}
	}
}

export class TextComponent {
	inputEl = document.createElement("input");

	constructor(containerEl?: HTMLElement) {
		containerEl?.appendChild(this.inputEl);
	}
	setPlaceholder(): this { return this; }
	setValue(value: string): this {
		this.inputEl.value = value;
		return this;
	}
	onChange(_callback: (value: string) => void): this { return this; }
	setDisabled(): this { return this; }
	getValue(): string { return this.inputEl.value; }
}

export class ButtonComponent {
	private clickHandler: (() => void) | null = null;
	readonly buttonEl = document.createElement("button");

	constructor(containerEl?: HTMLElement) {
		containerEl?.appendChild(this.buttonEl);
	}
	setButtonText(label: string): this {
		this.buttonEl.textContent = label;
		return this;
	}
	setCta(): this { return this; }
	onClick(callback: () => void): this {
		this.clickHandler = callback;
		this.buttonEl.onclick = callback;
		return this;
	}
	setDisabled(disabled: boolean): this {
		this.buttonEl.disabled = disabled;
		return this;
	}
	setIcon(): this { return this; }
	setTooltip(): this { return this; }
	click(): void {
		this.clickHandler?.();
	}
}

export class ToggleComponent {
	readonly toggleEl = document.createElement("input");
	constructor(containerEl?: HTMLElement) {
		this.toggleEl.type = "checkbox";
		containerEl?.appendChild(this.toggleEl);
	}
	setValue(): this { return this; }
	onChange(): this { return this; }
}

export const Platform = {
	isDesktop: true,
	isMobile: false,
	isDesktopApp: true,
	isMobileApp: false,
	isIosApp: false,
	isAndroidApp: false,
	isPhone: false,
	isTablet: false,
	isMacOS: true,
	isWin: false,
	isLinux: false,
	isSafari: false,
	resourcePathPrefix: "",
};

export function htmlToMarkdown(html: string): string {
	return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export class DropdownComponent {
	selectEl = document.createElement("select");

	constructor(containerEl?: HTMLElement) {
		containerEl?.appendChild(this.selectEl);
	}
	addOption(value: string, label: string): this {
		const optionEl = document.createElement("option");
		optionEl.value = value;
		optionEl.text = label;
		this.selectEl.appendChild(optionEl);
		return this;
	}
	setValue(value: string): this {
		this.selectEl.value = value;
		return this;
	}
	onChange(_callback: (value: string) => void): this { return this; }
}

export class TextAreaComponent {
	inputEl = document.createElement("textarea");

	constructor(containerEl?: HTMLElement) {
		containerEl?.appendChild(this.inputEl);
	}
	setPlaceholder(): this { return this; }
	setValue(value: string): this {
		this.inputEl.value = value;
		return this;
	}
	onChange(_callback: (value: string) => void): this { return this; }
}

export const requestUrl = vi.fn();
