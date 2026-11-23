---
id: deer-shop-avatar
title: "flutter_deer: the shop page's avatar, a network image"
description: >
  The user API is mocked with an avatar from GitHub; the shop page loads it through cached_network_image, whose
  cache is a sqflite database. A device fetches it; a host draws it only from a recording (case run --net-cache),
  which is what a pixel comparison needs. No step asserts the picture: the element tree cannot tell it from its
  placeholder.
---
steps:
  - app.mock: { route: "GET /users/simplezhli", body: '{"login":"simplezhli","name":"Deer","avatar_url":"https://github.com/simplezhli.png"}' }
  - app.deeplink: "/shop"
  - app.see: { text: "店铺设置" }
expected:
  - The avatar is drawn.
