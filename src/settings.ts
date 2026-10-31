import {
	AbstractInputSuggest,
	App,
	PluginSettingTab,
	Setting,
	TFolder,
} from 'obsidian';
import SpacedRepetitionPlugin from './main';
import type { GameId, GameMusicConfig } from './music';
import { renderRemoteSettings, type RemotePreset } from './remote';
import { renderSpeechSettings, type SpeechEngine } from './speech';

export type DuplicateMode = 'exact' | 'firstLine';

// ---- Blast game (נתונים נשמרים בקובץ blast-data.md) ----
export interface BlastData {
	highScore: number;
	bestStreak: number;
	games: number;
	// משחק Match: הזמן הטוב ביותר (בשניות) לכל חפיסה, ומספר המשחקים
	matchBest: Record<string, number>;
	matchGames: number;
	// משחק Hangman: הרצף הטוב ביותר לכל חפיסה, ומספר המשחקים
	hangmanBest: Record<string, number>;
	hangmanGames: number;
	// משחק Aliens: הניקוד הגבוה ביותר ומספר המשחקים
	aliensHigh: number;
	aliensGames: number;
	// הזמן המהיר ביותר (בשניות) שבו המשחק הושלם; 0 = עדיין לא הושלם
	aliensBestTime: number;
	// משחק Sword: הזמן המהיר ביותר ומספר המשחקים
	swordBest: number;
	swordGames: number;
}

export const defaultBlastData = (): BlastData => ({
	highScore: 0,
	bestStreak: 0,
	games: 0,
	matchBest: {},
	matchGames: 0,
	hangmanBest: {},
	hangmanGames: 0,
	aliensHigh: 0,
	aliensGames: 0,
	aliensBestTime: 0,
	swordBest: 0,
	swordGames: 0,
});

export interface SpacedRepetitionSettings {
	requestRetention: number;
	maximumInterval: number;
	fsrsWeights: number[];
	flashcardTags: string[];
	hintTags: string[];
	duplicateMode: DuplicateMode;
	showIntervalOnButtons: boolean;
	dataFolderPath: string;
	// ---- Blast game (העדפות; נתוני המשחק נשמרים ב-blast-data.md) ----
	blastSound: boolean;
	// תיקייה לקובץ blast-data.md. ריק = אותה תיקייה של srs-data.md
	blastDataFolderPath: string;
	// שדה ישן (גרסה קודמת) - מועבר אוטומטית ל-blast-data.md
	blastHighScore?: number;
	// ---- פתיחת עיצובים וכלי נשק לפי ההתקדמות ב-review (ראו rewards.ts) ----
	rewardMetric: 'completed' | 'recent';
	// הבחירה בכל משחק; -1 = תמיד הטוב ביותר שפתוח
	blastShip: number;
	matchTheme: number;
	hangmanTheme: number;
	aliensWeapon: number;
	swordBlade: number;
	// ---- מוזיקת רקע (ראו music.ts) ----
	// מפתח סודי שפותח את כל העיצובים וכלי הנשק (ראו rewards.ts). אין לו ממשק
	unlockKey?: string;
	musicVolume: number;
	gameMusic?: Partial<Record<GameId, GameMusicConfig>>;
	// ---- שלט רחוק ב-review (ראו remote.ts) ----
	remoteEnabled: boolean;
	remoteToast: boolean;
	remoteAcceptManual: boolean;
	// הקשה כפולה כקלט נפרד; כבוי = כל הקשה מיידית
	remoteDoublePress: boolean;
	// מתקן את כיוון הסוויפ של השלט כשהמסך מסובב, כדי שכל כפתור יישאר אותו דבר
	remoteFixRotation: boolean;
	// פריסט לכל שלט (קישורים וספים); רק אחד פעיל. ראו remotePresets ב-remote.ts
	remotePresets?: RemotePreset[];
	remoteActivePreset?: string;
	// מתי הפריסטים שונו לאחרונה (ms). ראו reconcileRemote ב-remote.ts
	remoteStamp?: number;
	// ---- הקראה בקול ב-review (ראו speech.ts) ----
	ttsEnabled: boolean;
	// auto = קולות המכשיר אם יש, אחרת מקוון (ב-Obsidian לאנדרואיד אין קולות מכשיר)
	ttsEngine: SpeechEngine;
	ttsReadAnswer: boolean;
	ttsAnnounce: boolean;
	ttsRate: number;
	// voiceURI של הקול שנבחר; ריק = ברירת המחדל של המכשיר
	ttsVoiceHe: string;
	ttsVoiceEn: string;
	// Google Cloud Text-to-Speech: מפתח API, וקול לכל שפה (ריק = ברירת המחדל של Google)
	ttsGoogleKey: string;
	ttsCloudVoiceHe: string;
	ttsCloudVoiceEn: string;
}

