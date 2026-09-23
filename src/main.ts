import {
	App,
	Modal,
	Notice,
	Plugin,
	TFile,
	MarkdownRenderer,
	Component,
} from 'obsidian';
import {
	SpacedRepetitionSettings,
	DEFAULT_SETTINGS,
	SpacedRepetitionSettingTab,
} from './settings';

// ============================================================================
// 1. Types & Interfaces
// ============================================================================

export type Rating = 1 | 2 | 3 | 4;
export type CardType =
	| 'SingleLine'
	| 'SingleLineReversed'
	| 'MultiLine'
	| 'MultiLineReversed'
	| 'Cloze';

export interface CardSchedulingMetadata {
	cardId: string;
	due: number;
	interval: number;
	ease: number;
	difficulty: number;
	stability: number;
	lapses: number;
	repetition: number;
	lastReview: number;
}

export interface Flashcard {
	id: string;
	filePath: string;
	deckName: string;
	type: CardType;
	front: string;
	back: string;
	lineStart: number;
	lineEnd: number;
	rawContent: string;
}

// ============================================================================
// 2. Algorithm Engine (SRSEngine - FSRS v4.5 & SM-2)
// ============================================================================

export class SRSEngine {
	static calculateNextState(
		cardMeta: CardSchedulingMetadata | undefined,
		rating: Rating,
		settings: SpacedRepetitionSettings,
	): CardSchedulingMetadata {
		const now = Date.now();
		const existing: CardSchedulingMetadata = cardMeta || {
			cardId: '',
			due: now,
			interval: 0,
			ease: 2.5,
			difficulty: 5.0,
			stability: 0.0,
			lapses: 0,
			repetition: 0,
			lastReview: now,
		};

		if (settings.algorithm === 'SM2') {
			return this.calculateSM2(existing, rating, now);
		} else {
			return this.calculateFSRS(existing, rating, now, settings);
		}
	}

	private static calculateSM2(
		meta: CardSchedulingMetadata,
		rating: Rating,
		now: number,
	): CardSchedulingMetadata {
		let ease = meta.ease;
		let interval = meta.interval;
		let repetition = meta.repetition;
		let lapses = meta.lapses;

		const q = rating === 1 ? 1 : rating === 2 ? 3 : rating === 3 ? 4 : 5;

		if (q < 3) {
			repetition = 0;
			interval = 1;
			lapses += 1;
		} else {
			if (repetition === 0) {
				interval = 1;
			} else if (repetition === 1) {
				interval = 6;
			} else {
				interval = Math.round(interval * ease);
			}
			repetition += 1;
		}

		ease = ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
		if (ease < 1.3) ease = 1.3;

		const due = now + interval * 24 * 60 * 60 * 1000;

		return {
			...meta,
			due,
			interval,
			ease,
			repetition,
			lapses,
			lastReview: now,
		};
	}

	private static calculateFSRS(
		meta: CardSchedulingMetadata,
		rating: Rating,
		now: number,
		settings: SpacedRepetitionSettings,
	): CardSchedulingMetadata {
		const w = settings.fsrsWeights;
		let { stability, difficulty, repetition, lapses, lastReview } = meta;

		const elapsedDays =
			lastReview > 0
				? Math.max(0, (now - lastReview) / (1000 * 60 * 60 * 24))
				: 0;

		if (repetition === 0 || stability === 0) {
			stability = w[rating - 1] ?? 1.0;
			difficulty = Math.min(
				Math.max(
					(w[4] ?? 4.93) -
						Math.exp((w[5] ?? 0.94) * (rating - 1)) +
						1,
					1,
				),
				10,
			);
			repetition = 1;
		} else {
			const retrievability = Math.pow(
				1 + (1 / 9) * (elapsedDays / stability),
				-1,
			);
			const deltaD = -(w[6] ?? 0.0) * (rating - 3);
			difficulty = Math.min(Math.max(difficulty + deltaD, 1), 10);

			if (rating === 1) {
				lapses += 1;
				stability =
					(w[11] ?? 1.0) *
					Math.pow(difficulty, -(w[12] ?? 0.5)) *
					Math.pow(stability, w[13] ?? 1.0) *
					Math.exp((w[14] ?? 0.0) * (1 - retrievability));
			} else {
				const hardPenalty = rating === 2 ? (w[15] ?? 1.0) : 1.0;
				const easyBonus = rating === 4 ? (w[16] ?? 1.0) : 1.0;
				const inc =
					Math.exp(w[8] ?? 0.0) *
					(11 - difficulty) *
					Math.pow(stability, -(w[9] ?? 0.5)) *
					(Math.exp((w[10] ?? 0.0) * (1 - retrievability)) - 1) *
					hardPenalty *
					easyBonus;
				stability = stability * (1 + inc);
			}
			repetition += 1;
		}

		let interval =
			(stability / (1 / 9)) *
			(Math.pow(settings.requestRetention, -1) - 1);

		if (rating === 1) {
			interval = 5 / (24 * 60);
		}

		interval = Math.min(interval, settings.maximumInterval);

		const due = now + interval * 24 * 60 * 60 * 1000;

		return {
			...meta,
			due,
			interval,
			difficulty,
			stability,
			repetition,
			lapses,
			lastReview: now,
		};
	}

