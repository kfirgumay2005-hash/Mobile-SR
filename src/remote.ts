import { App, Modal, Notice, Platform, Plugin, Setting } from 'obsidian';
import type SpacedRepetitionPlugin from './main';
import type { Flashcard } from './main';
import type { SpacedRepetitionSettings } from './settings';

// מספר השורות המקסימלי ביומן (הישנות נמחקות)
const MAX_LINES = 2000;
// הפסקה ארוכה מזה בין אירועים מוסיפה קו מפריד, כדי להפריד בין לחיצות
const GAP_MS = 1200;

interface LogLine {
	key: string | null; // שורות עם אותו מפתח ברצף מתמזגות לשורה אחת
	text: string;
	el: HTMLElement;
}

interface Start {
	x: number;
	y: number;
	t: number;
	moves: number;
}

// מודאל שרושם כל אירוע קלט שמגיע ל-WebView, כדי להבין מה שלט הטבעת שולח בפועל
export class RemoteLoggerModal extends Modal {
	private plugin: SpacedRepetitionPlugin;
	private ctrl: AbortController | null = null;
	private lines: LogLine[] = [];
	private logEl!: HTMLElement;
	private t0 = 0;
	private lastEventAt = 0;
	private blockDefault = false;
	private touchStart: Start | null = null;
	private pointerStarts = new Map<number, Start>();

	constructor(app: App, plugin: SpacedRepetitionPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText('Remote input logger');
		if (Platform.isPhone) {
			this.modalEl.setCssStyles({ width: '100vw', maxWidth: '100vw' });
		}

		const info = contentEl.createDiv({
			text: 'Press each remote button a few times, then copy the log. Newest events are at the top.',
		});
		info.setCssStyles({
			fontSize: '0.85em',
			opacity: '0.8',
			marginBottom: '0.5em',
		});

		const bar = contentEl.createDiv();
		bar.setCssStyles({
			display: 'flex',
			flexWrap: 'wrap',
			gap: '8px',
			alignItems: 'center',
			marginBottom: '0.5em',
		});
		const copyBtn = bar.createEl('button', {
			text: 'Copy log',
			cls: 'mod-cta',
		});
		copyBtn.onclick = () => void this.copyLog();
		const clearBtn = bar.createEl('button', { text: 'Clear' });
		clearBtn.onclick = () => this.clear();

		const blockLabel = bar.createEl('label');
		blockLabel.setCssStyles({
			display: 'flex',
			gap: '4px',
			alignItems: 'center',
			fontSize: '0.85em',
		});
		const blockBox = blockLabel.createEl('input', {
			type: 'checkbox',
		});
		blockLabel.appendText('Block scrolling (preventDefault on move/wheel)');
		blockBox.onchange = () => {
			this.blockDefault = blockBox.checked;
			this.add(`-- block scrolling: ${this.blockDefault ? 'on' : 'off'}`);
		};

		this.logEl = contentEl.createDiv();
		this.logEl.setAttr('dir', 'ltr');
		this.logEl.setCssStyles({
			fontFamily: 'var(--font-monospace)',
			fontSize: '0.75em',
			whiteSpace: 'pre-wrap',
			wordBreak: 'break-all',
			height: Platform.isPhone ? '55vh' : '400px',
			overflowY: 'auto',
			// בלי זה הדפדפן מזיז את הגלילה בכל שורה חדשה ונרשמים אירועי scroll מזויפים
			overflowAnchor: 'none',
			border: '1px solid var(--background-modifier-border)',
			borderRadius: '6px',
			padding: '6px',
		});

		this.t0 = performance.now();
		this.add(`-- ${this.deviceInfo()}`);
		this.attach();
	}

	onClose(): void {
		this.ctrl?.abort();
		this.ctrl = null;
		this.contentEl.empty();
	}

	private deviceInfo(): string {
		const os = Platform.isAndroidApp
			? 'android'
			: Platform.isIosApp
				? 'ios'
				: Platform.isMobile
					? 'mobile'
					: 'desktop';
		return `${os} viewport=${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio}`;
	}

	private attach(): void {
		const ctrl = new AbortController();
		this.ctrl = ctrl;
		// גם אם התוסף נטען מחדש כשהמודאל פתוח - המאזינים יוסרו
		this.plugin.register(() => ctrl.abort());
		const opts: AddEventListenerOptions = {
			capture: true,
			passive: false,
			signal: ctrl.signal,
		};
		const on = <K extends keyof WindowEventMap>(
			type: K,
			fn: (e: WindowEventMap[K]) => void,
		): void => {
			window.addEventListener(type, fn, opts);
		};

		on('touchstart', (e) => this.onTouch(e));
		on('touchmove', (e) => this.onTouch(e));
		on('touchend', (e) => this.onTouch(e));
		on('touchcancel', (e) => this.onTouch(e));
		on('pointerdown', (e) => this.onPointer(e));
		on('pointermove', (e) => this.onPointer(e));
		on('pointerup', (e) => this.onPointer(e));
		on('pointercancel', (e) => this.onPointer(e));
		on('wheel', (e) => {
			if (this.blockDefault && e.cancelable) e.preventDefault();
			this.add(
				`wheel dX=${r(e.deltaX)} dY=${r(e.deltaY)} mode=${e.deltaMode} at(${r(e.clientX)},${r(e.clientY)}) ${desc(e.target)}`,
				'wheel',
				true,
			);
		});
		on('scroll', (e) => {
			const t = e.target;
			const pos =
				t instanceof HTMLElement
					? ` top=${r(t.scrollTop)} left=${r(t.scrollLeft)}`
					: '';
			this.add(`scroll ${desc(t)}${pos}`, `scroll:${desc(t)}`, true);
		});
		on('keydown', (e) => this.onKey(e));
		on('keyup', (e) => this.onKey(e));
		on('click', (e) => this.onMouse(e));
		on('dblclick', (e) => this.onMouse(e));
		on('contextmenu', (e) => this.onMouse(e));
		document.addEventListener(
			'visibilitychange',
			() => this.add(`visibilitychange ${document.visibilityState}`),
			{ signal: ctrl.signal },
		);
	}

