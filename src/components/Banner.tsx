import { Box, Text } from "ink";
import { VERSION } from "@/lib/const.js";
import { t } from "@/lib/i18n.js";
import { terminalIsLight } from "@/lib/terminal-theme.js";

// CoDev Code's lowercase "codev" pixel wordmark (codev-code
// packages/tui/src/logo.ts): "co" on the left, "dev" on the right, no drop
// shadow. Kept split so each half takes its own brand color.
const CO = ["         ", "█▀▀▀ █▀▀█", "█    █  █", "▀▀▀▀ ▀▀▀▀"];
const DEV = [
	"   ▄          ",
	"█▀▀█ █▀▀█ █  █",
	"█  █ █▀▀▀ █  █",
	"▀▀▀▀ ▀▀▀▀  ▀▀ ",
];

// Brand palette from the CoDev landing page (--color-brand-navy / -red), the
// same values codev-code's logo uses.
const BRAND_NAVY = "#19224c";
const BRAND_RED = "#ee0033";

export function Banner() {
	// Match codev-code's TUI logo: "co" is the brand navy on a light terminal
	// and the terminal's default foreground on a dark or unknown one — the
	// readable counterpart of navy-on-white. "dev" is always the brand red.
	const coColor = terminalIsLight() ? BRAND_NAVY : undefined;

	return (
		<Box alignItems="flex-start" flexDirection="column">
			{CO.map((left, index) => (
				<Text key={left + DEV[index]} bold>
					<Text color={coColor}>{left}</Text>{" "}
					<Text color={BRAND_RED}>{DEV[index]}</Text>
				</Text>
			))}
			<Box marginBottom={1}>
				<Text>{`${t("banner.tagline")} `}</Text>
				<Text dimColor>v{VERSION}</Text>
			</Box>
		</Box>
	);
}
