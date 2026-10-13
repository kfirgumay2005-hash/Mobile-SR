import { App, Component, MarkdownRenderer, Modal, Notice } from 'obsidian';
import type SpacedRepetitionPlugin from './main';
import type { Flashcard } from './main';
import { GameMusic, renderMusicPanel } from './music';
import { renderLeaderboardButton, submitScore } from './online';
import { effectivePick, renderRewardPicker, rewardTier } from './rewards';

// ============================================================================
// Blast - משחק בסגנון Quizlet Blast
//
// למעלה מוצגת שאלה מכרטיס (כרטיס שהגיע זמנו לפי FSRS). אסטרואידים צפים
// באקראיות בחלל שמעל החללית כשעל כל אחד תשובה, ואתה יורה (לחיצה/נגיעה)
// באסטרואיד עם התשובה הנכונה.
//   • לכל שלב יש דקה ויעד נקודות (50 בשלב 1, 100 בשלב 2 וכו').
//   • פגיעה נכונה ראשונה = 5 נקודות, וכל פגיעה נוספת ברצף מגדילה את המכפיל.
//   • פגיעה שגויה = מינוס 2 נקודות והרצף מתאפס.
//   • נגמר הזמן לפני שהגעת ליעד = סוף המשחק.
//   • המשחק לא משפיע על FSRS: הוא רק קורא אילו כרטיסים הגיע זמנם, ולעולם
//     לא כותב ל-store / srs-data.md.
// השיא נשמר בקובץ blast-data.md (ליד srs-data.md, או בנתיב משלו).
// ============================================================================

const SVG_NS = 'http://www.w3.org/2000/svg';
const W = 360;
const H = 520;
const SHIP_X = W / 2;
const SHIP_Y = 478;
const AST_R = 40;
// הזירה שבה האסטרואידים צפים: מתחת ל-HUD ומעל החללית
const ARENA_TOP = 82;
const ARENA_BOTTOM = SHIP_Y - 52;
const LEVEL_TIME = 60; // שניות לכל שלב
const TARGET_PER_LEVEL = 50; // יעד השלב = 50 * מספר השלב
const BASE_POINTS = 5;
const STREAK_STEP = 0.2; // כל פגיעה ברצף מוסיפה 0.2 למכפיל
const WRONG_PENALTY = 2;

const levelTarget = (level: number): number => TARGET_PER_LEVEL * level;
const streakMult = (streak: number): number =>
	1 + STREAK_STEP * Math.max(0, streak - 1);
const fmtMult = (m: number): string => `x${m.toFixed(1)}`;

// ---------------------------------------------------------------------------
// עזרי SVG
// ---------------------------------------------------------------------------

export function el<K extends keyof SVGElementTagNameMap>(
	tag: K,
	attrs: Record<string, string | number>,
	parent?: Element,
): SVGElementTagNameMap[K] {
	const e = document.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) {
		e.setAttribute(k, String(v));
	}
	if (parent) parent.appendChild(e);
	return e;
}

// אנימציה שמתחילה בזמן ההוספה (אלמנטים שנוספים דינמית לא מתחילים לבד)
function anim(
	target: Element,
	tag: 'animate' | 'animateTransform',
	attrs: Record<string, string | number>,
	delay = 0,
): void {
	const a = el(tag, { ...attrs, begin: 'indefinite' }, target);
	if (typeof a.beginElementAt === 'function') a.beginElementAt(delay);
}

function txt(
	parent: Element,
	x: number,
	y: number,
	text: string,
	size: number,
	fill: string,
	anchor: 'start' | 'middle' | 'end' = 'middle',
): SVGTextElement {
	const t = el(
		'text',
		{
			x,
			y,
			'font-size': size,
			'font-weight': 700,
			'font-family': 'var(--font-interface, sans-serif)',
			fill,
			'text-anchor': anchor,
		},
		parent,
	);
	t.textContent = text;
	return t;
}

function clearChildren(node: Element): void {
	while (node.firstChild) node.removeChild(node.firstChild);
}

function spikePoints(
	cx: number,
	cy: number,
	n: number,
	outer: number,
	inner: number,
): string {
	const pts: string[] = [];
	for (let i = 0; i < n * 2; i++) {
		const rad = i % 2 === 0 ? outer : inner;
		const a = (Math.PI * i) / n - Math.PI / 2;
		pts.push(
			`${(cx + Math.cos(a) * rad).toFixed(1)},${(cy + Math.sin(a) * rad).toFixed(1)}`,
		);
	}
	return pts.join(' ');
}

const mulberry32 = (seed: number): (() => number) => {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

export function shuffle<T>(arr: T[]): T[] {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		const a = arr[i];
		const b = arr[j];
		if (a !== undefined && b !== undefined) {
			arr[i] = b;
			arr[j] = a;
		}
	}
	return arr;
}

// ---------------------------------------------------------------------------
// טקסט של תשובות על האסטרואידים
// ---------------------------------------------------------------------------

export const stripMd = (s: string): string =>
	s
		.replace(/!\[\[[^\]]*\]\]/g, '')
		.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
		.replace(/(\*\*|__|==|~~|`)/g, '')
		.replace(/^[#>\-*\s]+/, '')
		.replace(/\s+/g, ' ')
		.trim();

// התשובה שמוצגת על אסטרואיד: השורה הראשונה של צד התשובה, קצרה וללא Markdown
const answerText = (card: Flashcard): string => {
	const lines = card.back.split('\n');
	let first = '';
	for (const l of lines) {
		const t = stripMd(l);
		if (t !== '') {
			first = t;
			break;
		}
	}
	if (first === '') return '...';
	return first.length > 36 ? first.substring(0, 35) + '…' : first;
};

export const normKey = (s: string): string =>
	s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

function wrapText(s: string, maxChars: number, maxLines: number): string[] {
	const words = s.split(' ');
	const lines: string[] = [];
	let cur = '';
	for (const w0 of words) {
		let w = w0;
		while (w.length > maxChars) {
			if (cur) {
				lines.push(cur);
				cur = '';
			}
			lines.push(w.substring(0, maxChars));
			w = w.substring(maxChars);
		}
		if (cur === '') cur = w;
		else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
		else {
			lines.push(cur);
			cur = w;
		}
	}
	if (cur) lines.push(cur);
	if (lines.length > maxLines) {
		const cut = lines.slice(0, maxLines);
		const last = cut[maxLines - 1] ?? '';
		cut[maxLines - 1] =
			last.length >= maxChars
				? last.substring(0, maxChars - 1) + '…'
				: last + '…';
		return cut;
	}
	return lines;
}

// ---------------------------------------------------------------------------
// איורים: אסטרואיד, חללית, גביע
// ---------------------------------------------------------------------------

interface Asteroid {
	x: number;
	y: number;
	vx: number;
	vy: number;
	r: number;
	rot: number;
	vr: number;
	text: string;
	correct: boolean;
	g: SVGGElement;
	rock: SVGGElement;
}

function buildAsteroid(
	parent: Element,
	r: number,
	seed: number,
	text: string,
): { g: SVGGElement; rock: SVGGElement } {
	const rnd = mulberry32(seed * 7919 + 13);
	const g = el('g', {}, parent);
	const rock = el('g', {}, g);

	const n = 11;
	const pts: string[] = [];
	for (let i = 0; i < n; i++) {
		const a = (i / n) * Math.PI * 2;
		const rad = r * (0.82 + rnd() * 0.18);
		pts.push(
			`${(Math.cos(a) * rad).toFixed(1)},${(Math.sin(a) * rad).toFixed(1)}`,
		);
	}
	const kind = ['A', 'B', 'C'][Math.floor(rnd() * 3)] ?? 'A';
	el(
		'polygon',
		{
			points: pts.join(' '),
			fill: `url(#bl-rock${kind})`,
			stroke: '#1d1612',
			'stroke-width': 2,
			'stroke-linejoin': 'round',
		},
		rock,
	);
	for (let i = 0; i < 4; i++) {
		const a = rnd() * Math.PI * 2;
		const d = rnd() * r * 0.55;
		const cr = r * (0.08 + rnd() * 0.1);
		el(
			'circle',
			{
				cx: Math.cos(a) * d,
				cy: Math.sin(a) * d,
				r: cr,
				fill: '#000',
				opacity: 0.22,
			},
			rock,
		);
		el(
			'circle',
			{
				cx: Math.cos(a) * d - cr * 0.2,
				cy: Math.sin(a) * d - cr * 0.2,
				r: cr * 0.7,
				fill: '#fff',
				opacity: 0.08,
			},
			rock,
		);
	}
	el(
		'path',
		{
			d: `M${-r * 0.6} ${-r * 0.35} A${r * 0.75} ${r * 0.75} 0 0 1 ${r * 0.1} ${-r * 0.75}`,
			fill: 'none',
			stroke: '#fff',
			'stroke-width': 3,
			'stroke-linecap': 'round',
			opacity: 0.22,
		},
		rock,
	);

	// הטקסט לא מסתובב עם האסטרואיד
	el('circle', { r: r * 0.82, fill: '#000', opacity: 0.3 }, g);
	const lines = wrapText(text, 11, 3);
	const size = lines.length >= 3 ? 10 : 11.5;
	const lh = size * 1.18;
	const startY = -((lines.length - 1) * lh) / 2 + size * 0.34;
	lines.forEach((ln, i) => {
		const t = txt(g, 0, startY + i * lh, ln, size, '#ffffff');
		t.setCssStyles({
			paintOrder: 'stroke',
			stroke: '#000',
			strokeWidth: '2.6px',
			strokeLinejoin: 'round',
			unicodeBidi: 'plaintext',
		});
	});
	return { g, rock };
}

