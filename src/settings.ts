import { App, PluginSettingTab, Setting } from 'obsidian';
import SpacedRepetitionPlugin from './main';

export interface SpacedRepetitionSettings {
	algorithm: 'FSRS' | 'SM2';
	requestRetention: number;
	maximumInterval: number;
	fsrsWeights: number[];
	flashcardTags: string[];
	showIntervalOnButtons: boolean;
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
};

export class SpacedRepetitionSettingTab extends PluginSettingTab {
	plugin: SpacedRepetitionPlugin;

	constructor(app: App, plugin: SpacedRepetitionPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', {
			text: 'Spaced Repetition Plugin Settings',
		});

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

		containerEl.createEl('h3', {
			text: 'What is FSRS and Target Request Retention?',
		});
		const fsrsExplanation = containerEl.createEl('div');
		fsrsExplanation.style.marginBottom = '1.5em';
		fsrsExplanation.style.padding = '1em';
		fsrsExplanation.style.backgroundColor =
			'var(--background-modifier-form-field)';
		fsrsExplanation.style.borderRadius = '8px';
		fsrsExplanation.innerHTML = `
			<p><b>FSRS (Free Spaced Repetition Scheduler)</b> is a modern, research-backed algorithm that accurately predicts when you are about to forget information. It learns your memory patterns and adjusts intervals precisely.</p>
			<p><b>Target Request Retention:</b> This is the most crucial metric. It determines the probability that you will remember a card when it is due for review.
			<ul>
				<li><b>Default is 0.90 (90%)</b> - The algorithm schedules the card exactly when you have a 90% chance of remembering it.</li>
				<li>Increasing to <b>0.95</b> means you will see cards more frequently (shorter intervals) to ensure you rarely forget.</li>
				<li>Decreasing to <b>0.80</b> means you will see cards less often, saving time, but you might forget more cards. The sweet spot for efficiency is usually between 0.85 and 0.92.</li>
			</ul></p>
		`;

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
			containerEl.createEl('h3', {
				text: 'FSRS Model Weights (Advanced)',
			});
			containerEl.createEl('p', {
				text: 'These 17 weights control the math behind your memory decay. It is highly recommended NOT to change these unless you have generated optimized weights from an external tracker (like Anki).',
				cls: 'setting-item-description',
			});

			const weightDescriptions = [
				"W0: Initial Stability (Again) - Higher value = longer initial wait after pressing 'Again'.",
				"W1: Initial Stability (Hard) - Higher value = longer initial wait after pressing 'Hard'.",
				"W2: Initial Stability (Good) - Higher value = longer initial wait after pressing 'Good'.",
				"W3: Initial Stability (Easy) - Higher value = longer initial wait after pressing 'Easy'.",
				'W4: Initial Difficulty - Higher value = new cards are treated as harder, so future intervals will grow slower.',
				"W5: Difficulty Multiplier - Higher value = your very first rating (Good/Hard) alters the card's difficulty more drastically.",
				"W6: Difficulty Drift - Higher value = the card's difficulty adapts faster based on your future ratings.",
				'W7: Stability Tuning - Internal mathematical tuning parameter (leave default).',
				'W8: Stability Increase Base - Higher value = intervals grow much faster after correct answers.',
				'W9: Stability Decay - Higher value = intervals grow slower if the card is already highly stable.',
				'W10: Retrievability Multiplier - Higher value = remembering a card you were just about to forget gives a massive interval boost.',
				"W11: Lapse Stability Base - Higher value = you retain more stability (longer next interval) even after pressing 'Again'.",
				'W12: Lapse Difficulty Penalty - Higher value = forgetting a card punishes its future interval growth more.',
				'W13: Lapse Stability Decay - Higher value = highly stable cards lose a lot more stability when forgotten.',
				'W14: Lapse Retrievability Multiplier - Higher value = forgetting a card long after its due date retains more stability.',
				"W15: Hard Penalty - Higher value = punishes interval growth more heavily when you press 'Hard'.",
				"W16: Easy Bonus - Higher value = rewards interval growth more heavily when you press 'Easy'.",
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
