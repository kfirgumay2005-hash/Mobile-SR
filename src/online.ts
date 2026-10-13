import { App, Modal, Notice, requestUrl } from 'obsidian';
import type SpacedRepetitionPlugin from './main';
import { fmtClock } from './aliens';

// ============================================================================
// Online - טבלת שיאים משותפת לכל המשתמשים
//
// כבוי כברירת מחדל, ונעול עד שהמשתמש בוחר שם משתמש. שם המשתמש נרשם בשרת פעם
// אחת, הוא ייחודי ואי אפשר לשנות אותו; השם המוצג חופשי וניתן לשינוי בכל רגע.
// כשהשיתוף פעיל, בסוף כל משחק (גם משחק שנכשל בשלב הראשון) נשלחים לשרת רק:
// השם המוצג, התוצאה, שם הנשק / החרב / החללית, ומזהה אקראי שנוצר כאן. לא נשלח
// שום תוכן של כרטיסים ושום דבר מלוח הזמנים. השרת נמצא בתיקייה server/.
// תוצאה שהושגה עם המפתח הסודי (unlockAll) לא נשלחת.
// ============================================================================

// כתובת ה-Worker. ריק = הפיצ'ר מוסתר לגמרי
export const LEADERBOARD_URL: string =
	'https://mobile-sr-leaderboard.mobile-sr.workers.dev';

export type OnlineGame = 'aliens' | 'sword' | 'blast';

// תוצאה של משחק אחד. done = המשחק הושלם, ואז value הוא הזמן בשניות;
// אחרת level הוא השלב שהגיעו אליו ו-value הוא ההתקדמות (נקודות / מפלצות)
export interface GameResult {
	done: boolean;
	level: number;
	value: number;
	gear: string;
}

const GAME_TITLES: Record<OnlineGame, string> = {
	aliens: '👾 Aliens',
	sword: '⚔️ Sword',
	blast: '🚀 Blast',
};

export const USERNAME_RE = /^[a-z0-9_]{3,16}$/;

interface TopRow {
	name: string;
	username: string;
	done: boolean;
	level: number;
	value: number;
	gear: string;
}

export const onlineAvailable = (): boolean => LEADERBOARD_URL !== '';

function fmtResult(game: OnlineGame, r: TopRow): string {
	if (game === 'blast')
		return `${Math.round(r.value)} pts · level ${r.level}`;
	if (r.done) return fmtClock(r.value);
	const progress =
		game === 'aliens'
			? `${Math.round(r.value)} pts`
			: `${Math.round(r.value)} defeated`;
	return `Level ${r.level} · ${progress}`;
}

function privateId(plugin: SpacedRepetitionPlugin): string {
	let id = plugin.settings.onlineId ?? '';
	if (!/^[0-9a-f]{32}$/.test(id)) {
		const bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		id = Array.from(bytes)
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		plugin.settings.onlineId = id;
	}
	return id;
}

// רושם שם משתמש קבוע. מחזיר הודעת שגיאה, או null אם הצליח
export async function registerUsername(
	plugin: SpacedRepetitionPlugin,
	wanted: string,
): Promise<string | null> {
	const username = wanted.trim().toLowerCase();
	if (!USERNAME_RE.test(username))
		return 'A username is 3 to 16 characters: a-z, 0-9 and underscore.';
	const id = privateId(plugin);
	// המזהה נשמר לפני הרישום: בלעדיו אי אפשר להוכיח בעלות על השם
	await plugin.saveSettings();
	try {
		const res = await requestUrl({
			url: `${LEADERBOARD_URL}/register`,
			method: 'POST',
			contentType: 'application/json',
			body: JSON.stringify({ id, username }),
			throw: false,
		});
		const data = res.json as { username?: string; error?: string };
		if (res.status !== 200 || typeof data.username !== 'string')
			return data.error ?? 'The server did not accept this username.';
		plugin.settings.onlineUsername = data.username;
		if ((plugin.settings.onlineName ?? '').trim() === '')
			plugin.settings.onlineName = data.username;
		await plugin.saveSettings();
		return null;
	} catch {
		return 'Could not reach the leaderboard. Check your connection and try again.';
	}
}