// גרדיאנט מקומי: מוגדר בתוך האלמנט עצמו, כך שאותו ציור עובד גם בזירה וגם
// בתצוגה המקדימה שבתפריט
let gradSeq = 0;
function localGrad(
	parent: Element,
	colors: string[],
	horizontal = false,
): string {
	const id = `bl-lg${gradSeq++}`;
	const defs = el('defs', {}, parent);
	const g = el(
		'linearGradient',
		{ id, x1: 0, y1: 0, x2: horizontal ? 1 : 0, y2: horizontal ? 0 : 1 },
		defs,
	);
	colors.forEach((c, i) =>
		el(
			'stop',
			{
				offset: colors.length > 1 ? i / (colors.length - 1) : 0,
				'stop-color': c,
			},
			g,
		),
	);
	return `url(#${id})`;
}

// עיצובי החללית. עיצוב i נפתח בדרגה i (ראו rewards.ts)
interface ShipSkin {
	name: string;
	laser: string;
	hull: string; // path
	wing: string; // נקודות הכנף הימנית; השמאלית היא תמונת ראי
	hullColors: string[];
	wingColors: string[];
	glassColors: string[];
	flameColors: string[];
	trim: string;
	outline: string;
	flames: number[]; // מיקומי המנועים על ציר X
	extra?: (parent: Element, skin: ShipSkin) => void;
}

export const SHIP_SKINS: ShipSkin[] = [
	{
		name: 'Scout',
		laser: '#ff5252',
		hull: 'M0 -42 C11 -28 15 -8 13 24 L-13 24 C-15 -8 -11 -28 0 -42 Z',
		wing: '11,-2 36,26 36,36 10,24',
		hullColors: ['#eceff1', '#90a4ae'],
		wingColors: ['#5c6bc0', '#1a237e'],
		glassColors: ['#b3e5fc', '#0288d1'],
		flameColors: ['#fff176', '#ff9100', '#d50000'],
		trim: '#ff5252',
		outline: '#0d1b3a',
		flames: [0],
		extra: (p, s) => {
			for (const x of [-38, 33]) {
				el(
					'rect',
					{ x, y: 30, width: 5, height: 9, rx: 2, fill: s.trim },
					p,
				);
			}
		},
	},
	{
		name: 'Viper',
		laser: '#ffd600',
		hull: 'M0 -44 L8 -14 L11 24 L-11 24 L-8 -14 Z',
		wing: '9,6 34,-10 38,-6 30,22 10,26',
		hullColors: ['#ff8a80', '#b71c1c'],
		wingColors: ['#616161', '#111111'],
		glassColors: ['#fff59d', '#f57f17'],
		flameColors: ['#ffffff', '#ffd600', '#ff3d00'],
		trim: '#ffd600',
		outline: '#1a0505',
		flames: [-6, 6],
		extra: (p, s) => {
			for (const x of [-36, 36]) {
				el(
					'path',
					{
						d: `M${x} -8 V-22`,
						stroke: s.trim,
						'stroke-width': 2.5,
						'stroke-linecap': 'round',
					},
					p,
				);
			}
		},
	},
	{
		name: 'Falcon',
		laser: '#69f0ae',
		hull: 'M0 -40 C8 -30 10 -10 10 24 L-10 24 C-10 -10 -8 -30 0 -40 Z',
		wing: '8,-18 40,30 22,30 9,24',
		hullColors: ['#f1f8e9', '#66bb6a'],
		wingColors: ['#43a047', '#1b5e20'],
		glassColors: ['#e0f7fa', '#00acc1'],
		flameColors: ['#e8f5e9', '#69f0ae', '#00c853'],
		trim: '#ffd54f',
		outline: '#0b2e13',
		flames: [0],
		extra: (p, s) => {
			for (const k of [-1, 1]) {
				el(
					'path',
					{
						d: `M${k * 12} 2 L${k * 30} 26`,
						stroke: s.trim,
						'stroke-width': 2,
						'stroke-linecap': 'round',
					},
					p,
				);
			}
		},
	},
	{
		name: 'Phantom',
		laser: '#18ffff',
		hull: 'M0 -44 L14 4 L8 26 L-8 26 L-14 4 Z',
		wing: '12,-4 40,18 40,26 26,22 12,30',
		hullColors: ['#b39ddb', '#4527a0'],
		wingColors: ['#4527a0', '#12005e'],
		glassColors: ['#84ffff', '#00b8d4'],
		flameColors: ['#ffffff', '#18ffff', '#2962ff'],
		trim: '#18ffff',
		outline: '#0a0026',
		flames: [-5, 5],
		extra: (p, s) => {
			el(
				'path',
				{
					d: 'M-14 4 L0 -44 L14 4',
					fill: 'none',
					stroke: s.trim,
					'stroke-width': 1.2,
					opacity: 0.8,
				},
				p,
			);
		},
	},
	{
		name: 'Nova',
		laser: '#ffffff',
		hull: 'M0 -46 C14 -30 16 0 12 24 L-12 24 C-16 0 -14 -30 0 -46 Z',
		wing: '12,-8 30,2 42,30 34,38 12,26',
		hullColors: ['#fffde7', '#ffca28'],
		wingColors: ['#ffa000', '#e65100'],
		glassColors: ['#e1f5fe', '#29b6f6'],
		flameColors: ['#ffffff', '#ffe57f', '#ff6d00'],
		trim: '#ffffff',
		outline: '#4e2600',
		flames: [-10, 0, 10],
		extra: (p, s) => {
			const ring = el(
				'ellipse',
				{
					cx: 0,
					cy: 4,
					rx: 30,
					ry: 7,
					fill: 'none',
					stroke: s.trim,
					'stroke-width': 2,
					opacity: 0.7,
				},
				p,
			);
			anim(ring, 'animate', {
				attributeName: 'opacity',
				values: '0.8;0.25;0.8',
				dur: '1.2s',
				repeatCount: 'indefinite',
			});
		},
	},
];