	static formatInterval(days: number): string {
		if (days < 1 / 24) return `${Math.round(days * 24 * 60)}m`;
		if (days < 1) return `${Math.round(days * 24)}h`;
		if (days < 30) return `${Math.round(days)}d`;
		if (days < 365) return `${(days / 30).toFixed(1)}mo`;
		return `${(days / 365).toFixed(1)}y`;
	}
}

// ============================================================================
// 3. Markdown Parser (FlashcardParser)
// ============================================================================

export class FlashcardParser {
	static async parseFile(
		file: TFile,
		app: App,
		validTags: string[],
	): Promise<Flashcard[]> {
		const content = await app.vault.read(file);
		const lines = content.split('\n');
		const cardsMap = new Map<string, Flashcard>();

		const hasTag = validTags.some((tag) => content.includes(tag));
		if (!hasTag) return [];

		const deckName = file.basename;

		const isCardDelimiter = (line: string | undefined): boolean => {
			if (line === undefined) return false;
			const t = line.trim();
			return (
				t === '?' || t === '??' || t.includes('::') || t.includes(':::')
			);
		};

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line === undefined) continue;

			if (line.includes(':::') && !line.startsWith('//')) {
				const parts = line.split(':::');
				if (
					parts.length === 2 &&
					parts[0] !== undefined &&
					parts[1] !== undefined
				) {
					const q = parts[0].trim();
					const a = parts[1].trim();

					const idFwd = this.generateHash(
						`${file.path}:fwd:${q}:${a}`,
					);
					cardsMap.set(idFwd, {
						id: idFwd,
						filePath: file.path,
						deckName,
						type: 'SingleLineReversed',
						front: q,
						back: a,
						lineStart: i,
						lineEnd: i,
						rawContent: line,
					});

					const idRev = this.generateHash(
						`${file.path}:rev:${q}:${a}`,
					);
					cardsMap.set(idRev, {
						id: idRev,
						filePath: file.path,
						deckName,
						type: 'SingleLineReversed',
						front: a,
						back: q,
						lineStart: i,
						lineEnd: i,
						rawContent: line,
					});
					continue;
				}
			}

			if (line.includes('::') && !line.startsWith('//')) {
				const parts = line.split('::');
				if (
					parts.length === 2 &&
					parts[0] !== undefined &&
					parts[1] !== undefined
				) {
					const q = parts[0].trim();
					const a = parts[1].trim();
					const id = this.generateHash(
						`${file.path}:single:${q}:${a}`,
					);
					cardsMap.set(id, {
						id,
						filePath: file.path,
						deckName,
						type: 'SingleLine',
						front: q,
						back: a,
						lineStart: i,
						lineEnd: i,
						rawContent: line,
					});
					continue;
				}
			}

			if (line.includes('==') && !line.startsWith('//')) {
				const clozeRegex = /==(.*?)==/g;
				let match: RegExpExecArray | null;
				while ((match = clozeRegex.exec(line)) !== null) {
					const answer = match[1] ?? '';
					const question = line.replace(match[0], '[...]');
					const id = this.generateHash(
						`${file.path}:cloze:${question}:${answer}`,
					);
					cardsMap.set(id, {
						id,
						filePath: file.path,
						deckName,
						type: 'Cloze',
						front: question,
						back: answer,
						lineStart: i,
						lineEnd: i,
						rawContent: line,
					});
				}
			}

