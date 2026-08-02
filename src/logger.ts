/**
 * Small in-memory ring buffer surfaced in the settings tab as a log panel.
 * Session-only (not persisted). Callers must never pass passwords, derived
 * keys, or ciphertext into log() - only human-readable status messages.
 */
export class Logger {
	private lines: string[] = [];
	private readonly maxLines = 200;

	log(message: string): void {
		const stamp = new Date().toLocaleTimeString();
		this.lines.push(`[${stamp}] ${message}`);
		if (this.lines.length > this.maxLines) this.lines.shift();
	}

	getText(): string {
		return this.lines.length > 0 ? this.lines.join("\n") : "(no log entries yet)";
	}

	clear(): void {
		this.lines = [];
	}
}
