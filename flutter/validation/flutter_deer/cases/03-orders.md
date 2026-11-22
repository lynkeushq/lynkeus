---
id: deer-orders
title: "flutter_deer: order tabs, a long list that loads more, and pull to refresh"
description: >
  Switches to the to-deliver tab, scrolls until the list has loaded all three pages, goes back to the top and pulls
  to refresh: the list starts over with one page, so its footer says it is loading more again.
---
steps:
  # Home builds the shop tab too, which asks GitHub for its user: answered here, so no run depends on the internet
  # (a host blocks it; a device would hit the API's rate limit and show it in a toast).
  - app.mock: { route: "GET /users/simplezhli", body: '{"login":"simplezhli","name":"Deer","avatar_url":""}' }
  - app.deeplink: "/home"
  - app.see: { text: "新订单" }
  - app.press: "待配送"
  - app.wait: { target: "没有了呦~", scroll: true, timeoutMs: 30000 }
  - app.wait: { target: "#order_item_1", scroll: true, timeoutMs: 30000 }
  # The list sits under a collapsing header: two swipes bring it and the header fully down, the third is the pull.
  - app.swipe: { direction: down }
  - app.swipe: { direction: down }
  - app.swipe: { direction: down }
  - app.wait: { target: "正在加载中...", scroll: true, timeoutMs: 20000 }
expected:
  - Thirty orders load page by page; a pull to refresh starts the list over.
