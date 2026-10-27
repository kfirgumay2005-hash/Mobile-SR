import { App, Modal } from 'obsidian';
import type SpacedRepetitionPlugin from './main';
import { el, shuffle } from './blast';
import { fmtClock } from './aliens';
import { GameMusic, Sfx, renderMusicPanel } from './music';
import { effectivePick, renderRewardPicker, rewardTier } from './rewards';

// ============================================================================
// Sword - לוחם עם חרב מול מפלצות
//
// משחק ארקייד שהוא פרס על ה-review הרגיל: הוא לא משתמש בכרטיסים, אבל החרב
// משתדרגת לפי ההתקדמות ב-review (ראו rewards.ts) ונחלשת שוב כשהיא יורדת.
//   • הלוחם זז ימינה ושמאלה (חצים / A ו-D / הלחצנים שעל המסך).
//   • לחיצה על הזירה מכה בחרב לכיוון הלחיצה (גם רווח או לחצן החרב).
//   • מפלצות מגיעות משני הצדדים. שלושה שלבים, ובאחרון יש בוס.
//   • מספר השלבים קבוע, ולכן השיא הוא הזמן המהיר ביותר שבו המשחק הושלם.
//   • המשחק קורא את plugin.store רק כדי לדעת איזו חרב פתוחה, ולעולם לא כותב
//     אליו.
// השיא נשמר בקובץ blast-data.md.
// ============================================================================

const W = 360;
const H = 440;
const GROUND = 352;
const MAX_HP = 6;
const PLAYER_SPEED = 150;
const SWING_TIME = 0.22;
const INVULN_TIME = 0.8;
const INTRO_TIME = 1.6;
const TITLE = '⚔️ Sword';

// ---------------------------------------------------------------------------
// חרבות. חרב i נפתחת בדרגה i
// ---------------------------------------------------------------------------

interface Blade {
	name: string;
	color: string;
	glow: string; // ריק = בלי הילה
	dmg: number;
	reach: number;
	cooldown: number;
}

const BLADES: Blade[] = [
	{
		name: 'Wooden',
		color: '#a1887f',
		glow: '',
		dmg: 1,
		reach: 46,
		cooldown: 0.45,
	},
	{
		name: 'Iron',
		color: '#b0bec5',
		glow: '',
		dmg: 2,
		reach: 50,
		cooldown: 0.42,
	},
	{
		name: 'Steel',
		color: '#e3f2fd',
		glow: '#90caf9',
		dmg: 3,
		reach: 56,
		cooldown: 0.38,
	},
	{
		name: 'Flame',
		color: '#ffab40',
		glow: '#ff3d00',
		dmg: 4,
		reach: 64,
		cooldown: 0.34,
	},
	{
		name: 'Legend',
		color: '#fff59d',
		glow: '#ffd600',
		dmg: 6,
		reach: 74,
		cooldown: 0.3,
	},
];

// ---------------------------------------------------------------------------
// מפלצות ושלבים
// ---------------------------------------------------------------------------

type MonsterKind = 'slime' | 'goblin' | 'bat' | 'ogre' | 'boss';

interface MonsterDef {
	hp: number;
	speed: number;
	dmg: number;
	w: number;
	h: number;
	color: string;
}

const MONSTERS: Record<MonsterKind, MonsterDef> = {
	slime: { hp: 2, speed: 38, dmg: 1, w: 28, h: 20, color: '#66bb6a' },
	goblin: { hp: 3, speed: 62, dmg: 1, w: 24, h: 36, color: '#9ccc65' },
	bat: { hp: 1, speed: 95, dmg: 1, w: 30, h: 16, color: '#7e57c2' },
	ogre: { hp: 9, speed: 26, dmg: 2, w: 42, h: 56, color: '#8d6e63' },
	boss: { hp: 45, speed: 30, dmg: 2, w: 66, h: 88, color: '#c62828' },
};

interface LevelDef {
	name: string;
	spawn: [MonsterKind, number][];
	gap: number; // שניות בין מפלצת למפלצת
	maxAlive: number;
	sky: [string, string];
}

