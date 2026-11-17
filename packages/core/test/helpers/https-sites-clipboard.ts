/** @module test/helpers/https-sites-clipboard — the clipboard fixture page of the HTTPS sites (spec 13 §2.1, D18): buttons that write the clipboard the ways a page can, each reporting its outcome in `document.title`, and an input for the operator's own copy and other editing commands. */

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>clipboard</title></head><body>
<p id="text">selected text</p>
<input id="field" value="field text">
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
</body></html>`;

/** `/clipboard` on every fixture site; `null` for any other path. */
export function clipboardRoute(path: string): Response | null {
  if (path !== '/clipboard') return null;
  return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
