/** Builds "Note (conflict YYYY-MM-DD-HHmm).md" from "Note.md". */
export function conflictCopyPath(path: string, now: Date = new Date()): string {
	const stamp = formatConflictStamp(now);
	const slashIndex = path.lastIndexOf("/");
	const dotIndex = path.lastIndexOf(".");
	if (dotIndex > slashIndex) {
		return `${path.slice(0, dotIndex)} (conflict ${stamp})${path.slice(dotIndex)}`;
	}
	return `${path} (conflict ${stamp})`;
}

function formatConflictStamp(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(
		date.getMinutes()
	)}`;
}