const LEVELS: LevelDef[] = [
	{
		name: 'Meadow',
		spawn: [
			['slime', 7],
			['goblin', 3],
		],
		gap: 1.3,
		maxAlive: 3,
		sky: ['#4fc3f7', '#e1f5fe'],
	},
	{
		name: 'Dark forest',
		spawn: [
			['goblin', 7],
			['bat', 6],
			['ogre', 2],
		],
		gap: 1,
		maxAlive: 4,
		sky: ['#1a237e', '#5c6bc0'],
	},
	{
		name: 'Warlord',
		spawn: [
			['goblin', 4],
			['bat', 4],
			['ogre', 2],
		],
		gap: 1.1,
		maxAlive: 4,
		sky: ['#311b92', '#ff7043'],
	},
];

interface Monster {
	kind: MonsterKind;
	def: MonsterDef;
	x: number;
	hp: number;
	kb: number; // מהירות ההדיפה אחרי מכה
	flash: number;
	atkCd: number;
	t: number;
}

interface Particle {
	x: number;
	y: number;
	vx: number;
	vy: number;
	life: number;
	color: string;
}

type Phase = 'menu' | 'intro' | 'playing' | 'ended';

export class SwordModal extends Modal {
	private plugin: SpacedRepetitionPlugin;
	private music: GameMusic;
	private sfx: Sfx;

	private menuEl!: HTMLElement;
	private gameEl!: HTMLElement;
	private canvas!: HTMLCanvasElement;
	private g: CanvasRenderingContext2D | null = null;
	private win: Window | null = null;

	private phase: Phase = 'menu';
	private closed = false;
	private raf = 0;
	private lastT = 0;
	private keys = new Set<string>();
	private btnDir = 0;

	private blade = 0;
	private level = 1;
	private runTime = 0;
	private kills = 0;
	private introT = 0;
	private hp = MAX_HP;
	private x = W / 2;
	private face = 1;
	private walk = 0;
	private swingT = -1;
	private cooldown = 0;
	private invuln = 0;
	private queue: MonsterKind[] = [];
	private spawnT = 0;
	private monsters: Monster[] = [];
	private particles: Particle[] = [];

	constructor(app: App, plugin: SpacedRepetitionPlugin) {
		super(app);
		this.plugin = plugin;
		this.music = new GameMusic(plugin, 'sword');
		this.sfx = new Sfx(plugin);
	}

	onOpen(): void {
		this.modalEl.addClass('srs-sword-modal');
		this.contentEl.empty();
		this.contentEl.setCssStyles({ padding: '0.5em' });
		this.menuEl = this.contentEl.createDiv();
		this.gameEl = this.contentEl.createDiv();
		this.gameEl.setCssStyles({ display: 'none' });

		this.canvas = this.gameEl.createEl('canvas');
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		this.canvas.width = W * dpr;
		this.canvas.height = H * dpr;
		this.canvas.setCssStyles({
			width: '100%',
			maxWidth: '420px',
			display: 'block',
			margin: '0 auto',
			borderRadius: '12px',
			touchAction: 'none',
			userSelect: 'none',
			cursor: 'crosshair',
		});
		this.g = this.canvas.getContext('2d');
		this.g?.scale(dpr, dpr);
		// לחיצה על הזירה: פונים לכיוון הלחיצה ומכים
		this.canvas.addEventListener('pointerdown', (e) => {
			const r = this.canvas.getBoundingClientRect();
			if (r.width <= 0) return;
			const px = ((e.clientX - r.left) / r.width) * W;
			if (Math.abs(px - this.x) > 6) this.face = px > this.x ? 1 : -1;
			this.attack();
		});
		this.buildPad();

		this.win = this.contentEl.win;
		this.win.addEventListener('keydown', this.onKeyDown);
		this.win.addEventListener('keyup', this.onKeyUp);
		this.raf = window.requestAnimationFrame(this.tick);
		void this.showMenu();
	}

	onClose(): void {
		this.closed = true;
		window.cancelAnimationFrame(this.raf);
		this.win?.removeEventListener('keydown', this.onKeyDown);
		this.win?.removeEventListener('keyup', this.onKeyUp);
		this.music.stop();
		this.sfx.close();
		this.contentEl.empty();
	}

