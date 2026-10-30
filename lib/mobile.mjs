export const MOBILE_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d1117">
<title>STM32 无线串口</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0d1117; color: #c9d1d9; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-text-size-adjust: 100%; }
  header { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: rgba(13,17,23,0.96); border-bottom: 1px solid #21262d; }
  header b { font-size: 15px; }
  .pill { padding: 2px 8px; border-radius: 999px; font-size: 12px; background: #21262d; }
  .ok { color: #3fb950; } .bad { color: #f85149; } .warn { color: #d29922; }
  main { padding: 10px 12px 96px; display: flex; flex-direction: column; gap: 10px; }
  .card { border: 1px solid #21262d; border-radius: 12px; background: #10151c; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  button { font: inherit; padding: 8px 12px; border-radius: 9px; border: 1px solid #30363d; background: #1b222c; color: inherit; }
  button.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  button.danger { background: #3d1f22; border-color: #6b2b2f; color: #ffb4ae; }
  button:disabled { opacity: .45; }
  input, textarea, select { font: inherit; padding: 8px 10px; border-radius: 9px; border: 1px solid #30363d; background: #0d1117; color: inherit; }
  #term { height: 46vh; overflow-y: auto; background: #05070a; border: 1px solid #21262d; border-radius: 10px; padding: 8px; font: 12px/1.5 ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-all; }
  .sent { background: rgba(90,169,255,.16); border-radius: 3px; }
  .dim { opacity: .6; font-size: 12px; }
  footer { position: fixed; left: 0; right: 0; bottom: 0; display: flex; gap: 8px; padding: 8px 12px calc(8px + env(safe-area-inset-bottom)); background: rgba(13,17,23,0.97); border-top: 1px solid #21262d; }
  footer input { flex: 1; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<header>
  <b>STM32 无线串口</b>
  <span class="pill" id="link">–</span>
  <span class="pill" id="serial">–</span>
  <span style="flex:1"></span>
  <span class="pill" id="rssi">–</span>
</header>

<main>
  <div class="card">
    <div class="row">
      <button id="btnSerial">打开串口</button>
      <select id="transport">
        <option value="wifi">无线（ESP 管道）</option>
        <option value="local">本地 COM</option>
      </select>
      <button id="btnPing">PING</button>
      <button id="btnRun">RUN</button>
    </div>
    <div class="dim" id="hint">等待连接…</div>
  </div>

  <div id="term"></div>

  <div class="card">
    <div class="row">
      <button id="btnFollow" class="primary">跟随 ✓</button>
      <button id="btnClear">清屏</button>
      <span class="dim" id="count">0 行</span>
    </div>
  </div>

  <div class="card hidden" id="repeatCard">
    <div class="dim">连续发送</div>
    <div class="row">
      <input id="repeatGap" type="number" inputmode="numeric" value="500" style="width:90px"> <span class="dim">ms</span>
      <input id="repeatCount" type="number" inputmode="numeric" value="-1" style="width:90px"> <span class="dim">次（-1 无限）</span>
    </div>
    <div class="row">
      <button id="btnRepeatStart" class="primary">开始</button>
      <button id="btnRepeatStop" class="danger">停止</button>
      <span class="dim" id="repeatState">未运行</span>
    </div>
  </div>

  <div class="card hidden" id="macroCard">
    <div class="dim">多步命令（一行一条）</div>
    <textarea id="macroText" rows="6" placeholder="P90&#10;A-165&#10;L148"></textarea>
    <div class="row">
      <input id="macroGap" type="number" inputmode="numeric" value="300" style="width:90px"> <span class="dim">ms</span>
      <select id="macroEol">
        <option value="&#10;">换行</option>
        <option value="&#13;&#10;">回车换行</option>
        <option value="">不追加</option>
      </select>
    </div>
    <div class="row">
      <button id="btnMacroSave">保存</button>
      <button id="btnMacroRun" class="primary">保存并执行</button>
      <button id="btnMacroStop" class="danger">停止</button>
      <span class="dim" id="macroState">0 行</span>
    </div>
  </div>

  <div class="row">
    <button id="btnToggleRepeat">连续发送…</button>
    <button id="btnToggleMacro">多步命令…</button>
  </div>
</main>

<footer>
  <input id="send" placeholder="输入后回车发送" autocomplete="off">
  <button id="btnClearAfter">发后清空 ✓</button>
  <button id="btnSend" class="primary">发送</button>
</footer>

<script>
(function () {
  var params = new URLSearchParams(location.search);
  var token = params.get('t') || localStorage.getItem('dshtoken') || '';
  if (params.get('t')) localStorage.setItem('dshtoken', params.get('t'));
  var api = function (path) { return path + (path.indexOf('?') >= 0 ? '&' : '?') + 't=' + encodeURIComponent(token); };

  var el = function (id) { return document.getElementById(id); };
  var state = { serialOpen: false, transport: 'wifi', link: '', macroText: '', lines: 0, follow: true };
  var pending = [];

  function post(action, params2) {
    return fetch('/action?t=' + encodeURIComponent(token), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: action, params: params2 || {} })
    }).then(function (r) { return r.json(); })
      .then(function (body) { if (!body.ok) throw new Error(body.error || '失败'); return body.result; });
  }

  function render() {
    el('link').textContent = 'link=' + (state.link || '?');
    el('link').className = 'pill ' + (state.link ? 'ok' : 'warn');
    el('serial').textContent = state.serialOpen ? '串口已开' : '串口关';
    el('serial').className = 'pill ' + (state.serialOpen ? 'ok' : 'bad');
    el('btnSerial').textContent = state.serialOpen ? '关闭串口' : '打开串口';
    el('transport').value = state.transport || 'wifi';
    el('btnFollow').textContent = state.follow ? '跟随 ✓' : '跟随 ✗';
    el('btnFollow').className = state.follow ? 'primary' : '';
    el('count').textContent = state.lines + ' 行';
    el('hint').textContent = state.serialOpen
      ? '已连接；发送/连续/多步都会经过电脑转发到 ESP。'
      : '点「打开串口」开始（会同步到电脑面板）。';
  }

  function append(entry) {
    var term = el('term');
    var atBottom = term.scrollTop + term.clientHeight >= term.scrollHeight - 8;
    var div = document.createElement('div');
    if (entry.sent) div.className = 'sent';
    div.textContent = entry.text;
    term.appendChild(div);
    while (term.childElementCount > 600) term.removeChild(term.firstChild);
    state.lines += 1;
    el('count').textContent = state.lines + ' 行';
    if (state.follow && (atBottom || entry.sent)) term.scrollTop = term.scrollHeight;
  }

  function applyState(next) {
    if (!next) return;
    state.serialOpen = Boolean(next.serialOpen);
    state.transport = next.transport || state.transport;
    var wifi = next.wifi || {};
    state.link = (next.settings && next.settings.linkMode) || next.linkMode || state.link;
    /* 发后清空与电脑面板共用同一个设置 */
    state.sendClear = wifi.sendClear !== false;
    el('btnClearAfter').textContent = state.sendClear ? '发后清空 ✓' : '发后清空 ✗';
    el('btnClearAfter').className = state.sendClear ? 'primary' : '';
    el('rssi').textContent = wifi.rssi ? wifi.rssi + ' dBm' : (next.settings && next.settings.espHost) || '';
    var run = wifi.repeatRun;
    el('repeatState').textContent = run && run.running
      ? '已发 ' + run.sent + (run.count === -1 ? '（无限）' : '/' + run.count)
      : '未运行';
    var mrun = wifi.macroRun;
    var macroLines = (el('macroText').value || '').split('\n').filter(function (l) { return l.length; }).length;
    el('macroState').textContent = mrun && mrun.running ? '执行中 ' + mrun.step + '/' + mrun.total : macroLines + ' 行';
    if (wifi.macro && wifi.macro.lines && !state.macroLoaded) {
      el('macroText').value = wifi.macro.lines.join('\n');
      el('macroGap').value = wifi.macro.intervalMs || 300;
      state.macroLoaded = true;
    }
    render();
  }

  function connect() {
    var es = new EventSource(api('/stream'));
    es.addEventListener('state', function (e) { try { applyState(JSON.parse(e.data)); } catch (err) {} });
    es.addEventListener('log', function (e) {
      try { var entry = JSON.parse(e.data); if (entry.channel === 'serial' || entry.channel === 'flash') append(entry); } catch (err) {}
    });
    es.onerror = function () { el('hint').textContent = '连接断开，正在重连…'; };
  }

  function sendNow() {
    var box = el('send');
    var text = box.value;
    if (!text) return;
    post('serial-write', { text: text + '\n' }).then(function () {
      if (state.sendClear !== false) box.value = '';
    }).catch(function (err) { el('hint').textContent = '发送失败：' + err.message; });
  }

  el('btnClearAfter').onclick = function () {
    var next = state.sendClear === false;
    post('set-send-clear', { on: next })
      .then(function () { state.sendClear = next; el('btnClearAfter').textContent = next ? '发后清空 ✓' : '发后清空 ✗'; el('btnClearAfter').className = next ? 'primary' : ''; })
      .catch(function (err) { el('hint').textContent = '切换失败：' + err.message; });
  };
  el('btnSend').onclick = sendNow;
  el('send').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendNow(); });
  el('btnPing').onclick = function () { post('serial-write', { text: 'PING\n' }).catch(function () {}); };
  el('btnRun').onclick = function () { post('serial-write', { text: 'RUN\n' }).catch(function () {}); };
  el('btnClear').onclick = function () { el('term').textContent = ''; state.lines = 0; render(); };
  el('btnFollow').onclick = function () { state.follow = !state.follow; if (state.follow) el('term').scrollTop = el('term').scrollHeight; render(); };
  el('transport').onchange = function () {
    post('set-transport', { transport: el('transport').value }).catch(function () {});
  };
  el('btnSerial').onclick = function () {
    var wanted = !state.serialOpen;
    post(wanted ? 'monitor-start' : 'monitor-stop', {})
      .then(function () { state.serialOpen = wanted; render(); })
      .catch(function (err) { el('hint').textContent = (wanted ? '打开' : '关闭') + '失败：' + err.message; });
  };
  el('btnToggleRepeat').onclick = function () { el('repeatCard').classList.toggle('hidden'); };
  el('btnToggleMacro').onclick = function () { el('macroCard').classList.toggle('hidden'); };
  el('btnRepeatStart').onclick = function () {
    var text = el('send').value || '';
    if (!text) { el('hint').textContent = '先在下发送框里写好要重复的内容'; return; }
    post('run-repeat', { text: text, intervalMs: Number(el('repeatGap').value) || 500, count: Number(el('repeatCount').value) }).catch(function (err) {
      el('hint').textContent = '连续发送失败：' + err.message;
    });
  };
  el('btnRepeatStop').onclick = function () { post('stop-repeat', {}).catch(function () {}); };
  el('btnMacroSave').onclick = function () {
    post('set-macro', { lines: el('macroText').value.split('\n'), intervalMs: Number(el('macroGap').value) || 300, eol: el('macroEol').value })
      .then(function () { el('hint').textContent = '多步命令已保存'; })
      .catch(function (err) { el('hint').textContent = '保存失败：' + err.message; });
  };
  el('btnMacroRun').onclick = function () {
    post('set-macro', { lines: el('macroText').value.split('\n'), intervalMs: Number(el('macroGap').value) || 300, eol: el('macroEol').value })
      .then(function () { return post('run-macro', {}); })
      .catch(function (err) { el('hint').textContent = '多步执行失败：' + err.message; });
  };
  el('btnMacroStop').onclick = function () { post('stop-macro', {}).catch(function () {}); };

  fetch(api('/state')).then(function (r) { return r.json(); }).then(applyState).catch(function () {});
  connect();
  setInterval(function () {
    fetch(api('/state')).then(function (r) { return r.json(); }).then(applyState).catch(function () {});
  }, 4000);
})();
</script>
</body>
</html>`
