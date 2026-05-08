import { Box, Text } from "ink";
import { VERSION } from "@/lib/const.js";

const LOGO = [
	" ██████╗ ██████╗ ██████╗ ███████╗██╗   ██╗",
	"██╔════╝██╔═══██╗██╔══██╗██╔════╝██║   ██║",
	"██║     ██║   ██║██║  ██║█████╗  ██║   ██║",
	"██║     ██║   ██║██║  ██║██╔══╝  ╚██╗ ██╔╝",
	"╚██████╗╚██████╔╝██████╔╝███████╗ ╚████╔╝ ",
	" ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝  ╚═══╝  ",
].join("\n");

const LOGO_WIDTH = 42;

export function Banner() {
	return (
		<Box alignItems="flex-start" flexDirection="column">
			<Text bold color="cyan">
				{LOGO}
			</Text>
			<Box
				marginTop={1}
				marginBottom={1}
				justifyContent="center"
				width={LOGO_WIDTH}
			>
				<Text>{"AI Coding Agent Hub "}</Text>
				<Text dimColor>v{VERSION}</Text>
			</Box>
		</Box>
	);
}
