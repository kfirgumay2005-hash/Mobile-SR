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
import { normKey, shuffle } from './blast';
import { GameMusic, renderMusicPanel } from './music';
import { effectivePick, renderRewardPicker, rewardTier } from './rewards';

// ============================================================================
// Match - משחק בסגנון Quizlet Match
//
// על הלוח מפוזרים אריחים: לכל כרטיס אריח שאלה ואריח תשובה. בוחרים שני
// אריחים שמתאימים זה לזה והם נעלמים. המטרה: לנקות את הלוח בזמן הקצר ביותר.
//   • הכרטיסים נבחרים באקראיות מהחפיסה שנבחרה (לא רק כאלה שהגיע זמנם).
//   • התאמה שגויה מוסיפה שנייה לזמן.
//   • המשחק לא מעדכן את FSRS.
// הזמן הטוב ביותר נשמר לכל חפיסה בקובץ blast-data.md (יחד עם נתוני Blast).
// ============================================================================

const PAIRS = 6;
const WRONG_PENALTY_SECS = 1;
// המפתח של "כל החפיסות" בטבלת השיאים
const ALL_DECKS_KEY = '*';

const fmtTime = (secs: number): string => {
	const t = Math.round(secs * 10) / 10;
	const m = Math.floor(t / 60);
	const s = (t - m * 60).toFixed(1);
	return m > 0 ? `${m}:${s.padStart(4, '0')}` : s;
};

const questionText = (card: Flashcard): string =>
	card.hint !== '' ? card.firstLine : card.front;

// עיצובי האריחים. עיצוב i נפתח בדרגה i (ראו rewards.ts).
// color ריק = צבעי ערכת הנושא של Obsidian
interface MatchTheme {
	name: string;
	bg: string;
	border: string;
	color: string;
}

const MATCH_THEMES: MatchTheme[] = [
	{
		name: 'Classic',
		bg: 'var(--background-secondary)',
		border: 'var(--background-modifier-border)',
		color: '',
	},
	{
		name: 'Ocean',
		bg: 'linear-gradient(135deg, #0d47a1, #00838f)',
		border: '#4fc3f7',
		color: '#ffffff',
	},
	{
		name: 'Sunset',
		bg: 'linear-gradient(135deg, #ad1457, #ef6c00)',
		border: '#ffcc80',
		color: '#ffffff',
	},
	{
		name: 'Forest',
		bg: 'linear-gradient(135deg, #1b5e20, #558b2f)',
		border: '#c5e1a5',
		color: '#ffffff',
	},
	{
		name: 'Galaxy',
		bg: 'linear-gradient(135deg, #1a0b3d, #6a1b9a 60%, #283593)',
		border: '#ce93d8',
		color: '#ffffff',
	},
];

type TileState = 'idle' | 'selected' | 'wrong' | 'matched';

interface Tile {
	el: HTMLElement;
	pairId: number;
	state: TileState;
}

export class MatchModal extends Modal {
	private plugin: SpacedRepetitionPlugin;
	private component: Component = new Component();

	private menuEl!: HTMLElement;
	private gameEl!: HTMLElement;
	private timerEl: HTMLElement | null = null;

	private closed = false;
	private session = 0; // מזהה משחק, כדי להתעלם מרינדור של משחק קודם
	private interval = 0;
	private running = false;
	private startT = 0;
	private penalty = 0;

	private deckKey = ALL_DECKS_KEY;
	private deckLabel = '';
	private deckCards: Flashcard[] = [];
	private tiles: Tile[] = [];
	private selected: Tile | null = null;
	private left = 0;
	private mistakes = 0;
	private theme = 0;
	private music: GameMusic;

	constructor(app: App, plugin: SpacedRepetitionPlugin) {
		super(app);
		this.plugin = plugin;
		this.music = new GameMusic(plugin, 'match');
	}

	onOpen(): void {
		this.modalEl.addClass('srs-match-modal');
		this.modalEl.setCssStyles({ width: 'min(1000px, 96vw)' });
		this.contentEl.empty();
		this.component.load();
		this.menuEl = this.contentEl.createDiv();
		this.gameEl = this.contentEl.createDiv();
		this.gameEl.setCssStyles({ display: 'none' });
		void this.showMenu();
	}

	onClose(): void {
		this.closed = true;
		this.music.stop();
		this.stopTimer();
		this.component.unload();
		this.contentEl.empty();
	}

