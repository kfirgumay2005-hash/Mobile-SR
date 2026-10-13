import {
	App,
	Component,
	MarkdownRenderer,
	Modal,
	Notice,
	Platform,
} from 'obsidian';
import type SpacedRepetitionPlugin from './main';
import type { Flashcard } from './main';
import { el, shuffle, stripMd } from './blast';
import { GameMusic, renderMusicPanel } from './music';
import { effectivePick, renderRewardPicker, rewardTier } from './rewards';

// ============================================================================
// Hangman - איש תלוי
//
// מוצג צד אחד של הכרטיס כרמז, והצד השני (הקצר מביניהם) מוסתר. מנחשים אות
// אחרי אות, במקלדת שעל המסך או במקלדת הרגילה. 6 טעויות והאיש נתלה.
//   • הכרטיסים נבחרים באקראיות מהחפיסה שנבחרה (לא רק כאלה שהגיע זמנם).
//   • פותרים מילה אחרי מילה; הרצף נגמר במילה הראשונה שנכשלים בה.
//   • ניקוד מוצג אבל לא צריך לנחש אותו, ואות סופית נחשבת כאות הרגילה.
//   • לחצן הרמז חושף אות אחת בכל לחיצה, עד חצי מהאותיות של התשובה.
//   • לחצן הדילוג עובר לכרטיס הבא בלי להשפיע על הרצף (לא מוסיף ולא שובר).
//   • המשחק לא משפיע על FSRS.
// הרצף הטוב ביותר נשמר לכל חפיסה בקובץ blast-data.md.
// ============================================================================

const MAX_WRONG = 6;
const MIN_LETTERS = 2;
const MAX_LETTERS = 24;
// המפתח של "כל החפיסות" בטבלת השיאים
const ALL_DECKS_KEY = '*';

// אלפבית מלא לכתבים נפוצים. לכל כתב אחר (ולאותיות נוספות כמו ß או і) המקלדת
// נבנית מהאותיות שמופיעות בחפיסה עצמה
const ALPHABETS: Record<string, string[]> = {
	Latin: Array.from('abcdefghijklmnopqrstuvwxyz'),
	Hebrew: Array.from('אבגדהוזחטיכלמנסעפצקרשת'),
	Cyrillic: Array.from('абвгдежзийклмнопрстуфхцчшщъыьэюя'),
	Greek: Array.from('αβγδεζηθικλμνξοπρστυφχψω'),
	Arabic: Array.from('ابتثجحخدذرزسشصضطظعغفقكلمنهوي'),
};
const SCRIPTS = [
	'Latin',
	'Hebrew',
	'Cyrillic',
	'Greek',
	'Arabic',
	'Armenian',
	'Georgian',
	'Devanagari',
	'Bengali',
	'Thai',
	'Hangul',
	'Hiragana',
	'Katakana',
	'Han',
];
const SCRIPT_RES: [string, RegExp][] = SCRIPTS.map((s) => [
	s,
	new RegExp(`\\p{Script=${s}}`, 'u'),
]);
const OTHER_SCRIPT = 'Other';
const scriptOf = (ch: string): string => {
	for (const [name, re] of SCRIPT_RES) {
		if (re.test(ch)) return name;
	}
	return OTHER_SCRIPT;
};
// כתבים שבהם סימן מעל האות הוא תוספת לאות הבסיס (é מנחשים כ-e). בכתבים
// אחרים אות מורכבת היא אות בפני עצמה (й היא לא и)
const SPLIT_MARKS = new Set(['Latin', 'Hebrew', 'Greek', 'Arabic']);
// כתבים שבהם המקשים מוצגים באות גדולה
const UPPERCASE = new Set(['Latin', 'Cyrillic', 'Greek', 'Armenian']);
// צורות סופיות שנחשבות כאות הרגילה
const FINALS: Record<string, string> = {
	ך: 'כ',
	ם: 'מ',
	ן: 'נ',
	ף: 'פ',
	ץ: 'צ',
	ς: 'σ',
};
const LETTER_RE = /\p{L}/u;
// ניקוד, טעמים וסימנים דיאקריטיים: מוצמדים לאות שלפניהם
const MARK_RE = /\p{M}/u;
const RTL_RE =
	/[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}]/u;
