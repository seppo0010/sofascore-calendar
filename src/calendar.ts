// Builds the calendar from ESPN's public JSON API (soccer, NFL, NBA, cricket) and
// Jolpica (F1). No browser, no login.
//
//   node src/calendar.ts [out.ics]     (default: /opt/calendar/calendar.ics)
//
// What to follow lives in follows.json; title emojis in emojis.json.
import { readFileSync, writeFileSync } from 'fs';
import { createEvents, type EventAttributes } from 'ics';
import { computeWatchability, fetchNflWatchabilityMap, type TeamStats } from './nfl-fpi.ts';

type LeagueFollow = { sport: string; league: string; query?: string };
type TeamFollow = { sport: string; league?: string; id: number; name: string };
const follows: {
	f1: boolean;
	leagues: LeagueFollow[];
	teams: TeamFollow[];
	leagueNames: Record<string, string>;
} = JSON.parse(readFileSync(new URL('../follows.json', import.meta.url), 'utf8'));

const { teams, tournaments, stage, sports, teamSuffixes }: Record<'teams' | 'tournaments' | 'stage' | 'sports' | 'teamSuffixes', Record<string, string>> =
	JSON.parse(readFileSync(new URL('../emojis.json', import.meta.url), 'utf8'));

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
// emojis.json's "sports" is keyed by these names.
const SPORT_NAMES: Record<string, string> = {
	soccer: 'Football',
	football: 'American football',
	basketball: 'Basketball',
	cricket: 'Cricket',
};
const sportLabel = (name: string) => name === 'Football' ? 'Soccer' : name;
// Keep a bit of the recent past so a game that just ended doesn't vanish.
const SINCE = Date.now() - 7 * 24 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// The refresh is periodic, not urgent, so requests go out one at a time with
// a pause in between (and a slow backoff on errors), to stay well clear of
// rate limits rather than risk getting blocked.
const REQUEST_DELAY_MS = 1000;
let queue: Promise<unknown> = Promise.resolve();
function getJson(url: string): Promise<any> {
	const result = queue.then(async () => {
		for (let attempt = 1; ; attempt++) {
			try {
				const res = await fetch(url);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return await res.json();
			} catch (error) {
				if (attempt === 3) throw new Error(`${url}: ${error}`);
				await sleep(10_000 * attempt);
			}
		}
	});
	queue = result.catch(() => {}).then(() => sleep(REQUEST_DELAY_MS));
	return result;
}

const events: Record<string, EventAttributes> = {};
const failures: string[] = [];
let requests = 0;

