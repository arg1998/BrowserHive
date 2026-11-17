/** @module test/helpers/https-sites-clipboard — the clipboard fixture pages of the HTTPS sites (spec 13 §2.1, D18): buttons that write the clipboard the ways a page can, each reporting its outcome in `document.title`, an input for the operator's own copy and other editing commands, frames loaded with the page (an `about:blank` one, a `srcdoc` one, a sandboxed same-origin one, a same-site cross-origin one and a cross-site one, which runs out of process) and a frame page with its own copy button. */

/**
 * Selects the planted textarea after giving it `text`: `execCommand('copy')` without a `copy`
 * listener copies the selection, so a page controls what lands on the clipboard.
 */
const PLANT = (text: string): string =>
  `const t = document.getElementById('planted'); t.value = '${text}'; t.focus(); t.select();`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>clipboard</title>
<script>
  // A reference a page can take before a live switch reaches it.
  window.__savedExec = Document.prototype.execCommand;
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
<iframe id="pre" title="pre"></iframe>
<iframe id="srcdoc" title="srcdoc" srcdoc="<p>srcdoc</p>"></iframe>
<iframe id="sandboxed" title="sandboxed" sandbox="allow-same-origin"></iframe>
<iframe id="same-site" title="same site" src="https://sub.site-a.test/clipboard-frame"></iframe>
<iframe id="cross-site" title="cross site" src="https://cdn-a.test/clipboard-frame"></iframe>
</body></html>`;

/** A page meant to be framed: its own planted text and copy buttons, reported in its own title. */
const FRAME = (
  site: string,
): string => `<!doctype html><html><head><meta charset="utf-8"><title>frame</title></head><body>
<textarea id="planted">planted-by-frame-${site}</textarea>
<button id="frame-copy" onclick="const t = document.getElementById('planted'); t.focus(); t.select();
  document.title = 'frame-copy:' + document.execCommand('copy')">frame copy</button>
<iframe id="nested" title="nested"></iframe>
<button id="nested-copy" onclick="const t = document.getElementById('planted'); t.value = 'planted-by-nested-${site}'; t.focus(); t.select();
  document.title = 'nested-copy:' + document.getElementById('nested').contentWindow.Document.prototype.execCommand.call(document, 'copy')">nested copy</button>
</body></html>`;

const html = (body: string): Response =>
  new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

/** `/clipboard` and `/clipboard-frame` on every fixture site; `null` for any other path. */
export function clipboardRoute(site: string, path: string): Response | null {
  if (path === '/clipboard') return html(PAGE);
  if (path === '/clipboard-frame') return html(FRAME(site));
  return null;
}
