import { writeFileSync } from 'fs';
import { chromium, test, expect } from '@playwright/test';
import { createEvents } from 'ics';

const offset = 0 // - new Date().getTimezoneOffset() * 60 * 1000
test('write calendar ics', async ({ }) => {
	// from https://stackoverflow.com/a/78265981
	const userDataDir = `${process.env.HOME}/.config/google-chrome-for-api/`
	const context = await chromium.launchPersistentContext(userDataDir, { channel: "chrome", headless: true });

	const page = await context.newPage();
	const events = {}
	const addEvent = (event) => {
		if (!event) return
		events[event.id] = {
			title: `${event.homeTeam.name} - ${event.awayTeam.name} (${event.tournament.name}, ${event.tournament.category.sport.name})`,
			start: (event.startTimestamp * 1000) + offset,
			end: ((event.endTimestamp || (event.startTimestamp + 2 * 60 * 60)) * 1000) + offset,
			startInputType: 'utc',
			endInputType: 'utc',
		};
	}
	const addStage = (stage) => {
		if (!stage) return
		events[stage.id] = {
			title: `${stage.uniqueStage.name} (${stage.description})`,
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
	await page.goto('https://www.sofascore.com/favorites');
	await expect(page.getByRole('main')).toContainText('Finished');
	for (let x = 0; x < 20; x++) {
		await page.evaluate(() => window.scrollBy(0, 230));
		await page.waitForTimeout(100);
	}
	await page.waitForTimeout(8000);
	const dbData = JSON.parse(await page.evaluate(() => new Promise((resolve, reject) => {
		const DBOpenRequest = window.indexedDB.open("sofascoreIndexDB");

		DBOpenRequest.onerror = (event) => {
			reject(JSON.stringify(event))
		};

		DBOpenRequest.onsuccess = (event) => {
			const db = DBOpenRequest.result;
			const transaction = db.transaction(["keyvaluepairs"], 'readonly');
			const objectStore = transaction.objectStore("keyvaluepairs");
			const request = objectStore.getAll();
			request.onerror = (event) => {
				reject(JSON.stringify(event));
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
