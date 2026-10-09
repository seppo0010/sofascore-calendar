# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Generate the calendar (writes `/opt/calendar/calendar.ics`; pass a path to write elsewhere):
```bash
npm run calendar
node src/calendar.ts /tmp/test.ics
```

Type-check:
```bash
npm run typecheck
```

Runs daily from the user's crontab. Cron's default `node` is v18 (`/usr/local/bin`), which can't run `.ts`, so the cron line prepends nvm's Node 22 to `PATH`.

## Architecture

Builds a `.ics` calendar from public JSON APIs — no browser, no login. (It used to scrape Sofascore with Playwright; that was replaced.)

**`src/calendar.ts`**
- **Soccer / NFL / NBA:** ESPN's unofficial API (`site.api.espn.com/apis/site/v2/sports/...`). The scoreboard endpoint rejects date ranges, so a followed league is fetched as the union of its teams' `/teams/{id}/schedule` (deduplicated by event id). Soccer schedules need `?fixture=true` to get upcoming games; `soccer/all/teams/{id}/schedule` returns a team's games across all competitions. NBA needs `seasontype=2` or it returns preseason.
- **F1:** Jolpica (`api.jolpi.ca/ergast/f1/current.json`), the Ergast successor.
- Events older than 7 days and postponed/canceled games are dropped.
- If more than 20% of fetches fail (or nothing was fetched) it exits non-zero without overwriting the calendar.

**`follows.json`** — what to follow (the source of truth; edit by hand):
- `leagues` — whole leagues, by ESPN `sport` + `league` slug (e.g. `soccer`/`arg.1`)
- `teams` — single teams by ESPN team id (find ids via `.../{sport}/{league}/teams`)
- `leagueNames` — ESPN league slug → display name used in titles and for `tournaments` emoji matching
- `f1` — include F1 sessions

**Event title format:** `{sport emoji}{tournament emoji}{team emoji(s)} HomeTeam - AwayTeam (Tournament, Sport)`; F1: `{emoji} Formula 1 (Race name, Session)`.

**`emojis.json`** — title emojis, via five maps (names must match ESPN's team names and the `leagueNames` labels):
- `sports` — `"Football"` (soccer), `"American football"`, `"Basketball"`, `"Formula 1"` → emoji
- `tournaments` — tournament name or regex (e.g. `"/^.*UEFA.*$/"`) → emoji
- `teams` — team name → emoji appended to title
- `teamSuffixes` — team name → text suffix appended after team name
- `stage` — F1 session (`"Grand Prix"`, `"Qualifying"`, `"Sprint"`, `"Sprint Qualifying"`) → emoji

**NFL watchability score: `src/nfl-fpi.ts`**

For NFL games, fetches ESPN's NFL FPI pages (`espn.com/nfl/fpi` and `espn.com/nfl/fpi/_/view/projections`) with plain `fetch` and reads the JSON embedded in the HTML (`window['__espnfitt__'].page.content.table.stats`). Computes a 0-100 watchability score per game from three equal-weighted factors:
- **quality** — average FPI (team strength) of both teams
- **evenness** — how close the two teams' FPI is
- **stakes** — how much playoff qualification still hinges on the result (peaks when a team's `PLAYOFF%` projection is near 50%; a team already locked in or eliminated drags the score down)

The score becomes a 0-5 star badge (`⭐`) prepended to the event title, the numeric score is appended inside the title's trailing parentheses (e.g. `(NFL, American football, Watchability: 72/100)`), and a breakdown (`Watchability: N/100`, FPI, playoff%) is written to the ICS event's `description` field. If the FPI fetch fails, games are left unannotated rather than failing the run. Tune the weighting/constants at the top of `src/nfl-fpi.ts`.