			if (line.trim() === '?' || line.trim() === '??') {
				const isReversed = line.trim() === '??';
				let qStart = i - 1;

				while (
					qStart >= 0 &&
					lines[qStart]?.trim() !== '' &&
					!isCardDelimiter(lines[qStart])
				) {
					qStart--;
				}
				qStart++;

				let aEnd = i + 1;
				while (
					aEnd < lines.length &&
					lines[aEnd]?.trim() !== '' &&
					!isCardDelimiter(lines[aEnd])
				) {
					aEnd++;
				}
				aEnd--;

				if (qStart < i && aEnd > i) {
					const qText = lines.slice(qStart, i).join('\n').trim();
					const aText = lines
						.slice(i + 1, aEnd + 1)
						.join('\n')
						.trim();
					const raw = lines.slice(qStart, aEnd + 1).join('\n');

					const idFwd = this.generateHash(
						`${file.path}:multi:${qText}:${aText}`,
					);
					cardsMap.set(idFwd, {
						id: idFwd,
						filePath: file.path,
						deckName,
						type: isReversed ? 'MultiLineReversed' : 'MultiLine',
						front: qText,
						back: aText,
						lineStart: qStart,
						lineEnd: aEnd,
						rawContent: raw,
					});

					if (isReversed) {
						const idRev = this.generateHash(
							`${file.path}:multi-rev:${qText}:${aText}`,
						);
						cardsMap.set(idRev, {
							id: idRev,
							filePath: file.path,
							deckName,
							type: 'MultiLineReversed',
							front: aText,
							back: qText,
							lineStart: qStart,
							lineEnd: aEnd,
							rawContent: raw,
						});
					}
				}
			}
		}

		return Array.from(cardsMap.values());
	}

	private static generateHash(str: string): string {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash |= 0;
		}
		return 'card_' + Math.abs(hash).toString(36);
	}
}

// ============================================================================
// 4. UI Modals
// ============================================================================

export class ReviewModal extends Modal {
	private plugin: SpacedRepetitionPlugin;
	private queue: Flashcard[];
	private currentIndex: number = 0;
	private isAnswerShown: boolean = false;
	private isEditing: boolean = false;
	private component: Component;

	constructor(app: App, plugin: SpacedRepetitionPlugin, queue: Flashcard[]) {
		super(app);
		this.plugin = plugin;
		this.queue = queue;
		this.component = new Component();
	}

	onOpen(): void {
		this.component.load();
		this.modalEl.addClass('srs-review-modal-wrapper');
		this.renderCurrentCard();
	}

	onClose(): void {
		this.component.unload();
		this.contentEl.empty();
	}