	// לחצנים למסך מגע: תזוזה בלחיצה ארוכה, ומכה
	private buildPad(): void {
		const pad = this.gameEl.createDiv();
		pad.setCssStyles({
			display: 'flex',
			gap: '8px',
			maxWidth: '420px',
			margin: '8px auto 0 auto',
			userSelect: 'none',
		});
		const add = (text: string, flex: string): HTMLButtonElement => {
			const b = pad.createEl('button', { text });
			b.setCssStyles({
				flex,
				height: '52px',
				fontSize: '1.4em',
				touchAction: 'none',
			});
			return b;
		};
		const hold = (b: HTMLButtonElement, dir: number): void => {
			b.addEventListener('pointerdown', (e) => {
				e.preventDefault();
				this.btnDir = dir;
			});
			const release = (): void => {
				if (this.btnDir === dir) this.btnDir = 0;
			};
			b.addEventListener('pointerup', release);
			b.addEventListener('pointerleave', release);
			b.addEventListener('pointercancel', release);
		};
		hold(add('◀', '1'), -1);
		add('⚔', '1.4').addEventListener('pointerdown', (e) => {
			e.preventDefault();
			this.attack();
		});
		hold(add('▶', '1'), 1);
	}

	private keyAction(e: KeyboardEvent): string | null {
		const k = e.key.toLowerCase();
		if (k === 'arrowleft' || k === 'a') return 'left';
		if (k === 'arrowright' || k === 'd') return 'right';
		if (k === ' ' || k === 'arrowup' || k === 'w') return 'attack';
		return null;
	}

	private onKeyDown = (e: KeyboardEvent): void => {
		if (this.phase !== 'intro' && this.phase !== 'playing') return;
		const k = this.keyAction(e);
		if (!k) return;
		e.preventDefault();
		if (k === 'attack') {
			if (!e.repeat) this.attack();
		} else this.keys.add(k);
	};

	private onKeyUp = (e: KeyboardEvent): void => {
		const k = this.keyAction(e);
		if (k) this.keys.delete(k);
	};

	// ------------------------------------------------------------------
	// תפריט
	// ------------------------------------------------------------------
	private async showMenu(): Promise<void> {
		this.phase = 'menu';
		this.gameEl.setCssStyles({ display: 'none' });
		const m = this.menuEl;
		m.setCssStyles({ display: 'block' });
		m.empty();
		m.createEl('h2', { text: TITLE });
		m.createEl('p', { text: 'Loading…' });

		// טוען את השיא ואת מצב ה-review העדכני (קריאה בלבד)
		await this.plugin.loadBlastData();
		await this.plugin.scanAllCards();
		if (this.closed) return;
		const bd = this.plugin.blastData;

		m.empty();
		m.createEl('h2', { text: TITLE });
		m.createEl('p', {
			text: `Monsters close in from both sides. Move with the arrow keys or the on-screen buttons, and click or tap the arena to swing your sword in that direction. Clear all ${LEVELS.length} levels as fast as you can: your record is the fastest time. Your sword gets stronger as you keep up with your regular reviews, and weaker again when you fall behind. Sword is a reward game and never changes your review schedule.`,
		});
		const stats = m.createDiv();
		stats.setCssStyles({ fontWeight: 'bold', marginBottom: '0.75em' });
		stats.setText(
			`⏱ Best time: ${bd.swordBest > 0 ? fmtClock(bd.swordBest) : 'none yet'}   ·   🎮 Games: ${bd.swordGames}`,
		);

		renderRewardPicker(m, this.plugin, {
			title: 'Sword',
			names: BLADES.map((b) => b.name),
			get: () => this.plugin.settings.swordBlade,
			set: (i) => {
				this.plugin.settings.swordBlade = i;
			},
			draw: (cell, i) => this.drawBladeIcon(cell, i),
		});
		renderMusicPanel(m, this.plugin, 'sword', this.music);

		const play = m.createEl('button', { text: 'Play', cls: 'mod-cta' });
		play.setCssStyles({ width: '100%' });
		play.onclick = () => this.startGame();
	}

