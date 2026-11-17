/** @module test/helpers/https-sites-clipboard — the clipboard fixture pages of the HTTPS sites (spec 13 §2.1, D18): buttons that write the clipboard the ways a page can, each reporting its outcome in `document.title`, an input for the operator's own copy and other editing commands, frames loaded with the page (an `about:blank` one, a `srcdoc` one, a sandboxed same-origin one, an opaque sandboxed `srcdoc` one with another nested in it, a same-site cross-origin one and a cross-site one, which runs out of process), buttons that replace the document through `document.open`/`write` (verify #84 N2), whether the page came back from the back/forward cache (N3), and a frame page with its own copy button and an opaque sandboxed child (the cross-site one). */

/**
 * Selects the planted textarea after giving it `text`: `execCommand('copy')` without a `copy`
 * listener copies the selection, so a page controls what lands on the clipboard.
 */
const PLANT = (text: string): string =>
  `const t = document.getElementById('planted'); t.value = '${text}'; t.focus(); t.select();`;

/** Escapes `html` for a double-quoted attribute (`srcdoc`, `onclick`). */
const attr = (html: string): string => html.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

/**
 * An opaque sandboxed frame's document (`sandbox="allow-scripts"`, no `allow-same-origin`: with
 * Chromium's `IsolateSandboxedIframes` it runs out of process, verify #84 N1): its own planted text
 * and copy button (first, so it sits at the same offset in every such frame), a field and a button
 * that arms a `copy` listener, and optionally a nested frame.
 */
const SANDBOXED = (label: string, nested?: string): string => `<!doctype html><html><head>
<meta charset="utf-8"><title>sandboxed</title></head><body>
<button id="own-copy" onclick="const t = document.getElementById('planted'); t.focus(); t.select();
  document.title = 'own-copy:' + document.execCommand('copy')">copy</button>
<textarea id="planted">planted-by-${label}</textarea><input id="field" value="field text">
<button id="own-hijack" onclick="document.addEventListener('copy', (e) => { e.clipboardData.setData('text/plain', 'planted-by-${label}-hijack'); e.preventDefault(); });
  const i = document.getElementById('field'); i.focus(); i.select(); document.title = 'own-hijack:armed'">hijack</button>
${nested === undefined ? '' : `<iframe id="nested-sandbox" title="nested sandboxed" sandbox="allow-scripts" srcdoc="${attr(nested)}"></iframe>`}
</body></html>`;

/**
 * The document a `document.open`/`write` button puts in place of the page: the field and the
 * select-all button again, and `script`, which arms the page's rewrite of a person's next copy and
 * reports `<id>:armed`.
 */
const REOPENED = (id: string, script: string): string =>
  `<!doctype html><title>reopened</title><input id="field" value="field text">
<button id="select-all" onclick="const i = document.getElementById('field'); i.focus(); document.title = 'select-all:' + document.execCommand('selectAll')">select all</button>
<script>${script} document.title = '${id}:armed';</script>`;

/** A `copy` listener that rewrites the clipboard with `planted-by-<label>`. */
const HIJACK = (label: string): string =>
  `(e) => { e.clipboardData.setData('text/plain', 'planted-by-${label}'); e.preventDefault(); }`;

/**
 * Buttons that replace the document, each arming a rewrite of the person's next copy (verify #84
 * N2: `document.open` erases every listener of the window, the copy stopper included):
 * - `docopen-hijack` (the verifier's probe): `open`, `write`, `close`; a `document` listener.
 * - `docwrite-capture`: `write` alone opens the loaded document implicitly, and the written script
 *   adds a capturing `window` listener while the call still runs.
 * - `docopen-realm`: another realm's `open`/`write`/`close` on this document (a frame's
 *   `Document.prototype`; the frame goes away with the old document), and `document.oncopy`;
 *   `docopen-realm:refused` when the document was not replaced.
 */
