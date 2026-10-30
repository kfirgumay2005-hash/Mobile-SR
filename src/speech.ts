import {
	Notice,
	Setting,
	base64ToArrayBuffer,
	requestUrl,
	type RequestUrlResponse,
} from 'obsidian';
import type SpacedRepetitionPlugin from './main';
import type { SpacedRepetitionSettings } from './settings';
import { stripMd } from './blast';

// הקראה בקול: מנוע הדיבור של המכשיר (Web Speech API), או דיבור מקוון כשאין למכשיר
// מנוע - ב-Obsidian לאנדרואיד אין speechSynthesis בכלל
export type SpeechLang = 'he' | 'en';
export type SpeechEngine = 'auto' | 'device' | 'online' | 'cloud';
// המנוע שבפועל מקריא (auto נפתר לאחד מהם)
type EngineKind = 'device' | 'online' | 'cloud';

const LANG_TAG: Record<SpeechLang, string> = { he: 'he-IL', en: 'en-US' };
// מנועי הדיבור קוטעים משפטים ארוכים (והשירות המקוון מקבל עד 200 תווים), לכן מחלקים
const MAX_CHUNK = 180;

// דיבור מקוון: השירות של Google Translate. בלי מפתח, מחזיר mp3
const ONLINE_URL = 'https://translate.google.com/translate_tts';
const ONLINE_LANG: Record<SpeechLang, string> = { he: 'iw', en: 'en' };
// Google Cloud Text-to-Speech: API רשמי עם מפתח. מחזיר mp3 ב-base64
const CLOUD_URL = 'https://texttospeech.googleapis.com/v1';
const CLOUD_LANG: Record<SpeechLang, string> = { he: 'he-IL', en: 'en-US' };
// כמה קטעי שמע שמורים בזיכרון (להקראה חוזרת ולהורדה מראש)
const CACHE_MAX = 80;

const HEBREW = /[֐-׿יִ-ﭏ]/;
const LATIN = /[A-Za-zÀ-ɏ]/;

export function speechAvailable(): boolean {
	return (
		typeof window.speechSynthesis !== 'undefined' &&
		typeof window.SpeechSynthesisUtterance !== 'undefined'
	);
}

export function voicesFor(lang: SpeechLang): SpeechSynthesisVoice[] {
	if (!speechAvailable()) return [];
	// באנדרואיד עברית מופיעה לפעמים בקוד הישן iw
	const codes = lang === 'he' ? ['he', 'iw'] : ['en'];
	return window.speechSynthesis
		.getVoices()
		.filter((v) => codes.some((c) => v.lang.toLowerCase().startsWith(c)));
}

// טקסט כרטיס (Markdown) לטקסט להקראה
export function speechText(md: string): string {
	return md
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.split('\n')
		.map((l) => stripMd(l.replace(/\|/g, ' ')).replace(/[*_]/g, ''))
		.filter((l) => l !== '')
		.join('. ');
}

// מחלק את הטקסט לרצפים של עברית ואנגלית. סימנים בלי שפה (רווח, ספרות, פיסוק)
// נשארים ברצף הנוכחי
export function splitByLanguage(
	text: string,
): { lang: SpeechLang; text: string }[] {
	const first = text.match(/[֐-׿יִ-ﭏA-Za-zÀ-ɏ]/);
	let cur: SpeechLang = first && LATIN.test(first[0]) ? 'en' : 'he';
	const out: { lang: SpeechLang; text: string }[] = [];
	let buf = '';
	for (const ch of text) {
		const lang: SpeechLang | null = HEBREW.test(ch)
			? 'he'
			: LATIN.test(ch)
				? 'en'
				: null;
		if (lang && lang !== cur) {
			if (buf.trim()) out.push({ lang: cur, text: buf.trim() });
			buf = '';
			cur = lang;
		}
		buf += ch;
	}
	if (buf.trim()) out.push({ lang: cur, text: buf.trim() });
	return out;
}

