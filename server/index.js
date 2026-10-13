// Mobile-SR leaderboard: a Cloudflare Worker backed by a D1 database.
//
//   GET  /top?game=<game>   the best 50 results of a game
//   POST /register          { id, username } - claim a permanent username
//   POST /score             { game, id, name, done, level, value, gear }
//
// A player is identified by a random private id that the plugin generates.
// Only its SHA-256 is stored, so the tables never contain anything that can
// be used to submit in another player's name. A username is claimed once and
// can never be changed or claimed again; the display name is free.
//
// Every finished game is recorded, including ones lost on the first level.
// Ranking: completed games first, fastest first; then games that were not
// completed, by the level reached and then by the progress made.

// timed: the game can be completed, and a completed game is ranked by time.
// levels: the number of levels. maxProgress: the most points (or monsters
// defeated) a game that was not completed can plausibly report.
const GAMES = {
	aliens: { timed: true, levels: 3, minTime: 15, maxProgress: 5000 },
	sword: { timed: true, levels: 3, minTime: 10, maxProgress: 60 },
	blast: { timed: false, levels: 1000, minTime: 0, maxProgress: 1000000 },
};
const MAX_TIME = 3600;
const TOP = 50;
const MIN_GAP_MS = 5000; // between two submissions of one player to one game
const NAME_MAX = 20;
const GEAR_MAX = 24;
const USERNAME_RE = /^[a-z0-9_]{3,16}$/;
const ID_RE = /^[0-9a-f]{32,64}$/;

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (body, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...CORS },
	});

// Removes control and invisible formatting characters.
const cleanText = (value, max) =>
	String(value ?? '')
		.replace(/[\p{Cc}\p{Cf}]/gu, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, max);

async function sha256(text) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(text),
	);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

async function readBody(request) {
	try {
		const body = await request.json();
		return body && typeof body === 'object' ? body : null;
	} catch {
		return null;
	}
}

// Is result a better than result b? (Each is { done, level, value }.)
function better(a, b) {
	if (a.done !== b.done) return a.done > b.done;
	if (a.done) return a.value < b.value;
	if (a.level !== b.level) return a.level > b.level;
	return a.value > b.value;
}

async function top(env, game) {
	if (!GAMES[game]) return json({ error: 'Unknown game' }, 400);
	const { results } = await env.DB.prepare(
		`SELECT s.name, p.username, s.done, s.level, s.value, s.gear, s.at
		 FROM scores s JOIN players p ON p.uid = s.uid
		 WHERE s.game = ?
		 ORDER BY s.done DESC,
		          CASE WHEN s.done = 1 THEN s.value END ASC,
		          s.level DESC, s.value DESC, s.at ASC
		 LIMIT ${TOP}`,
	)
		.bind(game)
		.all();
	return json({ game, top: results });
}

async function register(env, request) {
	const body = await readBody(request);
	if (!body) return json({ error: 'Invalid JSON' }, 400);
	const id = String(body.id ?? '');
	if (!ID_RE.test(id)) return json({ error: 'Invalid id' }, 400);
	const username = String(body.username ?? '')
		.trim()
		.toLowerCase();
	if (!USERNAME_RE.test(username))
		return json(
			{
				error: 'A username is 3 to 16 characters: a-z, 0-9 and underscore.',
			},
			400,
		);

	const uid = await sha256(id);
	const mine = await env.DB.prepare(
		'SELECT username FROM players WHERE uid = ?',
	)
		.bind(uid)
		.first();
	// A username is permanent: registering again returns the existing one.
	if (mine) return json({ ok: true, username: mine.username });

	const taken = await env.DB.prepare(
		'SELECT 1 AS x FROM players WHERE username = ?',
	)
		.bind(username)
		.first();
	if (taken) return json({ error: 'This username is taken.' }, 409);
	try {
		await env.DB.prepare(
			'INSERT INTO players (username, uid, created) VALUES (?, ?, ?)',
		)
			.bind(username, uid, Date.now())
			.run();
	} catch {
		// Someone claimed it between the check and the insert.
		return json({ error: 'This username is taken.' }, 409);
	}
	return json({ ok: true, username });
}

async function submit(env, request) {
	const body = await readBody(request);
	if (!body) return json({ error: 'Invalid JSON' }, 400);
	const game = String(body.game ?? '');
	const rule = GAMES[game];
	if (!rule) return json({ error: 'Unknown game' }, 400);
	const id = String(body.id ?? '');
	if (!ID_RE.test(id)) return json({ error: 'Invalid id' }, 400);

	const done = body.done === true || body.done === 1 ? 1 : 0;
	const level = Number(body.level);
	const value = Number(body.value);
	if (!Number.isInteger(level) || !Number.isFinite(value))
		return json({ error: 'Invalid result' }, 400);
	if (done) {
		if (!rule.timed || level !== rule.levels)
			return json({ error: 'Invalid result' }, 400);
		if (value < rule.minTime || value > MAX_TIME)
			return json({ error: 'Result out of range' }, 400);
	} else if (
		level < 1 ||
		level > rule.levels ||
		value < 0 ||
		value > rule.maxProgress
	) {
		return json({ error: 'Result out of range' }, 400);
	}

	const uid = await sha256(id);
	const player = await env.DB.prepare(
		'SELECT username FROM players WHERE uid = ?',
	)
		.bind(uid)
		.first();
	if (!player) return json({ error: 'Register a username first.' }, 403);
	const name = cleanText(body.name, NAME_MAX) || player.username;
	const gear = cleanText(body.gear, GEAR_MAX);

	const now = Date.now();
	const prev = await env.DB.prepare(
		'SELECT done, level, value, seen FROM scores WHERE game = ? AND uid = ?',
	)
		.bind(game, uid)
		.first();

	if (!prev) {
		await env.DB.prepare(
			'INSERT INTO scores (game, uid, name, done, level, value, gear, at, seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
		)
			.bind(game, uid, name, done, level, value, gear, now, now)
			.run();
		return json({ ok: true, improved: true });
	}
	if (now - prev.seen < MIN_GAP_MS)
		return json({ error: 'Too many submissions' }, 429);

	const improved = better({ done, level, value }, prev);
	if (improved) {
		await env.DB.prepare(
			'UPDATE scores SET name = ?, done = ?, level = ?, value = ?, gear = ?, at = ?, seen = ? WHERE game = ? AND uid = ?',
		)
			.bind(name, done, level, value, gear, now, now, game, uid)
			.run();
	} else {
		// The display name is still refreshed, so a rename shows up at once.
		await env.DB.prepare(
			'UPDATE scores SET name = ?, seen = ? WHERE game = ? AND uid = ?',
		)
			.bind(name, now, game, uid)
			.run();
	}
	return json({ ok: true, improved });
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		try {
			if (request.method === 'OPTIONS')
				return new Response(null, { status: 204, headers: CORS });
			if (request.method === 'GET' && url.pathname === '/top')
				return await top(env, url.searchParams.get('game') ?? '');
			if (request.method === 'POST' && url.pathname === '/register')
				return await register(env, request);
			if (request.method === 'POST' && url.pathname === '/score')
				return await submit(env, request);
			return json({ error: 'Not found' }, 404);
		} catch (err) {
			console.error(err);
			return json({ error: 'Server error' }, 500);
		}
	},
};