	private onTouch(e: TouchEvent): void {
		const p = e.changedTouches[0];
		const x = p ? p.clientX : 0;
		const y = p ? p.clientY : 0;
		const head = `${e.type} touches=${e.touches.length} changed=${e.changedTouches.length}`;

		if (e.type === 'touchstart') {
			this.touchStart = { x, y, t: e.timeStamp, moves: 0 };
			this.add(
				`${head} at(${r(x)},${r(y)}) trusted=${e.isTrusted} ${desc(e.target)}`,
			);
			return;
		}

		const s = this.touchStart;
		const delta = s
			? ` dx=${r(x - s.x)} dy=${r(y - s.y)} dur=${r(e.timeStamp - s.t)}ms`
			: '';

		if (e.type === 'touchmove') {
			if (this.blockDefault && e.cancelable) e.preventDefault();
			if (s) s.moves++;
			this.add(
				`touchmove x${s ? s.moves : '?'} last(${r(x)},${r(y)})${delta} cancelable=${e.cancelable}`,
				'touchmove',
				true,
			);
			return;
		}

		// touchend / touchcancel - שורת סיכום של כל המחווה
		this.add(
			`${head} end(${r(x)},${r(y)})${s ? ` start(${r(s.x)},${r(s.y)})` : ''}${delta} moves=${s ? s.moves : '?'}`,
		);
		if (e.touches.length === 0) this.touchStart = null;
	}

	private onPointer(e: PointerEvent): void {
		const x = e.clientX;
		const y = e.clientY;
		const head = `${e.type} id=${e.pointerId} type=${e.pointerType} primary=${e.isPrimary}`;

		if (e.type === 'pointerdown') {
			this.pointerStarts.set(e.pointerId, {
				x,
				y,
				t: e.timeStamp,
				moves: 0,
			});
			this.add(
				`${head} at(${r(x)},${r(y)}) buttons=${e.buttons} ${desc(e.target)}`,
			);
			return;
		}

		const s = this.pointerStarts.get(e.pointerId);
		const delta = s
			? ` dx=${r(x - s.x)} dy=${r(y - s.y)} dur=${r(e.timeStamp - s.t)}ms`
			: '';

		if (e.type === 'pointermove') {
			// תנועה בלי לחיצה (ריחוף עכבר) - עדיין ממזגים לשורה אחת
			const moves = s ? ++s.moves : 0;
			this.add(
				`pointermove id=${e.pointerId} type=${e.pointerType}${s ? ` x${moves}` : ' (no down)'} last(${r(x)},${r(y)})${delta}`,
				`pmove:${e.pointerId}`,
				true,
			);
			return;
		}

		this.add(
			`${head} end(${r(x)},${r(y)})${delta}${s ? ` moves=${s.moves}` : ''}`,
		);
		this.pointerStarts.delete(e.pointerId);
	}

	private onKey(e: KeyboardEvent): void {
		this.add(
			`${e.type} key=${JSON.stringify(e.key)} code=${e.code} repeat=${e.repeat} ${desc(e.target)}`,
		);
	}

	private onMouse(e: MouseEvent): void {
		this.add(
			`${e.type} at(${r(e.clientX)},${r(e.clientY)}) button=${e.button} detail=${e.detail} ${desc(e.target)}`,
		);
	}

	// מוסיף שורה ליומן. אם merge וגם המפתח זהה לשורה האחרונה - מעדכן אותה במקום
	private add(text: string, key: string | null = null, merge = false): void {
		const now = performance.now();
		const stamp = ((now - this.t0) / 1000).toFixed(3).padStart(8, ' ');
		const last = this.lines[this.lines.length - 1];

		if (merge && key && last && last.key === key) {
			last.text = `${stamp} ${text}`;
			last.el.setText(last.text);
			this.lastEventAt = now;
			return;
		}

		if (this.lastEventAt && now - this.lastEventAt > GAP_MS) {
			this.push('--------', null);
		}
		this.lastEventAt = now;
		this.push(`${stamp} ${text}`, key);
	}

	private push(text: string, key: string | null): void {
		// השורה החדשה בראש הרשימה, כך שאין צורך לגלול את היומן (גלילה הייתה נרשמת כאירוע)
		const el = createDiv({ text });
		el.setCssStyles({
			borderBottom: '1px solid var(--background-modifier-border)',
		});
		this.logEl.prepend(el);
		this.lines.push({ key, text, el });
		while (this.lines.length > MAX_LINES) {
			this.lines.shift()?.el.remove();
		}
	}

	private clear(): void {
		this.lines = [];
		this.logEl.empty();
		this.lastEventAt = 0;
		this.t0 = performance.now();
		this.add(`-- ${this.deviceInfo()}`);
	}

	private async copyLog(): Promise<void> {
		// שורת פרטי המכשיר תמיד בראש ההעתקה, גם אם נמחקה מהיומן
		const text = [
			`-- ${this.deviceInfo()}`,
			...this.lines.map((l) => l.text),
		].join('\n');
		try {
			await navigator.clipboard.writeText(text);
			new Notice(`Copied ${this.lines.length} lines.`);
		} catch {
			new Notice('Could not copy to the clipboard.');
		}
	}
}

function r(n: number): number {
	return Math.round(n);
}

// תיאור קצר של יעד האירוע: תגית ומחלקה ראשונה
function desc(t: EventTarget | null): string {
	if (t === window) return 'window';
	if (t === document) return 'document';
	if (!(t instanceof Element)) return '?';
	const cls = t.classList[0];
	return `<${t.tagName.toLowerCase()}${cls ? '.' + cls : ''}>`;
}

// ================= שלט רחוק: זיהוי מחוות וקישור לפעולות =================