// מעל המספר הזה (למשל בסינית) המקלדת מציגה רק חלק מהאותיות
const MAX_KEYS = 48;
const KEYS_WHEN_LARGE = 36;

// האות שצריך לנחש בשביל התו הזה, או null אם זה לא תו שמנחשים
const letterKey = (ch: string): string | null => {
	if (!LETTER_RE.test(ch)) return null;
	const l = ch.toLowerCase();
	return FINALS[l] ?? l;
};

const questionText = (card: Flashcard): string =>
	card.hint !== '' ? card.firstLine : card.front;

interface Slot {
	display: string;
	key: string | null;
	revealed: boolean;
	el: HTMLElement | null;
}

interface Puzzle {
	words: Slot[][];
	keys: Set<string>;
	clue: string;
	path: string;
	scripts: string[]; // הכתבים של האותיות המוסתרות, לבניית המקלדת
	rtl: boolean;
}

// מפרק טקסט למילים ואותיות. מחזיר null אם הטקסט לא מתאים לניחוש
// (כמה שורות, ארוך מדי, או כמעט בלי אותיות)
function parseTarget(raw: string): { words: Slot[][]; letters: number } | null {
	if (/<br\s*\/?>/i.test(raw)) return null;
	const lines = raw
		.split('\n')
		.map(stripMd)
		.filter((l) => l !== '');
	const line = lines[0];
	if (lines.length !== 1 || line === undefined) return null;

	const words: Slot[][] = [];
	let cur: Slot[] = [];
	let letters = 0;
	let total = 0;
	for (const raw of Array.from(line.normalize('NFC'))) {
		if (raw === ' ') {
			if (cur.length > 0) words.push(cur);
			cur = [];
			continue;
		}
		if (MARK_RE.test(raw)) {
			const last = cur[cur.length - 1];
			if (last) last.display += raw;
			continue;
		}
		// אות עם סימן: מנחשים את אות הבסיס, והסימן מוצג יחד איתה
		const parts = Array.from(raw.normalize('NFD'));
		const base = parts[0] ?? raw;
		const split = parts.length > 1 && SPLIT_MARKS.has(scriptOf(base));
		const key = letterKey(split ? base : raw);
		if (key !== null) letters++;
		total++;
		cur.push({ display: raw, key, revealed: key === null, el: null });
	}
	if (cur.length > 0) words.push(cur);
	if (letters < MIN_LETTERS || letters > MAX_LETTERS) return null;
	if (letters * 2 < total) return null;
	return { words, letters };
}

// בוחר מה לנחש: הצד הקצר יותר של הכרטיס, והצד השני הוא הרמז
function buildPuzzle(card: Flashcard): Puzzle | null {
	const q = questionText(card);
	const a = card.back;
	const pq = parseTarget(q);
	const pa = parseTarget(a);
	let words: Slot[][];
	let clue: string;
	if (pq && (!pa || pq.letters <= pa.letters)) {
		words = pq.words;
		clue = a;
	} else if (pa) {
		words = pa.words;
		clue = q;
	} else {
		return null;
	}
	if (clue.trim() === '') return null;

	const keys = new Set<string>();
	for (const w of words) {
		for (const s of w) {
			if (s.key !== null) keys.add(s.key);
		}
	}
	const scripts: string[] = [];
	let rtl = false;
	for (const k of keys) {
		const s = scriptOf(k);
		if (!scripts.includes(s)) scripts.push(s);
		if (RTL_RE.test(k)) rtl = true;
	}
	return { words, keys, clue, path: card.filePath, scripts, rtl };
}

// עיצובי הדמות. עיצוב i נפתח בדרגה i (ראו rewards.ts).
// bg ריק = בלי לוח רקע, בצבעי ערכת הנושא של Obsidian
interface HangmanTheme {
	name: string;
	bg: string;
	gallows: string;
	body: string;
	dash: string;
	glow: string;
	hat: 'none' | 'cowboy' | 'crown';
}

