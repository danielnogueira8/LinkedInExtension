# LinkedIn Activity Sorter

A Chrome (Manifest V3) extension that adds a side panel to a LinkedIn profile's
**Recent Activity** page. The panel lets you sort the posts the page has
already loaded by:

- Most recent
- Most likes
- Most comments
- Most reposts

It does **not** make any LinkedIn API calls of its own. It only **observes**
the responses LinkedIn already loads when you scroll the activity page, and
re-renders them in the order you choose. All data stays in your browser.

## Why an extension and not a script?

LinkedIn's profile activity feed only loads ~10 posts at a time and there's
no built-in way to sort them. Sorting client-side requires having all the
posts loaded first — which means scrolling. The extension simply automates
the scroll *politely*, with a delay you control.

## Install (developer mode)

1. Clone this repo (or download as ZIP and extract).
2. Open Chrome → `chrome://extensions`.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** and select this folder.
5. Visit a profile's recent activity page, e.g.
   `https://www.linkedin.com/in/<handle>/recent-activity/all/`
6. The "Activity Sorter" panel appears on the right.

## Usage

- Click any of **Most recent / likes / comments / reposts** to re-sort.
- Click **Load more** to ask LinkedIn for more posts. The extension scrolls
  the page and waits for LinkedIn to fetch the next batch. Repeat as needed.
- Click **Hide native feed** to focus on the sorted list.
- Click each post's **Open post ↗** link to jump to it on LinkedIn.

Open the extension's popup (toolbar icon) to tune:

- **Posts per click** — how many *new* posts to try to load per "Load more".
- **Delay between scroll triggers** — keep this generous (default 1500ms).
- **Max scroll steps per click** — hard safety cap.

## Safety / ToS

- This is a **personal-use** tool. It only runs on profile activity pages.
- It does not initiate any LinkedIn API requests; it observes responses
  LinkedIn already sent for the page you're viewing.
- It does not exfiltrate data. There is no remote server. No analytics. No
  network egress beyond LinkedIn itself.
- Auto-scroll is paced and capped. Don't lower the delay aggressively.
- Automated scraping of LinkedIn at scale violates their Terms of Service
  and may get your account flagged. Use this tool the way you would
  manually scroll a profile.
- Don't redistribute scraped data. Keep it in your browser.

If you're using this professionally or in any automated way, **don't**.
Use the official LinkedIn API.

## Files

```
manifest.json       MV3 manifest
src/interceptor.js  Page-context fetch/XHR observer
src/content.js      Content script: parses + renders sorted feed
src/styles.css      Side panel styles
src/popup.html/.js  Toolbar popup config
icons/              16/48/128 PNG icons
```

## Limitations

- LinkedIn's Voyager response shape changes over time. The parser is
  defensive (walks the JSON tree looking for engagement fields) but may
  need updates when LinkedIn ships UI changes.
- "Most comments" / "most likes" reflect counts at the moment LinkedIn
  loaded each post. They can be slightly stale.
- Very old posts may not appear unless LinkedIn's pagination reaches them.

## Development

No build step. Edit a file, then click **Reload** on the extension card in
`chrome://extensions`, then refresh the LinkedIn page.

## License

MIT — see [LICENSE](./LICENSE).
