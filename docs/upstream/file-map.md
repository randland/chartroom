# Upstream → fork file map

Where each upstream file lives in this fork. Used by the `upstream-sync` skill to tell how hard an upstream change is
to fold in. Update it as files are ported, renamed or dropped.

- `same`: unchanged in the fork; `git cherry-pick` may apply.
- A path: the fork's counterpart (ported, so changes must be re-implemented by hand).
- `dropped`: the fork doesn't have this feature.

| Upstream path | Fork | Notes |
|---|---|---|
| `app/src/**` | same | Nothing ported yet. |
