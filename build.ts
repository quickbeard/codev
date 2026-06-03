import { chmodSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build, type Plugin } from "esbuild";

const ROOT = import.meta.dirname;

const shimDevtools: Plugin = {
	name: "shim-react-devtools",
	setup(build) {
		build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
			path: "react-devtools-core",
			namespace: "shim",
		}));
		build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
			contents: "export default undefined;",
			loader: "js",
		}));
	},
};

// The source uses path-aliased imports like `@/lib/upload.js` (TypeScript ESM
// convention: ".js" extension that maps to ".ts" at build time). esbuild's
// `alias` option remaps the prefix, and `resolveExtensions` covers the .js→.ts
// fallback for the rest of the import graph.
const result = await build({
	entryPoints: [resolve(ROOT, "src/index.tsx")],
	outfile: resolve(ROOT, "dist/index.js"),
	bundle: true,
	platform: "node",
	target: "node22.5",
	format: "esm",
	plugins: [shimDevtools],
	alias: {
		"@": resolve(ROOT, "src"),
	},
	resolveExtensions: [".tsx", ".ts", ".jsx", ".js", ".json"],
	// Bundled-CJS deps (e.g. `signal-exit`) call `require()` at runtime, which
	// doesn't exist in ESM output. Shim it via `createRequire`. We also emit the
	// shebang here so esbuild doesn't double it against the one in src/index.tsx.
	banner: {
		js: `#!/usr/bin/env node
import { createRequire as __createRequire } from "node:module";
const require = __createRequire(import.meta.url);`,
	},
	logLevel: "info",
});

if (result.errors.length > 0) {
	for (const err of result.errors) console.error(err);
	process.exit(1);
}

// esbuild does not preserve the source file's exec bit; restore it so the
// emitted bundle is runnable via the `codev` bin shim.
const outPath = resolve(ROOT, "dist/index.js");
chmodSync(outPath, 0o755);

const size = readFileSync(outPath).byteLength;
console.log(`Bundled ${outPath} (${size} bytes)`);
