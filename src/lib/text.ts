import { formatList } from "@/lib/i18n.js";

// Natural-language list join: "X", "X and Y", "X, Y, and Z" in English;
// "X, Y và Z" in Vietnamese.
//
// Used by `codevhub model` (joining configured tool labels in the success
// message), `codevhub install`'s Confirm step, and `formatCodegraphTargets` —
// whose result is interpolated into a translated sentence, which is why the
// join has to follow the active locale rather than English's comma rules.
//
// The rules themselves now live in lib/i18n.ts, backed by Intl.ListFormat. This
// stays as the name the non-UI callers already use; its English output is
// byte-identical to the hand-rolled version it replaced.
export function formatToolList(labels: string[]): string {
	return formatList(labels);
}
