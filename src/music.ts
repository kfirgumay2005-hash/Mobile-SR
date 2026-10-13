import { Notice, TFile, TFolder, normalizePath } from 'obsidian';
import type SpacedRepetitionPlugin from './main';

// ============================================================================
// Music - מוזיקת רקע למשחקים
//
// לכל משחק יש רשימת השמעה משלו:
//   • קבצי קול שהמשתמש הוסיף (נשמרים בכספת, בתיקייה game-music/<משחק>
//     שליד blast-data.md, כך שהם מסתנכרנים לטלפון כמו כל קובץ אחר).
//   • מנגינות אלקטרוניות מובנות. הן מנוגנות בסינתוז (WebAudio) ולא מקובץ,
//     ולכן אין עליהן זכויות יוצרים והן לא מגדילות את התוסף.
// הנגן בוחר קטע אקראי, וכשהוא מסתיים בוחר את הבא.
// ============================================================================

export type GameId = 'blast' | 'match' | 'hangman' | 'aliens' | 'sword';

export interface GameMusicConfig {
	on: boolean;
	builtin: string[];
}

const AUDIO_EXT = [
	'mp3',
	'm4a',
	'aac',
	'ogg',
	'oga',
	'opus',
	'wav',
	'flac',
	'webm',
];

function newAudioContext(): AudioContext | null {
	const w = window as unknown as {
		AudioContext?: typeof AudioContext;
		webkitAudioContext?: typeof AudioContext;
	};
	const Ctor = w.AudioContext ?? w.webkitAudioContext;
	if (!Ctor) return null;
	try {
		return new Ctor();
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// מנגינות מובנות
// ---------------------------------------------------------------------------

// כל תבנית היא 16 צעדים (תיבה אחת). בתופים x = מכה; בבס ובליד כל תו הוא
// דרגה בסולם (בבסיס 36) ביחס לאקורד של התיבה, ונקודה היא שתיקה.
interface TrackDef {
	id: string;
	name: string;
	bpm: number;
	root: number; // MIDI
	scale: number[];
	prog: number[]; // דרגת האקורד בכל תיבה
	bars: number;
	kick: string;
	snare: string;
	hat: string;
	bass: string;
	leadA: string;
	leadB: string;
	bassWave: OscillatorType;
	leadWave: OscillatorType;
}

const MINOR = [0, 2, 3, 5, 7, 8, 10];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const DORIAN = [0, 2, 3, 5, 7, 9, 10];

export const BUILTIN_TRACKS: TrackDef[] = [
	{
		id: 'neon',
		name: 'Neon Drive',
		bpm: 124,
		root: 45,
		scale: MINOR,
		prog: [0, 5, 3, 4],
		bars: 32,
		kick: 'x...x...x...x...',
		snare: '....x.......x...',
		hat: '..x...x...x...x.',
		bass: '0.00.0.00.00.0.7',
		leadA: '0.2.4.7.4.2.4.7.',
		leadB: '7.4.2.4.9.7.4.2.',
		bassWave: 'sawtooth',
		leadWave: 'square',
	},
	{
		id: 'pixel',
		name: 'Pixel Rush',
		bpm: 144,
		root: 48,
		scale: MAJOR,
		prog: [0, 4, 5, 3],
		bars: 36,
		kick: 'x.....x.x.....x.',
		snare: '....x.......x..x',
		hat: 'x.x.x.x.x.x.x.x.',
		bass: '0...7...0...7.4.',
		leadA: '0247420.4.7.9.7.',
		leadB: '79b97420.2.4.2.0',
		bassWave: 'square',
		leadWave: 'square',
	},
	{
		id: 'orbit',
		name: 'Deep Orbit',
		bpm: 96,
		root: 38,
		scale: DORIAN,
		prog: [0, 0, 3, 4],
		bars: 24,
		kick: 'x.........x.....',
		snare: '........x.......',
		hat: '....x.......x.x.',
		bass: '0.......0.....4.',
		leadA: '0...4...2...7...',
		leadB: '4...7...9...4.2.',
		bassWave: 'sine',
		leadWave: 'triangle',
	},
	{
		id: 'laser',
		name: 'Laser Grid',
		bpm: 132,
		root: 40,
		scale: MINOR,
		prog: [0, 0, 5, 6],
		bars: 32,
		kick: 'x...x...x...x.x.',
		snare: '....x.......x...',
		hat: 'x.xxx.xxx.xxx.xx',
		bass: '..0.0.0...0.0.07',
		leadA: '0..0..2.0..0..4.',
		leadB: '7..7..4.7..7..9.',
		bassWave: 'sawtooth',
		leadWave: 'sawtooth',
	},
];

const midiHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

// סיקוונסר קטן: מתזמן צעדים מעט קדימה, ומודיע כשהקטע נגמר
class SynthTrack {
	private ctx: AudioContext;
	private def: TrackDef;
	private onEnd: () => void;
	private out: GainNode;
	private leadBus: GainNode;
	private noiseBuf: AudioBuffer;
	private timer = 0;
	private endTimer = 0;
	private step = 0;
	private nextT = 0;
	private stepDur: number;

	constructor(
		ctx: AudioContext,
		def: TrackDef,
		volume: number,
		onEnd: () => void,
	) {
		this.ctx = ctx;
		this.def = def;
		this.onEnd = onEnd;
		this.stepDur = 60 / def.bpm / 4;

		this.out = ctx.createGain();
		this.out.connect(ctx.destination);
		this.setVolume(volume);

		// הליד עובר גם דרך הד קצר
		this.leadBus = ctx.createGain();
		this.leadBus.connect(this.out);
		const delay = ctx.createDelay(1);
		delay.delayTime.value = this.stepDur * 3;
		const fb = ctx.createGain();
		fb.gain.value = 0.35;
		const wet = ctx.createGain();
		wet.gain.value = 0.3;
		this.leadBus.connect(delay);
		delay.connect(fb);
		fb.connect(delay);
		delay.connect(wet);
		wet.connect(this.out);

		const len = Math.floor(ctx.sampleRate * 0.3);
		this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
		const data = this.noiseBuf.getChannelData(0);
		for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
	}

	setVolume(volume: number): void {
		this.out.gain.value = volume * 0.6;
	}

	start(): void {
		this.nextT = this.ctx.currentTime + 0.1;
		this.timer = window.setInterval(() => this.schedule(), 50);
	}

	stop(): void {
		window.clearInterval(this.timer);
		window.clearTimeout(this.endTimer);
		this.timer = 0;
		// מנתק גם צלילים שכבר תוזמנו
		this.out.disconnect();
	}

	private schedule(): void {
		const total = this.def.bars * 16;
		while (this.nextT < this.ctx.currentTime + 0.2) {
			if (this.step >= total) {
				window.clearInterval(this.timer);
				this.timer = 0;
				const wait = (this.nextT - this.ctx.currentTime) * 1000 + 400;
				this.endTimer = window.setTimeout(this.onEnd, wait);
				return;
			}
			this.playStep(this.step, this.nextT);
			this.nextT += this.stepDur;
			this.step++;
		}
	}

	private degHz(deg: number, octave: number): number {
		const d = this.def;
		const n = d.scale.length;
		const semi = (d.scale[deg % n] ?? 0) + 12 * Math.floor(deg / n);
		return midiHz(d.root + semi + 12 * octave);
	}

	private playStep(i: number, t: number): void {
		const d = this.def;
		const bar = Math.floor(i / 16);
		const s = i % 16;
		const chord = d.prog[bar % d.prog.length] ?? 0;
		// הכלים נכנסים בהדרגה, ובסוף התופים יוצאים
		const outro = bar >= d.bars - 2;

		if (bar >= 1 && !outro && d.kick[s] === 'x') this.kick(t);
		if (bar >= 4 && !outro && d.snare[s] === 'x')
			this.noise(t, 0.13, 0.25, 1500);
		if (bar >= 2 && !outro && d.hat[s] === 'x')
			this.noise(t, 0.04, 0.1, 7000);

		const b = d.bass[s];
		if (b !== undefined && b !== '.') {
			this.voice(
				this.out,
				d.bassWave,
				this.degHz(chord + parseInt(b, 36), 0),
				t,
				this.stepDur * 1.6,
				0.28,
				700,
			);
		}
		if (bar >= 2) {
			const pat = Math.floor(bar / 4) % 2 === 1 ? d.leadB : d.leadA;
			const l = pat[s];
			if (l !== undefined && l !== '.') {
				this.voice(
					this.leadBus,
					d.leadWave,
					this.degHz(chord + parseInt(l, 36), 2),
					t,
					this.stepDur * 1.8,
					0.1,
					2600,
				);
			}
		}
	}

	private voice(
		dest: AudioNode,
		type: OscillatorType,
		hz: number,
		t: number,
		dur: number,
		vol: number,
		cutoff: number,
	): void {
		const osc = this.ctx.createOscillator();
		const filter = this.ctx.createBiquadFilter();
		const gain = this.ctx.createGain();
		osc.type = type;
		osc.frequency.setValueAtTime(hz, t);
		filter.type = 'lowpass';
		filter.frequency.value = cutoff;
		gain.gain.setValueAtTime(0.0001, t);
		gain.gain.linearRampToValueAtTime(vol, t + 0.006);
		gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
		osc.connect(filter);
		filter.connect(gain);
		gain.connect(dest);
		osc.start(t);
		osc.stop(t + dur + 0.02);
	}

	private kick(t: number): void {
		const osc = this.ctx.createOscillator();
		const gain = this.ctx.createGain();
		osc.frequency.setValueAtTime(150, t);
		osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
		gain.gain.setValueAtTime(0.8, t);
		gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
		osc.connect(gain);
		gain.connect(this.out);
		osc.start(t);
		osc.stop(t + 0.25);
	}

	private noise(t: number, dur: number, vol: number, highpass: number): void {
		const src = this.ctx.createBufferSource();
		const filter = this.ctx.createBiquadFilter();
		const gain = this.ctx.createGain();
		src.buffer = this.noiseBuf;
		filter.type = 'highpass';
		filter.frequency.value = highpass;
		gain.gain.setValueAtTime(vol, t);
		gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
		src.connect(filter);
		filter.connect(gain);
		gain.connect(this.out);
		src.start(t);
		src.stop(t + dur + 0.02);
	}
}

// ---------------------------------------------------------------------------
// הגדרות וקבצים
// ---------------------------------------------------------------------------

export function musicConfig(
	plugin: SpacedRepetitionPlugin,
	game: GameId,
): GameMusicConfig {
	const all = plugin.settings.gameMusic ?? (plugin.settings.gameMusic = {});
	let c = all[game];
	if (!c || !Array.isArray(c.builtin)) {
		c = { on: true, builtin: BUILTIN_TRACKS.map((t) => t.id) };
		all[game] = c;
	}
	return c;
}

export function listMusicFiles(
	plugin: SpacedRepetitionPlugin,
	game: GameId,
): TFile[] {
	const folder = plugin.app.vault.getAbstractFileByPath(
		plugin.getGameMusicFolder(game),
	);
	if (!(folder instanceof TFolder)) return [];
	const files: TFile[] = [];
	for (const f of folder.children) {
		if (f instanceof TFile && AUDIO_EXT.includes(f.extension.toLowerCase()))
			files.push(f);
	}
	return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function importMusicFiles(
	plugin: SpacedRepetitionPlugin,
	game: GameId,
	picked: File[],
): Promise<number> {
	const folder = plugin.getGameMusicFolder(game);
	await plugin.ensureFolderExists(folder);
	let added = 0;
	for (const f of picked) {
		const clean =
			f.name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'track.mp3';
		const dot = clean.lastIndexOf('.');
		const base = dot > 0 ? clean.substring(0, dot) : clean;
		const ext = dot > 0 ? clean.substring(dot + 1) : 'mp3';
		if (!AUDIO_EXT.includes(ext.toLowerCase())) continue;
		let path = normalizePath(`${folder}/${base}.${ext}`);
		for (let n = 2; plugin.app.vault.getAbstractFileByPath(path); n++) {
			path = normalizePath(`${folder}/${base} (${n}).${ext}`);
		}
		try {
			await plugin.app.vault.createBinary(path, await f.arrayBuffer());
			added++;
		} catch (err) {
			console.error('Could not add music file:', err);
		}
	}
	return added;
}

// ---------------------------------------------------------------------------
// הנגן
// ---------------------------------------------------------------------------

type MusicMode = 'off' | 'playlist' | 'preview';

export class GameMusic {
	private plugin: SpacedRepetitionPlugin;
	private game: GameId;
	private ctx: AudioContext | null = null;
	private synth: SynthTrack | null = null;
	private audio: HTMLAudioElement | null = null;
	private mode: MusicMode = 'off';
	private gen = 0; // משתנה בכל עצירה, כדי להתעלם מאירועים של קטע קודם
	private lastKey = '';
	private previewKey = '';
	private errors = 0;
	onPreviewChange: (() => void) | null = null;

	constructor(plugin: SpacedRepetitionPlugin, game: GameId) {
		this.plugin = plugin;
		this.game = game;
	}

	// מתחיל את רשימת ההשמעה (צריך להיקרא מתוך לחיצה של המשתמש)
	start(): void {
		if (this.mode === 'playlist') return;
		this.halt();
		if (!musicConfig(this.plugin, this.game).on) return;
		this.mode = 'playlist';
		this.errors = 0;
		this.next();
	}

	stop(): void {
		this.halt();
		if (this.ctx) {
			void this.ctx.close();
			this.ctx = null;
		}
	}

	// השמעה לדוגמה של קטע אחד; לחיצה נוספת על אותו קטע עוצרת
	preview(key: string): void {
		const same = this.mode === 'preview' && this.previewKey === key;
		this.halt();
		if (!same) {
			this.mode = 'preview';
			this.previewKey = key;
			this.play(key, () => this.halt());
		}
		this.onPreviewChange?.();
	}

	isPreviewing(key: string): boolean {
		return this.mode === 'preview' && this.previewKey === key;
	}

	applyVolume(): void {
		const v = this.volume();
		if (this.audio) this.audio.volume = v;
		this.synth?.setVolume(v);
	}

	private volume(): number {
		const v = this.plugin.settings.musicVolume;
		return typeof v === 'number' ? Math.max(0, Math.min(1, v)) : 0.5;
	}

	private halt(): void {
		this.gen++;
		const wasPreview = this.mode === 'preview';
		this.mode = 'off';
		this.previewKey = '';
		this.synth?.stop();
		this.synth = null;
		if (this.audio) {
			this.audio.onended = null;
			this.audio.onerror = null;
			this.audio.pause();
			this.audio = null;
		}
		if (wasPreview) this.onPreviewChange?.();
	}

	private keys(): string[] {
		const cfg = musicConfig(this.plugin, this.game);
		const keys = BUILTIN_TRACKS.filter((t) =>
			cfg.builtin.includes(t.id),
		).map((t) => `b:${t.id}`);
		for (const f of listMusicFiles(this.plugin, this.game))
			keys.push(`f:${f.path}`);
		return keys;
	}

	private next(): void {
		if (this.mode !== 'playlist') return;
		const keys = this.keys();
		if (keys.length === 0) {
			this.mode = 'off';
			return;
		}
		// לא חוזרים על אותו קטע פעמיים ברצף אם יש עוד קטעים
		const pool =
			keys.length > 1 ? keys.filter((k) => k !== this.lastKey) : keys;
		const key = pool[Math.floor(Math.random() * pool.length)] ?? '';
		this.lastKey = key;
		this.play(key, () => this.next());
	}

	private play(key: string, onEnd: () => void): void {
		const gen = this.gen;
		const done = (): void => {
			if (gen !== this.gen) return;
			this.errors = 0;
			onEnd();
		};
		const fail = (): void => {
			if (gen !== this.gen) return;
			// קובץ שלא מתנגן: עוברים הלאה, אבל לא בלולאה אינסופית
			if (++this.errors > 5) this.halt();
			else window.setTimeout(() => gen === this.gen && onEnd(), 250);
		};

		if (key.startsWith('b:')) {
			const def = BUILTIN_TRACKS.find((t) => t.id === key.substring(2));
			if (!this.ctx) this.ctx = newAudioContext();
			if (!def || !this.ctx) {
				fail();
				return;
			}
			if (this.ctx.state === 'suspended') void this.ctx.resume();
			this.synth = new SynthTrack(this.ctx, def, this.volume(), done);
			this.synth.start();
			return;
		}

		const file = this.plugin.app.vault.getAbstractFileByPath(
			key.substring(2),
		);
		if (!(file instanceof TFile)) {
			fail();
			return;
		}
		const audio = new Audio(this.plugin.app.vault.getResourcePath(file));
		audio.volume = this.volume();
		audio.onended = done;
		audio.onerror = fail;
		this.audio = audio;
		audio.play().catch(() => undefined);
	}
}

// ---------------------------------------------------------------------------
// אפקטים קוליים קצרים (למשחקים שאין להם מנגנון משלהם)
// ---------------------------------------------------------------------------

export class Sfx {
	private plugin: SpacedRepetitionPlugin;
	private ctx: AudioContext | null = null;

	constructor(plugin: SpacedRepetitionPlugin) {
		this.plugin = plugin;
	}

	tone(
		f0: number,
		f1: number,
		dur: number,
		type: OscillatorType,
		vol: number,
		delay = 0,
	): void {
		if (!this.plugin.settings.blastSound) return;
		if (!this.ctx) this.ctx = newAudioContext();
		const ctx = this.ctx;
		if (!ctx) return;
		if (ctx.state === 'suspended') void ctx.resume();
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

	close(): void {
		if (this.ctx) void this.ctx.close();
		this.ctx = null;
	}
}

// ---------------------------------------------------------------------------
// חלונית המוזיקה שבתפריט של כל משחק
// ---------------------------------------------------------------------------

export function renderMusicPanel(
	parent: HTMLElement,
	plugin: SpacedRepetitionPlugin,
	game: GameId,
	music: GameMusic,
): void {
	const details = parent.createEl('details');
	details.setCssStyles({
		border: '1px solid var(--background-modifier-border)',
		borderRadius: '8px',
		padding: '8px 12px',
		marginBottom: '0.9em',
	});
	details.createEl('summary', { text: '🎵 Music' }).setCssStyles({
		cursor: 'pointer',
		fontWeight: 'bold',
	});
	const body = details.createDiv();
	body.setCssStyles({ marginTop: '8px' });

	const save = (): void => void plugin.saveSettings();
	const rowStyle = {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		marginBottom: '4px',
	};

	const render = (): void => {
		body.empty();
		const cfg = musicConfig(plugin, game);

		const onLabel = body.createEl('label');
		onLabel.setCssStyles(rowStyle);
		const onCb = onLabel.createEl('input', { type: 'checkbox' });
		onCb.checked = cfg.on;
		onLabel.appendText('Play music in this game');
		onCb.onchange = () => {
			cfg.on = onCb.checked;
			save();
		};

		const volRow = body.createDiv();
		volRow.setCssStyles(rowStyle);
		volRow.createSpan({ text: 'Volume (all games)' });
		const vol = volRow.createEl('input', { type: 'range' });
		vol.min = '0';
		vol.max = '1';
		vol.step = '0.05';
		vol.value = String(plugin.settings.musicVolume);
		vol.setCssStyles({ flex: '1', minWidth: '80px' });
		vol.oninput = () => {
			plugin.settings.musicVolume = parseFloat(vol.value);
			music.applyVolume();
		};
		vol.onchange = save;

		const previewBtn = (row: HTMLElement, key: string): void => {
			const btn = row.createEl('button', {
				text: music.isPreviewing(key) ? '⏹' : '▶',
			});
			btn.setCssStyles({ padding: '0 8px' });
			btn.onclick = () => music.preview(key);
		};

		body.createEl('strong', { text: 'Built-in tracks' });
		for (const t of BUILTIN_TRACKS) {
			const row = body.createDiv();
			row.setCssStyles(rowStyle);
			const label = row.createEl('label');
			label.setCssStyles({ flex: '1' });
			const cb = label.createEl('input', { type: 'checkbox' });
			cb.checked = cfg.builtin.includes(t.id);
			label.appendText(` ${t.name}`);
			cb.onchange = () => {
				cfg.builtin = cfg.builtin.filter((id) => id !== t.id);
				if (cb.checked) cfg.builtin.push(t.id);
				save();
			};
			previewBtn(row, `b:${t.id}`);
		}

		body.createEl('strong', { text: 'Your files' });
		const files = listMusicFiles(plugin, game);
		if (files.length === 0) {
			body.createDiv({ text: 'No files added yet.' }).setCssStyles({
				fontSize: '0.85em',
				opacity: '0.8',
			});
		}
		for (const f of files) {
			const row = body.createDiv();
			row.setCssStyles(rowStyle);
			// שם הקובץ באלמנט משלו (יכול להיות בעברית)
			const name = row.createDiv({ text: f.name });
			name.setAttr('dir', 'auto');
			name.setCssStyles({ flex: '1', overflowWrap: 'anywhere' });
			previewBtn(row, `f:${f.path}`);
			const del = row.createEl('button', { text: '🗑' });
			del.setCssStyles({ padding: '0 8px' });
			del.onclick = async () => {
				if (music.isPreviewing(`f:${f.path}`))
					music.preview(`f:${f.path}`);
				await plugin.app.fileManager.trashFile(f);
				render();
			};
		}

		const input = body.createEl('input', { type: 'file' });
		input.accept = 'audio/*,.mp3';
		input.multiple = true;
		input.setCssStyles({ display: 'none' });
		const addBtn = body.createEl('button', { text: '➕ Add audio files' });
		addBtn.setCssStyles({ marginTop: '6px' });
		addBtn.onclick = () => input.click();
		input.onchange = async () => {
			const picked = Array.from(input.files ?? []);
			if (picked.length === 0) return;
			addBtn.disabled = true;
			const added = await importMusicFiles(plugin, game, picked);
			new Notice(
				added === picked.length
					? `Added ${added} audio file(s).`
					: `Added ${added} of ${picked.length} files. The rest are not audio files or could not be saved.`,
			);
			render();
		};

		const note = body.createDiv();
		note.setCssStyles({
			fontSize: '0.8em',
			opacity: '0.7',
			marginTop: '6px',
		});
		note.appendText(
			'Tracks play in random order, one after another. Your files are kept in the vault folder: ',
		);
		note.createSpan({ text: plugin.getGameMusicFolder(game) }).setAttr(
			'dir',
			'auto',
		);
	};

	music.onPreviewChange = render;
	render();
}