	// ------------------------------------------------------------------
	// תפריט
	// ------------------------------------------------------------------
	private async showMenu(): Promise<void> {
		this.session++;
		this.stopTimer();
		this.gameEl.setCssStyles({ display: 'none' });
		this.menuEl.setCssStyles({ display: 'block' });
		this.menuEl.empty();
		this.menuEl.createEl('h2', { text: '🧩 Match' });
		this.menuEl.createEl('p', { text: 'Loading your cards…' });

		await this.plugin.loadBlastData();
		const all = await this.plugin.scanAllCards();
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
		m.createEl('h2', { text: '🧩 Match' });
		m.createEl('p', {
			text: `Match each question with its answer and clear the board as fast as you can. Each game picks ${PAIRS} random cards from the deck you choose, and a wrong match adds ${WRONG_PENALTY_SECS} second to your time. Match does not change your FSRS schedule.`,
		});
		const stats = m.createDiv();
		stats.setCssStyles({ fontWeight: 'bold', marginBottom: '0.75em' });
		stats.setText(`🎮 Games: ${bd.matchGames}`);

		// בחירת עיצוב לאריחים: כל עיצוב נפתח לפי ההתקדמות ב-review הרגיל
		renderRewardPicker(m, this.plugin, {
			title: 'Card design',
			names: MATCH_THEMES.map((t) => t.name),
			get: () => this.plugin.settings.matchTheme,
			set: (i) => {
				this.plugin.settings.matchTheme = i;
			},
			draw: (cell, i) => {
				const t = MATCH_THEMES[i];
				if (!t) return;
				const tile = cell.createDiv({ text: 'Aa' });
				tile.setCssStyles({
					width: '54px',
					height: '40px',
					lineHeight: '36px',
					borderRadius: '8px',
					border: `2px solid ${t.border}`,
					background: t.bg,
					color: t.color,
					fontWeight: 'bold',
				});
			},
		});
		renderMusicPanel(m, this.plugin, 'match', this.music);

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
				.createDiv({ text: `${cards.length} cards` })
				.setCssStyles({ fontSize: '0.85em' });
			const best = bd.matchBest[key];
			infoDiv
				.createDiv({
					text:
						best !== undefined
							? `🏆 Best time: ${fmtTime(best)}`
							: 'No best time yet',
				})
				.setCssStyles({ fontSize: '0.85em', opacity: '0.8' });
			const btn = deckCard.createEl('button', {
				text: 'Play',
				cls: 'mod-cta',
			});
			if (cards.length < 2) btn.disabled = true;
			btn.onclick = () => {
				this.deckKey = key;
				this.deckLabel = name;
				this.deckCards = cards;
				void this.startGame();
			};
		};
		if (decks.size > 1) add(ALL_DECKS_KEY, 'All decks', all);
		for (const [name, cards] of decks.entries()) add(name, name, cards);

