import { App, MarkdownView, Plugin, PluginSettingTab, Setting } from "obsidian";
import { EditorView } from "@codemirror/view";
import { foldEffect, unfoldEffect, foldable, foldedRanges } from "@codemirror/language";

/**
 * Auto Fold — folds headings when a note is opened.
 *
 * Editing and reading mode are configured separately: each has its own
 * on/off switch and its own heading level.
 *
 * Two rules this plugin will not break:
 *   1. Auto-fold only ever COLLAPSES. It never unfolds, so headings you
 *      opened by hand stay open, and list/frontmatter folds are untouched.
 *   2. Auto-fold never PERSISTS. Obsidian saves one fold state per note
 *      (shared by both modes); writing to it here would silently overwrite
 *      the folds you built yourself.
 */

type FoldLevel = "all" | "1" | "2" | "3" | "4" | "5" | "6";

interface ModeSettings {
	enabled: boolean;
	level: FoldLevel;
}

interface AutoFoldSettings {
	editing: ModeSettings;
	reading: ModeSettings;
	delay: number;
}

/** Below this, the reading-mode renderer often is not ready in time. */
const MIN_DELAY = 150;

const DEFAULT_SETTINGS: AutoFoldSettings = {
	editing: { enabled: true, level: "all" },
	reading: { enabled: true, level: "all" },
	delay: MIN_DELAY,
};

/** The shape written by versions before per-mode settings existed. */
interface LegacySettings {
	foldLevel?: string;
	delay?: number;
}

export function migrateSettings(raw: unknown): AutoFoldSettings {
	const data = (raw ?? {}) as Partial<AutoFoldSettings> & LegacySettings;

	// Legacy 'fold-all' becomes 'all'; legacy '1'..'6' carry over unchanged.
	const legacyLevel: FoldLevel =
		data.foldLevel === undefined
			? "all"
			: data.foldLevel === "fold-all"
				? "all"
				: (/^[1-6]$/.test(data.foldLevel) ? (data.foldLevel as FoldLevel) : "all");

	const mode = (current: unknown, fallback: ModeSettings): ModeSettings => {
		const m = (current ?? {}) as Partial<ModeSettings>;
		return {
			enabled: typeof m.enabled === "boolean" ? m.enabled : fallback.enabled,
			level: typeof m.level === "string" && /^(all|[1-6])$/.test(m.level)
				? (m.level as FoldLevel)
				: fallback.level,
		};
	};

	const inherited: ModeSettings = { enabled: true, level: legacyLevel };

	return {
		editing: mode(data.editing, inherited),
		reading: mode(data.reading, inherited),
		// The build that has actually been running used 150ms. An older saved
		// value of 100 would give the renderer less time than it needs.
		delay: Math.max(MIN_DELAY, typeof data.delay === "number" ? data.delay : MIN_DELAY),
	};
}

export default class AutoFoldPlugin extends Plugin {
	settings: AutoFoldSettings;