export type RemoteAction =
	| 'flip'
	| 'next'
	| 'prev'
	| 'again'
	| 'hard'
	| 'good'
	| 'easy'
	| 'exit'
	| 'hint'
	| 'repeat';

export const REMOTE_ACTIONS: { id: RemoteAction; label: string }[] = [
	{ id: 'flip', label: 'Flip / show answer' },
	{ id: 'hint', label: 'Show hint' },
	{ id: 'next', label: 'Next card (skip)' },
	{ id: 'prev', label: 'Previous card' },
	{ id: 'again', label: 'Rate again' },
	{ id: 'hard', label: 'Rate hard' },
	{ id: 'good', label: 'Rate good' },
	{ id: 'easy', label: 'Rate easy' },
	{ id: 'exit', label: 'Exit review' },
	{ id: 'repeat', label: 'Read aloud again' },
];

// שמות המחוות לפי כיוון תנועת ה"אצבע". בשלט S18 הכפתור השמאלי מזיז ימינה (dx>0)
// והימני שמאלה, לכן Again על SWIPE_RIGHT ו-Good על SWIPE_LEFT.
// ב-S18 לחיצה ארוכה מפעילה פעולת מערכת ולא מגיעה לאפליקציה, לכן הרמז על לחיצה כפולה
export const DEFAULT_REMOTE_BINDINGS: Record<RemoteAction, string[]> = {
	flip: ['SWIPE_UP'],
	hint: ['DOUBLE_TAP'],
	next: ['SWIPE_DOWN'],
	prev: [],
	again: ['SWIPE_RIGHT'],
	hard: [],
	good: ['SWIPE_LEFT'],
	easy: [],
	exit: [],
	repeat: ['TAP'],
};

export const DEFAULT_REMOTE_THRESHOLDS = {
	remoteFirstStep: 16,
	remoteSwipeDistance: 35,
	remoteTapMaxMs: 60,
	remoteDoubleTapMs: 300,
	remoteDebounceMs: 200,
};

type ThresholdKey = keyof typeof DEFAULT_REMOTE_THRESHOLDS;

// פריסט של שלט: לכל שלט קישורים וספים משלו (כל שלט שולח מחוות קצת אחרות).
// רק פריסט אחד פעיל בכל רגע (remoteActivePreset)
export interface RemotePreset extends Record<ThresholdKey, number> {
	id: string;
	name: string;
	// מחוות לכל פעולה; פעולה חסרה = ברירת המחדל (DEFAULT_REMOTE_BINDINGS)
	bindings: Partial<Record<RemoteAction, string[]>>;
}