const HANGMAN_THEMES: HangmanTheme[] = [
	{
		name: 'Classic',
		bg: '',
		gallows: 'currentColor',
		body: 'currentColor',
		dash: '',
		glow: '',
		hat: 'none',
	},
	{
		name: 'Chalk',
		bg: '#2f4f3f',
		gallows: '#cfd8dc',
		body: '#ffffff',
		dash: '9 5',
		glow: '',
		hat: 'none',
	},
	{
		name: 'Neon',
		bg: '#0b0b1e',
		gallows: '#ff4081',
		body: '#18ffff',
		dash: '',
		glow: 'drop-shadow(0 0 3px #18ffff)',
		hat: 'none',
	},
	{
		name: 'Western',
		bg: 'linear-gradient(#ffb74d, #e64a19)',
		gallows: '#3e2723',
		body: '#212121',
		dash: '',
		glow: '',
		hat: 'cowboy',
	},
	{
		name: 'Royal',
		bg: 'linear-gradient(#283593, #0d0d2b)',
		gallows: '#ffd54f',
		body: '#fff8e1',
		dash: '',
		glow: 'drop-shadow(0 0 2px #ffd54f)',
		hat: 'crown',
	},
];

// מצייר את הגרדום ומחזיר את חלקי הגוף לפי סדר הטעויות
function drawFigure(
	parent: HTMLElement,
	theme: HangmanTheme,
	scale: number,
): SVGElement[] {
	const panel = parent.createDiv();
	panel.setCssStyles({
		display: 'flex',
		background: theme.bg,
		borderRadius: '10px',
		padding: theme.bg !== '' ? `${Math.round(6 * scale)}px` : '0',
		color: 'var(--text-normal)',
	});
	const svg = el('svg', {
		viewBox: '0 0 120 130',
		width: Math.round(130 * scale),
		height: Math.round(140 * scale),
	});
	svg.setCssStyles({ filter: theme.glow });
	panel.appendChild(svg);
	const line = {
		'stroke-width': 4,
		'stroke-linecap': 'round',
		'stroke-linejoin': 'round',
		fill: 'none',
	};
	const gallows = { ...line, stroke: theme.gallows };
	const body: Record<string, string | number> = {
		...line,
		stroke: theme.body,
	};
	if (theme.dash !== '') body['stroke-dasharray'] = theme.dash;
	// הגרדום
	el('path', { d: 'M8 124 H72 M24 124 V8 H80 V22', ...gallows }, svg);
	el('path', { d: 'M24 30 L44 8', ...gallows, 'stroke-width': 3 }, svg);

	// הראש, יחד עם הכובע של העיצוב
	const head = el('g', {}, svg);
	el('circle', { cx: 80, cy: 34, r: 12, ...body }, head);
	if (theme.hat === 'cowboy') {
		el(
			'path',
			{
				d: 'M62 25 H98 M71 25 C71 12 89 12 89 25',
				...line,
				stroke: '#4e342e',
				fill: '#6d4c41',
			},
			head,
		);
	} else if (theme.hat === 'crown') {
		el(
			'path',
			{
				d: 'M69 24 L67 11 L74 18 L80 9 L86 18 L93 11 L91 24 Z',
				...line,
				'stroke-width': 2,
				stroke: '#ffb300',
				fill: '#ffd54f',
			},
			head,
		);
	}
	return [
		head,
		el('path', { d: 'M80 46 V84', ...body }, svg),
		el('path', { d: 'M80 56 L62 70', ...body }, svg),
		el('path', { d: 'M80 56 L98 70', ...body }, svg),
		el('path', { d: 'M80 84 L64 108', ...body }, svg),
		el('path', { d: 'M80 84 L96 108', ...body }, svg),
	];
}

type Phase = 'menu' | 'playing' | 'pause' | 'over';

