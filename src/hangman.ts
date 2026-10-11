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

const HE_LETTERS = Array.from('אבגדהוזחטיכלמנסעפצקרשת');
const EN_LETTERS = Array.from('abcdefghijklmnopqrstuvwxyz');
const HE_FINALS: Record<string, string> = {
	ך: 'כ',
	ם: 'מ',
	ן: 'נ',
	ף: 'פ',
	ץ: 'צ',
};
// ניקוד, טעמים וסימנים דיאקריטיים: מוצמדים לאות שלפניהם
const MARK_RE = /[̀-֑ͯ-ׇֽֿׁׂׅׄ]/;

// האות שצריך לנחש בשביל התו הזה, או null אם זה לא תו שמנחשים
const letterKey = (ch: string): string | null => {
	if (/[א-ת]/.test(ch)) return HE_FINALS[ch] ?? ch;
	const l = ch.toLowerCase();
	return /^[a-z]$/.test(l) ? l : null;
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
	hasHe: boolean;
	hasEn: boolean;
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
	for (const ch of Array.from(line.normalize('NFD'))) {
		if (ch === ' ') {
			if (cur.length > 0) words.push(cur);
			cur = [];
			continue;
		}
		if (MARK_RE.test(ch)) {
			const last = cur[cur.length - 1];
			if (last) last.display += ch;
			continue;
		}
		const key = letterKey(ch);
		if (key !== null) letters++;
		total++;
		cur.push({ display: ch, key, revealed: key === null, el: null });
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
	let hasHe = false;
	let hasEn = false;
	for (const k of keys) {
		if (/[a-z]/.test(k)) hasEn = true;
		else hasHe = true;
	}
	return { words, keys, clue, path: card.filePath, hasHe, hasEn };
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
	private queue: Flashcard[] = [];
	private puzzle: Puzzle | null = null;
	private guessed = new Set<string>();
	private wrong = 0;
	private hintsLeft = 0;
	private hintBtn: HTMLButtonElement | null = null;
	private streak = 0;

	constructor(app: App, plugin: SpacedRepetitionPlugin) {
		super(app);
		this.plugin = plugin;
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
			color: 'var(--text-normal)',
		});
		const svg = el('svg', {
			viewBox: '0 0 120 130',
			width: 130,
			height: 140,
		});
		wrap.appendChild(svg);
		const line = {
			stroke: 'currentColor',
			'stroke-width': 4,
			'stroke-linecap': 'round',
			fill: 'none',
		};
		// הגרדום
		el('path', { d: 'M8 124 H72 M24 124 V8 H80 V22', ...line }, svg);
		el('path', { d: 'M24 30 L44 8', ...line, 'stroke-width': 3 }, svg);
		// חלקי הגוף, לפי סדר הטעויות
		this.parts = [
			el('circle', { cx: 80, cy: 34, r: 12, ...line }, svg),
			el('path', { d: 'M80 46 V84', ...line }, svg),
			el('path', { d: 'M80 56 L62 70', ...line }, svg),
			el('path', { d: 'M80 56 L98 70', ...line }, svg),
			el('path', { d: 'M80 84 L64 108', ...line }, svg),
			el('path', { d: 'M80 84 L96 108', ...line }, svg),
		];
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
		this.wordEl.setAttr('dir', puzzle.hasHe ? 'rtl' : 'ltr');
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
		const addRow = (letters: string[], dir: 'rtl' | 'ltr'): void => {
			const row = this.bottomEl.createDiv();
			row.setAttr('dir', dir);
			row.setCssStyles({
				display: 'flex',
				flexWrap: 'wrap',
				justifyContent: 'center',
				gap: '6px',
				marginBottom: '10px',
			});
			for (const l of letters) {
				const btn = row.createEl('button', { text: l.toUpperCase() });
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
		if (puzzle.hasHe) addRow(HE_LETTERS, 'rtl');
		if (puzzle.hasEn) addRow(EN_LETTERS, 'ltr');

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