	private drawBladeIcon(cell: HTMLElement, i: number): void {
		const b = BLADES[i];
		if (!b) return;
		const svg = el('svg', { viewBox: '0 0 56 56', width: 52, height: 52 });
		cell.appendChild(svg);
		const g = el('g', { transform: 'rotate(45 28 28)' }, svg);
		const len = 20 + i * 4;
		if (b.glow !== '') {
			el(
				'rect',
				{
					x: 23,
					y: 34 - len - 3,
					width: 10,
					height: len + 4,
					rx: 5,
					fill: b.glow,
					opacity: 0.45,
				},
				g,
			);
		}
		el(
			'polygon',
			{
				points: `25,34 25,${38 - len} 28,${32 - len} 31,${38 - len} 31,34`,
				fill: b.color,
				stroke: '#263238',
				'stroke-width': 1,
			},
			g,
		);
		el(
			'rect',
			{ x: 19, y: 34, width: 18, height: 4, rx: 2, fill: '#5d4037' },
			g,
		);
		el(
			'rect',
			{ x: 26, y: 38, width: 4, height: 10, rx: 2, fill: '#3e2723' },
			g,
		);
	}

	// ------------------------------------------------------------------
	// משחק
	// ------------------------------------------------------------------
	private startGame(): void {
		this.blade = effectivePick(
			this.plugin.settings.swordBlade,
			rewardTier(this.plugin),
			BLADES.length,
		);
		this.music.start();
		this.runTime = 0;
		this.kills = 0;
		this.hp = MAX_HP;
		this.x = W / 2;
		this.face = 1;
		this.swingT = -1;
		this.cooldown = 0;
		this.invuln = 0;
		this.btnDir = 0;
		this.particles = [];
		this.keys.clear();
		this.menuEl.setCssStyles({ display: 'none' });
		this.gameEl.setCssStyles({ display: 'block' });
		this.startLevel(1);
	}

	private startLevel(level: number): void {
		this.level = level;
		this.monsters = [];
		this.queue = [];
		const def = LEVELS[level - 1];
		for (const [kind, n] of def?.spawn ?? []) {
			for (let i = 0; i < n; i++) this.queue.push(kind);
		}
		shuffle(this.queue);
		// הבוס מגיע אחרון
		if (level === LEVELS.length) this.queue.push('boss');
		this.spawnT = 0.4;
		this.introT = INTRO_TIME;
		this.phase = 'intro';
		this.sfx.tone(392, 392, 0.1, 'sine', 0.05);
		this.sfx.tone(587, 587, 0.16, 'sine', 0.05, 0.12);
	}

	private attack(): void {
		if (this.phase !== 'playing' || this.cooldown > 0) return;
		const b = BLADES[this.blade];
		if (!b) return;
		this.cooldown = b.cooldown;
		this.swingT = 0;
		this.sfx.tone(700, 180, 0.12, 'sawtooth', 0.03);
		let hit = false;
		for (const m of this.monsters) {
			const d = (m.x - this.x) * this.face;
			if (d < -12 || d > b.reach + m.def.w / 2) continue;
			hit = true;
			m.hp -= b.dmg;
			m.flash = 0.1;
			m.kb = this.face * (m.kind === 'boss' ? 50 : 190);
			const y = this.monsterY(m) - m.def.h / 2;
			this.burst(m.x, y, m.hp <= 0 ? m.def.color : '#ffffff', 6);
			if (m.hp <= 0) this.burst(m.x, y, m.def.color, 14);
		}
		if (hit) this.sfx.tone(220, 70, 0.14, 'square', 0.04);
		this.kills += this.monsters.filter((m) => m.hp <= 0).length;
		this.monsters = this.monsters.filter((m) => m.hp > 0);
	}

	// גובה הרגליים של המפלצת (העטלף מרחף)
	private monsterY(m: Monster): number {
		return m.kind === 'bat' ? GROUND - 34 + Math.sin(m.t * 5) * 10 : GROUND;
	}