// שולח תוצאה אם השיתוף פעיל. שגיאות רשת לא מפריעות למשחק
export async function submitScore(
	plugin: SpacedRepetitionPlugin,
	game: OnlineGame,
	result: GameResult,
): Promise<void> {
	const s = plugin.settings;
	if (!onlineAvailable() || !s.onlineShare || !s.onlineUsername) return;
	// המשתמש ביקש לשתף: אם התוצאה לא נשלחת, אומרים לו למה
	if (plugin.unlockAll) {
		new Notice(
			'Result not shared: the unlock key in data.json is active, so everything is unlocked.',
		);
		return;
	}
	try {
		const res = await requestUrl({
			url: `${LEADERBOARD_URL}/score`,
			method: 'POST',
			contentType: 'application/json',
			body: JSON.stringify({
				game,
				id: privateId(plugin),
				name: (s.onlineName ?? '').trim() || s.onlineUsername,
				done: result.done,
				level: result.level,
				value: result.value,
				gear: result.gear,
			}),
			throw: false,
		});
		if (res.status === 200) {
			const data = res.json as { improved?: boolean };
			new Notice(
				data.improved
					? 'Your result is on the leaderboard.'
					: 'Result sent. Your best on the leaderboard is still better.',
			);
		} else if (res.status !== 429) {
			new Notice('The leaderboard did not accept this result.');
		}
	} catch (err) {
		console.warn('Could not submit the score:', err);
		new Notice('Could not reach the leaderboard.');
	}
}

async function fetchTop(game: OnlineGame): Promise<TopRow[]> {
	const res = await requestUrl({
		url: `${LEADERBOARD_URL}/top?game=${game}`,
		throw: false,
	});
	if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
	const data = res.json as { top?: unknown };
	if (!Array.isArray(data.top)) return [];
	const rows: TopRow[] = [];
	for (const r of data.top as Record<string, unknown>[]) {
		if (typeof r.name !== 'string' || typeof r.value !== 'number') continue;
		rows.push({
			name: r.name,
			username: typeof r.username === 'string' ? r.username : '',
			done: r.done === 1 || r.done === true,
			level: typeof r.level === 'number' ? r.level : 1,
			value: r.value,
			gear: typeof r.gear === 'string' ? r.gear : '',
		});
	}
	return rows;
}

class LeaderboardModal extends Modal {
	private plugin: SpacedRepetitionPlugin;
	private game: OnlineGame;

	constructor(app: App, plugin: SpacedRepetitionPlugin, game: OnlineGame) {
		super(app);
		this.plugin = plugin;
		this.game = game;
	}

	onOpen(): void {
		void this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async render(): Promise<void> {
		const c = this.contentEl;
		c.empty();
		c.createEl('h2', { text: `${GAME_TITLES[this.game]} leaderboard` });
		const status = c.createEl('p', { text: 'Loading…' });

		let rows: TopRow[];
		try {
			rows = await fetchTop(this.game);
		} catch {
			status.setText(
				'Could not load the leaderboard. Check your connection and try again.',
			);
			return;
		}
		if (rows.length === 0) {
			status.setText('No results yet. Be the first!');
		} else {
			status.remove();
			this.renderTable(c, rows);
		}

		const s = this.plugin.settings;
		if (!s.onlineUsername || !s.onlineShare) {
			c.createEl('p', {
				text: s.onlineUsername
					? 'Your own results are not shared. To appear here, turn on sharing in the plugin settings.'
					: 'Your own results are not shared. To appear here, choose a username in the plugin settings and turn on sharing.',
			}).setCssStyles({ fontSize: '0.85em', opacity: '0.8' });
		}
	}

	private renderTable(parent: HTMLElement, rows: TopRow[]): void {
		const mine = this.plugin.settings.onlineUsername ?? '';
		const table = parent.createEl('table');
		table.setCssStyles({ width: '100%', borderCollapse: 'collapse' });
		rows.forEach((r, i) => {
			const tr = table.createEl('tr');
			tr.setCssStyles({
				borderBottom: '1px solid var(--background-modifier-border)',
				fontWeight: mine !== '' && r.username === mine ? 'bold' : '',
			});
			const cell = (align: string, text = ''): HTMLElement => {
				const td = tr.createEl('td', { text });
				td.setCssStyles({ padding: '6px 4px', textAlign: align });
				return td;
			};
			cell('center', ['🥇', '🥈', '🥉'][i] ?? String(i + 1));
			// השם המוצג באלמנט משלו: יכול להיות בכל שפה וכיוון
			const who = cell('start');
			who.createDiv({ text: r.name }).setAttr('dir', 'auto');
			who.createDiv({ text: `@${r.username}` }).setCssStyles({
				opacity: '0.6',
				fontSize: '0.8em',
			});
			cell('start', r.gear).setCssStyles({
				opacity: '0.7',
				fontSize: '0.85em',
			});
			cell('end', fmtResult(this.game, r)).setCssStyles({
				fontVariantNumeric: 'tabular-nums',
			});
		});
	}
}

// לחצן שפותח את הטבלה, לתפריט של משחק. לא מוצג אם אין שרת מוגדר
export function renderLeaderboardButton(
	parent: HTMLElement,
	plugin: SpacedRepetitionPlugin,
	game: OnlineGame,
): void {
	if (!onlineAvailable()) return;
	const btn = parent.createEl('button', { text: '🌍 Leaderboard' });
	btn.setCssStyles({ marginBottom: '0.9em' });
	btn.onclick = () => new LeaderboardModal(plugin.app, plugin, game).open();
}
