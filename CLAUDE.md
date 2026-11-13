# Secret Santa: project instructions

Free, ad-free Secret Santa web app. No user accounts: friends get in with the group's codeword and tap their name; behind that, people act through private link tokens. Read `docs/SPEC.md` for behaviour and `docs/DESIGN.md` for visuals before changing anything substantial.

## Layout

- `backend/`: FastAPI app, SQLAlchemy models, Alembic migrations, pytest tests
- `frontend/`: React + TypeScript + Vite single-page app
- `docs/`: spec, design, static design reference (do not edit the reference HTML to "fix" the app; change the app)

## Hard rules

- Secrecy is the product. No endpoint, log line, error message, email or test fixture may reveal the full list of who has whom. A giver's request returns only their own giftee. Admin endpoints never return assignments.
- Tokens (admin, participant) are `secrets.token_urlsafe(16)` or longer, stored as SHA-256 hashes, compared in constant time, and never logged. The invite token is stored in plain text because the admin needs to see it.
- One link per person: the organiser's admin link is also their own participant link when they take part, so it may show their own giftee and nothing more. Admin endpoints still never return assignments.
- Codewords are chosen by the organiser, unique across live groups, and matched ignoring case, spaces and punctuation. Anyone with the codeword can pick any name: that's the owner's chosen trust model. So the codeword routes return names only, every attempt counts toward a per-IP rate limit, and picking a name never gives admin access. Names are unique within a group. Email is optional for participants.
- Emails carry signed `/open/` links (HMAC, with expiry), never raw tokens. Opening one issues an extra random token in `link_tokens`, so older links keep working. Lost-link emails expire after 24 hours; the rest last until the group is deleted.
- Money is stored in minor units (pence), GBP only.
- Fetching a URL for link previews must block private, loopback and link-local addresses, follow few redirects, and enforce size and time limits.
- Personal data is deleted 30 days after the gift date.
- Use a secure random source (`secrets` / `random.SystemRandom`) for the draw.

## UI rules

- Mobile first: design at 390px wide, tap targets at least 44px, text contrast at least 4.5:1.
- Use the tokens in `docs/DESIGN.md` as CSS variables. No UI kit, no emoji, no gradients.
- Keep copy minimal. Do not add explanatory helper text, reassurance lines or marketing microcopy that the designed screens don't have.
- Real `<button>`, `<a>`, `<label>` + `<input>`. Icon-only buttons need `aria-label`.
- Respect `prefers-reduced-motion` for any animation.

## Workflow

- Work in small commits using conventional commit messages.
- Every behaviour change in the draw, exclusions, tokens or visibility needs a test.
- Run lint and tests before saying a milestone is done.
- Ask before choosing hosting, buying domains or adding paid services.

## Commands

Copy `.env.example` to `.env` first. `make` targets (on Windows without make, run the commands under each target directly):

- `make up`: start Postgres and Mailpit (Mailpit UI at http://localhost:8025)
- `make migrate`: `uv run alembic upgrade head` in `backend/`
- `make dev`: up, migrate, then API on :8000 and Vite on :5173
- `make test`: `uv run pytest` in `backend/` (needs Postgres; uses the `santa_test` database) and `npm test` in `frontend/`
- `make lint`: ruff check and format check, eslint and `tsc -b`
- `make e2e`: Playwright flow against `make dev` (reads emails from Mailpit; raise `RATE_LIMIT_GROUP_CREATE` and `RATE_LIMIT_EMAIL_SEND` in `.env` for repeated runs)
- `make jobs`: run reminders, wish-list-changed emails and old-group deletion once

Deployment: see `docs/DEPLOY.md` (Vercel for the API and frontend, Neon Postgres, GitHub Actions for migrations and the cron, Resend). The API runs serverless: send emails before returning, and keep shared state in Postgres, never in process memory. Neon: app traffic uses the pooled `DATABASE_URL` (prepared statements are off for `-pooler` hosts); Alembic uses `DATABASE_URL_UNPOOLED`.
