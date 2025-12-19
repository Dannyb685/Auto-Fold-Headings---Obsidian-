import { Plugin, MarkdownView, App, PluginSettingTab, Setting } from 'obsidian';

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

        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (file) {
                    // We add a delay to ensure the file is fully loaded and the editor is ready
                    setTimeout(() => {
                        // Check if the current view is a Markdown view
                        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                        if (view) {
                            // Execute the command based on settings
                            try {
                                let commandId = 'editor:fold-all';
                                if (this.settings.foldLevel !== 'fold-all') {
                                    commandId = `editor:fold-level-${this.settings.foldLevel}`;
                                }
                                // @ts-ignore - access internal commands
                                this.app.commands.executeCommandById(commandId);
                            } catch (error) {
                                console.error("Auto Fold: Error executing fold command", error);
                            }
                        }
                    }, this.settings.delay);
                }
            })
        );

        this.addSettingTab(new AutoFoldSettingTab(this.app, this));
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
