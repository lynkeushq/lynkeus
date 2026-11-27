# App commands: a known start with qa.register and app.call

Sign in, reset or seed state through a command the app registers, not by driving forms in every case (that also keeps iOS's Save Password prompt away):

```ts
import { qa } from 'lynkeus-agent'
qa.register('signIn', async ({ user }) => { /* … */ return { ok: true } })
```

`app.call: { command: signIn, params: {...}, expect?, as? }` runs it. Right after a launch, a command not registered yet is asked again for up to 5 s. Do not register inside `if (__DEV__)`: FastSim runs a release bundle and would miss it; outside it the commands are inert in production builds.
