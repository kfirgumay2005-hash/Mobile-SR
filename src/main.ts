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

export const cleanStr = (s: string | undefined): string => {
	if (s === undefined) return '';
	return s
		.replace(/\r/g, '')
		.replace(/[\u200B-\u200F\u202A-\u202E]/g, '')
		.trim();
};

// נרמול טקסט להשוואה (עברית / אנגלית / כל שפה): Unicode NFKC, הסרת תווים סמויים,
// איחוד רווחים, והשוואה ללא תלות באותיות גדולות/קטנות
export const normalizeForCompare = (s: string): string => {
	return s
		.normalize('NFKC')
		.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\u00AD\uFEFF]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
};

export const formatDateTime = (ts: number): string => {
	const d = new Date(ts);
	const p = (n: number): string => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const escapeRegExp = (s: string): string =>
	s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// בדיקה שתג (למשל #hint) מופיע כתג שלם ולא כחלק מתג אחר (כמו #hints)
export const hasTagToken = (content: string, tag: string): boolean => {
	const t = tag.trim();
	if (!t) return false;
	return new RegExp(`(^|[^\\w/-])${escapeRegExp(t)}(?![\\w/-])`).test(
		content,
	);
};

// ============================================================================
// 1. Types & Interfaces
// ============================================================================

export type Rating = 1 | 2 | 3 | 4;
export type CardType = 'MultiLine' | 'MultiLineReversed';

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
	// סך כל הפעמים שהכרטיס נבדק + חותמות זמן (ms) של כל בדיקה
	reviewCount?: number;
	reviewHistory?: number[];
}

export interface Flashcard {
	id: string;
	filePath: string;
	deckName: string;
	type: CardType;
	front: string;
	back: string;
	// השורה הראשונה של הכרטיס, והרמז (השורות שבין השורה הראשונה ל-?)
	// הרמז מלא רק בדק שיש בו תג #hint (ורק בכיוון הקדמי של הכרטיס)
	firstLine: string;
	hint: string;
	lineStart: number;
	lineEnd: number;
	rawContent: string;
}

// הטקסט שמוצג כ"שאלה" (בלי הרמז אם יש רמז)
export const displayFront = (card: Flashcard): string =>
	card.hint !== '' ? card.firstLine : card.front;

