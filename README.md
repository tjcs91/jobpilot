# JobPilot — deployment-ready MVP

JobPilot is an AI-assisted booking/admin SaaS for UK mobile service businesses. The repository contains a lightweight Node.js web app with business accounts, customer records, services, bookings, public booking pages and an AI quote-draft endpoint.

## Run locally

Requires Node.js 22+.

```bash
npm install
npm start
```

Open `http://localhost:3000`. `npm install` is intentionally dependency-free and completes without downloading application packages.

## Production deployment

A `render.yaml` Blueprint is included for Render. It runs the Node web service and mounts a persistent disk at `/var/data`, where the current MVP stores its data file. Render web services accept a `PORT` environment variable and can expose the service at a public `onrender.com` URL; custom domains and environment secrets can be configured in the Render dashboard.

Before accepting real payments or sensitive customer data, move the persistence layer to a managed Postgres database, add email/SMS delivery, Stripe webhooks, backups, stronger rate limiting, CSRF/origin protections and formal privacy/terms pages.

## Environment variables

Copy `.env.example` to `.env` for local development. For production, set secrets in the hosting provider rather than committing them.

- `BASE_URL` — public app URL
- `PASSWORD_SALT` — long random secret
- `OPENAI_API_KEY` — optional until AI is enabled
- `OPENAI_MODEL` — model name
- `STRIPE_SECRET_KEY` — optional until billing is enabled
- `STRIPE_PRICE_ID` — Stripe recurring price ID
- `STRIPE_SUCCESS_URL` / `STRIPE_CANCEL_URL` — post-checkout URLs
- `DATA_DIR` — writable data directory (Render Blueprint uses `/var/data`)

## Current status

This is a deployment-ready MVP, not a finished production SaaS. The next integration steps are managed Postgres, Stripe checkout/webhooks, transactional email/SMS, observability and production security hardening.
