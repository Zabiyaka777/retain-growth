Intentionally empty.

The marketing site (landing/) must ship zero functions: it is a static site and
the app's functions belong to app.retain-growth.ai only. Pointing
landing/netlify.toml at a directory that does NOT exist is not enough — the
Netlify CLI warns and then falls back to the repo's default functions folder,
which silently published all 60 app functions on retain-growth.ai. Pointing it
at this real, empty directory is what actually keeps that list at zero.