	private burst(x: number, y: number, color: string, n: number): void {
		for (let i = 0; i < n; i++) {
			const a = Math.random() * Math.PI * 2;
			const v = 40 + Math.random() * 120;
			this.particles.push({
				x,
				y,
				vx: Math.cos(a) * v,
				vy: Math.sin(a) * v - 40,
				life: 0.3 + Math.random() * 0.4,
				color,
			});
		}
	}

	private tick = (t: number): void => {
		if (this.closed) return;
		const dt = Math.min(0.05, this.lastT ? (t - this.lastT) / 1000 : 0.016);
		this.lastT = t;
		if (this.phase === 'intro' || this.phase === 'playing') {
			this.update(dt);
			this.draw();
		}
		this.raf = window.requestAnimationFrame(this.tick);
	};

	private update(dt: number): void {
		for (const p of this.particles) {
			p.x += p.vx * dt;
			p.y += p.vy * dt;
			p.vy += 260 * dt;
			p.life -= dt;
		}
		this.particles = this.particles.filter((p) => p.life > 0);

		const keyDir =
			(this.keys.has('right') ? 1 : 0) - (this.keys.has('left') ? 1 : 0);
		const dir = keyDir !== 0 ? keyDir : this.btnDir;
		if (dir !== 0) {
			this.x = Math.max(
				16,
				Math.min(W - 16, this.x + dir * PLAYER_SPEED * dt),
			);
			// באמצע מכה הלוחם לא מסתובב
			if (this.swingT < 0) this.face = dir;
			this.walk += dt * 10;
		}
		this.cooldown = Math.max(0, this.cooldown - dt);
		this.invuln = Math.max(0, this.invuln - dt);
		if (this.swingT >= 0) {
			this.swingT += dt;
			if (this.swingT > SWING_TIME) this.swingT = -1;
		}

		if (this.phase === 'intro') {
			this.introT -= dt;
			if (this.introT <= 0) this.phase = 'playing';
			return;
		}
		this.runTime += dt;

		// מפלצת חדשה מגיעה מאחד הצדדים
		const def = LEVELS[this.level - 1];
		this.spawnT -= dt;
		if (
			def &&
			this.spawnT <= 0 &&
			this.queue.length > 0 &&
			this.monsters.length < def.maxAlive
		) {
			const kind = this.queue.shift();
			if (kind) {
				const md = MONSTERS[kind];
				const side = Math.random() < 0.5 ? -1 : 1;
				this.monsters.push({
					kind,
					def: md,
					x: side < 0 ? -md.w : W + md.w,
					hp: md.hp,
					kb: 0,
					flash: 0,
					atkCd: 0.3,
					t: Math.random() * 6,
				});
			}
			this.spawnT = def.gap;
		}

		for (const m of this.monsters) {
			m.t += dt;
			m.flash = Math.max(0, m.flash - dt);
			m.atkCd = Math.max(0, m.atkCd - dt);
			m.x += m.kb * dt;
			m.kb *= Math.pow(0.02, dt);
			const dx = this.x - m.x;
			const range = m.def.w / 2 + 12;
			if (Math.abs(dx) > range) {
				if (Math.abs(m.kb) < 30)
					m.x += Math.sign(dx) * m.def.speed * dt;
			} else if (m.atkCd <= 0) {
				m.atkCd = 1.1;
				if (this.invuln <= 0) this.playerHit(m.def.dmg);
			}
		}
		if (this.phase !== 'playing') return;

		if (this.queue.length === 0 && this.monsters.length === 0) {
			if (this.level >= LEVELS.length) this.endGame(true);
			else this.startLevel(this.level + 1);
		}
	}

	private playerHit(dmg: number): void {
		this.hp -= dmg;
		this.invuln = INVULN_TIME;
		this.burst(this.x, GROUND - 30, '#ff5252', 10);
		this.sfx.tone(160, 60, 0.3, 'sawtooth', 0.06);
		if (this.hp <= 0) this.endGame(false);
	}

