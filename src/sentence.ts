// כרטיסי משפטים: שינון משפט ארוך מילה במילה בהסתרה הדרגתית.
// מילים מודגשות (**...**) או במרקר (==...==) הן "מילות עוגן" ולעולם לא מוסתרות.
// אין כאן שום כתיבה ל-store: הדירוג נשאר דירוג אחד רגיל ב-ReviewModal
import { shuffle } from './blast';

// שלב 0 = המשפט המלא, שלב 3 = רק מילות העוגן
export const SENTENCE_STAGES = 3;

export type SentenceToken =
	| { kind: 'text'; text: string }
	| { kind: 'br' }
	| {
			kind: 'word';
			// פיסוק לפני ואחרי המילה נשאר גלוי גם כשהמילה מוסתרת
			lead: string;
			core: string;
			trail: string;
			anchor: boolean;
			// מספר המילה במשפט (0, 1, 2...)
			w: number;
			// מיקום הליבה בטקסט המקורי של הגב (עם סימני ה-**)
			start: number;
			end: number;
	  };

export type WordToken = Extract<SentenceToken, { kind: 'word' }>;

// סימני עוגן: הדגשה ומרקר. "Make anchor" תמיד מוסיף **
const ANCHOR_MARKS = ['**', '=='];

const LETTER = /[\p{L}\p{N}]/u;
const MARK = /\p{M}/u;

// מפרק את הגב של הכרטיס למילים, רווחים ושורות
export function parseSentence(src: string): SentenceToken[] {
	// עוגן = הדגשה (**...**) או מרקר (==...==). כל סוג נספר בנפרד;
	// סימן בלי זוג (מספר אי-זוגי) לא נחשב
	const markAt = new Map<number, string>();
	for (const m of ANCHOR_MARKS) {
		const found: number[] = [];
		for (let i = src.indexOf(m); i !== -1; i = src.indexOf(m, i + 2)) {
			found.push(i);
		}
		if (found.length % 2 === 1) found.pop();
		for (const i of found) markAt.set(i, m);
	}

	const chars: { c: string; i: number; b: boolean }[] = [];
	const open = new Set<string>();
	for (let i = 0; i < src.length;) {
		const m = markAt.get(i);
		if (m) {
			if (open.has(m)) open.delete(m);
			else open.add(m);
			i += 2;
			continue;
		}
		const c = String.fromCodePoint(src.codePointAt(i) ?? 0);
		chars.push({ c, i, b: open.size > 0 });
		i += c.length;
	}

	const tokens: SentenceToken[] = [];
	let w = 0;
	let k = 0;
	while (k < chars.length) {
		const ch = chars[k];
		if (!ch) break;
		if (ch.c === '\n') {
			tokens.push({ kind: 'br' });
			k++;
			continue;
		}
		if (/\s/.test(ch.c)) {
			let text = '';
			while (k < chars.length) {
				const x = chars[k];
				if (!x || x.c === '\n' || !/\s/.test(x.c)) break;
				text += x.c;
				k++;
			}
			tokens.push({ kind: 'text', text });
			continue;
		}
		// רצף בלי רווחים: פיסוק פותח, ליבה (מהאות הראשונה עד האחרונה + ניקוד), פיסוק סוגר
		const run: typeof chars = [];
		while (k < chars.length) {
			const x = chars[k];
			if (!x || /\s/.test(x.c)) break;
			run.push(x);
			k++;
		}
		let first = run.findIndex((x) => LETTER.test(x.c));
		if (first === -1) {
			tokens.push({ kind: 'text', text: run.map((x) => x.c).join('') });
			continue;
		}
		let last = first;
		for (let j = run.length - 1; j >= first; j--) {
			if (LETTER.test(run[j]?.c ?? '')) {
				last = j;
				break;
			}
		}
		while (last + 1 < run.length && MARK.test(run[last + 1]?.c ?? '')) {
			last++;
		}
		// ניקוד שלפני האות הראשונה שייך לליבה (נדיר, אבל לא מפרקים אותו מהאות)
		while (first > 0 && MARK.test(run[first - 1]?.c ?? '')) first--;
		const coreChars = run.slice(first, last + 1);
		const firstC = coreChars[0];
		const lastC = coreChars[coreChars.length - 1];
		if (!firstC || !lastC) continue;
		tokens.push({
			kind: 'word',
			lead: run
				.slice(0, first)
				.map((x) => x.c)
				.join(''),
			core: coreChars.map((x) => x.c).join(''),
			trail: run
				.slice(last + 1)
				.map((x) => x.c)
				.join(''),
			anchor: coreChars.some((x) => x.b),
			w: w++,
			start: firstC.i,
			end: lastC.i + lastC.c.length,
		});
	}
	return tokens;
}