const REPLACERS = [
  [
    'docopen-hijack',
    `document.open(); document.write(${JSON.stringify(REOPENED('docopen-hijack', `document.addEventListener('copy', ${HIJACK('docopen')});`))}); document.close();`,
  ],
  [
    'docwrite-capture',
    `document.write(${JSON.stringify(REOPENED('docwrite-capture', `addEventListener('copy', ${HIJACK('docwrite-capture')}, true);`))}); document.close();`,
  ],
  [
    'docopen-realm',
    `const p = document.getElementById('pre').contentWindow.Document.prototype; p.open.call(document);
  p.write.call(document, ${JSON.stringify(REOPENED('docopen-realm', `document.oncopy = ${HIJACK('docopen-realm')};`))}); p.close.call(document);
  if (!document.title.startsWith('docopen-realm:')) document.title = 'docopen-realm:refused';`,
  ],
]
  .map(([id, script]) => `<button id="${id}" onclick="${attr(script ?? '')}">${id}</button>`)
  .join('\n');

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>clipboard</title>
<script>
  // A reference a page can take before a live switch reaches it.
  window.__savedExec = Document.prototype.execCommand;
  window.__persisted = 'no';
  addEventListener('pageshow', (e) => { window.__persisted = e.persisted ? 'yes' : 'no'; });
</script></head><body>
<p id="text">selected text</p>
<input id="field" value="field text">
<textarea id="planted">planted</textarea>
<button id="write-text" onclick="navigator.clipboard.writeText('planted-by-writeText').then(
  () => { document.title = 'write-text:ok'; }, (e) => { document.title = 'write-text:' + e.name; })">writeText</button>
<button id="write-item" onclick="navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob(['planted-by-write'], { type: 'text/plain' }) })]).then(
  () => { document.title = 'write-item:ok'; }, (e) => { document.title = 'write-item:' + e.name; })">write</button>
<button id="exec-copy" onclick="document.addEventListener('copy', (e) => { e.clipboardData.setData('text/plain', 'planted-by-copy'); e.preventDefault(); }, { once: true });
  document.title = 'exec-copy:' + document.execCommand('copy')">copy</button>
<button id="exec-cut" onclick="document.addEventListener('cut', (e) => { e.clipboardData.setData('text/plain', 'planted-by-cut'); e.preventDefault(); }, { once: true });
  document.title = 'exec-cut:' + document.execCommand('cut')">cut</button>
<button id="iframe-copy" onclick="const f = document.createElement('iframe'); document.body.appendChild(f);
  document.addEventListener('copy', (e) => { e.clipboardData.setData('text/plain', 'planted-by-iframe'); e.preventDefault(); }, { once: true });
  document.title = 'iframe-copy:' + f.contentWindow.Document.prototype.execCommand.call(document, 'copy')">iframe copy</button>
<button id="hijack" onclick="document.addEventListener('copy', (e) => { e.clipboardData.setData('text/plain', 'planted-by-hijack'); e.preventDefault(); });
  document.title = 'hijack:armed'">rewrite the next copy</button>
<button id="select-all" onclick="const i = document.getElementById('field'); i.focus();
  document.title = 'select-all:' + document.execCommand('selectAll')">select all</button>
<button id="toctou-copy" onclick="${PLANT('planted-by-toctou')}
  let n = 0; const cmd = { toString() { return n++ === 0 ? 'bold' : 'copy'; } };
  document.title = 'toctou-copy:' + document.execCommand(cmd)">toctou</button>
<button id="toctou-cut" onclick="${PLANT('planted-by-toctou-cut')}
  let n = 0; const cmd = { toString() { return n++ === 0 ? 'selectAll' : 'cut'; } };
  document.title = 'toctou-cut:' + Reflect.apply(Document.prototype.execCommand, document, [cmd])">toctou cut</button>
<button id="case-copy" onclick="${PLANT('planted-by-case')}
  document.title = 'case-copy:' + [document.execCommand('COPY'), document.execCommand('Cut'), document.execCommand(new String('copy'))].join(',')">case</button>
<button id="call-copy" onclick="${PLANT('planted-by-call')}
  const exec = Document.prototype.execCommand;
  document.title = 'call-copy:' + [exec.call(document, 'copy'), Function.prototype.call.call(exec, document, 'copy'), exec.bind(document)('copy')].join(',')">call</button>
<button id="reflect-steal-copy" onclick="${PLANT('planted-by-reflect-steal')}
  const real = Reflect.apply; let stolen = null;
  Reflect.apply = function (t, self, a) { if (typeof t === 'function' && t.name === 'execCommand') stolen = t; return real(t, self, a); };
  try { document.execCommand('bold'); } finally { Reflect.apply = real; }
  document.title = 'reflect-steal-copy:' + (stolen || Document.prototype.execCommand).call(document, 'copy')">steal through Reflect.apply</button>