export function buildShip(parent: Element, skinIndex: number): void {
	const s = SHIP_SKINS[skinIndex] ?? SHIP_SKINS[0];
	if (!s) return;
	const flameFill = localGrad(parent, s.flameColors);
	for (const x of s.flames) {
		const w = s.flames.length > 1 ? 5 : 8;
		const flame = el(
			'polygon',
			{ points: `${x - w},20 ${x},46 ${x + w},20`, fill: flameFill },
			parent,
		);
		anim(flame, 'animate', {
			attributeName: 'opacity',
			values: '1;0.5;1',
			dur: '0.16s',
			repeatCount: 'indefinite',
		});
		const flame2 = el(
			'polygon',
			{
				points: `${x - w / 2},20 ${x},34 ${x + w / 2},20`,
				fill: '#fff8c4',
			},
			parent,
		);
		anim(flame2, 'animate', {
			attributeName: 'opacity',
			values: '0.9;0.4;0.9',
			dur: '0.12s',
			repeatCount: 'indefinite',
		});
	}
	// כנפיים
	const wingFill = localGrad(parent, s.wingColors);
	for (const k of [1, -1]) {
		el(
			'polygon',
			{
				points: s.wing,
				fill: wingFill,
				stroke: s.outline,
				'stroke-width': 1.5,
				'stroke-linejoin': 'round',
				transform: `scale(${k} 1)`,
			},
			parent,
		);
	}
	// גוף
	el(
		'path',
		{
			d: s.hull,
			fill: localGrad(parent, s.hullColors, true),
			stroke: s.outline,
			'stroke-width': 1.8,
			'stroke-linejoin': 'round',
		},
		parent,
	);
	el('path', { d: 'M-9 14 H9', stroke: s.trim, 'stroke-width': 3 }, parent);
	el(
		'ellipse',
		{
			cx: 0,
			cy: -12,
			rx: 5.5,
			ry: 10,
			fill: localGrad(parent, s.glassColors),
			stroke: s.outline,
			'stroke-width': 1.2,
		},
		parent,
	);
	el(
		'ellipse',
		{ cx: -2, cy: -16, rx: 1.6, ry: 3.6, fill: '#fff', opacity: 0.7 },
		parent,
	);
	s.extra?.(parent, s);
}

function drawTrophy(
	parent: Element,
	cx: number,
	cy: number,
	scale: number,
): void {
	const g = el(
		'g',
		{ transform: `translate(${cx} ${cy}) scale(${scale})` },
		parent,
	);
	const gold = 'url(#bl-gold)';
	el(
		'path',
		{
			d: 'M-9 -7 H-14 C-14 1 -11 3 -8 3',
			fill: 'none',
			stroke: '#f9a825',
			'stroke-width': 2,
		},
		g,
	);
	el(
		'path',
		{
			d: 'M9 -7 H14 C14 1 11 3 8 3',
			fill: 'none',
			stroke: '#f9a825',
			'stroke-width': 2,
		},
		g,
	);
	el(
		'path',
		{
			d: 'M-9 -11 H9 V-2 C9 5 4 8 0 8 C-4 8 -9 5 -9 -2 Z',
			fill: gold,
			stroke: '#c77800',
			'stroke-width': 1,
		},
		g,
	);
	el('rect', { x: -2, y: 8, width: 4, height: 5, fill: '#f9a825' }, g);
	el(
		'rect',
		{ x: -7, y: 13, width: 14, height: 3.5, rx: 1.5, fill: gold },
		g,
	);
}

// ---------------------------------------------------------------------------
// המשחק
// ---------------------------------------------------------------------------

type Phase = 'menu' | 'playing' | 'between' | 'ended';

export class BlastModal extends Modal {
	private plugin: SpacedRepetitionPlugin;
	private component: Component = new Component();

	// ממשק
	private menuEl!: HTMLElement;
	private gameEl!: HTMLElement;
	private questionEl!: HTMLElement;
	private questionBody!: HTMLElement;
	private hintBtn!: HTMLButtonElement;
	private hintText!: HTMLElement;
	private svg!: SVGSVGElement;
	private starLayer!: SVGGElement;
	private astLayer!: SVGGElement;
	private fxLayer!: SVGGElement;
	private shipRot!: SVGGElement;
	private shipG!: SVGGElement;
	private skin = 0;
	private music: GameMusic;
	private hudLayer!: SVGGElement;
	private overlayLayer!: SVGGElement;

	private stars: { e: SVGCircleElement; y: number; v: number }[] = [];

	// מצב
	private phase: Phase = 'menu';
	private closed = false;
	private raf = 0;
	private lastT = 0;
	private timers: number[] = [];
	private audio: AudioContext | null = null;

	private pool: Flashcard[] = [];
	private queue: Flashcard[] = [];
	private totalCards = 0;
	private current: Flashcard | null = null;
	private asteroids: Asteroid[] = [];
	private score = 0; // סך כל הנקודות במשחק (לשיא)
	private levelPoints = 0; // נקודות בשלב הנוכחי, מול היעד
	private timeLeft = LEVEL_TIME;
	private timerOn = false;
	private shownSec = -1;
	private streak = 0;
	private bestStreakRun = 0;
	private correctCount = 0;
	private answeredCount = 0;
	private mistakes = 0;
	private level = 1;
	private startBest = 0;
	private newRecord = false;
	private astSeed = 1;

	constructor(app: App, plugin: SpacedRepetitionPlugin) {
		super(app);
		this.plugin = plugin;
		this.music = new GameMusic(plugin, 'blast');
	}

	onOpen(): void {
		this.modalEl.addClass('srs-blast-modal');
		this.contentEl.empty();
		this.contentEl.setCssStyles({
			padding: '0.5em',
			position: 'relative',
		});
		this.component.load();

		this.menuEl = this.contentEl.createDiv();
		this.gameEl = this.contentEl.createDiv();
		this.gameEl.setCssStyles({ display: 'none' });
		this.buildGameUi();

		this.raf = window.requestAnimationFrame(this.tick);
		void this.showMenu();
	}

	onClose(): void {
		this.closed = true;
		this.music.stop();
		window.cancelAnimationFrame(this.raf);
		this.clearTimers();
		this.component.unload();
		if (this.phase === 'playing' || this.phase === 'between') {
			this.commitRecord(false);
		}
		this.contentEl.empty();
	}