	// ------------------------------------------------------------------
	// ציור
	// ------------------------------------------------------------------
	private drawMonster(m: Monster): void {
		const g = this.g;
		if (!g) return;
		const d = m.def;
		const y = this.monsterY(m);
		const look = this.x >= m.x ? 1 : -1;
		const body = m.flash > 0 ? '#ffffff' : d.color;
		g.save();
		g.translate(m.x, y);
		g.scale(look, 1);
		g.fillStyle = body;
		if (m.kind === 'slime') {
			const sq = 1 + Math.sin(m.t * 6) * 0.12;
			g.beginPath();
			g.ellipse(0, 0, (d.w / 2) * sq, d.h / sq, 0, Math.PI, 0);
			g.fill();
		} else if (m.kind === 'bat') {
			const flap = Math.sin(m.t * 18) * 8;
			g.beginPath();
			g.moveTo(0, -8);
			g.lineTo(-d.w / 2, -8 - flap);
			g.lineTo(-6, -2);
			g.lineTo(6, -2);
			g.lineTo(d.w / 2, -8 - flap);
			g.closePath();
			g.fill();
			g.beginPath();
			g.arc(0, -8, 7, 0, Math.PI * 2);
			g.fill();
		} else {
			// גוף, ראש, רגליים; לגובלין אוזניים ולבוס קרניים
			const step = Math.sin(m.t * 8) * 3;
			const legH = d.h * 0.25;
			g.fillRect(
				-d.w * 0.32,
				-legH + Math.min(0, step),
				d.w * 0.22,
				legH,
			);
			g.fillRect(d.w * 0.1, -legH + Math.min(0, -step), d.w * 0.22, legH);
			g.fillRect(-d.w / 2, -d.h * 0.72, d.w, d.h * 0.5);
			g.beginPath();
			g.arc(0, -d.h * 0.8, d.w * 0.34, 0, Math.PI * 2);
			g.fill();
			if (m.kind === 'goblin') {
				g.beginPath();
				g.moveTo(-d.w * 0.3, -d.h * 0.85);
				g.lineTo(-d.w * 0.75, -d.h * 1.0);
				g.lineTo(-d.w * 0.3, -d.h * 0.72);
				g.moveTo(d.w * 0.3, -d.h * 0.85);
				g.lineTo(d.w * 0.75, -d.h * 1.0);
				g.lineTo(d.w * 0.3, -d.h * 0.72);
				g.fill();
			}
			if (m.kind === 'boss') {
				g.fillStyle = '#ffe082';
				g.beginPath();
				g.moveTo(-d.w * 0.28, -d.h * 0.98);
				g.lineTo(-d.w * 0.42, -d.h * 1.22);
				g.lineTo(-d.w * 0.1, -d.h * 1.04);
				g.moveTo(d.w * 0.28, -d.h * 0.98);
				g.lineTo(d.w * 0.42, -d.h * 1.22);
				g.lineTo(d.w * 0.1, -d.h * 1.04);
				g.fill();
			}
			// זרוע שמונפת לפני מכה
			g.strokeStyle = body;
			g.lineWidth = Math.max(4, d.w * 0.16);
			g.lineCap = 'round';
			g.beginPath();
			g.moveTo(d.w * 0.3, -d.h * 0.6);
			g.lineTo(d.w * 0.75, -d.h * (m.atkCd > 0.85 ? 0.85 : 0.45));
			g.stroke();
		}
		// עיניים
		const eyeY =
			m.kind === 'slime'
				? -d.h * 0.55
				: m.kind === 'bat'
					? -9
					: -d.h * 0.82;
		const eye = Math.max(2, d.w * 0.07);
		g.fillStyle = '#ffffff';
		g.beginPath();
		g.arc(d.w * 0.02, eyeY, eye, 0, Math.PI * 2);
		g.arc(d.w * 0.22, eyeY, eye, 0, Math.PI * 2);
		g.fill();
		g.fillStyle = '#000000';
		g.beginPath();
		g.arc(d.w * 0.05, eyeY, eye * 0.5, 0, Math.PI * 2);
		g.arc(d.w * 0.25, eyeY, eye * 0.5, 0, Math.PI * 2);
		g.fill();
		g.restore();

		// פס חיים למפלצות חזקות
		if (d.hp >= 9) {
			const bw = d.w;
			const by = y - d.h * (m.kind === 'boss' ? 1.3 : 1.2);
			g.fillStyle = 'rgba(0,0,0,0.5)';
			g.fillRect(m.x - bw / 2, by, bw, 5);
			g.fillStyle = '#ff5252';
			g.fillRect(m.x - bw / 2, by, bw * Math.max(0, m.hp / d.hp), 5);
		}
	}

