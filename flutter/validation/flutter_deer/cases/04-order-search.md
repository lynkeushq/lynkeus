---
id: deer-order-search
title: "flutter_deer: search with typing, an empty query refused, the answer mocked"
description: >
  Submitting an empty search shows a toast; a query goes to the search API, which the case answers with a mock, and
  the results are listed.
---
steps:
  - app.mock: { route: "GET /search/repositories", body: '{"total_count":2,"incomplete_results":false,"items":[{"id":1,"name":"deer_one"},{"id":2,"name":"deer_two"}]}' }
  - app.deeplink: "/order/search"
  - app.see: { testId: search_text_field }
  - app.press: "搜索"
  - app.see: { text: "搜索关键字不能为空" }
  - app.type: { target: "#search_text_field", text: "deer", submit: true }
  - app.see: { text: "deer_one" }
  - app.see: { request: "GET /search/repositories" }
  - app.press: "#search_back"
expected:
  - The empty query is refused; the mocked results are listed.