	private async renderCurrentCard(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();

		if (this.currentIndex >= this.queue.length) {
			contentEl.createEl('h2', { text: '🎉 Deck Completed!' });
			contentEl.createEl('p', {
				text: 'You have reviewed all due flashcards in this session.',
			});
			const closeBtn = contentEl.createEl('button', {
				text: 'Close',
				cls: 'mod-cta',
			});
			closeBtn.onclick = () => this.close();
			return;
		}

		const card = this.queue[this.currentIndex];
		if (!card) return;

		const cardMeta = this.plugin.store[card.id];

		const headerEl = contentEl.createDiv({ cls: 'srs-header-bar' });
		headerEl.style.display = 'flex';
		headerEl.style.justifyContent = 'space-between';
		headerEl.style.alignItems = 'center';
		headerEl.style.marginBottom = '1em';

		headerEl.createSpan({
			text: `Deck: ${card.deckName}`,
			cls: 'srs-deck-title',
		});
		headerEl.createSpan({
			text: `Card ${this.currentIndex + 1} / ${this.queue.length}`,
			cls: 'srs-card-progress',
		});

		const editBtn = headerEl.createEl('button', {
			text: this.isEditing ? 'Cancel Edit' : 'Edit Card',
		});
		editBtn.onclick = () => {
			this.isEditing = !this.isEditing;
			this.renderCurrentCard();
		};

		const bodyEl = contentEl.createDiv({ cls: 'srs-card-body' });
		bodyEl.style.minHeight = '150px';
		bodyEl.style.padding = '1em';
		bodyEl.style.border = '1px solid var(--background-modifier-border)';
		bodyEl.style.borderRadius = '8px';

		if (this.isEditing) {
			const editArea = bodyEl.createEl('textarea');
			editArea.value = card.rawContent;
			editArea.style.width = '100%';
			editArea.style.height = '120px';

			const saveBtn = bodyEl.createEl('button', {
				text: 'Save Changes',
				cls: 'mod-cta',
			});
			saveBtn.style.marginTop = '0.5em';
			saveBtn.onclick = async () => {
				await this.saveCardModification(card, editArea.value);
				this.isEditing = false;
				this.renderCurrentCard();
			};
			return;
		}

		const frontEl = bodyEl.createDiv({ cls: 'srs-front-content' });
		await MarkdownRenderer.render(
			this.app,
			card.front,
			frontEl,
			card.filePath,
			this.component,
		);

		if (this.isAnswerShown) {
			bodyEl.createEl('hr');
			const backEl = bodyEl.createDiv({ cls: 'srs-back-content' });
			await MarkdownRenderer.render(
				this.app,
				card.back,
				backEl,
				card.filePath,
				this.component,
			);
		}

		const bottomBar = contentEl.createDiv({ cls: 'srs-bottom-bar' });
		bottomBar.style.marginTop = '1.5em';

		if (!this.isAnswerShown) {
			const showBtn = bottomBar.createEl('button', {
				text: 'Show Answer',
				cls: 'mod-cta',
			});
			showBtn.style.width = '100%';
			showBtn.onclick = () => {
				this.isAnswerShown = true;
				this.renderCurrentCard();
			};
		} else {
			const buttonGrid = bottomBar.createDiv({ cls: 'srs-button-grid' });
			buttonGrid.style.display = 'grid';
			buttonGrid.style.gridTemplateColumns = 'repeat(4, 1fr)';
			buttonGrid.style.gap = '8px';

			const ratings: { label: string; rating: Rating; color: string }[] =
				[
					{ label: 'Again', rating: 1, color: 'var(--text-error)' },
					{ label: 'Hard', rating: 2, color: 'var(--text-warning)' },
					{ label: 'Good', rating: 3, color: 'var(--text-accent)' },
					{ label: 'Easy', rating: 4, color: 'var(--text-success)' },
				];

			for (const item of ratings) {
				const nextMeta = SRSEngine.calculateNextState(
					cardMeta,
					item.rating,
					this.plugin.settings,
				);
				const intervalText = SRSEngine.formatInterval(
					nextMeta.interval,
				);

				const btn = buttonGrid.createEl('button');
				btn.style.display = 'flex';
				btn.style.flexDirection = 'column';
				btn.style.alignItems = 'center';

				const labelSpan = btn.createSpan({ text: item.label });
				labelSpan.style.color = item.color;
				labelSpan.style.fontWeight = 'bold';

				if (this.plugin.settings.showIntervalOnButtons) {
					const intervalSpan = btn.createSpan({ text: intervalText });
					intervalSpan.style.fontSize = '0.8em';
					intervalSpan.style.opacity = '0.7';
				}

				btn.onclick = async () => {
					await this.applyRating(card, nextMeta);
				};
			}
		}
	}

	private async applyRating(
		card: Flashcard,
		nextMeta: CardSchedulingMetadata,
	): Promise<void> {
		nextMeta.cardId = card.id;
		this.plugin.store[card.id] = nextMeta;
		await this.plugin.saveStore();
		this.currentIndex++;
		this.isAnswerShown = false;
		this.renderCurrentCard();
	}

	private async saveCardModification(
		card: Flashcard,
		newContent: string,
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(card.filePath);
		if (file instanceof TFile) {
			const content = await this.app.vault.read(file);
			const lines = content.split('\n');
			lines.splice(
				card.lineStart,
				card.lineEnd - card.lineStart + 1,
				newContent,
			);
			await this.app.vault.modify(file, lines.join('\n'));
			card.rawContent = newContent;
			card.front = newContent;
			new Notice('Card edited and saved successfully.');
		}
	}
}

export class DashboardModal extends Modal {
	private plugin: SpacedRepetitionPlugin;
	private filterText: string = '';
	private allCards: Flashcard[] = [];
	private cardsMap: Map<string, Flashcard> = new Map();

