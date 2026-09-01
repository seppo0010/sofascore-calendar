import type { BrowserContext } from '@playwright/test';

export type TeamStats = {
	fpi: number;
	playoffPct?: number;
};

type EspnStatRow = {
	team: { displayName: string };
	stats: { name: string; value: string }[];
};

const statValue = (row: EspnStatRow, name: string): number | undefined => {
	const stat = row.stats.find((s) => s.name === name);
	return stat === undefined ? undefined : parseFloat(stat.value);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

export async function fetchNflWatchabilityMap(context: BrowserContext): Promise<Record<string, TeamStats>> {
	for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
		const page = await context.newPage();
		try {
			await page.goto('https://www.espn.com/nfl/fpi', { waitUntil: 'domcontentloaded', timeout: 30000 });
			const fpiRows = await page.evaluate(() => (window as any).__espnfitt__.page.content.table.stats) as EspnStatRow[];

			await page.goto('https://www.espn.com/nfl/fpi/_/view/projections', { waitUntil: 'domcontentloaded', timeout: 30000 });
			const projRows = await page.evaluate(() => (window as any).__espnfitt__.page.content.table.stats) as EspnStatRow[];

			const map: Record<string, TeamStats> = {};
			for (const row of fpiRows) {
				const fpi = statValue(row, 'fpi');
				if (fpi !== undefined) map[row.team.displayName] = { fpi };
			}
			for (const row of projRows) {
				if (!map[row.team.displayName]) continue;
				map[row.team.displayName].playoffPct = statValue(row, 'probmakeplayoffs');
			}
			return map;
		} catch (error) {
			if (attempt === RETRY_ATTEMPTS) {
				console.error('Failed to fetch NFL FPI/playoff data from ESPN, skipping watchability scoring', { attempt, error });
				return {};
			}
			console.error(`Failed to fetch NFL FPI/playoff data from ESPN (attempt ${attempt}/${RETRY_ATTEMPTS}), retrying`, { error });
			await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
		} finally {
			await page.close();
		}
	}
	return {};
}

const FPI_MIN = -10;
const FPI_MAX = 10;
const clamp100 = (v: number) => Math.max(0, Math.min(100, v));

export function computeWatchability(home: TeamStats, away: TeamStats) {
	const quality = clamp100(((home.fpi + away.fpi) / 2 - FPI_MIN) / (FPI_MAX - FPI_MIN) * 100);
	const evenness = clamp100(100 - Math.abs(home.fpi - away.fpi) * 10);
	const stakesFor = (p?: number) => p === undefined ? 50 : 100 - Math.abs(2 * p - 100);
	const stakes = Math.min(stakesFor(home.playoffPct), stakesFor(away.playoffPct));
	const score = Math.round((quality + evenness + stakes) / 3);
	return {
		score,
		quality: Math.round(quality),
		evenness: Math.round(evenness),
		stakes: Math.round(stakes),
	};
}
