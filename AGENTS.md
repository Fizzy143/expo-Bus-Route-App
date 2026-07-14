# Project Working Notes

## Local Web Development Flow

- Use the Codex in-app browser to inspect and test `http://localhost:8081/`.
- Do not rely on Codex's sandboxed terminal to keep Expo running as a detached background process. In this environment, foreground verification works, but long-lived background launch is unreliable.
- When browser-assisted development is needed, keep the Expo web dev server running from a normal local terminal outside the Codex sandbox.

## Realtime Data Does Not Work Under `expo start --web`

- The realtime ETA sources for web go through the Vercel serverless proxies in `api/` (`/api/new-taipei-estimates`, `/api/route-dyna`). These functions only exist on a Vercel deployment (or under `vercel dev`).
- `expo start --web` (i.e. `npm run web`, `npm run web:local`) serves only the Metro bundle. Requests to `/api/*` return `404` + the SPA `index.html`, so `fetchNewTaipeiEstimateDataset` / RouteDyna get no JSON and fall back to the codetabs/slid Taipei-only path — New Taipei routes (e.g. 707) then show `未發車` / `暫無資料` even though production is fine.
- To test realtime data locally, either open the deployed site (`https://expo-bus-route-app.vercel.app`) or run `vercel dev` (which runs the `api/` functions). Plain `expo start --web` is only sufficient for UI work; expect no live arrivals there.

## Recommended Local Startup Command

Run this in a local PowerShell window from `C:\Users\fizzy\Desktop\stop-togo`:

```powershell
$env:CI="1"
$env:EXPO_NO_TELEMETRY="1"
$env:HOME="C:\Users\fizzy\Desktop\stop-togo"
$env:USERPROFILE="C:\Users\fizzy\Desktop\stop-togo"
npm run web -- --offline --port 8081
```

## Easier Local Startup

- Preferred local web command inside a prepared PowerShell window:
  - `npm run web:local`
- One-click launcher from the repo root:
  - `.\start-web-local.cmd`
- The launcher script sets the needed Expo environment variables automatically before starting the web server on `http://localhost:8082/`.

## Codex Browser Workflow

- After the local server is running, use the in-app browser against `http://localhost:8081/`.
- After code changes, reload the page in the in-app browser to verify UI behavior.
- If localhost stops responding, ask the user to restart the local PowerShell command above.

## Validation Notes

- `npm run lint` (`expo lint`) and `npm run typecheck` (`tsc --noEmit`) are the validation commands. There is no unit-test suite / `test` script.
- A husky **pre-push** hook (`.husky/pre-push`) runs `npm run lint && npm run typecheck` before every push, so lint/type regressions are caught before they reach the Vercel deploy. Hooks activate after `npm install` (via the `prepare` script). To push while intentionally bypassing it, use `git push --no-verify`.
