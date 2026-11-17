export const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
  'referrer-policy': 'no-referrer',
} as const;

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

// No web fonts and no outside requests: the page is served from 127.0.0.1 and has to work offline.
const STYLE = `
:root{color-scheme:dark light;--bg:#0e0f12;--card:#17181d;--line:#2a2c33;--text:#e8e9ee;--muted:#a3a6b1;--faint:#8a8d98;--box:#1b1d22;--box-line:#24262d;--link:#a5a8ff;--link-hover:#c7c9ff}
@media (prefers-color-scheme:light){:root{--bg:#f4f5f8;--card:#ffffff;--line:#d9dbe3;--text:#16171c;--muted:#454854;--faint:#575a66;--box:#f1f2f6;--box-line:#e0e2e9;--link:#3a4bd1;--link-hover:#2434a8}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;padding:16px;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--text);font-family:Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:32px;display:flex;flex-direction:column;gap:22px}
.icon{position:relative;width:56px;height:56px}
.badge{position:absolute;right:-6px;bottom:-6px;width:24px;height:24px;border-radius:12px;border:3px solid var(--card);display:flex;align-items:center;justify-content:center}
.head{display:flex;flex-direction:column;gap:8px}
h1{margin:0;font-size:24px;line-height:1.25;font-weight:600;letter-spacing:-.01em}
p{margin:0}
.lead{font-size:15px;line-height:1.55;color:var(--muted)}
.lead b{color:var(--text);font-weight:500;overflow-wrap:anywhere}
.try{display:flex;flex-direction:column;gap:10px}
.try span{font-size:13px;color:var(--muted)}
.cmd{display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--box);border:1px solid var(--box-line);border-radius:12px}
.cmd svg{flex:none}
code{font-family:"Geist Mono",ui-monospace,Menlo,monospace;font-size:13px;color:var(--text);overflow-wrap:anywhere}
.fine{font-size:13px;line-height:1.5;color:var(--faint)}
a{color:var(--link)}a:hover{color:var(--link-hover)}
`;

const ICON = (id: string, bodyOpacity: string, badge: string, mark: string) =>
  `<div class="icon"><svg width="56" height="56" viewBox="100 100 824 824" role="img" aria-label="fastsim"><defs><linearGradient id="${id}-tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2042"/><stop offset="1" stop-color="#0c0d12"/></linearGradient><linearGradient id="${id}-body" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#b3bdff"/><stop offset="1" stop-color="#5a6be0"/></linearGradient></defs><rect x="104" y="104" width="816" height="816" rx="184" fill="url(#${id}-tile)" stroke="#ffffff" stroke-opacity="0.08" stroke-width="6"/><g transform="rotate(12 512 512)"><rect x="292" y="150" width="440" height="724" rx="100" fill="url(#${id}-body)"${bodyOpacity}/><rect x="462" y="196" width="100" height="26" rx="13" fill="#0c0d12" fill-opacity="0.9"/><path d="M584 272 L424 540 L520 540 L452 752 L608 476 L512 476 Z" fill="#0c0d12"/></g></svg><span class="badge" style="background:${badge}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${mark}</svg></span></div>`;

const TERMINAL = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color:var(--muted)"><path d="M4 17l6-5-6-5"/><path d="M12 19h8"/></svg>`;

const shell = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;

export type SignedInPage = { command: string; cloud: string; organization?: string; email?: string };

export const signedInPage = (o: SignedInPage): string => {
  const who =
    o.organization && o.email
      ? `The lynkeus CLI is signed in to <b>${escapeHtml(o.organization)}</b> as <b>${escapeHtml(o.email)}</b>.`
      : 'The lynkeus CLI is signed in.';
  const host = new URL(o.cloud).host;
  return shell(
    'Signed in to lynkeus',
    `${ICON('ok', '', '#2f9e6b', '<path d="M20 6L9 17l-5-5"/>')}<div class="head"><h1>You're signed in</h1><p class="lead">${who} Go back to your terminal: it carries on from here.</p></div><div class="cmd">${TERMINAL}<code>${escapeHtml(o.command)}</code></div><p class="fine">You can close this tab. Did not start this? Disconnect it under <a href="${escapeHtml(o.cloud)}/#members">Members</a> on ${escapeHtml(host)}.</p>`,
  );
};

export const failedPage = (reason: string): string =>
  shell(
    'Sign-in did not finish',
    `${ICON('no', ' fill-opacity="0.55"', '#b4704a', '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>')}<div class="head"><h1>The sign-in did not finish</h1><p class="lead">${reason}</p></div><div class="try"><span>To try again, run this in your terminal:</span><div class="cmd">${TERMINAL}<code>npx lynkeus login</code></div></div><p class="fine">You can close this tab.</p>`,
  );

export const failureReason = {
  denied: 'You chose <b>Deny</b>, so the lynkeus CLI is not signed in. Nothing was shared with it.',
  state: 'This answer was not for the sign-in this terminal started, so it was ignored.',
  service: (text: string) => escapeHtml(text),
  exchange: (host: string, reason: string) => `${escapeHtml(host)} did not accept the sign-in: ${escapeHtml(reason)}.`,
};
