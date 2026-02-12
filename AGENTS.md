# Repository Guidelines

## Project Structure & Module Organization
This repository is a TypeScript monorepo using npm workspaces.
- `packages/` contains core services and apps:
  - Backend services: `dashboard`, `proxy-gateway`, `billing`, `metering`, `pool-manager`, `shared`
  - Frontend clients: `frontend` (React/Vite), `extension` (browser extension)
- `sdks/node/` contains the published Node.js SDK.
- `infra/docker/` holds Dockerfiles; root `docker-compose*.yml` files orchestrate local/prod stacks.
- `docs/` includes setup, usage, architecture, and audit documentation.
- Tests are mostly colocated as `src/**/*.test.ts` (or `*.test.tsx` in frontend).

## Build, Test, and Development Commands
- `npm run build`: Compile all workspace packages (`tsc --build`).
- `npm run clean`: Remove build outputs across packages.
- `docker compose up -d`: Start local PostgreSQL and supporting services.
- `npm run db:migrate`: Apply database schema migrations (after build).
- `npm run start:api`: Run dashboard API from built output.
- `npm run start:proxy`: Run proxy gateway from built output.
- `npm run start:frontend`: Start the React frontend dev server.
- `npm run test`: Run backend Vitest suites.
- `npm run test:frontend`: Run frontend Vitest suite.
- `npm run test:coverage`: Generate backend coverage report in `coverage/`.
- `npm run lint` / `npm run format`: Lint and format TypeScript sources.

## Coding Style & Naming Conventions
Use TypeScript with 2-space indentation, double quotes, semicolons, and trailing commas (Prettier defaults). Keep modules focused and colocate tests near implementation. Use:
- `camelCase` for variables/functions
- `PascalCase` for React components/types
- kebab-case filenames for backend modules (for example, `session-manager.ts`)

## Testing Guidelines
Vitest is the test runner across backend, frontend, extension, and SDK packages. Name tests `*.test.ts` (or `*.test.tsx` for React). Run relevant package tests plus root test commands before opening a PR, and include coverage changes when touching critical paths (`proxy-gateway`, `shared`, `billing`, `metering`, `pool-manager`).

## Commit & Pull Request Guidelines
Follow Conventional Commit style seen in history (for example, `feat: ...`, `security: ...`). Keep commits scoped to a package or concern. PRs should include:
- concise summary of behavior changes
- impacted packages/modules
- test evidence (commands run and results)
- screenshots for UI/extension changes
- linked issue(s) when applicable

## Security & Configuration Tips
Start from `.env.example`; never commit real secrets. Keep `JWT_SECRET`, payment keys, and provider credentials local. Run dependency audits (`npm audit`) and ensure CI workflows (lint, build, tests, security audit) stay green.
