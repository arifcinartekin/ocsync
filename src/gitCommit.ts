import { mapWithConcurrency } from "./concurrency";
import { GitHubClient, GitTreeEntry } from "./github";

export interface PendingBlob {
	path: string;
	contentBase64: string;
}

const BLOB_UPLOAD_CONCURRENCY = 6;

/**
 * Bundles blob creation + a single tree/commit/ref-update into one atomic
 * commit, so a sync cycle that touches many files produces one commit
 * instead of one per file. `deletedPaths` removes paths from the tree
 * (used from Phase 4 onward for tombstone cleanup / remote-driven deletes).
 *
 * Throws GitHubConflictError if the branch moved since we read its head -
 * callers should treat that as "retry next cycle", never force-push.
 */
export async function commitChanges(
	client: GitHubClient,
	message: string,
	blobs: PendingBlob[],
	deletedPaths: string[] = []
): Promise<string> {
	if (blobs.length === 0 && deletedPaths.length === 0) {
		throw new Error("commitChanges called with no changes");
	}

	const headSha = await client.getBranchHeadSha();
	const baseTreeSha = headSha ? await client.getCommitTreeSha(headSha) : null;

	const blobShas = await mapWithConcurrency(blobs, BLOB_UPLOAD_CONCURRENCY, async (blob) => ({
		path: blob.path,
		sha: await client.createBlob(blob.contentBase64),
	}));

	const entries: GitTreeEntry[] = [
		...blobShas.map((b) => ({ path: b.path, mode: "100644" as const, type: "blob" as const, sha: b.sha })),
		...deletedPaths.map((path) => ({ path, mode: "100644" as const, type: "blob" as const, sha: null })),
	];

	const newTreeSha = await client.createTree(baseTreeSha, entries);
	const commitSha = await client.createCommit(message, newTreeSha, headSha ? [headSha] : []);

	if (headSha) {
		await client.updateBranchRef(commitSha, false);
	} else {
		await client.createBranchRef(commitSha);
	}

	return commitSha;
}
