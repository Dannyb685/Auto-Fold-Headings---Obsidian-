import { Plugin, MarkdownView, App, PluginSettingTab, Setting } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { foldEffect, unfoldEffect, foldable, foldedRanges } from '@codemirror/language';

interface AutoFoldSettings {
    foldLevel: string;
    delay: number;
}

const DEFAULT_SETTINGS: AutoFoldSettings = {
    foldLevel: 'fold-all',
    delay: 500
}

export default class AutoFoldPlugin extends Plugin {
    settings: AutoFoldSettings;

    async onload() {
        await this.loadSettings();

        this.addCommand({
            id: 'auto-fold-current-file',
            name: 'Fold current file',
            callback: () => {
                this.applyFoldLevel(this.settings.foldLevel);
            }
        });

        this.addCommand({
            id: 'auto-fold-all',
            name: 'Fold all',
            callback: () => {
                // @ts-ignore
                this.app.commands.executeCommandById('editor:fold-all');
            }
        });

        for (let i = 1; i <= 6; i++) {
            const level = i;
            this.addCommand({
                id: `auto-fold-level-${level}`,
                name: `Toggle fold H${level}`,
                callback: () => {
                    this.toggleFoldAtLevel(level);
                }
            });
        }

        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (file) {
                    setTimeout(() => {
                        this.applyFoldLevel(this.settings.foldLevel);
                    }, this.settings.delay);
                }
            })
        );

        this.addSettingTab(new AutoFoldSettingTab(this.app, this));
    }

    private getCmEditor(): EditorView | null {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return null;
        // @ts-ignore - access internal CM6 editor
        return (view.editor as any).cm as EditorView ?? null;
    }

    toggleFoldAtLevel(targetLevel: number) {
        const cm = this.getCmEditor();
        if (!cm) return;

        const state = cm.state;
        const doc = state.doc;
        const folded = foldedRanges(state);

        const foldableItems: { range: { from: number; to: number } }[] = [];

        for (let i = 1; i <= doc.lines; i++) {
            const line = doc.line(i);
            const match = line.text.match(/^(#{1,6})\s/);
            if (match && match[1].length === targetLevel) {
                const range = foldable(state, line.from, line.to);
                if (range) foldableItems.push({ range });
            }
        }

        if (foldableItems.length === 0) return;

        // If ALL headings at this level are folded → unfold; otherwise → fold
        const allFolded = foldableItems.every(({ range }) => {
            let found = false;
            folded.between(range.from, range.from + 1, (rFrom) => {
                if (rFrom === range.from) { found = true; return false; }
            });
            return found;
        });

        const effects = foldableItems.map(({ range }) =>
            allFolded ? unfoldEffect.of(range) : foldEffect.of(range)
        );

        cm.dispatch({ effects });
    }

    applyFoldLevel(level: string) {
        if (level === 'fold-all') {
            // @ts-ignore
            this.app.commands.executeCommandById('editor:fold-all');
            return;
        }

        const targetLevel = parseInt(level);
        if (isNaN(targetLevel)) return;

        const cm = this.getCmEditor();
        if (!cm) return;

        const state = cm.state;
        const doc = state.doc;
        const effects = [];

        for (let i = 1; i <= doc.lines; i++) {
            const line = doc.line(i);
            const match = line.text.match(/^(#{1,6})\s/);
            if (match && match[1].length === targetLevel) {
                const range = foldable(state, line.from, line.to);
                if (range) effects.push(foldEffect.of(range));
            }
        }

        if (effects.length > 0) cm.dispatch({ effects });
    }

    onunload() {

    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
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

        containerEl.createEl('h2', { text: 'Auto Fold Settings' });

        new Setting(containerEl)
            .setName('Fold Level')
            .setDesc('Select which level of headings to fold when opening a file.')
            .addDropdown(dropdown => dropdown
                .addOption('fold-all', 'Fold All')
                .addOption('1', 'Level 1 (H1)')
                .addOption('2', 'Level 2 (H2)')
                .addOption('3', 'Level 3 (H3)')
                .addOption('4', 'Level 4 (H4)')
                .addOption('5', 'Level 5 (H5)')
                .addOption('6', 'Level 6 (H6)')
                .setValue(this.plugin.settings.foldLevel)
                .onChange(async (value) => {
                    this.plugin.settings.foldLevel = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Delay (ms)')
            .setDesc('Delay before folding (in milliseconds). Increase this if folding is inconsistent.')
            .addSlider(slider => slider
                .setLimits(0, 2000, 50)
                .setValue(this.plugin.settings.delay)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.delay = value;
                    await this.plugin.saveSettings();
                }));
    }
}