export class HangmanModal extends Modal {
	private plugin: SpacedRepetitionPlugin;
	private component: Component = new Component();

	private menuEl!: HTMLElement;
	private gameEl!: HTMLElement;
	private streakEl!: HTMLElement;
	private clueEl!: HTMLElement;
	private mistakesEl!: HTMLElement;
	private wordEl!: HTMLElement;
	private bottomEl!: HTMLElement;
	private parts: SVGElement[] = [];
	private keyBtns = new Map<string, HTMLButtonElement>();

	private phase: Phase = 'menu';
	private closed = false;
	private session = 0;
	private win: Window | null = null;

	private deckKey = ALL_DECKS_KEY;
	private deckLabel = '';
	private deckCards: Flashcard[] = [];
	// האותיות שמופיעות בתשובות של החפיסה, לפי כתב
	private deckKeys = new Map<string, Set<string>>();
	private queue: Flashcard[] = [];
	private puzzle: Puzzle | null = null;
	private guessed = new Set<string>();
	private wrong = 0;
	private hintsLeft = 0;
	private hintBtn: HTMLButtonElement | null = null;
	private streak = 0;
	private music: GameMusic;

	constructor(app: App, plugin: SpacedRepetitionPlugin) {
		super(app);
		this.plugin = plugin;
		this.music = new GameMusic(plugin, 'hangman');
	}

	onOpen(): void {
		this.modalEl.addClass('srs-hangman-modal');
		this.contentEl.empty();
		this.component.load();
		this.menuEl = this.contentEl.createDiv();
		this.gameEl = this.contentEl.createDiv();
		this.gameEl.setCssStyles({ display: 'none' });
		this.win = this.contentEl.win;
		this.win.addEventListener('keydown', this.onKey);
		void this.showMenu();
	}

	onClose(): void {
		this.closed = true;
		this.music.stop();
		this.win?.removeEventListener('keydown', this.onKey);
		// רצף שנקטע באמצע עדיין נחשב לשיא
		if (this.phase === 'playing' || this.phase === 'pause') {
			this.commit(false);
		}
		this.component.unload();
		this.contentEl.empty();
	}

	private onKey = (e: KeyboardEvent): void => {
		if (this.phase !== 'playing') return;
		if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
		const key = letterKey(e.key);
		if (key === null || !this.keyBtns.has(key)) return;
		e.preventDefault();
		this.guess(key);
	};