	private drawPlayer(): void {
		const g = this.g;
		const b = BLADES[this.blade];
		if (!g || !b) return;
		// הבהוב בזמן החסינות שאחרי פגיעה
		if (this.invuln > 0 && Math.floor(this.invuln * 14) % 2 === 0) return;
		const step = Math.sin(this.walk) * 5;
		g.save();
		g.translate(this.x, GROUND);
		g.scale(this.face, 1);
		g.lineCap = 'round';
		// רגליים
		g.strokeStyle = '#37474f';
		g.lineWidth = 5;
		g.beginPath();
		g.moveTo(-3, -18);
		g.lineTo(-5 + step, 0);
		g.moveTo(3, -18);
		g.lineTo(5 - step, 0);
		g.stroke();
		// גוף ומגן
		g.fillStyle = '#1565c0';
		g.fillRect(-8, -40, 16, 24);
		g.fillStyle = '#90a4ae';
		g.beginPath();
		g.ellipse(-9, -28, 6, 10, 0, 0, Math.PI * 2);
		g.fill();
		// ראש וקסדה
		g.fillStyle = '#ffcc80';
		g.beginPath();
		g.arc(0, -47, 8, 0, Math.PI * 2);
		g.fill();
		g.fillStyle = '#b0bec5';
		g.beginPath();
		g.arc(0, -49, 9, Math.PI, 0);
		g.fill();
		g.fillStyle = '#e53935';
		g.fillRect(-2, -62, 4, 6);

		// החרב: במנוחה מונפת למעלה, ובמכה נעה בקשת קדימה
		const p = this.swingT >= 0 ? this.swingT / SWING_TIME : -1;
		const ang = p >= 0 ? -1.9 + p * 2.7 : -0.9;
		const len = b.reach * 0.62;
		if (p >= 0) {
			g.fillStyle = b.glow !== '' ? b.glow : '#ffffff';
			g.globalAlpha = 0.3;
			g.beginPath();
			g.moveTo(8, -32);
			g.arc(8, -32, len + 12, -1.9, ang);
			g.closePath();
			g.fill();
			g.globalAlpha = 1;
		}
		g.translate(8, -32);
		g.rotate(ang);
		if (b.glow !== '') {
			g.shadowColor = b.glow;
			g.shadowBlur = 12;
		}
		g.strokeStyle = b.color;
		g.lineWidth = 4;
		g.beginPath();
		g.moveTo(8, 0);
		g.lineTo(8 + len, 0);
		g.stroke();
		g.shadowBlur = 0;
		g.strokeStyle = '#5d4037';
		g.lineWidth = 4;
		g.beginPath();
		g.moveTo(0, 0);
		g.lineTo(7, 0);
		g.moveTo(8, -5);
		g.lineTo(8, 5);
		g.stroke();
		g.restore();
	}

