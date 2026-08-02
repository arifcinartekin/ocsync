/**
 * All encryption in ocsync goes through this module. Only the Web Crypto API
 * (crypto.subtle) is used so the exact same code runs on Electron (desktop)
 * and Capacitor (iOS/Android) without any native modules.
 *
 * Format on disk (what actually gets written to a GitHub blob):
 *   base64( iv[12 bytes] || ciphertext-with-gcm-tag )
 *
 * The IV is not secret and travels alongside the ciphertext. The PBKDF2 salt
 * is also not secret (stored in plaintext as salt.txt in the repo) - only the
 * user's password and the key derived from it are sensitive, and neither is
 * ever written to disk or logged.
 */

export const PBKDF2_ITERATIONS = 250_000;
const SALT_LENGTH_BYTES = 16;
const IV_LENGTH_BYTES = 12;

export function generateSalt(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(SALT_LENGTH_BYTES));
}

export async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
	const passwordKey = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveKey"]
	);

	return crypto.subtle.deriveKey(
		{
			name: "PBKDF2",
			salt: salt as BufferSource,
			iterations: PBKDF2_ITERATIONS,
			hash: "SHA-256",
		},
		passwordKey,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"]
	);
}

export async function encryptBytes(key: CryptoKey, plaintext: ArrayBuffer): Promise<Uint8Array> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
	const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plaintext);
	const combined = new Uint8Array(iv.length + ciphertext.byteLength);
	combined.set(iv, 0);
	combined.set(new Uint8Array(ciphertext), iv.length);
	return combined;
}

/**
 * Throws if the ciphertext cannot be authenticated - i.e. wrong password or
 * corrupted data. Callers must surface this as a clear "wrong password or
 * corrupted data" error rather than silently producing garbage.
 */
export async function decryptBytes(key: CryptoKey, combined: Uint8Array): Promise<ArrayBuffer> {
	if (combined.length < IV_LENGTH_BYTES) {
		throw new Error("Ciphertext too short to contain an IV");
	}
	const iv = combined.slice(0, IV_LENGTH_BYTES);
	const ciphertext = combined.slice(IV_LENGTH_BYTES);
	return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ciphertext as BufferSource);
}

export async function encryptString(key: CryptoKey, plaintext: string): Promise<Uint8Array> {
	return encryptBytes(key, new TextEncoder().encode(plaintext).buffer as ArrayBuffer);
}

export async function decryptToString(key: CryptoKey, combined: Uint8Array): Promise<string> {
	const plainBuf = await decryptBytes(key, combined);
	return new TextDecoder().decode(plainBuf);
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	return bytesToHex(new Uint8Array(digest));
}

export function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
	}
	return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}
