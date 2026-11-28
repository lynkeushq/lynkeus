# case impact: the cases a change reaches

After changing the app's code, or to review a branch:

```sh
npx lynkeus case impact --base main                     # cases the diff reaches, and reached screens no case covers
npx lynkeus case run $(npx lynkeus case impact --base main --files)
```

It crosses the screens the diff touches or imports with the screens each case covers (`case run` keeps those in `.lynkeus/seen`). A string-table change counts only for the keys and texts it changed; a change of only testIDs or accessibility labels reaches only the cases naming them. Run what it lists, fix what broke, and write a case for each reached screen no case covers (`case new`).

A base git cannot diff against (unknown ref, shallow checkout) is an error, never "nothing changed": fetch it (`git fetch --unshallow`) or pass the right `--base`.