	// ------------------------------------------------------------------
	// תפריט
	// ------------------------------------------------------------------
	private async showMenu(): Promise<void> {
		this.session++;
		this.phase = 'menu';
		this.gameEl.setCssStyles({ display: 'none' });
		this.menuEl.setCssStyles({ display: 'block' });
		this.menuEl.empty();
		this.menuEl.createEl('h2', { text: '🪢 Hangman' });
		this.menuEl.createEl('p', { text: 'Loading your cards…' });

		await this.plugin.loadBlastData();
		const all = (await this.plugin.scanAllCards()).filter(
			(c) => buildPuzzle(c) !== null,
		);
		if (this.closed) return;

		const decks = new Map<string, Flashcard[]>();
		for (const c of all) {
			let d = decks.get(c.deckName);
			if (!d) {
				d = [];
				decks.set(c.deckName, d);
			}
			d.push(c);
		}
		const bd = this.plugin.blastData;

		const m = this.menuEl;
		m.empty();
		m.createEl('h2', { text: '🪢 Hangman' });
		m.createEl('p', {
			text: `One side of a card is the clue and the other is hidden. Guess it letter by letter: ${MAX_WRONG} wrong letters and the run is over. Solve as many cards in a row as you can. You can reveal up to half of the letters, or skip a card without affecting your streak. Hangman is practice only and never changes your review schedule.`,
		});
		const stats = m.createDiv();
		stats.setCssStyles({ fontWeight: 'bold', marginBottom: '0.75em' });
		stats.setText(`🎮 Games: ${bd.hangmanGames}`);

		// בחירת עיצוב לדמות: כל עיצוב נפתח לפי ההתקדמות ב-review הרגיל
		renderRewardPicker(m, this.plugin, {
			title: 'Figure design',
			names: HANGMAN_THEMES.map((t) => t.name),
			get: () => this.plugin.settings.hangmanTheme,
			set: (i) => {
				this.plugin.settings.hangmanTheme = i;
			},
			draw: (cell, i) => {
				const t = HANGMAN_THEMES[i];
				if (t) drawFigure(cell, t, 0.36);
			},
		});
		renderMusicPanel(m, this.plugin, 'hangman', this.music);

		const box = m.createDiv();
		box.setCssStyles({
			display: 'grid',
			gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
			gap: '10px',
		});

		const add = (key: string, name: string, cards: Flashcard[]): void => {
			const deckCard = box.createDiv();
			deckCard.setCssStyles({
				border: '1px solid var(--background-modifier-border)',
				padding: '12px',
				borderRadius: '8px',
				display: 'flex',
				justifyContent: 'space-between',
				alignItems: 'center',
				gap: '8px',
			});
			const infoDiv = deckCard.createDiv();
			infoDiv.createEl('strong', { text: name }).setAttr('dir', 'auto');
			infoDiv
				.createDiv({ text: `${cards.length} playable cards` })
				.setCssStyles({ fontSize: '0.85em' });
			const best = bd.hangmanBest[key];
			infoDiv
				.createDiv({
					text:
						best !== undefined
							? `🏆 Best streak: ${best}`
							: 'No best streak yet',
				})
				.setCssStyles({ fontSize: '0.85em', opacity: '0.8' });
			const btn = deckCard.createEl('button', {
				text: 'Play',
				cls: 'mod-cta',
			});
			btn.onclick = () => {
				this.deckKey = key;
				this.deckLabel = name;
				this.deckCards = cards;
				this.startGame();
			};
		};
		if (decks.size > 1) add(ALL_DECKS_KEY, 'All decks', all);
		for (const [name, cards] of decks.entries()) add(name, name, cards);

		if (all.length === 0) {
			m.createEl('p', {
				text: 'No playable cards found. Hangman needs cards with a short, single-line question or answer.',
			});
		}
	}

	// ------------------------------------------------------------------
	// משחק
	// ------------------------------------------------------------------
	private startGame(): void {
		if (this.deckCards.length === 0) {
			new Notice('This deck has no cards that fit Hangman.');
			return;
		}
		this.session++;
		this.streak = 0;
		this.queue = [];
		this.music.start();

		this.deckKeys.clear();
		for (const c of this.deckCards) {
			for (const k of buildPuzzle(c)?.keys ?? []) {
				const s = scriptOf(k);
				let set = this.deckKeys.get(s);
				if (!set) {
					set = new Set<string>();
					this.deckKeys.set(s, set);
				}
				set.add(k);
			}
		}

		this.menuEl.setCssStyles({ display: 'none' });
		const g = this.gameEl;
		g.setCssStyles({ display: 'block' });
		g.empty();

		const header = g.createDiv();
		header.setCssStyles({
			display: 'flex',
			justifyContent: 'space-between',
			alignItems: 'center',
			gap: '8px',
			marginBottom: '8px',
		});
		const title = header.createDiv({ text: this.deckLabel });
		title.setAttr('dir', 'auto');
		title.setCssStyles({ opacity: '0.8', fontSize: '0.9em', flex: '1' });
		this.streakEl = header.createDiv();
		this.streakEl.setCssStyles({ fontWeight: 'bold', fontSize: '1.2em' });
		const best = this.plugin.blastData.hangmanBest[this.deckKey];
		const bestEl = header.createDiv({
			text: best !== undefined ? `🏆 ${best}` : '',
		});
		bestEl.setCssStyles({
			opacity: '0.8',
			fontSize: '0.9em',
			flex: '1',
			textAlign: 'end',
		});

		this.clueEl = g.createDiv();
		this.clueEl.setAttr('dir', 'auto');
		this.clueEl.setCssStyles({
			padding: '8px 12px',
			background: 'var(--background-secondary)',
			border: '1px solid var(--background-modifier-border)',
			borderRadius: '10px',
			textAlign: 'center',
			maxHeight: '9em',
			overflowY: 'auto',
		});

		this.buildFigure(g);
		this.mistakesEl = g.createDiv();
		this.mistakesEl.setCssStyles({
			textAlign: 'center',
			fontSize: '0.85em',
			opacity: '0.8',
		});

		this.wordEl = g.createDiv();
		this.wordEl.setCssStyles({
			display: 'flex',
			flexWrap: 'wrap',
			justifyContent: 'center',
			gap: '6px 18px',
			margin: '14px 0',
			fontSize: Platform.isPhone ? '1.3em' : '1.6em',
			fontWeight: 'bold',
			minHeight: '1.8em',
		});

		this.bottomEl = g.createDiv();
		this.nextWord();
	}

