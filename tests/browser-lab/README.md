# LocKeep browser compatibility lab

Start the local lab with `npm run lab` and open http://127.0.0.1:4318.
Both fixture servers bind to the loopback interface only. The second server,
on the next port, supplies a genuinely different origin for iframe tests.
Set `LOCKEEP_LAB_PORT` to change the first port; the next port must also be free.

The dashboard has 57 scenarios covering login, registration, confirmation,
password reset/change, unusual field names/types, misleading hidden fields,
multiple forms, multistep and redirected flows, validation/rejected submissions,
SPA replacement and late rendering, password visibility toggles, synthetic
events, passkey annotations, overlays, native dialogs/popovers, nested scrolling,
transforms, delayed layout shifts, narrow screens, RTL, hostile CSS, long account
lists, removed fields, frames, Shadow DOM, custom controls and connection states.
Riot-style cases include unassociated sibling labels, nested field wrappers,
icon-only form-free submission, and the five-screen email/birthday/username/
password/consent flow without a URL change. The password step requires actual
browser editing events to enable its next button. The final consent button is
text-only and has no signup marker, so it cannot pass through the icon-button
matcher accidentally.
The scenario catalog is the source of truth for the actual count.
Identity/CAPTCHA cases reproduce the public e-Devlet form's `number` account
field, its `password` masking toggle and separate security-code input. Sample
identifiers start with zero and are deliberately invalid Turkish identity
numbers. The fixtures do not solve a CAPTCHA or authenticate with a real service.
[The initial baseline](BASELINE.md) records the first measured gaps and their
development priorities.
Fixtures use neutral numbered URLs and session identifiers, so incidental
`login`/`signup` words in the test address cannot give the detector extra hints.
Multistep fixtures also remove their descriptive page title on the password step.

## Simulation

The dashboard embeds each fixture in an iframe. It loads the production
`content_script.js`, diagnostics, styles, icons, and optional popup code directly
from the repository. Only the extension messaging API is replaced with an
in-memory fake desktop bridge. Use the Codex browser or a browser profile without
LocKeep installed for simulation. The production manifest now uses `all_frames:
true`, so an installed extension would also run in matching fixture frames.
The dashboard itself contains no login/password fields.

Embedded child injection follows the production manifest. The closed-component
fixture supplies a fake `chrome.dom.openOrClosedShadowRoot` with the same contract
as [the Chromium extension API](https://developer.chrome.com/docs/extensions/reference/api/dom).
Its real availability must also be checked in the installed Brave extension.

Sample accounts are `demo.one@example.test` and `demo.two@example.test`.
Generation uses unmistakable deterministic demo passwords, not the production
random generator. New-account submissions, pending saves and saved entries stay
in simulation memory. No real vault or native messaging host is opened; nothing
is submitted to an outside service. Reloading the dashboard clears the sessions.
Use sample data only. The command log and exported results contain command names,
counts and verdicts, not field values or credential payloads.

Pick a scenario, interact with its fields and action buttons, and use **Kontrol
et** to inspect the current state. Checks that require an interaction should be
reviewed after that action. **Uzantı paneli** previews the actual popup with the
fake connection. **Teşhis raporu** runs the production diagnostic probe. Change
the language, viewport width, theme or desktop state to repeat the same scenario.
**Bağlantıyı düzelt** changes only the bridge state, deliberately retaining the
page's cached result so recovery problems can be reproduced.

## Actual Brave/Chrome/Edge extension

Reload this repository's `extension` folder in the browser's extension manager.
Use **Gerçek uzantıyla aç** to open the chosen fixture as a top-level page. This
route does not install the fake API or manually inject the page script: it relies
entirely on the real browser extension and desktop connection. In your real vault,
create only disposable test accounts for `http://127.0.0.1:4318` if you want to
test existing-account lookup. Clicking the real extension's Save button writes
to that real vault; this is separate from the dashboard simulation.

Test the real popup, permissions, locked/unlocked desktop, desktop shutdown and
restart, extension reload, browser refresh, and real-site passkey conflicts here.
The passkey annotation fixture tests removal/restoration of the annotation;
it does not create passkeys or open a real Windows Hello prompt. Cross-origin
fixtures use the next port and need matching disposable accounts at that origin.
Frames and closed Shadow DOM expose current support limits; they are not marked
successful merely because a form could not be inspected.

## Automated Chromium checks

Run `npm run test:browser`. The installed Electron runtime opens hidden, isolated
Chromium renderers and loads the same production page code. Mouse/keyboard
actions use Chromium input events, so trusted-event guards are exercised rather
than bypassed. No Electron application code from `src` is launched.
Test-only background memory lives in the runner process so pending saves survive
navigation, as they do in the extension's service worker. It is discarded when
the runner exits and contains only the fixture's demo data.

The runner writes `dist/browser-lab/results.json`, an HTML report, and a screenshot
for every scenario. It exits with 1 when a behavioral gap or test-environment error
is found. These failures are useful findings for the next development steps;
the browser lab is deliberately separate from the existing unit-test suite.
Run one case with `npm run test:browser -- --case=overlay`, or a group with
`--case=overlay,dialog-signup,scroll-panel`.
Set `LOCKEEP_LAB_TEST_PORT` if the default test ports 4718/4719 are busy.
Run `npm run test:lab` for the server's isolation, native/simulation separation,
scenario availability, and path/write rejection checks. The latest generated
visual report can also be opened at http://127.0.0.1:4318/results/ while the lab
server is running.

The automated suite checks injection, field pairing, generation scope, trusted
selection, input/change events, duplicate accounts, diagnostic privacy and error
categories, pending save/navigation, save/cancel, popup status, removal, geometry,
hit testing and viewport containment. It cannot establish real extension-origin
permissions, native messaging security, browser-owned UI behavior, screen reader
quality, or OS/browser zoom. Repeat the manual real-extension path in Brave,
Chrome and Edge; use browser zoom 80%, 125%, 150%, keyboard Tab/Enter/Escape,
large text, and both light/dark sites when assessing those aspects.
