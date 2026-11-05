# Material deck visual baselines

The existing `*-chromium-darwin.png` files remain the local macOS baseline.
`*-macos-15-ci-chromium-darwin.png` is the independently reviewed hosted-runner
baseline, selected only by `PLAYWRIGHT_VISUAL_BASELINE=macos-15-ci`.

The hosted screenshots came unchanged from the diagnostics of
[CI run 42070493549](https://github.com/zhouao010809-code/best-partners/actions/runs/42070493549),
commit `620f40fd444094bbbd8f2a7718d68c2870cd7702`, on `macos-15-arm64` image
`20261028.0489.1`, macOS `15.8.2` (`24H232`). All four actual/expected/diff triplets
were reviewed. The fixture, card geometry, backgrounds, controls and content are
unchanged; CJK glyph metrics differ. Some card titles wrap to an additional line,
and the selected title uses two of its permitted three lines. Metadata remains
inside the card and above its action button.

Keep both sets strict. Do not raise pixel thresholds, mask text, or regenerate a
baseline without examining the corresponding diffs. Layout, interaction and
focus assertions run in addition to screenshot comparison.