export const sentenceWords = (tokens: SentenceToken[]): WordToken[] =>
	tokens.filter((t): t is WordToken => t.kind === 'word');

// סדר אקראי של כל המילים (גם העוגנים). כל שלב מסתיר קטע ארוך יותר מתחילת הסדר,
// כך שמילה שהוסתרה בשלב 1 נשארת מוסתרת בשלב 2. הפיכת מילה לעוגן רק מוציאה אותה
export function randomOrder(count: number): number[] {
	return shuffle(Array.from({ length: count }, (_, i) => i));
}

export function hiddenAt(
	words: WordToken[],
	order: number[],
	stage: number,
): Set<number> {
	const anchor = new Set(words.filter((x) => x.anchor).map((x) => x.w));
	const hideable = order.filter((i) => i < words.length && !anchor.has(i));
	const n =
		stage >= SENTENCE_STAGES
			? hideable.length
			: Math.round(
					(hideable.length * Math.max(0, stage)) / SENTENCE_STAGES,
				);
	return new Set(hideable.slice(0, n));
}

// הטקסט של הגב אחרי שמילה הופכת לעוגן (עטיפה ב-** בדיוק סביב הליבה)
export function withAnchor(src: string, word: WordToken): string {
	return `${src.slice(0, word.start)}**${src.slice(word.start, word.end)}**${src.slice(word.end)}`;
}

// ---------------- השוואת המשפט שהוקלד ----------------

// השוואה סלחנית: בלי פיסוק, בלי הבדל בין אותיות גדולות לקטנות, ובלי ניקוד וטעמים
export function normWord(s: string): string {
	return s
		.normalize('NFKD')
		.replace(/[֑-ׇ]/g, '')
		.replace(/[^\p{L}\p{N}\p{M}]/gu, '')
		.toLowerCase();
}

export interface SentenceDiff {
	// מילים במשפט שלא הוקלדו (או הוקלדו אחרת)
	missing: Set<number>;
	// הטקסט שהוקלד, חלק אחרי חלק; ok = false למילה שגויה או מיותרת
	typed: { text: string; ok: boolean }[];
}

export function diffSentence(words: WordToken[], typed: string): SentenceDiff {
	const target = words.map((x) => normWord(x.core));
	const parts = typed.trim().split(/(\s+)/);
	const typedIdx: number[] = [];
	const typedNorm: string[] = [];
	parts.forEach((p, i) => {
		const n = normWord(p);
		if (n !== '') {
			typedIdx.push(i);
			typedNorm.push(n);
		}
	});

	// LCS על רשימות המילים המנורמלות
	const n = target.length;
	const m = typedNorm.length;
	const dp: Uint16Array[] = [];
	for (let i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
	for (let i = n - 1; i >= 0; i--) {
		const row = dp[i];
		const below = dp[i + 1];
		if (!row || !below) continue;
		for (let j = m - 1; j >= 0; j--) {
			row[j] =
				target[i] === typedNorm[j]
					? (below[j + 1] ?? 0) + 1
					: Math.max(below[j] ?? 0, row[j + 1] ?? 0);
		}
	}
	const missing = new Set<number>();
	const typedOk = new Set<number>();
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (target[i] === typedNorm[j]) {
			typedOk.add(j);
			i++;
			j++;
		} else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
			missing.add(i);
			i++;
		} else {
			j++;
		}
	}
	for (; i < n; i++) missing.add(i);

	const okParts = new Set<number>();
	typedIdx.forEach((p, k) => {
		if (typedOk.has(k)) okParts.add(p);
	});
	return {
		missing,
		typed: parts.map((text, p) => ({
			text,
			ok: !typedIdx.includes(p) || okParts.has(p),
		})),
	};
}

