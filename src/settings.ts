import {
	AbstractInputSuggest,
	App,
	PluginSettingTab,
	Setting,
	TFolder,
} from 'obsidian';
import SpacedRepetitionPlugin from './main';

export interface SpacedRepetitionSettings {
	algorithm: 'FSRS' | 'SM2';
	requestRetention: number;
	maximumInterval: number;
	fsrsWeights: number[];
	flashcardTags: string[];
	showIntervalOnButtons: boolean;
	dataFolderPath: string;
}

export const DEFAULT_SETTINGS: SpacedRepetitionSettings = {
	algorithm: 'FSRS',
	requestRetention: 0.9,
	maximumInterval: 3650,
	fsrsWeights: [
		0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18,
		0.05, 0.34, 1.26, 0.29, 2.61,
	],
	flashcardTags: ['#flashcards'],
	showIntervalOnButtons: true,
	dataFolderPath: 'SRS-Data',
};

// מחלקה המציגה רשימת תיקיות קיימות מהכספת עם אפשרות חיפוש
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
	private inputEl: HTMLInputElement;

	constructor(app: App, textInputEl: HTMLInputElement) {
		super(app, textInputEl);
		this.inputEl = textInputEl;
	}

	getSuggestions(inputStr: string): TFolder[] {
		const abstractFiles = this.app.vault.getAllLoadedFiles();
		const folders: TFolder[] = [];
		const lowerInput = inputStr.toLowerCase();

		for (const file of abstractFiles) {
			if (file instanceof TFolder) {
				if (!inputStr || file.path.toLowerCase().includes(lowerInput)) {
					folders.push(file);
				}
			}
		}
		return folders;
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}

	selectSuggestion(folder: TFolder): void {
		this.inputEl.value = folder.path;
		this.inputEl.dispatchEvent(new Event('input'));
		this.close();
	}
}

export class SpacedRepetitionSettingTab extends PluginSettingTab {
	plugin: SpacedRepetitionPlugin;

