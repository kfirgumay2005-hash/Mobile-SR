// מדריכים אינטראקטיביים לכל תכונות התוסף (בלי המשחקים).
// כל מדריך הוא review אמיתי (ReviewModal) על כרטיסים שנוצרו בזיכרון: שום דירוג,
// עריכה או עוגן לא נשמרים, ולוח הזמנים וההתקדמות בפתיחות לא נוגעים
import { App, Modal, Notice } from 'obsidian';
import type SpacedRepetitionPlugin from './main';
import {
	FlashcardParser,
	ReviewModal,
	fixCardsText,
	type Flashcard,
	type PracticeOptions,
} from './main';
import { parseSentence, renderSentence } from './sentence';

// כרטיס של מדריך. q = השאלה (או כותרת כרטיס משפט), a = התשובה (או המשפט)
interface Lesson {
	q: string;
	a: string;
	hint?: string;
	sentence?: boolean;
	// כרטיס משפט שמוצג כאילו כבר נלמד
	reviewed?: boolean;
}

interface Tutorial {
	id: string;
	icon: string;
	name: string;
	desc: string;
	options?: Omit<PracticeOptions, 'onFinish' | 'onComplete'>;
	lessons: (plugin: SpacedRepetitionPlugin) => Lesson[];
}

const tag = (list: string[], fallback: string): string =>
	`\`${list[0] ?? fallback}\``;

function buildCards(t: Tutorial, lessons: Lesson[]): Flashcard[] {
	return lessons.map((l, i) => {
		const front = l.hint ? `${l.q}\n${l.hint}` : l.q;
		return {
			id: `tutorial-${t.id}-${i + 1}`,
			filePath: '',
			deckName: `Tutorial: ${t.name}`,
			type: 'MultiLine',
			front,
			back: l.a,
			firstLine: (l.q.split('\n')[0] ?? '').trim(),
			hint: l.hint ?? '',
			sentence: !!l.sentence,
			tutorialReviewed: l.reviewed,
			lineStart: 0,
			lineEnd: 0,
			rawContent: `${front}\n?\n${l.a}`,
		};
	});
}