	private buildFigure(parent: HTMLElement): void {
		const wrap = parent.createDiv();
		wrap.setCssStyles({
			display: 'flex',
			justifyContent: 'center',
			marginTop: '8px',
		});
		const pick = effectivePick(
			this.plugin.settings.hangmanTheme,
			rewardTier(this.plugin),
			HANGMAN_THEMES.length,
		);
		const theme = HANGMAN_THEMES[pick] ?? HANGMAN_THEMES[0];
		this.parts = theme ? drawFigure(wrap, theme, 1) : [];
	}

	private renderStatus(): void {
		this.streakEl.setText(`🔥 ${this.streak}`);
		this.mistakesEl.setText(`Mistakes: ${this.wrong} / ${MAX_WRONG}`);
		this.parts.forEach((p, i) =>
			p.setAttribute('visibility', i < this.wrong ? 'visible' : 'hidden'),
		);
	}

	private nextWord(): void {
		let puzzle: Puzzle | null = null;
		while (!puzzle) {
			// כשהחפיסה נגמרת מערבבים אותה מחדש והרצף ממשיך
			if (this.queue.length === 0) {
				this.queue = shuffle(this.deckCards.slice());
			}
			const card = this.queue.shift();
			if (!card) return;
			puzzle = buildPuzzle(card);
		}
		this.puzzle = puzzle;
		this.guessed = new Set<string>();
		this.wrong = 0;
		// מותר לחשוף עד חצי מהאותיות של התשובה
		let letters = 0;
		for (const w of puzzle.words) {
			for (const s of w) {
				if (s.key !== null) letters++;
			}
		}
		this.hintsLeft = Math.floor(letters / 2);
		this.phase = 'playing';

		this.clueEl.empty();
		void MarkdownRenderer.render(
			this.app,
			puzzle.clue,
			this.clueEl,
			puzzle.path,
			this.component,
		);

		this.wordEl.empty();
		this.wordEl.setAttr('dir', puzzle.rtl ? 'rtl' : 'ltr');
		for (const word of puzzle.words) {
			const w = this.wordEl.createDiv();
			w.setCssStyles({ display: 'flex', gap: '4px' });
			for (const slot of word) {
				const s = w.createDiv();
				s.setCssStyles({
					minWidth: slot.key !== null ? '1em' : '0.4em',
					textAlign: 'center',
					lineHeight: '1.5',
					borderBottom:
						slot.key !== null
							? '2px solid var(--text-muted)'
							: '2px solid transparent',
				});
				slot.el = s;
				this.paintSlot(slot);
			}
		}

		this.buildKeyboard(puzzle);
		this.renderStatus();
	}

	private paintSlot(slot: Slot, color = ''): void {
		if (!slot.el) return;
		slot.el.setText(slot.revealed ? slot.display : ' ');
		slot.el.setCssStyles({ color });
	}

