import { decryptToString, encryptString } from "./crypto";
import { emptyManifest, Manifest, MANIFEST_VERSION } from "./types";

export async function encryptManifest(key: CryptoKey, manifest: Manifest): Promise<Uint8Array> {
	return encryptString(key, JSON.stringify(manifest));
}

/**
 * Throws if the ciphertext cannot be authenticated (wrong password / corrupt
 * data) or the decrypted payload isn't a valid manifest.
 */
export async function decryptManifest(key: CryptoKey, combined: Uint8Array): Promise<Manifest> {
	let text: string;
	try {
		text = await decryptToString(key, combined);
	} catch {
		throw new Error("Could not decrypt remote manifest - wrong password or corrupted data");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("Decrypted manifest is not valid JSON - wrong password or corrupted data");
	}

	if (
		typeof parsed !== "object" ||
		parsed === null ||
		typeof (parsed as Manifest).version !== "number" ||
		typeof (parsed as Manifest).files !== "object"
	) {
		throw new Error("Decrypted manifest has an unexpected shape - wrong password or corrupted data");
	}

	return parsed as Manifest;
}

export { emptyManifest, MANIFEST_VERSION };