		if (all.length === 0) {
			m.createEl('p', { text: 'No flashcards found.' });
		}
	}

	// ------------------------------------------------------------------
	// משחק
	// ------------------------------------------------------------------

	// כרטיסים אקראיים שאין ביניהם טקסט זהה (אחרת ההתאמה לא חד-משמעית)
	private pickCards(): Flashcard[] {
		const seen = new Set<string>();
		const picked: Flashcard[] = [];
		for (const c of shuffle(this.deckCards.slice())) {
			const q = normKey(questionText(c));
			const a = normKey(c.back);
			if (q === '' || a === '' || q === a) continue;
			if (seen.has(q) || seen.has(a)) continue;
			seen.add(q);
			seen.add(a);
			picked.push(c);
			if (picked.length >= PAIRS) break;
		}
		return picked;
	}

	private async startGame(): Promise<void> {
		const cards = this.pickCards();
		if (cards.length < 2) {
			new Notice('Match needs at least 2 different cards in the deck.');
			return;
		}
		const session = ++this.session;
		this.stopTimer();
		this.tiles = [];
		this.selected = null;
		this.left = cards.length;
		this.mistakes = 0;
		this.penalty = 0;
		this.theme = effectivePick(
			this.plugin.settings.matchTheme,
			rewardTier(this.plugin),
			MATCH_THEMES.length,
		);
		const theme = MATCH_THEMES[this.theme];
		this.music.start();

		this.menuEl.setCssStyles({ display: 'none' });
		const g = this.gameEl;
		g.setCssStyles({ display: 'block' });
		g.empty();

		const header = g.createDiv();
		header.setCssStyles({
			display: 'flex',
			justifyContent: 'space-between',
			alignItems: 'center',
			marginBottom: '8px',
			gap: '8px',
		});
		const title = header.createDiv({ text: this.deckLabel });
		title.setAttr('dir', 'auto');
		title.setCssStyles({ opacity: '0.8', fontSize: '0.9em', flex: '1' });
		this.timerEl = header.createDiv({ text: '0.0' });
		this.timerEl.setCssStyles({
			fontWeight: 'bold',
			fontSize: '1.3em',
			fontVariantNumeric: 'tabular-nums',
		});
		const best = this.plugin.blastData.matchBest[this.deckKey];
		const bestEl = header.createDiv({
			text: best !== undefined ? `🏆 ${fmtTime(best)}` : '',
		});
		bestEl.setCssStyles({
			opacity: '0.8',
			fontSize: '0.9em',
			flex: '1',
			textAlign: 'end',
		});

		const phone = Platform.isPhone;
		const grid = g.createDiv();
		grid.setCssStyles({
			display: 'grid',
			gridTemplateColumns: `repeat(${phone ? 3 : 4}, 1fr)`,
			gridAutoRows: phone ? '110px' : '150px',
			gap: phone ? '6px' : '10px',
		});

		const items: { pairId: number; text: string; path: string }[] = [];
		cards.forEach((c, i) => {
			items.push({ pairId: i, text: questionText(c), path: c.filePath });
			items.push({ pairId: i, text: c.back, path: c.filePath });
		});
		shuffle(items);

		const renders: Promise<void>[] = [];
		for (const it of items) {
			const tileEl = grid.createDiv();
			tileEl.setCssStyles({
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				padding: phone ? '4px' : '10px',
				borderRadius: '10px',
				border: `2px solid ${theme?.border ?? ''}`,
				background: theme?.bg ?? '',
				color: theme?.color ?? '',
				cursor: 'pointer',
				overflow: 'hidden',
				userSelect: 'none',
				textAlign: 'center',
				fontSize: phone ? '0.8em' : '1em',
				transition:
					'background-color 0.12s, border-color 0.12s, opacity 0.25s, transform 0.25s',
			});
			const inner = tileEl.createDiv();
			inner.setAttr('dir', 'auto');
			inner.setCssStyles({
				pointerEvents: 'none',
				maxHeight: '100%',
				overflow: 'hidden',
				overflowWrap: 'anywhere',
			});
			renders.push(
				MarkdownRenderer.render(
					this.app,
					it.text,
					inner,
					it.path,
					this.component,
				),
			);
			const tile: Tile = { el: tileEl, pairId: it.pairId, state: 'idle' };
			this.tiles.push(tile);
			tileEl.onclick = () => this.onTile(tile);
		}

		// השעון מתחיל רק אחרי שכל האריחים מוצגים
		await Promise.all(renders);
		if (this.closed || session !== this.session) return;
		this.startT = performance.now();
		this.running = true;
		this.interval = window.setInterval(() => this.renderTimer(), 100);
	}

	private elapsed(): number {
		return (performance.now() - this.startT) / 1000 + this.penalty;
	}

	private renderTimer(): void {
		if (this.running && this.timerEl) {
			this.timerEl.setText(fmtTime(this.elapsed()));
		}
	}

	private stopTimer(): void {
		this.running = false;
		if (this.interval) window.clearInterval(this.interval);
		this.interval = 0;
	}

	private paint(tile: Tile): void {
		const s = tile.state;
		const color =
			s === 'selected'
				? 'var(--interactive-accent)'
				: s === 'wrong'
					? 'var(--color-red)'
					: s === 'matched'
						? 'var(--color-green)'
						: '';
		const theme = MATCH_THEMES[this.theme];
		// באריח מעוצב הרקע נשאר, והמצב מסומן במסגרת זוהרת
		const themed = this.theme > 0;
		tile.el.setCssStyles({
			borderColor: color || (theme?.border ?? ''),
			background:
				s === 'idle' || themed
					? (theme?.bg ?? '')
					: 'var(--background-modifier-hover)',
			boxShadow: themed && color ? `0 0 0 3px ${color}` : 'none',
			filter: themed && s === 'selected' ? 'brightness(1.25)' : 'none',
			opacity: s === 'matched' ? '0' : '1',
			transform: s === 'matched' ? 'scale(0.85)' : 'none',
			pointerEvents: s === 'matched' ? 'none' : 'auto',
		});
	}

	private setState(tile: Tile, state: TileState): void {
		tile.state = state;
		this.paint(tile);
	}

	private onTile(tile: Tile): void {
		if (!this.running || tile.state === 'matched') return;
		const first = this.selected;
		if (first === tile) {
			this.selected = null;
			this.setState(tile, 'idle');
			return;
		}
		if (!first) {
			this.selected = tile;
			this.setState(tile, 'selected');
			return;
		}
		this.selected = null;

		if (first.pairId === tile.pairId) {
			this.setState(first, 'matched');
			this.setState(tile, 'matched');
			this.left--;
			if (this.left === 0) this.finish();
			return;
		}

		// התאמה שגויה: שנייה נוספת לזמן
		this.mistakes++;
		this.penalty += WRONG_PENALTY_SECS;
		this.renderTimer();
		const timerEl = this.timerEl;
		timerEl?.setCssStyles({ color: 'var(--color-red)' });
		for (const t of [first, tile]) {
			this.setState(t, 'wrong');
			t.el.animate(
				[
					{ transform: 'translateX(0)' },
					{ transform: 'translateX(-6px)' },
					{ transform: 'translateX(6px)' },
					{ transform: 'translateX(-4px)' },
					{ transform: 'translateX(0)' },
				],
				{ duration: 300 },
			);
		}
		window.setTimeout(() => {
			timerEl?.setCssStyles({ color: '' });
			for (const t of [first, tile]) {
				if (t.state === 'wrong') this.setState(t, 'idle');
			}
		}, 450);
	}

	// ------------------------------------------------------------------
	// סיום
	// ------------------------------------------------------------------
	private finish(): void {
		const time = Math.round(this.elapsed() * 10) / 10;
		this.stopTimer();

		const d = this.plugin.blastData;
		const prev = d.matchBest[this.deckKey];
		const newRecord = prev === undefined || time < prev;
		if (newRecord) d.matchBest[this.deckKey] = time;
		d.matchGames += 1;
		void this.plugin.saveBlastData();

		const session = this.session;
		window.setTimeout(() => {
			if (this.closed || session !== this.session) return;
			this.renderEnd(time, prev, newRecord);
		}, 350);
	}

	private renderEnd(
		time: number,
		prev: number | undefined,
		newRecord: boolean,
	): void {
		const g = this.gameEl;
		g.empty();
		const box = g.createDiv();
		box.setCssStyles({ textAlign: 'center', padding: '1.5em 0.5em' });

		box.createEl('h2', {
			text: newRecord ? '🏆 New best time!' : '🧩 Board cleared!',
		});
		box.createDiv({ text: this.deckLabel }).setAttr('dir', 'auto');
		const big = box.createDiv({ text: `${fmtTime(time)} seconds` });
		big.setCssStyles({
			fontSize: '2.2em',
			fontWeight: 'bold',
			margin: '0.4em 0',
			fontVariantNumeric: 'tabular-nums',
		});
		if (prev !== undefined) {
			box.createDiv({
				text: newRecord
					? `Previous best: ${fmtTime(prev)}`
					: `Best time: ${fmtTime(prev)}`,
			});
		}
		const info = box.createDiv({
			text:
				this.mistakes > 0
					? `${this.mistakes} wrong match(es): +${this.mistakes * WRONG_PENALTY_SECS} seconds`
					: 'No wrong matches',
		});
		info.setCssStyles({ opacity: '0.8', fontSize: '0.9em' });

		const btns = box.createDiv();
		btns.setCssStyles({
			display: 'flex',
			gap: '8px',
			justifyContent: 'center',
			flexWrap: 'wrap',
			marginTop: '1.2em',
		});
		btns.createEl('button', {
			text: 'Play again',
			cls: 'mod-cta',
		}).onclick = () => void this.startGame();
		btns.createEl('button', { text: 'Choose deck' }).onclick = () =>
			void this.showMenu();
		btns.createEl('button', { text: 'Close' }).onclick = () => this.close();
	}
}
