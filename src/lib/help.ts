import { VERSION } from "@/lib/const.js";
import { t } from "@/lib/i18n.js";

export function printVersion() {
	console.log(`${VERSION}`);
}

/**
 * The whole screen is a single message per locale rather than one key per line.
 * Command names, flags and their arguments are fixed tokens the user types, so
 * only the descriptions beside them change — and the column alignment has to be
 * maintained as a unit, which per-line keys make impossible to see or review.
 */
export function printHelp() {
	console.log(t("help.body"));
}