	// ------------------------------------------------------------------
	// בניית ממשק המשחק (שאלה ב-HTML, זירה ב-SVG)
	// ------------------------------------------------------------------
	private buildGameUi(): void {
		const q = this.gameEl.createDiv();
		q.setCssStyles({
			maxWidth: '420px',
			margin: '0 auto 6px auto',
			padding: '10px 12px',
			background: 'var(--background-secondary)',
			border: '1px solid var(--background-modifier-border)',
			borderRadius: '10px',
			textAlign: 'center',
			minHeight: '58px',
		});
		this.questionEl = q;
		this.questionBody = q.createDiv();
		this.questionBody.setAttr('dir', 'auto');
		this.hintText = q.createDiv();
		this.hintText.setAttr('dir', 'auto');
		this.hintText.setCssStyles({
			display: 'none',
			marginTop: '6px',
			opacity: '0.75',
			fontSize: '0.9em',
			borderTop: '1px dashed var(--background-modifier-border)',
			paddingTop: '6px',
		});
		this.hintBtn = q.createEl('button', { text: '💡 Hint' });
		this.hintBtn.setCssStyles({
			display: 'none',
			marginTop: '6px',
			fontSize: '0.8em',
		});

		const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%' });
		svg.setCssStyles({
			maxWidth: '420px',
			display: 'block',
			margin: '0 auto',
			touchAction: 'none',
			userSelect: 'none',
			borderRadius: '12px',
		});
		this.gameEl.appendChild(svg);
		this.svg = svg;

		// --- הגדרות: גרדיאנטים ---
		const defs = el('defs', {}, svg);
		const lin = (id: string, stops: [number, string][]): void => {
			const g = el(
				'linearGradient',
				{ id, x1: 0, y1: 0, x2: 0, y2: 1 },
				defs,
			);
			stops.forEach(([o, c]) =>
				el('stop', { offset: o, 'stop-color': c }, g),
			);
		};
		const rad = (
			id: string,
			stops: [number, string][],
			cx = '35%',
			cy = '30%',
		): void => {
			const g = el('radialGradient', { id, cx, cy, r: '75%' }, defs);
			stops.forEach(([o, c]) =>
				el('stop', { offset: o, 'stop-color': c }, g),
			);
		};
		lin('bl-bg', [
			[0, '#050818'],
			[0.55, '#120a33'],
			[1, '#2a1250'],
		]);
		rad('bl-planet', [
			[0, '#ffb74d'],
			[0.6, '#e65100'],
			[1, '#4e1a00'],
		]);
		rad(
			'bl-nebula',
			[
				[0, 'rgba(171,71,188,0.45)'],
				[1, 'rgba(171,71,188,0)'],
			],
			'50%',
			'50%',
		);
		rad(
			'bl-nebula2',
			[
				[0, 'rgba(41,182,246,0.35)'],
				[1, 'rgba(41,182,246,0)'],
			],
			'50%',
			'50%',
		);
		rad('bl-rockA', [
			[0, '#c9b49e'],
			[1, '#5d4a3e'],
		]);
		rad('bl-rockB', [
			[0, '#a9b4bf'],
			[1, '#3f4954'],
		]);
		rad('bl-rockC', [
			[0, '#d19a78'],
			[1, '#5a362a'],
		]);
		lin('bl-gold', [
			[0, '#fff59d'],
			[1, '#f9a825'],
		]);
		lin('bl-btn', [
			[0, '#81c784'],
			[1, '#2e7d32'],
		]);
		lin('bl-btn2', [
			[0, '#7986cb'],
			[1, '#303f9f'],
		]);

		// --- רקע חלל ---
		el(
			'rect',
			{ x: 0, y: 0, width: W, height: H, fill: 'url(#bl-bg)' },
			svg,
		);
		el('circle', { cx: 70, cy: 150, r: 120, fill: 'url(#bl-nebula)' }, svg);
		el(
			'circle',
			{ cx: 300, cy: 330, r: 140, fill: 'url(#bl-nebula2)' },
			svg,
		);
		// כוכב לכת עם טבעת
		const planet = el('g', { transform: 'translate(290 96)' }, svg);
		el('circle', { r: 30, fill: 'url(#bl-planet)' }, planet);
		el(
			'ellipse',
			{
				rx: 50,
				ry: 11,
				fill: 'none',
				stroke: '#ffe0b2',
				'stroke-width': 3,
				opacity: 0.6,
				transform: 'rotate(-18)',
			},
			planet,
		);
		el(
			'circle',
			{ cx: -9, cy: -9, r: 8, fill: '#fff', opacity: 0.1 },
			planet,
		);

		this.starLayer = el('g', {}, svg);
		const rnd = mulberry32(42);
		for (let i = 0; i < 55; i++) {
			const sz = 0.6 + rnd() * 1.6;
			const e = el(
				'circle',
				{
					cx: rnd() * W,
					cy: rnd() * H,
					r: sz,
					fill: '#fff',
					opacity: 0.3 + rnd() * 0.6,
				},
				this.starLayer,
			);
			this.stars.push({ e, y: rnd() * H, v: 6 + sz * 10 });
		}

		this.astLayer = el('g', {}, svg);
		this.fxLayer = el('g', { 'pointer-events': 'none' }, svg);

		// חללית
		this.shipRot = el('g', {}, svg);
		this.shipG = el(
			'g',
			{ transform: `translate(${SHIP_X} ${SHIP_Y})` },
			this.shipRot,
		);
		buildShip(this.shipG, this.skin);

		this.hudLayer = el('g', { 'pointer-events': 'none' }, svg);
		this.overlayLayer = el('g', {}, svg);

		svg.addEventListener('pointerdown', (e) => this.onPointer(e));
	}

	// ------------------------------------------------------------------
	// תפריט
	// ------------------------------------------------------------------
	private async showMenu(): Promise<void> {
		this.phase = 'menu';
		this.timerOn = false;
		this.clearTimers();
		this.gameEl.setCssStyles({ display: 'none' });
		this.menuEl.setCssStyles({ display: 'block' });
		this.menuEl.empty();
		this.menuEl.createEl('h2', { text: '🚀 Blast' });
		this.menuEl.createEl('p', { text: 'Loading your cards…' });

		await this.plugin.loadBlastData();
		const all = await this.plugin.scanAllCards();
		if (this.closed) return;

		const now = Date.now();
		const isDue = (c: Flashcard): boolean => {
			const m = this.plugin.store[c.id];
			return !m || m.due <= now;
		};
		const decks = new Map<string, { all: Flashcard[]; due: Flashcard[] }>();
		for (const c of all) {
			let d = decks.get(c.deckName);
			if (!d) {
				d = { all: [], due: [] };
				decks.set(c.deckName, d);
			}
			d.all.push(c);
			if (isDue(c)) d.due.push(c);
		}
		const totalDue = all.filter(isDue).length;
		const bd = this.plugin.blastData;

		const m = this.menuEl;
		m.empty();
		m.createEl('h2', { text: '🚀 Blast' });
		m.createEl('p', {
			text: `Shoot the asteroid that carries the right answer. You have ${LEVEL_TIME} seconds to reach each level's target. Every hit in a row is worth more, and a miss costs ${WRONG_PENALTY} points and resets the streak. Cards come from your due flashcards. Blast is practice only and never changes your review schedule.`,
		});
		const stats = m.createDiv();
		stats.setCssStyles({ fontWeight: 'bold', marginBottom: '0.75em' });
		stats.setText(
			`🏆 High score: ${bd.highScore}   ·   🔥 Best streak: ${bd.bestStreak}   ·   🎮 Games: ${bd.games}`,
		);

		// בחירת חללית: כל עיצוב נפתח לפי ההתקדמות ב-review הרגיל
		renderRewardPicker(m, this.plugin, {
			title: 'Ship',
			names: SHIP_SKINS.map((s) => s.name),
			get: () => this.plugin.settings.blastShip,
			set: (i) => {
				this.plugin.settings.blastShip = i;
			},
			draw: (cell, i) => {
				const svg = el('svg', {
					viewBox: '-46 -50 92 102',
					width: 50,
					height: 56,
				});
				cell.appendChild(svg);
				buildShip(svg, i);
			},
		});
		renderMusicPanel(m, this.plugin, 'blast', this.music);
		renderLeaderboardButton(m, this.plugin, 'blast');

		const label = m.createEl('label');
		label.setCssStyles({ display: 'block', marginBottom: '0.75em' });
		const cb = label.createEl('input', { type: 'checkbox' });
		label.appendText(' Include cards that are not due');

		const box = m.createDiv();
		box.setCssStyles({
			display: 'grid',
			gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
			gap: '10px',
		});

		// אותו עיצוב כמו כרטיסי החפיסות בדשבורד: שם החפיסה והמספרים באלמנטים
		// נפרדים, כך ששם בעברית לא מערבב את סדר הספרות
		const renderButtons = (): void => {
			box.empty();
			const add = (name: string, cards: Flashcard[]): void => {
				const due = cards.filter(isDue);
				const scope = cb.checked ? cards : due;
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
				infoDiv
					.createEl('strong', { text: name })
					.setAttr('dir', 'auto');
				infoDiv
					.createDiv({ text: `${due.length} cards due` })
					.setCssStyles({ fontSize: '0.85em' });
				infoDiv
					.createDiv({ text: `${cards.length} cards total` })
					.setCssStyles({ fontSize: '0.85em', opacity: '0.8' });
				const btn = deckCard.createEl('button', {
					text: 'Play',
					cls: 'mod-cta',
				});
				if (scope.length < 1) btn.disabled = true;
				btn.onclick = () => this.startSession(scope, all);
			};
			add('All decks', all);
			for (const [name, d] of decks.entries()) add(name, d.all);
		};
		cb.onchange = renderButtons;
		renderButtons();

		if (all.length === 0) {
			m.createEl('p', { text: 'No flashcards found.' });
		} else if (totalDue === 0) {
			m.createEl('p', {
				text: '🎉 No cards are due right now. Include cards that are not due to play with any card.',
			});
		}
	}