function chunks(text: string): string[] {
	const parts = text.match(/[^.!?;:،]+[.!?;:،]*/g) ?? [text];
	const out: string[] = [];
	for (const p of parts) {
		let rest = p.trim();
		while (rest.length > MAX_CHUNK) {
			const cut = rest.lastIndexOf(' ', MAX_CHUNK);
			const at = cut > 40 ? cut : MAX_CHUNK;
			out.push(rest.slice(0, at));
			rest = rest.slice(at).trim();
		}
		if (rest) out.push(rest);
	}
	return out;
}

// כל הקטעים להקראה, לפי הסדר, כל אחד עם השפה שלו
function pieces(md: string): { lang: SpeechLang; text: string }[] {
	return splitByLanguage(speechText(md)).flatMap((seg) =>
		chunks(seg.text).map((text) => ({ lang: seg.lang, text })),
	);
}

type Report = (msg: string) => void;

// ---- מנוע המכשיר ----
class DeviceSpeech {
	private settings: () => SpacedRepetitionSettings;

	constructor(settings: () => SpacedRepetitionSettings) {
		this.settings = settings;
		// רשימת הקולות נטענת באיחור; הקריאה הראשונה מתחילה את הטעינה
		if (speechAvailable()) window.speechSynthesis.getVoices();
	}

	private voice(lang: SpeechLang): SpeechSynthesisVoice | undefined {
		const s = this.settings();
		const uri = lang === 'he' ? s.ttsVoiceHe : s.ttsVoiceEn;
		const list = voicesFor(lang);
		return (uri && list.find((v) => v.voiceURI === uri)) || list[0];
	}

	speak(md: string, report?: Report): void {
		if (!speechAvailable()) {
			report?.('Device voices are not available in this app.');
			return;
		}
		const synth = window.speechSynthesis;
		synth.cancel();
		const rate = this.settings().ttsRate;
		const list = pieces(md);
		list.forEach((piece, i) => {
			const u = new SpeechSynthesisUtterance(piece.text);
			u.lang = LANG_TAG[piece.lang];
			const v = this.voice(piece.lang);
			if (v) u.voice = v;
			u.rate = rate;
			if (report) {
				if (i === 0) {
					u.onstart = () =>
						report(`Speaking (${v ? v.name : u.lang})`);
				}
				u.onerror = (e) => report(`Speech error: ${e.error}`);
				if (i === list.length - 1) u.onend = () => report('Finished');
			}
			synth.speak(u);
		});
	}

	stop(): void {
		if (speechAvailable()) window.speechSynthesis.cancel();
	}
}

// הודעת השגיאה ש-Google Cloud מחזיר (למשל מפתח לא תקין או API לא מופעל)
function cloudError(res: RequestUrlResponse): string {
	try {
		const msg = (res.json as { error?: { message?: string } }).error
			?.message;
		if (msg) return `HTTP ${res.status}: ${msg}`;
	} catch {
		// התשובה אינה JSON
	}
	return `HTTP ${res.status}`;
}

// רשימת הקולות של Google Cloud לשפה; זורק שגיאה אם המפתח לא עובד
export async function cloudVoices(
	key: string,
	lang: SpeechLang,
): Promise<string[]> {
	const res = await requestUrl({
		url: `${CLOUD_URL}/voices?languageCode=${CLOUD_LANG[lang]}&key=${encodeURIComponent(key.trim())}`,
		throw: false,
	});
	if (res.status !== 200) throw new Error(cloudError(res));
	const voices = (res.json as { voices?: { name?: string }[] }).voices ?? [];
	return voices
		.map((v) => v.name ?? '')
		.filter((n) => n !== '')
		.sort();
}

// ---- מנוע מקוון: מוריד mp3 לכל קטע ומנגן דרך WebAudio ----
// WebAudio ולא <audio>: ב-WebView של אנדרואיד ניגון מדיה דורש מגע בכל פעם, ואילו
// AudioContext שהופעל פעם אחת בזמן מגע ממשיך לנגן גם אחר כך
class OnlineSpeech {
	private settings: () => SpacedRepetitionSettings;
	private ctx: AudioContext | null = null;
	private cache = new Map<string, Promise<AudioBuffer>>();
	// מונה הקראות: הקראה חדשה או עצירה מבטלות את הקודמת
	private gen = 0;
	private source: AudioBufferSourceNode | null = null;
	private gestureCtrl: AbortController | null = null;

