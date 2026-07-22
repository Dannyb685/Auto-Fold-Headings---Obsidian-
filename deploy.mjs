/**
 * Copy the built plugin into the vault so the repo and the installed copy
 * cannot silently diverge (they had, badly, before this existed).
 *
 *   npm run deploy
 *
 * Only build outputs are copied. data.json (your settings) is never touched.
 */
import { copyFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const VAULT_PLUGIN_DIR =
	process.env.OBSIDIAN_PLUGIN_DIR ??
	"/Users/danielbergholz/Documents/Second Brain/.obsidian/plugins/obsidian-auto-fold";

const FILES = ["main.js", "manifest.json"];

if (!existsSync(VAULT_PLUGIN_DIR)) {
	mkdirSync(VAULT_PLUGIN_DIR, { recursive: true });
	console.log(`created ${VAULT_PLUGIN_DIR}`);
}

for (const file of FILES) {
	if (!existsSync(file)) {
		console.error(`missing build output: ${file} — run the build first`);
		process.exit(1);
	}
	copyFileSync(file, join(VAULT_PLUGIN_DIR, file));
	console.log(`copied ${file}`);
}

console.log(`\ndeployed to ${VAULT_PLUGIN_DIR}`);
console.log("Reload the plugin in Obsidian to pick it up.");