// ============================================================================
// 2. Algorithm Engine (SRSEngine)
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
		hintTags: string[],
	): Promise<Flashcard[]> {
		const rawContent = await app.vault.read(file);
		const content = rawContent.replace(/\r\n/g, '\n');
		const lines = content.split('\n');
		const cardsMap = new Map<string, Flashcard>();

		const hasTag = validTags.some((tag) => content.includes(tag));
		if (!hasTag) return [];

		// האם הדק הזה מוגדר כדק עם רמזים (תג #hint בנוסף ל-#flashcards)
		const hintEnabled = hintTags.some((tag) => hasTagToken(content, tag));

		const deckName = file.basename;

		const isCardDelimiter = (line: string | undefined): boolean => {
			if (line === undefined) return false;
			const t = cleanStr(line);
			return t === '?' || t === '??' || t === '-';
		};

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line === undefined) continue;

			if (cleanStr(line) === '?' || cleanStr(line) === '??') {
				const isReversed = cleanStr(line) === '??';

				let qStart = i - 1;
				while (
					qStart >= 0 &&
					cleanStr(lines[qStart]) !== '-' &&
					!isCardDelimiter(lines[qStart])
				) {
					qStart--;
				}
				qStart++;

				let aEnd = i + 1;
				while (
					aEnd < lines.length &&
					cleanStr(lines[aEnd]) !== '-' &&
					!isCardDelimiter(lines[aEnd])
				) {
					aEnd++;
				}
				aEnd--;

				if (qStart <= i && aEnd >= i) {
					const qText = lines.slice(qStart, i).join('\n').trim();
					const aText = lines
						.slice(i + 1, aEnd + 1)
						.join('\n')
						.trim();
					const raw = lines.slice(qStart, aEnd + 1).join('\n');

					// השורה הראשונה = השאלה, מה שבינה לבין ה-? = הרמז
					const qLines = qText.split('\n');
					const qFirstLine = (qLines[0] ?? '').trim();
					const qHint = hintEnabled
						? qLines.slice(1).join('\n').trim()
						: '';

					// ה-ID נשאר מחושב על התוכן המלא כמו קודם, כדי לא לאבד התקדמות קיימת
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
						firstLine: qFirstLine,
						hint: qHint,
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
							firstLine: (aText.split('\n')[0] ?? '').trim(),
							hint: '',
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
		const normalized = str.replace(/\r/g, '').trim();
		let hash = 0;
		for (let i = 0; i < normalized.length; i++) {
			const char = normalized.charCodeAt(i);
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
	// כל הכרטיסים של הדק (גם אלה שכבר הושלמו) - לצורך ספירת "הושלמו"
	private deckCards: Flashcard[];
	private currentIndex: number = 0;
	private isAnswerShown: boolean = false;
	private isHintShown: boolean = false;
	private isEditing: boolean = false;
	private component: Component;

	constructor(
		app: App,
		plugin: SpacedRepetitionPlugin,
		queue: Flashcard[],
		deckCards: Flashcard[],
	) {
		super(app);
		this.plugin = plugin;
		this.queue = queue;
		this.deckCards = deckCards;
		this.component = new Component();
	}

	onOpen(): void {
		this.component.load();
		this.modalEl.addClass('srs-review-modal-wrapper');
		void this.renderCurrentCard();
	}

	onClose(): void {
		this.component.unload();
		this.contentEl.empty();
	}

	// כרטיסים שלא צריך לבצע להם review כרגע (מועד הבדיקה הבא שלהם בעתיד)
	private getCompletedCount(): number {
		const now = Date.now();
		return this.deckCards.filter((c) => {
			const meta = this.plugin.store[c.id];
			return !!meta && meta.due > now;
		}).length;
	}

	private async renderCurrentCard(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();

		if (this.currentIndex >= this.queue.length) {
			contentEl.createEl('h2', { text: '✨ Deck Completed!' });
			contentEl.createEl('p', {
				text: 'You have reviewed all due flashcards in this session.',
			});
			contentEl.createEl('p', {
				text: `Completed in deck: ${this.getCompletedCount()} / ${this.deckCards.length}`,
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
		headerEl.setCssStyles({
			display: 'flex',
			justifyContent: 'space-between',
			alignItems: 'center',
			marginBottom: '1em',
		});

		headerEl.createSpan({
			text: `Deck: ${card.deckName}`,
			cls: 'srs-deck-title',
		});
		headerEl.createSpan({
			text: `Completed: ${this.getCompletedCount()} / ${this.deckCards.length}`,
			cls: 'srs-card-progress',
		});

		const editBtn = headerEl.createEl('button', {
			text: this.isEditing ? 'Cancel Edit' : 'Edit Card',
		});
		editBtn.onclick = () => {
			this.isEditing = !this.isEditing;
			void this.renderCurrentCard();
		};

		const bodyEl = contentEl.createDiv({ cls: 'srs-card-body' });
		bodyEl.setCssStyles({
			minHeight: '150px',
			padding: '1em',
			border: '1px solid var(--background-modifier-border)',
			borderRadius: '8px',
		});

		if (this.isEditing) {
			const editArea = bodyEl.createEl('textarea');
			editArea.value = card.rawContent;
			editArea.setCssStyles({ width: '100%', height: '120px' });

			const saveBtn = bodyEl.createEl('button', {
				text: 'Save Changes',
				cls: 'mod-cta',
			});
			saveBtn.setCssStyles({ marginTop: '0.5em' });
			saveBtn.onclick = async () => {
				await this.saveCardModification(card, editArea.value);
				this.isEditing = false;
				void this.renderCurrentCard();
			};
			return;
		}

		const hasHint = card.hint !== '';

		const frontEl = bodyEl.createDiv({ cls: 'srs-front-content' });
		await MarkdownRenderer.render(
			this.app,
			displayFront(card),
			frontEl,
			card.filePath,
			this.component,
		);

		if (hasHint && (this.isHintShown || this.isAnswerShown)) {
			const hintWrap = bodyEl.createDiv({ cls: 'srs-hint-wrapper' });
			hintWrap.setCssStyles({
				marginTop: '0.75em',
				paddingLeft: '0.75em',
				borderLeft: '3px solid var(--text-accent)',
			});
			const hintLabel = hintWrap.createDiv({ text: '💡 Hint' });
			hintLabel.setCssStyles({
				fontSize: '0.8em',
				opacity: '0.7',
				marginBottom: '0.25em',
			});
			const hintEl = hintWrap.createDiv({ cls: 'srs-hint-content' });
			await MarkdownRenderer.render(
				this.app,
				card.hint,
				hintEl,
				card.filePath,
				this.component,
			);
		}

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
		bottomBar.setCssStyles({ marginTop: '1.5em' });

		if (!this.isAnswerShown) {
			if (hasHint && !this.isHintShown) {
				const hintBtn = bottomBar.createEl('button', {
					text: 'Show Hint',
				});
				hintBtn.setCssStyles({ width: '100%', marginBottom: '8px' });
				hintBtn.onclick = () => {
					this.isHintShown = true;
					void this.renderCurrentCard();
				};
			}

			const showBtn = bottomBar.createEl('button', {
				text: 'Show Answer',
				cls: 'mod-cta',
			});
			showBtn.setCssStyles({ width: '100%' });
			showBtn.onclick = () => {
				this.isAnswerShown = true;
				void this.renderCurrentCard();
			};
		} else {
			const buttonGrid = bottomBar.createDiv({ cls: 'srs-button-grid' });
			buttonGrid.setCssStyles({
				display: 'grid',
				gridTemplateColumns: 'repeat(4, 1fr)',
				gap: '8px',
			});

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
				btn.setCssStyles({
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
				});

				const labelSpan = btn.createSpan({ text: item.label });
				labelSpan.setCssStyles({
					color: item.color,
					fontWeight: 'bold',
				});

				if (this.plugin.settings.showIntervalOnButtons) {
					const intervalSpan = btn.createSpan({
						text: intervalText,
					});
					intervalSpan.setCssStyles({
						fontSize: '0.8em',
						opacity: '0.7',
					});
				}

				btn.onclick = () => {
					void this.applyRating(card, nextMeta);
				};
			}
		}
	}

	private async applyRating(
		card: Flashcard,
		nextMeta: CardSchedulingMetadata,
	): Promise<void> {
		const prev = this.plugin.store[card.id];
		const reviewedAt = Date.now();

		// כרטיסים ישנים שאין להם עדיין היסטוריה - מתחילים מהמידע הקיים
		const prevHistory: number[] =
			prev?.reviewHistory ??
			(prev && prev.lastReview ? [prev.lastReview] : []);
		const prevCount: number =
			prev?.reviewCount ?? (prev ? Math.max(prev.repetition, 1) : 0);

		nextMeta.cardId = card.id;
		nextMeta.reviewHistory = [...prevHistory, reviewedAt];
		nextMeta.reviewCount = prevCount + 1;

		this.plugin.store[card.id] = nextMeta;
		await this.plugin.saveCardStore();
		this.currentIndex++;
		this.isAnswerShown = false;
		this.isHintShown = false;
		void this.renderCurrentCard();
	}

	private async saveCardModification(
		card: Flashcard,
		newContent: string,
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(card.filePath);
		if (!(file instanceof TFile)) return;

		const settings = this.plugin.settings;
		const content = await this.app.vault.read(file);
		const lines = content.replace(/\r\n/g, '\n').split('\n');

		// מאתרים את הכרטיס בקובץ לפי התוכן (ולא רק לפי מספרי שורות), כי עריכת כרטיס
		// קודם באותו סשן עלולה להזיז את השורות של כרטיסים אחרים
		const oldLines = card.rawContent.split('\n');
		const matchesAt = (s: number): boolean =>
			oldLines.every((l, k) => lines[s + k] === l);

		let start = card.lineStart;
		if (!matchesAt(start)) {
			start = -1;
			for (let s = 0; s + oldLines.length <= lines.length; s++) {
				if (matchesAt(s)) {
					start = s;
					break;
				}
			}
		}

		if (start === -1) {
			new Notice(
				'Could not locate this card in the note (it may have changed). Reopen the dashboard and try again.',
			);
			return;
		}

		const blockStart = start;
		const parseBlock = async (): Promise<Flashcard[]> => {
			const parsed = await FlashcardParser.parseFile(
				file,
				this.app,
				settings.flashcardTags,
				settings.hintTags,
			);
			return parsed.filter((c) => c.lineStart === blockStart);
		};

		const before = await parseBlock();

		lines.splice(blockStart, oldLines.length, newContent);
		await this.app.vault.modify(file, lines.join('\n'));

		const after = await parseBlock();

		// עריכת כרטיס משנה את ה-ID שלו - מעבירים את ההתקדמות וההיסטוריה ל-ID החדש
		// כדי שהסריקה של הדשבורד לא תמחק אותם כ"כרטיס שנמחק"
		let migrated = false;
		if (before.length > 0 && before.length === after.length) {
			for (let i = 0; i < before.length; i++) {
				const b = before[i];
				const a = after[i];
				if (!b || !a || a.id === b.id) continue;
				const meta = this.plugin.store[b.id];
				if (meta && !this.plugin.store[a.id]) {
					delete this.plugin.store[b.id];
					meta.cardId = a.id;
					this.plugin.store[a.id] = meta;
					migrated = true;
				}
			}
		}
		if (migrated) await this.plugin.saveCardStore();

		const idx = before.findIndex((b) => b.id === card.id);
		const updated = idx >= 0 ? after[idx] : undefined;
		if (updated) {
			Object.assign(card, updated);
		} else {
			card.rawContent = newContent;
			card.front = newContent;
			card.firstLine = (newContent.split('\n')[0] ?? '').trim();
			card.hint = '';
			card.lineStart = blockStart;
			card.lineEnd = blockStart + newContent.split('\n').length - 1;
		}

		new Notice('Card edited and saved successfully.');
	}
}

interface DeckStats {
	all: Flashcard[];
	due: Flashcard[];
	completed: number;
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

	onOpen(): void {
		this.modalEl.addClass('srs-dashboard-modal');
		this.contentEl.empty();
		this.contentEl.createEl('h2', {
			text: '🔍 Scanning decks and preparing cards...',
		});

		void this.loadAndSyncCards()
			.then(() => {
				this.render();
			})
			.catch((err) => {
				console.error('SRS dashboard scan failed:', err);
				this.contentEl.empty();
				this.contentEl.createEl('h2', {
					text: '⚠️ Failed to scan decks. See the developer console.',
				});
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	// בכל פתיחה של הדשבורד (מה-ribbon או מהפקודה) מתבצעת סריקה מלאה:
	// טעינת נתונים, פירוק כל הכרטיסים, מחיקת כרטיסים שנמחקו, והשלמת שדות חסרים
	private async loadAndSyncCards(): Promise<void> {
		this.allCards = await this.plugin.scanAllCards();
		this.cardsMap.clear();
		for (const c of this.allCards) {
			this.cardsMap.set(c.id, c);
		}
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: 'Decks to Review' });

		const now = Date.now();
		const decks = new Map<string, DeckStats>();
		let totalCompleted = 0;

		for (const card of this.allCards) {
			let stats = decks.get(card.deckName);
			if (!stats) {
				stats = { all: [], due: [], completed: 0 };
				decks.set(card.deckName, stats);
			}
			stats.all.push(card);

			const meta = this.plugin.store[card.id];
			if (meta && meta.due > now) {
				stats.completed++;
				totalCompleted++;
			} else {
				stats.due.push(card);
			}
		}

		const totalCards = this.allCards.length;
		const totalDue = totalCards - totalCompleted;

		const summaryEl = contentEl.createDiv({ cls: 'srs-dashboard-summary' });
		summaryEl.setCssStyles({ marginBottom: '1em', fontWeight: 'bold' });
		summaryEl.setText(
			`✅ Total completed: ${totalCompleted} / ${totalCards} cards   ·   ⏰ Due: ${totalDue}`,
		);

		if (decks.size === 0) {
			contentEl.createEl('p', {
				text: 'No flashcards found.',
			});
		} else {
			if (totalDue === 0) {
				contentEl.createEl('p', {
					text: '🎉 No cards are due right now! Great job.',
				});
			}

			const decksContainer = contentEl.createDiv({
				cls: 'srs-decks-container',
			});
			decksContainer.setCssStyles({
				display: 'grid',
				gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
				gap: '10px',
				marginBottom: '2em',
			});

			for (const [deckName, stats] of decks.entries()) {
				const deckCard = decksContainer.createDiv();
				deckCard.setCssStyles({
					border: '1px solid var(--background-modifier-border)',
					padding: '12px',
					borderRadius: '8px',
					display: 'flex',
					justifyContent: 'space-between',
					alignItems: 'center',
				});

				const infoDiv = deckCard.createDiv();
				infoDiv.createEl('strong', { text: deckName });
				infoDiv
					.createDiv({
						text: `${stats.due.length} cards due`,
						cls: 'srs-deck-count',
					})
					.setCssStyles({ fontSize: '0.85em' });
				infoDiv
					.createDiv({
						text: `${stats.completed} / ${stats.all.length} completed`,
						cls: 'srs-deck-completed',
					})
					.setCssStyles({ fontSize: '0.85em', opacity: '0.8' });

				const startBtn = deckCard.createEl('button', {
					text: 'Start',
					cls: 'mod-cta',
				});
				if (stats.due.length === 0) {
					startBtn.disabled = true;
				}
				startBtn.onclick = () => {
					this.close();
					new ReviewModal(
						this.app,
						this.plugin,
						stats.due,
						stats.all,
					).open();
				};
			}
		}

		contentEl.createEl('hr');

		contentEl.createEl('h2', { text: 'Reviewed Flashcards Status' });

		// רק כרטיסים שעדיין קיימים בפתקים (כרטיסים שנמחקו כבר נוקו בסריקה)
		const storeEntries = Object.values(this.plugin.store).filter((m) =>
			this.cardsMap.has(m.cardId),
		);

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
		searchInput.setCssStyles({
			width: '100%',
			marginBottom: '1em',
			padding: '0.5em',
		});
		searchInput.value = this.filterText;

		const tableContainer = contentEl.createDiv({
			cls: 'srs-table-container',
		});
		tableContainer.setCssStyles({ maxHeight: '400px', overflowY: 'auto' });

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
			if (!card) return false;
			if (!this.filterText) return true;
			const frontText = card.front.toLowerCase();
			const deckText = card.deckName.toLowerCase();
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
		table.setCssStyles({ width: '100%', borderCollapse: 'collapse' });

		const thead = table.createEl('thead');
		const headerRow = thead.createEl('tr');
		headerRow.setCssStyles({
			borderBottom: '2px solid var(--background-modifier-border)',
		});

		[
			'Card Prompt',
			'Deck',
			'Interval',
			'Reviews',
			'Last Review',
			'Status',
		].forEach((h) => {
			const th = headerRow.createEl('th', { text: h });
			th.setCssStyles({ padding: '8px', textAlign: 'left' });
		});

		const tbody = table.createEl('tbody');
		filteredEntries.sort((a, b) => a.due - b.due);

		for (const meta of filteredEntries) {
			const card = this.cardsMap.get(meta.cardId);
			if (!card) continue;

			const row = tbody.createEl('tr');
			row.setCssStyles({
				borderBottom: '1px solid var(--background-modifier-border)',
			});

			const promptText = displayFront(card);
			const tdPrompt = row.createEl('td');
			tdPrompt.setCssStyles({ padding: '8px' });
			tdPrompt.textContent =
				promptText.length > 45
					? promptText.substring(0, 45) + '...'
					: promptText;

			const tdDeck = row.createEl('td');
			tdDeck.setCssStyles({ padding: '8px' });
			tdDeck.textContent = card.deckName;

			const tdInterval = row.createEl('td');
			tdInterval.setCssStyles({ padding: '8px' });
			tdInterval.textContent = SRSEngine.formatInterval(meta.interval);

			const history = meta.reviewHistory ?? [];
			const tdReviews = row.createEl('td');
			tdReviews.setCssStyles({ padding: '8px' });
			tdReviews.textContent = String(meta.reviewCount ?? history.length);
			if (history.length > 0) {
				// ריחוף עם העכבר מציג את תאריכי ושעות הביצוע (30 האחרונים)
				tdReviews.title = history
					.slice(-30)
					.map((t) => formatDateTime(t))
					.join('\n');
			}

			const lastTs = history[history.length - 1] ?? meta.lastReview;
			const tdLast = row.createEl('td');
			tdLast.setCssStyles({ padding: '8px' });
			tdLast.textContent = lastTs ? formatDateTime(lastTs) : '-';

			const tdStatus = row.createEl('td');
			tdStatus.setCssStyles({ padding: '8px' });

			const diffMs = meta.due - now;
			if (diffMs <= 0) {
				tdStatus.textContent = '⏰ Due Now';
				tdStatus.setCssStyles({
					color: 'var(--text-error)',
					fontWeight: 'bold',
				});
			} else {
				const timeStr = this.formatTimeRemaining(diffMs);
				tdStatus.textContent = `⏳ ${timeStr}`;
				tdStatus.setCssStyles({ color: 'var(--text-success)' });
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
	isSaving: boolean = false; // דגל למניעת לולאת רענון בעת שמירה

	async onload(): Promise<void> {
		// מוודא שהכספת טעונה במלואה לפני ניסיון הקריאה מהקובץ
		this.app.workspace.onLayoutReady(async () => {
			await this.loadAllData();
		});

		// מאזין לשינויים בקובץ ברקע (עבור סנכרון עם הטלפון / LiveSync)
		this.registerEvent(
			this.app.vault.on('modify', async (file) => {
				if (file.path === this.getDataFilePath() && !this.isSaving) {
					await this.loadAllData();
				}
			}),
		);

		this.addRibbonIcon(
			'clipboard-check',
			'Spaced Repetition Dashboard',
			() => {
				new DashboardModal(this.app, this).open();
			},
		);

		this.addCommand({
			id: 'open-srs-dashboard',
			name: 'Open Spaced Repetition Dashboard',
			callback: () => {
				new DashboardModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: 'fix-cards-and-remove-duplicates',
			name: 'Fix Cards Spacing and Remove Duplicates',
			callback: async () => {
				await this.fixCardsAndRemoveDuplicates();
			},
		});

		this.addSettingTab(new SpacedRepetitionSettingTab(this.app, this));
	}

	public getDataFilePath(): string {
		const folder = this.settings?.dataFolderPath
			? this.settings.dataFolderPath.trim().replace(/^\/+|\/+$/g, '')
			: '';
		return folder ? `${folder}/srs-data.md` : 'srs-data.md';
	}

	private getVaultDataFile(): TFile | null {
		const targetPath = this.getDataFilePath();

		let file = this.app.vault.getAbstractFileByPath(targetPath);
		if (file instanceof TFile) return file;

		const files = this.app.vault.getFiles();
		return files.find((f) => f.name === 'srs-data.md') || null;
	}

	private async ensureFolderExists(folderPath: string): Promise<void> {
		if (!folderPath) return;
		const normalized = folderPath.trim().replace(/^\/+|\/+$/g, '');
		if (!normalized) return;

		const parts = normalized.split('/');
		let currentPath = '';
		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const folderExists =
				this.app.vault.getAbstractFileByPath(currentPath);
			if (!folderExists) {
				try {
					await this.app.vault.createFolder(currentPath);
				} catch {
					// Folder exists or creation failed
				}
			}
		}
	}

	async loadAllData(): Promise<void> {
		const loadedSettings = (await this.loadData()) as Record<
			string,
			unknown
		> | null;
		if (loadedSettings && typeof loadedSettings === 'object') {
			this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedSettings);
		} else {
			this.settings = Object.assign({}, DEFAULT_SETTINGS);
		}

		let newStore: Record<string, CardSchedulingMetadata> = {};
		const file = this.getVaultDataFile();

		if (file instanceof TFile) {
			try {
				const content = await this.app.vault.read(file);
				// שיפור ה-Regex על מנת לטפל בשינויי שורות/רווחים בטלפון
				const match = content.match(/```json\s+([\s\S]*?)\s+```/);
				let parsed: unknown = null;

				if (match && match[1]) {
					parsed = JSON.parse(match[1]);
				} else {
					try {
						parsed = JSON.parse(content);
					} catch {
						console.warn(
							'Not a valid JSON format inside data file',
						);
					}
				}

				if (parsed && typeof parsed === 'object' && parsed !== null) {
					const dataObj = parsed as {
						store?: Record<string, CardSchedulingMetadata>;
						settings?: unknown;
					};
					if (dataObj.store && typeof dataObj.store === 'object') {
						newStore = dataObj.store;
					} else if (!dataObj.settings) {
						newStore = parsed as Record<
							string,
							CardSchedulingMetadata
						>;
					}
				}
			} catch (err) {
				console.error('Error reading SRS card data file:', err);
				// במידה ויש שגיאת קריאה, לא נדרוס את הזיכרון ונאבד נתונים
				return;
			}
		}

		this.store = newStore;
	}

	// ------------------------------------------------------------------------
	// סריקה מלאה - נקראת בכל פתיחה של הדשבורד
	// ------------------------------------------------------------------------
	async scanAllCards(): Promise<Flashcard[]> {
		// וידוא שהמידע המעודכן ביותר בקובץ (גם ממכשירים אחרים) טעון לפני חישוב כרטיסים
		await this.loadAllData();

		const files = this.app.vault.getMarkdownFiles();
		const allCards: Flashcard[] = [];

		for (const file of files) {
			if (file.name === 'srs-data.md' || file.name === 'srs-data.json')
				continue;

			const cards = await FlashcardParser.parseFile(
				file,
				this.app,
				this.settings.flashcardTags,
				this.settings.hintTags,
			);
			allCards.push(...cards);
		}

		if (this.syncStoreWithCards(allCards)) {
			await this.saveCardStore();
		}

		return allCards;
	}

	// מוחק מה-store כרטיסים שנמחקו מהפתקים, ומשלים שדות חסרים (היסטוריית ביצועים).
	// מחזיר true אם משהו השתנה ויש לשמור.
	private syncStoreWithCards(allCards: Flashcard[]): boolean {
		let changed = false;
		const existingIds = new Set(allCards.map((c) => c.id));

		// הגנה: אם לא נמצא אף כרטיס בכל הכספת (למשל הכספת עוד לא נטענה במלואה / סנכרון חלקי)
		// לא מוחקים כלום, כדי לא לאבד נתונים בטעות
		const canPrune =
			allCards.length > 0 || Object.keys(this.store).length === 0;

		for (const [id, meta] of Object.entries(this.store)) {
			if (canPrune && !existingIds.has(id)) {
				delete this.store[id];
				changed = true;
				continue;
			}
			if (this.ensureMetaFields(id, meta)) changed = true;
		}

		return changed;
	}

	private ensureMetaFields(
		id: string,
		meta: CardSchedulingMetadata,
	): boolean {
		let changed = false;

		if (meta.cardId !== id) {
			meta.cardId = id;
			changed = true;
		}

		// כרטיסים שנבדקו לפני שהתווספה ההיסטוריה: נשמר מועד הבדיקה האחרון הידוע
		if (!Array.isArray(meta.reviewHistory)) {
			meta.reviewHistory = meta.lastReview ? [meta.lastReview] : [];
			changed = true;
		}

		// מספר הפעמים: הערכה לפי מונה החזרות הקיים (לכרטיסים ישנים בלבד)
		if (typeof meta.reviewCount !== 'number') {
			meta.reviewCount = Math.max(
				meta.repetition || 0,
				meta.reviewHistory.length,
				1,
			);
			changed = true;
		}

		return changed;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async saveCardStore(): Promise<void> {
		this.isSaving = true;
		try {
			const filePath = this.getDataFilePath();
			const folderPath = this.settings.dataFolderPath
				? this.settings.dataFolderPath.trim().replace(/^\/+|\/+$/g, '')
				: '';

			if (folderPath) {
				await this.ensureFolderExists(folderPath);
			}

			const dataObj = {
				store: this.store,
			};

			const jsonString = JSON.stringify(dataObj, null, 2);
			const markdownContent = `---\ntags: [srs-system-data]\n---\n# Spaced Repetition Data\n\n> ⚠️ **Warning:** Do not edit this file manually unless you know what you are doing. The plugin reads and writes directly from the code block below.\n\n\`\`\`json\n${jsonString}\n\`\`\`\n`;

			const file = this.app.vault.getAbstractFileByPath(filePath);

			if (file instanceof TFile) {
				await this.app.vault.modify(file, markdownContent);
			} else {
				const oldFile = this.getVaultDataFile();
				if (oldFile && oldFile.path !== filePath) {
					try {
						await this.app.fileManager.trashFile(oldFile);
					} catch {
						// Ignored: File could not be trashed
					}
				}

				await this.app.vault.create(filePath, markdownContent);
			}
		} finally {
			// שחרור הדגל לאחר זמן קצר כדי לאפשר לאירועי ה-modify להסתיים
			window.setTimeout(() => {
				this.isSaving = false;
			}, 1000);
		}
	}

	async applyDataLocation(): Promise<void> {
		await this.saveSettings();
		await this.saveCardStore();
		new Notice(
			`Data location applied!\nSaved settings to plugin data.json and card data to: ${this.getDataFilePath()}`,
		);
	}

	async fixCardsAndRemoveDuplicates(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice('No active markdown file found.');
			return;
		}

		const mode = this.settings.duplicateMode;

		const content = await this.app.vault.read(file);
		const lines = content.replace(/\r\n/g, '\n').split('\n');

		const dashGroups: string[][] = [];
		let currentGroup: string[] = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line === undefined) continue;

			if (cleanStr(line) === '-') {
				dashGroups.push(currentGroup);
				currentGroup = [];
			} else {
				currentGroup.push(line);
			}
		}
		dashGroups.push(currentGroup);

		const seenKeys = new Set<string>();
		let duplicatesCount = 0;
		const outLines: string[] = [];

		for (let i = 0; i < dashGroups.length; i++) {
			const group = dashGroups[i];
			if (!group) continue;

			let delimiter = '';
			let delimiterIdx = -1;

			for (let j = 0; j < group.length; j++) {
				const trimmed = cleanStr(group[j]);
				if (trimmed === '?' || trimmed === '??') {
					delimiter = trimmed;
					delimiterIdx = j;
					break;
				}
			}

			if (delimiterIdx !== -1) {
				const frontLines = group.slice(0, delimiterIdx);
				const backLines = group.slice(delimiterIdx + 1);

				const frontKeys = frontLines
					.map(normalizeForCompare)
					.filter((l) => l !== '');
				const backKeys = backLines
					.map(normalizeForCompare)
					.filter((l) => l !== '');

				// מפתח ההשוואה:
				// firstLine - רק השורה הראשונה של הכרטיס (בין המקף הפותח לשורה השנייה),
				//             כך ששני כרטיסים עם אותה שורה ראשונה אך רמז/תשובה שונים נחשבים כפילות
				// exact     - כל תוכן הכרטיס (שאלה + רמז + סוג המפריד + תשובה)
				let key = '';
				if (mode === 'firstLine') {
					key = frontKeys[0] ?? '';
				} else if (frontKeys.length > 0 || backKeys.length > 0) {
					key = `${frontKeys.join('\n')}\u0001${delimiter}\u0001${backKeys.join('\n')}`;
				}

				if (key !== '' && seenKeys.has(key)) {
					duplicatesCount++;
					continue;
				}

				if (key !== '') {
					seenKeys.add(key);
				}

				const cleanedFront = frontLines.filter(
					(l) => cleanStr(l) !== '',
				);
				const cleanedBack = backLines.filter((l) => cleanStr(l) !== '');

				if (i > 0) outLines.push('-');

				outLines.push(...cleanedFront);
				outLines.push(delimiter);
				outLines.push(...cleanedBack);
			} else {
				if (i > 0) outLines.push('-');
				outLines.push(...group);
			}
		}

		const finalContent = outLines.join('\n');
		await this.app.vault.modify(file, finalContent);

		const modeLabel =
			mode === 'firstLine' ? 'same first line' : 'identical content';

		if (duplicatesCount > 0) {
			new Notice(
				`Cards formatting updated and removed ${duplicatesCount} duplicate card(s) (${modeLabel}).`,
			);
		} else {
			new Notice(
				`Cards formatting fixed successfully! No duplicates found (${modeLabel}).`,
			);
		}
	}
}
