# PR #788 Kimi input E2E evidence

- `kimi-old-stuck.png`: pre-fix multiline first-turn prompt remains in the input box and no model response appears.
- `kimi-new-ok.png`: final `pasteText` implementation submits the same desensitized prompt and Kimi responds.
- Final adapter contract stays assume-issued, so ambiguous transport results never become a clean-non-submit retry signal.

The prompt uses only synthetic bot, user, session, and message identifiers.