function newPresetId(): string {
	return `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

// מנקה פריסט שנטען מ-data.json (שדות חסרים או לא תקינים מקבלים ברירת מחדל)
function cleanPreset(raw: unknown): RemotePreset | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	const p: RemotePreset = {
		id: typeof r.id === 'string' && r.id ? r.id : newPresetId(),
		name: typeof r.name === 'string' && r.name.trim() ? r.name : 'Remote',
		bindings:
			r.bindings && typeof r.bindings === 'object' ? r.bindings : {},
		...DEFAULT_REMOTE_THRESHOLDS,
	};
	for (const k of Object.keys(DEFAULT_REMOTE_THRESHOLDS) as ThresholdKey[]) {
		const v = r[k];
		if (typeof v === 'number' && isFinite(v)) p[k] = v;
	}
	return p;
}

// מוודא שיש לפחות פריסט אחד ושהפריסט הפעיל קיים. בפעם הראשונה ההגדרות הישנות
// (קישורים וספים ישירות בהגדרות) הופכות לפריסט "S18"
// רשימות שכבר נוקו: מחזירים אותן כמו שהן, כדי ששינוי בפריסט יישמר בהגדרות
// (ולא בעותק) וכדי לא לנקות מחדש בכל אירוע מגע
const cleanedLists = new WeakSet<RemotePreset[]>();

export function remotePresets(s: SpacedRepetitionSettings): RemotePreset[] {
	const saved = s.remotePresets;
	if (
		saved &&
		cleanedLists.has(saved) &&
		saved.some((p) => p.id === s.remoteActivePreset)
	) {
		return saved;
	}
	const list = Array.isArray(saved)
		? saved.map(cleanPreset).filter((p): p is RemotePreset => p !== null)
		: [];
	if (list.length === 0) {
		const legacy = s as unknown as Record<string, unknown>;
		const first = cleanPreset({
			id: 's18',
			name: 'S18',
			bindings: legacy.remoteBindings,
			...Object.fromEntries(
				Object.keys(DEFAULT_REMOTE_THRESHOLDS).map((k) => [
					k,
					legacy[k],
				]),
			),
		});
		if (first) list.push(first);
		for (const k of [
			'remoteBindings',
			...Object.keys(DEFAULT_REMOTE_THRESHOLDS),
		]) {
			delete legacy[k];
		}
	}
	s.remotePresets = list;
	cleanedLists.add(list);
	if (!list.some((p) => p.id === s.remoteActivePreset)) {
		s.remoteActivePreset = list[0]?.id ?? '';
	}
	return list;
}

export function activeRemote(s: SpacedRepetitionSettings): RemotePreset {
	const list = remotePresets(s);
	const found = list.find((p) => p.id === s.remoteActivePreset) ?? list[0];
	// remotePresets תמיד מחזיר לפחות פריסט אחד
	return found as RemotePreset;
}

// פריסט חדש: בלי קישורים (כל שלט שולח מחוות אחרות - מקשרים עם Listen) וספים רגילים
export function addRemotePreset(
	s: SpacedRepetitionSettings,
	name: string,
): RemotePreset {
	const list = remotePresets(s);
	const bindings: Partial<Record<RemoteAction, string[]>> = {};
	for (const { id } of REMOTE_ACTIONS) bindings[id] = [];
	const p: RemotePreset = {
		id: newPresetId(),
		name,
		bindings,
		...DEFAULT_REMOTE_THRESHOLDS,
	};
	list.push(p);
	s.remoteActivePreset = p.id;
	return p;
}

// תנועה קטנה מזה לא נחשבת תזוזה (הקשה)
const TAP_SLOP = 6;
// החלקת אצבע / עכבר אמיתית (רק כשהאפשרות פעילה)
const MANUAL_SWIPE = 80;
const MANUAL_MAX_MS = 700;
// גלגלת: סכום התזוזה שמפעיל מחווה, והפסקה שמסיימת מחווה
const WHEEL_THRESHOLD = 60;
const WHEEL_GAP_MS = 250;
// כמה זמן מחכים ללחיצה ב-Listen
const LISTEN_TIMEOUT_MS = 10000;

const LABELS: Record<string, string> = {
	SWIPE_UP: 'Swipe up',
	SWIPE_DOWN: 'Swipe down',
	SWIPE_LEFT: 'Swipe left',
	SWIPE_RIGHT: 'Swipe right',
	TAP: 'Tap',
	DOUBLE_TAP: 'Double tap',
};

export function gestureLabel(g: string): string {
	if (g.startsWith('KEY:')) return `Key ${g.slice(4)}`;
	return LABELS[g] ?? g;
}

// הקישורים השמורים, עם ברירת מחדל לכל פעולה שלא נשמרה (ומסנן ערכים לא תקינים)
export function remoteBindings(
	s: SpacedRepetitionSettings,
): Record<RemoteAction, string[]> {
	const out = { ...DEFAULT_REMOTE_BINDINGS };
	const saved: unknown = activeRemote(s).bindings;
	const missing: RemoteAction[] = [];
	const used = new Set<string>();
	for (const { id } of REMOTE_ACTIONS) {
		const v: unknown =
			saved && typeof saved === 'object'
				? (saved as Record<string, unknown>)[id]
				: undefined;
		if (Array.isArray(v)) {
			out[id] = v.filter((g): g is string => typeof g === 'string');
			for (const g of out[id]) used.add(g);
		} else {
			missing.push(id);
		}
	}
	// ברירת מחדל של פעולה שלא נשמרה לא לוקחת מחווה שהמשתמש כבר קישר לפעולה אחרת
	for (const id of missing) {
		out[id] = DEFAULT_REMOTE_BINDINGS[id].filter((g) => !used.has(g));
	}
	return out;
}

export function remoteActionFor(
	s: SpacedRepetitionSettings,
	g: string,
): RemoteAction | null {
	const b = remoteBindings(s);
	for (const { id } of REMOTE_ACTIONS) if (b[id].includes(g)) return id;
	return null;
}

export function remoteActionLabel(a: RemoteAction): string {
	return REMOTE_ACTIONS.find((x) => x.id === a)?.label ?? a;
}

function dirOf(dx: number, dy: number): string {
	if (Math.abs(dx) >= Math.abs(dy))
		return dx < 0 ? 'SWIPE_LEFT' : 'SWIPE_RIGHT';
	return dy < 0 ? 'SWIPE_UP' : 'SWIPE_DOWN';
}

function isEditable(t: EventTarget | null): boolean {
	return (
		t instanceof Element &&
		!!t.closest('input, textarea, select, [contenteditable="true"]')
	);
}

// הקשה על כפתור או שדה לא נחשבת מחווה - היא נשארת לחיצה רגילה
function isInteractive(t: EventTarget | null): boolean {
	return (
		t instanceof Element &&
		!!t.closest(
			'button, a, input, textarea, select, label, [role="button"], .clickable-icon, [contenteditable="true"]',
		)
	);
}

export interface GestureInfo {
	source: 'remote' | 'finger' | 'mouse' | 'wheel' | 'key';
	detail: string;
}

interface RemoteInputOptions {
	settings: () => SpacedRepetitionSettings;
	// האם המחווה מקושרת כרגע. רק מחוות מקושרות נחסמות (preventDefault)
	wants: (gesture: string) => boolean;
	onGesture: (gesture: string, info: GestureInfo) => void;
	// הקשה על יעד כזה נשארת לחיצה רגילה. ברירת מחדל: כפתורים ושדות
	tapIgnore?: (target: EventTarget | null) => boolean;
}

interface TouchSeq {
	x: number;
	y: number;
	t: number;
	lastX: number;
	lastY: number;
	// remote = הצעד הראשון גדול (כמו בשלט), finger = תנועת אצבע רגילה
	mode: 'unknown' | 'remote' | 'finger' | 'ignore';
	block: boolean;
	fired: boolean;
	moved: boolean;
	target: EventTarget | null;
}

// הופך אירועי מגע / עכבר / גלגלת / מקלדת גולמיים למחוות: SWIPE_*, TAP, DOUBLE_TAP, KEY:<code>
export class RemoteInput {
	private opts: RemoteInputOptions;
	private ctrl: AbortController | null = null;
	private seq: TouchSeq | null = null;
	private pointer: { id: number; x: number; y: number; t: number } | null =
		null;
	private wheelX = 0;
	private wheelY = 0;
	private wheelLast = 0;
	private wheelFired = false;
	private lastEmit = 0;
	private lastGesture = '';
	// לחיצה בודדת שמחכה לראות אם מגיעה לחיצה שנייה (רק כשהגרסה הכפולה מקושרת)
	private pending: { g: string; info: GestureInfo; timer: number } | null =
		null;
	private suppressClickUntil = 0;

	constructor(opts: RemoteInputOptions) {
		this.opts = opts;
	}

	attach(plugin: Plugin): void {
		this.detach();
		const ctrl = new AbortController();
		this.ctrl = ctrl;
		// גם אם התוסף נטען מחדש כשהסשן פתוח - המאזינים יוסרו
		plugin.register(() => ctrl.abort());
		const opts: AddEventListenerOptions = {
			capture: true,
			passive: false,
			signal: ctrl.signal,
		};
		const on = <K extends keyof WindowEventMap>(
			type: K,
			fn: (e: WindowEventMap[K]) => void,
		): void => {
			window.addEventListener(type, fn, opts);
		};
		on('touchstart', (e) => this.onTouchStart(e));
		on('touchmove', (e) => this.onTouchMove(e));
		on('touchend', (e) => this.onTouchEnd(e));
		on('touchcancel', (e) => this.onTouchEnd(e));
		on('pointerdown', (e) => this.onPointerDown(e));
		on('pointerup', (e) => this.onPointerUp(e));
		on('wheel', (e) => this.onWheel(e));
		on('keydown', (e) => this.onKey(e));
		on('click', (e) => this.onClick(e));
		on('dblclick', (e) => this.onClick(e));
	}

	detach(): void {
		this.ctrl?.abort();
		this.ctrl = null;
		if (this.pending) window.clearTimeout(this.pending.timer);
		this.pending = null;
		this.seq = null;
	}

	private emit(g: string, info: GestureInfo): void {
		const now = performance.now();
		// רק אותה מחווה ברצף נבלעת; מחווה אחרת (למשל אחרי לחיצה ממתינה) עוברת
		if (
			g === this.lastGesture &&
			now - this.lastEmit <
				activeRemote(this.opts.settings()).remoteDebounceMs
		) {
			return;
		}
		this.lastEmit = now;
		this.lastGesture = g;
		this.opts.onGesture(g, info);
	}

	private onTouchStart(e: TouchEvent): void {
		const p = e.touches[0];
		if (e.touches.length !== 1 || !p) {
			// יותר מאצבע אחת (זום וכו') - לא מחווה
			if (this.seq) this.seq.mode = 'ignore';
			return;
		}
		this.seq = {
			x: p.clientX,
			y: p.clientY,
			t: e.timeStamp,
			lastX: p.clientX,
			lastY: p.clientY,
			mode: 'unknown',
			block: false,
			fired: false,
			moved: false,
			target: e.target,
		};
	}

	private onTouchMove(e: TouchEvent): void {
		const s = this.seq;
		const p = e.touches[0];
		if (!s || s.mode === 'ignore' || !p) return;
		const st = activeRemote(this.opts.settings());
		const dx = p.clientX - s.x;
		const dy = p.clientY - s.y;
		s.lastX = p.clientX;
		s.lastY = p.clientY;
		const big = Math.max(Math.abs(dx), Math.abs(dy));
		if (big >= TAP_SLOP) s.moved = true;

		// ההחלטה נעשית ב-touchmove הראשון: השלט קופץ מיד 19-25 פיקסלים, אצבע זזה מעט.
		// חייבים לחסום כבר כאן, אחרת הדפדפן מתחיל לגלול וה-touchmove הבאים לא ניתנים לביטול
		if (s.mode === 'unknown') {
			s.mode = big >= st.remoteFirstStep ? 'remote' : 'finger';
			if (s.mode === 'remote') s.block = this.opts.wants(dirOf(dx, dy));
		}
		if (s.block) {
			if (e.cancelable) e.preventDefault();
			e.stopPropagation();
		}
		// מפעילים כבר באמצע התנועה - לפעמים ה-touchend של השלט לא מגיע
		if (s.mode === 'remote' && !s.fired && big >= st.remoteSwipeDistance) {
			s.fired = true;
			this.single(dirOf(dx, dy), {
				source: 'remote',
				detail: `${r(dx)},${r(dy)} px in ${r(e.timeStamp - s.t)} ms`,
			});
		}
	}

	private onTouchEnd(e: TouchEvent): void {
		const s = this.seq;
		if (!s) return;
		if (e.touches.length === 0) this.seq = null;
		if (s.mode === 'ignore') return;
		const st = activeRemote(this.opts.settings());
		const manual = this.opts.settings().remoteAcceptManual;
		const p = e.changedTouches[0];
		const dx = (p ? p.clientX : s.lastX) - s.x;
		const dy = (p ? p.clientY : s.lastY) - s.y;
		const big = Math.max(Math.abs(dx), Math.abs(dy));
		const dur = e.timeStamp - s.t;
		const detail = `${r(dx)},${r(dy)} px in ${r(dur)} ms`;
		if (s.block) e.stopPropagation();

		if (s.mode === 'remote') {
			if (!s.fired && big >= st.remoteSwipeDistance) {
				this.single(dirOf(dx, dy), { source: 'remote', detail });
			}
			return;
		}
		if (s.mode === 'finger') {
			const small = Math.min(Math.abs(dx), Math.abs(dy));
			if (
				manual &&
				e.type === 'touchend' &&
				big >= MANUAL_SWIPE &&
				dur <= MANUAL_MAX_MS &&
				big >= small * 2
			) {
				this.single(dirOf(dx, dy), { source: 'finger', detail });
			}
			return;
		}
		// בלי שום touchmove: הקשה קצרה כמו של הכפתור האמצעי בשלט
		if (
			e.type === 'touchend' &&
			!s.moved &&
			big < TAP_SLOP &&
			dur <= st.remoteTapMaxMs &&
			!(this.opts.tapIgnore ?? isInteractive)(s.target)
		) {
			this.onTap(e, `${r(dur)} ms`);
		}
	}

	private onTap(e: TouchEvent, detail: string): void {
		const wantsTap = this.opts.wants('TAP');
		const wantsDouble =
			this.opts.settings().remoteDoublePress &&
			this.opts.wants('DOUBLE_TAP');
		if (!wantsTap && !wantsDouble) return;
		// מבטלים את ה-click שהדפדפן היה יוצר מההקשה
		if (e.cancelable) e.preventDefault();
		e.stopPropagation();
		this.suppressClickUntil = performance.now() + 600;
		this.tap({ source: 'remote', detail });
	}

	// הקשה בודדת או כפולה. אם Double tap מקושר והאפשרות פעילה, הקשה בודדת מחכה חלון
	// קצר; אחרת היא מופעלת מיד. (ב-S18 לחיצה כפולה על חץ לא נשלחת, לכן רק הקשה)
	private tap(info: GestureInfo): void {
		const p = this.pending;
		if (p && p.g === 'TAP') {
			window.clearTimeout(p.timer);
			this.pending = null;
			this.emit('DOUBLE_TAP', info);
			return;
		}
		this.flushPending();
		if (
			!this.opts.settings().remoteDoublePress ||
			!this.opts.wants('DOUBLE_TAP')
		) {
			this.emit('TAP', info);
			return;
		}
		const timer = window.setTimeout(() => {
			this.pending = null;
			this.emit('TAP', info);
		}, activeRemote(this.opts.settings()).remoteDoubleTapMs);
		this.pending = { g: 'TAP', info, timer };
	}

	// לחיצה אחרת הגיעה: הלחיצה הממתינה מופעלת מיד כבודדת
	private flushPending(): void {
		const p = this.pending;
		if (!p) return;
		window.clearTimeout(p.timer);
		this.pending = null;
		this.emit(p.g, p.info);
	}

	// קלט שאין לו גרסה כפולה (החלקה, מקש, גלגלת, עכבר)
	private single(g: string, info: GestureInfo): void {
		this.flushPending();
		this.emit(g, info);
	}

	private onClick(e: MouseEvent): void {
		if (performance.now() < this.suppressClickUntil) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	// עכבר / עט (מגע מטופל ב-touch*)
	private onPointerDown(e: PointerEvent): void {
		if (e.pointerType === 'touch') return;
		this.pointer = {
			id: e.pointerId,
			x: e.clientX,
			y: e.clientY,
			t: e.timeStamp,
		};
	}

	private onPointerUp(e: PointerEvent): void {
		const p = this.pointer;
		if (e.pointerType === 'touch' || !p || p.id !== e.pointerId) return;
		this.pointer = null;
		if (!this.opts.settings().remoteAcceptManual) return;
		const dx = e.clientX - p.x;
		const dy = e.clientY - p.y;
		const big = Math.max(Math.abs(dx), Math.abs(dy));
		const small = Math.min(Math.abs(dx), Math.abs(dy));
		const dur = e.timeStamp - p.t;
		if (big < MANUAL_SWIPE || dur > MANUAL_MAX_MS || big < small * 2)
			return;
		const g = dirOf(dx, dy);
		if (!this.opts.wants(g)) return;
		this.single(g, {
			source: 'mouse',
			detail: `${r(dx)},${r(dy)} px in ${r(dur)} ms`,
		});
	}

	private onWheel(e: WheelEvent): void {
		if (!this.opts.settings().remoteAcceptManual) return;
		const k =
			e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
		const now = performance.now();
		if (now - this.wheelLast > WHEEL_GAP_MS) {
			this.wheelX = 0;
			this.wheelY = 0;
			this.wheelFired = false;
		}
		this.wheelLast = now;
		// גלילה למטה (deltaY>0) היא כמו החלקת אצבע למעלה
		const g = dirOf(-e.deltaX, -e.deltaY);
		if (!this.opts.wants(g)) return;
		e.preventDefault();
		e.stopPropagation();
		if (this.wheelFired) return;
		this.wheelX += e.deltaX * k;
		this.wheelY += e.deltaY * k;
		if (
			Math.max(Math.abs(this.wheelX), Math.abs(this.wheelY)) >=
			WHEEL_THRESHOLD
		) {
			this.wheelFired = true;
			this.single(dirOf(-this.wheelX, -this.wheelY), {
				source: 'wheel',
				detail: `${r(this.wheelX)},${r(this.wheelY)}`,
			});
		}
	}

	private onKey(e: KeyboardEvent): void {
		if (e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
		const g = `KEY:${e.code || e.key}`;
		if (!this.opts.wants(g)) return;
		e.preventDefault();
		e.stopPropagation();
		if (e.repeat) return;
		this.single(g, { source: 'key', detail: e.key });
	}
}

// ---- מסך ההגדרות: פריסטים, קישורים, בדיקה וספים. מחזיר פונקציית ניקוי ----

export function renderRemoteSettings(
	containerEl: HTMLElement,
	plugin: SpacedRepetitionPlugin,
	redisplay: () => void,
): () => void {
	let probe: RemoteInput | null = null;
	let listenTimer: number | null = null;
	let stopUi: (() => void) | null = null;
	let listening: RemoteAction | null = null;
	const save = (): void => void plugin.saveSettings();

	const stopProbe = (): void => {
		probe?.detach();
		probe = null;
		if (listenTimer !== null) window.clearTimeout(listenTimer);
		listenTimer = null;
		const f = stopUi;
		stopUi = null;
		f?.();
	};
	const startProbe = (
		onGesture: (g: string, info: GestureInfo) => void,
		onStop: () => void,
		ownButton: HTMLElement,
	): void => {
		stopProbe();
		// Escape נשאר ל-Obsidian (סגירת ההגדרות).
		// ההקשה של השלט נופלת במרכז המסך, ובהגדרות יש שם כמעט תמיד כפתור - לכן כאן הקשה
		// נחשבת מחווה בכל מקום, חוץ מהכפתור שהפעיל את ההאזנה (כדי שאפשר לעצור באצבע)
		probe = new RemoteInput({
			settings: () => plugin.settings,
			wants: (g) => g !== 'KEY:Escape',
			onGesture,
			tapIgnore: (t) => t instanceof Node && ownButton.contains(t),
		});
		probe.attach(plugin);
		stopUi = onStop;
	};

	new Setting(containerEl)
		.setName('Remote control')
		.setDesc(
			'Control reviews with a wireless ring or page-turner remote that sends swipes. It works only while a review is open.',
		)
		.setHeading();

	new Setting(containerEl)
		.setName('Use the remote in reviews')
		.addToggle((t) =>
			t.setValue(plugin.settings.remoteEnabled).onChange((v) => {
				plugin.settings.remoteEnabled = v;
				save();
			}),
		);

	new Setting(containerEl)
		.setName('Show which action fired')
		.setDesc('Show a short notice each time the remote triggers an action.')
		.addToggle((t) =>
			t.setValue(plugin.settings.remoteToast).onChange((v) => {
				plugin.settings.remoteToast = v;
				save();
			}),
		);

	new Setting(containerEl)
		.setName('Double tap')
		.setDesc(
			'Two quick taps count as their own input that can be bound to an action. When it is bound, a single tap waits a moment to see whether a second one follows. Turn off to make every tap instant.',
		)
		.addToggle((t) =>
			t.setValue(plugin.settings.remoteDoublePress).onChange((v) => {
				plugin.settings.remoteDoublePress = v;
				save();
			}),
		);

	new Setting(containerEl)
		.setName('Also accept finger, mouse and wheel swipes')
		.setDesc(
			'Off: only the remote is used, and finger scrolling works as usual. On: fast finger swipes, mouse drags and the scroll wheel also trigger the bound actions.',
		)
		.addToggle((t) =>
			t.setValue(plugin.settings.remoteAcceptManual).onChange((v) => {
				plugin.settings.remoteAcceptManual = v;
				save();
			}),
		);

	// ---- בחירת השלט הפעיל ----
	const presets = remotePresets(plugin.settings);
	const current = activeRemote(plugin.settings);
	new Setting(containerEl)
		.setName('Active remote')
		.setDesc(
			'Each remote has its own bindings and thresholds. Only the selected one is used.',
		)
		.addDropdown((d) => {
			for (const p of presets) d.addOption(p.id, p.name);
			d.setValue(current.id).onChange(async (v) => {
				stopProbe();
				plugin.settings.remoteActivePreset = v;
				await plugin.saveSettings();
				redisplay();
			});
		})
		.addButton((btn) =>
			btn.setButtonText('Add remote').onClick(async () => {
				stopProbe();
				addRemotePreset(
					plugin.settings,
					`Remote ${presets.length + 1}`,
				);
				await plugin.saveSettings();
				redisplay();
				new Notice(
					'Remote added. Give it a name and bind its buttons.',
				);
			}),
		)
		.addExtraButton((btn) =>
			btn
				.setIcon('trash')
				.setTooltip('Delete this remote')
				.setDisabled(presets.length < 2)
				.onClick(async () => {
					if (presets.length < 2) return;
					stopProbe();
					plugin.settings.remotePresets = presets.filter(
						(p) => p.id !== current.id,
					);
					await plugin.saveSettings();
					redisplay();
				}),
		);

	new Setting(containerEl).setName('Remote name').addText((t) =>
		t.setValue(current.name).onChange((v) => {
			// שם ריק לא נשמר; הרשימה מתעדכנת בציור הבא של ההגדרות
			if (v.trim()) {
				current.name = v.trim();
				save();
			}
		}),
	);

	const bindingsEl = containerEl.createDiv();
	const renderBindings = (): void => {
		bindingsEl.empty();
		const b = remoteBindings(plugin.settings);
		for (const a of REMOTE_ACTIONS) {
			const row = new Setting(bindingsEl)
				.setName(a.label)
				.setDesc(
					b[a.id].length
						? b[a.id].map(gestureLabel).join(', ')
						: 'Not bound',
				);
			row.addButton((btn) =>
				btn.setButtonText('Listen…').onClick(() => {
					// לחיצה נוספת על אותו כפתור מבטלת את ההאזנה
					if (listening === a.id) {
						stopProbe();
						return;
					}
					startProbe(
						(g) => {
							stopProbe();
							// מחווה אחת מפעילה פעולה אחת: מסירים אותה משאר הפעולות
							const next = remoteBindings(plugin.settings);
							for (const k of REMOTE_ACTIONS) {
								next[k.id] = next[k.id].filter((x) => x !== g);
							}
							next[a.id].push(g);
							activeRemote(plugin.settings).bindings = next;
							save();
							renderBindings();
							new Notice(`${gestureLabel(g)}: ${a.label}`);
						},
						() => {
							listening = null;
							renderBindings();
						},
						btn.buttonEl,
					);
					listening = a.id;
					btn.setButtonText('Press the remote…').setCta();
					listenTimer = window.setTimeout(
						stopProbe,
						LISTEN_TIMEOUT_MS,
					);
				}),
			);
			row.addExtraButton((btn) =>
				btn
					.setIcon('x')
					.setTooltip('Clear')
					.onClick(() => {
						stopProbe();
						const next = remoteBindings(plugin.settings);
						next[a.id] = [];
						activeRemote(plugin.settings).bindings = next;
						save();
						renderBindings();
					}),
			);
		}
	};
	renderBindings();

	new Setting(containerEl)
		.setName('Remote tutorial')
		.setDesc(
			'A short practice deck that walks through every action with the remote. Nothing in it is saved.',
		)
		.addButton((btn) =>
			btn
				.setButtonText('Start tutorial')
				.setCta()
				.onClick(() => {
					stopProbe();
					plugin.openRemoteTutorial();
				}),
		);

	const testSetting = new Setting(containerEl)
		.setName('Test remote')
		.setDesc(
			'Press start, then use the remote. Each detected input and its action are listed. Nothing is rated here.',
		);
	const testOut = containerEl.createDiv();
	testOut.setAttr('dir', 'ltr');
	testOut.setCssStyles({
		fontFamily: 'var(--font-monospace)',
		fontSize: '0.8em',
		whiteSpace: 'pre-wrap',
		paddingBottom: '0.75em',
	});
	const testLines: string[] = [];
	let testing = false;
	testSetting.addButton((btn) => {
		btn.setButtonText('Start').onClick(() => {
			if (testing) {
				stopProbe();
				return;
			}
			startProbe(
				(g, info) => {
					const a = remoteActionFor(plugin.settings, g);
					const time = new Date().toLocaleTimeString();
					testLines.unshift(
						`${time}  ${gestureLabel(g)} (${info.source}, ${info.detail})  ->  ${a ? remoteActionLabel(a) : 'not bound'}`,
					);
					testLines.length = Math.min(testLines.length, 8);
					testOut.setText(testLines.join('\n'));
				},
				() => {
					testing = false;
					btn.setButtonText('Start').removeCta();
				},
				btn.buttonEl,
			);
			testing = true;
			btn.setButtonText('Stop').setCta();
		});
	});

	const slider = (
		name: string,
		desc: string,
		key: ThresholdKey,
		min: number,
		max: number,
		step: number,
	): void => {
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addSlider((s) =>
				s
					.setLimits(min, max, step)
					.setValue(current[key])
					.setDynamicTooltip()
					.onChange((v) => {
						activeRemote(plugin.settings)[key] = v;
						save();
					}),
			);
	};
	slider(
		'Remote first step (px)',
		'A swipe whose first movement is at least this long is treated as the remote. Finger swipes start with smaller steps.',
		'remoteFirstStep',
		5,
		60,
		1,
	);
	slider(
		'Swipe distance (px)',
		'How far a remote swipe must move before its action fires.',
		'remoteSwipeDistance',
		10,
		200,
		5,
	);
	slider(
		'Longest tap (ms)',
		'A touch without movement that is shorter than this counts as a remote tap. Taps on buttons always stay normal clicks.',
		'remoteTapMaxMs',
		20,
		200,
		5,
	);
	slider(
		'Double tap window (ms)',
		'The longest gap between the two taps of a double tap. A single tap waits this long when a double tap is bound.',
		'remoteDoubleTapMs',
		100,
		600,
		25,
	);
	slider(
		'Ignore repeats for (ms)',
		'After an action fires, further input is ignored for this long, so one press fires one action.',
		'remoteDebounceMs',
		0,
		1000,
		50,
	);

	new Setting(containerEl)
		.setName('Reset this remote')
		.setDesc(
			'Restore the default bindings and thresholds of the selected remote. The default bindings were set up for the first ring remote.',
		)
		.addButton((btn) =>
			btn.setButtonText('Reset').onClick(async () => {
				stopProbe();
				const p = activeRemote(plugin.settings);
				p.bindings = {};
				Object.assign(p, DEFAULT_REMOTE_THRESHOLDS);
				await plugin.saveSettings();
				redisplay();
			}),
		);

	return stopProbe;
}

// ---- מדריך השלט: דק שנוצר בזיכרון. הטקסט נבנה מהקישורים הנוכחיים ----
export const REMOTE_TUTORIAL_DECK = 'Remote tutorial';

export function buildRemoteTutorialCards(
	s: SpacedRepetitionSettings,
): Flashcard[] {
	const b = remoteBindings(s);
	const press = (a: RemoteAction): string => {
		const g = b[a][0];
		return g
			? `**${gestureLabel(g)}**`
			: `the input for "${remoteActionLabel(a)}" (not bound yet; bind it in Settings, Remote control)`;
	};

	// [שאלה, תשובה, רמז]
	const steps: [string, string, string?][] = [
		[
			`### Remote tutorial\nNothing in this tutorial is saved: your schedule and unlocks are not touched.\n\nPress ${press('flip')} to flip this card.`,
			`This is the answer side. Each input shows a notice with what was detected.\n\nNow press ${press('good')} to rate **Good**.\n\nRemote buttons do not always send the direction printed on them; the notices show what each one sends. Anything not bound can still be done with the buttons on screen.`,
		],
		[
			`Flip this card with ${press('flip')}.`,
			`Pressing ${press('flip')} again hides the answer. Try it, then flip back.\n\nRate this card with ${press('again')} (**Again**), the rating for a card you forgot.`,
		],
		[
			`This card has a hint. Show it with ${press('hint')}.`,
			`Rate this card with ${press('good')}.`,
			`This is the hint. Hints are written in the card between its first line and the "?" line, in decks tagged for hints.`,
		],
		[
			`Ratings only work once the answer is shown. Press ${press('good')} now, before flipping: a notice asks you to show the answer first.\n\nThen flip with ${press('flip')}.`,
			`Now rate it with ${press('hard')} (**Hard**).`,
		],
		[
			`Skip this card with ${press('next')}. A skipped card is not rated and comes back at the end of the session.`,
			`You flipped it instead. Press ${press('next')} to skip it anyway.`,
		],
		[
			`Press ${press('prev')} to go back to the card you just skipped, then press ${press('next')} to skip it again and come back here.\n\nGoing back works for rated cards too: a card you go back to can be rated again, and the new rating replaces the earlier one.`,
			`Rate this card with ${press('easy')} (**Easy**).`,
		],
		[
			`Some remotes have a center button that sends a **Tap** in the middle of the screen, and a double press sends a **Double tap**. Press it now: a notice shows whether it is bound. ${press('repeat')} reads the card aloud again when read aloud is on.\n\nThen flip with ${press('flip')}.`,
			`Finish by rating this card, or close the tutorial with ${press('exit')}. The card you skipped comes next.`,
		],
	];

	return steps.map(([front, back, hint], i) => ({
		id: `remote-tutorial-${i + 1}`,
		filePath: '',
		deckName: REMOTE_TUTORIAL_DECK,
		type: 'MultiLine',
		front,
		back,
		// בכרטיס עם רמז, השורה הראשונה היא מה שמוצג כשאלה
		firstLine: hint ? front : (front.split('\n')[0] ?? ''),
		hint: hint ?? '',
		lineStart: 0,
		lineEnd: 0,
		rawContent: `${front}\n?\n${back}`,
	}));
}