	// ------------------------------------------------------------------
	// התחלת משחק
	// ------------------------------------------------------------------
	private startSession(scope: Flashcard[], all: Flashcard[]): void {
		// מאגר להסחות: כרטיסי הסקופ; אם אין מספיק תשובות שונות - כל הכרטיסים
		const distinct = (cards: Flashcard[]): number =>
			new Set(cards.map((c) => normKey(answerText(c)))).size;
		let pool = scope;
		if (distinct(pool) < 4) pool = all;
		if (distinct(pool) < 2) {
			new Notice('Blast needs at least 2 cards with different answers.');
			return;
		}

		this.skin = effectivePick(
			this.plugin.settings.blastShip,
			rewardTier(this.plugin),
			SHIP_SKINS.length,
		);
		clearChildren(this.shipG);
		buildShip(this.shipG, this.skin);
		this.music.start();

		this.pool = pool;
		this.queue = shuffle(scope.slice());
		this.totalCards = this.queue.length;
		this.score = 0;
		this.levelPoints = 0;
		this.timeLeft = LEVEL_TIME;
		this.timerOn = true;
		this.streak = 0;
		this.bestStreakRun = 0;
		this.correctCount = 0;
		this.answeredCount = 0;
		this.mistakes = 0;
		this.level = 1;
		this.newRecord = false;
		this.startBest = this.plugin.blastData.highScore;
		this.current = null;
		this.clearAsteroids();
		clearChildren(this.overlayLayer);
		clearChildren(this.fxLayer);
		this.setShipAngle(0);

		this.menuEl.setCssStyles({ display: 'none' });
		this.gameEl.setCssStyles({ display: 'block' });
		this.renderHud();
		this.nextQuestion();
	}

	private clearTimers(): void {
		for (const t of this.timers) window.clearTimeout(t);
		this.timers = [];
	}

	private later(fn: () => void, ms: number): void {
		const id = window.setTimeout(() => {
			this.timers = this.timers.filter((x) => x !== id);
			if (!this.closed) fn();
		}, ms);
		this.timers.push(id);
	}

	// ------------------------------------------------------------------
	// שאלות ואסטרואידים
	// ------------------------------------------------------------------
	private nextQuestion(): void {
		const card = this.queue.shift();
		if (!card) {
			this.endGame(true);
			return;
		}
		this.current = card;
		void this.renderQuestion(card);
		this.spawnWave(card);
		this.phase = 'playing';
		this.renderHud();
	}

	private async renderQuestion(card: Flashcard): Promise<void> {
		this.questionBody.empty();
		const front = card.hint !== '' ? card.firstLine : card.front;
		await MarkdownRenderer.render(
			this.app,
			front,
			this.questionBody,
			card.filePath,
			this.component,
		);
		this.hintText.setCssStyles({ display: 'none' });
		this.hintText.empty();
		if (card.hint !== '') {
			this.hintBtn.setCssStyles({ display: 'inline-block' });
			this.hintBtn.onclick = () => {
				this.hintBtn.setCssStyles({ display: 'none' });
				this.hintText.setCssStyles({ display: 'block' });
				void MarkdownRenderer.render(
					this.app,
					card.hint,
					this.hintText,
					card.filePath,
					this.component,
				);
			};
		} else {
			this.hintBtn.setCssStyles({ display: 'none' });
		}
	}

	private speed(): number {
		return Math.min(60, 20 + this.level * 4);
	}

	private spawnWave(card: Flashcard): void {
		const correctText = answerText(card);
		const seen = new Set<string>([normKey(correctText)]);
		const distractors: string[] = [];
		for (const c of shuffle(this.pool.slice())) {
			if (c.id === card.id) continue;
			const t = answerText(c);
			const k = normKey(t);
			if (seen.has(k)) continue;
			seen.add(k);
			distractors.push(t);
			if (distractors.length >= 4) break;
		}
		const want = this.level >= 4 ? 5 : this.level >= 2 ? 4 : 3;
		const n = Math.min(want, 1 + distractors.length);
		const items: { t: string; c: boolean }[] = [
			{ t: correctText, c: true },
		];
		distractors.slice(0, n - 1).forEach((t) => items.push({ t, c: false }));
		shuffle(items);

		items.forEach((it) => {
			const seed = this.astSeed++;
			const { g, rock } = buildAsteroid(this.astLayer, AST_R, seed, it.t);
			// מיקום אקראי בזירה, בלי לעלות על אסטרואיד אחר
			let x = W / 2;
			let y = (ARENA_TOP + ARENA_BOTTOM) / 2;
			for (let tries = 0; tries < 60; tries++) {
				x = AST_R + Math.random() * (W - AST_R * 2);
				y =
					ARENA_TOP +
					AST_R +
					Math.random() * (ARENA_BOTTOM - ARENA_TOP - AST_R * 2);
				const px = x;
				const py = y;
				if (
					this.asteroids.every(
						(o) =>
							Math.hypot(o.x - px, o.y - py) >= o.r + AST_R + 4,
					)
				)
					break;
			}
			const dir = Math.random() * Math.PI * 2;
			const v = this.speed() * (0.75 + Math.random() * 0.5);
			const a: Asteroid = {
				x,
				y,
				vx: Math.cos(dir) * v,
				vy: Math.sin(dir) * v,
				r: AST_R,
				rot: Math.random() * 360,
				vr: (Math.random() - 0.5) * 24,
				text: it.t,
				correct: it.c,
				g,
				rock,
			};
			this.asteroids.push(a);
			this.placeAsteroid(a);
			anim(g, 'animate', {
				attributeName: 'opacity',
				from: 0,
				to: 1,
				dur: '0.25s',
				fill: 'freeze',
			});
		});
	}

