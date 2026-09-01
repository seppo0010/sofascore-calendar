# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Run the calendar generator (the only test):
```bash
npx playwright test
```

Run with headed browser (for debugging):
```bash
npx playwright test --headed
```

View the HTML test report after a run:
```bash
npx playwright show-report
```

## Architecture

This project scrapes the user's Sofascore favorites page and generates a `.ics` calendar file at `/opt/calendar/calendar.ics`.

**Single test file: `tests/fetch.spec.ts`**

The test:
1. Opens `https://www.sofascore.com/favorites` using a persistent Chrome profile at `~/.config/google-chrome-for-api/` (this profile must already be logged into Sofascore)
2. Intercepts API responses matching `/api/v1/event/:id` (matches/games) and `/api/v1/stage/:id` (F1 stages)
3. Scrolls the page to trigger lazy-loaded content
4. Reads the Sofascore `indexedDB` (`sofascoreIndexDB` → `keyvaluepairs`) to get all cached events and stages
5. Merges intercepted responses + IndexedDB data, deduplicating by event ID
6. Writes an ICS file using the `ics` npm package

**Event title format:** `{sport emoji}{tournament emoji}{team emoji(s)} HomeTeam - AwayTeam (Tournament, Sport)`

**Configuration: `.env` → `SPECIAL_EVENTS` JSON**

The `SPECIAL_EVENTS` env var controls emoji prefixes via five maps:
- `sports` — sport name → emoji (e.g. `"Football": "⚽"`)
- `tournaments` — tournament name or regex (e.g. `"/^.*UEFA.*$/"`) → emoji
- `teams` — team name → emoji appended to title
- `teamSuffixes` — team name → text suffix appended after team name
- `stage` — F1 stage description (e.g. `"Grand Prix"`, `"Qualifying"`) → emoji

Postponed events are filtered out. The `offset` constant in `fetch.spec.ts` can adjust timestamps if needed (currently 0).

**NFL watchability score: `tests/nfl-fpi.ts`**

For "American football" events only, the test automatically fetches live data from ESPN's NFL FPI pages (`espn.com/nfl/fpi` and `espn.com/nfl/fpi/_/view/projections`, read from the embedded `window.__espnfitt__.page.content.table.stats` JSON — no manual steps) and computes a 0-100 watchability score per game from three equal-weighted factors:
- **quality** — average FPI (team strength) of both teams
- **evenness** — how close the two teams' FPI is
- **stakes** — how much playoff qualification still hinges on the result (peaks when a team's `PLAYOFF%` projection is near 50%; a team already locked in or eliminated drags the score down)

The score becomes a 0-5 star badge (`⭐`) prepended to the event title, and a breakdown (`Watchability: N/100`, FPI, playoff%) is written to the ICS event's `description` field. Team names are matched exactly between Sofascore and ESPN; if a team isn't found (fetch failure or a naming mismatch) the event is left unannotated rather than failing the run. Tune the weighting/constants at the top of `tests/nfl-fpi.ts`.
