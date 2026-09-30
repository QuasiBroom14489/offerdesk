# Design notes

## What the dashboard is for

The home screen answers one question: **what do I need to do today?** In
recruiting that is almost always "nudge someone who went quiet" or "submit
before a deadline", so the page leads with a sentence that says exactly that:

> Three conversations have gone quiet, and Tidewater Insurance closes in 4 days.

## Look

White, quiet, and minimal. Ink text, grey secondary text, hairline dividers,
no card shadows or fills. **Color only ever means something**, and it follows
a traffic light:

| Signal | Means | Used for |
| --- | --- | --- |
| Green | Moving forward | Assessment, interviewing, offer; replies in the timeline |
| Yellow | Waiting on them | Applied; follow-ups under 14 days; deadlines within a week |
| Red | Closed or urgent | Rejected, ghosted; follow-ups 14+ days; deadlines within 3 days |
| Grey | Neutral | Saved, withdrawn; everything else |

A signal is never color alone: every dot sits beside a word, and every pill
contains its value ("19 days", "in 4 days"). Tokens live in
`apps/web/src/styles.css`; the status → signal map is `STATUS_SIGNAL` in
`components/StatusMark.tsx`.

The pipeline funnel is a single series, so it uses neutral ink bars rather than
a signal color, with every bar labeled and conversion rates on hover.

## Type

Onest, one family throughout. The headline is 28px at weight 500; everything
else is 14–16px. Section titles are small and grey so the content leads.

## Keyboard

| Keys | Action |
| --- | --- |
| `⌘K` or `/` | Command palette: jump to any page, application or person |
| `N` | Add an application |
| `G` then `H` / `B` / `A` / `P` / `D` / `S` | Home, Board, Applications, People, Documents, Settings |
| `J` / `K` | Move through cards or table rows |
| `[` / `]` (or `H` / `L`) on a focused card | Move it to the previous or next stage |
| `Enter` | Open the selected row |

## Tables

The Applications page is a table builder. The view tabs across the top are the
presets, then your saved views. **Columns** adds, hides and reorders columns,
**Filters** narrows rows (all filters must match), and clicking a header sorts.
Once you change anything, **Save** (for your own views) or **Save as view…**
appears, along with a line under the table saying the view is edited but not
saved.

Cells keep the same signals as everywhere else: status dots, deadline urgency
(red ≤3 days, yellow ≤7), and days-waiting pills on the follow-up thresholds
(yellow from 7 days, red from 14). The Excel export tints status cells with the
same palette.