	// תנועה חופשית בזירה: קפיצה מהקירות (כולל הגבול שמעל החללית) ואחד מהשני
	private moveAsteroids(dt: number): void {
		const list = this.asteroids;
		for (const a of list) {
			a.x += a.vx * dt;
			a.y += a.vy * dt;
			a.rot += a.vr * dt;
			if (a.x < a.r) {
				a.x = a.r;
				a.vx = Math.abs(a.vx);
			} else if (a.x > W - a.r) {
				a.x = W - a.r;
				a.vx = -Math.abs(a.vx);
			}
			if (a.y < ARENA_TOP + a.r) {
				a.y = ARENA_TOP + a.r;
				a.vy = Math.abs(a.vy);
			} else if (a.y > ARENA_BOTTOM - a.r) {
				a.y = ARENA_BOTTOM - a.r;
				a.vy = -Math.abs(a.vy);
			}
		}
		for (let i = 0; i < list.length; i++) {
			for (let j = i + 1; j < list.length; j++) {
				const a = list[i];
				const b = list[j];
				if (!a || !b) continue;
				const dx = b.x - a.x;
				const dy = b.y - a.y;
				const dist = Math.hypot(dx, dy) || 0.01;
				const overlap = a.r + b.r - dist;
				if (overlap <= 0) continue;
				const nx = dx / dist;
				const ny = dy / dist;
				a.x -= (nx * overlap) / 2;
				a.y -= (ny * overlap) / 2;
				b.x += (nx * overlap) / 2;
				b.y += (ny * overlap) / 2;
				// התנגשות אלסטית בין מסות שוות: מחליפים את רכיב המהירות שלאורך הנורמל
				const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
				if (rel < 0) {
					a.vx += rel * nx;
					a.vy += rel * ny;
					b.vx -= rel * nx;
					b.vy -= rel * ny;
				}
			}
		}
		for (const a of list) this.placeAsteroid(a);
	}

	private placeAsteroid(a: Asteroid): void {
		a.g.setAttribute(
			'transform',
			`translate(${a.x.toFixed(1)} ${a.y.toFixed(1)})`,
		);
		a.rock.setAttribute('transform', `rotate(${a.rot.toFixed(1)})`);
	}

	private clearAsteroids(): void {
		for (const a of this.asteroids) a.g.remove();
		this.asteroids = [];
	}

	private removeAsteroid(a: Asteroid): void {
		a.g.remove();
		this.asteroids = this.asteroids.filter((x) => x !== a);
	}

	// ------------------------------------------------------------------
	// לולאת המשחק
	// ------------------------------------------------------------------
	private tick = (t: number): void => {
		if (this.closed) return;
		const dt = Math.min(0.05, this.lastT ? (t - this.lastT) / 1000 : 0.016);
		this.lastT = t;

		for (const s of this.stars) {
			s.y += s.v * dt;
			if (s.y > H) s.y -= H;
			s.e.setAttribute('cy', s.y.toFixed(1));
		}

		if (this.phase === 'playing') this.moveAsteroids(dt);

		if (
			this.timerOn &&
			(this.phase === 'playing' || this.phase === 'between')
		) {
			this.timeLeft = Math.max(0, this.timeLeft - dt);
			const sec = Math.ceil(this.timeLeft);
			if (sec !== this.shownSec) {
				this.renderHud();
				if (sec <= 5 && sec > 0)
					this.tone(880, 880, 0.07, 'sine', 0.04);
			}
			if (this.timeLeft <= 0) this.onTimeUp();
		}

		this.raf = window.requestAnimationFrame(this.tick);
	};

	private onPointer(e: PointerEvent): void {
		this.getAudio();
		if (this.phase !== 'playing') return;
		const m = this.svg.getScreenCTM();
		if (!m) return;
		const pt = this.svg.createSVGPoint();
		pt.x = e.clientX;
		pt.y = e.clientY;
		const p = pt.matrixTransform(m.inverse());

		let best: Asteroid | null = null;
		let bestD = Infinity;
		for (const a of this.asteroids) {
			const d = Math.hypot(a.x - p.x, a.y - p.y);
			if (d <= a.r + 12 && d < bestD) {
				best = a;
				bestD = d;
			}
		}
		if (best) this.fire(best);
	}

	private fire(a: Asteroid): void {
		this.fireLaser(a.x, a.y);
		this.sfxLaser();
		if (a.correct) this.onCorrect(a);
		else this.onWrong(a);
	}

	// ------------------------------------------------------------------
	// תוצאות ירייה
	// ------------------------------------------------------------------
	private onCorrect(a: Asteroid): void {
		this.phase = 'between';
		this.answeredCount++;
		this.correctCount++;
		this.streak++;
		this.bestStreakRun = Math.max(this.bestStreakRun, this.streak);

		// 5 נקודות לפגיעה הראשונה, והמכפיל גדל עם כל פגיעה נוספת ברצף
		const mult = streakMult(this.streak);
		const gain = Math.round(BASE_POINTS * mult);
		this.score += gain;
		this.levelPoints += gain;

		this.explode(a.x, a.y, '#b9f6ca', '#00e676', 58, 1.2);
		this.floatText(`+${gain}`, a.x, a.y - 6, 24, '#ffeb3b');
		if (this.streak > 1)
			this.floatText(
				`${fmtMult(mult)} streak!`,
				a.x,
				a.y + 18,
				14,
				'#ff80ab',
			);
		this.sfxCorrect();
		this.removeAsteroid(a);
		for (const o of [...this.asteroids]) {
			this.explode(o.x, o.y, '#cfd8dc', '#90a4ae', 26, 0.5);
			this.removeAsteroid(o);
		}

		if (this.levelPoints >= levelTarget(this.level)) {
			this.levelUp();
			return;
		}
		this.renderHud();
		this.later(() => this.nextQuestion(), 600);
	}

	// הגעת ליעד לפני שנגמר הזמן: שלב חדש עם דקה חדשה ויעד גבוה יותר
	private levelUp(): void {
		this.timerOn = false;
		this.renderHud();
		if (this.queue.length === 0) {
			this.later(() => this.endGame(true), 700);
			return;
		}
		const banner = el('g', {}, this.fxLayer);
		el(
			'rect',
			{
				x: 30,
				y: 190,
				width: W - 60,
				height: 84,
				rx: 14,
				fill: '#000',
				opacity: 0.78,
				stroke: '#80d8ff',
				'stroke-width': 2,
			},
			banner,
		);
		txt(banner, W / 2, 224, `Level ${this.level} complete!`, 22, '#80d8ff');
		txt(
			banner,
			W / 2,
			252,
			`Next target: ${levelTarget(this.level + 1)} points`,
			14,
			'#ffffff',
		);
		this.tone(523, 523, 0.12, 'sine', 0.06, 0.35);
		this.tone(784, 784, 0.12, 'sine', 0.06, 0.47);
		this.tone(1047, 1047, 0.25, 'sine', 0.06, 0.59);
		this.later(() => {
			banner.remove();
			this.level++;
			this.levelPoints = 0;
			this.timeLeft = LEVEL_TIME;
			this.timerOn = true;
			this.nextQuestion();
		}, 1800);
	}

