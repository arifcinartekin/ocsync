import { App, Modal, Setting } from "obsidian";

/**
 * Prompts the user for their vault encryption password. The password is
 * handed to the callback and MUST NOT be logged or persisted by any caller.
 */
export class PasswordModal extends Modal {
	private password = "";

	constructor(app: App, private title: string, private onSubmit: (password: string) => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: this.title });

		let inputEl: HTMLInputElement;

		new Setting(contentEl).setName("Encryption password").addText((text) => {
			text.inputEl.type = "password";
			inputEl = text.inputEl;
			text.onChange((value) => (this.password = value));
			text.inputEl.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") {
					this.submit();
				}
			});
		});

		new Setting(contentEl).addButton((button) =>
			button
				.setCta()
				.setButtonText("Unlock")
				.onClick(() => this.submit())
		);

		window.setTimeout(() => inputEl?.focus(), 0);
	}

	private submit(): void {
		if (this.password.length === 0) return;
		this.close();
		this.onSubmit(this.password);
	}

	onClose(): void {
		this.contentEl.empty();
		this.password = "";
	}
}