const TUTORIALS: Tutorial[] = [
	{
		id: 'review',
		icon: '🃏',
		name: 'Reviewing cards',
		desc: 'Flip a card, rate it, fix a typo, and find your way around the dashboard.',
		lessons: (p) => [
			{
				q: '### Reviewing cards\nThis is the front of a card: the question. Try to recall the answer, then select **Show Answer**.\n\nNothing in these tutorials is saved. Your schedule, your notes and your unlocks are not touched.',
				a: 'This is the back: the answer.\n\nNow rate how well you knew it:\n- **Again**: you forgot it. It comes back in a few minutes.\n- **Hard**: you got it, with effort.\n- **Good**: you got it.\n- **Easy**: it took no effort at all.\n\nThe time under each button is when the card would come back. Select **Good**.',
			},
			{
				q: 'What is the largest planet in the solar system?',
				a: 'Jupiter.\n\nThe FSRS scheduler uses every rating to estimate how long you will remember a card, and brings it back just before you would forget it. Rate honestly: a **Good** you did not earn only means you see the card again too late.\n\nRate this card any way you like.',
			},
			{
				q: '### Fixing a card\nFound a mistake during a review? Select **Edit Card** at the top, change the text, then select **Save Changes**.\n\nTry it: this card says the hottest planet is *Mars*. Change it to *Venus*.\n\nThe hottest planet is Mars.',
				a: 'In a real deck the note itself is updated, and the card keeps its review history. Here the change lasts only for this tutorial.\n\nRate the card to go on.',
			},
			{
				q: `### The dashboard\nOpen it with the ribbon icon or the command **Mobile-SR: Open**. Every note with the ${tag(p.settings.flashcardTags, '#flashcards')} tag is a deck there, with its number of due cards and a **Start** button for that deck alone.\n\nShow the answer.`,
				a: 'Below the decks, **Reviewed flashcards status** lists every card you have studied with its interval, how often you reviewed it, and the time until it is due. Search it by question or by deck.\n\nThis was the last card. Rate it to finish.',
			},
		],
	},
	{
		id: 'hints',
		icon: '💡',
		name: 'Hints',
		desc: 'Keep a clue behind a button until you need it.',
		options: { hintDeck: true },
		lessons: (p) => [
			{
				q: 'What does *ephemeral* mean? Select **Show Hint** first.',
				hint: 'Think of a mayfly, which lives for a single day.',
				a: 'Lasting a very short time.\n\nThe hint stays hidden until you ask for it, and it is shown again next to the answer.',
			},
			{
				q: 'What is the opposite of *ancient*? Try it without the hint this time.',
				hint: 'It starts with M.',
				a: 'Modern.',
			},
			{
				q: 'How is a hint written?',
				hint: 'In the lines between the first line and the ? line.',
				a: `Add the ${tag(p.settings.hintTags, '#hint')} tag to a deck note, next to ${tag(p.settings.flashcardTags, '#flashcards')}. In every card of that note, the first line is the question and any lines between it and the \`?\` line are the hint:\n\n\`\`\`\n-\nephemeral\nThink of a mayfly, which lives for a single day.\n?\nLasting a very short time.\n-\n\`\`\`\n\nThe **Subtle hint button** setting shows the button as small, faded text, so it is easier to resist.`,
			},
		],
	},
	{
		id: 'reversed',
		icon: '🔁',
		name: 'Reversed cards',
		desc: 'Study one card in both directions.',
		lessons: () => [
			{
				q: '### Reversed cards\nA card written with `??` instead of `?` is studied in both directions.\n\nWhat is *library* in Spanish?',
				a: '*Biblioteca*.\n\nThe same card in the other direction comes next.',
			},
			{
				q: '*Biblioteca*',
				a: '*Library*.\n\nThis is the other direction of the card you just answered. Each direction has its own schedule, so you can know one way better than the other. In the note the card is written once:\n\n```\n-\nlibrary\n??\nbiblioteca\n-\n```',
			},
		],
	},
	{
		id: 'type',
		icon: '⌨️',
		name: 'Type before reveal',
		desc: 'Commit to an answer before you see the back.',
		options: { typeAnswer: true },
		lessons: () => [
			{
				q: '### Type before reveal\nType the answer in the field below and select **Submit**. Enter also submits; Shift+Enter starts a new line.\n\nHow many legs does a spider have?',
				a: '8.\n\nWhat you typed is shown above the answer, so you can compare. It is never saved and does not rate the card: you still choose the rating yourself.',
			},
			{
				q: 'Type the chemical symbol for gold.',
				a: 'Au.\n\nTurn this on for your decks with **Type answer before reveal** in the settings. A remote has no keyboard, so using one switches the rest of that review back to the **Show Answer** button.',
			},
		],
	},
	{
		id: 'sentences',
		icon: '📜',
		name: 'Sentence cards',
		desc: 'Learn a definition or a quote word for word as words disappear.',
		options: { fillBlanks: true },
		lessons: (p) => [
			{
				q: '### Sentence cards: a new card\nRead the sentence and say it aloud, then select **Hide more words**. Do it again at each stage until only the bold anchor words are left, then flip to see the whole sentence.\n\nEvery hidden word is a field. Type the missing words and select **Check** (or press Enter in the last field): right words turn green, wrong ones red. You can also leave the fields empty and just say the words.\n\nOn the answer side, words you typed wrong are marked as missed; tap a word to change its mark. Each missed word gets a ★ button that turns it into an anchor.',
				a: 'Ask not what your **country** can do for you, ask what **you can do** for your country.',
				sentence: true,
			},
			{
				q: '### Sentence cards: a review\nA card you have already learned opens at the last stage, with only the anchor words. Fill in the blanks, or say the whole sentence. Stuck? Select **Show more words** to bring back one stage, then flip.',
				a: '**Four score** and seven years ago our fathers brought forth on this continent,\na **new nation**, conceived in **Liberty**,\nand dedicated to the proposition that all men are **created equal**.',
				sentence: true,
				reviewed: true,
			},
			{
				q: 'How is a sentence card written?',
				a: `Add the ${tag(p.settings.sentenceTags, '#sentences')} tag to a deck note, next to ${tag(p.settings.flashcardTags, '#flashcards')}. Each card is a short title, the \`?\` line, then the full sentence, which may run over several lines. Wrap the key words in \`**bold**\` or \`==highlight==\`: they are the anchor words and are never hidden.\n\n\`\`\`\n-\nApollo 11\n?\nThat's one **small step** for a man, one **giant leap** for **mankind**.\n-\n\`\`\`\n\n- **Type into sentence blanks** in the settings turns the fields on or off.\n- With the fields off and **Type answer before reveal** on, you type the whole sentence instead. It is compared word by word, ignoring punctuation, case and vowel marks.\n- With a remote, flip moves through the stages, and **Show more words** can be bound to a button of its own.\n\nRate this card to finish.`,
			},
		],
	},
	{
		id: 'speech',
		icon: '🔊',
		name: 'Read aloud',
		desc: 'Hear the cards, for reviews with your eyes elsewhere.',
		lessons: () => [
			{
				q: '### Read aloud\nSelect the speaker button at the top of this window to turn reading on. The question is then read to you. After that, select **Show Answer**.',
				a: 'The answer is read when you flip a card. If you heard nothing, check the volume, or open the settings and select **Test** under **Read aloud**.\n\nThe speaker button is there in every review, and your choice carries over to the next one. Rate this card to go on.',
			},
			{
				q: 'A card with text in two languages is read part by part, each part with a voice for its language. With a remote, bind **Read aloud again** to a button to hear the current side once more.',
				a: 'More options are under **Read aloud** in the settings:\n- **Voice engine**: the voices built into your device, a free online voice, or Google Cloud Text-to-Speech with your own API key. Obsidian on Android has no built-in voices, so phones use online speech.\n- The voice for each language and the **Speech rate**.\n- **Read the answer**, and **Say the action**, which says what the remote did ("Good", "Skipped") before the next card.\n\nRate this card to finish.',
			},
		],
	},
];

