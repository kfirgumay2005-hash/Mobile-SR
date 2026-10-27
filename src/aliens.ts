import { App, Modal } from 'obsidian';
import type SpacedRepetitionPlugin from './main';
import { el } from './blast';
import { GameMusic, Sfx, renderMusicPanel } from './music';
import { effectivePick, renderRewardPicker, rewardTier } from './rewards';

// ============================================================================
// Aliens - משחק יריות דו-ממדי נגד חייזרים
//
// משחק ארקייד שהוא פרס על ה-review הרגיל: הוא לא משתמש בכרטיסים, אבל כלי
// הנשק נפתחים לפי ההתקדמות ב-review (ראו rewards.ts) וננעלים שוב כשהיא יורדת.
//   • החללית זזה ימינה ושמאלה (גרירה / עכבר / חצים) ויורה לבד.
//   • שלושה שלבים: סיירים, פושטים, וספינת האם.
//   • שלוש פסילות. חייזר שמגיע לגובה החללית מסיים את המשחק.
//   • מספר השלבים קבוע, ולכן השיא הוא הזמן המהיר ביותר שבו המשחק הושלם.
//   • המשחק קורא את plugin.store רק כדי לדעת איזה נשק פתוח, ולעולם לא כותב
//     אליו.
// השיא נשמר בקובץ blast-data.md.
// ============================================================================

const W = 360;
const H = 520;
const PLAYER_Y = H - 44;
const PLAYER_R = 11;
const LIVES = 3;
const LEVELS = ['Scouts', 'Raiders', 'Mothership'];
const KEY_SPEED = 260;
const INTRO_TIME = 1.6;

// זמן משחק: 1:05.3
export const fmtClock = (secs: number): string => {
	const t = Math.round(secs * 10) / 10;
	const m = Math.floor(t / 60);
	return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
};

// ---------------------------------------------------------------------------
// כלי נשק. נשק i נפתח בדרגה i
// ---------------------------------------------------------------------------

interface ShotSpec {
	dx: number; // היסט מהחללית
	deg: number; // זווית מהאנך
	r: number;
	dmg: number;
	pierce: boolean;
}

interface Weapon {
	name: string;
	color: string;
	cooldown: number;
	speed: number;
	shots: ShotSpec[];
}

const shot = (
	dx: number,
	deg: number,
	r = 3,
	dmg = 1,
	pierce = false,
): ShotSpec => ({ dx, deg, r, dmg, pierce });

const WEAPONS: Weapon[] = [
	{
		name: 'Blaster',
		color: '#80d8ff',
		cooldown: 0.32,
		speed: 430,
		shots: [shot(0, 0)],
	},
	{
		name: 'Twin',
		color: '#69f0ae',
		cooldown: 0.3,
		speed: 450,
		shots: [shot(-7, 0), shot(7, 0)],
	},
	{
		name: 'Tri-Spread',
		color: '#ffd740',
		cooldown: 0.3,
		speed: 450,
		shots: [shot(0, -14), shot(0, 0), shot(0, 14)],
	},
	{
		name: 'Plasma',
		color: '#ea80fc',
		cooldown: 0.36,
		speed: 400,
		shots: [shot(0, 0, 7, 3, true)],
	},
	{
		name: 'Nova Storm',
		color: '#ff6e40',
		cooldown: 0.22,
		speed: 480,
		shots: [
			shot(0, -24, 3, 2),
			shot(0, -12, 3, 2),
			shot(0, 0, 5, 2, true),
			shot(0, 12, 3, 2),
			shot(0, 24, 3, 2),
		],
	},
];

// ---------------------------------------------------------------------------
// ציורי החייזרים (פיקסלים)
// ---------------------------------------------------------------------------

const SPRITES: string[][] = [
	[
		'...XXXXX...',
		'..XXXXXXX..',
		'.XX.XXX.XX.',
		'.XXXXXXXXX.',
		'..XXXXXXX..',
		'..X.X.X.X..',
		'.X..X.X..X.',
		'X.........X',
	],
	[
		'X...XXX...X',
		'XX.XXXXX.XX',
		'XXXXXXXXXXX',
		'XXX.XXX.XXX',
		'.XXXXXXXXX.',
		'..XX...XX..',
		'.XX.....XX.',
		'.X.......X.',
	],
	[
		'....XXX....',
		'.XXXXXXXXX.',
		'XXXXXXXXXXX',
		'XX..XXX..XX',
		'XXXXXXXXXXX',
		'.XXX...XXX.',
		'XX..XXX..XX',
		'.XX.....XX.',
	],
];
const SPRITE_W = 11;
const SPRITE_H = 8;