export const DEFAULT_SETTINGS: SpacedRepetitionSettings = {
	requestRetention: 0.9,
	maximumInterval: 3650,
	fsrsWeights: [
		0.4, 0.6, 2.4, 5.8, 4.93, 0.94, 0.86, 0.01, 1.49, 0.14, 0.94, 2.18,
		0.05, 0.34, 1.26, 0.29, 2.61,
	],
	flashcardTags: ['#flashcards'],
	hintTags: ['#hint'],
	duplicateMode: 'exact',
	showIntervalOnButtons: true,
	dataFolderPath: 'SRS-Data',
	blastSound: true,
	blastDataFolderPath: '',
	rewardMetric: 'completed',
	blastShip: -1,
	matchTheme: -1,
	hangmanTheme: -1,
	aliensWeapon: -1,
	swordBlade: -1,
	musicVolume: 0.5,
	remoteEnabled: true,
	remoteToast: true,
	remoteAcceptManual: false,
	remoteDoublePress: true,
	remoteFixRotation: true,
	ttsEnabled: false,
	ttsEngine: 'auto',
	ttsReadAnswer: true,
	ttsAnnounce: true,
	ttsRate: 1,
	ttsVoiceHe: '',
	ttsVoiceEn: '',
	ttsGoogleKey: '',
	ttsCloudVoiceHe: '',
	ttsCloudVoiceEn: '',
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

	// עוצר את ההאזנה לשלט (Listen / Test) ואת ההקראה כשההגדרות נסגרות או מצוירות מחדש
	private remoteCleanup: (() => void) | null = null;

	hide(): void {
		this.remoteCleanup?.();
		this.remoteCleanup = null;
	}

	display(): void {
		const { containerEl } = this;
		this.remoteCleanup?.();
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

		new Setting(containerEl).setName('Decks & Cards').setHeading();

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
			.setName('Hint Deck Tags')
			.setDesc(
				'Comma-separated list of tags (e.g., #hint). If a deck note contains one of these tags in addition to a flashcard tag, every card in it gets a "Show Hint" button: the lines between the first line of the card and the ? line are treated as the hint and hidden until requested.',
			)
			.addText((text) =>
				text
					.setPlaceholder('#hint')
					.setValue(this.plugin.settings.hintTags.join(', '))
					.onChange(async (value) => {
						this.plugin.settings.hintTags = value
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

		new Setting(containerEl).setName('Duplicate Removal').setHeading();

		new Setting(containerEl)
			.setName('Duplicate Detection Mode')
			.setDesc(
				'How the "Fix Cards Spacing and Remove Duplicates" command decides that two cards in the active note are duplicates. Works with any language (Hebrew, English, etc.); comparison ignores letter case, extra spaces and invisible characters. The first occurrence is always kept.',
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption(
						'exact',
						'Identical content (front, hint and answer)',
					)
					.addOption(
						'firstLine',
						'Same first line (ignore hint and answer)',
					)
					.setValue(this.plugin.settings.duplicateMode)
					.onChange(async (value) => {
						this.plugin.settings.duplicateMode =
							value === 'firstLine' ? 'firstLine' : 'exact';
						await this.plugin.saveSettings();
					}),
			);

		const stopRemote = renderRemoteSettings(containerEl, this.plugin, () =>
			this.display(),
		);
		const stopSpeech = renderSpeechSettings(containerEl, this.plugin);
		this.remoteCleanup = () => {
			stopRemote();
			stopSpeech();
		};

		new Setting(containerEl)
			.setName('Games')
			.setDesc(
				'The games are practice only. They never change your review schedule. Music is set up inside each game, under Music in its menu.',
			)
			.setHeading();

		new Setting(containerEl)
			.setName('Game sound effects')
			.setDesc('Play sound effects in the action games.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.blastSound)
					.onChange(async (value) => {
						this.plugin.settings.blastSound = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Unlocks are based on')
			.setDesc(
				'Your regular reviews unlock ships, card and figure designs, weapons and swords in the games. Choose what is counted: every 50 opens the next item. An unlock is lost again when the number drops below its requirement.',
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption('completed', 'Cards reviewed and not due')
					.addOption('recent', 'Reviews in the last 24 hours')
					.setValue(this.plugin.settings.rewardMetric)
					.onChange(async (value) => {
						this.plugin.settings.rewardMetric =
							value === 'recent' ? 'recent' : 'completed';
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Blast Data Folder Path')
			.setDesc(
				'Folder for blast-data.md (records of all the games) and for the game-music folder. Leave empty to keep them next to the card data (same folder as srs-data.md).',
			)
			.addText((text) => {
				text.setPlaceholder('Same as card data')
					.setValue(this.plugin.settings.blastDataFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.blastDataFolderPath = value;
						await this.plugin.saveSettings();
					});
				new FolderSuggest(this.app, text.inputEl);
			});

		new Setting(containerEl)
			.setName('Apply Blast Data Location')
			.setDesc(
				`Click to write the Blast data to: ${this.plugin.getBlastDataFilePath()}`,
			)
			.addButton((btn) =>
				btn
					.setButtonText('Apply')
					.setCta()
					.onClick(async () => {
						await this.plugin.applyBlastDataLocation();
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName('Reset Game Data')
			.setDesc(
				`Blast - high score: ${this.plugin.blastData.highScore} · Best streak: ${this.plugin.blastData.bestStreak} · Games: ${this.plugin.blastData.games}. Match - games: ${this.plugin.blastData.matchGames}. Hangman - games: ${this.plugin.blastData.hangmanGames}. Aliens - high score: ${this.plugin.blastData.aliensHigh} · Games: ${this.plugin.blastData.aliensGames}. Sword - games: ${this.plugin.blastData.swordGames}. Resetting also clears the Match best times, Hangman best streaks, and the Aliens and Sword best times.`,
			)
			.addButton((btn) =>
				btn
					.setButtonText('Reset')
					.setWarning()
					.onClick(async () => {
						this.plugin.blastData = defaultBlastData();
						await this.plugin.saveBlastData();
						this.display();
					}),
			);

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
								this.plugin.settings.fsrsWeights[index] = val;
								await this.plugin.saveSettings();
							}
						}),
				);
		});
	}
}
