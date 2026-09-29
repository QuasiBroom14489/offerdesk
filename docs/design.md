# Design notes

## What the dashboard is for

The home screen answers one question: **what do I need to do today?** In
recruiting that is almost always "nudge someone who went quiet" or "submit
before a deadline", so the page leads with a sentence that says exactly that —

> Four conversations have gone quiet, and Tidewater Insurance closes in 4 days.

— in place of a row of KPI tiles. The numbers are still there, one line below,
at reading size rather than poster size.

## Palette

Tokyo Night (dark) and Tokyo Night Day (light): the same scheme as the author's
terminal, editor and window manager, so the dashboard sits in the same rig.
Components reference roles (`--fg`, `--accent`, `--attention`), never hex, and
the theme follows the OS unless overridden in the sidebar.

- **Pipeline stages** use an ordinal blue ramp (saved → interview), green for
  an offer, and hollow grey dots for closed outcomes. A stage is always shown
  with its name — never color alone.
- **Attention** (amber, with a clock icon) is reserved for "waiting on you".
  Nothing else uses it.
- **The funnel** is one series, so it is one hue, direct-labeled, with a hidden
  data table for screen readers and conversion rates on hover.

## Type

Onest, one family throughout. The headline is set large at weight 500 with
slight negative tracking; everything else stays at 14–16px.

## Keyboard

| Keys | Action |
| --- | --- |
| `⌘K` or `/` | Command palette: jump to any page, application or person |
| `N` | Add an application |
| `G` then `H` / `B` / `A` / `P` | Home, Board, All applications, People |
| `J` / `K` | Move through cards or table rows |
| `[` / `]` (or `H` / `L`) on a focused card | Move it to the previous or next stage |
| `Enter` | Open the selected row |