	constructor(app: App, plugin: SpacedRepetitionPlugin) {
		super(app);
		this.plugin = plugin;
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass('srs-dashboard-modal');
		this.contentEl.empty();
		this.contentEl.createEl('h2', {
			text: '🔄 Scanning decks and cleaning data...',
		});

		await this.loadAndSyncCards();
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async loadAndSyncCards(): Promise<void> {
		const files = this.app.vault.getMarkdownFiles();
		this.allCards = [];
		this.cardsMap.clear();

		for (const file of files) {
			const cards = await FlashcardParser.parseFile(
				file,
				this.app,
				this.plugin.settings.flashcardTags,
			);
			for (const c of cards) {
				this.allCards.push(c);
				this.cardsMap.set(c.id, c);
			}
		}

		// Garbage Collection: Delete store entries for cards that no longer exist
		let storeChanged = false;
		for (const storedId in this.plugin.store) {
			if (!this.cardsMap.has(storedId)) {
				delete this.plugin.store[storedId];
				storeChanged = true;
			}
		}

		if (storeChanged) {
			await this.plugin.saveStore();
			console.log(
				'Spaced Repetition: Cleaned up deleted cards from data.json',
			);
		}
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		// --- SECTION 1: DECKS TO REVIEW ---
		contentEl.createEl('h2', { text: '📚 Decks to Review' });

		const now = Date.now();
		const deckMap = new Map<string, Flashcard[]>();

		for (const card of this.allCards) {
			const meta = this.plugin.store[card.id];
			const isDue = !meta || meta.due <= now;

			if (isDue) {
				if (!deckMap.has(card.deckName)) deckMap.set(card.deckName, []);
				deckMap.get(card.deckName)!.push(card);
			}
		}

		if (deckMap.size === 0) {
			contentEl.createEl('p', {
				text: '🎉 No cards are due right now! Great job.',
			});
		} else {
			const decksContainer = contentEl.createDiv({
				cls: 'srs-decks-container',
			});
			decksContainer.style.display = 'grid';
			decksContainer.style.gridTemplateColumns =
				'repeat(auto-fill, minmax(250px, 1fr))';
			decksContainer.style.gap = '10px';
			decksContainer.style.marginBottom = '2em';

			for (const [deckName, dueCards] of deckMap.entries()) {
				const deckCard = decksContainer.createDiv();
				deckCard.style.border =
					'1px solid var(--background-modifier-border)';
				deckCard.style.padding = '12px';
				deckCard.style.borderRadius = '8px';
				deckCard.style.display = 'flex';
				deckCard.style.justifyContent = 'space-between';
				deckCard.style.alignItems = 'center';

				const infoDiv = deckCard.createDiv();
				infoDiv.createEl('strong', { text: deckName });
				infoDiv.createEl('div', {
					text: `${dueCards.length} cards due`,
					cls: 'srs-deck-count',
				}).style.fontSize = '0.85em';

				const startBtn = deckCard.createEl('button', {
					text: 'Start',
					cls: 'mod-cta',
				});
				startBtn.onclick = () => {
					this.close();
					new ReviewModal(this.app, this.plugin, dueCards).open();
				};
			}
		}

		contentEl.createEl('hr');

		// --- SECTION 2: REVIEWED CARDS STATUS ---
		contentEl.createEl('h2', { text: '📊 Reviewed Flashcards Status' });

		const storeEntries = Object.values(this.plugin.store);

		if (storeEntries.length === 0) {
			contentEl.createEl('p', {
				text: 'No cards have been reviewed yet.',
			});
			return;
		}

		const searchInput = contentEl.createEl('input', {
			type: 'text',
			placeholder: 'Search reviewed cards by prompt or deck...',
		});
		searchInput.style.width = '100%';
		searchInput.style.marginBottom = '1em';
		searchInput.style.padding = '0.5em';
		searchInput.value = this.filterText;

		const tableContainer = contentEl.createDiv({
			cls: 'srs-table-container',
		});
		tableContainer.style.maxHeight = '400px';
		tableContainer.style.overflowY = 'auto';

		searchInput.oninput = (e) => {
			this.filterText = (
				e.target as HTMLInputElement
			).value.toLowerCase();
			this.renderTable(tableContainer, storeEntries);
		};

		this.renderTable(tableContainer, storeEntries);
	}

	private renderTable(
		container: HTMLElement,
		storeEntries: CardSchedulingMetadata[],
	): void {
		container.empty();
		const now = Date.now();

		const filteredEntries = storeEntries.filter((meta) => {
			const card = this.cardsMap.get(meta.cardId);
			if (!this.filterText) return true;
			const frontText = card
				? card.front.toLowerCase()
				: meta.cardId.toLowerCase();
			const deckText = card ? card.deckName.toLowerCase() : '';
			return (
				frontText.includes(this.filterText) ||
				deckText.includes(this.filterText)
			);
		});

		if (filteredEntries.length === 0) {
			container.createEl('p', {
				text: 'No matching reviewed cards found.',
			});
			return;
		}

		const table = container.createEl('table');
		table.style.width = '100%';
		table.style.borderCollapse = 'collapse';

		const thead = table.createEl('thead');
		const headerRow = thead.createEl('tr');
		headerRow.style.borderBottom =
			'2px solid var(--background-modifier-border)';

		['Card Prompt', 'Deck', 'Interval', 'Status'].forEach((h) => {
			const th = headerRow.createEl('th', { text: h });
			th.style.padding = '8px';
			th.style.textAlign = 'left';
		});

		const tbody = table.createEl('tbody');
		filteredEntries.sort((a, b) => a.due - b.due);

		for (const meta of filteredEntries) {
			const card = this.cardsMap.get(meta.cardId);
			const row = tbody.createEl('tr');
			row.style.borderBottom =
				'1px solid var(--background-modifier-border)';

			const tdPrompt = row.createEl('td');
			tdPrompt.style.padding = '8px';
			tdPrompt.textContent = card
				? card.front.length > 45
					? card.front.substring(0, 45) + '...'
					: card.front
				: 'Unknown (Deleted)';

			const tdDeck = row.createEl('td');
			tdDeck.style.padding = '8px';
			tdDeck.textContent = card ? card.deckName : 'Unknown';

			const tdInterval = row.createEl('td');
			tdInterval.style.padding = '8px';
			tdInterval.textContent = SRSEngine.formatInterval(meta.interval);

			const tdStatus = row.createEl('td');
			tdStatus.style.padding = '8px';

			const diffMs = meta.due - now;
			if (diffMs <= 0) {
				tdStatus.textContent = '⚡ Due Now';
				tdStatus.style.color = 'var(--text-error)';
				tdStatus.style.fontWeight = 'bold';
			} else {
				const timeStr = this.formatTimeRemaining(diffMs);
				tdStatus.textContent = `⏳ ${timeStr}`;
				tdStatus.style.color = 'var(--text-success)';
			}
		}
	}

	private formatTimeRemaining(ms: number): string {
		const totalMinutes = Math.floor(ms / (1000 * 60));
		const totalHours = Math.floor(totalMinutes / 60);
		const days = Math.floor(totalHours / 24);

		if (days > 0) {
			const remainingHours = totalHours % 24;
			return remainingHours > 0
				? `${days}d ${remainingHours}h`
				: `${days}d`;
		}
		if (totalHours > 0) {
			const remainingMins = totalMinutes % 60;
			return remainingMins > 0
				? `${totalHours}h ${remainingMins}m`
				: `${totalHours}h`;
		}
		return `${Math.max(1, totalMinutes)}m`;
	}
}

// ============================================================================
// 5. Main Plugin Entrypoint
// ============================================================================

export default class SpacedRepetitionPlugin extends Plugin {
	settings!: SpacedRepetitionSettings;
	store: Record<string, CardSchedulingMetadata> = {};