// ---------------- תצוגה ----------------

export interface SentenceView {
	// מילים שמוצגות כקו ריק
	blank?: Set<number>;
	// צד התשובה: מילים שהיו מוסתרות (מסומנות בצבע)
	wasHidden?: Set<number>;
	// מילים שסומנו כ"שכחתי"
	missed?: Set<number>;
	// הקשה על מילה (בצד התשובה)
	onTap?: (w: number) => void;
	// מצייר את המקום הריק בעצמו (שדה הקלדה) במקום קו
	makeBlank?: (parent: HTMLElement, word: WordToken) => void;
}

export const letterCount = (s: string): number =>
	Array.from(s).filter((c) => LETTER.test(c)).length;

// כל שורה היא בלוק עם dir="auto", כדי ששורה בעברית ושורה באנגלית יוצגו כל אחת בכיוון שלה
export function renderSentence(
	parent: HTMLElement,
	tokens: SentenceToken[],
	view: SentenceView,
): HTMLElement {
	const box = parent.createDiv({ cls: 'srs-sentence' });
	box.setCssStyles({ fontSize: '1.1em', lineHeight: '2.2' });
	let line = box.createDiv({ attr: { dir: 'auto' } });
	let lineStart = true;
	const newLine = (): void => {
		line = box.createDiv({ attr: { dir: 'auto' } });
		// שורה ריקה עדיין תופסת גובה
		line.setCssStyles({ minHeight: '1em' });
		lineStart = true;
	};

	for (const t of tokens) {
		if (t.kind === 'br') {
			newLine();
			continue;
		}
		if (t.kind === 'text') {
			// רווחי הזחה בתחילת שורה לא מוצגים
			if (lineStart && t.text.trim() === '') continue;
			line.appendText(t.text);
			lineStart = false;
			continue;
		}
		lineStart = false;
		if (t.lead) line.appendText(t.lead);

		if (view.blank?.has(t.w) && view.makeBlank) {
			view.makeBlank(line, t);
		} else if (view.blank?.has(t.w)) {
			const gap = line.createSpan({ cls: 'srs-sentence-blank' });
			gap.setCssStyles({
				display: 'inline-block',
				width: `${Math.max(2, letterCount(t.core)) * 0.6}em`,
				height: '1em',
				verticalAlign: '-0.15em',
				borderBottom: '2px solid var(--text-faint)',
				margin: '0 0.1em',
			});
		} else {
			const span = line.createSpan({
				text: t.core,
				cls: 'srs-sentence-word',
			});
			const styles: Partial<CSSStyleDeclaration> = {};
			if (t.anchor) {
				styles.fontWeight = 'bold';
				styles.color = 'var(--text-accent)';
			}
			if (view.wasHidden?.has(t.w)) {
				styles.backgroundColor = 'var(--text-highlight-bg)';
			}
			if (view.missed?.has(t.w)) {
				styles.color = 'var(--text-error)';
				styles.textDecoration = 'underline wavy var(--text-error)';
				styles.textUnderlineOffset = '0.25em';
			}
			if (view.onTap) {
				const tap = view.onTap;
				const w = t.w;
				// role="button": השלט מתעלם מהקשה על כפתור, אז אצבע על מילה לא נחשבת ללחיצת שלט
				span.setAttr('role', 'button');
				styles.cursor = 'pointer';
				styles.padding = '0.3em 0.15em';
				styles.borderRadius = '4px';
				span.onclick = (e) => {
					e.preventDefault();
					tap(w);
				};
			}
			span.setCssStyles(styles);
		}
		if (t.trail) line.appendText(t.trail);
	}
	return box;
}