<button id="trap-steal-copy" onclick="${PLANT('planted-by-trap-steal')}
  let stolen = null;
  Object.defineProperty(Object.prototype, 'get', { configurable: true, value(t, k, r) { stolen = t; return Reflect.get(t, k, r); } });
  try { void Document.prototype.execCommand.name; } finally { delete Object.prototype.get; }
  document.title = 'trap-steal-copy:' + (stolen || Document.prototype.execCommand).call(document, 'copy')">steal through a trap</button>
<button id="lower-copy" onclick="${PLANT('planted-by-lower')}
  const real = String.prototype.toLowerCase; String.prototype.toLowerCase = function () { return 'bold'; };
  let out; try { out = document.execCommand('copy'); } finally { String.prototype.toLowerCase = real; }
  document.title = 'lower-copy:' + out">replaced toLowerCase</button>
<button id="string-copy" onclick="${PLANT('planted-by-string')}
  const real = window.String; window.String = function () { return 'bold'; };
  let out; try { out = document.execCommand('copy'); } finally { window.String = real; }
  document.title = 'string-copy:' + out">replaced String</button>
<button id="stop-override" onclick="Event.prototype.stopImmediatePropagation = function () {};
  document.addEventListener('copy', (e) => { e.clipboardData.setData('text/plain', 'planted-by-stop-override'); e.preventDefault(); });
  document.title = 'stop-override:armed'">disarm the copy stopper</button>
<button id="saved-copy"onclick="${PLANT('planted-by-saved')}
  document.title = 'saved-copy:' + window.__savedExec.call(document, 'copy')">saved</button>
<button id="pre-iframe-copy" onclick="${PLANT('planted-by-pre-iframe')}
  document.title = 'pre-iframe-copy:' + document.getElementById('pre').contentWindow.Document.prototype.execCommand.call(document, 'copy')">pre iframe</button>
<button id="srcdoc-copy" onclick="${PLANT('planted-by-srcdoc')}
  document.title = 'srcdoc-copy:' + document.getElementById('srcdoc').contentWindow.Document.prototype.execCommand.call(document, 'copy')">srcdoc</button>
<button id="sandbox-copy" onclick="${PLANT('planted-by-sandbox')}
  document.title = 'sandbox-copy:' + document.getElementById('sandboxed').contentWindow.Document.prototype.execCommand.call(document, 'copy')">sandboxed</button>
<button id="popup-open" onclick="const w = window.open('', 'clipboard-popup', 'popup,width=300,height=200');
  window.__popupExec = w && w.Document.prototype.execCommand;
  document.title = 'popup-open:' + (w ? 'opened' : 'blocked')">open popup</button>
<button id="popup-copy" onclick="${PLANT('planted-by-popup')}
  document.title = 'popup-copy:' + window.__popupExec.call(document, 'copy')">popup copy</button>
<button id="lying-write-text" onclick="let n = 0; const text = { toString() { return n++ === 0 ? '' : 'planted-by-lying-text'; } };
  navigator.clipboard.writeText(text).then(
  () => { document.title = 'lying-write-text:ok'; }, (e) => { document.title = 'lying-write-text:' + e.name; })">lying writeText</button>
<button id="proxy-write" onclick="const item = new ClipboardItem({ get 'text/plain'() { return new Blob(['planted-by-proxy'], { type: 'text/plain' }); } });
  const items = new Proxy([item], { get(t, k) { return Reflect.get(t, k); } });
  navigator.clipboard.write(items).then(
  () => { document.title = 'proxy-write:ok'; }, (e) => { document.title = 'proxy-write:' + e.name; })">proxy write</button>
${REPLACERS}
<button id="persisted" onclick="document.title = 'persisted:' + window.__persisted">restored from the back/forward cache?</button>
<button id="sandbox-add" onclick="const f = document.createElement('iframe'); f.id = 'sandbox-late'; f.title = 'late sandboxed';
  f.sandbox.add('allow-scripts'); f.srcdoc = ${attr(JSON.stringify(SANDBOXED('sandbox-late')))};
  f.onload = () => { document.title = 'sandbox-add:loaded'; }; document.body.appendChild(f);">add a sandboxed frame</button>
