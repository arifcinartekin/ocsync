/**
 * Minimal GitHub REST API client built on plain fetch(). No child_process,
 * no external git binary - this must work unmodified on iOS/Android where
 * there is no shell access.
 *
 * Reads deliberately go through the Git Data API (blobs/trees/commits/refs)
 * rather than the higher-level Contents API. In testing, the Contents API
 * repeatedly served stale data for well over a minute after a commit made
 * via the Git Data API - the two are backed by different caching layers.
 * Writes to manifest.enc/objects/* already went through the Git Data API;
 * routing reads through it too means reads and writes hit the same
 * consistency guarantees. `putFile` (Contents API) is kept only for the
 * one-off salt.txt bootstrap write, which isn't read-after-write sensitive.
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

	/**
	 * Returns null if the file (or the branch itself) does not exist.
	 * Walks branch -> commit -> tree -> ... -> blob entirely through the Git
	 * Data API so this always reflects the latest commit, unlike the
	 * Contents API - see the class-level comment.
	 */
	async getFile(path: string): Promise<RemoteFile | null> {
		const headSha = await this.getBranchHeadSha();
		if (!headSha) return null;
		const rootTreeSha = await this.getCommitTreeSha(headSha);

		const segments = path.split("/");
		let currentTreeSha = rootTreeSha;
		for (let i = 0; i < segments.length - 1; i++) {
			const entries = await this.getTreeCached(currentTreeSha);
			const dirEntry = entries.find((e) => e.path === segments[i] && e.type === "tree");
			if (!dirEntry) return null;
			currentTreeSha = dirEntry.sha;
		}

		const entries = await this.getTreeCached(currentTreeSha);
		const fileEntry = entries.find((e) => e.path === segments[segments.length - 1] && e.type === "blob");
		if (!fileEntry) return null;

		return this.getBlob(fileEntry.sha);
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

	/**
	 * Verifies the token can reach the repo. Deliberately checks repo
	 * existence, not branch existence - a brand new repository has no
	 * commits and therefore no branches yet, and ocsync creates the branch
	 * itself on the first push, so requiring the branch up front would
	 * reject the most common first-time setup.
	 */
	async testConnection(): Promise<void> {
		const url = `${this.repoUrl()}`;
		const res = await fetch(url, { headers: this.authHeaders() });
		if (!res.ok) return this.handleErrorResponse(res, "testConnection");
	}

	// ---- Git Data API (blobs/trees/commits/refs) -------------------------
	// Used to bundle many file changes into a single atomic commit instead
	// of one Contents API call per file.

	private repoUrl(): string {
		return `${this.apiBase}/repos/${this.options.owner}/${this.options.repo}`;
	}

	/**
	 * Returns the commit sha the branch currently points to, or null if the
	 * branch/ref doesn't exist yet. A repository with zero commits returns
	 * 409 "Git Repository is empty" from this endpoint instead of the 404
	 * you'd expect for a missing ref - both mean the same thing here: there
	 * is no branch yet, so treat them identically rather than surfacing the
	 * 409 as a real (ref-moved-concurrently) conflict.
	 */
	async getBranchHeadSha(): Promise<string | null> {
		const url = `${this.repoUrl()}/git/ref/${encodeURIComponent(`heads/${this.options.branch}`)}`;
		const res = await fetch(url, { headers: this.authHeaders(), cache: "no-store" });
		if (res.status === 404 || res.status === 409) return null;
		if (!res.ok) return this.handleErrorResponse(res, "getBranchHeadSha");
		const body = (await res.json()) as { object: { sha: string } };
		return body.object.sha;
	}

	async getCommitTreeSha(commitSha: string): Promise<string> {
		const url = `${this.repoUrl()}/git/commits/${commitSha}`;
		const res = await fetch(url, { headers: this.authHeaders(), cache: "no-store" });
		if (!res.ok) return this.handleErrorResponse(res, "getCommitTreeSha");
		const body = (await res.json()) as { tree: { sha: string } };
		return body.tree.sha;
	}

	/**
	 * Per-instance cache keyed by tree sha (trees are content-addressed, so
	 * this is always safe to reuse) - avoids re-fetching the "objects"
	 * subtree once per file when a single sync pulls/looks up many objects.
	 */
	private treeCache = new Map<string, GitTreeListEntry[]>();

	private async getTreeCached(treeSha: string): Promise<GitTreeListEntry[]> {
		const cached = this.treeCache.get(treeSha);
		if (cached) return cached;
		const entries = await this.getTree(treeSha);
		this.treeCache.set(treeSha, entries);
		return entries;
	}

	/** Non-recursive: lists only the immediate entries of one tree object. */
	async getTree(treeSha: string): Promise<GitTreeListEntry[]> {
		const url = `${this.repoUrl()}/git/trees/${treeSha}`;
		const res = await fetch(url, { headers: this.authHeaders(), cache: "no-store" });
		if (!res.ok) return this.handleErrorResponse(res, "getTree");
		const body = (await res.json()) as { tree: GitTreeListEntry[] };
		return body.tree;
	}

	async getBlob(blobSha: string): Promise<RemoteFile> {
		const url = `${this.repoUrl()}/git/blobs/${blobSha}`;
		const res = await fetch(url, { headers: this.authHeaders(), cache: "no-store" });
		if (!res.ok) return this.handleErrorResponse(res, "getBlob");
		const body = (await res.json()) as { sha: string; content: string; encoding: string };
		const contentBase64 = body.encoding === "base64" ? body.content.replace(/\n/g, "") : btoa(body.content);
		return { sha: body.sha, contentBase64 };
	}

	async createBlob(contentBase64: string): Promise<string> {
		const url = `${this.repoUrl()}/git/blobs`;
		const res = await fetch(url, {
			method: "POST",
			headers: { ...this.authHeaders(), "Content-Type": "application/json" },
			body: JSON.stringify({ content: contentBase64, encoding: "base64" }),
		});
		if (!res.ok) return this.handleErrorResponse(res, "createBlob");
		const body = (await res.json()) as { sha: string };
		return body.sha;
	}

	/**
	 * Creates a new tree. When `baseTreeSha` is provided, only the given
	 * entries are added/changed/removed (sha: null removes a path) - every
	 * other path from the base tree is carried over unchanged.
	 */
	async createTree(baseTreeSha: string | null, entries: GitTreeEntry[]): Promise<string> {
		const url = `${this.repoUrl()}/git/trees`;
		const res = await fetch(url, {
			method: "POST",
			headers: { ...this.authHeaders(), "Content-Type": "application/json" },
			body: JSON.stringify({
				...(baseTreeSha ? { base_tree: baseTreeSha } : {}),
				tree: entries,
			}),
		});
		if (!res.ok) return this.handleErrorResponse(res, "createTree");
		const body = (await res.json()) as { sha: string };
		return body.sha;
	}

	async createCommit(message: string, treeSha: string, parents: string[]): Promise<string> {
		const url = `${this.repoUrl()}/git/commits`;
		const res = await fetch(url, {
			method: "POST",
			headers: { ...this.authHeaders(), "Content-Type": "application/json" },
			body: JSON.stringify({ message, tree: treeSha, parents }),
		});
		if (!res.ok) return this.handleErrorResponse(res, "createCommit");
		const body = (await res.json()) as { sha: string };
		return body.sha;
	}

	/** Creates the branch ref if it doesn't exist yet. */
	async createBranchRef(commitSha: string): Promise<void> {
		const url = `${this.repoUrl()}/git/refs`;
		const res = await fetch(url, {
			method: "POST",
			headers: { ...this.authHeaders(), "Content-Type": "application/json" },
			body: JSON.stringify({ ref: `refs/heads/${this.options.branch}`, sha: commitSha }),
		});
		if (!res.ok) return this.handleErrorResponse(res, "createBranchRef");
	}

	/**
	 * Fast-forwards (or force-updates) the branch ref. Uses `force: false` by
	 * default so a concurrent push from another device surfaces as a 409/422
	 * conflict rather than silently overwriting it.
	 */
	async updateBranchRef(commitSha: string, force = false): Promise<void> {
		const url = `${this.repoUrl()}/git/refs/${encodeURIComponent(`heads/${this.options.branch}`)}`;
		const res = await fetch(url, {
			method: "PATCH",
			headers: { ...this.authHeaders(), "Content-Type": "application/json" },
			body: JSON.stringify({ sha: commitSha, force }),
		});
		if (!res.ok) {
			if (res.status === 422) {
				throw new GitHubConflictError("Branch ref update rejected (not a fast-forward - remote moved concurrently)");
			}
			return this.handleErrorResponse(res, "updateBranchRef");
		}
	}
}

export interface GitTreeEntry {
	path: string;
	mode: "100644";
	type: "blob";
	sha: string | null;
}

/** One entry as returned when *reading* a tree (not the write-side GitTreeEntry above). */
export interface GitTreeListEntry {
	path: string;
	mode: string;
	type: "blob" | "tree" | "commit";
	sha: string;
}

function encodeGitHubPath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}
