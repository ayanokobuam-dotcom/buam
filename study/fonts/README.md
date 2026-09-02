# Fonts — TH Mali Grade 6

The app's design system (`study/style.css`) is built for **TH Mali Grade 6** as
the primary Thai typeface. The font file is **not bundled in this repo** —
it was not available at implementation time, and no URL for it should be
fabricated or linked from a third-party host.

## How to install it

Drop the official font files into this folder using these exact names
(the `@font-face` rules in `study/style.css` already point at them):

```
study/fonts/THMaliGrade6-Regular.woff2
study/fonts/THMaliGrade6-Regular.ttf     (fallback for older browsers)
study/fonts/THMaliGrade6-Bold.woff2
study/fonts/THMaliGrade6-Bold.ttf
```

Once the files exist at those paths, no code changes are needed — the
`@font-face` declarations will start resolving automatically and the whole
app will switch over to TH Mali Grade 6.

Get the official font from SIPA / the Thai government's free-font program
(it is distributed as part of the "13 fonts for the nation" set) and confirm
its license permits bundling before committing the binary to this repo.

## Fallback in the meantime

Until the real files are present, `study/style.css` falls back to
**Noto Sans Thai** (loaded from Google Fonts) and then the system Thai/Latin
UI stack. This keeps Thai text comfortable and legible for long study
sessions without depending on a fabricated TH Mali Grade 6 URL.
