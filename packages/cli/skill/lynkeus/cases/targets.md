# Targets: testIDs, text matching, routes, rows

- `#testId` first, then short texts. A text also matches a field's placeholder; an index (`app.press: 7`) and `x,y` work too.
- Letter case never matters. A text matches an element's whole text (a button's label also by part, whole words first; a press that matched by part warns with the element it pressed). A word inside a paragraph: `app.see: { text: "…", contains: true }`.
- A bare word starting with a capital is a route: `app.wait: Next`. Quote it twice for the text: `app.wait: '"Next"'`. With an explicit `target:` key (`app.wait: { target: TextField, scroll: true }`) a bare capitalized word is the text, unless the app has that route.
- A case's own `targets: [ios, android]` is honored by every run on a named target (`on: headless`, `host`): the case is skipped with a line, not failed.
- In a list of rows, give each row's control a testID; `within` scopes a target to an element, `nth` picks one of several.
