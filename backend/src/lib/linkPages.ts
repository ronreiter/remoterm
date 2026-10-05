// Server-rendered pages for the CLI device-code sign-in (`remoterm login`).
// Self-contained (inline CSS/SVG, one tiny inline script) so they work without the web app.

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const CSS = `
:root{--bg:#1e1e2e;--surface:#313244;--card:#24243a;--text:#cdd6f4;--sub:#a6adc8;--accent:#89b4fa;--green:#a6e3a1;--red:#f38ba8;--border:#45475a;--on-accent:#1e1e2e}
@media (prefers-color-scheme:light){:root{--bg:#eff1f5;--surface:#e6e9ef;--card:#ffffff;--text:#4c4f69;--sub:#6c6f85;--accent:#1e66f5;--green:#40a02b;--red:#d20f39;--border:#ccd0da;--on-accent:#ffffff}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px 16px}
main{width:100%;max-width:400px}
.brand{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:28px;font-weight:600;font-size:17px;letter-spacing:.2px}
.mark{width:34px;height:34px;border-radius:9px;background:var(--surface);border:1px solid var(--border);display:grid;place-items:center;color:var(--accent);font:600 14px/1 ui-monospace,SFMono-Regular,Menlo,monospace}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px 24px 24px;box-shadow:0 10px 30px rgba(0,0,0,.18)}
h1{font-size:20px;margin:0 0 6px;text-align:center}
.lead{color:var(--sub);margin:0 0 22px;text-align:center}
label{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--sub);margin-bottom:8px}
.code{width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:14px 12px;text-align:center;font:600 28px/1.1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em;text-transform:uppercase;outline:none}
.code:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent)}
.btn{margin-top:16px;width:100%;display:flex;align-items:center;justify-content:center;gap:10px;background:var(--accent);color:var(--on-accent);border:0;border-radius:10px;padding:12px 14px;font-family:inherit;font-size:15px;font-weight:600;line-height:1;cursor:pointer}
.btn:hover{filter:brightness(1.06)}
.btn svg{width:18px;height:18px;fill:currentColor}
.alert{display:flex;gap:8px;align-items:flex-start;background:color-mix(in srgb,var(--red) 14%,transparent);color:var(--red);border:1px solid color-mix(in srgb,var(--red) 35%,transparent);border-radius:10px;padding:10px 12px;margin-bottom:16px;font-size:14px}
.hint{margin:18px 0 0;font-size:13px;color:var(--sub);text-align:center}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:1px 6px;color:var(--text)}
.status{display:grid;place-items:center;width:56px;height:56px;border-radius:50%;margin:0 auto 16px}
.status svg{width:28px;height:28px;fill:none;stroke:currentColor;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}
.ok{color:var(--green);background:color-mix(in srgb,var(--green) 15%,transparent)}
.bad{color:var(--red);background:color-mix(in srgb,var(--red) 15%,transparent)}
.who{color:var(--text);font-weight:600}
`;

const GITHUB_MARK =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const CROSS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';

// Keeps the code as XXXX-XXXX while typing or pasting.
const FORMAT_SCRIPT =
  `<script>(()=>{const i=document.getElementById('user_code');if(!i)return;` +
  `i.addEventListener('input',()=>{const r=i.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8);` +
  `i.value=r.length>4?r.slice(0,4)+'-'+r.slice(4):r});})()</script>`;

function layout(title: string, body: string, script = ''): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="dark light"><meta name="robots" content="noindex">` +
    `<title>${esc(title)} · Remoterm</title><style>${CSS}</style></head>` +
    `<body><main><div class="brand"><span class="mark">&gt;_</span>Remoterm</div>` +
    `<div class="card">${body}</div></main>${script}</body></html>`
  );
}

export function linkFormPage(code: string, error = ''): string {
  return layout(
    'Sign in to the CLI',
    `<h1>Sign in to the Remoterm CLI</h1>` +
      `<p class="lead">Check that this code matches the one in your terminal.</p>` +
      (error ? `<div class="alert" role="alert">${esc(error)}</div>` : '') +
      `<form method="post" action="/link">` +
      `<label for="user_code">Device code</label>` +
      `<input class="code" id="user_code" name="user_code" value="${esc(code)}" placeholder="ABCD-EFGH" maxlength="9" ` +
      `autocomplete="off" autocapitalize="characters" spellcheck="false" ${code ? '' : 'autofocus '}required>` +
      `<button class="btn" type="submit">${GITHUB_MARK}Continue with GitHub</button>` +
      `</form>` +
      `<p class="hint">Only continue if you just ran <code>remoterm login</code> yourself.</p>`,
    FORMAT_SCRIPT,
  );
}

export function linkDonePage(login: string): string {
  return layout(
    'Signed in',
    `<div class="status ok">${CHECK}</div>` +
      `<h1>You're signed in</h1>` +
      `<p class="lead">The CLI is now signed in as <span class="who">@${esc(login)}</span>.</p>` +
      `<p class="hint">Return to your terminal. You can close this tab.</p>`,
  );
}

export function linkExpiredPage(): string {
  return layout(
    'Code expired',
    `<div class="status bad">${CROSS}</div>` +
      `<h1>This code expired</h1>` +
      `<p class="lead">Codes are valid for 10 minutes and work once.</p>` +
      `<p class="hint">Run <code>remoterm login</code> again to get a new code.</p>`,
  );
}
