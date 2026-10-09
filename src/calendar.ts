// Builds the calendar from ESPN's public JSON API (soccer, NFL, NBA) and
// Jolpica (F1). No browser, no login.
//
//   node src/calendar.ts [out.ics]     (default: /opt/calendar/calendar.ics)
//
// What to follow lives in follows.json; emoji maps come from SPECIAL_EVENTS
// in .env.
import 'dotenv/config';
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

const { teams, tournaments, stage, sports, teamSuffixes } = process.env.SPECIAL_EVENTS === undefined ? {
	teams: {}, tournaments: {}, stage: {}, sports: {}, teamSuffixes: {},
} : JSON.parse(process.env.SPECIAL_EVENTS);

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
// SPECIAL_EVENTS.sports is keyed by these names.
const SPORT_NAMES: Record<string, string> = {
	soccer: 'Football',
	football: 'American football',
	basketball: 'Basketball',
};
const sportLabel = (name: string) => name === 'Football' ? 'Soccer' : name;
// Keep a bit of the recent past so a game that just ended doesn't vanish.
const SINCE = Date.now() - 7 * 24 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function getJson(url: string): Promise<any> {
	for (let attempt = 1; ; attempt++) {
		try {
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return await res.json();
		} catch (error) {
			if (attempt === 3) throw new Error(`${url}: ${error}`);
			await sleep(1000 * 2 ** (attempt - 1));
		}
	}
}

// Runs fn over items with at most `limit` requests in flight.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(Array.from({ length: limit }, async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i]);
		}
	}));
	return results;
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
	const durationHours = sport === 'football' ? 3.5 : 2;
	events[`espn-${e.id}`] = {
		title: `${prefix} ${home}${t1Suffix} - ${away}${t2Suffix} (${tournament}, ${sportLabel(sportName)}${watchabilitySuffix})`.trim(),
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

	requests += follows.leagues.length + schedules.length;
	await mapLimit(schedules, 8, async ({ url, sport, league }) => {
		try {
			const d = await getJson(url);
			for (const e of d.events ?? []) addEspnEvent(e, sport, league, nflMap);
		} catch (error) {
			failures.push(String(error));
		}
	});
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

await Promise.all([addEspn(), follows.f1 ? addF1() : Promise.resolve()]);

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