	private buildKeyboard(puzzle: Puzzle): void {
		this.bottomEl.empty();
		this.keyBtns.clear();
		const size = Platform.isPhone ? '2.2em' : '2.5em';
		const addRow = (script: string): void => {
			const letters = this.keyboardLetters(script, puzzle);
			const first = letters[0];
			if (first === undefined) return;
			const upper = UPPERCASE.has(script);
			const row = this.bottomEl.createDiv();
			row.setAttr('dir', RTL_RE.test(first) ? 'rtl' : 'ltr');
			row.setCssStyles({
				display: 'flex',
				flexWrap: 'wrap',
				justifyContent: 'center',
				gap: '6px',
				marginBottom: '10px',
			});
			for (const l of letters) {
				const big = l.toUpperCase();
				const btn = row.createEl('button', {
					text: upper && big.length === l.length ? big : l,
				});
				btn.setCssStyles({
					width: size,
					height: size,
					padding: '0',
					fontSize: '1.05em',
					fontWeight: 'bold',
				});
				btn.onclick = () => this.guess(l);
				this.keyBtns.set(l, btn);
			}
		};
		for (const script of puzzle.scripts) addRow(script);

		const actions = this.bottomEl.createDiv();
		actions.setCssStyles({
			display: 'flex',
			flexWrap: 'wrap',
			justifyContent: 'center',
			gap: '8px',
			marginTop: '4px',
		});
		this.hintBtn = actions.createEl('button');
		this.hintBtn.onclick = () => this.revealLetter();
		this.renderHintBtn();
		actions.createEl('button', { text: '⏭ Skip' }).onclick = () =>
			this.skip();
	}

	// המקשים של כתב אחד: האלפבית המלא אם הוא מוכר, ועוד כל אות מהחפיסה.
	// בכתב עם הרבה מאוד אותיות מוצגות אותיות התשובה ועוד אותיות אקראיות
	private keyboardLetters(script: string, puzzle: Puzzle): string[] {
		const base = ALPHABETS[script] ?? [];
		const extra = Array.from(this.deckKeys.get(script) ?? [])
			.filter((k) => !base.includes(k))
			.sort();
		const all = [...base, ...extra];
		for (const k of puzzle.keys) {
			if (scriptOf(k) === script && !all.includes(k)) all.push(k);
		}
		if (all.length <= MAX_KEYS) return all;
		const own = all.filter((k) => puzzle.keys.has(k));
		const decoys = shuffle(all.filter((k) => !puzzle.keys.has(k))).slice(
			0,
			Math.max(0, KEYS_WHEN_LARGE - own.length),
		);
		return [...own, ...decoys].sort();
	}

	private renderHintBtn(): void {
		if (!this.hintBtn) return;
		this.hintBtn.setText(`💡 Reveal a letter (${this.hintsLeft} left)`);
		this.hintBtn.disabled = this.hintsLeft <= 0;
	}

	// מסמן מקש כמנוצל אם כל המופעים של האות כבר גלויים
	private syncKey(puzzle: Puzzle, key: string): void {
		for (const w of puzzle.words) {
			for (const s of w) {
				if (s.key === key && !s.revealed) return;
			}
		}
		this.guessed.add(key);
		const btn = this.keyBtns.get(key);
		if (btn) {
			btn.disabled = true;
			btn.setCssStyles({
				background: 'var(--color-green)',
				color: 'var(--text-on-accent)',
			});
		}
	}

	// רמז: חושף אות מוסתרת אחת באקראי
	private revealLetter(): void {
		const puzzle = this.puzzle;
		if (this.phase !== 'playing' || !puzzle || this.hintsLeft <= 0) return;
		const hidden: Slot[] = [];
		for (const w of puzzle.words) {
			for (const s of w) {
				if (!s.revealed) hidden.push(s);
			}
		}
		const slot = hidden[Math.floor(Math.random() * hidden.length)];
		if (!slot || slot.key === null) return;
		this.hintsLeft--;
		slot.revealed = true;
		this.paintSlot(slot, 'var(--text-accent)');
		this.syncKey(puzzle, slot.key);
		this.renderHintBtn();
		if (hidden.length === 1) this.onSolved(puzzle);
	}

