/**
 * Minimal GitHub REST API client built on plain fetch(). No child_process,
 * no external git binary - this must work unmodified on iOS/Android where
 * there is no shell access.
 *
 * Phase 1 only needs the Contents API (get/put a single file). The Git Data
 * API (blobs/trees/commits/refs, for atomic multi-file commits) is added in
 * Phase 2.
 */

export interface GitHubClientOptions {
	token: string;
	owner: string;
	repo: string;
	branch: string;
}

export class GitHubApiError extends Error {
	constructor(message: string, public readonly status: number) {
		super(message);
		this.name = "GitHubApiError";
	}
}

export class GitHubRateLimitError extends GitHubApiError {
	constructor(message: string, status: number, public readonly retryAfterMs: number | null) {
		super(message, status);
		this.name = "GitHubRateLimitError";
	}
}

export class GitHubConflictError extends GitHubApiError {
	constructor(message: string) {
		super(message, 409);
		this.name = "GitHubConflictError";
	}
}

export interface RemoteFile {
	sha: string;
	contentBase64: string;
}

export class GitHubClient {
	constructor(private options: GitHubClientOptions) {}

	private apiBase = "https://api.github.com";

	private authHeaders(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.options.token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		};
	}

	/**
	 * Central error translation. Never includes request bodies (which could
	 * contain ciphertext) or the token in thrown error messages.
	 */
	private async handleErrorResponse(res: Response, context: string): Promise<never> {
		if (res.status === 403 || res.status === 429) {
			const remaining = res.headers.get("x-ratelimit-remaining");
			const resetHeader = res.headers.get("x-ratelimit-reset");
			const retryAfterHeader = res.headers.get("retry-after");
			let retryAfterMs: number | null = null;
			if (retryAfterHeader) {
				retryAfterMs = parseInt(retryAfterHeader, 10) * 1000;
			} else if (resetHeader) {
				const resetEpochSeconds = parseInt(resetHeader, 10);
				retryAfterMs = Math.max(0, resetEpochSeconds * 1000 - Date.now());
			}
			if (res.status === 429 || remaining === "0") {
				throw new GitHubRateLimitError(`GitHub rate limit hit during ${context}`, res.status, retryAfterMs);
			}
		}
		if (res.status === 409) {
			throw new GitHubConflictError(`GitHub conflict during ${context} (ref moved concurrently)`);
		}
		throw new GitHubApiError(`GitHub API error during ${context}: HTTP ${res.status}`, res.status);
	}

	/** Returns null if the file does not exist (404). */
	async getFile(path: string): Promise<RemoteFile | null> {
		const url = `${this.apiBase}/repos/${this.options.owner}/${this.options.repo}/contents/${encodeGitHubPath(
			path
		)}?ref=${encodeURIComponent(this.options.branch)}`;
		const res = await fetch(url, { headers: this.authHeaders() });
		if (res.status === 404) return null;
		if (!res.ok) return this.handleErrorResponse(res, `getFile(${path})`);
		const body = (await res.json()) as { sha: string; content: string; encoding: string };
		const contentBase64 = body.encoding === "base64" ? body.content.replace(/\n/g, "") : btoa(body.content);
		return { sha: body.sha, contentBase64 };
	}

	/**
	 * Creates or updates a file. Pass the previous sha when updating an
	 * existing file so GitHub can detect concurrent modification.
	 */
	async putFile(path: string, contentBase64: string, message: string, sha?: string): Promise<{ sha: string }> {
		const url = `${this.apiBase}/repos/${this.options.owner}/${this.options.repo}/contents/${encodeGitHubPath(
			path
		)}`;
		const res = await fetch(url, {
			method: "PUT",
			headers: { ...this.authHeaders(), "Content-Type": "application/json" },
			body: JSON.stringify({
				message,
				content: contentBase64,
				branch: this.options.branch,
				...(sha ? { sha } : {}),
			}),
		});
		if (!res.ok) return this.handleErrorResponse(res, `putFile(${path})`);
		const body = (await res.json()) as { content: { sha: string } };
		return { sha: body.content.sha };
	}

	/** Verifies the token/repo/branch combination works and is reachable. */
	async testConnection(): Promise<void> {
		const url = `${this.apiBase}/repos/${this.options.owner}/${this.options.repo}/branches/${encodeURIComponent(
			this.options.branch
		)}`;
		const res = await fetch(url, { headers: this.authHeaders() });
		if (!res.ok) return this.handleErrorResponse(res, "testConnection");
	}
}

function encodeGitHubPath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}