	constructor(settings: () => SpacedRepetitionSettings) {
		this.settings = settings;
	}

	private context(): AudioContext {
		if (!this.ctx) this.ctx = new AudioContext();
		return this.ctx;
	}

	// חייב לרוץ בזמן מגע / לחיצה כדי שהשמע יופעל
	unlock(): void {
		const c = this.context();
		if (c.state === 'suspended') void c.resume();
	}

	// כל מגע במסך (גם המגע המדומה של השלט) מנסה להפעיל את השמע מחדש
	watchGestures(): void {
		if (this.gestureCtrl) return;
		const ctrl = new AbortController();
		this.gestureCtrl = ctrl;
		const fn = (): void => {
			if (this.ctx && this.ctx.state === 'suspended')
				void this.ctx.resume();
		};
		for (const type of ['pointerdown', 'touchend', 'keydown'] as const) {
			window.addEventListener(type, fn, {
				capture: true,
				passive: true,
				signal: ctrl.signal,
			});
		}
	}

	private audio(
		kind: EngineKind,
		lang: SpeechLang,
		text: string,
	): Promise<AudioBuffer> {
		const s = this.settings();
		const voice = lang === 'he' ? s.ttsCloudVoiceHe : s.ttsCloudVoiceEn;
		// ב-Cloud הקצב והקול הם חלק מהשמע, לכן הם חלק מהמפתח
		const key =
			kind === 'cloud'
				? `cloud:${voice}:${s.ttsRate}:${lang}:${text}`
				: `online:${lang}:${text}`;
		const hit = this.cache.get(key);
		if (hit) {
			// הכי חדש בסוף, כדי שהמחיקה תתחיל מהישן
			this.cache.delete(key);
			this.cache.set(key, hit);
			return hit;
		}
		const p = (async (): Promise<AudioBuffer> => {
			let bytes: ArrayBuffer;
			if (kind === 'cloud') {
				const res = await requestUrl({
					url: `${CLOUD_URL}/text:synthesize?key=${encodeURIComponent(s.ttsGoogleKey.trim())}`,
					method: 'POST',
					contentType: 'application/json',
					body: JSON.stringify({
						input: { text },
						voice: voice
							? { languageCode: CLOUD_LANG[lang], name: voice }
							: { languageCode: CLOUD_LANG[lang] },
						audioConfig: {
							audioEncoding: 'MP3',
							speakingRate: s.ttsRate,
						},
					}),
					throw: false,
				});
				if (res.status !== 200) throw new Error(cloudError(res));
				const b64 = (res.json as { audioContent?: string })
					.audioContent;
				if (!b64) throw new Error('No audio in the response');
				bytes = base64ToArrayBuffer(b64);
			} else {
				const url = `${ONLINE_URL}?ie=UTF-8&client=tw-ob&tl=${ONLINE_LANG[lang]}&q=${encodeURIComponent(text)}`;
				const res = await requestUrl({ url, throw: false });
				if (res.status !== 200) {
					throw new Error(
						res.status === 429
							? 'HTTP 429 (too many requests from this network; use Google Cloud with an API key)'
							: `HTTP ${res.status}`,
					);
				}
				bytes = res.arrayBuffer.slice(0);
			}
			return await this.context().decodeAudioData(bytes);
		})();
		this.cache.set(key, p);
		// הורדה שנכשלה לא נשמרת, כדי לנסות שוב בפעם הבאה
		void p.catch(() => this.cache.delete(key));
		while (this.cache.size > CACHE_MAX) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
		}
		return p;
	}

	prefetch(md: string, kind: EngineKind): void {
		for (const p of pieces(md)) {
			void this.audio(kind, p.lang, p.text).catch(() => undefined);
		}
	}

	speak(md: string, kind: EngineKind, report: Report): void {
		this.stop();
		const gen = this.gen;
		const list = pieces(md);
		if (!list.length) return;
		// כל הקטעים יורדים במקביל ומנוגנים לפי הסדר
		const audios = list.map((p) => this.audio(kind, p.lang, p.text));
		// ב-Cloud הקצב כבר בתוך השמע; בשירות החינמי משנים את מהירות הניגון
		const rate = kind === 'cloud' ? 1 : this.settings().ttsRate;
		report('Downloading…');
		void (async () => {
			try {
				for (const [i, a] of audios.entries()) {
					const buf = await a;
					if (gen !== this.gen) return;
					if (i === 0) {
						report(
							this.context().state === 'running'
								? `Speaking (${kind === 'cloud' ? 'Google Cloud' : 'online'})`
								: 'Sound is blocked: tap the screen once.',
						);
					}
					await this.play(buf, rate);
					if (gen !== this.gen) return;
				}
				report('Finished');
			} catch (e) {
				if (gen !== this.gen) return;
				report(
					`Online speech failed: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		})();
	}

	private play(buf: AudioBuffer, rate: number): Promise<void> {
		const ctx = this.context();
		if (ctx.state === 'suspended') void ctx.resume();
		return new Promise((resolve) => {
			const src = ctx.createBufferSource();
			src.buffer = buf;
			src.playbackRate.value = rate;
			src.connect(ctx.destination);
			src.onended = () => {
				if (this.source === src) this.source = null;
				resolve();
			};
			this.source = src;
			src.start();
		});
	}

	stop(): void {
		this.gen++;
		const s = this.source;
		this.source = null;
		if (s) {
			try {
				s.stop();
			} catch {
				// כבר נעצר
			}
		}
	}

	dispose(): void {
		this.stop();
		this.gestureCtrl?.abort();
		this.gestureCtrl = null;
		void this.ctx?.close();
		this.ctx = null;
	}
}

// ---- המקריא: בוחר מנוע לפי ההגדרה ----
export class Speaker {
	private settings: () => SpacedRepetitionSettings;
	private device: DeviceSpeech;
	private online: OnlineSpeech | null = null;
	private lastErrorAt = 0;

	constructor(settings: () => SpacedRepetitionSettings) {
		this.settings = settings;
		this.device = new DeviceSpeech(settings);
	}

	// auto: קולות המכשיר אם יש; אחרת Google Cloud אם הוזן מפתח, ואחרת השירות החינמי
	private kind(): EngineKind {
		const s = this.settings();
		if (s.ttsEngine !== 'auto') return s.ttsEngine;
		if (speechAvailable()) return 'device';
		return s.ttsGoogleKey.trim() ? 'cloud' : 'online';
	}

	private onlineEngine(): OnlineSpeech {
		if (!this.online) {
			this.online = new OnlineSpeech(this.settings);
			this.online.watchGestures();
		}
		return this.online;
	}

	// לקרוא בזמן לחיצה (פתיחת ה-review, כפתור הבדיקה) כדי לאפשר שמע
	unlock(): void {
		if (this.kind() !== 'device') this.onlineEngine().unlock();
	}

	// בלי report: שגיאה מוצגת כהודעה (לכל היותר פעם ב-10 שניות)
	speak(md: string, report?: Report): void {
		const show: Report =
			report ??
			((msg) => {
				if (!msg.startsWith('Online speech failed')) return;
				if (Date.now() - this.lastErrorAt < 10000) return;
				this.lastErrorAt = Date.now();
				new Notice(msg);
			});
		const kind = this.kind();
		if (kind !== 'device') {
			this.device.stop();
			this.onlineEngine().speak(md, kind, show);
		} else {
			this.online?.stop();
			this.device.speak(md, report);
		}
	}

	// מוריד מראש את השמע של טקסט שכנראה יוקרא בקרוב (רק במנוע המקוון)
	prefetch(md: string): void {
		const kind = this.kind();
		if (kind !== 'device') this.onlineEngine().prefetch(md, kind);
	}

	stop(): void {
		this.device.stop();
		this.online?.stop();
	}

	dispose(): void {
		this.device.stop();
		this.online?.dispose();
		this.online = null;
	}
}

// ---- מסך ההגדרות ----
export function renderSpeechSettings(
	containerEl: HTMLElement,
	plugin: SpacedRepetitionPlugin,
): () => void {
	const speaker = new Speaker(() => plugin.settings);
	const save = (): void => void plugin.saveSettings();

	new Setting(containerEl)
		.setName('Read aloud')
		.setDesc(
			'Read cards aloud in reviews, for reviewing with the remote without looking. A card that mixes the two supported languages is read with the matching voice for each part.',
		)
		.setHeading();

	new Setting(containerEl)
		.setName('Read cards aloud')
		.setDesc('Read the question when a card opens.')
		.addToggle((t) =>
			t.setValue(plugin.settings.ttsEnabled).onChange((v) => {
				plugin.settings.ttsEnabled = v;
				save();
			}),
		);

	new Setting(containerEl)
		.setName('Voice engine')
		.setDesc(
			(speechAvailable()
				? 'This device has built-in voices. '
				: 'This device has no built-in voices in this app, so automatic uses online speech: Google Cloud when an API key is set below, otherwise the free service. ') +
				'Online speech sends the card text to Google to turn it into audio and needs an internet connection.',
		)
		.addDropdown((d) =>
			d
				.addOption('auto', 'Automatic')
				.addOption('device', 'Device voices (offline)')
				.addOption('online', 'Online, free (no key)')
				.addOption('cloud', 'Cloud speech (API key)')
				.setValue(plugin.settings.ttsEngine)
				.onChange((v) => {
					plugin.settings.ttsEngine =
						v === 'device' || v === 'online' || v === 'cloud'
							? v
							: 'auto';
					save();
				}),
		);

	// ---- Google Cloud: מפתח ובחירת קול ----
	const cloudEl = containerEl.createDiv();
	let cloudStatus = '';
	const renderCloud = (voices: Record<SpeechLang, string[]> | null): void => {
		cloudEl.empty();
		new Setting(cloudEl)
			.setName('API key for cloud speech')
			.setDesc(
				'Optional. Read aloud works without a key; you only need one if the free online speech fails, for example behind a VPN or on another shared network. For Google Cloud Text-to-Speech, enable the Cloud Text-to-Speech API in a Google Cloud project, create an API key and restrict it to that API. The key is stored in data.json in the plugin folder, which syncs with your vault.',
			)
			.addText((t) => {
				t.inputEl.type = 'password';
				t.setPlaceholder('API key')
					.setValue(plugin.settings.ttsGoogleKey)
					.onChange((v) => {
						plugin.settings.ttsGoogleKey = v.trim();
						save();
					});
			})
			.addButton((btn) =>
				btn.setButtonText('Check key').onClick(() => void loadVoices()),
			);
		if (cloudStatus) {
			const st = cloudEl.createDiv({
				text: cloudStatus,
				cls: 'setting-item-description',
			});
			st.setAttr('dir', 'ltr');
		}
		if (!voices) return;
		const pick = (
			name: string,
			lang: SpeechLang,
			key: 'ttsCloudVoiceHe' | 'ttsCloudVoiceEn',
		): void => {
			new Setting(cloudEl)
				.setName(name)
				.setDesc(
					'Standard voices have the largest free monthly quota; WaveNet and newer voices sound more natural.',
				)
				.addDropdown((d) => {
					d.addOption('', 'Default');
					for (const v of voices[lang]) d.addOption(v, v);
					d.setValue(plugin.settings[key]).onChange((v) => {
						plugin.settings[key] = v;
						save();
					});
				});
		};
		pick('Google Cloud voice for Hebrew', 'he', 'ttsCloudVoiceHe');
		pick('Google Cloud voice for English', 'en', 'ttsCloudVoiceEn');
	};
	const loadVoices = async (): Promise<void> => {
		const key = plugin.settings.ttsGoogleKey;
		if (!key) {
			cloudStatus = 'Enter an API key first.';
			renderCloud(null);
			return;
		}
		cloudStatus = 'Checking…';
		renderCloud(null);
		try {
			const [he, en] = await Promise.all([
				cloudVoices(key, 'he'),
				cloudVoices(key, 'en'),
			]);
			cloudStatus = `The key works: ${he.length} voices for Hebrew, ${en.length} for English.`;
			renderCloud({ he, en });
		} catch (e) {
			cloudStatus = `The key does not work: ${e instanceof Error ? e.message : String(e)}`;
			renderCloud(null);
		}
	};
	renderCloud(null);
	if (plugin.settings.ttsGoogleKey) void loadVoices();

	new Setting(containerEl)
		.setName('Read the answer')
		.setDesc('Read the answer when it is shown.')
		.addToggle((t) =>
			t.setValue(plugin.settings.ttsReadAnswer).onChange((v) => {
				plugin.settings.ttsReadAnswer = v;
				save();
			}),
		);

	new Setting(containerEl)
		.setName('Say the action')
		.setDesc(
			'Say what the remote did (for example "good" or "skipped") before the next card, so you know the right button was pressed.',
		)
		.addToggle((t) =>
			t.setValue(plugin.settings.ttsAnnounce).onChange((v) => {
				plugin.settings.ttsAnnounce = v;
				save();
			}),
		);

	new Setting(containerEl)
		.setName('Speech rate')
		.setDesc(
			'With the free online service, a rate other than 1 also shifts the pitch a little.',
		)
		.addSlider((s) =>
			s
				.setLimits(0.5, 2, 0.1)
				.setValue(plugin.settings.ttsRate)
				.setDynamicTooltip()
				.onChange((v) => {
					plugin.settings.ttsRate = v;
					save();
				}),
		);

	// בחירת קול רלוונטית רק כשיש קולות במכשיר. הרשימה נטענת באיחור, לכן מציירים מחדש
	const voicesEl = containerEl.createDiv();
	const renderVoices = (): void => {
		voicesEl.empty();
		if (!speechAvailable()) return;
		const pick = (
			name: string,
			lang: SpeechLang,
			key: 'ttsVoiceHe' | 'ttsVoiceEn',
		): void => {
			const list = voicesFor(lang);
			new Setting(voicesEl)
				.setName(name)
				.setDesc(
					list.length
						? `${list.length} device voices. Used with device voices only.`
						: 'No device voice for this language was found. Install one in the text-to-speech settings of your device.',
				)
				.addDropdown((d) => {
					d.addOption('', 'Default');
					for (const v of list) d.addOption(v.voiceURI, v.name);
					d.setValue(plugin.settings[key]).onChange((v) => {
						plugin.settings[key] = v;
						save();
					});
				});
		};
		pick('Hebrew voice', 'he', 'ttsVoiceHe');
		pick('English voice', 'en', 'ttsVoiceEn');
	};
	renderVoices();
	const onVoices = (): void => renderVoices();
	if (speechAvailable()) {
		window.speechSynthesis.addEventListener('voiceschanged', onVoices);
	}

	const status = createDiv();
	new Setting(containerEl)
		.setName('Test speech')
		.setDesc(
			'Reads a short sentence in both languages with the selected engine. The line below shows what happens.',
		)
		.addButton((btn) =>
			btn.setButtonText('Test').onClick(() => {
				status.setText('Starting…');
				speaker.unlock();
				speaker.speak(
					'זהו מבחן של הקראה. This is a speech test.',
					(msg) => status.setText(msg),
				);
			}),
		);
	status.setAttr('dir', 'ltr');
	status.setCssStyles({
		fontSize: '0.85em',
		opacity: '0.8',
		paddingBottom: '0.75em',
	});
	containerEl.appendChild(status);

	return () => {
		speaker.dispose();
		if (speechAvailable()) {
			window.speechSynthesis.removeEventListener(
				'voiceschanged',
				onVoices,
			);
		}
	};
}
