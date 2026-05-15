# Project Working Notes

## Local Web Development Flow

- Use the Codex in-app browser to inspect and test `http://localhost:8081/`.
- Do not rely on Codex's sandboxed terminal to keep Expo running as a detached background process. In this environment, foreground verification works, but long-lived background launch is unreliable.
- When browser-assisted development is needed, keep the Expo web dev server running from a normal local terminal outside the Codex sandbox.

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

- `npm run lint` is the current built-in validation command.
- There is currently no dedicated `test` script in `package.json`.