	async onload(): Promise<void> {
		await this.loadSettings();
		await this.loadStore();

		this.addRibbonIcon(
			'clipboard-check',
			'Spaced Repetition Dashboard',
			async () => {
				new DashboardModal(this.app, this).open();
			},
		);

		this.addCommand({
			id: 'open-srs-dashboard',
			name: 'Open Spaced Repetition Dashboard',
			callback: async () => {
				new DashboardModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: 'separate-cards-active-note',
			name: 'Separate Cards with Spaces in Active Note',
			callback: async () => {
				await this.separateCardsInActiveNote();
			},
		});

		this.addCommand({
			id: 'remove-duplicates-active-note',
			name: 'Remove Duplicate Cards in Active Note',
			callback: async () => {
				await this.removeDuplicatesInActiveNote();
			},
		});

		this.addSettingTab(new SpacedRepetitionSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async loadStore(): Promise<void> {
		const data = await this.loadData();
		if (data && data.store) {
			this.store = data.store;
		}
	}

	async saveStore(): Promise<void> {
		const currentData = (await this.loadData()) || {};
		currentData.store = this.store;
		await this.saveData(currentData);
	}

	async separateCardsInActiveNote(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice('No active markdown file found.');
			return;
		}

		const content = await this.app.vault.read(file);
		const lines = content.split('\n');
		const newLines: string[] = [];

		let inAnswer = false;
		let lastDelimiterIndex = -1;

		const isCardDelimiter = (l: string | undefined): boolean => {
			if (!l) return false;
			const t = l.trim();
			return (
				t === '?' || t === '??' || t.includes('::') || t.includes(':::')
			);
		};

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line === undefined) continue;

			const trimmed = line.trim();

			if (i > 0 && (line.includes('::') || line.includes(':::'))) {
				const prev = lines[i - 1];
				if (prev !== undefined) {
					const prevTrimmed = prev.trim();
					if (
						prevTrimmed !== '' &&
						!prevTrimmed.startsWith('//') &&
						!inAnswer
					) {
						newLines.push('');
					}
				}
			}

			if (inAnswer && i > lastDelimiterIndex + 1) {
				if (trimmed === '') {
					inAnswer = false;
				} else if (isCardDelimiter(line)) {
					newLines.push('');
					inAnswer = false;
				} else {
					let isNewQuestion = false;
					for (let j = i + 1; j < lines.length && j <= i + 4; j++) {
						const lookAheadLine = lines[j];
						if (lookAheadLine === undefined) break;
						const lookAheadTrim = lookAheadLine.trim();
						if (lookAheadTrim === '') break;
						if (lookAheadTrim === '?' || lookAheadTrim === '??') {
							isNewQuestion = true;
							break;
						}
					}
					if (isNewQuestion) {
						newLines.push('');
						inAnswer = false;
					}
				}
			}

			newLines.push(line);

			if (trimmed === '?' || trimmed === '??') {
				inAnswer = true;
				lastDelimiterIndex = i;
			}
		}

		const newContent = newLines.join('\n');
		if (newContent !== content) {
			await this.app.vault.modify(file, newContent);
			new Notice('Successfully added empty spaces between cards!');
		} else {
			new Notice('No missing spaces found between cards.');
		}
	}