	private onTimeUp(): void {
		this.endGame(false);
	}

	private flashRed(): void {
		const r = el(
			'rect',
			{ x: 0, y: 0, width: W, height: H, fill: '#ff1744', opacity: 0 },
			this.fxLayer,
		);
		anim(r, 'animate', {
			attributeName: 'opacity',
			values: '0.4;0',
			dur: '0.4s',
			fill: 'freeze',
		});
		this.later(() => r.remove(), 600);
	}

	private onWrong(a: Asteroid): void {
		// טעות: מינוס 2 נקודות והרצף מתאפס (הפגיעה הבאה שוב שווה 5)
		this.mistakes++;
		this.streak = 0;
		this.score = Math.max(0, this.score - WRONG_PENALTY);
		this.levelPoints = Math.max(0, this.levelPoints - WRONG_PENALTY);
		this.explode(a.x, a.y, '#ffcdd2', '#ff1744', 46, 1);
		this.floatText(`-${WRONG_PENALTY}`, a.x, a.y, 24, '#ff5252');
		this.flashRed();
		this.sfxWrong();
		this.removeAsteroid(a);
		this.renderHud();
	}

	// ------------------------------------------------------------------
	// סיום
	// ------------------------------------------------------------------
	private commitRecord(countGame: boolean): void {
		const d = this.plugin.blastData;
		let changed = false;
		if (this.score > d.highScore) {
			d.highScore = this.score;
			changed = true;
		}
		if (this.bestStreakRun > d.bestStreak) {
			d.bestStreak = this.bestStreakRun;
			changed = true;
		}
		if (countGame) {
			d.games += 1;
			changed = true;
		}
		if (changed) void this.plugin.saveBlastData();
	}

	private endGame(completed: boolean): void {
		if (this.phase === 'ended') return;
		this.phase = 'ended';
		this.timerOn = false;
		this.clearTimers();
		clearChildren(this.fxLayer);
		this.clearAsteroids();
		this.newRecord = this.score > this.startBest && this.score > 0;
		this.commitRecord(true);
		void submitScore(this.plugin, 'blast', {
			done: false,
			level: this.level,
			value: this.score,
			gear: SHIP_SKINS[this.skin]?.name ?? '',
		});
		this.renderHud();
		this.renderEnd(completed);
		if (completed) this.sfxCorrect();
		else this.sfxWrong();
	}

	private button(
		parent: Element,
		x: number,
		y: number,
		w: number,
		h: number,
		label: string,
		onClick: () => void,
		grad = 'bl-btn',
	): void {
		const g = el('g', { style: 'cursor:pointer' }, parent);
		el(
			'rect',
			{
				x,
				y,
				width: w,
				height: h,
				rx: h / 2,
				fill: `url(#${grad})`,
				stroke: '#0d1b3a',
				'stroke-width': 2,
			},
			g,
		);
		txt(g, x + w / 2, y + h / 2 + 5, label, 15, '#ffffff');
		g.addEventListener('pointerdown', (e) => e.stopPropagation());
		g.addEventListener('click', onClick);
	}

	private renderEnd(completed: boolean): void {
		const g = this.overlayLayer;
		clearChildren(g);
		el(
			'rect',
			{ x: 0, y: 0, width: W, height: H, fill: '#04060f', opacity: 0.82 },
			g,
		);

		// איור: כוכב מתפוצץ (שלם) או חללית עם לב
		const burst = el(
			'polygon',
			{
				points: spikePoints(W / 2, 120, 12, 66, 40),
				fill: completed ? 'url(#bl-gold)' : 'url(#bl-planet)',
				stroke: completed ? '#c77800' : '#7f1d1d',
				'stroke-width': 2,
			},
			g,
		);
		anim(burst, 'animateTransform', {
			attributeName: 'transform',
			type: 'rotate',
			from: `0 ${W / 2} 120`,
			to: `360 ${W / 2} 120`,
			dur: '16s',
			repeatCount: 'indefinite',
		});
		if (completed) {
			// כוכב ענק + חיוך
			el(
				'polygon',
				{
					points: spikePoints(W / 2, 120, 5, 34, 15),
					fill: '#fff',
					opacity: 0.9,
				},
				g,
			);
		} else {
			const face = {
				stroke: '#3b0d0d',
				'stroke-width': 4,
				'stroke-linecap': 'round',
				fill: 'none',
			};
			el(
				'path',
				{ d: `M${W / 2 - 24} 104 l12 12 m0 -12 l-12 12`, ...face },
				g,
			);
			el(
				'path',
				{ d: `M${W / 2 + 12} 104 l12 12 m0 -12 l-12 12`, ...face },
				g,
			);
			el(
				'path',
				{
					d: `M${W / 2 - 18} 146 Q${W / 2} 128 ${W / 2 + 18} 146`,
					...face,
				},
				g,
			);
		}

		txt(
			g,
			W / 2,
			224,
			completed ? 'Deck cleared!' : "Time's up!",
			28,
			'#ffffff',
		);
		txt(g, W / 2, 256, `Score: ${this.score}`, 22, '#cfd8ff');
		txt(
			g,
			W / 2,
			278,
			`Level ${this.level}   ·   ${this.levelPoints} / ${levelTarget(this.level)} points`,
			13,
			'#9fb3d9',
		);

		let y = 306;
		if (this.newRecord) {
			drawTrophy(g, W / 2 - 78, y - 6, 1.2);
			txt(g, W / 2 + 10, y, 'New Record!', 20, '#ffd54f');
		} else {
			txt(
				g,
				W / 2,
				y,
				`Best: ${this.plugin.blastData.highScore}`,
				18,
				'#ffd54f',
			);
		}
		y += 28;
		txt(
			g,
			W / 2,
			y,
			`Correct: ${this.correctCount}   ·   Mistakes: ${this.mistakes}   ·   Best streak: ${this.bestStreakRun}`,
			13,
			'#9fb3d9',
		);

		this.button(g, 40, 410, 130, 40, 'Play again', () => {
			clearChildren(g);
			void this.showMenu();
		});
		this.button(
			g,
			190,
			410,
			130,
			40,
			'Close',
			() => this.close(),
			'bl-btn2',
		);
	}

	// ------------------------------------------------------------------
	// HUD
	// ------------------------------------------------------------------
	private renderHud(): void {
		const g = this.hudLayer;
		clearChildren(g);
		el(
			'rect',
			{ x: 0, y: 0, width: W, height: 36, fill: '#000', opacity: 0.35 },
			g,
		);

		// שורה עליונה: ניקוד כולל | טיימר | שלב
		el(
			'polygon',
			{ points: spikePoints(16, 18, 5, 8, 3.4), fill: 'url(#bl-gold)' },
			g,
		);
		txt(g, 30, 24, String(this.score), 17, '#ffffff', 'start');

		const sec = Math.ceil(this.timeLeft);
		this.shownSec = sec;
		txt(
			g,
			W / 2,
			25,
			`⏱ ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`,
			18,
			sec <= 10 ? '#ff5252' : '#ffffff',
		);
		txt(g, W - 14, 24, `Level ${this.level}`, 15, '#80d8ff', 'end');

		// פס התקדמות אל יעד השלב
		const target = levelTarget(this.level);
		const barW = W - 28;
		el(
			'rect',
			{
				x: 14,
				y: 42,
				width: barW,
				height: 14,
				rx: 7,
				fill: '#000',
				opacity: 0.5,
				stroke: '#5c6bc0',
				'stroke-width': 1,
			},
			g,
		);
		const frac = Math.min(1, this.levelPoints / target);
		if (frac > 0) {
			el(
				'rect',
				{
					x: 14,
					y: 42,
					width: Math.max(14, barW * frac),
					height: 14,
					rx: 7,
					fill: 'url(#bl-btn)',
				},
				g,
			);
		}
		txt(g, W / 2, 53, `${this.levelPoints} / ${target}`, 11, '#ffffff');

		// הרצף והמכפיל שיחול על הפגיעה הבאה
		txt(
			g,
			14,
			73,
			`Card ${Math.min(this.answeredCount + (this.phase === 'ended' ? 0 : 1), this.totalCards)} / ${this.totalCards}`,
			11,
			'#9fb3d9',
			'start',
		);
		if (this.streak > 0) {
			txt(
				g,
				W - 14,
				73,
				`🔥 ${this.streak}   ·   next ${fmtMult(streakMult(this.streak + 1))}`,
				12,
				'#ffab40',
				'end',
			);
		}
	}

