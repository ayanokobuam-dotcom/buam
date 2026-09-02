# Active Recall

A standalone study app: read a lesson section, hide it, write what you
remember from memory, then reveal the original and compare. It is a
learning tool, not a note-taking app — see `PRODUCT EXTENSION` in the
task history for the full spec this implements.

This is a separate app from the rest of this repo (the `buam` task
manager at the repo root). It has its own design system, its own data,
and does not modify anything outside `study/`.

## Running it

No build step. Serve the folder statically and open `index.html`, e.g.:

```
cd study
python3 -m http.server 8080
# open http://localhost:8080/index.html
```

## Architecture

- `index.html` — shell, font loading, script includes.
- `style.css` — design tokens (`--background`, `--surface`, `--foreground`,
  `--muted`, `--border`, `--accent`, `--success`, `--warning`, `--error`)
  plus every component/screen style. Light and dark variants of the
  tokens both exist; dark follows `prefers-color-scheme` or a manual
  toggle in the header.
- `data.js` — the data layer. This repo has no backend, so each "table"
  from the spec (`subjects`, `topics`, `subtopics`, `lessons`,
  `lesson_sections`, `recall_notes`, `active_recall_sessions`) is a JSON
  array in `localStorage`, accessed only through the `Table` helper
  (`list`/`get`/`insert`/`update`). Every caller goes through `data.js`,
  not `localStorage` directly, so swapping this for a real API later is a
  matter of reimplementing this one file. Seed content (Biology, Chemistry,
  Physics with a full Cell Organelles lesson) is inserted once on first
  load and never overwrites user data.
- `app.js` — a small hash router (`#/home`, `#/learn`, `#/lesson/:id/section/:id`,
  `#/recall/:id/:id`, `#/compare/:noteId`, `#/history`, `#/progress`, …) and
  the screens/components themselves (`LessonViewer`, `RecallEditor`,
  `RecallComparison`+`RecallRating`, `ReviewCard`, `ProgressIndicator`,
  `SubjectSelector`/`TopicSelector`). There is no UI framework in this
  repo, so "components" are render functions returning HTML strings with
  a `mount()` callback that wires up listeners — composable, but not a
  real component runtime.

## What's implemented vs. deferred

Phases A–C from the spec are fully implemented: lessons/sections, the
read → hide → recall → write flow, and reveal/compare/self-rating, plus
recall history and a light per-subject "average recall quality" progress
view (Phase D, kept intentionally simple — no charting library).

Phase E (wiring into a real spaced-repetition scheduler) is **not**
implemented, by design — the spec calls for staying conservative about
self-reported performance. What exists instead: `data.js`'s
`srsSignalForRating()` maps each 1–4 self-rating to a conservative label
("strong" / "normal" / "weak" / "early-review") and it's stored on the
session record, so a future SRS engine has a signal to read without any
schema change. The "Today's Review" queue on Home/History is a simple
heuristic (poor/okay recalls older than a day, anything untouched for 3+
days) standing in for a real scheduler.

The future-AI-analysis feature (missing/incorrect concept detection,
suggested flashcards) described in the spec is explicitly out of scope
for this milestone and not implemented; nothing in the data model blocks
adding it later since `recall_notes.content` and the matching
`lesson_sections.content` are both already stored as plain text.

## Fonts

See `fonts/README.md` — the primary typeface is TH Mali Grade 6, which is
not bundled here since no font file was available at implementation time.
The app currently falls back to Noto Sans Thai (Google Fonts) so Thai text
stays comfortable to read in the meantime.
