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
