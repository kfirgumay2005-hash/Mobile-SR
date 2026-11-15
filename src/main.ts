import {
	App,
	Modal,
	Notice,
	Platform,
	Plugin,
	TFile,
	MarkdownRenderer,
	Component,
	setIcon,
} from 'obsidian';
import {
	type DuplicateMode,
	SpacedRepetitionSettings,
	DEFAULT_SETTINGS,
	SpacedRepetitionSettingTab,
	BlastData,
	defaultBlastData,
} from './settings';
import { BlastModal } from './blast';
import { MatchModal } from './match';
import { HangmanModal } from './hangman';
import { AliensModal } from './aliens';
import { SwordModal } from './sword';
import {
	RemoteInput,
	RemoteLoggerModal,
	buildRemoteTutorialCards,
	gestureLabel,
	isTapGesture,
	reconcileRemote,
	remoteActionFor,
	stampRemote,
	type GestureInfo,
	type RemoteAction,
} from './remote';
import { Speaker } from './speech';
import type { GameId } from './music';
import { checkUnlockKey } from './rewards';
import { TutorialMenuModal } from './tutorials';
import {
	SENTENCE_STAGES,
	diffSentence,
	hiddenAt,
	letterCount,
	normWord,
	parseSentence,
	randomOrder,
	renderSentence,
	sentenceWords,
	withAnchor,
	type SentenceToken,
	type WordToken,
} from './sentence';

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
	// במדריך: כרטיס משפט שמוצג כאילו כבר נלמד (נפתח בשלב האחרון)
	tutorialReviewed?: boolean;
	// כרטיס משפט (דק עם תג #sentences): הגב נלמד מילה במילה, ראו sentence.ts
	sentence: boolean;
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
			difficulty: 5.0,
			stability: 0.0,
			lapses: 0,
			repetition: 0,
			lastReview: now,
		};

		return this.calculateFSRS(existing, rating, now, settings);
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
	// סוג הדק לפי התגים שבפתק
	static deckFlags(
		content: string,
		validTags: string[],
		hintTags: string[],
		sentenceTags: string[],
	): { isDeck: boolean; hint: boolean; sentence: boolean } {
		return {
			isDeck: validTags.some((tag) => content.includes(tag)),
			// האם הדק הזה מוגדר כדק עם רמזים (תג #hint בנוסף ל-#flashcards)
			hint: hintTags.some((tag) => hasTagToken(content, tag)),
			// דק משפטים: אין כרטיס הפוך (?? נחשב כמו ?), כי שאלה של משפט שלם לא הגיונית
			sentence: sentenceTags.some((tag) => hasTagToken(content, tag)),
		};
	}

	static async parseFile(
		file: TFile,
		app: App,
		validTags: string[],
		hintTags: string[],
		sentenceTags: string[] = [],
	): Promise<Flashcard[]> {
		const rawContent = await app.vault.read(file);
		const content = rawContent.replace(/\r\n/g, '\n');
		const flags = this.deckFlags(
			content,
			validTags,
			hintTags,
			sentenceTags,
		);
		if (!flags.isDeck) return [];
		return this.parseText(
			content,
			file.path,
			file.basename,
			flags.hint,
			flags.sentence,
		);
	}

	// פירוק הכרטיסים מטקסט. גם המדריכים ומגרש הכתיבה משתמשים בזה, בלי קובץ
	static parseText(
		content: string,
		filePath: string,
		deckName: string,
		hintEnabled: boolean,
		sentence: boolean,
	): Flashcard[] {
		const lines = content.replace(/\r\n/g, '\n').split('\n');
		const cardsMap = new Map<string, Flashcard>();

		const isCardDelimiter = (line: string | undefined): boolean => {
			if (line === undefined) return false;
			const t = cleanStr(line);
			return t === '?' || t === '??' || t === '-';
		};

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line === undefined) continue;

			if (cleanStr(line) === '?' || cleanStr(line) === '??') {
				const isReversed = cleanStr(line) === '??' && !sentence;

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
						`${filePath}:multi:${qText}:${aText}`,
					);
					cardsMap.set(idFwd, {
						id: idFwd,
						filePath: filePath,
						deckName,
						type: isReversed ? 'MultiLineReversed' : 'MultiLine',
						front: qText,
						back: aText,
						firstLine: qFirstLine,
						hint: qHint,
						sentence,
						lineStart: qStart,
						lineEnd: aEnd,
						rawContent: raw,
					});

					if (isReversed) {
						const idRev = this.generateHash(
							`${filePath}:multi-rev:${qText}:${aText}`,
						);
						cardsMap.set(idRev, {
							id: idRev,
							filePath: filePath,
							deckName,
							type: 'MultiLineReversed',
							front: aText,
							back: qText,
							firstLine: (aText.split('\n')[0] ?? '').trim(),
							hint: '',
							sentence: false,
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

// צעד קדימה ב-review: advanced = currentIndex התקדם, moved = הכרטיס הועבר לסוף התור
interface ReviewStep {
	card: Flashcard;
	kind: 'advanced' | 'moved';
}

// פעולות שנאמרות בקול לפני הכרטיס הבא (בהפיכה ההקראה של התשובה היא האישור)
const ANNOUNCED = new Set<RemoteAction>([
	'again',
	'hard',
	'good',
	'easy',
	'next',
	'prev',
]);

const REMOTE_RATINGS: Record<
	'again' | 'hard' | 'good' | 'easy',
	{ value: Rating; label: string }
> = {
	again: { value: 1, label: 'Again' },
	hard: { value: 2, label: 'Hard' },
	good: { value: 3, label: 'Good' },
	easy: { value: 4, label: 'Easy' },
};

// review של תרגול (מדריכים): כרטיסים בזיכרון, ושום דבר לא נשמר
export interface PracticeOptions {
	// מדריך השלט: השלט פעיל גם כשכובה בהגדרות, וכל מחווה מוצגת בהודעה
	remote?: boolean;
	// מחייב תשובה מוקלדת, בלי קשר להגדרה
	typeAnswer?: boolean;
	// דק רמזים, כדי שכרטיס שנערך במדריך יפורק כמו בפתק אמיתי
	hintDeck?: boolean;
	// כפתור "More tutorials" במסך הסיום
	onFinish?: () => void;
	// נקרא פעם אחת כשכל הכרטיסים דורגו (המדריך הושלם)
	onComplete?: () => void;
	// מכריח (או מבטל) שדות הקלדה במקומות הריקים, בלי קשר להגדרה
	fillBlanks?: boolean;
}

// מצב כרטיס המשפט המוצג: שלב ההסתרה, סדר ההסתרה האקראי והמילים שסומנו כ"שכחתי".
// walk = כרטיס חדש שעובר את כל השלבים לפני חשיפת התשובה
interface SentenceState {
	card: Flashcard;
	stage: number;
	walk: boolean;
	order: number[];
	missed: Set<number>;
	// המילים החסרות מההשוואה עם מה שהוקלד כבר סומנו
	seeded: boolean;
	// מה שהוקלד בכל מקום ריק (לפי מספר המילה), ותוצאת Check: true = נכון
	fills: Map<number, string>;
	marks: Map<number, boolean>;
}

export class ReviewModal extends Modal {
	private plugin: SpacedRepetitionPlugin;
	private queue: Flashcard[];
	// כל הכרטיסים של הדק (גם אלה שכבר הושלמו) - לצורך ספירת "הושלמו"
	private deckCards: Flashcard[];
	private currentIndex: number = 0;
	private isAnswerShown: boolean = false;
	private isHintShown: boolean = false;
	private isEditing: boolean = false;
	// מה שהוקלד לכרטיס הנוכחי. נשמר כאן כדי לעבור ציור מחדש, ולא נשמר לשום קובץ
	private typedAnswer: string = '';
	// השלט בשימוש בסשן הזה: אי אפשר להקליד איתו, אז חוזרים לכפתור Show Answer
	private remoteInUse: boolean = false;
	private component: Component;
	// שלט רחוק (ראו remote.ts); פעיל רק כל עוד החלון פתוח
	private remote: RemoteInput | null = null;
	// הקראה בקול (ראו speech.ts); null כשההקראה כבויה
	private speaker: Speaker | null = null;
	// הצד שכבר הוקרא (מזהה כרטיס + צד), כדי לא להקריא שוב בכל ציור מחדש
	private spokenKey: string = '';
	// מה שהשלט עשה, נאמר לפני הכרטיס הבא
	private announce: string = '';
	// מדריך: כרטיסים שנוצרו בזיכרון, ושום דבר לא נשמר (לא דירוג ולא פתק)
	private practice: boolean;
	private opts: PracticeOptions;
	// ציור שהתחיל אחרי ציור אחר מבטל אותו, כדי שלחיצות מהירות לא יכפילו את התצוגה
	private renderToken: number = 0;
	// כרטיס המשפט הנוכחי (ראו sentence.ts); נוצר מחדש כשעוברים לכרטיס אחר
	private sent: SentenceState | null = null;
	// "Make anchor" כותב לפתק ומשנה את ה-ID של הכרטיס; בזמן הזה לא מדרגים
	private anchorBusy: boolean = false;
	// המדריך כבר דווח כהושלם (onComplete)
	private completed: boolean = false;
	// false = דק משפטים שנבחר ללמוד ככרטיסים רגילים (ראו flashcardDecks בהגדרות)
	private asSentences: boolean;
	// צעדים קדימה, כדי ש-"כרטיס קודם" יוכל לחזור אחורה
	private history: ReviewStep[] = [];
	// כרטיסים שדורגו בסשן הזה ומה היה המצב שלהם לפני הדירוג,
	// כך שדירוג חוזר (אחרי "כרטיס קודם") מחליף את הדירוג הקודם במקום להוסיף עוד אחד
	private ratedBefore = new Map<
		Flashcard,
		{ before: CardSchedulingMetadata | undefined; label: string }
	>();

	constructor(
		app: App,
		plugin: SpacedRepetitionPlugin,
		queue: Flashcard[],
		deckCards: Flashcard[],
		practice: PracticeOptions | null = null,
		asSentences: boolean = true,
	) {
		super(app);
		this.asSentences = asSentences;
		this.plugin = plugin;
		this.queue = queue;
		this.deckCards = deckCards;
		this.practice = practice !== null;
		this.opts = practice ?? {};
		this.component = new Component();
	}

	onOpen(): void {
		this.component.load();
		this.modalEl.addClass('srs-review-modal-wrapper');
		// במדריך השלט פעיל תמיד, גם אם כובה בהגדרות
		if (this.plugin.settings.remoteEnabled || this.opts.remote) {
			this.remote = new RemoteInput({
				settings: () => this.plugin.settings,
				// במדריך גם הקשה לא מקושרת נתפסת, כדי להראות שהיא הגיעה
				// הקשה באמצע הקלדה היא אצבע על המסך, ולא בקשה לרמז או להפוך את הכרטיס
				wants: (g) =>
					!this.isEditing &&
					!(isTapGesture(g) && this.isTyping()) &&
					(remoteActionFor(this.plugin.settings, g) !== null ||
						(!!this.opts.remote && isTapGesture(g))),
				onGesture: (g, info) => this.onRemoteGesture(g, info),
			});
			this.remote.attach(this.plugin);
		}
		if (this.plugin.settings.ttsEnabled) this.startSpeaker();
		void this.renderCurrentCard();
	}

	// רק מתוך לחיצה (פתיחת החלון, כפתור ההשתקה), כי רק אז מותר להפעיל את השמע
	private startSpeaker(): void {
		this.speaker = new Speaker(() => this.plugin.settings);
		this.speaker.unlock();
	}

	// כפתור ההשתקה משנה את אותה הגדרה של "Read cards aloud", ולכן הבחירה נשמרת לסשן הבא
	private setReadAloud(on: boolean): void {
		this.plugin.settings.ttsEnabled = on;
		void this.plugin.saveSettings();
		this.speaker?.dispose();
		this.speaker = null;
		if (!on) return;
		// מה שקרה בזמן ההשתקה לא נאמר, ומקריאים את הצד שמוצג עכשיו
		this.announce = '';
		this.spokenKey = '';
		this.startSpeaker();
		this.speakCurrent();
	}

	private renderMuteButton(parent: HTMLElement): void {
		const btn = parent.createEl('button');
		const paint = (): void => {
			const on = this.plugin.settings.ttsEnabled;
			btn.empty();
			setIcon(btn, on ? 'volume-2' : 'volume-x');
			btn.setAttr('aria-label', on ? 'Mute' : 'Unmute');
		};
		paint();
		btn.onclick = () => {
			this.setReadAloud(!this.plugin.settings.ttsEnabled);
			paint();
		};
	}

	onClose(): void {
		this.remote?.detach();
		this.remote = null;
		this.speaker?.dispose();
		this.speaker = null;
		this.component.unload();
		this.contentEl.empty();
	}

	// האם הכרטיס הנוכחי מחכה לתשובה מוקלדת במקום לכפתור Show Answer
	private mustType(): boolean {
		// במדריכים ההקלדה פעילה רק במדריך שלה
		const on = this.practice
			? !!this.opts.typeAnswer
			: this.plugin.settings.typeBeforeReveal;
		return on && !this.remoteInUse && !this.isAnswerShown;
	}

	// כרטיס משפט שמוצג כמשפט (ולא ככרטיס רגיל לפי הבחירה בדשבורד).
	// card.sentence עצמו לא משתנה, כי עריכת כרטיס מפרקת אותו מחדש מהפתק
	private isSent(card: Flashcard): boolean {
		return card.sentence && this.asSentences;
	}

	// כרטיס משפט עם שדות במקומות הריקים (לא עם שלט, שאין לו מקלדת)
	private fillsBlanks(card: Flashcard): boolean {
		if (!this.isSent(card) || this.isAnswerShown || this.remoteInUse) {
			return false;
		}
		const on =
			this.opts.fillBlanks ?? this.plugin.settings.sentenceFillBlanks;
		if (!on) return false;
		const st = this.sentenceState(card);
		const words = sentenceWords(parseSentence(card.back));
		return hiddenAt(words, st.order, st.stage).size > 0;
	}

	// יש טקסט שהוקלד ועוד לא נשלח: הקשה היא אצבע על המסך, לא פקודה
	private isTyping(): boolean {
		if (this.mustType() && this.typedAnswer.trim() !== '') return true;
		const card = this.queue[this.currentIndex];
		if (!card || !this.fillsBlanks(card)) return false;
		for (const v of this.sentenceState(card).fills.values()) {
			if (v.trim() !== '') return true;
		}
		return false;
	}

	private onRemoteGesture(g: string, info: GestureInfo): void {
		const action = remoteActionFor(this.plugin.settings, g);
		if (this.isEditing) return;
		if (!action) {
			if (this.opts.remote) {
				new Notice(`${gestureLabel(g)}: not bound`, 1500);
			}
			return;
		}
		const wasTyping = this.mustType();
		// הקשה בודדת יכולה להיות גם אצבע על הכרטיס, ולכן היא לא מעידה על שלט
		if (
			info.source === 'remote' &&
			(g.startsWith('SWIPE') || action === 'flip')
		) {
			this.remoteInUse = true;
		}
		const done = this.runRemoteAction(action);
		// פעולה שנדחתה לא מציירת מחדש, והשדה צריך להיעלם גם אז
		if (wasTyping && !done && !this.mustType()) {
			void this.renderCurrentCard();
		}
		if (done && this.plugin.settings.ttsAnnounce && ANNOUNCED.has(action)) {
			this.announce = done;
		}
		// במדריך תמיד מראים גם איזו מחווה זוהתה
		if (done && this.opts.remote) {
			new Notice(`${gestureLabel(g)}: ${done}`, 1500);
		} else if (done && this.plugin.settings.remoteToast) {
			new Notice(done, 1200);
		}
	}

	// מבצע פעולה של השלט. מחזיר טקסט להודעה, או null אם לא קרה כלום
	private runRemoteAction(action: RemoteAction): string | null {
		if (action === 'exit') {
			this.close();
			return 'Review closed';
		}
		if (action === 'prev') return this.goBack();
		if (action === 'repeat') {
			if (!this.speaker) {
				new Notice(
					'Read aloud is muted. Select the speaker button to turn it on.',
				);
				return null;
			}
			this.speakCurrent(true);
			return 'Reading again';
		}

		const card = this.queue[this.currentIndex];
		if (!card) return null;

		if (action === 'flip') return this.advance(card);
		if (action === 'more') return this.showMoreWords(card);
		if (action === 'next') return this.skipCard(card);
		if (action === 'hint') {
			if (card.hint === '') {
				this.tell('This card has no hint.');
				return null;
			}
			this.isHintShown = true;
			void this.renderCurrentCard();
			this.speaker?.speak(card.hint);
			return 'Hint shown';
		}

		const rating = REMOTE_RATINGS[action];
		if (!this.isAnswerShown) {
			this.tell('Show the answer before rating.');
			return null;
		}
		const nextMeta = SRSEngine.calculateNextState(
			this.metaBeforeRating(card),
			rating.value,
			this.plugin.settings,
		);
		this.applyRating(card, nextMeta, rating.label);
		return rating.label;
	}

	private sentenceState(card: Flashcard): SentenceState {
		const count = sentenceWords(parseSentence(card.back)).length;
		if (this.sent && this.sent.card === card) {
			// אחרי עריכה שמשנה את מספר המילים, הסדר הישן כבר לא מתאים
			if (this.sent.order.length !== count) {
				this.sent.order = randomOrder(count);
			}
			return this.sent;
		}
		// כרטיס חדש עובר את כל השלבים; כרטיס שכבר נלמד נפתח ישר בשלב האחרון
		const meta = this.metaBeforeRating(card);
		const isNew =
			!card.tutorialReviewed && (!meta || meta.repetition === 0);
		this.sent = {
			card,
			stage: isNew ? 0 : SENTENCE_STAGES,
			walk: isNew,
			order: randomOrder(count),
			missed: new Set(),
			seeded: false,
			fills: new Map(),
			marks: new Map(),
		};
		return this.sent;
	}

	// השלב הבא (dir = 1) או הקודם (dir = -1) שמשנה את מה שמוסתר; null אם אין כזה
	private stageStep(
		card: Flashcard,
		st: SentenceState,
		dir: 1 | -1,
	): number | null {
		const words = sentenceWords(parseSentence(card.back));
		const now = hiddenAt(words, st.order, st.stage).size;
		for (
			let stage = st.stage + dir;
			stage >= 0 && stage <= SENTENCE_STAGES;
			stage += dir
		) {
			if (hiddenAt(words, st.order, stage).size !== now) return stage;
		}
		return null;
	}

	// האם הפיכה תסתיר עוד מילים (כרטיס משפט חדש) במקום לחשוף את התשובה
	private advancesStage(card: Flashcard): boolean {
		if (!this.isSent(card) || this.isAnswerShown) return false;
		const st = this.sentenceState(card);
		return st.walk && this.stageStep(card, st, 1) !== null;
	}

	// הפיכה (כפתור או שלט). בכרטיס משפט חדש מסתירים קודם עוד מילים, ורק אחרי
	// השלב האחרון התשובה נחשפת
	private advance(card: Flashcard): string {
		if (this.advancesStage(card)) {
			const st = this.sentenceState(card);
			st.stage = this.stageStep(card, st, 1) ?? SENTENCE_STAGES;
			void this.renderCurrentCard();
			return `Stage ${st.stage} of ${SENTENCE_STAGES}`;
		}
		this.isAnswerShown = !this.isAnswerShown;
		void this.renderCurrentCard();
		return this.isAnswerShown ? 'Answer shown' : 'Answer hidden';
	}

	// "Show more words": שלב אחד אחורה, כמו Show hint
	private showMoreWords(card: Flashcard): string | null {
		if (!this.isSent(card)) {
			this.tell('This is not a sentence card.');
			return null;
		}
		if (this.isAnswerShown) {
			this.tell('The whole sentence is shown.');
			return null;
		}
		const st = this.sentenceState(card);
		const prev = this.stageStep(card, st, -1);
		if (prev === null) {
			this.tell('All words are shown.');
			return null;
		}
		st.stage = prev;
		void this.renderCurrentCard();
		return 'More words shown';
	}

	// דילוג בלי דירוג: הכרטיס עובר לסוף התור (כרטיס שכבר דורג פשוט נשאר מאחור)
	private skipCard(card: Flashcard): string | null {
		if (this.ratedBefore.has(card)) {
			this.history.push({ card, kind: 'advanced' });
			this.currentIndex++;
		} else {
			if (this.currentIndex >= this.queue.length - 1) {
				this.tell('This is the last card.');
				return null;
			}
			this.queue.splice(this.currentIndex, 1);
			this.queue.push(card);
			this.history.push({ card, kind: 'moved' });
		}
		this.isAnswerShown = false;
		this.isHintShown = false;
		this.typedAnswer = '';
		void this.renderCurrentCard();
		return 'Skipped';
	}

	private goBack(): string | null {
		const step = this.history.pop();
		if (!step) {
			this.tell('No previous card.');
			return null;
		}
		if (step.kind === 'advanced') {
			this.currentIndex--;
		} else {
			// הכרטיס שדולג נמצא בסוף התור - מחזירים אותו למקום הנוכחי
			const at = this.queue.lastIndexOf(step.card);
			if (at >= 0) this.queue.splice(at, 1);
			this.queue.splice(this.currentIndex, 0, step.card);
		}
		this.isAnswerShown = this.ratedBefore.has(step.card);
		this.isHintShown = false;
		this.typedAnswer = '';
		void this.renderCurrentCard();
		return 'Previous card';
	}

	// הודעה שגם נאמרת בקול, כי בזמן הליכה לא מסתכלים על המסך
	private tell(msg: string): void {
		new Notice(msg, 1500);
		this.speaker?.speak(msg);
	}

	// מקריא את הצד המוצג של הכרטיס, פעם אחת לכל צד (force = הקראה חוזרת)
	private speakCurrent(force = false): void {
		const speaker = this.speaker;
		if (!speaker) return;
		const card = this.queue[this.currentIndex];
		const key = card ? `${card.id}:${this.isAnswerShown}` : 'done';
		if (!force && key === this.spokenKey) return;
		this.spokenKey = key;
		const pre = this.announce ? `${this.announce}. ` : '';
		this.announce = '';

		const next = this.queue[this.currentIndex + 1];
		if (!card) {
			speaker.speak(`${pre}Deck completed.`);
		} else if (!this.isAnswerShown) {
			speaker.speak(pre + displayFront(card));
			// מורידים מראש את מה שכנראה יוקרא אחר כך, כדי שלא יהיה המתנה
			if (this.plugin.settings.ttsReadAnswer) speaker.prefetch(card.back);
		} else if (this.plugin.settings.ttsReadAnswer || force) {
			speaker.speak(pre + card.back);
		} else if (pre) {
			speaker.speak(pre);
		}
		if (card && this.isAnswerShown && next) {
			speaker.prefetch(displayFront(next));
		}
	}

	// המצב שממנו מחשבים דירוג: לכרטיס שכבר דורג בסשן - המצב שלפני הדירוג ההוא
	private metaBeforeRating(
		card: Flashcard,
	): CardSchedulingMetadata | undefined {
		const rated = this.ratedBefore.get(card);
		return rated ? rated.before : this.plugin.store[card.id];
	}

	// כרטיסים שלא צריך לבצע להם review כרגע (מועד הבדיקה הבא שלהם בעתיד)
	private getCompletedCount(): number {
		if (this.practice) return this.ratedBefore.size;
		const now = Date.now();
		return this.deckCards.filter((c) => {
			const meta = this.plugin.store[c.id];
			return !!meta && meta.due > now;
		}).length;
	}

	private async renderCurrentCard(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		const token = ++this.renderToken;
		// אחרי שהפעולה הנוכחית מסתיימת, כדי שההודעה (announce) כבר תהיה מוכנה
		if (this.speaker) window.setTimeout(() => this.speakCurrent(), 0);

		if (this.currentIndex >= this.queue.length && this.practice) {
			// כל כרטיס דורג (דילוג רק מעביר לסוף התור), אז המדריך הושלם
			if (!this.completed) {
				this.completed = true;
				this.opts.onComplete?.();
			}
			contentEl.createEl('h2', { text: '✨ Tutorial finished' });
			if (this.opts.onComplete) {
				contentEl
					.createEl('p', { text: 'Completed ✓' })
					.setCssStyles({ color: 'var(--text-success)' });
			}
			contentEl.createEl('p', {
				text: 'Nothing from this tutorial was saved.',
			});
			const row = contentEl.createDiv();
			row.setCssStyles({ display: 'flex', gap: '8px', flexWrap: 'wrap' });
			const onFinish = this.opts.onFinish;
			if (onFinish) {
				const moreBtn = row.createEl('button', {
					text: 'More tutorials',
					cls: 'mod-cta',
				});
				moreBtn.onclick = () => {
					this.close();
					onFinish();
				};
			}
			row.createEl('button', { text: 'Close' }).onclick = () =>
				this.close();
			return;
		}

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

		const cardMeta = this.metaBeforeRating(card);
		const earlier = this.ratedBefore.get(card);

		const headerEl = contentEl.createDiv({ cls: 'srs-header-bar' });
		headerEl.setCssStyles({
			display: 'flex',
			justifyContent: 'space-between',
			alignItems: 'center',
			flexWrap: 'wrap',
			gap: '8px',
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

		const headerActions = headerEl.createDiv();
		headerActions.setCssStyles({ display: 'flex', gap: '8px' });

		this.renderMuteButton(headerActions);

		// בכרטיסי המדריך העריכה נשארת בזיכרון (ראו saveCardModification)
		const editBtn = headerActions.createEl('button', {
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
		if (token !== this.renderToken) return;

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
			if (token !== this.renderToken) return;
		}

		if (this.isSent(card) && !this.isAnswerShown) {
			bodyEl.createEl('hr');
			const st = this.sentenceState(card);
			const tokens = parseSentence(card.back);
			const stageLabel = bodyEl.createDiv({
				text:
					st.stage === 0
						? 'Full sentence'
						: st.stage >= SENTENCE_STAGES
							? `Stage ${SENTENCE_STAGES} of ${SENTENCE_STAGES}: anchor words only`
							: `Stage ${st.stage} of ${SENTENCE_STAGES}`,
			});
			stageLabel.setCssStyles({
				fontSize: '0.8em',
				opacity: '0.7',
				marginBottom: '0.25em',
			});
			const blank = hiddenAt(sentenceWords(tokens), st.order, st.stage);
			if (this.fillsBlanks(card)) {
				this.renderBlankFields(bodyEl, tokens, blank, st);
			} else {
				renderSentence(bodyEl, tokens, { blank });
			}
		}

		if (this.isAnswerShown && this.isSent(card)) {
			bodyEl.createEl('hr');
			this.renderSentenceAnswer(bodyEl, card);
		} else if (this.isAnswerShown) {
			bodyEl.createEl('hr');
			if (this.typedAnswer.trim() !== '') {
				const typedWrap = bodyEl.createDiv({ cls: 'srs-typed-answer' });
				typedWrap.setCssStyles({ marginBottom: '0.75em' });
				const typedLabel = typedWrap.createDiv({ text: 'Your answer' });
				typedLabel.setCssStyles({
					fontSize: '0.8em',
					opacity: '0.7',
					marginBottom: '0.25em',
				});
				const typedEl = typedWrap.createDiv({
					text: this.typedAnswer.trim(),
					attr: { dir: 'auto' },
				});
				typedEl.setCssStyles({ whiteSpace: 'pre-wrap' });
			}
			const backEl = bodyEl.createDiv({ cls: 'srs-back-content' });
			await MarkdownRenderer.render(
				this.app,
				card.back,
				backEl,
				card.filePath,
				this.component,
			);
			if (token !== this.renderToken) return;
		}

		if (earlier) {
			const note = contentEl.createDiv({
				text: `Rated ${earlier.label} earlier in this session. Rating it again replaces that rating.`,
			});
			note.setCssStyles({
				marginTop: '0.75em',
				fontSize: '0.85em',
				opacity: '0.75',
			});
		}

		const bottomBar = contentEl.createDiv({ cls: 'srs-bottom-bar' });
		bottomBar.setCssStyles({ marginTop: '1.5em' });

		if (!this.isAnswerShown) {
			if (this.isSent(card)) {
				const st = this.sentenceState(card);
				if (this.stageStep(card, st, -1) !== null) {
					const moreBtn = bottomBar.createEl('button', {
						text: 'Show more words',
					});
					moreBtn.setCssStyles({
						width: '100%',
						marginBottom: '8px',
					});
					moreBtn.onclick = () => {
						this.showMoreWords(card);
					};
				}
			}

			if (hasHint && !this.isHintShown) {
				const subtle = this.plugin.settings.hintButtonSubtle;
				const hintBtn = bottomBar.createEl('button', {
					text: subtle ? 'Hint' : 'Show Hint',
				});
				hintBtn.setCssStyles(
					subtle
						? {
								display: 'block',
								width: 'auto',
								height: 'auto',
								margin: '0 auto 8px',
								padding: '2px 8px',
								background: 'transparent',
								border: 'none',
								boxShadow: 'none',
								color: 'var(--text-faint)',
								fontSize: '0.75em',
								opacity: '0.6',
							}
						: { width: '100%', marginBottom: '8px' },
				);
				hintBtn.onclick = () => {
					this.isHintShown = true;
					void this.renderCurrentCard();
				};
			}

			if (this.advancesStage(card)) {
				// כרטיס משפט חדש: אותו כפתור כמו Show Answer, אבל מסתיר עוד מילים
				const nextBtn = bottomBar.createEl('button', {
					text: 'Hide more words',
					cls: 'mod-cta',
				});
				nextBtn.setCssStyles({ width: '100%' });
				nextBtn.onclick = () => {
					this.advance(card);
				};
			} else if (this.mustType() && !this.fillsBlanks(card)) {
				this.renderAnswerField(
					bottomBar,
					this.isSent(card)
						? 'Type the whole sentence'
						: 'Type your answer',
				);
			} else {
				const showBtn = bottomBar.createEl('button', {
					text: 'Show Answer',
					cls: 'mod-cta',
				});
				showBtn.setCssStyles({ width: '100%' });
				showBtn.onclick = () => {
					this.advance(card);
				};
			}
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
					this.applyRating(card, nextMeta, item.label);
				};
			}
		}
	}

	// שדה התשובה: הגב נחשף רק אחרי שליחה של טקסט לא ריק
	private renderAnswerField(parent: HTMLElement, placeholder: string): void {
		const field = parent.createEl('textarea', {
			attr: { dir: 'auto', rows: '2', placeholder },
		});
		field.value = this.typedAnswer;
		field.setCssStyles({
			display: 'block',
			width: '100%',
			marginBottom: '8px',
			resize: 'vertical',
		});

		const submitBtn = parent.createEl('button', {
			text: 'Submit',
			cls: 'mod-cta',
		});
		submitBtn.setCssStyles({ width: '100%' });

		const isBlank = (): boolean => this.typedAnswer.trim() === '';
		const submit = (): void => {
			if (isBlank()) return;
			this.isAnswerShown = true;
			void this.renderCurrentCard();
		};
		submitBtn.disabled = isBlank();
		submitBtn.onclick = submit;
		field.oninput = () => {
			this.typedAnswer = field.value;
			submitBtn.disabled = isBlank();
		};
		// Enter שולח ו-Shift+Enter יורד שורה; בזמן הרכבת אותיות Enter שייך למקלדת
		field.onkeydown = (e) => {
			if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
			e.preventDefault();
			submit();
		};
		field.focus();
		field.setSelectionRange(field.value.length, field.value.length);
	}

	// שדה הקלדה בכל מקום ריק, וכפתור Check שצובע כל שדה בירוק או באדום.
	// הקלדה לא מציירת את הכרטיס מחדש, כדי שהפוקוס והמקלדת לא ייעלמו
	private renderBlankFields(
		parent: HTMLElement,
		tokens: SentenceToken[],
		blank: Set<number>,
		st: SentenceState,
	): void {
		type Field = { w: number; core: string; input: HTMLInputElement };
		const fields: Field[] = [];
		const paintField = (f: Field): void => {
			const mark = st.marks.get(f.w);
			const color =
				mark === true
					? 'var(--text-success)'
					: mark === false
						? 'var(--text-error)'
						: '';
			f.input.setCssStyles({
				borderBottomColor: color || 'var(--text-faint)',
				color: color || 'var(--text-normal)',
			});
		};
		const filled = (f: Field): boolean =>
			(st.fills.get(f.w) ?? '').trim() !== '';

		const row = createDiv();
		const checkBtn = row.createEl('button', { text: 'Check' });
		const result = row.createSpan();
		const refresh = (): void => {
			checkBtn.disabled = !fields.some(filled);
			result.empty();
			const checked = fields.filter((f) => st.marks.has(f.w));
			if (checked.length === 0) return;
			const right = checked.filter((f) => st.marks.get(f.w)).length;
			if (right === fields.length) {
				result.createSpan({ text: 'All right ✓' }).setCssStyles({
					color: 'var(--text-success)',
					fontWeight: 'bold',
				});
				return;
			}
			result.setText(`${right} of ${fields.length} right`);
		};
		const check = (): void => {
			for (const f of fields) {
				const v = (st.fills.get(f.w) ?? '').trim();
				if (v === '') st.marks.delete(f.w);
				else st.marks.set(f.w, normWord(v) === normWord(f.core));
				paintField(f);
			}
			refresh();
			// השדה השגוי הראשון מקבל פוקוס, כדי לתקן אותו מיד
			const wrong = fields.find((f) => st.marks.get(f.w) === false);
			if (wrong) {
				wrong.input.focus();
				wrong.input.select();
			}
		};

		renderSentence(parent, tokens, {
			blank,
			makeBlank: (line, word) => {
				const input = line.createEl('input', {
					type: 'text',
					cls: 'srs-sentence-field',
					attr: {
						dir: 'auto',
						autocomplete: 'off',
						autocorrect: 'off',
						autocapitalize: 'off',
						spellcheck: 'false',
						enterkeyhint: 'next',
						'aria-label': 'Missing word',
					},
				});
				input.value = st.fills.get(word.w) ?? '';
				input.setCssStyles({
					width: `${Math.max(3, letterCount(word.core)) * 0.65 + 0.8}em`,
					height: '1.6em',
					padding: '0 0.2em',
					margin: '0 0.1em',
					border: 'none',
					borderBottom: '2px solid var(--text-faint)',
					borderRadius: '4px 4px 0 0',
					background: 'var(--background-modifier-form-field)',
					boxShadow: 'none',
					fontSize: 'inherit',
					textAlign: 'center',
					verticalAlign: 'baseline',
				});
				const f: Field = { w: word.w, core: word.core, input };
				fields.push(f);
				paintField(f);
				input.oninput = () => {
					st.fills.set(word.w, input.value);
					st.marks.delete(word.w);
					paintField(f);
					refresh();
				};
				// Enter עובר לשדה הבא, ובשדה האחרון בודק
				input.onkeydown = (e) => {
					if (e.key !== 'Enter' || e.isComposing) return;
					e.preventDefault();
					const next = fields[fields.indexOf(f) + 1];
					if (next) next.input.focus();
					else check();
				};
			},
		});

		parent.appendChild(row);
		row.setCssStyles({
			display: 'flex',
			alignItems: 'center',
			flexWrap: 'wrap',
			gap: '8px',
			marginTop: '0.5em',
		});
		result.setCssStyles({ fontSize: '0.9em' });
		checkBtn.onclick = check;
		refresh();
	}

	// צד התשובה של כרטיס משפט: המשפט המלא, המילים שהיו מוסתרות מסומנות, והשוואה למה
	// שהוקלד. הקשה על מילה מסמנת שהיא נשכחה; מילה שנשכחה אפשר להפוך לעוגן בפתק עצמו
	private renderSentenceAnswer(parent: HTMLElement, card: Flashcard): void {
		const st = this.sentenceState(card);
		const tokens = parseSentence(card.back);
		const words = sentenceWords(tokens);
		const wasHidden = hiddenAt(words, st.order, st.stage);
		const typed = this.typedAnswer.trim();
		const diff = typed !== '' ? diffSentence(words, typed) : null;
		if (diff && !st.seeded) {
			st.missed = new Set(diff.missing);
			st.seeded = true;
		}
		// מה שהוקלד במקומות הריקים: רק מילה שהוקלדה לא נכון נחשבת "שכחתי".
		// שדה ריק לא נספר, כי אפשר גם להגיד את המילה בקול
		const fillOf = (w: number): string => (st.fills.get(w) ?? '').trim();
		const filled = diff
			? []
			: words.filter((x) => wasHidden.has(x.w) && fillOf(x.w) !== '');
		const wrongFills = filled.filter(
			(x) => normWord(fillOf(x.w)) !== normWord(x.core),
		);
		if (filled.length > 0 && !st.seeded) {
			st.missed = new Set(wrongFills.map((x) => x.w));
			st.seeded = true;
		}

		const small = (el: HTMLElement): void =>
			el.setCssStyles({
				fontSize: '0.8em',
				opacity: '0.7',
				marginBottom: '0.25em',
			});

		if (diff) {
			const typedWrap = parent.createDiv({ cls: 'srs-typed-answer' });
			typedWrap.setCssStyles({ marginBottom: '0.75em' });
			small(typedWrap.createDiv({ text: 'Your answer' }));
			const typedEl = typedWrap.createDiv({ attr: { dir: 'auto' } });
			typedEl.setCssStyles({ whiteSpace: 'pre-wrap', lineHeight: '1.8' });
			let wrong = 0;
			for (const part of diff.typed) {
				if (part.ok) {
					typedEl.appendText(part.text);
					continue;
				}
				wrong++;
				typedEl.createSpan({ text: part.text }).setCssStyles({
					color: 'var(--text-warning)',
					textDecoration: 'line-through',
				});
			}
			const summary = typedWrap.createDiv();
			summary.setCssStyles({ fontSize: '0.85em', marginTop: '0.25em' });
			if (diff.missing.size === 0 && wrong === 0) {
				summary.createSpan({ text: 'Word for word ✓' }).setCssStyles({
					color: 'var(--text-success)',
				});
			} else {
				summary
					.createSpan({ text: `${diff.missing.size} missing` })
					.setCssStyles({ color: 'var(--text-error)' });
				summary.appendText(' · ');
				summary
					.createSpan({ text: `${wrong} wrong or extra` })
					.setCssStyles({ color: 'var(--text-warning)' });
			}
		}

		if (filled.length > 0) {
			const fillWrap = parent.createDiv({ cls: 'srs-typed-answer' });
			fillWrap.setCssStyles({ marginBottom: '0.75em' });
			small(fillWrap.createDiv({ text: 'Your blanks' }));
			const summary = fillWrap.createDiv();
			const right = filled.length - wrongFills.length;
			if (wrongFills.length === 0) {
				summary
					.createSpan({
						text: `${right} of ${filled.length} right ✓`,
					})
					.setCssStyles({ color: 'var(--text-success)' });
			} else {
				summary.setText(`${right} of ${filled.length} right`);
			}
			// לכל מילה שגויה: מה שהוקלד (מחוק) והמילה הנכונה
			const list = fillWrap.createDiv();
			list.setCssStyles({
				display: 'flex',
				flexWrap: 'wrap',
				gap: '4px 12px',
				marginTop: '0.25em',
			});
			for (const x of wrongFills) {
				const item = list.createSpan();
				item.createSpan({
					text: fillOf(x.w),
					attr: { dir: 'auto' },
				}).setCssStyles({
					color: 'var(--text-warning)',
					textDecoration: 'line-through',
				});
				item.appendText(' → ');
				item.createSpan({
					text: x.core,
					attr: { dir: 'auto' },
				}).setCssStyles({ color: 'var(--text-error)' });
			}
		}

		small(
			parent.createDiv({
				text:
					diff || filled.length > 0
						? 'Highlighted words were hidden. Red words are the ones you got wrong; tap a word to change its mark.'
						: 'Highlighted words were hidden. Tap the words you missed.',
			}),
		);

		// רק החלק הזה מצויר מחדש בהקשה, כדי שהחלון לא יקפוץ לראש הדף
		const area = parent.createDiv();
		const paint = (): void => {
			area.empty();
			renderSentence(area, tokens, {
				wasHidden,
				missed: st.missed,
				onTap: (w) => {
					if (st.missed.has(w)) st.missed.delete(w);
					else st.missed.add(w);
					paint();
				},
			});

			// במדריך העוגן נוסף בזיכרון בלבד (ראו makeAnchor)
			if (!this.practice && !card.filePath) return;
			const missed = words.filter((x) => st.missed.has(x.w) && !x.anchor);
			if (missed.length === 0) return;
			const anchors = area.createDiv();
			anchors.setCssStyles({ marginTop: '0.75em' });
			small(
				anchors.createDiv({
					text: 'Make anchor: the word is made bold in the note and always stays visible.',
				}),
			);
			const chips = anchors.createDiv();
			chips.setCssStyles({
				display: 'flex',
				flexWrap: 'wrap',
				gap: '6px',
			});
			for (const word of missed) {
				const chip = chips.createEl('button');
				chip.setCssStyles({ minHeight: '36px' });
				chip.createSpan({ text: '★ ' });
				// המילה בתוך אלמנט משלה, כדי שמילה בעברית לא תשנה את סדר הכפתור
				chip.createSpan({ text: word.core, attr: { dir: 'auto' } });
				chip.setAttr('aria-label', 'Make anchor');
				chip.onclick = () => {
					chip.disabled = true;
					void this.makeAnchor(card, word);
				};
			}
		};
		paint();
	}

	// עוטף את המילה ב-** בפתק. הפתק הוא מקור האמת: אין מצב נסתר מחוץ לו
	private async makeAnchor(card: Flashcard, word: WordToken): Promise<void> {
		if (this.anchorBusy) return;
		const raw = card.rawContent;
		const at = raw.lastIndexOf(card.back);
		if (at < 0 || card.back.slice(word.start, word.end) !== word.core) {
			new Notice(
				'Could not find this word in the note. Edit the card instead.',
			);
			return;
		}
		const newRaw =
			raw.slice(0, at) +
			withAnchor(card.back, word) +
			raw.slice(at + card.back.length);
		if (this.practice) {
			card.back = withAnchor(card.back, word);
			card.rawContent = newRaw;
			new Notice(
				'Anchor added. In a real deck the word is made bold in the note.',
			);
			void this.renderCurrentCard();
			return;
		}
		this.anchorBusy = true;
		try {
			await this.saveCardModification(
				card,
				newRaw,
				'Anchor word added to the note.',
			);
		} finally {
			this.anchorBusy = false;
		}
		if (this.queue[this.currentIndex] === card) {
			void this.renderCurrentCard();
		}
	}

	// הכרטיס הבא מוצג מיד, והכתיבה לקובץ רצה ברקע (היא עלולה לקחת זמן בטלפון)
	private applyRating(
		card: Flashcard,
		nextMeta: CardSchedulingMetadata,
		label: string,
	): void {
		if (this.anchorBusy) {
			new Notice('Saving the note. Rate again in a moment.', 1500);
			return;
		}
		const prev = this.metaBeforeRating(card);
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

		this.ratedBefore.set(card, { before: prev, label });
		this.history.push({ card, kind: 'advanced' });
		// במדריך לא שומרים כלום - לא ללוח הזמנים ולא לספירת הפתיחות
		if (!this.practice) {
			this.plugin.store[card.id] = nextMeta;
			void this.plugin.saveCardStore().catch(() => {
				new Notice('Could not save your rating to the data file.');
			});
		}
		this.currentIndex++;
		this.isAnswerShown = false;
		this.isHintShown = false;
		this.typedAnswer = '';
		void this.renderCurrentCard();
	}

	private async saveCardModification(
		card: Flashcard,
		newContent: string,
		doneMessage: string = 'Card edited and saved successfully.',
	): Promise<void> {
		// במדריך אין פתק: הכרטיס מתעדכן בזיכרון בלבד, באותו פירוק כמו בפתק אמיתי
		if (this.practice) {
			const updated = FlashcardParser.parseText(
				newContent,
				'',
				card.deckName,
				!!this.opts.hintDeck,
				card.sentence,
			)[0];
			if (!updated) {
				new Notice(
					'That text has no card in it. Keep a line that holds only a question mark between the question and the answer.',
				);
				return;
			}
			Object.assign(card, {
				...updated,
				id: card.id,
				tutorialReviewed: card.tutorialReviewed,
			});
			new Notice(
				'Changed in this tutorial only. In a real deck the note is updated.',
			);
			return;
		}
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
				settings.sentenceTags,
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

		new Notice(doneMessage);
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

				// דק משפטים: בחירה אם ללמוד כמשפטים או ככרטיסים רגילים. הבחירה נשמרת לכל דק
				const isSentenceDeck = stats.all.some((c) => c.sentence);
				if (isSentenceDeck) this.renderModePicker(infoDiv, deckName);

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
						null,
						!this.plugin.studiesAsFlashcards(deckName),
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
			this.renderGames(contentEl);
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
		// בטלפון תוכן המודאל הוא flex column, ובלי flexShrink מיכל גלילה נמעך עד לגובה 0
		tableContainer.setCssStyles({
			maxHeight: '400px',
			overflowY: 'auto',
			flexShrink: '0',
		});

		searchInput.oninput = (e) => {
			this.filterText = (
				e.target as HTMLInputElement
			).value.toLowerCase();
			this.renderTable(tableContainer, storeEntries);
		};

		this.renderTable(tableContainer, storeEntries);
		this.renderGames(contentEl);
	}

	// שני כפתורים קטנים: Sentences / Flashcards. הלחוץ מודגש
	private renderModePicker(parent: HTMLElement, deckName: string): void {
		const row = parent.createDiv();
		row.setCssStyles({ display: 'flex', gap: '4px', marginTop: '6px' });
		const make = (label: string, flash: boolean): HTMLButtonElement => {
			const btn = row.createEl('button', { text: label });
			btn.setCssStyles({
				fontSize: '0.75em',
				padding: '2px 8px',
				height: 'auto',
			});
			btn.onclick = () => {
				this.plugin.setStudyAsFlashcards(deckName, flash);
				paint();
			};
			return btn;
		};
		const sent = make('Sentences', false);
		const flash = make('Flashcards', true);
		const paint = (): void => {
			const asFlash = this.plugin.studiesAsFlashcards(deckName);
			sent.toggleClass('mod-cta', !asFlash);
			flash.toggleClass('mod-cta', asFlash);
			sent.setAttr('aria-pressed', String(!asFlash));
			flash.setAttr('aria-pressed', String(asFlash));
		};
		paint();
	}

	// קטגוריית משחקים בתחתית הדשבורד (משחקי עזר בלבד)
	private renderGames(parent: HTMLElement): void {
		// מדריכים אינטראקטיביים לכל מה שאינו משחק
		parent.createEl('hr');
		const learn = parent.createDiv();
		learn.setCssStyles({
			border: '1px solid var(--background-modifier-border)',
			padding: '12px',
			borderRadius: '8px',
			display: 'flex',
			justifyContent: 'space-between',
			alignItems: 'center',
			gap: '8px',
		});
		const learnInfo = learn.createDiv();
		learnInfo.createEl('strong', { text: '📘 Tutorials' });
		learnInfo
			.createDiv({
				text: 'Short hands-on lessons for every feature. Nothing in them is saved.',
			})
			.setCssStyles({ fontSize: '0.85em', opacity: '0.8' });
		learn.createEl('button', { text: 'Open' }).onclick = () => {
			this.close();
			this.plugin.openTutorials();
		};

		parent.createEl('hr');
		parent.createEl('h2', { text: 'Games' });

		const addGame = (
			name: string,
			desc: string,
			open: () => void,
		): void => {
			const row = parent.createDiv();
			row.setCssStyles({
				border: '1px solid var(--background-modifier-border)',
				padding: '12px',
				borderRadius: '8px',
				display: 'flex',
				justifyContent: 'space-between',
				alignItems: 'center',
				marginBottom: '10px',
			});

			const info = row.createDiv();
			info.createEl('strong', { text: name });
			info.createDiv({ text: desc }).setCssStyles({
				fontSize: '0.85em',
				opacity: '0.8',
			});

			const openBtn = row.createEl('button', { text: 'Open' });
			openBtn.onclick = () => {
				this.close();
				open();
			};
		};

		addGame('🚀 Blast', 'Shoot the asteroid with the right answer', () =>
			new BlastModal(this.app, this.plugin).open(),
		);
		addGame(
			'🧩 Match',
			'Match questions with answers as fast as you can',
			() => new MatchModal(this.app, this.plugin).open(),
		);
		addGame('🪢 Hangman', 'Guess the hidden answer letter by letter', () =>
			new HangmanModal(this.app, this.plugin).open(),
		);
		addGame(
			'👾 Aliens',
			'Fight off the invasion with weapons your reviews unlock',
			() => new AliensModal(this.app, this.plugin).open(),
		);
		addGame(
			'⚔️ Sword',
			'Fight off monsters with a sword your reviews upgrade',
			() => new SwordModal(this.app, this.plugin).open(),
		);
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
		// בטלפון הטבלה רחבה מהמסך: הסטטוס עובר לעמודה השנייה כדי שייראה בלי גלילה הצידה
		const statusSecond = (tr: HTMLElement): void => {
			if (Platform.isPhone && tr.lastElementChild) {
				tr.insertBefore(tr.lastElementChild, tr.children[1] ?? null);
			}
		};
		statusSecond(headerRow);

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
			statusSecond(row);
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

// סידור רווחים והסרת כפילויות בטקסט של דק. הכרטיס הראשון מבין כפילויות תמיד נשאר
export function fixCardsText(
	content: string,
	mode: DuplicateMode,
): { text: string; duplicatesCount: number } {
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

			const cleanedFront = frontLines.filter((l) => cleanStr(l) !== '');
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

	return { text: outLines.join('\n'), duplicatesCount };
}

// ============================================================================
// 5. Main Plugin Entrypoint
// ============================================================================

export default class SpacedRepetitionPlugin extends Plugin {
	settings!: SpacedRepetitionSettings;
	store: Record<string, CardSchedulingMetadata> = {};
	isSaving: boolean = false; // דגל למניעת לולאת רענון בעת שמירה
	private savingTimer: number | undefined;
	private storeWrite: Promise<void> | null = null;
	private storeDirty: boolean = false;
	blastData: BlastData = defaultBlastData();
	isSavingBlast: boolean = false;
	unlockAll: boolean = false; // המפתח הסודי ב-data.json תקין

	async onload(): Promise<void> {
		// מוודא שהכספת טעונה במלואה לפני ניסיון הקריאה מהקובץ
		this.app.workspace.onLayoutReady(async () => {
			await this.loadAllData();
			await this.loadBlastData();
		});

		// מאזין לשינויים בקובץ ברקע (עבור סנכרון עם הטלפון / LiveSync)
		this.registerEvent(
			this.app.vault.on('modify', async (file) => {
				if (file.path === this.getDataFilePath() && !this.isSaving) {
					await this.loadAllData();
				}
				if (
					file.path === this.getBlastDataFilePath() &&
					!this.isSavingBlast
				) {
					await this.loadBlastData();
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

		// נראה בפלטה כ-"Mobile-SR: Open", בדיוק כמו הכפתור ב-ribbon
		this.addCommand({
			id: 'open',
			name: 'Open',
			callback: () => {
				new DashboardModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: 'open-srs-dashboard',
			name: 'Open Spaced Repetition Dashboard',
			callback: () => {
				new DashboardModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: 'open-blast-game',
			name: 'Play Blast Game',
			callback: () => {
				new BlastModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: 'open-match-game',
			name: 'Play Match Game',
			callback: () => {
				new MatchModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: 'open-hangman-game',
			name: 'Play Hangman Game',
			callback: () => {
				new HangmanModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: 'open-aliens-game',
			name: 'Play aliens game',
			callback: () => {
				new AliensModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: 'open-sword-game',
			name: 'Play sword game',
			callback: () => {
				new SwordModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: 'open-tutorials',
			name: 'Open tutorials',
			callback: () => this.openTutorials(),
		});

		this.addCommand({
			id: 'open-remote-tutorial',
			name: 'Remote: start tutorial',
			callback: () => this.openRemoteTutorial(),
		});

		this.addCommand({
			id: 'open-remote-input-logger',
			name: 'Remote: open input logger',
			callback: () => {
				new RemoteLoggerModal(this.app, this).open();
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

	// מדריך השלט: review אמיתי על דק שנוצר בזיכרון, בלי קובץ ובלי שמירת דירוגים
	public openRemoteTutorial(onFinish?: () => void): void {
		const cards = buildRemoteTutorialCards(this.settings);
		new ReviewModal(this.app, this, [...cards], cards, {
			remote: true,
			onFinish,
			onComplete: () => this.markTutorialDone('remote'),
		}).open();
	}

	// דק משפטים שהמשתמש בחר ללמוד ככרטיסים רגילים (לפי שם הדק)
	public studiesAsFlashcards(deckName: string): boolean {
		return (this.settings.flashcardDecks ?? []).includes(deckName);
	}

	public setStudyAsFlashcards(deckName: string, on: boolean): void {
		const rest = (this.settings.flashcardDecks ?? []).filter(
			(d) => d !== deckName,
		);
		// מערך חדש, כדי לא לשנות את המערך של DEFAULT_SETTINGS
		this.settings.flashcardDecks = on ? [...rest, deckName] : rest;
		void this.saveSettings();
	}

	// מדריך שהושלם עד הסוף. נשמר ב-data.json בלבד, ולא נוגע בלוח הזמנים
	public markTutorialDone(id: string): void {
		const done = this.settings.tutorialsDone ?? [];
		if (done.includes(id)) return;
		// מערך חדש, כדי לא לשנות את המערך של DEFAULT_SETTINGS
		this.settings.tutorialsDone = [...done, id];
		void this.saveSettings();
	}

	public openTutorials(): void {
		new TutorialMenuModal(this.app, this).open();
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

	async ensureFolderExists(folderPath: string): Promise<void> {
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
		if (reconcileRemote(this.app, this.settings)) {
			await this.saveSettings();
		}
		this.unlockAll = await checkUnlockKey(this.settings.unlockKey);

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
			if (
				file.name === 'srs-data.md' ||
				file.name === 'srs-data.json' ||
				file.name === 'blast-data.md'
			)
				continue;

			const cards = await FlashcardParser.parseFile(
				file,
				this.app,
				this.settings.flashcardTags,
				this.settings.hintTags,
				this.settings.sentenceTags,
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
		stampRemote(this.app, this.settings);
		await this.saveData(this.settings);
	}

	// ------------------------------------------------------------------------
	// נתוני משחק Blast - קובץ md נפרד (ברירת מחדל: ליד srs-data.md)
	// ------------------------------------------------------------------------
	public getBlastDataFilePath(): string {
		const own = this.settings?.blastDataFolderPath ?? '';
		const raw =
			own.trim() !== '' ? own : (this.settings?.dataFolderPath ?? '');
		const folder = raw.trim().replace(/^\/+|\/+$/g, '');
		return folder ? `${folder}/blast-data.md` : 'blast-data.md';
	}

	// תיקיית קבצי המוזיקה של משחק: game-music/<משחק> ליד blast-data.md
	public getGameMusicFolder(game: GameId): string {
		const filePath = this.getBlastDataFilePath();
		const slash = filePath.lastIndexOf('/');
		const base = slash > 0 ? `${filePath.substring(0, slash)}/` : '';
		return `${base}game-music/${game}`;
	}

	private getVaultBlastFile(): TFile | null {
		const file = this.app.vault.getAbstractFileByPath(
			this.getBlastDataFilePath(),
		);
		if (file instanceof TFile) return file;
		const files = this.app.vault.getFiles();
		return files.find((f) => f.name === 'blast-data.md') || null;
	}

	async loadBlastData(): Promise<void> {
		let data = defaultBlastData();
		let migrated = false;
		const file = this.getVaultBlastFile();

		if (file instanceof TFile) {
			try {
				const content = await this.app.vault.read(file);
				const match = content.match(/```json\s+([\s\S]*?)\s+```/);
				let parsed: unknown = null;
				if (match && match[1]) {
					parsed = JSON.parse(match[1]);
				} else {
					try {
						parsed = JSON.parse(content);
					} catch {
						console.warn('Blast data file is not valid JSON');
					}
				}
				if (parsed && typeof parsed === 'object') {
					const p = parsed as Partial<BlastData>;
					data = {
						highScore:
							typeof p.highScore === 'number' ? p.highScore : 0,
						bestStreak:
							typeof p.bestStreak === 'number' ? p.bestStreak : 0,
						games: typeof p.games === 'number' ? p.games : 0,
						matchBest: {},
						matchGames:
							typeof p.matchGames === 'number' ? p.matchGames : 0,
						hangmanBest: {},
						hangmanGames:
							typeof p.hangmanGames === 'number'
								? p.hangmanGames
								: 0,
						aliensHigh:
							typeof p.aliensHigh === 'number' ? p.aliensHigh : 0,
						aliensBestTime:
							typeof p.aliensBestTime === 'number'
								? p.aliensBestTime
								: 0,
						swordBest:
							typeof p.swordBest === 'number' ? p.swordBest : 0,
						swordGames:
							typeof p.swordGames === 'number' ? p.swordGames : 0,
						aliensGames:
							typeof p.aliensGames === 'number'
								? p.aliensGames
								: 0,
					};
					const readMap = (
						src: unknown,
						dst: Record<string, number>,
					): void => {
						if (!src || typeof src !== 'object') return;
						for (const [k, v] of Object.entries(src)) {
							if (typeof v === 'number') dst[k] = v;
						}
					};
					readMap(p.matchBest, data.matchBest);
					readMap(p.hangmanBest, data.hangmanBest);
				}
			} catch (err) {
				console.error('Error reading Blast data file:', err);
				// לא דורסים את הזיכרון כדי לא לאבד נתונים
				return;
			}
		} else if ((this.settings?.blastHighScore ?? 0) > 0) {
			// מעבר מהגרסה הקודמת: השיא היה שמור ב-data.json
			data.highScore = this.settings.blastHighScore ?? 0;
			migrated = true;
		}

		this.blastData = data;

		if (migrated) {
			await this.saveBlastData();
			delete this.settings.blastHighScore;
			await this.saveSettings();
		}
	}

	async saveBlastData(): Promise<void> {
		this.isSavingBlast = true;
		try {
			const filePath = this.getBlastDataFilePath();
			const slash = filePath.lastIndexOf('/');
			if (slash > 0) {
				await this.ensureFolderExists(filePath.substring(0, slash));
			}

			const jsonString = JSON.stringify(this.blastData, null, 2);
			const markdownContent = `---\ntags: [blast-game-data]\n---\n# Blast Game Data\n\n> ⚠️ **Warning:** Do not edit this file manually unless you know what you are doing. The Blast game reads and writes directly from the code block below.\n\n\`\`\`json\n${jsonString}\n\`\`\`\n`;

			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (file instanceof TFile) {
				await this.app.vault.modify(file, markdownContent);
			} else {
				const oldFile = this.getVaultBlastFile();
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
			window.setTimeout(() => {
				this.isSavingBlast = false;
			}, 1000);
		}
	}

	async applyBlastDataLocation(): Promise<void> {
		await this.saveSettings();
		await this.saveBlastData();
		new Notice(`Blast data saved to: ${this.getBlastDataFilePath()}`);
	}

	// כתיבה אחת בכל רגע: שמירה שמגיעה באמצע כתיבה מסמנת שצריך לכתוב שוב בסיומה.
	// isSaving נשאר דלוק לכל האורך, כדי שטעינה מהדיסק לא תדרוס דירוג שעוד לא נכתב
	saveCardStore(): Promise<void> {
		this.isSaving = true;
		window.clearTimeout(this.savingTimer);
		if (this.storeWrite) {
			this.storeDirty = true;
			return this.storeWrite;
		}
		this.storeWrite = this.runStoreWrites();
		return this.storeWrite;
	}

	private async runStoreWrites(): Promise<void> {
		try {
			do {
				this.storeDirty = false;
				await this.writeCardStore();
			} while (this.storeDirty);
		} finally {
			this.storeWrite = null;
			// שחרור הדגל לאחר זמן קצר כדי לאפשר לאירועי ה-modify להסתיים
			this.savingTimer = window.setTimeout(() => {
				this.isSaving = false;
			}, 1000);
		}
	}

	private async writeCardStore(): Promise<void> {
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
	}

	async applyDataLocation(): Promise<void> {
		await this.saveSettings();
		await this.saveCardStore();
		// קובץ ה-Blast עוקב אחרי תיקיית הכרטיסים אם לא הוגדר לו נתיב משלו
		await this.saveBlastData();
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
		const { text: finalContent, duplicatesCount } = fixCardsText(
			content,
			mode,
		);
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