	async removeDuplicatesInActiveNote(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice('No active markdown file found.');
			return;
		}

		const cards = await FlashcardParser.parseFile(
			file,
			this.app,
			this.settings.flashcardTags,
		);
		if (cards.length === 0) {
			new Notice('No flashcards found in active note.');
			return;
		}

		const content = await this.app.vault.read(file);
		const lines = content.split('\n');

		const seenCardKeys = new Set<string>();
		const lineIndicesToRemove = new Set<number>();
		let duplicatesCount = 0;

		for (const card of cards) {
			const key = card.front.trim().toLowerCase();
			if (seenCardKeys.has(key)) {
				let isNewBlock = false;
				for (let l = card.lineStart; l <= card.lineEnd; l++) {
					if (!lineIndicesToRemove.has(l)) {
						lineIndicesToRemove.add(l);
						isNewBlock = true;
					}
				}
				if (isNewBlock) duplicatesCount++;
			} else {
				seenCardKeys.add(key);
			}
		}

		if (duplicatesCount === 0) {
			new Notice('No duplicate cards found in active note.');
			return;
		}

		const newLines = lines.filter(
			(_, idx) => !lineIndicesToRemove.has(idx),
		);
		const cleanedLines: string[] = [];

		for (let i = 0; i < newLines.length; i++) {
			const currLine = newLines[i];
			if (currLine === undefined) continue;

			if (i > 0) {
				const prevLine = newLines[i - 1];
				if (
					prevLine !== undefined &&
					currLine.trim() === '' &&
					prevLine.trim() === ''
				) {
					continue;
				}
			}
			cleanedLines.push(currLine);
		}

		await this.app.vault.modify(file, cleanedLines.join('\n'));
		new Notice(
			`Removed ${duplicatesCount} duplicate card(s) from active note.`,
		);
	}
}
