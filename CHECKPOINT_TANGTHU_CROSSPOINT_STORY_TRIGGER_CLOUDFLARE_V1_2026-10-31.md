# CHECKPOINT — TÀNG THƯ CROSSPOINT STORY TRIGGER VIA CLOUDFLARE V1

Date: 2026-10-31

## Decision

CrossPoint native `device.json` no longer calls Apps Script directly for Story Trigger.

New path:

```text
CrossPoint
  → Cloudflare Worker /story/crosspoint-trigger
  → branches.json
  → existing authenticated /story/trigger
  → StoryState
  → request queue
  → Story Scraper
```

## Why

CrossPoint native HTTPS successfully reaches GitHub Raw and Cloudflare-style endpoints, but the direct
`script.google.com` connection fails inside CrossPoint wolfSSL with error `-161`.

The existing Story Worker already contains the authenticated `/story/trigger` receptor and all Story
request logic. The new endpoint is therefore only a thin public receptor that:

1. accepts `shelf_no` + `direction`;
2. resolves `shelf_no` from `tangthu-opds/config/branches.json`;
3. obtains `user_id` and `root_folder_id`;
4. internally delegates to the existing `/story/trigger` path with `STORY_TRIGGER_TOKEN`.

The token is never exposed to CrossPoint.

## Implementation

- `src/crosspoint.js` — new Worker entrypoint/wrapper.
- `wrangler.jsonc` — entrypoint changed from `src/index.js` to `src/crosspoint.js`.
- Existing `src/index.js` is intentionally unchanged.
- CrossPoint test `device.json` currently uses `shelf_no = 1`.

## Important

The current Worker URL supplied for the test is:

`https://tangthu-story-worker.mienluonngon.workers.dev/`

After deploying the Worker, test:

```text
POST /story/crosspoint-trigger
{
  "shelf_no": 1,
  "direction": "next"
}
```

Do not change the existing Story Worker token or Story trigger logic.
