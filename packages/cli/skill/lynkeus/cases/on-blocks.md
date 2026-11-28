# on: blocks: steps only one kind of target needs

```yaml
  - on: device        # or headless (Node), fastsim, host (either), ios, android, has:<command>, !device …
    do:
      - app.press: "#close-native-sheet"
```
