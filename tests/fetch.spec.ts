import { writeFileSync } from 'fs';
import { chromium, test, expect } from '@playwright/test';
import { createEvents } from 'ics';

const { teams, tournaments, stage, sports, teamSuffixes } = process.env.SPECIAL_EVENTS === undefined ? {
	teams: {}, tournaments: {}, stage: {}, sports: {}, teamSuffixes: {},
} : JSON.parse(process.env.SPECIAL_EVENTS);
const specialStage = stage;
const offset = 0 // - new Date().getTimezoneOffset() * 60 * 1000

const sport = (name) => {
	if (name === 'Football') return 'Soccer';
	return name;
}
test('write calendar ics', async ({ }) => {
	// from https://stackoverflow.com/a/78265981
	const userDataDir = `${process.env.HOME}/.config/google-chrome-for-api/`
	const context = await chromium.launchPersistentContext(userDataDir, { channel: "chrome", headless: true });

	const page = await context.newPage();
	const events = {}
	const addEvent = (event) => {
		if (!event) return
		if (event.status && event.status.type === 'postponed') return;
		let prefix = '';
		if (sports[event.tournament.category.sport.name]) prefix += sports[event.tournament.category.sport.name]
		for (const [k, v] of Object.entries(tournaments)) {
			if ((k[0] === '/' && event.tournament.name.match(new RegExp(k.substring(1, k.length-1)))) || k === event.tournament.name) {
				prefix += v;
			}
		}
		if (teams[event.homeTeam.name]) prefix += teams[event.homeTeam.name]
		if (teams[event.awayTeam.name]) prefix += teams[event.awayTeam.name]
		const t1Suffix = teamSuffixes[event.homeTeam.name] ? ` ${teamSuffixes[event.homeTeam.name]}` : ''
		const t2Suffix = teamSuffixes[event.awayTeam.name] ? ` ${teamSuffixes[event.awayTeam.name]}` : ''
		events[event.id] = {
			title: `${prefix} ${event.homeTeam.name}${t1Suffix} - ${event.awayTeam.name}${t2Suffix} (${event.tournament.name}, ${sport(event.tournament.category.sport.name)})`.trim(),
			start: (event.startTimestamp * 1000) + offset,
			end: ((event.endTimestamp || (event.startTimestamp + 2 * 60 * 60)) * 1000) + offset,
			startInputType: 'utc',
			endInputType: 'utc',
		};
	}
	const addStage = (stage) => {
		if (!stage) return
		if (stage.status && stage.status.type === 'postponed') return;
		let prefix = '';
		if (sports[stage.uniqueStage.category.name]) prefix += sports[stage.uniqueStage.category.name]
		if (specialStage[stage.description]) prefix += specialStage[stage.description]
		events[stage.id] = {
			title: `${prefix} ${stage.uniqueStage.name} (${stage.info.circuit}, ${stage.description})`.trim(),
			start: (stage.startDateTimestamp * 1000) + offset,
			end: ((stage.endDateTimestamp || (stage.startDateTimestamp + 2 * 60 * 60)) * 1000) + offset,
			startInputType: 'utc',
			endInputType: 'utc',
		};
	}
	page.on('response', async (response) => {
		if (response.url().match(/^https:\/\/(www\.)?sofascore\.com\/api\/v1\/event\/\d+$/)) {
			// Soccer, cricket, etc.
			const d = await response.json()
			addEvent(d.event)
		}
		if (response.url().match(/^https:\/\/(www\.)?sofascore\.com\/api\/v1\/stage\/\d+$/)) {
			// F1
			const d = await response.json()
			addStage(d.stage)
		}
	});
	await page.goto('https://www.sofascore.com/favorites', { waitUntil: 'domcontentloaded', timeout: 30000 });
	await expect(page.getByRole('main')).toContainText('Finished');
	for (let x = 0; x < 20; x++) {
		await page.evaluate(() => window.scrollBy(0, 230));
		await page.waitForTimeout(100);
	}
	await page.waitForTimeout(8000);
	const dbData = JSON.parse(await page.evaluate(() => new Promise((resolve, reject) => {
		const DBOpenRequest = window.indexedDB.open("sofascoreIndexDB");

		DBOpenRequest.onerror = (event) => {
			reject(event)
		};

		DBOpenRequest.onsuccess = (event) => {
			const db = DBOpenRequest.result;
			const transaction = db.transaction(["keyvaluepairs"], 'readonly');
			const objectStore = transaction.objectStore("keyvaluepairs");
			const request = objectStore.getAll();
			request.onerror = (event) => {
				reject(event);
			};
			request.onsuccess = (event) => {
				resolve(event.target.result[0]);
			};
		};
	})))
	Object.values(JSON.parse(dbData.events)).forEach(addEvent);
	Object.values(JSON.parse(dbData.stages)).forEach(addStage);

	await page.waitForTimeout(1000);
	await context.close();

	const { error, value } = createEvents(Object.values(events));
	if (error) {
		console.error({ error })
		throw new Error(error)
	}
	writeFileSync(`/opt/calendar/calendar.ics`, value)
});
