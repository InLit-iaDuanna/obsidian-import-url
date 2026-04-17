import {afterEach, vi} from "vitest";

function applyElementHelpers(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	if (typeof proto.addClass !== "function") {
		proto.addClass = function addClass(this: HTMLElement, ...classes: string[]): void {
			this.classList.add(...classes);
		};
	}
	if (typeof proto.empty !== "function") {
		proto.empty = function empty(this: HTMLElement): void {
			this.innerHTML = "";
		};
	}
	if (typeof proto.createDiv !== "function") {
		proto.createDiv = function createDiv(this: HTMLElement, options?: {cls?: string; text?: string}): HTMLElement {
			const self = this as HTMLElement & {
				createEl: (tag: string, options?: {cls?: string; text?: string}) => HTMLElement;
			};
			return self.createEl("div", options);
		};
	}
	if (typeof proto.createEl !== "function") {
		proto.createEl = function createEl(
			this: HTMLElement,
			tag: string,
			options?: {cls?: string; text?: string; attr?: Record<string, string>},
		): HTMLElement {
			const element = document.createElement(tag);
			if (options?.cls) {
				element.className = options.cls;
			}
			if (options?.text) {
				element.textContent = options.text;
			}
			if (options?.attr) {
				for (const [name, value] of Object.entries(options.attr)) {
					element.setAttribute(name, value);
				}
			}
			this.appendChild(element);
			return element;
		};
	}
	if (typeof proto.setText !== "function") {
		proto.setText = function setText(this: HTMLElement, text: string): void {
			this.textContent = text;
		};
	}
	if (typeof proto.setAttr !== "function") {
		proto.setAttr = function setAttr(this: HTMLElement, name: string, value: string | number | boolean): void {
			this.setAttribute(name, String(value));
		};
	}
}

applyElementHelpers();

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});