	constructor(app: App, plugin: SpacedRepetitionPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions() {
		return [];
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('Data Storage Location').setHeading();

		new Setting(containerEl)
			.setName('Data Folder Path')
			.setDesc(
				'Select or search an existing folder in your vault where data will be stored. Leave empty for vault root.',
			)
			.addText((text) => {
				text.setValue(this.plugin.settings.dataFolderPath).onChange(
					async (value) => {
						this.plugin.settings.dataFolderPath = value;
						await this.plugin.saveSettings();
					},
				);
				new FolderSuggest(this.app, text.inputEl);
			});

		new Setting(containerEl)
			.setName('Apply Data Location')
			.setDesc(
				'Click this button to save settings and card data into srs-data.md at the chosen folder path.',
			)
			.addButton((btn) =>
				btn
					.setButtonText('Apply')
					.setCta()
					.onClick(async () => {
						await this.plugin.applyDataLocation();
					}),
			);

		new Setting(containerEl)
			.setName('Spaced Repetition Algorithm')
			.setHeading();

		new Setting(containerEl)
			.setName('Scheduling Algorithm')
			.setDesc('Select the spaced repetition algorithm.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('FSRS', 'FSRS v4.5 (Recommended)')
					.addOption('SM2', 'SM-2 (Classic)')
					.setValue(this.plugin.settings.algorithm)
					.onChange(async (value) => {
						this.plugin.settings.algorithm = value as
							| 'FSRS'
							| 'SM2';
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName('What is FSRS and Target Request Retention?')
			.setHeading();

		const fsrsExplanation = containerEl.createDiv();
		fsrsExplanation.setCssStyles({
			marginBottom: '1.5em',
			padding: '1em',
			backgroundColor: 'var(--background-modifier-form-field)',
			borderRadius: '8px',
		});

		const p1 = fsrsExplanation.createEl('p');
		p1.createEl('b', { text: 'FSRS (Free Spaced Repetition Scheduler)' });
		p1.appendText(
			' is a modern, research-backed algorithm that accurately predicts when you are about to forget information. It learns your memory patterns and adjusts intervals precisely.',
		);

		const p2 = fsrsExplanation.createEl('p');
		p2.createEl('b', { text: 'Target Request Retention:' });
		p2.appendText(
			' This is the most crucial metric. It determines the probability that you will remember a card when it is due for review.',
		);

		const ul = fsrsExplanation.createEl('ul');

		const li1 = ul.createEl('li');
		li1.createEl('b', { text: 'Default is 0.90 (90%)' });
		li1.appendText(
			' - The algorithm schedules the card exactly when you have a 90% chance of remembering it.',
		);

		const li2 = ul.createEl('li');
		li2.appendText('Increasing to ');
		li2.createEl('b', { text: '0.95' });
		li2.appendText(
			' means you will see cards more frequently (shorter intervals) to ensure you rarely forget.',
		);

		const li3 = ul.createEl('li');
		li3.appendText('Decreasing to ');
		li3.createEl('b', { text: '0.80' });
		li3.appendText(
			' means you will see cards less often, saving time, but you might forget more cards. The sweet spot for efficiency is usually between 0.85 and 0.92.',
		);

		new Setting(containerEl)
			.setName('Target Request Retention')
			.setDesc(
				'Desired probability of recalling a card (0.70 to 0.97). Recommended to keep at 0.90.',
			)
			.addSlider((slider) =>
				slider
					.setLimits(0.7, 0.97, 0.01)
					.setValue(this.plugin.settings.requestRetention)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.requestRetention = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Maximum Interval (Days)')
			.setDesc('Upper limit for scheduled review intervals in days.')
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.maximumInterval))
					.onChange(async (value) => {
						const val = parseInt(value, 10);
						if (!isNaN(val)) {
							this.plugin.settings.maximumInterval = val;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName('Flashcard Deck Tags')
			.setDesc(
				'Comma-separated list of tags identifying flashcard notes (e.g., #flashcards).',
			)
			.addText((text) =>
				text
					.setValue(this.plugin.settings.flashcardTags.join(', '))
					.onChange(async (value) => {
						this.plugin.settings.flashcardTags = value
							.split(',')
							.map((t) => t.trim())
							.filter((t) => t.length > 0);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Show Interval Previews')
			.setDesc(
				'Display projected next review times directly on the rating buttons (Again, Hard, Good, Easy).',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showIntervalOnButtons)
					.onChange(async (value) => {
						this.plugin.settings.showIntervalOnButtons = value;
						await this.plugin.saveSettings();
					}),
			);

		if (this.plugin.settings.algorithm === 'FSRS') {
			new Setting(containerEl)
				.setName('FSRS Model Weights (Advanced)')
				.setHeading();

			containerEl.createEl('p', {
				text: 'These 17 weights control the math behind your memory decay. It is highly recommended NOT to change these unless you have generated optimized weights from an external tracker (like Anki).',
				cls: 'setting-item-description',
			});

			const weightDescriptions = [
				"W0: Initial Stability (Again) - Higher value = longer initial wait after pressing 'Again'. (Range: 0.1 - 40.0)",
				"W1: Initial Stability (Hard) - Higher value = longer initial wait after pressing 'Hard'. (Range: 0.1 - 40.0)",
				"W2: Initial Stability (Good) - Higher value = longer initial wait after pressing 'Good'. (Range: 0.1 - 40.0)",
				"W3: Initial Stability (Easy) - Higher value = longer initial wait after pressing 'Easy'. (Range: 0.1 - 40.0)",
				'W4: Initial Difficulty - Higher value = new cards are treated as harder, so future intervals will grow slower. (Range: 1.0 - 10.0)',
				"W5: Difficulty Multiplier - Higher value = your very first rating (Good/Hard) alters the card's difficulty more drastically. (Range: 0.01 - 5.0)",
				"W6: Difficulty Drift - Higher value = the card's difficulty adapts faster based on your future ratings. (Range: 0.01 - 5.0)",
				'W7: Stability Tuning - Internal mathematical tuning parameter (leave default). (Range: 0.0 - 0.5)',
				'W8: Stability Increase Base - Higher value = intervals grow much faster after correct answers. (Range: 0.0 - 3.0)',
				'W9: Stability Decay - Higher value = intervals grow slower if the card is already highly stable. (Range: 0.0 - 1.0)',
				'W10: Retrievability Multiplier - Higher value = remembering a card you were just about to forget gives a massive interval boost. (Range: 0.01 - 2.0)',
				"W11: Lapse Stability Base - Higher value = you retain more stability (longer next interval) even after pressing 'Again'. (Range: 0.01 - 5.0)",
				'W12: Lapse Difficulty Penalty - Higher value = forgetting a card punishes its future interval growth more. (Range: 0.01 - 0.5)',
				'W13: Lapse Stability Decay - Higher value = highly stable cards lose a lot more stability when forgotten. (Range: 0.01 - 1.0)',
				'W14: Lapse Retrievability Multiplier - Higher value = forgetting a card long after its due date retains more stability. (Range: 0.01 - 4.0)',
				"W15: Hard Penalty - Higher value = punishes interval growth more heavily when you press 'Hard'. (Range: 0.0 - 1.0)",
				"W16: Easy Bonus - Higher value = rewards interval growth more heavily when you press 'Easy'. (Range: 1.0 - 4.0)",
			];

			weightDescriptions.forEach((desc, index) => {
				new Setting(containerEl)
					.setName(`Weight ${index}`)
					.setDesc(desc)
					.addText((text) =>
						text
							.setValue(
								String(this.plugin.settings.fsrsWeights[index]),
							)
							.onChange(async (value) => {
								const val = parseFloat(value);
								if (!isNaN(val)) {
									this.plugin.settings.fsrsWeights[index] =
										val;
									await this.plugin.saveSettings();
								}
							}),
					);
			});
		}
	}
}