const small = (el: HTMLElement): void =>
	el.setCssStyles({ fontSize: '0.8em', opacity: '0.7' });

export class TutorialMenuModal extends Modal {
	constructor(
		app: App,
		private plugin: SpacedRepetitionPlugin,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: '📘 Tutorials' });
		contentEl.createEl('p', {
			text: 'Each tutorial is a short practice review that you work through yourself. Nothing in them is saved: your schedule, your notes and your unlocks stay as they are.',
		});

		const back = (): void => this.plugin.openTutorials();
		const done = new Set(this.plugin.settings.tutorialsDone ?? []);
		const ids = [...TUTORIALS.map((t) => t.id), 'remote', 'playground'];
		const count = ids.filter((id) => done.has(id)).length;
		const progress = contentEl.createDiv({
			text:
				count === ids.length
					? `All ${ids.length} tutorials completed ✓`
					: `${count} of ${ids.length} completed`,
		});
		progress.setCssStyles({
			fontWeight: 'bold',
			marginBottom: '10px',
			color: count === ids.length ? 'var(--text-success)' : '',
		});

		const addRow = (
			id: string,
			icon: string,
			name: string,
			desc: string,
			start: () => void,
		): void => {
			const isDone = done.has(id);
			const row = contentEl.createDiv();
			row.setCssStyles({
				border: '1px solid var(--background-modifier-border)',
				padding: '12px',
				borderRadius: '8px',
				display: 'flex',
				justifyContent: 'space-between',
				alignItems: 'center',
				gap: '8px',
				marginBottom: '10px',
			});
			if (isDone) {
				row.setCssStyles({ borderColor: 'var(--text-success)' });
			}
			const info = row.createDiv();
			info.createEl('strong', { text: `${icon} ${name}` });
			if (isDone) {
				info.createSpan({ text: ' ✓ Completed' }).setCssStyles({
					color: 'var(--text-success)',
					fontSize: '0.85em',
					whiteSpace: 'nowrap',
				});
			}
			info.createDiv({ text: desc }).setCssStyles({
				fontSize: '0.85em',
				opacity: '0.8',
			});
			const btn = row.createEl('button', {
				text: isDone ? 'Again' : 'Start',
				cls: isDone ? '' : 'mod-cta',
			});
			btn.onclick = () => {
				this.close();
				start();
			};
		};

		for (const t of TUTORIALS) {
			addRow(t.id, t.icon, t.name, t.desc, () => {
				const cards = buildCards(t, t.lessons(this.plugin));
				new ReviewModal(this.app, this.plugin, [...cards], cards, {
					...t.options,
					onFinish: back,
					onComplete: () => this.plugin.markTutorialDone(t.id),
				}).open();
			});
		}
		addRow(
			'remote',
			'🎮',
			'Remote control',
			'Rate, skip and flip with a Bluetooth ring or page-turner remote.',
			() => this.plugin.openRemoteTutorial(back),
		);
		addRow(
			'playground',
			'✍️',
			'Write your own cards',
			'Type cards, see how the plugin reads them, tidy them up and try them out.',
			() => new CardPlaygroundModal(this.app, this.plugin).open(),
		);
		small(
			contentEl.createDiv({
				text: 'Write your own cards counts as completed after you try your cards to the end.',
			}),
		);

		if (count > 0) {
			const reset = contentEl.createEl('button', {
				text: 'Reset progress',
			});
			reset.setCssStyles({ marginTop: '8px' });
			reset.onclick = () => {
				this.plugin.settings.tutorialsDone = [];
				void this.plugin.saveSettings();
				this.onOpen();
			};
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// הטקסט במגרש נשמר בין פתיחות (עד טעינה מחדש של התוסף), כדי שאחרי תרגול אפשר להמשיך
let playgroundText: string | null = null;

// מגרש כתיבה: כותבים כרטיסים ורואים מיד איך התוסף מפרק אותם. שום דבר לא נכתב לכספת
export class CardPlaygroundModal extends Modal {
	constructor(
		app: App,
		private plugin: SpacedRepetitionPlugin,
	) {
		super(app);
	}

	private sample(): string {
		const s = this.plugin.settings;
		const deck = s.flashcardTags[0] ?? '#flashcards';
		const hint = s.hintTags[0] ?? '#hint';
		return `${deck} ${hint}\n-\nWhat is the capital of France?\n?\nParis\n-\nenigma\nSounds like a puzzle.\n?\nA mystery; something hard to understand.\n-\nlibrary\n??\nbiblioteca\n-\n`;
	}

	onOpen(): void {
		const { contentEl } = this;
		const s = this.plugin.settings;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Write your own cards' });
		contentEl.createEl('p', {
			text: 'Write or paste cards below. The preview shows how the plugin reads them. Nothing here is saved to your vault: copy the text into a note when it looks right.',
		});

		const rules = contentEl.createEl('ul');
		rules.setCssStyles({ fontSize: '0.85em' });
		for (const r of [
			`A note is a deck when it has the ${s.flashcardTags[0] ?? '#flashcards'} tag.`,
			'Every card sits between two lines that hold only a hyphen (-).',
			'A line with only ? separates the question from the answer; ?? makes a reversed card.',
			`With ${s.hintTags[0] ?? '#hint'}, the lines between the first line and the ? line are a hint.`,
			`With ${s.sentenceTags[0] ?? '#sentences'}, the answer is a sentence to learn word for word, and **bold** or ==highlighted== words are anchors.`,
		]) {
			rules.createEl('li', { text: r });
		}

		const field = contentEl.createEl('textarea', {
			attr: { dir: 'auto', rows: '12', spellcheck: 'false' },
		});
		field.value = playgroundText ?? this.sample();
		field.setCssStyles({
			display: 'block',
			width: '100%',
			fontFamily: 'var(--font-monospace)',
			resize: 'vertical',
		});

		const actions = contentEl.createDiv();
		actions.setCssStyles({
			display: 'flex',
			flexWrap: 'wrap',
			gap: '8px',
			margin: '8px 0',
		});
		const practiceBtn = actions.createEl('button', {
			text: 'Try these cards',
			cls: 'mod-cta',
		});
		const fixBtn = actions.createEl('button', {
			text: 'Fix spacing and remove duplicates',
		});
		const copyBtn = actions.createEl('button', { text: 'Copy' });
		const resetBtn = actions.createEl('button', { text: 'Start over' });

		const status = contentEl.createDiv();
		status.setCssStyles({ fontWeight: 'bold', margin: '8px 0' });
		const preview = contentEl.createDiv();

		let cards: Flashcard[] = [];
		let hintDeck = false;
		const update = (): void => {
			playgroundText = field.value;
			const content = field.value.replace(/\r\n/g, '\n');
			const flags = FlashcardParser.deckFlags(
				content,
				s.flashcardTags,
				s.hintTags,
				s.sentenceTags,
			);
			hintDeck = flags.hint;
			cards = flags.isDeck
				? FlashcardParser.parseText(
						content,
						'playground',
						'Your cards',
						flags.hint,
						flags.sentence,
					)
				: [];
			practiceBtn.disabled = cards.length === 0;

			const kinds = [
				flags.hint ? 'hint deck' : '',
				flags.sentence ? 'sentence deck' : '',
			].filter((k) => k !== '');
			status.setText(
				!flags.isDeck
					? `Not a deck yet: add the ${s.flashcardTags[0] ?? '#flashcards'} tag.`
					: `${cards.length} card${cards.length === 1 ? '' : 's'} found${kinds.length ? ` (${kinds.join(', ')})` : ''}.`,
			);
			if (flags.isDeck && cards.length === 0) {
				status.appendText(
					' Put a line with only ? between a question and its answer.',
				);
			}

			preview.empty();
			cards.forEach((c, i) => {
				const box = preview.createDiv();
				box.setCssStyles({
					border: '1px solid var(--background-modifier-border)',
					borderRadius: '8px',
					padding: '8px 12px',
					marginBottom: '8px',
				});
				// הצד ההפוך של ?? נוצר מיד אחרי הכרטיס הרגיל, מאותן שורות
				const reversedSide =
					i > 0 && cards[i - 1]?.lineStart === c.lineStart;
				box.createDiv({
					text: `Card ${i + 1}${reversedSide ? ' (reversed side)' : ''}`,
				}).setCssStyles({ fontSize: '0.8em', opacity: '0.7' });
				const part = (label: string, text: string): void => {
					const row = box.createDiv();
					row.setCssStyles({ marginTop: '4px' });
					row.createSpan({ text: `${label}: ` }).setCssStyles({
						fontWeight: 'bold',
					});
					row.createSpan({
						text,
						attr: { dir: 'auto' },
					}).setCssStyles({ whiteSpace: 'pre-wrap' });
				};
				part(
					c.sentence ? 'Title' : 'Question',
					c.hint ? c.firstLine : c.front,
				);
				if (c.hint) part('Hint', c.hint);
				if (c.sentence) {
					const row = box.createDiv();
					row.setCssStyles({ marginTop: '4px' });
					row.createSpan({
						text: 'Sentence (anchors in colour):',
					}).setCssStyles({
						fontWeight: 'bold',
					});
					renderSentence(row, parseSentence(c.back), {});
				} else {
					part('Answer', c.back);
				}
			});
		};

		field.oninput = update;
		fixBtn.onclick = () => {
			const r = fixCardsText(field.value, s.duplicateMode);
			field.value = r.text;
			update();
			new Notice(
				r.duplicatesCount > 0
					? `Spacing fixed and ${r.duplicatesCount} duplicate card(s) removed.`
					: 'Spacing fixed. No duplicates found.',
			);
		};
		copyBtn.onclick = () => {
			navigator.clipboard.writeText(field.value).then(
				() =>
					new Notice(
						'Copied. Paste it into a note to make it a deck.',
					),
				() =>
					new Notice(
						'Could not copy. Select the text and copy it yourself.',
					),
			);
		};
		resetBtn.onclick = () => {
			field.value = this.sample();
			update();
		};
		practiceBtn.onclick = () => {
			if (cards.length === 0) return;
			const practice = cards.map((c, i) => ({
				...c,
				id: `playground-${i + 1}`,
				filePath: '',
			}));
			this.close();
			new ReviewModal(this.app, this.plugin, [...practice], practice, {
				hintDeck,
				onFinish: () =>
					new CardPlaygroundModal(this.app, this.plugin).open(),
				onComplete: () => this.plugin.markTutorialDone('playground'),
			}).open();
		};
		update();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