function addEspnEvent(e: any, sport: string, fallbackLeague: string, nflMap: Record<string, TeamStats>) {
	const start = Date.parse(e.date);
	if (start < SINCE) return;
	const comp = e.competitions[0];
	const statusName: string = comp.status?.type?.name ?? '';
	if (statusName === 'STATUS_POSTPONED' || statusName === 'STATUS_CANCELED') return;
	const home = comp.competitors.find((c: any) => c.homeAway === 'home')?.team.displayName;
	const away = comp.competitors.find((c: any) => c.homeAway === 'away')?.team.displayName;
	if (!home || !away) return;

	const leagueSlug: string = e.league?.slug ?? fallbackLeague;
	const tournament = follows.leagueNames[leagueSlug] ?? e.league?.name ?? leagueSlug;
	const sportName = SPORT_NAMES[sport] ?? sport;

	let prefix = sports[sportName] ?? '';
	for (const [k, v] of Object.entries(tournaments) as [string, string][]) {
		if ((k[0] === '/' && tournament.match(new RegExp(k.substring(1, k.length - 1)))) || k === tournament) prefix += v;
	}
	if (teams[home]) prefix += teams[home];
	if (teams[away]) prefix += teams[away];
	const t1Suffix = teamSuffixes[home] ? ` ${teamSuffixes[home]}` : '';
	const t2Suffix = teamSuffixes[away] ? ` ${teamSuffixes[away]}` : '';

	let description: string | undefined;
	let watchabilitySuffix = '';
	if (sport === 'football' && nflMap[home] && nflMap[away]) {
		const w = computeWatchability(nflMap[home], nflMap[away]);
		prefix += '⭐'.repeat(Math.round(w.score / 20));
		watchabilitySuffix = `, Watchability: ${w.score}/100`;
		description = [
			`Watchability: ${w.score}/100`,
			`FPI: ${home} ${nflMap[home].fpi} vs ${away} ${nflMap[away].fpi}`,
			`Playoff%: ${nflMap[home].playoffPct ?? '?'}% vs ${nflMap[away].playoffPct ?? '?'}%`,
		].join('\n');
	}
	const title = `${prefix} ${home}${t1Suffix} - ${away}${t2Suffix} (${tournament}, ${sportLabel(sportName)}${watchabilitySuffix})`.trim();
	// Cricket fixtures announced far ahead carry a placeholder time.
	if (comp.timeValid === false) {
		const day = new Date(start);
		const ymd = (d: Date): [number, number, number] => [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
		events[`espn-${e.id}`] = { title, description, start: ymd(day), end: ymd(new Date(start + 24 * 60 * 60 * 1000)) };
		return;
	}
	// An ODI takes most of a day; a T20 is about as long as an NFL game.
	const durationHours = sport === 'football' ? 3.5
		: sport === 'cricket' ? (comp.class?.eventType === 'T20' ? 3.5 : 8)
		: 2;
	events[`espn-${e.id}`] = {
		title,
		description,
		start,
		end: start + durationHours * 60 * 60 * 1000,
		startInputType: 'utc',
		endInputType: 'utc',
	};
}

async function addEspn() {
	const nflMap = follows.leagues.some((l) => l.league === 'nfl') ? await fetchNflWatchabilityMap() : {};

	// ESPN's scoreboard rejects date ranges, so a whole league is fetched as
	// the union of its teams' schedules (deduplicated by event id).
	const schedules: { url: string; sport: string; league: string }[] = [];
	for (const l of follows.leagues) {
		if (l.sport === 'cricket') continue;
		try {
			const d = await getJson(`${ESPN}/${l.sport}/${l.league}/teams`);
			for (const { team } of d.sports[0].leagues[0].teams) {
				const query = [l.sport === 'soccer' ? 'fixture=true' : '', l.query ?? ''].filter(Boolean).join('&');
				schedules.push({ url: `${ESPN}/${l.sport}/${l.league}/teams/${team.id}/schedule?${query}`, sport: l.sport, league: l.league });
			}
		} catch (error) {
			failures.push(`${l.league} teams: ${error}`);
		}
	}
	// For soccer, league "all" returns a team's fixtures across every competition.
	for (const t of follows.teams) {
		const league = t.league ?? 'all';
		schedules.push({ url: `${ESPN}/${t.sport}/${league}/teams/${t.id}/schedule${t.sport === 'soccer' ? '?fixture=true' : ''}`, sport: t.sport, league });
	}

	requests += follows.leagues.filter((l) => l.sport !== 'cricket').length + schedules.length;
	for (const { url, sport, league } of schedules) {
		try {
			const d = await getJson(url);
			for (const e of d.events ?? []) addEspnEvent(e, sport, league, nflMap);
		} catch (error) {
			failures.push(String(error));
		}
	}
}

// Cricket has no team schedules, and its scoreboard takes a single day, but
// it lists the days with matches in `calendar`. So: one request for that
// list, then one per day that isn't already past. A tournament counts as a
// single fetch for the failure ratio, failing if any of its days does (the
// other days are still kept).
async function addCricket() {
	for (const l of follows.leagues.filter((l) => l.sport === 'cricket')) {
		requests++;
		const url = `${ESPN}/cricket/${l.league}/scoreboard`;
		try {
			const d = await getJson(url);
			const days: string[] = (d.leagues[0].calendar ?? [])
				.filter((day: string) => Date.parse(day) + 24 * 60 * 60 * 1000 >= SINCE)
				.map((day: string) => day.slice(0, 10).replaceAll('-', ''));
			for (const e of d.events ?? []) addEspnEvent(e, 'cricket', l.league, {});
			const failedDays: string[] = [];
			for (const day of days) {
				try {
					const p = await getJson(`${url}?dates=${day}`);
					for (const e of p.events ?? []) addEspnEvent(e, 'cricket', l.league, {});
				} catch {
					failedDays.push(day);
				}
			}
			if (failedDays.length) failures.push(`cricket ${l.league}: days ${failedDays.join(', ')} failed`);
		} catch (error) {
			failures.push(`cricket ${l.league}: ${error}`);
		}
	}
}

async function addF1() {
	const SESSIONS: [key: string, name: string, minutes: number][] = [
		['FirstPractice', 'Practice 1', 60],
		['SecondPractice', 'Practice 2', 60],
		['ThirdPractice', 'Practice 3', 60],
		['SprintQualifying', 'Sprint Qualifying', 45],
		['Sprint', 'Sprint', 60],
		['Qualifying', 'Qualifying', 60],
		['Race', 'Grand Prix', 120],
	];
	requests++;
	try {
		const d = await getJson('https://api.jolpi.ca/ergast/f1/current.json');
		for (const race of d.MRData.RaceTable.Races) {
			for (const [key, name, minutes] of SESSIONS) {
				const s = key === 'Race' ? { date: race.date, time: race.time } : race[key];
				if (!s?.time) continue;
				const start = Date.parse(`${s.date}T${s.time}`);
				if (start < SINCE) continue;
				const prefix = (sports['Formula 1'] ?? '') + (stage[name] ?? '');
				events[`f1-${race.season}-${race.round}-${key}`] = {
					title: `${prefix} Formula 1 (${race.raceName}, ${name})`.trim(),
					start,
					end: start + minutes * 60 * 1000,
					startInputType: 'utc',
					endInputType: 'utc',
				};
			}
		}
	} catch (error) {
		failures.push(`F1: ${error}`);
	}
}

await Promise.all([addEspn(), addCricket(), follows.f1 ? addF1() : Promise.resolve()]);

if (failures.length) console.error(`${failures.length}/${requests} fetches failed:\n  ${failures.join('\n  ')}`);
// A partial outage would silently drop whole teams or leagues from the
// calendar; better to keep yesterday's file and fail loudly.
const MAX_FAILURE_RATIO = 0.2;
if (Object.keys(events).length === 0 || failures.length > requests * MAX_FAILURE_RATIO) {
	console.error('Too many failures, not overwriting the calendar');
	process.exit(1);
}
const { error, value } = createEvents(Object.values(events));
if (error) throw error;
const out = process.argv[2] ?? '/opt/calendar/calendar.ics';
writeFileSync(out, value!);
console.log(`Wrote ${Object.keys(events).length} events to ${out}`);