type EnemyKind = 'grid' | 'flyer' | 'boss';

interface Enemy {
	id: number;
	kind: EnemyKind;
	sprite: number;
	color: string;
	px: number; // גודל פיקסל
	x: number;
	y: number;
	w: number;
	h: number;
	hp: number;
	maxHp: number;
	points: number;
	t: number;
	baseX: number;
	flash: number;
}

interface Bullet {
	x: number;
	y: number;
	vx: number;
	vy: number;
	r: number;
	dmg: number;
	pierce: boolean;
	hit: Set<number>;
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

export class AliensModal extends Modal {
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

	private weapon = 0;
	private level = 1;
	private score = 0;
	private runTime = 0;
	private lives = LIVES;
	private introT = 0;
	private playerX = W / 2;
	private targetX: number | null = null;
	private invuln = 0;
	private cooldown = 0;
	private enemyFireT = 0;
	private spawnT = 0;
	private formDir = 1;
	private gridTotal = 0;
	private nextId = 1;
	private enemies: Enemy[] = [];
	private bullets: Bullet[] = [];
	private enemyBullets: Bullet[] = [];
	private particles: Particle[] = [];
	private stars: { x: number; y: number; v: number; s: number }[] = [];

	constructor(app: App, plugin: SpacedRepetitionPlugin) {
		super(app);
		this.plugin = plugin;
		this.music = new GameMusic(plugin, 'aliens');
		this.sfx = new Sfx(plugin);
	}

	onOpen(): void {
		this.modalEl.addClass('srs-aliens-modal');
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
		});
		this.g = this.canvas.getContext('2d');
		this.g?.scale(dpr, dpr);
		const steer = (e: PointerEvent): void => {
			const r = this.canvas.getBoundingClientRect();
			if (r.width > 0)
				this.targetX = ((e.clientX - r.left) / r.width) * W;
		};
		this.canvas.addEventListener('pointerdown', steer);
		this.canvas.addEventListener('pointermove', steer);

