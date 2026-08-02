import { Notice, Plugin, TFile } from "obsidian";
import { DEFAULT_SETTINGS, OCSyncSettings, OCSyncSettingTab } from "./settings";
import { PasswordModal } from "./passwordModal";
import { GitHubClient } from "./github";
import { base64ToBytes, bytesToBase64, deriveKey, encryptBytes, generateSalt } from "./crypto";

const SALT_PATH = "salt.txt";

type SyncStatus = "locked" | "idle" | "syncing" | "ok" | "error";

/**
 * Encodes a UTF-8 string as the base64 payload the GitHub Contents API
 * expects for a plain-text file (e.g. salt.txt).
 */
function textToContentBase64(text: string): string {
	return bytesToBase64(new TextEncoder().encode(text));
}

function contentBase64ToText(contentBase64: string): string {
	return new TextDecoder().decode(base64ToBytes(contentBase64));
}

export default class OCSyncPlugin extends Plugin {
	settings: OCSyncSettings = DEFAULT_SETTINGS;

	/**
	 * Session-only state. The derived key and salt live in memory for as
	 * long as Obsidian stays open and are never written to disk.
	 */
	private sessionKey: CryptoKey | null = null;

	private statusBarItem: HTMLElement | null = null;
	private status: SyncStatus = "locked";

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addSettingTab(new OCSyncSettingTab(this.app, this));

		this.statusBarItem = this.addStatusBarItem();
		this.setStatus("locked");

		this.addCommand({
			id: "ocsync-unlock",
			name: "Unlock encryption password",
			callback: () => this.promptForPassword(),
		});

		this.addCommand({
			id: "ocsync-sync-active-file",
			name: "Sync now (Phase 1: test push active file)",
			callback: () => this.manualSyncActiveFile(),
		});

		this.app.workspace.onLayoutReady(() => {
			if (this.hasCompleteGitHubSettings()) {
				this.promptForPassword();
			}
		});
	}

	onunload(): void {
		this.sessionKey = null;
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Placeholder until Phase 4 introduces the real periodic sync loop. */
	restartSyncLoop(): void {
		// No-op in Phase 1.
	}

	hasCompleteGitHubSettings(): boolean {
		const s = this.settings;
		return s.githubOwner.length > 0 && s.githubRepo.length > 0 && s.githubToken.length > 0;
	}

	private getGitHubClient(): GitHubClient {
		if (!this.hasCompleteGitHubSettings()) {
			throw new Error("GitHub owner, repository, and token must be configured in settings first.");
		}
		return new GitHubClient({
			token: this.settings.githubToken,
			owner: this.settings.githubOwner,
			repo: this.settings.githubRepo,
			branch: this.settings.githubBranch,
		});
	}

	async testGitHubConnection(): Promise<void> {
		await this.getGitHubClient().testConnection();
	}

	promptForPassword(): void {
		new PasswordModal(this.app, "Unlock OCSync", (password) => {
			void this.unlockWithPassword(password);
		}).open();
	}

	/**
	 * Fetches (or creates, on first run) the PBKDF2 salt from the repo and
	 * derives the session key from it. A wrong password will not fail here -
	 * PBKDF2 always succeeds - it only surfaces later as a failed AES-GCM
	 * authentication when we try to decrypt something.
	 */
	private async unlockWithPassword(password: string): Promise<void> {
		try {
			this.setStatus("syncing");
			const client = this.getGitHubClient();

			let saltBytes: Uint8Array;
			const existing = await client.getFile(SALT_PATH);
			if (existing) {
				const saltBase64Text = contentBase64ToText(existing.contentBase64);
				saltBytes = base64ToBytes(saltBase64Text);
			} else {
				saltBytes = generateSalt();
				const saltBase64Text = bytesToBase64(saltBytes);
				await client.putFile(SALT_PATH, textToContentBase64(saltBase64Text), "ocsync: initialize salt");
				new Notice("OCSync: initialized new encryption salt in repository");
			}

			this.sessionKey = await deriveKey(password, saltBytes);
			this.setStatus("idle");
			new Notice("OCSync: unlocked");
		} catch (e) {
			this.setStatus("error");
			new Notice(`OCSync: failed to unlock - ${(e as Error).message}`);
		}
	}

	/**
	 * Phase 1 connectivity test: encrypts the active file and pushes it to a
	 * throwaway test path. This does not build a manifest or content-addressed
	 * object store yet - that lands in Phase 2. There is no decrypt/pull path
	 * yet either.
	 */
	async manualSyncActiveFile(): Promise<void> {
		if (!this.sessionKey) {
			new Notice("OCSync: unlock your encryption password first");
			return;
		}
		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile)) {
			new Notice("OCSync: no active file to sync");
			return;
		}

		try {
			this.setStatus("syncing");
			const client = this.getGitHubClient();

			const plaintext = await this.app.vault.readBinary(file);
			const combined = await encryptBytes(this.sessionKey, plaintext);

			const remotePath = `ocsync-test/${file.path}.enc`;
			const existing = await client.getFile(remotePath).catch(() => null);
			await client.putFile(
				remotePath,
				bytesToBase64(combined),
				`ocsync: test push ${file.path}`,
				existing?.sha
			);

			this.setStatus("ok");
			new Notice(`OCSync: pushed encrypted "${file.path}" to GitHub`);
		} catch (e) {
			this.setStatus("error");
			new Notice(`OCSync: sync failed - ${(e as Error).message}`);
		}
	}

	private setStatus(status: SyncStatus): void {
		this.status = status;
		if (!this.statusBarItem) return;
		const icons: Record<SyncStatus, string> = {
			locked: "🔒",
			idle: "⚡",
			syncing: "⏳",
			ok: "✅",
			error: "❌",
		};
		this.statusBarItem.setText(`${icons[this.status]} OCSync`);
	}
}
