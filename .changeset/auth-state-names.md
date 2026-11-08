---
"browserhive": patch
---

Saved logins are now kept per principal. Before, all token principals shared one set of names, so an agent that saved a login under a name another agent already used replaced that agent's snapshot and its identity seed, and could then restore it. Now:

- Every token principal has its own directory, `auth-states/p/<id>/`. The no-auth `local` principal keeps the flat `auth-states/` layout, so single-user installs see no change.
- `list_saved_auths` and restores (`context_options.storageState`, `restore_profile`) see only the caller's own snapshots, and a restore must name the kind that was saved. Anything else answers `AUTH_STATE_NOT_FOUND` with the same text as a missing name.
- Saving under a name you already use replaces your earlier snapshot of that name whichever kind it was, including the identity seed saved beside a full profile.
- On first start, snapshots in the flat layout that belong to a token principal move into that principal's directory with their identity seed. An interrupted move finishes on the next start.

A name that was already taken over before the upgrade cannot be detected afterwards. If you use more than one token, ask each agent to check its `list_saved_auths` and save again any login that is missing or wrong. After a downgrade, an older release does not see the per-principal directories. See the upgrading guide.