	private draw(): void {
		const g = this.g;
		if (!g) return;
		const def = LEVELS[this.level - 1];
		const sky = g.createLinearGradient(0, 0, 0, GROUND);
		sky.addColorStop(0, def?.sky[0] ?? '#4fc3f7');
		sky.addColorStop(1, def?.sky[1] ?? '#e1f5fe');
		g.fillStyle = sky;
		g.fillRect(0, 0, W, H);
		// גבעות ואדמה
		g.fillStyle = 'rgba(0,0,0,0.18)';
		g.beginPath();
		g.moveTo(0, GROUND);
		g.quadraticCurveTo(70, GROUND - 110, 150, GROUND);
		g.quadraticCurveTo(250, GROUND - 150, W, GROUND - 30);
		g.lineTo(W, GROUND);
		g.fill();
		g.fillStyle = '#33691e';
		g.fillRect(0, GROUND, W, 10);
		g.fillStyle = '#4e342e';
		g.fillRect(0, GROUND + 10, W, H - GROUND - 10);

		for (const m of this.monsters) this.drawMonster(m);
		this.drawPlayer();
		for (const p of this.particles) {
			g.globalAlpha = Math.min(1, p.life * 3);
			g.fillStyle = p.color;
			g.fillRect(p.x - 2, p.y - 2, 4, 4);
		}
		g.globalAlpha = 1;

		// HUD
		g.fillStyle = 'rgba(0,0,0,0.45)';
		g.fillRect(0, 0, W, 32);
		g.font = 'bold 15px sans-serif';
		g.textBaseline = 'middle';
		g.textAlign = 'left';
		g.fillStyle = '#ff5252';
		g.fillText('♥'.repeat(Math.max(0, this.hp)), 10, 17);
		g.textAlign = 'center';
		g.fillStyle = '#ffffff';
		g.fillText(`⏱ ${fmtClock(this.runTime)}`, W / 2, 17);
		g.textAlign = 'right';
		g.fillStyle = '#80d8ff';
		g.fillText(`Level ${this.level}`, W - 10, 17);
		g.font = 'bold 11px sans-serif';
		g.fillStyle = '#ffffff';
		g.textAlign = 'left';
		g.fillText(`${BLADES[this.blade]?.name ?? ''} sword`, 10, H - 12);
		g.textAlign = 'right';
		g.fillText(
			`Monsters left: ${this.queue.length + this.monsters.length}`,
			W - 10,
			H - 12,
		);

		if (this.phase === 'intro') {
			g.textAlign = 'center';
			g.fillStyle = '#ffffff';
			g.font = 'bold 30px sans-serif';
			g.fillText(`Level ${this.level}`, W / 2, 150);
			g.font = 'bold 16px sans-serif';
			g.fillText(def?.name ?? '', W / 2, 182);
		}
	}

	// ------------------------------------------------------------------
	// סיום
	// ------------------------------------------------------------------
	private endGame(won: boolean): void {
		if (this.phase === 'ended') return;
		this.phase = 'ended';
		const time = Math.round(this.runTime * 10) / 10;
		const d = this.plugin.blastData;
		const prev = d.swordBest;
		const newRecord = won && (prev <= 0 || time < prev);
		if (newRecord) d.swordBest = time;
		d.swordGames += 1;
		void this.plugin.saveBlastData();
		if (won) {
			this.sfx.tone(523, 523, 0.12, 'sine', 0.06);
			this.sfx.tone(784, 784, 0.12, 'sine', 0.06, 0.12);
			this.sfx.tone(1047, 1047, 0.3, 'sine', 0.06, 0.24);
		}

		this.gameEl.setCssStyles({ display: 'none' });
		const m = this.menuEl;
		m.setCssStyles({ display: 'block' });
		m.empty();
		const box = m.createDiv();
		box.setCssStyles({ textAlign: 'center', padding: '1.5em 0.5em' });
		box.createEl('h2', {
			text: newRecord
				? '🏆 New best time!'
				: won
					? '🎉 All monsters defeated!'
					: '💀 You were defeated',
		});
		if (won) {
			box.createDiv({ text: fmtClock(time) }).setCssStyles({
				fontSize: '2.2em',
				fontWeight: 'bold',
				margin: '0.3em 0',
				fontVariantNumeric: 'tabular-nums',
			});
		} else {
			box.createDiv({
				text: `You reached level ${this.level} of ${LEVELS.length}. Only a completed run sets a time.`,
			});
		}
		if (prev > 0) {
			box.createDiv({
				text: newRecord
					? `Previous best: ${fmtClock(prev)}`
					: `Best time: ${fmtClock(prev)}`,
			}).setCssStyles({ opacity: '0.8', fontSize: '0.9em' });
		}

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
		}).onclick = () => this.startGame();
		btns.createEl('button', { text: 'Swords and music' }).onclick = () =>
			void this.showMenu();
		btns.createEl('button', { text: 'Close' }).onclick = () => this.close();
	}
}
