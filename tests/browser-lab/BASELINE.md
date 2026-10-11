# Initial compatibility baseline

Captured on 2026-10-11 against the v1.0.9 extension source (commit `a5f47c0`).
The lab ran 50 scenarios with 409 recorded checks: 27 scenarios passed the
performed checks, 23 exposed behavioral gaps or support limits, and there were
no test-environment errors. A pass applies to those measured actions, not to
all possible websites or the manual browser/OS matrix.

The production extension was unchanged when this initial baseline was captured.
The following findings provide reproducible starting points; later corrections
are recorded in [FIXES.md](FIXES.md) and the regenerated results.

| Priority | Area | Reproducible findings |
| --- | --- | --- |
| 1 | Layers and visibility | `overlay`: generator remains on top of a covered form. `dialog-signup` / `dialog-login`: generator or account list is behind the native dialog. `scroll-panel`: generator escapes a clipped panel. `bottom-field`: account list runs below the viewport. `responsive`: save prompt runs outside a 320 px viewport. `layout-shift`: generator does not follow a late position change. |
| 2 | Field selection and form scope | `label-only`: a text password described only by its label is missed. `phone-login`: the telephone username field is missed. `hidden-trap` / `distractors`: hidden or unrelated fields are selected. `external-form`: filling works, but a new-account submission with externally associated fields does not produce the save prompt. `two-forms` / `change-password`: generator placement is blocked by another password field earlier in the document. |
| 3 | Flow and recovery | `multistep-login`: no account list on the username-only step. `invalid-form` / `rejected-login`: a save prompt is offered before valid/successful submission is established. `recover-connection`: a fresh diagnostic lookup can find accounts while the page's original listeners/cache remain empty. |
| 4 | Additional form contexts | `iframe-same` / `iframe-cross`: the current manifest injects only into the top document. `shadow-open`: the current scan does not enter component roots. `shadow-closed`: closed component internals are a browser access boundary. `custom-editable`: contenteditable username controls are outside the current input-only matching. |

The standard login/registration checks, multiple autocomplete tokens, multistep
registration, save after navigation, save/cancel, late rendering, form replacement,
show/hide password, synthetic-event guards, passkey annotation restoration,
popover coverage, transformed/RTL/hostile-style fixtures, duplicate accounts,
special-character account titles, empty/locked/offline/slow connection diagnostics,
and pending-save restoration passed the actions covered by this initial run.

The server isolation check and the existing 21 content/diagnostic unit tests
also passed. Real Brave integration, browser-owned passkey UI, native messaging
origin/cryptographic boundaries, service-worker expiry, actual browser zoom,
and assistive technology still require their separate integration/manual checks.

Open `/results/` on the running lab server for the current HTML report. Screenshots
and detailed JSON are generated in `dist/browser-lab`, which is ignored by Git.
Regenerate the report after each production change; this document remains a
record of the initial behavior rather than a permanently updated success claim.