		for (let i = 0; i < 50; i++) {
			const s = 0.6 + Math.random() * 1.4;
			this.stars.push({
				x: Math.random() * W,
				y: Math.random() * H,
				v: 10 + s * 22,
				s,
			});
		}

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
		// משחק שנקטע באמצע עדיין נחשב לשיא
		if (this.phase === 'intro' || this.phase === 'playing') {
			this.commit(false);
		}
		this.contentEl.empty();
	}

	private steerKey(e: KeyboardEvent): string | null {
		const k = e.key.toLowerCase();
		if (k === 'arrowleft' || k === 'a') return 'left';
		if (k === 'arrowright' || k === 'd') return 'right';
		return null;
	}

	private onKeyDown = (e: KeyboardEvent): void => {
		if (this.phase !== 'intro' && this.phase !== 'playing') return;
		const k = this.steerKey(e);
		if (!k) return;
		e.preventDefault();
		this.keys.add(k);
		this.targetX = null;
	};

	private onKeyUp = (e: KeyboardEvent): void => {
		const k = this.steerKey(e);
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
		m.createEl('h2', { text: '👾 Aliens' });
		m.createEl('p', { text: 'Loading…' });

		// טוען את השיא ואת מצב ה-review העדכני (קריאה בלבד)
		await this.plugin.loadBlastData();
		await this.plugin.scanAllCards();
		if (this.closed) return;
		const bd = this.plugin.blastData;

		m.empty();
		m.createEl('h2', { text: '👾 Aliens' });
		m.createEl('p', {
			text: `Fight through ${LEVELS.length} levels of invaders. Drag, move the mouse or use the arrow keys to steer; your ship fires by itself. You have ${LIVES} lives, and your record is the fastest time in which you clear every level. Better weapons unlock as you keep up with your regular reviews, and lock again when you fall behind. Aliens is a reward game and never changes your review schedule.`,
		});
		const stats = m.createDiv();
		stats.setCssStyles({ fontWeight: 'bold', marginBottom: '0.75em' });
		stats.setText(
			`⏱ Best time: ${bd.aliensBestTime > 0 ? fmtClock(bd.aliensBestTime) : 'none yet'}   ·   🏆 High score: ${bd.aliensHigh}   ·   🎮 Games: ${bd.aliensGames}`,
		);

		renderRewardPicker(m, this.plugin, {
			title: 'Weapon',
			names: WEAPONS.map((w) => w.name),
			get: () => this.plugin.settings.aliensWeapon,
			set: (i) => {
				this.plugin.settings.aliensWeapon = i;
			},
			draw: (cell, i) => this.drawWeaponIcon(cell, i),
		});
		renderMusicPanel(m, this.plugin, 'aliens', this.music);

		const play = m.createEl('button', { text: 'Play', cls: 'mod-cta' });
		play.setCssStyles({ width: '100%' });
		play.onclick = () => this.startGame();
	}

	// תצוגה מקדימה של נשק: צורת המטח שלו
	private drawWeaponIcon(cell: HTMLElement, i: number): void {
		const w = WEAPONS[i];
		if (!w) return;
		const svg = el('svg', {
			viewBox: '-30 -44 60 52',
			width: 56,
			height: 50,
		});
		cell.appendChild(svg);
		el('polygon', { points: '0,-4 8,6 -8,6', fill: '#cfd8dc' }, svg);
		for (const s of w.shots) {
			const rad = (s.deg * Math.PI) / 180;
			for (const d of [14, 30]) {
				el(
					'circle',
					{
						cx: s.dx + Math.sin(rad) * d,
						cy: -4 - Math.cos(rad) * d,
						r: Math.max(2.2, s.r * 0.8),
						fill: w.color,
					},
					svg,
				);
			}
		}
	}

	// ------------------------------------------------------------------
	// משחק
	// ------------------------------------------------------------------
	private startGame(): void {
		this.weapon = effectivePick(
			this.plugin.settings.aliensWeapon,
			rewardTier(this.plugin),
			WEAPONS.length,
		);
		this.music.start();
		this.score = 0;
		this.runTime = 0;
		this.lives = LIVES;
		this.playerX = W / 2;
		this.targetX = null;
		this.invuln = 0;
		this.cooldown = 0;
		this.particles = [];
		this.keys.clear();
		this.menuEl.setCssStyles({ display: 'none' });
		this.gameEl.setCssStyles({ display: 'block' });
		this.startLevel(1);
	}

	private addEnemy(
		kind: EnemyKind,
		sprite: number,
		color: string,
		px: number,
		x: number,
		y: number,
		hp: number,
		points: number,
	): void {
		this.enemies.push({
			id: this.nextId++,
			kind,
			sprite,
			color,
			px,
			x,
			y,
			w: SPRITE_W * px,
			h: SPRITE_H * px,
			hp,
			maxHp: hp,
			points,
			t: Math.random() * 6,
			baseX: x,
			flash: 0,
		});
	}

	private startLevel(level: number): void {
		this.level = level;
		this.enemies = [];
		this.bullets = [];
		this.enemyBullets = [];
		this.formDir = 1;
		this.enemyFireT = 1.2;
		this.spawnT = 4;
		this.introT = INTRO_TIME;
		this.phase = 'intro';

		if (level === 3) {
			this.addEnemy('boss', 2, '#ff5252', 8, W / 2, 104, 80, 500);
		} else {
			const rows = level === 1 ? 4 : 5;
			const cols = 7;
			const gapX = 42;
			const x0 = (W - (cols - 1) * gapX) / 2;
			for (let r = 0; r < rows; r++) {
				// בשלב 2 השורות העליונות חזקות יותר
				const strong = level === 2 ? (r === 0 ? 2 : r <= 2 ? 1 : 0) : 0;
				const color = ['#b2ff59', '#40c4ff', '#ff80ab'][strong] ?? '';
				for (let c = 0; c < cols; c++) {
					this.addEnemy(
						'grid',
						strong,
						color,
						2.4,
						x0 + c * gapX,
						74 + r * 30,
						strong + 1,
						10 * (strong + 1),
					);
				}
			}
		}
		this.gridTotal = this.enemies.length;
		this.sfx.tone(392, 392, 0.1, 'sine', 0.05);
		this.sfx.tone(587, 587, 0.16, 'sine', 0.05, 0.12);
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
		for (const s of this.stars) {
			s.y += s.v * dt;
			if (s.y > H) s.y -= H;
		}
		for (const p of this.particles) {
			p.x += p.vx * dt;
			p.y += p.vy * dt;
			p.life -= dt;
		}
		this.particles = this.particles.filter((p) => p.life > 0);

		// תנועת החללית: מקלדת, או מעקב אחרי האצבע / העכבר
		const dir =
			(this.keys.has('right') ? 1 : 0) - (this.keys.has('left') ? 1 : 0);
		if (dir !== 0) this.playerX += dir * KEY_SPEED * dt;
		else if (this.targetX !== null) {
			const d = this.targetX - this.playerX;
			this.playerX += Math.sign(d) * Math.min(Math.abs(d), 520 * dt);
		}
		this.playerX = Math.max(16, Math.min(W - 16, this.playerX));
		this.invuln = Math.max(0, this.invuln - dt);

		if (this.phase === 'intro') {
			this.introT -= dt;
			if (this.introT <= 0) this.phase = 'playing';
			return;
		}

		this.runTime += dt;
		this.fire(dt);
		this.moveEnemies(dt);
		this.enemiesFire(dt);
		this.moveBullets(dt);
		this.collide();
		if (this.phase !== 'playing') return;

		const left =
			this.level === 3
				? this.enemies.some((e) => e.kind === 'boss')
				: this.enemies.some((e) => e.kind === 'grid');
		if (!left) this.levelCleared();
	}

	private fire(dt: number): void {
		this.cooldown -= dt;
		if (this.cooldown > 0) return;
		const w = WEAPONS[this.weapon];
		if (!w) return;
		this.cooldown = w.cooldown;
		for (const s of w.shots) {
			const rad = (s.deg * Math.PI) / 180;
			this.bullets.push({
				x: this.playerX + s.dx,
				y: PLAYER_Y - 16,
				vx: Math.sin(rad) * w.speed,
				vy: -Math.cos(rad) * w.speed,
				r: s.r,
				dmg: s.dmg,
				pierce: s.pierce,
				hit: new Set<number>(),
			});
		}
		this.sfx.tone(900, 300, 0.07, 'square', 0.012);
	}

	private moveEnemies(dt: number): void {
		// המערך: זז לצדדים, ובכל פעם שהוא נוגע בקיר הוא יורד שורה.
		// ככל שנשארים פחות חייזרים הוא מאיץ
		const grid = this.enemies.filter((e) => e.kind === 'grid');
		if (grid.length > 0) {
			const gone = 1 - grid.length / Math.max(1, this.gridTotal);
			const v = (14 + this.level * 8) * (1 + gone * 1.8);
			let minX = W;
			let maxX = 0;
			for (const e of grid) {
				e.x += this.formDir * v * dt;
				minX = Math.min(minX, e.x - e.w / 2);
				maxX = Math.max(maxX, e.x + e.w / 2);
			}
			if (
				(this.formDir > 0 && maxX > W - 6) ||
				(this.formDir < 0 && minX < 6)
			) {
				this.formDir = -this.formDir;
				for (const e of grid) e.y += 10;
			}
			if (grid.some((e) => e.y + e.h / 2 >= PLAYER_Y - 18)) {
				this.endGame(false);
				return;
			}
		}

		for (const e of this.enemies) {
			e.t += dt;
			e.flash = Math.max(0, e.flash - dt);
			if (e.kind === 'flyer') {
				e.y += (50 + this.level * 12) * dt;
				e.x = e.baseX + Math.sin(e.t * 2.4) * 46;
				if (e.y > H + 20) e.y = -20;
			} else if (e.kind === 'boss') {
				e.x = W / 2 + Math.sin(e.t * 0.8) * 108;
			}
		}

		// חייזרים מעופפים שמצטרפים בשלבים 2 ו-3
		if (this.level >= 2) {
			this.spawnT -= dt;
			const flyers = this.enemies.filter(
				(e) => e.kind === 'flyer',
			).length;
			if (this.spawnT <= 0 && flyers < this.level + 1) {
				this.spawnT = this.level === 3 ? 3.5 : 6;
				this.addEnemy(
					'flyer',
					0,
					'#ffab40',
					2.4,
					60 + Math.random() * (W - 120),
					-16,
					1,
					15,
				);
			}
		}
	}

	private enemyShot(x: number, y: number, deg: number, speed: number): void {
		const rad = (deg * Math.PI) / 180;
		this.enemyBullets.push({
			x,
			y,
			vx: Math.sin(rad) * speed,
			vy: Math.cos(rad) * speed,
			r: 4,
			dmg: 1,
			pierce: false,
			hit: new Set<number>(),
		});
	}

	private enemiesFire(dt: number): void {
		this.enemyFireT -= dt;
		if (this.enemyFireT > 0) return;
		const boss = this.enemies.find((e) => e.kind === 'boss');
		if (boss) {
			// ספינת האם מכוונת לחללית; מתחת לחצי חיים המטח רחב ומהיר יותר
			const rage = boss.hp < boss.maxHp / 2;
			this.enemyFireT = rage ? 0.8 : 1.15;
			const aim =
				(Math.atan2(this.playerX - boss.x, PLAYER_Y - boss.y) * 180) /
				Math.PI;
			for (const d of rage ? [-28, -14, 0, 14, 28] : [-16, 0, 16]) {
				this.enemyShot(boss.x, boss.y + boss.h / 2, aim + d, 190);
			}
			return;
		}
		const grid = this.enemies.filter((e) => e.kind === 'grid');
		const shooter = grid[Math.floor(Math.random() * grid.length)];
		this.enemyFireT = this.level === 1 ? 1.3 : 0.9;
		if (shooter) {
			this.enemyShot(
				shooter.x,
				shooter.y + shooter.h / 2,
				0,
				130 + this.level * 25,
			);
		}
	}

	private moveBullets(dt: number): void {
		const inside = (b: Bullet): boolean =>
			b.y > -12 && b.y < H + 12 && b.x > -12 && b.x < W + 12;
		for (const b of this.bullets) {
			b.x += b.vx * dt;
			b.y += b.vy * dt;
		}
		for (const b of this.enemyBullets) {
			b.x += b.vx * dt;
			b.y += b.vy * dt;
		}
		this.bullets = this.bullets.filter(inside);
		this.enemyBullets = this.enemyBullets.filter(inside);
	}

	private collide(): void {
		const dead = new Set<Bullet>();
		for (const b of this.bullets) {
			for (const e of this.enemies) {
				if (e.hp <= 0 || b.hit.has(e.id)) continue;
				if (
					Math.abs(b.x - e.x) > e.w / 2 + b.r ||
					Math.abs(b.y - e.y) > e.h / 2 + b.r
				)
					continue;
				e.hp -= b.dmg;
				e.flash = 0.08;
				b.hit.add(e.id);
				if (e.hp <= 0) this.killEnemy(e);
				if (!b.pierce) {
					dead.add(b);
					break;
				}
			}
		}
		this.bullets = this.bullets.filter((b) => !dead.has(b));
		this.enemies = this.enemies.filter((e) => e.hp > 0);

		if (this.invuln > 0) return;
		let hit = false;
		for (const b of this.enemyBullets) {
			if (
				Math.hypot(b.x - this.playerX, b.y - PLAYER_Y) <
				PLAYER_R + b.r
			) {
				hit = true;
				dead.add(b);
			}
		}
		this.enemyBullets = this.enemyBullets.filter((b) => !dead.has(b));
		for (const e of this.enemies) {
			if (
				e.kind === 'flyer' &&
				Math.abs(e.x - this.playerX) < e.w / 2 + PLAYER_R &&
				Math.abs(e.y - PLAYER_Y) < e.h / 2 + PLAYER_R
			) {
				hit = true;
				e.hp = 0;
				this.burst(e.x, e.y, e.color, 10);
			}
		}
		this.enemies = this.enemies.filter((e) => e.hp > 0);
		if (hit) this.playerHit();
	}

	private killEnemy(e: Enemy): void {
		this.score += e.points;
		this.burst(e.x, e.y, e.color, e.kind === 'boss' ? 60 : 12);
		if (e.kind === 'boss') {
			this.sfx.tone(220, 30, 0.9, 'sawtooth', 0.07);
		} else {
			this.sfx.tone(240, 50, 0.18, 'square', 0.035);
		}
	}

	private burst(x: number, y: number, color: string, n: number): void {
		for (let i = 0; i < n; i++) {
			const a = Math.random() * Math.PI * 2;
			const v = 40 + Math.random() * (n > 20 ? 220 : 110);
			this.particles.push({
				x,
				y,
				vx: Math.cos(a) * v,
				vy: Math.sin(a) * v,
				life: 0.3 + Math.random() * 0.5,
				color: i % 3 === 0 ? '#ffffff' : color,
			});
		}
	}

	private playerHit(): void {
		this.lives--;
		this.invuln = 1.6;
		this.burst(this.playerX, PLAYER_Y, '#ff5252', 18);
		this.sfx.tone(160, 60, 0.35, 'sawtooth', 0.06);
		if (this.lives <= 0) this.endGame(false);
	}

	private levelCleared(): void {
		for (const e of this.enemies) this.burst(e.x, e.y, e.color, 8);
		this.enemies = [];
		this.score += 100 * this.level;
		if (this.level >= LEVELS.length) {
			this.score += 100 * this.lives;
			this.endGame(true);
			return;
		}
		this.startLevel(this.level + 1);
	}

	// ------------------------------------------------------------------
	// ציור
	// ------------------------------------------------------------------
	private drawSprite(e: Enemy): void {
		const g = this.g;
		const rows = SPRITES[e.sprite];
		if (!g || !rows) return;
		g.fillStyle = e.flash > 0 ? '#ffffff' : e.color;
		const x0 = e.x - e.w / 2;
		// תנודה קלה למעלה ולמטה
		const y0 =
			e.y - e.h / 2 + Math.sin(e.t * 4) * (e.kind === 'boss' ? 3 : 1.5);
		rows.forEach((row, r) => {
			for (let c = 0; c < row.length; c++) {
				if (row[c] === 'X') {
					g.fillRect(
						x0 + c * e.px,
						y0 + r * e.px,
						e.px + 0.3,
						e.px + 0.3,
					);
				}
			}
		});
	}

	private drawPlayer(): void {
		const g = this.g;
		if (!g) return;
		// הבהוב בזמן החסינות שאחרי פגיעה
		if (this.invuln > 0 && Math.floor(this.invuln * 12) % 2 === 0) return;
		const x = this.playerX;
		const y = PLAYER_Y;
		const color = WEAPONS[this.weapon]?.color ?? '#80d8ff';
		g.fillStyle = '#ffab40';
		g.beginPath();
		g.moveTo(x - 5, y + 12);
		g.lineTo(x, y + 20 + Math.random() * 6);
		g.lineTo(x + 5, y + 12);
		g.fill();
		g.fillStyle = '#eceff1';
		g.beginPath();
		g.moveTo(x, y - 18);
		g.lineTo(x + 7, y + 4);
		g.lineTo(x + 16, y + 12);
		g.lineTo(x - 16, y + 12);
		g.lineTo(x - 7, y + 4);
		g.closePath();
		g.fill();
		g.fillStyle = color;
		g.fillRect(x - 16, y + 8, 6, 5);
		g.fillRect(x + 10, y + 8, 6, 5);
		g.beginPath();
		g.arc(x, y - 2, 3.5, 0, Math.PI * 2);
		g.fill();
	}

	private draw(): void {
		const g = this.g;
		if (!g) return;
		const bg = g.createLinearGradient(0, 0, 0, H);
		bg.addColorStop(0, '#050818');
		bg.addColorStop(1, '#1b0f3a');
		g.fillStyle = bg;
		g.fillRect(0, 0, W, H);
		g.fillStyle = '#ffffff';
		for (const s of this.stars) {
			g.globalAlpha = 0.3 + s.s * 0.3;
			g.fillRect(s.x, s.y, s.s, s.s);
		}
		g.globalAlpha = 1;

		for (const e of this.enemies) this.drawSprite(e);

		g.fillStyle = WEAPONS[this.weapon]?.color ?? '#80d8ff';
		for (const b of this.bullets) {
			g.beginPath();
			g.ellipse(b.x, b.y, b.r, b.r * 1.8, 0, 0, Math.PI * 2);
			g.fill();
		}
		g.fillStyle = '#ff5252';
		for (const b of this.enemyBullets) {
			g.beginPath();
			g.arc(b.x, b.y, b.r, 0, Math.PI * 2);
			g.fill();
		}
		for (const p of this.particles) {
			g.globalAlpha = Math.min(1, p.life * 2.5);
			g.fillStyle = p.color;
			g.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
		}
		g.globalAlpha = 1;

		this.drawPlayer();

		// HUD
		g.fillStyle = 'rgba(0,0,0,0.4)';
		g.fillRect(0, 0, W, 32);
		g.font = 'bold 15px sans-serif';
		g.textBaseline = 'middle';
		g.fillStyle = '#ffffff';
		g.textAlign = 'left';
		g.fillText(`★ ${this.score}`, 12, 17);
		g.textAlign = 'center';
		g.fillStyle = '#80d8ff';
		g.fillText(`L${this.level}  ⏱ ${fmtClock(this.runTime)}`, W / 2, 17);
		g.textAlign = 'right';
		g.fillStyle = '#ff5252';
		g.fillText('♥'.repeat(Math.max(0, this.lives)), W - 12, 17);
		g.font = 'bold 11px sans-serif';
		g.textAlign = 'left';
		g.fillStyle = WEAPONS[this.weapon]?.color ?? '#ffffff';
		g.fillText(WEAPONS[this.weapon]?.name ?? '', 10, H - 10);

		const boss = this.enemies.find((e) => e.kind === 'boss');
		if (boss) {
			g.fillStyle = 'rgba(0,0,0,0.5)';
			g.fillRect(40, 40, W - 80, 8);
			g.fillStyle = '#ff5252';
			g.fillRect(40, 40, (W - 80) * Math.max(0, boss.hp / boss.maxHp), 8);
		}

		if (this.phase === 'intro') {
			g.textAlign = 'center';
			g.fillStyle = '#ffffff';
			g.font = 'bold 30px sans-serif';
			g.fillText(`Level ${this.level}`, W / 2, H / 2 - 16);
			g.font = 'bold 16px sans-serif';
			g.fillStyle = '#80d8ff';
			g.fillText(LEVELS[this.level - 1] ?? '', W / 2, H / 2 + 16);
		}
	}

	// ------------------------------------------------------------------
	// סיום
	// ------------------------------------------------------------------
	private commit(countGame: boolean, time = 0): boolean {
		const d = this.plugin.blastData;
		let changed = countGame;
		if (this.score > d.aliensHigh) {
			d.aliensHigh = this.score;
			changed = true;
		}
		// הזמן נרשם רק למשחק שהושלם
		const newRecord =
			time > 0 && (d.aliensBestTime <= 0 || time < d.aliensBestTime);
		if (newRecord) {
			d.aliensBestTime = time;
			changed = true;
		}
		if (countGame) d.aliensGames += 1;
		if (changed) void this.plugin.saveBlastData();
		return newRecord;
	}

	private endGame(won: boolean): void {
		if (this.phase === 'ended') return;
		this.phase = 'ended';
		this.draw();
		const time = Math.round(this.runTime * 10) / 10;
		const prev = this.plugin.blastData.aliensBestTime;
		const newRecord = this.commit(true, won ? time : 0);
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
					? '🎉 Invasion stopped!'
					: '💥 Game over',
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
			});
		}
		box.createDiv({ text: `Score: ${this.score}` }).setCssStyles({
			opacity: '0.8',
			fontSize: '0.9em',
		});

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
		btns.createEl('button', { text: 'Weapons and music' }).onclick = () =>
			void this.showMenu();
		btns.createEl('button', { text: 'Close' }).onclick = () => this.close();
	}
}
