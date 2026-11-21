# AllegationList bot

- `architecture.md` is the living bird's-eye map of this codebase (diagram, folder structure,
  design patterns, data flows, data model). **Before writing or changing any code, update
  `architecture.md` first** to describe the planned change, then make the code match it.
  Keep its "Last updated" date current.
- Start the bot with `npm.cmd start` (plain `npm` is blocked by PowerShell's execution policy here).
- Never print or commit `.env` (it holds the bot token).
