# TV Tracker

An Executor app template for tracking shows, seasons, and episodes.

## Features

- Organize shows into four groups: watching, pending, up to date, and finished.
- Store where you stopped and the latest released season.
- Record genre, platform, and free-form notes.
- Mark each episode as watched individually.
- Keep recommendations with a reason, platform, and source.
- Persist shows, episodes, and recommendations in the app's own database.

## Installation

Create a new Executor app using the files in this directory. Do not overwrite another app. The `package.json` pins the framework version used during development; if your Executor server requires a different version, update `apps` to the version reported by the server before creating the app.

This template contains no shows, episodes, or recommendations. The migrations create empty tables only.

## Verification

After deploying, call `listShows`, `listSuggestions`, and `listEpisodes`. Each one should return an empty array. To test the episode checkbox, add a show through the UI, open `Episodes`, add an episode, and mark it as watched.