	// ------------------------------------------------------------------
	// אפקטים
	// ------------------------------------------------------------------
	private setShipAngle(deg: number): void {
		this.shipRot.setAttribute(
			'transform',
			`rotate(${deg.toFixed(1)} ${SHIP_X} ${SHIP_Y})`,
		);
	}

	private fireLaser(tx: number, ty: number): void {
		const ang = Math.max(
			-55,
			Math.min(
				55,
				(Math.atan2(tx - SHIP_X, SHIP_Y - ty) * 180) / Math.PI,
			),
		);
		this.setShipAngle(ang);
		const rad = (ang * Math.PI) / 180;
		const nx = SHIP_X + Math.sin(rad) * 46;
		const ny = SHIP_Y - Math.cos(rad) * 46;
		const grp = el('g', {}, this.fxLayer);
		el(
			'line',
			{
				x1: nx,
				y1: ny,
				x2: tx,
				y2: ty,
				stroke: SHIP_SKINS[this.skin]?.laser ?? '#ff5252',
				'stroke-width': 9,
				'stroke-linecap': 'round',
				opacity: 0.35,
			},
			grp,
		);
		el(
			'line',
			{
				x1: nx,
				y1: ny,
				x2: tx,
				y2: ty,
				stroke: '#ffffff',
				'stroke-width': 3,
				'stroke-linecap': 'round',
			},
			grp,
		);
		anim(grp, 'animate', {
			attributeName: 'opacity',
			from: 1,
			to: 0,
			dur: '0.22s',
			fill: 'freeze',
		});
		this.later(() => grp.remove(), 300);
		this.later(() => this.setShipAngle(0), 220);
	}

	private explode(
		x: number,
		y: number,
		c1: string,
		c2: string,
		size: number,
		k: number,
	): void {
		const g = el('g', {}, this.fxLayer);
		const flash = el(
			'circle',
			{ cx: x, cy: y, r: 4, fill: c1, opacity: 0.9 },
			g,
		);
		anim(flash, 'animate', {
			attributeName: 'r',
			from: 4,
			to: size,
			dur: '0.4s',
			fill: 'freeze',
		});
		anim(flash, 'animate', {
			attributeName: 'opacity',
			from: 0.9,
			to: 0,
			dur: '0.45s',
			fill: 'freeze',
		});
		const ring = el(
			'circle',
			{
				cx: x,
				cy: y,
				r: 6,
				fill: 'none',
				stroke: c2,
				'stroke-width': 3,
				opacity: 1,
			},
			g,
		);
		anim(ring, 'animate', {
			attributeName: 'r',
			from: 6,
			to: size * 1.5,
			dur: '0.5s',
			fill: 'freeze',
		});
		anim(ring, 'animate', {
			attributeName: 'opacity',
			from: 1,
			to: 0,
			dur: '0.5s',
			fill: 'freeze',
		});
		const n = Math.round(10 * k);
		for (let i = 0; i < n; i++) {
			const ang = (i / n) * Math.PI * 2 + Math.random() * 0.4;
			const d = size * (0.8 + Math.random() * 1.1);
			const p = el(
				'circle',
				{
					cx: x,
					cy: y,
					r: 2.5 + Math.random() * 2.5,
					fill: i % 2 ? c1 : c2,
					opacity: 1,
				},
				g,
			);
			anim(p, 'animate', {
				attributeName: 'cx',
				from: x,
				to: x + Math.cos(ang) * d,
				dur: '0.7s',
				fill: 'freeze',
			});
			anim(p, 'animate', {
				attributeName: 'cy',
				from: y,
				to: y + Math.sin(ang) * d,
				dur: '0.7s',
				fill: 'freeze',
			});
			anim(p, 'animate', {
				attributeName: 'opacity',
				from: 1,
				to: 0,
				dur: '0.7s',
				fill: 'freeze',
			});
		}
		this.sfxBoom();
		this.later(() => g.remove(), 900);
	}

	private floatText(
		text: string,
		x: number,
		y: number,
		size: number,
		fill: string,
		dur = 0.9,
	): void {
		const t = txt(this.fxLayer, x, y, text, size, fill);
		t.setCssStyles({
			paintOrder: 'stroke',
			stroke: '#000',
			strokeWidth: '3px',
			strokeLinejoin: 'round',
		});
		anim(t, 'animate', {
			attributeName: 'y',
			from: y,
			to: y - 44,
			dur: `${dur}s`,
			fill: 'freeze',
		});
		anim(t, 'animate', {
			attributeName: 'opacity',
			values: '1;1;0',
			dur: `${dur}s`,
			fill: 'freeze',
		});
		this.later(() => t.remove(), dur * 1000 + 200);
	}

	// ------------------------------------------------------------------
	// צלילים
	// ------------------------------------------------------------------
	private getAudio(): AudioContext | null {
		if (!this.audio) {
			const w = window as unknown as {
				AudioContext?: typeof AudioContext;
				webkitAudioContext?: typeof AudioContext;
			};
			const Ctor = w.AudioContext ?? w.webkitAudioContext;
			if (!Ctor) return null;
			try {
				this.audio = new Ctor();
			} catch {
				return null;
			}
		}
		if (this.audio.state === 'suspended') void this.audio.resume();
		return this.audio;
	}

	private tone(
		f0: number,
		f1: number,
		dur: number,
		type: OscillatorType,
		vol: number,
		delay = 0,
	): void {
		if (!this.plugin.settings.blastSound) return;
		const ctx = this.getAudio();
		if (!ctx) return;
		const t0 = ctx.currentTime + delay;
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.type = type;
		osc.frequency.setValueAtTime(f0, t0);
		osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
		gain.gain.setValueAtTime(vol, t0);
		gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
		osc.connect(gain);
		gain.connect(ctx.destination);
		osc.start(t0);
		osc.stop(t0 + dur + 0.02);
	}

	private sfxLaser(): void {
		this.tone(1100, 220, 0.16, 'sawtooth', 0.04);
	}
	private sfxBoom(): void {
		this.tone(160, 40, 0.3, 'square', 0.05);
	}
	private sfxCorrect(): void {
		this.tone(660, 660, 0.1, 'sine', 0.06);
		this.tone(880, 880, 0.14, 'sine', 0.06, 0.1);
		this.tone(1175, 1175, 0.2, 'sine', 0.05, 0.22);
	}
	private sfxWrong(): void {
		this.tone(140, 90, 0.28, 'sawtooth', 0.05);
	}
}
