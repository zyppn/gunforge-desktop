# renderer tests

`controls.test.js` drives the real settings panel in a real Chromium via Playwright:
it clicks a control row, presses a key, and checks the binding takes, persists,
swaps on conflict, refuses reserved keys, and is restored by RESET TO DEFAULT.

    npm i -D playwright
    node renderer/test/controls.test.js

Set CHROME_PATH if Playwright's bundled Chromium is not where it expects.

`deathcard.test.js` lifts `showDeathCard` straight out of `index.html` by brace
matching and runs it in a VM against a stub DOM, so the test exercises the
shipped source rather than a copy of it. No browser needed.

    node renderer/test/deathcard.test.js

`zfight.test.js` measures z-fighting instead of waiting for someone to spot it in a
render. Two coplanar faces at the same depth make the depth buffer choose per pixel,
which shows up as a stippled band along the seam — from some angles only, which is why
it survives review. Almost every mesh here is an axis-aligned box, so for each pair that
interpenetrates, the test checks whether they share an exact plane. It is a ratchet:
each set records the pairs it has today, and the test fails either way, so a fix has to
lower its own baseline.

    node renderer/test/zfight.test.js
    ZFIGHT_VERBOSE=1 node renderer/test/zfight.test.js   # print the offending bounds
