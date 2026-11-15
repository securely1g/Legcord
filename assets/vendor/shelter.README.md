# Pinned Shelter runtime

`shelter.js` is an unmodified official build from
[`uwu/shelter-builds`](https://github.com/uwu/shelter-builds/tree/fcc9143b026a3d74c6268b1f0f5111aae22af669),
build commit `fcc9143b026a3d74c6268b1f0f5111aae22af669`. Its upstream commit
message identifies source commit
[`6d42725f7ad21df5807789e852ca8c0f8c6eb61f`](https://github.com/uwu/shelter/tree/6d42725f7ad21df5807789e852ca8c0f8c6eb61f).

The source project's CC0-1.0 license is retained in `shelter.LICENSE`.
`shelter.provenance.json` records immutable download URLs, checksums and sizes.
The source repository also contains the build inputs and third-party dependency
declarations. The runtime's existing code and notices have not been altered.

Parent-managed mode reads this package asset instead of the daily profile's
`shelter.js` and skips profile mod downloads. A missing asset never falls back
to user-controlled runtime code. The build copies the asset and this provenance
along with the other application assets; targets do not download it at startup.

Before evaluating this runtime, managed startup secures only Shelter's own
IndexedDB stores. It preserves installed plugin code, manifests and data while
disabling their startup and update flags, removes the reserved developer-mode
stub, and disables its persistent developer menu. The supported injector hook
locks public plugin mutation methods before upstream startup enables the
packaged Legcord integrations. Native Shelter customization settings are also
blocked. Storage inspection/open/transaction failures prevent runtime evaluation
and have a bounded timeout. No vendor JavaScript is rewritten.

For an update, select a new official build commit on the build host, verify its
source commit and license, replace the asset and provenance together, and repeat
unit, VM and phone validation before deployment.
