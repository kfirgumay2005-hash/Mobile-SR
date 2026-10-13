import type SpacedRepetitionPlugin from './main';

// ============================================================================
// Rewards - פתיחת עיצובים וכלי נשק במשחקים לפי ההתקדמות ב-review הרגיל
//
// ה"כוח" נמדד מתוך plugin.store בקריאה בלבד (המשחקים אף פעם לא כותבים אליו):
//   • completed - מספר הכרטיסים שנבדקו ועדיין לא הגיע זמנם שוב
//   • recent    - מספר הבדיקות שבוצעו ב-24 השעות האחרונות
// כל REWARD_STEP נקודות (50) פותחות דרגה. כשהמספר יורד, הדרגה
// ננעלת שוב.
// ============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

export function rewardProgress(plugin: SpacedRepetitionPlugin): number {
	const now = Date.now();
	let n = 0;
	if (plugin.settings.rewardMetric === 'recent') {
		for (const m of Object.values(plugin.store)) {
			for (const t of m.reviewHistory ?? []) {
				if (now - t < DAY_MS) n++;
			}
		}
	} else {
		for (const m of Object.values(plugin.store)) {
			if (m.due > now) n++;
		}
	}
	return n;
}

// כמה נקודות צריך לכל דרגה. קבוע, כדי שהדרגות יהיו זהות אצל כל המשתמשים
// (חשוב לטבלת השיאים המשותפת)
export const REWARD_STEP = 50;

// מפתח סודי: אם השדה unlockKey ב-data.json תואם ל-hash הזה, הכול פתוח בלי קשר
// להתקדמות (לצפייה בעיצובים). בקוד נשמר רק ה-SHA-256 של המפתח, לא המפתח עצמו
const UNLOCK_KEY_SHA256 =
	'f07c4082ade962066211c2ccc2a555fa2acba93380fbfab9ba350b5b31297fbb';
const UNLOCK_ALL_TIER = 999;

export async function checkUnlockKey(key: unknown): Promise<boolean> {
	if (typeof key !== 'string' || key === '') return false;
	try {
		const digest = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(key.trim()),
		);
		const hex = Array.from(new Uint8Array(digest))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		return hex === UNLOCK_KEY_SHA256;
	} catch {
		return false;
	}
}

export const rewardTier = (plugin: SpacedRepetitionPlugin): number =>
	plugin.unlockAll
		? UNLOCK_ALL_TIER
		: Math.floor(rewardProgress(plugin) / REWARD_STEP);

// הפריט שבשימוש בפועל: הבחירה של המשתמש אם היא פתוחה, אחרת הטוב ביותר שפתוח
// (selected שלילי = תמיד הטוב ביותר)
export const effectivePick = (
	selected: number,
	tier: number,
	count: number,
): number => {
	const max = Math.max(0, Math.min(tier, count - 1));
	return selected >= 0 && selected <= max ? selected : max;
};

export interface RewardPickerOptions {
	title: string;
	names: string[];
	get: () => number;
	set: (i: number) => void;
	draw: (cell: HTMLElement, i: number) => void;
}

// שורת בחירה: פריט i נפתח בדרגה i. פריטים נעולים מוצגים עם המספר הדרוש
export function renderRewardPicker(
	parent: HTMLElement,
	plugin: SpacedRepetitionPlugin,
	o: RewardPickerOptions,
): void {
	const wrap = parent.createDiv();
	wrap.setCssStyles({ marginBottom: '0.9em' });

	const render = (): void => {
		wrap.empty();
		const progress = rewardProgress(plugin);
		const step = REWARD_STEP;
		const tier = rewardTier(plugin);
		const sel = effectivePick(o.get(), tier, o.names.length);

		wrap.createEl('strong', { text: o.title });
		const info = wrap.createDiv();
		info.setCssStyles({
			fontSize: '0.85em',
			opacity: '0.8',
			marginBottom: '6px',
		});
		const what =
			plugin.settings.rewardMetric === 'recent'
				? 'reviews in the last 24 hours'
				: 'cards reviewed and not due';
		const next =
			tier < o.names.length - 1
				? ` Next unlock at ${(tier + 1) * step}.`
				: ' Everything is unlocked.';
		info.setText(`⭐ ${progress} ${what}.${next}`);

		const row = wrap.createDiv();
		row.setCssStyles({ display: 'flex', flexWrap: 'wrap', gap: '8px' });
		o.names.forEach((name, i) => {
			const locked = i > tier;
			const cell = row.createDiv();
			cell.setCssStyles({
				width: '78px',
				padding: '6px 4px',
				borderRadius: '8px',
				border:
					i === sel
						? '2px solid var(--interactive-accent)'
						: '2px solid var(--background-modifier-border)',
				textAlign: 'center',
				cursor: locked ? 'not-allowed' : 'pointer',
				opacity: locked ? '0.45' : '1',
			});
			const preview = cell.createDiv();
			preview.setCssStyles({
				height: '56px',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				pointerEvents: 'none',
			});
			o.draw(preview, i);
			cell.createDiv({ text: name }).setCssStyles({
				fontSize: '0.75em',
				fontWeight: 'bold',
			});
			cell.createDiv({
				text: locked
					? `🔒 ${i * step}`
					: i === sel
						? '✓ In use'
						: 'Unlocked',
			}).setCssStyles({ fontSize: '0.7em', opacity: '0.8' });
			if (!locked) {
				cell.onclick = () => {
					o.set(i);
					void plugin.saveSettings();
					render();
				};
			}
		});
	};
	render();
}
