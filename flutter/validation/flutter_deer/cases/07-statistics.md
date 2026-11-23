---
id: deer-statistics
title: "flutter_deer: a calendar switched between week, month and year"
description: >
  The order statistics open on a week; the year button lists the months and one is picked (the pick only changes
  its highlight, which the screen does not report), the month button shows the days, which expand and collapse.
---
steps:
  - app.deeplink: "/statistics/order"
  - app.see: { text: "交易额走势" }
  - app.press: "#year"
  - app.see: { text: "12月" }
  - app.press: "3月"
  - app.press: "#month"
  - app.see: { text: "周一" }
  - app.press: "收起"
  - app.see: { text: "展开" }
  - app.press: "展开"
  - app.see: { text: "收起" }
  - app.press: "#day"
  - app.see: { text: "交易额走势" }
expected:
  - The calendar follows each button.
