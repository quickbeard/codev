// Natural-English list join: "X", "X and Y", "X, Y, and Z".
// Used by both `codev model` (joining configured tool labels in the
// success message) and `codev install`'s Confirm step (joining restore
// commands in the heads-up warning).
export function formatToolList(labels: string[]): string {
	if (labels.length === 0) return "";
	if (labels.length === 1) return labels[0] ?? "";
	if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
	const head = labels.slice(0, -1).join(", ");
	return `${head}, and ${labels[labels.length - 1]}`;
}
