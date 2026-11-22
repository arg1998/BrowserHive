---
"browserhive": patch
---

Launch arguments are now checked in every spelling Chromium accepts. `launch_options.args` entries on the deny-list are refused with `UNSAFE_LAUNCH_ARG` whether they start with `--`, `-` or `/` and in any letter case (`-no-sandbox`, `/User-Data-Dir=…`), and a bare `--` is refused too. Raw proxy arguments are recognised in the same spellings.