<iframe id="pre" title="pre"></iframe>
<iframe id="sandbox-srcdoc" title="sandboxed srcdoc" width="400" height="320" sandbox="allow-scripts" srcdoc="${attr(SANDBOXED('sandbox-srcdoc', SANDBOXED('sandbox-nested')))}"></iframe>
<iframe id="srcdoc" title="srcdoc" srcdoc="<p>srcdoc</p>"></iframe>
<iframe id="sandboxed" title="sandboxed" sandbox="allow-same-origin"></iframe>
<iframe id="same-site" title="same site" src="https://sub.site-a.test/clipboard-frame"></iframe>
<iframe id="cross-site" title="cross site" src="https://cdn-a.test/clipboard-frame"></iframe>
</body></html>`;

/**
 * The back/forward-cache page (verify #84 N3): the main document's copy buttons, an in-process
 * frame and a cross-site one, and whether the page came back from the cache. Smaller than `PAGE`:
 * after a restore Patchright 1.63 loses track of pages with more frames (measured: `goBack` never
 * settles, or a frame is missing from `page.frames()`).
 */
const RESTORE = `<!doctype html><html><head><meta charset="utf-8"><title>restore</title>
<script>
  window.__persisted = 'no';
  addEventListener('pageshow', (e) => { window.__persisted = e.persisted ? 'yes' : 'no'; });
</script></head><body>
<input id="field" value="field text">
<textarea id="planted">planted</textarea>
<button id="persisted" onclick="document.title = 'persisted:' + window.__persisted">restored?</button>
<button id="exec-copy" onclick="${PLANT('planted-by-restored')} document.title = 'exec-copy:' + document.execCommand('copy')">copy</button>
<button id="pre-iframe-copy" onclick="${PLANT('planted-by-restored-pre')}
  document.title = 'pre-iframe-copy:' + document.getElementById('pre').contentWindow.Document.prototype.execCommand.call(document, 'copy')">pre iframe</button>
<button id="write-text" onclick="navigator.clipboard.writeText('planted-by-writeText').then(
  () => { document.title = 'write-text:ok'; }, (e) => { document.title = 'write-text:' + e.name; })">writeText</button>
<button id="hijack" onclick="document.addEventListener('copy', (e) => { e.clipboardData.setData('text/plain', 'planted-by-hijack'); e.preventDefault(); });
  document.title = 'hijack:armed'">rewrite the next copy</button>
<button id="select-all" onclick="const i = document.getElementById('field'); i.focus();
  document.title = 'select-all:' + document.execCommand('selectAll')">select all</button>
<iframe id="pre" title="pre"></iframe>
<iframe id="cross-site" title="cross site" src="https://cdn-a.test/clipboard-frame"></iframe>
</body></html>`;

/**
 * A page meant to be framed: its own planted text and copy buttons, reported in its own title. The
 * cross-site one also holds an opaque sandboxed frame. The same-site one does not: under Chromium's
 * default process model (that frame out of process), Patchright 1.63 loses the page after a
 * back/forward-cache restore when an in-process child frame holds such a frame (measured: `goBack`
 * never settles), which the N3 test needs.
 */
const FRAME = (
  site: string,
): string => `<!doctype html><html><head><meta charset="utf-8"><title>frame</title></head><body>
<textarea id="planted">planted-by-frame-${site}</textarea>
<button id="frame-copy" onclick="const t = document.getElementById('planted'); t.focus(); t.select();
  document.title = 'frame-copy:' + document.execCommand('copy')">frame copy</button>
<iframe id="nested" title="nested"></iframe>
<button id="nested-copy" onclick="const t = document.getElementById('planted'); t.value = 'planted-by-nested-${site}'; t.focus(); t.select();
  document.title = 'nested-copy:' + document.getElementById('nested').contentWindow.Document.prototype.execCommand.call(document, 'copy')">nested copy</button>
${site === 'cdn-a.test' ? `<iframe id="sandbox-child" title="sandboxed child" sandbox="allow-scripts" srcdoc="${attr(SANDBOXED(`sandbox-child-${site}`))}"></iframe>` : ''}
</body></html>`;

const html = (body: string): Response =>
  new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

/** `/clipboard`, `/clipboard-frame` and `/clipboard-restore` on every fixture site; `null` otherwise. */
export function clipboardRoute(site: string, path: string): Response | null {
  if (path === '/clipboard') return html(PAGE);
  if (path === '/clipboard-frame') return html(FRAME(site));
  if (path === '/clipboard-restore') return html(RESTORE);
  return null;
}