	/** One shared timer, so a burst of file-opens folds once. */
	private foldTimer: number | null = null;
	/** One shared retry handle, so retries cannot pile up. */
	private retryTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file) this.scheduleAutoFold();
			})
		);

		this.addCommand({
			id: "auto-fold-current-file",
			name: "Fold current file",
			callback: () => this.foldActiveView(),
		});

		for (let level = 1; level <= 6; level++) {
			this.addCommand({
				id: `auto-fold-level-${level}`,
				name: `Toggle fold H${level}`,
				callback: () => this.toggleFoldAtLevel(level),
			});
		}

		this.addSettingTab(new AutoFoldSettingTab(this.app, this));
	}

	onunload(): void {
		this.clearTimers();
	}

	private clearTimers(): void {
		window.clearTimeout(this.foldTimer ?? undefined);
		window.clearTimeout(this.retryTimer ?? undefined);
		this.foldTimer = null;
		this.retryTimer = null;
	}

	private scheduleAutoFold(): void {
		this.clearTimers();
		this.foldTimer = window.setTimeout(() => this.foldActiveView(), this.settings.delay);
	}

	/** Fold the active note using whichever mode it is currently showing. */
	private foldActiveView(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		// Live Preview and Source both report "source" — both are editing.
		const reading = view.getMode() === "preview";
		const mode = reading ? this.settings.reading : this.settings.editing;
		if (!mode.enabled) return;

		const minLevel = mode.level === "all" ? 1 : parseInt(mode.level, 10);
		if (reading) this.foldReading(view, minLevel, 12);
		else this.foldEditing(view, minLevel);
	}

	// #region -> reading mode

	/**
	 * Collapse preview sections at `minLevel` and deeper.
	 *
	 * Retries while a render is in flight: Obsidian queues its own
	 * applyFoldInfo through onRendered, and anything folded before that
	 * drains gets overwritten. A pane that is not visible never renders, so
	 * the retry count is bounded rather than open-ended.
	 */
	private foldReading(view: MarkdownView, minLevel: number, triesLeft: number): void {
		const renderer = (view as unknown as { previewMode?: { renderer?: PreviewRenderer } })
			.previewMode?.renderer;

		const ready =
			!!renderer &&
			renderer.rendered === null &&
			Array.isArray(renderer.sections) &&
			renderer.sections.length > 0;

		if (!ready) {
			if (triesLeft <= 0) return;
			window.clearTimeout(this.retryTimer ?? undefined);
			this.retryTimer = window.setTimeout(
				() => this.foldReading(view, minLevel, triesLeft - 1),
				50
			);
			return;
		}

		let collapsedAny = false;
		for (const section of renderer.sections) {
			// level 1..6 are headings; 7 is a body block, 0 a header/footer sentinel.
			if (section.level >= minLevel && section.level <= 6 && !section.headingCollapsed) {
				section.setCollapsed(true);
				collapsedAny = true;
			}
		}
		if (!collapsedAny) return;

		renderer.updateShownSections();
		renderer.updateVirtualDisplay();
		// Deliberately no onFoldChange() — see the header comment.
	}

	// #region -> editing mode

	/**
	 * Fold headings at `minLevel` and deeper in the editor.
	 *
	 * Additive on purpose. Clearing existing folds first would also wipe
	 * folded lists and frontmatter, which share the same fold set.
	 */
	private foldEditing(view: MarkdownView, minLevel: number): void {
		const cm = this.getCmEditor(view);
		if (!cm) return;

		const { state } = cm;
		const alreadyFolded = foldedRanges(state);
		const effects = [];

		for (let i = 1; i <= state.doc.lines; i++) {
			const line = state.doc.line(i);
			const match = line.text.match(/^(#{1,6})\s/);
			if (!match || match[1].length < minLevel) continue;

			const range = foldable(state, line.from, line.to);
			if (range && !this.isFolded(alreadyFolded, range.from)) {
				effects.push(foldEffect.of(range));
			}
		}

		if (effects.length > 0) cm.dispatch({ effects });
	}

	// #region -> shared

	private getCmEditor(view: MarkdownView): EditorView | null {
		return (view.editor as unknown as { cm?: EditorView }).cm ?? null;
	}

	private isFolded(folded: ReturnType<typeof foldedRanges>, from: number): boolean {
		let found = false;
		folded.between(from, from + 1, (rangeFrom) => {
			if (rangeFrom === from) {
				found = true;
				return false;
			}
		});
		return found;
	}

	/**
	 * Manual command: fold every heading at exactly `targetLevel`, or unfold
	 * them if they are all already folded. Editing mode only, since it works
	 * on CodeMirror ranges.
	 */
	toggleFoldAtLevel(targetLevel: number): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || view.getMode() === "preview") return;

		const cm = this.getCmEditor(view);
		if (!cm) return;

		const { state } = cm;
		const folded = foldedRanges(state);
		const ranges: { from: number; to: number }[] = [];

		for (let i = 1; i <= state.doc.lines; i++) {
			const line = state.doc.line(i);
			const match = line.text.match(/^(#{1,6})\s/);
			if (match && match[1].length === targetLevel) {
				const range = foldable(state, line.from, line.to);
				if (range) ranges.push(range);
			}
		}
		if (ranges.length === 0) return;

		const allFolded = ranges.every((range) => this.isFolded(folded, range.from));
		cm.dispatch({
			effects: ranges.map((range) =>
				allFolded ? unfoldEffect.of(range) : foldEffect.of(range)
			),
		});
	}

	async loadSettings(): Promise<void> {
		this.settings = migrateSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

/** The private preview-renderer surface this plugin relies on. */
interface PreviewSection {
	level: number;
	headingCollapsed: boolean;
	setCollapsed(collapsed: boolean): void;
}

interface PreviewRenderer {
	/** null when idle; an array while a render pass is in flight. */
	rendered: unknown[] | null;
	sections: PreviewSection[];
	updateShownSections(): void;
	updateVirtualDisplay(): void;
}

class AutoFoldSettingTab extends PluginSettingTab {
	plugin: AutoFoldPlugin;

	constructor(app: App, plugin: AutoFoldPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.addModeSection("Editing mode", "editing");
		this.addModeSection("Reading mode", "reading");

		new Setting(containerEl).setName("Timing").setHeading();

		new Setting(containerEl)
			.setName("Delay")
			.setDesc(
				`How long to wait after a note opens before folding, in milliseconds. ` +
					`Increase this if folding is inconsistent. Minimum ${MIN_DELAY}.`
			)
			.addSlider((slider) =>
				slider
					.setLimits(MIN_DELAY, 2000, 50)
					.setValue(this.plugin.settings.delay)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.delay = value;
						await this.plugin.saveSettings();
					})
			);
	}

	private addModeSection(title: string, key: "editing" | "reading"): void {
		const { containerEl } = this;
		const mode = this.plugin.settings[key];

		new Setting(containerEl).setName(title).setHeading();

		new Setting(containerEl)
			.setName("Fold on open")
			.setDesc(`Fold headings when a note opens in ${title.toLowerCase()}.`)
			.addToggle((toggle) =>
				toggle.setValue(mode.enabled).onChange(async (value) => {
					mode.enabled = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Heading level")
			.setDesc("Headings at this level and deeper get collapsed.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("all", "All headings")
					.addOption("1", "H1 and deeper")
					.addOption("2", "H2 and deeper")
					.addOption("3", "H3 and deeper")
					.addOption("4", "H4 and deeper")
					.addOption("5", "H5 and deeper")
					.addOption("6", "H6 only")
					.setValue(mode.level)
					.onChange(async (value) => {
						mode.level = value as FoldLevel;
						await this.plugin.saveSettings();
					})
			);
	}
}
