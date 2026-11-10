# Project Guidance

Use README.md for detailed behavior, setup, and deployment context.
This file guides coding agents; it is not runtime bot configuration.

## Structure and Conventions

- Runtime: Node.js 24, TypeScript ESM, and grammY; one process and one bot.
- Use npm from the repository root; `webui/` is the React/Vite npm workspace,
  managed by the root `package-lock.json`. Install dependencies with `npm ci`.
- `src/` contains the backend; `src/telegram/` and `src/web/` adapt its entry points.
- `src/actions.ts` explicitly registers Actions and centralizes validation,
  authorization, approvals, execution, output validation, and redacted receipts.
- Keep business functions independent of grammY Context and HTTP Request objects.
- `shared/schemas/` holds shared Zod contracts and Draft 7 JSON Schema exports;
  settings schemas are distinct from one-shot operation schemas.
- Native modules live in `src/modules/`; `src/modules/index.ts` explicitly registers
  `alias`, `rss`, `rate`, `weather`, `sticker`, and `subconv`. Do not scan directories, reflectively execute
  functions, or load archived modules.
- Remaining migrations are `shuo` and AI. Do not add the obsolete `echo` example;
  defer `reminder` until grammY supports Bot API 10.4 Widgets.
- Follow strict TypeScript/NodeNext settings and existing `.js` relative imports
  in backend TypeScript. Match nearby formatting and the ESLint configuration.
- `legacy/ptb/` is an immutable archive, not a compatibility layer. Preserve its
  original bytes and manifest; `npm run verify:archive` checks recorded SHA-256 hashes.

## Actions and Scope

- Telegram and HTTP operations share the Action executor; do not bypass its checks.
- Only trusted adapters create `InvocationContext`. Never accept actor identity,
  roles, invocation source, or approval results as user-controlled Action parameters.
- Use Zod `strictObject` inputs without stripping unknown fields or coercing invalid
  types; validate serializable DTO outputs. Server-side permissions remain decisive.
- Personal language and weather defaults belong to the authenticated user. Group
  weather must not read or mutate private defaults; group RSS is chat/topic scoped.
- Bind input sessions and panels to user, chat, topic, and message as appropriate.
  Derive topic scope from `is_topic_message`, not `message_thread_id` alone.
- Preserve group allowlisting and private-only administration. Telegram group
  administrators are not automatically configured superadmins.
- Preserve one-time approvals and revision checks. Reopening an expired panel must
  reauthorize and read current state, never replay a saved mutation or approval.
- An Action timeout does not imply rollback; check state before retrying an
  `OUTCOME_UNKNOWN` result.

## Locales and Rendering

- User-facing copy belongs in `shared/locales/{zh-CN,zh-TW,en,ja}/`, split into
  `common.json`, `bot.json`, and `web.json`. Keep all four locales in sync, including
  keys, named interpolation, plural branches, and shared schema labels.
- Bind translators per invocation; do not change global language. Preserve explicit
  preferences, language negotiation, and the English missing-translation fallback.
- Telegram panels use native `sendRichMessage` and editable structured RichText.
  Use normal-sized bold text and native panel times, not large headings or code-block
  commands. RSS attribution timestamps stay plain text, without date-time entities.
- Keep dynamic content literal and safely structured; never send untrusted group
  names or raw feed HTML through Telegram's Markdown/HTML parser. Extract validated
  RSS links with explicit boundaries. Use trusted rich-text templates for help.
- Enable automatic entity detection only in controlled command/alias views, not
  RSS or panels with dynamic group names. Do not restore legacy Markdown converters.

## Validation

Run relevant checks from the repository root for code changes:

- `npm run lint`: backend, shared code, frontend, tests, scripts, and root TS configs.
- `npm run typecheck`: backend/shared/tests and the WebUI workspace.
- `npm test`: Vitest tests, separate from Playwright E2E tests.
- `npm run build`: compile the backend and build the WebUI workspace.
- `npm run verify:archive`: verify archived file bytes without changing the archive.
- `npm run verify:dist`: check build artifacts and public bundle isolation after build.
- `npm run test:e2e`: Playwright desktop/mobile coverage; relevant for WebUI, login,
  browser behavior, static serving, or security-header changes. Build first; Chromium
  must be installed (`npx playwright install chromium` when needed).
- Automated tests use mocks/local servers, not real bot credentials. They do not
  replace live Telegram/OIDC acceptance. Documentation-only edits need no live bot.

## State and Operational Safety

- Protect `.env`, tokens, administrator lists, provider/OIDC secrets, and auth data;
  do not expose them in code, logs, chat, screenshots, test fixtures, or commits.
- Never pass production credentials, legacy configuration/state, or production data
  volumes to the new core or tests. Use a separate test bot and isolated data directory.
- Never start two pollers for one token or multiple writers for one JSON data directory.
- Startup configuration uses `MISAKA_` environment variables and private `.env`,
  not legacy `config/*.json`; it is not editable business configuration.
- Preserve existing JSON state, including untracked files. Use the shared storage
  lock, atomic writes, schema versions, and revision checks; never delete/reset data
  to hide corruption, unknown versions, write failures, or stale-edit conflicts.
- Preserve unrelated work, including existing changes and files. Do not migrate or
  clean up legacy state incidentally. Commit or push only when explicitly asked.
