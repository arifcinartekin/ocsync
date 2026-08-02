import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type OCSyncPlugin from "./main";

export interface OCSyncSettings {
	githubOwner: string;
	githubRepo: string;
	githubBranch: string;
	/**
	 * Stored in plain text in data.json by design (per project spec). This is
	 * the user's own private-repo token, not the vault encryption password -
	 * the password itself is never persisted anywhere.
	 */
	githubToken: string;
	syncIntervalSeconds: number;
	excludePatterns: string[];
}

export const DEFAULT_SETTINGS: OCSyncSettings = {
	githubOwner: "",
	githubRepo: "",
	githubBranch: "main",
	githubToken: "",
	syncIntervalSeconds: 60,
	excludePatterns: [".obsidian/workspace*", ".obsidian/cache", ".trash/**"],
};

export class OCSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: OCSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "OCSync settings" });

		const notice = containerEl.createEl("div", { cls: "ocsync-info-box" });
		notice.createEl("strong", { text: "Token recommendation: " });
		notice.appendText(
			"create a fine-grained Personal Access Token scoped to this single repository, " +
				"with Contents: Read and write permission only. Do not use a classic token with broader scope."
		);

		new Setting(containerEl)
			.setName("GitHub repository owner")
			.setDesc("The account or organization that owns the sync repository, e.g. \"octocat\".")
			.addText((text) =>
				text
					.setPlaceholder("owner")
					.setValue(this.plugin.settings.githubOwner)
					.onChange(async (value) => {
						this.plugin.settings.githubOwner = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("GitHub repository name")
			.setDesc("Should be a private repository dedicated to this vault's encrypted sync data.")
			.addText((text) =>
				text
					.setPlaceholder("my-vault-sync")
					.setValue(this.plugin.settings.githubRepo)
					.onChange(async (value) => {
						this.plugin.settings.githubRepo = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Branch")
			.setDesc("Branch used for sync commits.")
			.addText((text) =>
				text
					.setPlaceholder("main")
					.setValue(this.plugin.settings.githubBranch)
					.onChange(async (value) => {
						this.plugin.settings.githubBranch = value.trim() || "main";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Personal access token")
			.setDesc("Fine-grained token with Contents read/write access to the repository above.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("github_pat_...")
					.setValue(this.plugin.settings.githubToken)
					.onChange(async (value) => {
						this.plugin.settings.githubToken = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Sync interval (seconds)")
			.setDesc("How often to automatically sync in the background.")
			.addText((text) =>
				text
					.setPlaceholder("60")
					.setValue(String(this.plugin.settings.syncIntervalSeconds))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (!Number.isNaN(parsed) && parsed > 0) {
							this.plugin.settings.syncIntervalSeconds = parsed;
							await this.plugin.saveSettings();
							this.plugin.restartSyncLoop();
						}
					})
			);

		new Setting(containerEl)
			.setName("Excluded patterns")
			.setDesc("One glob-style pattern per line. Matching files/folders are never synced.")
			.addTextArea((text) => {
				text
					.setValue(this.plugin.settings.excludePatterns.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.excludePatterns = value
							.split("\n")
							.map((line) => line.trim())
							.filter((line) => line.length > 0);
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 5;
			});

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Verify the token can reach the configured repository and branch.")
			.addButton((button) =>
				button.setButtonText("Test").onClick(async () => {
					try {
						await this.plugin.testGitHubConnection();
						new Notice("OCSync: connection OK");
					} catch (e) {
						new Notice(`OCSync: connection failed - ${(e as Error).message}`);
					}
				})
			);

		new Setting(containerEl)
			.setName("Sync now")
			.setDesc("Pushes local changes, pulls remote changes, and creates conflict copies when both sides changed.")
			.addButton((button) =>
				button
					.setCta()
					.setButtonText("Sync now")
					.onClick(async () => {
						await this.plugin.syncNow();
					})
			);
	}
}
