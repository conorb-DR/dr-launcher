# DR Launcher · B3 vanilla port

This folder is a drop-in replacement for `dr-launcher/public/` that ships the B3
Datarails-design-system landing page as plain HTML / CSS / JS — no React, no
build step.

## What's inside

```
dr-launcher-handoff/
└── public/
    ├── index.html       ← replaces public/index.html
    ├── style.css        ← replaces public/style.css
    ├── app.js           ← replaces public/app.js (API logic preserved verbatim)
    ├── smoke-test.html  ← optional preview with mocked /api responses
    └── ds/              ← Datarails design system tokens + icons + fonts
        ├── fonts.css
        ├── colors_and_type.css
        ├── favicon-d.svg
        └── icons/*.svg
```

## How to drop it into your repo

1. Copy the entire contents of `dr-launcher-handoff/public/` over your existing
   `dr-launcher/public/` folder. Three files (`index.html`, `style.css`,
   `app.js`) are overwritten; the `ds/` folder is new.
2. Restart `node server.js`. The `__API_TOKEN__` injection still happens —
   `index.html` keeps the same placeholder string.

That's it. The server contract is unchanged.

## Preview before you commit

Open `smoke-test.html` directly in a browser. It mocks the `/api/*` endpoints
with eight realistic customer accounts and a working virtual-desktop reply, so
you see exactly what the landing page looks like populated.

## What's in this round

- Landing page (customer table + server filter sidebar + active-launch banner)
- Empty state (first run)
- Authenticate-customer modal (per-server SSO picker)
- Settings modal (virtual desktops toggle)
- Instruction-fallback modal (when terminal launch fails)

## What's not in this round (yet)

- Dedicated launch-in-progress detail page (step log + live PowerShell tail).
  The active-launch banner above the table covers the in-flight state for now.
- Recently-launched and pinned customers persist only in memory for the
  current session. If you want them to survive a refresh, hook them into
  `userSettings` or a new `/api/recent` endpoint.