	// דילוג: מציג את התשובה ועובר לכרטיס הבא. הרצף לא משתנה
	private skip(): void {
		const puzzle = this.puzzle;
		if (this.phase !== 'playing' || !puzzle) return;
		this.phase = 'pause';
		for (const w of puzzle.words) {
			for (const s of w) {
				if (!s.revealed) {
					s.revealed = true;
					this.paintSlot(s, 'var(--text-muted)');
				}
			}
		}
		const session = this.session;
		window.setTimeout(() => {
			if (this.closed || session !== this.session) return;
			this.nextWord();
		}, 1500);
	}

	private guess(key: string): void {
		const puzzle = this.puzzle;
		if (this.phase !== 'playing' || !puzzle || this.guessed.has(key))
			return;
		this.guessed.add(key);
		const hit = puzzle.keys.has(key);

		const btn = this.keyBtns.get(key);
		if (btn) {
			btn.disabled = true;
			btn.setCssStyles({
				background: hit ? 'var(--color-green)' : 'var(--color-red)',
				color: 'var(--text-on-accent)',
				opacity: hit ? '1' : '0.45',
			});
		}

		if (!hit) {
			this.wrong++;
			this.renderStatus();
			if (this.wrong >= MAX_WRONG) this.onLost(puzzle);
			return;
		}

		let done = true;
		for (const w of puzzle.words) {
			for (const s of w) {
				if (s.key === key) {
					s.revealed = true;
					this.paintSlot(s);
				}
				if (!s.revealed) done = false;
			}
		}
		if (done) this.onSolved(puzzle);
	}

	private onSolved(puzzle: Puzzle): void {
		this.phase = 'pause';
		this.streak++;
		this.renderStatus();
		for (const w of puzzle.words) {
			for (const s of w) this.paintSlot(s, 'var(--color-green)');
		}
		const session = this.session;
		window.setTimeout(() => {
			if (this.closed || session !== this.session) return;
			this.nextWord();
		}, 1200);
	}

	// ------------------------------------------------------------------
	// סיום
	// ------------------------------------------------------------------
	private commit(countGame: boolean): boolean {
		const d = this.plugin.blastData;
		const prev = d.hangmanBest[this.deckKey];
		const newRecord = this.streak > 0 && this.streak > (prev ?? 0);
		if (newRecord) d.hangmanBest[this.deckKey] = this.streak;
		if (countGame) d.hangmanGames += 1;
		if (newRecord || countGame) void this.plugin.saveBlastData();
		return newRecord;
	}

	private onLost(puzzle: Puzzle): void {
		this.phase = 'over';
		// מציגים את האותיות שלא נמצאו
		for (const w of puzzle.words) {
			for (const s of w) {
				if (!s.revealed) {
					s.revealed = true;
					this.paintSlot(s, 'var(--color-red)');
				}
			}
		}
		const prev = this.plugin.blastData.hangmanBest[this.deckKey];
		const newRecord = this.commit(true);

		this.keyBtns.clear();
		const b = this.bottomEl;
		b.empty();
		const box = b.createDiv();
		box.setCssStyles({ textAlign: 'center' });
		box.createEl('h3', {
			text: newRecord ? '🏆 New best streak!' : '💀 Hanged!',
		});
		const big = box.createDiv({
			text: `${this.streak} solved in a row`,
		});
		big.setCssStyles({ fontSize: '1.4em', fontWeight: 'bold' });
		if (prev !== undefined) {
			box.createDiv({
				text: newRecord
					? `Previous best: ${prev}`
					: `Best streak: ${prev}`,
			});
		}
		const btns = box.createDiv();
		btns.setCssStyles({
			display: 'flex',
			gap: '8px',
			justifyContent: 'center',
			flexWrap: 'wrap',
			marginTop: '1em',
		});
		btns.createEl('button', {
			text: 'Play again',
			cls: 'mod-cta',
		}).onclick = () => this.startGame();
		btns.createEl('button', { text: 'Choose deck' }).onclick = () =>
			void this.showMenu();
		btns.createEl('button', { text: 'Close' }).onclick = () => this.close();
	}
}
