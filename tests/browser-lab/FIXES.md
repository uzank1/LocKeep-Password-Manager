# Compatibility corrections

Updated on 2026-10-12 against the current working source. The original
[baseline](BASELINE.md) contained 23 gaps/support limits in 50 scenarios.
The regenerated Chromium simulation now passes all 57 scenarios with 560 checks
and no harness errors. `npm test` passes 106 application/unit tests and
`npm run test:lab` passes the server isolation test.

| Original cases | Resulting behavior |
| --- | --- |
| `overlay`, `scroll-panel`, `layout-shift` | Shared tracking hides covered/clipped icons, restores them when the field becomes visible, and follows later position changes. Both full-form and edge-only overlays are checked. |
| `dialog-signup`, `dialog-login` | Floating controls are attached to the field's native dialog/popover context so the top layer does not hide them. |
| `bottom-field`, `responsive` | Account lists choose the side with available space and stay within the viewport. Save prompts fit a 320 px screen. |
| `label-only`, `phone-login`, `hidden-trap`, `distractors` | Labels and autocomplete semantics identify password/username controls. Hidden, disabled, one-time-code and coupon fields are excluded. Telephone usernames are supported. |
| `external-form`, `two-forms`, `change-password` | Native form associations include external inputs. Generation fills only the relevant form's new/confirmation controls, preserving current passwords and other forms. |
| `multistep-login` | Account selection works on the username-only step without requesting the password. The later password step receives its own listener. |
| `invalid-form`, `rejected-login` | Native validation blocks invalid candidates. Newly visible site error/invalid-field signals withdraw pending offers. Values are captured before a site's handler removes the form. |
| `recover-connection` | A genuine field interaction retries an empty/failed lookup without reloading. Retries are throttled and concurrent requests share one lookup. Diagnostics remain read-only. |
| `iframe-same`, `iframe-cross` | Every matching HTTP(S) frame receives the script. Searches, password requests and saves use that frame's browser-provided origin; opaque origins cannot claim the parent's origin. |
| `shadow-open`, `shadow-closed` | Component roots are scanned and observed, and their local submit/input events are handled. Closed roots use the supported Chromium extension API when available. |
| `custom-editable` | Editable username textboxes are paired with the password control and receive input/change events. Native input setters also support controlled framework fields. |

The existing `replace-form` case additionally checks changing login/signup modes
without replacing the original fields. Old listeners/icons are removed and the
correct controls return without duplicate injection. Tests check preserved current
passwords and other-form values separately from generated fields.
Overlay close buttons outside a form no longer count as native submit controls,
and a separate assertion checks that they do not create pending save offers.

## Riot registration and password changes

The user reported a missed save offer after a five-screen signup, an inactive
next button after password generation, and a generator on the current-password
field. The public Riot signup screen independently showed an unassociated
sibling label and a form-free, textless `data-testid="btn-signup-submit"` button.
No real account was created or real account credentials entered during the work.

- `unbound-change-labels` checks nested wrappers with sibling labels and random
  input names. `named-current-password` checks `current_password`/`newPassword`
  without autocomplete hints. The current field retains its original value;
  generation is anchored to and fills the new/confirmation fields only.
- `icon-signup` checks semantic button attributes instead of requiring text or
  a native form. Disabled controls, generic forward buttons and synthetic clicks
  cannot start a save candidate.
- `riot-five-step` reproduces the user's email, date, username, password and
  consent sequence. Native editing events enable the controlled next button
  without typing/deleting a character manually. The date never replaces the
  remembered username. Removing password fields to show consent does not lose
  the pair or open an early save offer. The final checked-consent click offers
  to save the correct username/password.

Deferred registration data stays in this content script's memory, expires after
120 seconds, and its buffer is cleared on error, prompt presentation or expiry. Consent
completion requires an active registration and checked relevant checkboxes;
cookie controls are excluded. Diagnostics expose only fixed phases and field
roles, never this buffer's contents.

The editing path uses Chromium's `insertText` editing command, with a native
setter/InputEvent fallback. [MDN documents its compatibility limits](https://developer.mozilla.org/en-US/docs/Web/API/Document/execCommand).
This legacy API is optional and tested in the lab's Chromium engine; its behavior
in the installed Brave extension remains part of the real-browser check.

## Numeric identity and CAPTCHA correction

The public e-Devlet login form was inspected without entering account details
or submitting it. Its `tridField` uses `type="number"`, a T.C. Kimlik No label,
and numeric input mode. The site's hide/show control changes that same input
to `type="password"`. Its actual sign-in password remains a separate `egpField`,
and `captchaField` is a text input labelled Güvenlik Kodu.

The previous detector excluded numeric usernames and allowed CAPTCHA as a
generic text fallback. Three added fixtures reproduced all three gaps before
the correction: `identity-captcha`, `masked-identity`, and
`captcha-without-username`.

Numeric controls now require positive account/identity semantics; arbitrary
quantities cannot become usernames by proximity. Masked identity controls stay
account fields, with explicit current/new password autocomplete taking priority.
CAPTCHA and English/Turkish/German security-code labels are excluded even when
there is no other username control. The cases exercise real clicks from both
identity and password fields, mask toggling, unchanged security-code values,
and value-free diagnostics. Unit tests also classify the controls with value
getters that throw, ensuring detection does not inspect account data.

## Validation boundaries

This is a source-level Chromium simulation with sample accounts and a fake
desktop bridge. The closed-root case also simulates the contract of
[`chrome.dom.openOrClosedShadowRoot`](https://developer.chrome.com/docs/extensions/reference/api/dom).
Its availability in the installed Brave extension remains a real-browser check,
as do native messaging, browser-owned passkey UI, actual zoom and keyboard/accessibility.
Frame-origin authorization is independently covered by background-script unit
tests, rather than inferred from the fake bridge.

Submission detection observes DOM validation/error signals; it cannot prove an
arbitrary server's authentication result. An unobservable rejection is outside
these measured fixtures. Valid navigation and removed-form flows retain the
pending-save behavior.

Use an extension-free browser for simulation. Use the native-mode fixture only
with disposable accounts when checking the real installed extension; its Save
button writes to the real vault. See [the guide](README.md).

Current results and screenshots are regenerated in the ignored
`dist/browser-lab` directory and served at `/results/`.
