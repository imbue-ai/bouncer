# hosting/

Static assets deployed to Cloudflare Pages and served at:

- **prod:** `https://bouncer.imbue.com`
- **dev:** `https://bouncer-dev.imbue.com`

Contents:
- `signin.html` — hosted Firebase Auth sign-in page (Safari uses this; see `src/background/auth.ts`)
- `icon128.png` — logo used on the sign-in page
- `_headers` — Cloudflare Pages `_headers` config (CSP, etc.)

## Deploy

Run from inside this `hosting/` directory:

```bash
# Prod
npx wrangler pages deploy . --project-name=bouncer-prod --branch=main

# Dev
npx wrangler pages deploy . --project-name=bouncer-dev --branch=main
```

First-time setup:
```bash
npx wrangler login
```

## Notes

- The sign-in page is loaded by the extension at `https://<SIGNIN_DOMAIN>/signin#<params>` — the `#signin` path maps to `signin.html` via Cloudflare Pages' default routing (any request for `/signin` resolves to `signin.html`).
- `_headers` must ship alongside `signin.html` for CSP to apply. Both live at the root of the deployed site.
- Apple Sign In requires the domain be listed in both the Apple Services ID "Domains and Subdomains" and Firebase Console "Authorized domains" — see Apple Developer console.
- Changes to `signin.html` take effect as soon as the deploy completes; no extension rebuild is needed.
