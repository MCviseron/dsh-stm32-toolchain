window.__ModuleLoader__.load({
  id: "dsh-stm32-toolchain",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var React = require("react");
    var h = React.createElement;

    // Official DSH primitives when the host injects them; a plain checkbox is the
    // fallback so the panel still works on a host without the package.
    var primitives = null;
    try { primitives = require("@deepseek-ai/dsh-client-ui-primitives"); } catch (error) { primitives = null; }
    var PrimitiveSwitch = primitives && primitives.Switch ? primitives.Switch : null;
    var PrimitiveMenu = primitives && primitives.Menu ? primitives.Menu : null;

    /**
     * Themed dropdown: the official Menu when the host injects the primitives,
     * else a rounded native select. Never the bare UA control.
     */
    function Dropdown(props) {
      var openBox = React.useState(false);
      var open = openBox[0], setOpen = openBox[1];
      var options = props.options || [];
      var current = null;
      options.forEach(function (option) { if (option.id === props.value) current = option; });

      var trigger = h("button", {
        type: "button",
        disabled: !!props.disabled,
        title: props.title || "",
        onClick: function () { setOpen(!open); },
        style: Object.assign({}, S.selectBtn, props.width ? { width: props.width } : null, props.disabled ? { opacity: 0.55, cursor: "not-allowed" } : null)
      },
        h("span", { style: { flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
          current ? current.label : (props.placeholder || "")),
        h("span", { style: { opacity: 0.45, fontSize: "10px" } }, open ? "▲" : "▼")
      );

      if (!PrimitiveMenu) {
        return h("select", {
          style: Object.assign({}, S.selectBtn, { appearance: "none", colorScheme: "inherit" }, props.width ? { width: props.width } : null),
          value: props.value === undefined ? "" : props.value,
          disabled: !!props.disabled,
          onChange: function (event) { props.onChange(event.target.value); }
        }, options.map(function (option) { return h("option", { key: option.id, value: option.id }, option.label); }));
      }

      return h(PrimitiveMenu, {
        open: open,
        anchor: trigger,
        items: options.map(function (option) { return { id: option.id, label: option.label, disabled: !!option.disabled }; }),
        selectedId: props.value,
        onSelect: function (id) { setOpen(false); props.onChange(id); },
        onClose: function () { setOpen(false); },
        align: "start",
        side: "bottom",
        portal: true,
        dense: true
      });
    }

    /** Label on the left, control on the right (stretch = control pinned to the row end). */
    function Toggle(props) {
      var rowStyle = {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: props.stretch ? "space-between" : "flex-start",
        gap: "10px",
        width: props.stretch ? "100%" : undefined,
        fontSize: "12px",
        cursor: "pointer"
      };
      var label = props.label ? h("span", { style: { opacity: 0.8 } }, props.label) : null;
      var control = PrimitiveSwitch
        ? h(PrimitiveSwitch, {
          checked: !!props.checked,
          onChange: function (next) { props.onChange(next); },
          label: props.label,
          disabled: !!props.disabled,
          title: props.title || props.label
        })
        : h("input", { type: "checkbox", checked: !!props.checked, disabled: !!props.disabled, onChange: function (event) { props.onChange(event.target.checked); } });
      return h("label", { style: rowStyle }, label, control);
    }

    var API = "/api/dsh-stm32-toolchain";
    var ID = "stm32-toolchain";
    var PHASE = {
      idle: { color: "#8b949e", label: "空闲" },
      building: { color: "#4c9aff", label: "编译中" },
      flashing: { color: "#f5a623", label: "烧录中" },
      running: { color: "#3fb950", label: "运行中" },
      error: { color: "#f85149", label: "出错" },
      offline: { color: "#6e7681", label: "未连接" }
    };
    var CHANNEL = { build: "#9aa4b2", flash: "#e3b341", serial: "#5aa9ff", sys: "#6e7681" };

    function post(action, params) {
      return fetch(API + "/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: action, params: params || {} })
      }).then(function (r) { return r.json(); });
    }

    function clock(ms) {
      if (!ms) return "—";
      var d = new Date(ms);
      return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2);
    }

    function size(bytes) {
      if (!bytes) return "—";
      return bytes >= 1048576 ? (bytes / 1048576).toFixed(2) + " MB" : (bytes / 1024).toFixed(1) + " KB";
    }

    var S = {
      root: { display: "flex", flexDirection: "column", gap: "12px", padding: "18px 20px 24px", minHeight: "calc(100vh - 96px)", boxSizing: "border-box", color: "inherit" },
      head: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
      title: { fontSize: "18px", fontWeight: 600 },
      pill: { display: "inline-flex", alignItems: "center", gap: "6px", padding: "3px 10px", borderRadius: "999px", fontSize: "12px", border: "1px solid rgba(127,127,127,0.3)" },
      dot: { width: "8px", height: "8px", borderRadius: "50%" },
      updated: { marginLeft: "auto", fontSize: "12px", opacity: 0.55 },
      grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px" },
      card: { padding: "10px 12px", borderRadius: "10px", background: "rgba(127,127,127,0.08)", border: "1px solid rgba(127,127,127,0.14)", minWidth: 0 },
      cardLabel: { fontSize: "11px", opacity: 0.55, letterSpacing: "0.4px" },
      cardValue: { fontSize: "15px", marginTop: "4px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
      cardHint: { fontSize: "11px", opacity: 0.5, marginTop: "2px" },
      bar: { display: "flex", alignItems: "center", gap: "8px", rowGap: "10px", flexWrap: "wrap" },
      btn: { padding: "6px 12px", borderRadius: "7px", border: "1px solid rgba(127,127,127,0.32)", background: "transparent", color: "inherit", cursor: "pointer", fontSize: "12.5px" },
      btnPrimary: { padding: "6px 14px", borderRadius: "7px", border: "1px solid rgba(63,185,80,0.55)", background: "rgba(63,185,80,0.12)", color: "inherit", cursor: "pointer", fontSize: "12.5px", fontWeight: 600 },
      input: { padding: "5px 9px", borderRadius: "7px", border: "1px solid rgba(127,127,127,0.32)", background: "transparent", color: "inherit", fontSize: "12px" },
      select: { padding: "5px 8px", borderRadius: "7px", border: "1px solid rgba(127,127,127,0.32)", background: "transparent", color: "inherit", fontSize: "12px", maxWidth: "240px" },
      selectBtn: {
        display: "inline-flex", alignItems: "center", gap: "8px",
        minWidth: "120px", maxWidth: "280px", padding: "6px 10px",
        borderRadius: "8px", border: "1px solid rgba(127,127,127,0.32)",
        background: "rgba(127,127,127,0.06)", color: "inherit",
        fontSize: "12.5px", cursor: "pointer", appearance: "none", colorScheme: "inherit"
      },
      body: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: "12px", flex: 1, minHeight: 0 },
      logCard: { display: "flex", flexDirection: "column", minHeight: "320px", borderRadius: "10px", border: "1px solid rgba(127,127,127,0.16)", background: "rgba(127,127,127,0.10)", overflow: "hidden" },
      logHead: { display: "flex", alignItems: "center", gap: "6px", padding: "6px 8px", borderBottom: "1px solid rgba(127,127,127,0.16)" },
      tab: { padding: "3px 9px", borderRadius: "6px", fontSize: "11.5px", cursor: "pointer", opacity: 0.6 },
      logBody: { flex: 1, overflowY: "auto", padding: "8px 10px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11.5px", lineHeight: "1.5" },
      side: { display: "flex", flexDirection: "column", gap: "10px", minHeight: 0 },
      sideCard: { borderRadius: "10px", border: "1px solid rgba(127,127,127,0.16)", background: "rgba(127,127,127,0.06)", padding: "10px", display: "flex", flexDirection: "column", gap: "6px", minHeight: 0 },
      sideTitle: { fontSize: "11.5px", opacity: 0.6 },
      diag: { fontSize: "11.5px", cursor: "pointer", padding: "4px 6px", borderRadius: "6px", background: "rgba(248,81,73,0.08)", border: "1px solid rgba(248,81,73,0.18)" },
      dim: { opacity: 0.5, fontSize: "11.5px" },
      field: { display: "flex", flexDirection: "column", gap: "3px", minWidth: "120px" },
      fieldLabel: { fontSize: "11px", opacity: 0.55 },
      section: { border: "1px solid rgba(127,127,127,0.16)", borderRadius: "10px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "10px" },
      row: { display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "flex-end" }
    };

    var sessionsService = null;
    /** Resolves a folder through the app's native picker: null means cancelled. */
    var directoryPicker = null;
    /** Workspace UI service: ownSession/pickDirectory live here. */
    var workspaceService = null;

    /** Turn the live board state into a self-contained question for a fresh session. */
    function buildBrief(state, logs) {
      var chip = state.chip || {};
      var build = state.lastBuild || null;
      var flash = state.lastFlash || null;
      var tail = logs.filter(function (entry) { return entry.channel !== "sys"; }).slice(-20).map(function (entry) {
        return "[" + entry.channel + "] " + entry.text;
      });
      return [
        "STM32 烧录/编译现场（来自 dsh-stm32-toolchain 面板）：",
        "- 工程: " + (state.project || "未选择"),
        "- 芯片: " + (chip.device || "-") + (chip.family ? " / " + chip.family : ""),
        "- 传输: " + (state.transport || "-") + "，端口: " + (state.port || "-"),
        "- 阶段: " + (state.phase || "-") + (state.message ? " (" + state.message + ")" : ""),
        build ? "- 上次编译: " + (build.ok ? "通过" : "失败") + " " + Math.round(build.elapsedMs / 1000) + "s，" + build.errors + " 错 / " + build.warnings + " 警" : "- 上次编译: -",
        flash ? "- 上次烧录: " + (flash.ok ? "成功" : "失败") + " " + clock(flash.at) : "- 上次烧录: -",
        "",
        "最近日志：",
        tail.length ? tail.join("\n") : "(无)",
        "",
        "请判断问题出在哪，需要的话直接用 stm32_* 工具复现（编译 / 烧录 / 读日志），并给出修改方案。"
      ].join("\n");
    }

    var CARDS = [
      { id: "chip", label: "芯片" },
      { id: "transport", label: "传输" },
      { id: "port", label: "端口" },
      { id: "firmware", label: "固件" },
      { id: "build", label: "编译" },
      { id: "flash", label: "烧录" },
      { id: "lease", label: "占用" },
      { id: "logs", label: "日志" }
    ];
    var DEFAULT_ORDER = CARDS.map(function (card) { return card.id; }).join(",");

    /** Keep known ids, drop duplicates, then pad with whatever is missing. */
    function resolveOrder(raw) {
      var valid = {}, seen = {}, out = [];
      CARDS.forEach(function (card) { valid[card.id] = true; });
      String(raw || "").split(",").forEach(function (part) {
        var id = part.trim();
        if (!id || !valid[id] || seen[id]) return;
        seen[id] = true;
        out.push(id);
      });
      DEFAULT_ORDER.split(",").forEach(function (id) {
        if (!seen[id]) { seen[id] = true; out.push(id); }
      });
      return out.slice(0, CARDS.length);
    }

    /** Move one slot to a new index (drag semantics: pull out, insert). */
    function moveCard(order, from, to) {
      var next = order.slice();
      if (from === to || from < 0 || to < 0 || from >= next.length || to >= next.length) return next;
      var moved = next.splice(from, 1)[0];
      next.splice(to, 0, moved);
      return next;
    }

    /** Log text preferences, with the same defaults the host schema uses. */
    function logPrefs(settings) {
      var source = settings || {};
      return {
        fontSize: Number(source.logFontSize) > 0 ? Number(source.logFontSize) : 12,
        lineHeight: Number(source.logLineHeight) > 0 ? Number(source.logLineHeight) : 1.5,
        maxLines: Number(source.logMaxLines) > 0 ? Number(source.logMaxLines) : 400,
        wrap: source.logWrap !== false,
        timestamps: source.logTimestamps === true,
        colors: {
          build: source.logColorBuild || '',
          flash: source.logColorFlash || '',
          serial: source.logColorSerial || '',
          sys: source.logColorSys || ''
        },
        gradient: {
          enabled: source.logBgGradient === true,
          from: source.logBgFrom || "#0d1117",
          to: source.logBgTo || "#161b22"
        }
      };
    }

    function lineColor(prefs, channel) {
      return (prefs.colors && prefs.colors[channel]) || CHANNEL[channel] || CHANNEL.sys;
    }

    function logBackground(prefs) {
      if (prefs.gradient && prefs.gradient.enabled) {
        return "linear-gradient(135deg, " + prefs.gradient.from + ", " + prefs.gradient.to + ")";
      }
      return "rgba(127,127,127,0.10)";
    }

    /** Sample lines so the settings card can show the effect while adjusting. */
    var LOG_SAMPLES = [
      { channel: "build", text: "Rebuild target 'Project'  -  0 Error(s), 2 Warning(s)." },
      { channel: "flash", text: "wrote 118432/118432 bytes  ·  verified  ·  go 0x08000000" },
      { channel: "serial", text: "[boot] bmi088 ok, motor idle, ready for rc frame" },
      { channel: "sys", text: "bridge listening on 127.0.0.1:39021" }
    ];

    function LogSample(props) {
      var prefs = props.prefs;
      var stamp = "09:41:07 ";
      return h("div", {
        style: {
          padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l, rgba(127,127,127,0.18))",
          background: logBackground(prefs), color: "inherit",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: prefs.fontSize + "px", lineHeight: String(prefs.lineHeight),
          whiteSpace: prefs.wrap ? "pre-wrap" : "pre", overflowX: prefs.wrap ? "hidden" : "auto"
        }
      }, LOG_SAMPLES.map(function (sample, index) {
        return h("div", { key: index, style: { color: lineColor(prefs, sample.channel) } },
          prefs.timestamps ? h("span", { style: { opacity: 0.45, marginRight: "6px" } }, stamp) : null,
          sample.text);
      }));
    }

    /** Live look-and-feel shared by the settings card and the panel. */
    var lookStore = (function () {
      var value = null;
      var listeners = [];
      return {
        get: function () { return value },
        set: function (next) {
          value = next;
          for (var i = 0; i < listeners.length; i += 1) {
            try { listeners[i](next) } catch (error) { /* one bad listener must not stop the rest */ }
          }
        },
        subscribe: function (listener) {
          listeners.push(listener);
          return function () {
            var at = listeners.indexOf(listener);
            if (at >= 0) listeners.splice(at, 1);
          };
        }
      };
    })();

    /** "session-3f2a9c71" -> "…2a9c71": the prefix is constant, the tail identifies it. */
    function shortSession(id) {
      var text = String(id || "");
      return text.length > 10 ? "…" + text.slice(-6) : text;
    }

    function bindingName(binding) {
      if (!binding) return "";
      if (typeof binding.label === "string" && binding.label.trim()) return binding.label.trim();
      return shortSession(binding.sessionId);
    }

    /** ';'-separated settings value -> cleaned path list ([] means "use the defaults"). */
    function splitRoots(value) {
      if (typeof value !== "string" || !value.trim()) return [];
      return value.split(/[;\n]/).map(function (entry) { return entry.trim(); }).filter(Boolean);
    }

    /**
     * The host's config is authoritative; the bridge's env snapshot is only a
     * bootstrap value for the first paint before /config answers.
     */
    function resolveLook(hostConfig, bridgeSettings) {
      if (hostConfig && typeof hostConfig === "object") return hostConfig;
      return bridgeSettings && typeof bridgeSettings === "object" ? bridgeSettings : {};
    }

    /**
     * Only write fields the form actually holds. A save used to send "" / 0 for
     * anything missing (the post-save describe view can omit default-equal keys),
     * which silently reset colours and font size back to their defaults.
     */
    function buildOps(value) {
      var ops = [];
      FIELDS.concat(LOG_FIELDS).forEach(function (field) {
        var raw = value[field.key];
        if (field.type === "number") {
          var num = Number(raw);
          if (Number.isFinite(num) && num > 0) ops.push({ op: "set", path: [field.key], value: num });
          return;
        }
        if (raw === undefined || raw === null) return;
        ops.push({ op: "set", path: [field.key], value: String(raw) });
      });
      LOG_COLOR_FIELDS.forEach(function (field) {
        var raw = value[field.key];
        if (raw === undefined || raw === null) return;
        ops.push({ op: "set", path: [field.key], value: String(raw) });
      });
      ops.push({ op: "set", path: ["enabled"], value: value.enabled !== false });
      ops.push({ op: "set", path: ["announceToAgent"], value: value.announceToAgent !== false });
      ops.push({ op: "set", path: ["logWrap"], value: value.logWrap !== false });
      ops.push({ op: "set", path: ["logTimestamps"], value: value.logTimestamps === true });
      ops.push({ op: "set", path: ["logBgGradient"], value: value.logBgGradient === true });
      ops.push({ op: "set", path: ["cardOrder"], value: resolveOrder(value.cardOrder).join(",") });
      return ops;
    }

    /** Merge instead of replace: the response may omit keys equal to their default. */
    function mergeForm(previous, fromServer) {
      return Object.assign({}, previous, fromServer && typeof fromServer === "object" ? fromServer : {});
    }

    /** Mirror of the host projection, built from the settings form values. */
    function presentationFromForm(source) {
      var v = source || {};
      function num(value, fallback) { var n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; }
      function text(value, fallback) { return typeof value === "string" ? value : fallback; }
      return {
        searchRoots: text(v.searchRoots, ""),
        cardOrder: text(v.cardOrder, DEFAULT_ORDER),
        logFontSize: num(v.logFontSize, 12),
        logLineHeight: num(v.logLineHeight, 1.5),
        logMaxLines: num(v.logMaxLines, 400),
        logWrap: v.logWrap !== false,
        logTimestamps: v.logTimestamps === true,
        logColorBuild: text(v.logColorBuild, ""),
        logColorFlash: text(v.logColorFlash, ""),
        logColorSerial: text(v.logColorSerial, ""),
        logColorSys: text(v.logColorSys, ""),
        logBgGradient: v.logBgGradient === true,
        logBgFrom: text(v.logBgFrom, "#0d1117"),
        logBgTo: text(v.logBgTo, "#161b22")
      };
    }

    /** Trigger + official Menu for actions that have more than one variant. */
    function MenuButton(props) {
      var openBox = React.useState(false);
      var open = openBox[0], setOpen = openBox[1];
      var items = props.items || [];
      var trigger = h("button", {
        type: "button",
        disabled: !!props.disabled,
        onClick: function () { setOpen(!open); },
        style: Object.assign({}, S.btn, { display: "inline-flex", alignItems: "center", gap: "6px" })
      },
        props.label,
        h("span", { style: { opacity: 0.5, fontSize: "10px" } }, "▼")
      );
      if (!PrimitiveMenu) {
        return h("span", { style: { display: "inline-flex", gap: "6px" } }, items.map(function (item) {
          return h("button", { key: item.id, type: "button", style: S.btn, disabled: !!props.disabled, onClick: function () { props.onSelect(item.id); } }, item.label);
        }));
      }
      return h(PrimitiveMenu, {
        open: open,
        anchor: trigger,
        items: items.map(function (item) { return { id: item.id, label: item.label }; }),
        onSelect: function (id) { setOpen(false); props.onSelect(id); },
        onClose: function () { setOpen(false); },
        align: "start",
        side: "bottom",
        portal: true,
        dense: true
      });
    }

    /**
     * Bind the panel to one conversation. Three states: no binding, bound to THIS
     * session, bound to another session.
     */
    function BindSessionButton(props) {
      var bindingBox = React.useState(null);
      var binding = bindingBox[0], setBinding = bindingBox[1];
      var busyBox = React.useState(false);
      var busy = busyBox[0], setBusy = busyBox[1];

      React.useEffect(function () {
        var alive = true;
        function read() {
          fetch(API + "/state").then(function (r) { return r.json(); }).then(function (snapshot) {
            if (alive && snapshot && snapshot.binding !== undefined) setBinding(snapshot.binding);
          }).catch(function () {});
        }
        read();
        var timer = setInterval(read, 3000);
        return function () { alive = false; clearInterval(timer); };
      }, []);

      /** The session list carries the title: send it so the panel can name the session. */
      function sessionLabel(id) {
        try {
          var list = sessionsService && sessionsService.list;
          var snapshot = list && typeof list.getSnapshot === "function" ? list.getSnapshot() : null;
          var row = snapshot && snapshot.byId && snapshot.byId[id];
          var title = row && (row.title || row.durableTitle || row.name);
          if (typeof title === "string" && title.trim()) return title.trim().slice(0, 60);
        } catch (error) { /* fall back to the id */ }
        return "";
      }

      function write(action, params) {
        setBusy(true);
        fetch(API + "/action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: action, params: params || {} })
        }).then(function (r) { return r.json(); }).then(function (result) {
          if (result && result.ok) setBinding(result.result && result.result.binding !== undefined ? result.result.binding : null);
        }).catch(function () { }).then(function () { setBusy(false); });
      }

      function currentSessionId() {
        try {
          var list = sessionsService && sessionsService.list;
          var snapshot = list && typeof list.getSnapshot === "function" ? list.getSnapshot() : null;
          var fromList = snapshot && (snapshot.currentId || (snapshot.current && snapshot.current.sessionId));
          if (fromList) return String(fromList);
        } catch (error) { /* fall through */ }
        return "";
      }
      var sessionId = props.sessionId ? String(props.sessionId) : currentSessionId();
      var boundTo = binding && binding.sessionId ? String(binding.sessionId) : "";
      var isThisSession = Boolean(boundTo && sessionId && boundTo === sessionId);
      var small = { fontSize: "11.5px", padding: "3px 9px" };

      /** The session header is already a flex row: the control is just an inline pill. */
      function shell(child) {
        return h("div", { style: { display: "inline-flex", alignItems: "center", marginLeft: "4px", lineHeight: 1.2 } }, child);
      }
      var pill = {
        display: "inline-flex", alignItems: "center", gap: "6px",
        padding: "2px 9px", borderRadius: "999px",
        border: "1px solid var(--dsw-alias-border-l, rgba(127,127,127,0.3))",
        background: "rgba(127,127,127,0.10)", color: "inherit",
        fontSize: "11.5px", lineHeight: "16px", cursor: "pointer"
      };

      if (!boundTo) {
        return shell(h("button", {
          type: "button",
          disabled: busy || !sessionId,
          title: sessionId ? "把 STM32 总管绑定到本会话" : "这个位置拿不到会话 id",
          style: Object.assign({}, pill, busy || !sessionId ? { opacity: 0.5, cursor: "not-allowed" } : null),
          onClick: function () { write("set-binding", { sessionId: sessionId, label: sessionLabel(sessionId) }); }
        }, busy ? "绑定中…" : "绑定 STM32"));
      }

      if (isThisSession) {
        return shell(h("span", { style: Object.assign({}, pill, { cursor: "default" }) },
          h("span", null, "本会话已绑定"),
          h("button", {
            type: "button", disabled: busy, title: "解除绑定",
            style: { border: "none", background: "transparent", color: "inherit", padding: "0 2px", fontSize: "11px", cursor: "pointer", opacity: 0.7 },
            onClick: function () { write("clear-binding", {}); }
          }, "解绑")));
      }

      return shell(h("button", {
        type: "button", disabled: busy || !sessionId,
        title: "已绑定到另一个会话，点击改绑到本会话",
        style: Object.assign({}, pill, { borderColor: "rgba(245,166,35,0.55)" }),
        onClick: function () { write("set-binding", { sessionId: sessionId, label: sessionLabel(sessionId) }); }
      }, "非本会话已绑定"));
    }

    function Card(props) {
      return h("div", { style: S.card },
        h("div", { style: S.cardLabel }, props.label),
        h("div", { style: Object.assign({}, S.cardValue, props.style || {}) }, props.value),
        props.hint ? h("div", { style: S.cardHint }, props.hint) : null
      );
    }

    function Field(props) {
      return h("label", { style: S.field },
        h("span", { style: S.fieldLabel }, props.label),
        props.children
      );
    }

    function Dashboard() {
      var stateBox = React.useState({ phase: "offline", message: "" });
      var state = stateBox[0], setState = stateBox[1];
      var logsBox = React.useState([]);
      var logs = logsBox[0], setLogs = logsBox[1];
      var chanBox = React.useState("");
      var channel = chanBox[0], setChannel = chanBox[1];
      var filterBox = React.useState("");
      var filter = filterBox[0], setFilter = filterBox[1];
      var busyBox = React.useState("");
      var busy = busyBox[0], setBusy = busyBox[1];
      var portsBox = React.useState([]);
      var ports = portsBox[0], setPorts = portsBox[1];
      var projectsBox = React.useState([]);
      var projects = projectsBox[0], setProjects = projectsBox[1];
      var ssidBox = React.useState("");
      var wifiSsid = ssidBox[0], setWifiSsid = ssidBox[1];
      var passBox = React.useState("");
      var wifiPass = passBox[0], setWifiPass = passBox[1];
      var fwBox = React.useState("");
      var fwNote = fwBox[0], setFwNote = fwBox[1];
      var scanBox = React.useState(null);
      var scanInfo = scanBox[0], setScanInfo = scanBox[1];
      var pathBox = React.useState("");
      var projectPath = pathBox[0], setProjectPath = pathBox[1];
      var sendBox = React.useState("");
      var sendText = sendBox[0], setSendText = sendBox[1];
      var followBox = React.useState(true);
      var follow = followBox[0], setFollow = followBox[1];
      var moreBox = React.useState(false);
      var showFlashConfig = moreBox[0], setShowFlashConfig = moreBox[1];
      var watchBox = React.useState(true);
      var watch = watchBox[0], setWatch = watchBox[1];
      var askBox = React.useState("");
      var askText = askBox[0], setAskText = askBox[1];
      var askHintBox = React.useState("");
      var askHint = askHintBox[0], setAskHint = askHintBox[1];
      var askingBox = React.useState(false);
      var asking = askingBox[0], setAsking = askingBox[1];
      var baudBox = React.useState("115200");
      var baudText = baudBox[0], setBaudText = baudBox[1];
      var espHostBox = React.useState("");
      var espHost = espHostBox[0], setEspHost = espHostBox[1];
      var espPortBox = React.useState("23");
      var espPort = espPortBox[0], setEspPort = espPortBox[1];
      var retryBox = React.useState("3");
      var retryText = retryBox[0], setRetryText = retryBox[1];
      var lastSeq = React.useRef(0);
      var logRef = React.useRef(null);
      var bootBox = React.useRef(false);
      var seenInstance = React.useRef(null);
      var presBox = React.useState(null);
      var presentation = presBox[0], setPresentation = presBox[1];
      var lookBox = React.useState(lookStore.get());
      var liveLook = lookBox[0], setLiveLook = lookBox[1];

      React.useEffect(function () {
        return lookStore.subscribe(function (next) { setLiveLook(next); });
      }, []);
      var tickBox = React.useState(Date.now());
      var nowTick = tickBox[0], setNowTick = tickBox[1];
      var expiredBox = React.useRef(false);

      React.useEffect(function () {
        var id = setInterval(function () { setNowTick(Date.now()); }, 1000);
        return function () { clearInterval(id); };
      }, []);

      function applySettings(next) {
        if (next && next.wifi && next.wifi.ssid) setWifiSsid(function (prev) { return prev || next.wifi.ssid; });
        var conf = (next && next.settings) || null;
        if (conf && !bootBox.current) {
          bootBox.current = true;
          if (conf.baud) setBaudText(String(conf.baud));
          if (conf.espHost) setEspHost(conf.espHost);
          if (conf.espPort) setEspPort(String(conf.espPort));
          if (conf.retry) setRetryText(String(conf.retry));
        }
      }

      /** Pull board state and the host's presentation config, then fold both in. */
      function resync() {
        return Promise.all([
          fetch(API + "/state").then(function (r) { return r.json(); }).catch(function () { return null; }),
          fetch(API + "/config").then(function (r) { return r.json(); }).catch(function () { return null; })
        ]).then(function (pair) {
          var fresh = pair[0];
          var conf = pair[1] && pair[1].config;
          if (fresh && typeof fresh === "object") mergeState(fresh);
          if (conf && typeof conf === "object") {
            setPresentation(conf);
            if (lookStore.get() === null) lookStore.set(conf);
          }
        });
      }

      function mergeState(next) {
        setState(function (prev) { return Object.assign({}, prev, next); });
        if (next && next.project) setProjectPath(next.project);
        applySettings(next);
      }

      React.useEffect(function () {
        var alive = true;
        var source = null;
        function connect() {
          source = new EventSource(API + "/stream?since=" + lastSeq.current);
          source.addEventListener("state", function (event) {
            if (alive) mergeState(JSON.parse(event.data));
          });
          source.addEventListener("log", function (event) {
            if (!alive) return;
            var entry = JSON.parse(event.data);
            if (entry.instance && entry.instance !== seenInstance.current) {
              seenInstance.current = entry.instance;
              lastSeq.current = 0;
              setLogs([]);
            }
            if (entry.seq > lastSeq.current) lastSeq.current = entry.seq;
            setLogs(function (prev) {
              var next = prev.concat([entry]);
              return next.length > 800 ? next.slice(next.length - 800) : next;
            });
          });
          source.onopen = function () { if (alive) resync(); };
          source.onerror = function () {
            if (!alive) return;
            setState(function (prev) { return Object.assign({}, prev, { phase: "offline" }); });
            if (source) source.close();
            setTimeout(function () { if (alive) connect(); }, 3000);
          };
        }
        resync();
        fetch(API + "/logs?limit=400").then(function (r) { return r.json(); }).then(function (d) {
          if (!alive || !d.logs) return;
          d.logs.forEach(function (entry) { if (entry.seq > lastSeq.current) lastSeq.current = entry.seq; });
          setLogs(d.logs);
        }).catch(function () {});
        // Presentation settings live in the host config, so poll them: a saved
        // setting must show up even when the bridge child kept running.
        var poll = setInterval(function () { if (alive) resync(); }, 2000);
        var onConfig = function () { if (alive) resync(); };
        window.addEventListener("dsh-stm32:config", onConfig);
        connect();
        post("ports").then(function (r) { if (alive && r && r.ok && Array.isArray(r.result)) setPorts(r.result); }).catch(function () {});
        return function () {
          alive = false;
          clearInterval(poll);
          window.removeEventListener("dsh-stm32:config", onConfig);
          if (source) source.close();
        };
      }, []);

      React.useEffect(function () {
        if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
      }, [logs.length, follow]);

      /**
       * Switch the main view to the bound session through the workspace service -
       * the same call the app itself uses. sessions.retain({source:'mainView'})
       * is NOT used: holding that retention pins the view so the user cannot
       * switch to another session any more.
       */
      function jumpToBoundSession() {
        var bound = state.binding;
        if (!bound || !bound.sessionId) {
          setAskHint("未绑定会话，请先在会话里点「绑定 STM32」");
          return;
        }
        var open = workspaceService && workspaceService.openSession;
        if (typeof open !== "function") {
          setAskHint("宿主没有提供会话切换接口（uiWorkspace.openSession）");
          return;
        }
        try {
          open.call(workspaceService, bound.sessionId);
          setAskHint("已跳到会话 " + bindingName(bound));
        } catch (error) {
          setAskHint("切换失败：" + String((error && error.message) || error));
        }
      }

      /** Send to the session the user bound in the conversation (no session creation). */
      function askBoundSession() {
        var bound = state.binding;
        var text = askText.trim();
        if (!bound || !bound.sessionId) {
          setAskHint("未绑定会话，请先在会话里点「绑定 STM32」");
          return;
        }
        if (!text) {
          setAskHint("输入为空，没有发送");
          return;
        }
        setAsking(true);
        setAskHint("");
        fetch(API + "/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: bound.sessionId, text: text })
        }).then(function (r) { return r.json(); }).then(function (result) {
          if (result && result.ok) {
            setAskHint("已发送到会话 " + String(bound.sessionId).slice(0, 8));
            setAskText("");
          } else {
            setAskHint("发送失败：" + ((result && result.error) || "未知错误"));
          }
        }).catch(function (error) {
          setAskHint("发送失败：" + String((error && error.message) || error));
        }).then(function () { setAsking(false); });
      }

      /** Empty input jumps to the bound session; content sends to it. */
      function jumpOrAsk() {
        if (!askText.trim()) {
          jumpToBoundSession();
          return;
        }
        askBoundSession();
      }

      function run(action, params) {
        setBusy(action);
        return post(action, params).then(function (result) {
          if (result && result.ok === false) {
            setState(function (prev) { return Object.assign({}, prev, { phase: "error", message: result.error || "操作失败" }); });
          }
          return result;
        }).catch(function (error) {
          setState(function (prev) { return Object.assign({}, prev, { phase: "error", message: String(error.message || error) }); });
        }).then(function (value) {
          setBusy("");
          // Always resync: an action result is not board state.
          return resync().then(function () { return value; }).catch(function () { return value; });
        });
      }

      var phaseInfo = PHASE[state.phase] || PHASE.offline;
      var chip = state.chip || {};
      var build = state.lastBuild || null;
      var flash = state.lastFlash || null;
      var shown = logs.filter(function (entry) {
        if (channel && entry.channel !== channel) return false;
        if (!filter) return true;
        return entry.text.toLowerCase().indexOf(filter.toLowerCase()) >= 0;
      });
      var diagnostics = (build && build.diagnostics) || [];
      var lease = state.lease || null;
      var leaseLeft = lease ? Math.max(0, Math.round(((lease.expiresAt || 0) - nowTick) / 1000)) : 0;
      var leaseHeld = lease ? Math.max(0, Math.round((nowTick - (lease.since || nowTick)) / 1000)) : 0;
      var liveLease = lease && leaseLeft > 0 ? lease : null;

      React.useEffect(function () {
        if (lease && leaseLeft === 0 && !expiredBox.current) {
          expiredBox.current = true;
          fetch(API + "/state").then(function (r) { return r.json(); }).then(function (fresh) {
            if (fresh && typeof fresh === "object") setState(function (prev) { return Object.assign({}, prev, fresh); });
          }).catch(function () {});
        }
        if (!lease) expiredBox.current = false;
      }, [leaseLeft, lease]);

      var look = resolveLook(liveLook || presentation, state.settings);
      var prefs = logPrefs(look);
      var order = resolveOrder(look && look.cardOrder);
      var cardViews = {
        chip: function () { return h(Card, { key: "chip", label: "芯片", value: chip.device || "未选择工程", hint: chip.family || "" }); },
        transport: function () {
          var label = state.transport === "wifi" ? "Wi-Fi"
            : state.transport === "uart" ? "串口 Bootloader"
            : "ST-Link SWD";
          return h(Card, { key: "transport", label: "传输", value: label });
        },
        port: function () { return h(Card, { key: "port", label: "端口", value: state.port || "未打开", hint: state.serialOpen ? "监视中" : "" }); },
        firmware: function () { return h(Card, { key: "firmware", label: "固件", value: size(state.firmware && state.firmware.bytes), hint: state.firmware ? clock(state.firmware.at) : "" }); },
        build: function () { return h(Card, { key: "build", label: "编译", value: build ? (build.ok ? "通过" : "失败") + " " + (build.elapsedMs / 1000).toFixed(1) + "s" : "—", hint: build ? build.errors + " 错 / " + build.warnings + " 警" : "" }); },
        flash: function () { return h(Card, { key: "flash", label: "烧录", value: flash ? (flash.ok ? "成功" : "失败") : "—", hint: flash ? clock(flash.at) : "" }); },
        lease: function () { return h(Card, { key: "lease", label: "占用", value: liveLease ? liveLease.owner : "空闲", hint: liveLease ? "已占用 " + leaseHeld + "s · 剩 " + leaseLeft + "s" : "无人占用", style: liveLease ? { color: "#f5a623" } : null }); },
        logs: function () { return h(Card, { key: "logs", label: "日志", value: logs.length + " 条", hint: "串口 " + (state.serialLines || 0) + " 行 · 桥接 :" + ((state.settings && state.settings.httpPort) || 39021) }); }
      };
      var cards = order.map(function (id) { return cardViews[id] ? cardViews[id]() : null; }).filter(Boolean);

      return h("div", { style: S.root },
        h("div", { style: S.head },
          h("div", { style: S.title }, "STM32 总管"),
          h("span", { style: S.pill },
            h("span", { style: Object.assign({}, S.dot, { background: phaseInfo.color, boxShadow: "0 0 6px " + phaseInfo.color }) }),
            phaseInfo.label
          ),
          h("span", { style: S.dim }, state.message || ""),
          state.binding ? h("span", { style: Object.assign({}, S.pill, { borderColor: "rgba(120,170,255,0.5)" }), title: String(state.binding.sessionId) },
            "已绑定会话 " + bindingName(state.binding)) : null,
          liveLease ? h("span", { style: Object.assign({}, S.pill, { borderColor: "rgba(245,166,35,0.5)" }) },
            "占用: " + liveLease.owner + " · 剩 " + leaseLeft + "s",
            h("button", {
              style: Object.assign({}, S.btn, { padding: "1px 6px", fontSize: "11px" }),
              title: "强制释放（会清掉其他会话的占用）",
              onClick: function () { run("release", { force: true }); }
            }, "释放")
          ) : null,
          h("span", { style: S.updated }, "更新 " + clock(state.updatedAt))
        ),

        h("div", { style: S.grid }, cards.slice(0, 4)),
        h("div", { style: S.grid }, cards.slice(4, 8)),

        h("div", { style: S.bar },
          h("button", { style: S.btn, disabled: !!busy, onClick: function () { run("build"); } }, busy === "build" ? "编译中…" : "编译"),
          h("button", { style: S.btn, disabled: !!busy, onClick: function () { run("flash"); } }, busy === "flash" ? "烧录中…" : "烧录"),
          h("button", { style: S.btnPrimary, disabled: !!busy, onClick: function () { run("deploy", { watch: watch ? 5000 : 0 }); } },
            busy === "deploy" ? "执行中…" : watch ? "一键编译 + 烧录 + 看日志" : "一键编译 + 烧录"),
          h("button", { style: S.btn, onClick: function () { run(state.serialOpen ? "monitor-stop" : "monitor-start"); } }, state.serialOpen ? "关闭串口" : "打开串口"),
          h("button", {
            style: S.btn,
            title: "在 VS Code 中打开工程文件夹",
            onClick: function () {
              if (state.project) run("open-vscode", { project: state.project });
            }
          }, "VSCode"),
          h(MenuButton, {
            label: "清空日志",
            items: [{ id: "current", label: "清空当前日志" }, { id: "all", label: "清空所有日志" }],
            onSelect: function (id) {
              if (id === "all" || channel === "") {
                setLogs([]);
                run("clear-logs");
                return;
              }
              setLogs(function (prev) { return prev.filter(function (entry) { return entry.channel !== channel; }); });
              run("clear-logs", { channel: channel });
            }
          }),
          h("span", { style: { flex: 1 } }),
          h("button", { style: Object.assign({}, S.btn, showFlashConfig ? { borderColor: "rgba(127,127,127,0.6)" } : null), onClick: function () { setShowFlashConfig(!showFlashConfig); } }, "烧录设置"),
          h(Dropdown, {
            value: state.port || "",
            width: "210px",
            title: "选择串口",
            options: [{ id: "", label: "选择串口…" }].concat(ports.map(function (p) {
              return { id: p.port, label: p.port + "  " + (p.desc || "") };
            })),
            onChange: function (id) { run("set-port", { port: id, baud: Number(baudText) || 115200 }); }
          })
        ),

        h("div", { style: S.bar },
          h("span", { style: Object.assign({}, S.dim, { minWidth: "68px" }) }, "交给 AI"),
          h("input", {
            style: Object.assign({}, S.input, { flex: 1, minWidth: "220px" }),
            placeholder: state.binding ? "留空＝跳转到该会话；写内容＝发送给它" : "未绑定会话，请先在会话里点「绑定 STM32」",
            value: askText,
            disabled: !state.binding,
            onChange: function (e) { setAskText(e.target.value); },
            onKeyDown: function (e) {
              if (e.key === "Enter") { jumpOrAsk(); }
            }
          }),
          h("button", { style: S.btn, title: "把当前状态与最近日志填进来", onClick: function () { setAskText(buildBrief(state, logs)); } }, "带入现状"),
          state.binding
            ? h("button", {
              style: S.btnPrimary,
              disabled: asking,
              title: askText.trim()
                ? "发送到已绑定的会话"
                : "输入框为空：切换到已绑定的会话",
              onClick: jumpOrAsk
            }, asking ? "发送中…" : askText.trim() ? "发送到此会话" : "跳转到会话")
            : h("button", { style: Object.assign({}, S.btnPrimary, { opacity: 0.5, cursor: "not-allowed" }), disabled: true, title: "还没有绑定会话" }, "未绑定会话"),
          state.binding
            ? h("span", { style: S.dim }, "→ " + bindingName(state.binding))
            : null,
          askHint ? h("span", { style: S.dim }, askHint) : null
        ),

        showFlashConfig ? h("div", { style: S.section },
          h("div", { style: S.sideTitle }, "烧录设置（只影响这块板，不再跑设置页）"),
          h("div", { style: S.row },
            h(Field, { label: "传输" },
              h(Dropdown, {
                value: state.transport || "swd",
                width: "210px",
                options: [
                  { id: "swd", label: "ST-Link (UV4 -f)" },
                  { id: "uart", label: "串口 Bootloader (AN3155)" },
                  { id: "wifi", label: "Wi-Fi (ESP 模块)" }
                ],
                onChange: function (id) { run("set-transport", { transport: id }); }
              })),
            h(Field, { label: "波特率" },
              h("input", { style: Object.assign({}, S.input, { width: "100px" }), value: baudText, onChange: function (e) { setBaudText(e.target.value); },
                onBlur: function () { run("set-port", { port: state.port, baud: Number(baudText) || 115200 }); } })),
            h(Field, { label: "重试次数" },
              h("input", { style: Object.assign({}, S.input, { width: "70px" }), value: retryText, onChange: function (e) { setRetryText(e.target.value); },
                onBlur: function () { run("set-retry", { retry: Number(retryText) || 3 }); } })),
            h(Field, { label: "ESP 主机（无线）" },
              h("input", { style: Object.assign({}, S.input, { width: "150px" }), placeholder: "192.168.4.1", value: espHost, onChange: function (e) { setEspHost(e.target.value); },
                onBlur: function () { run("set-wifi", { host: espHost, port: Number(espPort) || 23 }); } })),
            h(Field, { label: "ESP 端口" },
              h("input", { style: Object.assign({}, S.input, { width: "80px" }), value: espPort, onChange: function (e) { setEspPort(e.target.value); },
                onBlur: function () { run("set-wifi", { host: espHost, port: Number(espPort) || 23 }); } })),
            h("div", { style: { flexBasis: "100%", height: "0px" } }),
            h("button", {
              style: S.btn, title: "扫描本网段里应答 3333 端口的 ESP，并自动填入主机地址",
              onClick: function () {
                setFwNote("正在扫描…");
                run("esp-discover").then(function (r) {
                  if (!r || !r.ok || !r.result) { setFwNote("探测失败：" + ((r && r.error) || "未知错误")); return; }
                  var devices = (r.result.devices || []);
                  if (devices.length === 1) setFwNote("已找到 ESP：" + devices[0].host);
                  else if (devices.length === 0) setFwNote("本网段没找到 ESP（检查供电/联网）");
                  else setFwNote("找到 " + devices.length + " 个：" + devices.map(function (d) { return d.host; }).join("、"));
                });
              }
            }, "自动探测 ESP"),
            h(Field, { label: "ESP 板型" },
              h(Dropdown, {
                value: state.espBoard || "nodemcu",
                width: "160px",
                options: [
                  { id: "nodemcu", label: "ESP-12E / NodeMCU" },
                  { id: "esp01s", label: "ESP-01S" }
                ],
                onChange: function (id) { run("set-esp-board", { board: id }); }
              })),
            h(Field, { label: "Wi-Fi 名称" },
              h("input", {
                style: Object.assign({}, S.input, { width: "150px" }), placeholder: "手机热点 / 路由器 SSID",
                value: wifiSsid,
                onChange: function (e) { setWifiSsid(e.target.value); },
                onBlur: function () { run("set-wifi-fw", { ssid: wifiSsid, pass: wifiPass }); }
              })),
            h(Field, { label: "Wi-Fi 密码" },
              h("input", {
                style: Object.assign({}, S.input, { width: "150px" }), type: "password", placeholder: "留空＝开放网络",
                value: wifiPass,
                onChange: function (e) { setWifiPass(e.target.value); },
                onBlur: function () { run("set-wifi-fw", { ssid: wifiSsid, pass: wifiPass }); }
              })),
            h("button", {
              style: S.btn, title: "把上面两个值烧进 ESP 固件并编译",
              onClick: function () {
                if (!wifiSsid.trim()) { setFwNote("先填 Wi-Fi 名称"); return; }
                setFwNote("正在生成（首次约 30 s）…");
                run("set-wifi-fw", { ssid: wifiSsid, pass: wifiPass });
                run("gen-firmware", { ssid: wifiSsid, pass: wifiPass }).then(function (r) {
                  if (r && r.ok && r.result) setFwNote("已生成 " + Math.round((r.result.bytes || 0) / 1024) + " KB");
                  else setFwNote("生成失败：" + ((r && r.error) || "未知错误"));
                });
              }
            }, "生成固件"),
            h("button", {
              style: S.btn, title: "把刚生成的固件烧到 ESP（GPIO0 需接地）",
              onClick: function () {
                if (!state.port) { setFwNote("先选 ESP 的串口"); return; }
                setFwNote("正在烧 ESP（" + state.port + "）…");
                run("flash-esp", { port: state.port }).then(function (r) {
                  if (r && r.ok) setFwNote("ESP 已烧录 " + state.port);
                  else setFwNote("烧录失败：" + ((r && r.error) || "未知错误"));
                });
              }
            }, "烧到 ESP"),
            h("div", { style: { flexBasis: "100%", height: "0px" } }),
            fwNote ? h("span", { style: S.dim }, fwNote) : null,
            state.wifi && state.wifi.firmware
              ? h("span", { style: S.dim }, "上次：" + state.wifi.firmware.name + " · " + Math.round((state.wifi.firmware.bytes || 0) / 1024) + " KB")
              : null,
            h("span", { style: { paddingBottom: "4px" } }, h(Toggle, { checked: watch, onChange: function (next) { setWatch(next); }, label: "烧完抓 5s 串口" })),
            h("button", { style: S.btn, onClick: function () {
              run("set-transport", { transport: state.transport });
              run("set-port", { port: state.port, baud: Number(baudText) || 115200 });
              run("set-retry", { retry: Number(retryText) || 3 });
              run("set-wifi", { host: espHost, port: Number(espPort) || 23 });
            } }, "全部应用")
          ),
          h("div", { style: S.dim }, "ESP 主机是 0.2.0 无线传输的接入点；现在填好不会影响有线烧录。")
        ) : null,

        h("div", { style: S.body },
          h("div", { style: S.logCard },
            h("div", { style: S.logHead },
              [{ key: "", label: "全部" }, { key: "build", label: "编译" }, { key: "flash", label: "烧录" }, { key: "serial", label: "串口" }, { key: "sys", label: "系统" }].map(function (tab) {
                return h("span", {
                  key: tab.key,
                  style: Object.assign({}, S.tab, channel === tab.key ? { opacity: 1, background: "rgba(127,127,127,0.18)" } : null),
                  onClick: function () { setChannel(tab.key); }
                }, tab.label);
              }),
              h("span", { style: { flex: 1 } }),
              h(Toggle, { checked: follow, onChange: function (next) { setFollow(next); }, label: "跟随" }),
              h("input", { style: Object.assign({}, S.input, { width: "120px" }), placeholder: "过滤", value: filter, onChange: function (e) { setFilter(e.target.value); } })
            ),
            h("div", {
              ref: logRef,
              style: Object.assign({}, S.logBody, {
                background: logBackground(prefs),
                fontSize: prefs.fontSize + "px",
                lineHeight: String(prefs.lineHeight),
                whiteSpace: prefs.wrap ? "pre-wrap" : "pre"
              })
            },
              shown.length === 0
                ? h("div", { style: S.dim }, "暂无日志。点「编译」开始。")
                : shown.slice(-prefs.maxLines).map(function (entry) {
                  return h("div", { key: (entry.instance || "") + ":" + entry.seq, style: { color: lineColor(prefs, entry.channel), whiteSpace: prefs.wrap ? "pre-wrap" : "pre" } },
                    prefs.timestamps ? h("span", { style: { opacity: 0.45, marginRight: "6px" } }, clock(entry.t)) : null,
                    entry.text
                  );
                })
            ),
            state.serialOpen ? h("div", { style: Object.assign({}, S.logHead, { borderTop: "1px solid rgba(127,127,127,0.16)", borderBottom: "none" }) },
              h("input", {
                style: Object.assign({}, S.input, { flex: 1 }),
                placeholder: "向串口发送（回车提交）", value: sendText,
                onChange: function (e) { setSendText(e.target.value); },
                onKeyDown: function (e) {
                  if (e.key !== "Enter" || !sendText) return;
                  run("serial-write", { text: sendText + "\n" });
                  setSendText("");
                }
              })
            ) : null
          ),

          h("div", { style: S.side },
            h("div", { style: S.sideCard },
              h("div", { style: S.sideTitle }, "工程"),
              h("div", { style: Object.assign({}, S.dim, { wordBreak: "break-all" }) }, state.project || "未选择"),
              h("div", { style: { display: "flex", gap: "6px", marginTop: "4px", flexWrap: "wrap" } },
                h("button", { style: S.btn, title: "选择包含 .uvprojx 的工程目录", onClick: function () {
                  var useFolder = function (folder) {
                    if (!folder) return;
                    setProjectPath(folder);
                    run("checkout", { folder: folder });
                  };
                  if (directoryPicker) {
                    Promise.resolve(directoryPicker()).then(useFolder).catch(function () {
                      return run("pick-folder").then(function (r) {
                        if (r && r.ok && r.result) useFolder(r.result.folder);
                      });
                    });
                    return;
                  }
                  run("pick-folder").then(function (r) {
                    if (r && r.ok && r.result) useFolder(r.result.folder);
                  });
                } }, "选择文件夹…"),
                h("button", { style: S.btn, title: "按设置里的扫描根目录查找 .uvprojx", onClick: function () {
                  run("projects", { roots: splitRoots(look.searchRoots) }).then(function (r) {
                    if (!r || !r.ok || !r.result) return;
                    setProjects(Array.isArray(r.result.items) ? r.result.items : []);
                    setScanInfo(r.result);
                  });
                } }, "扫描工程"),
                h("button", { style: S.btn, onClick: function () { if (projectPath) run("set-project", { file: projectPath }); } }, "使用此路径")
              ),
              h("input", { style: S.input, placeholder: "D:\\work\\Project.uvprojx", value: projectPath, onChange: function (e) { setProjectPath(e.target.value); } }),
              scanInfo ? h("div", {
                style: Object.assign({}, S.dim, { marginTop: "2px" }),
                title: "扫描范围：\n" + (scanInfo.roots || []).join("\n")
              }, "扫描了 " + (scanInfo.roots || []).length + " 个根目录 / " + (scanInfo.scannedDirs || 0) + " 个文件夹，找到 " +
                (scanInfo.items || []).length + " 个工程" + (scanInfo.truncated ? "（已截断，可在设置里缩小范围）" : "") + " · 悬停看范围") : null,
              projects.length ? h(Dropdown, {
                value: "",
                width: "100%",
                options: [{ id: "", label: "共 " + projects.length + " 个工程…" }].concat(projects.map(function (p) {
                  return { id: p.file, label: (p.device || "?") + "  " + p.name };
                })),
                onChange: function (id) { if (id) { setProjectPath(id); run("set-project", { file: id }); } }
              }) : null
            ),
            h("div", { style: Object.assign({}, S.sideCard, { flex: 1, overflow: "auto" }) },
              h("div", { style: S.sideTitle }, "诊断" + (diagnostics.length ? " (" + diagnostics.length + ")" : "")),
              diagnostics.length === 0
                ? h("div", { style: S.dim }, "编译通过或尚未编译")
                : diagnostics.map(function (item, index) {
                  return h("div", {
                    key: index,
                    style: Object.assign({}, S.diag, item.severity === "warning" ? { background: "rgba(210,153,34,0.08)", borderColor: "rgba(210,153,34,0.2)" } : null),
                    title: "点击在 VSCode 中打开",
                    onClick: function () { run("open-vscode", { file: item.file, line: item.line }); }
                  },
                    h("div", { style: { color: item.severity === "warning" ? "#d29922" : "#f85149" } }, (item.severity === "warning" ? "WARN " : "ERROR ") + item.file.replace(/^.*[\\/]/, "") + ":" + item.line),
                    h("div", { style: { opacity: 0.8, marginTop: "2px" } }, item.message)
                  );
                })
            )
          )
        )
      );
    }

    // ------------------------------------------------------------ settings card
    var FIELDS = [
      { key: "uv4Path", label: "Keil uVision (UV4.exe)", placeholder: "留空自动探测 D:\\Keli_v5\\UV4\\UV4.exe", wide: true },
      { key: "cubeMxPath", label: "STM32CubeMX 路径", placeholder: "留空自动探测" },
      { key: "pythonPath", label: "Python (需 pyserial)", placeholder: "留空自动探测" },
      { key: "project", label: "默认工程 (.uvprojx)", placeholder: "也可在 STM32 总管页面里选" },
      { key: "searchRoots", label: "扫描根目录（分号分隔）", placeholder: "留空＝桌面/文档/下载 + 工程所在盘", wide: true },
      { key: "httpPort", label: "桥接端口 (127.0.0.1)", type: "number", restart: true },
      { key: "toolCallTimeoutMs", label: "单次工具超时 (ms)", type: "number", restart: true }
    ];

    /** Official settings rhythm: hairline between items, label left, control right. */
    var SETTINGS_DIVIDER = "1px solid var(--dsw-alias-border-l, rgba(127,127,127,0.18))";

    /** Category heading: the row above already drew the rule, so no border here. */
    function settingsGroup(key, title, hint) {
      return h("div", {
        key: key,
        style: { display: "flex", alignItems: "baseline", gap: "8px", padding: "14px 0 2px" }
      },
        h("div", { style: { fontSize: "12.5px", fontWeight: 600, letterSpacing: "0.2px" } }, title),
        hint ? h("span", { style: S.dim }, hint) : null
      );
    }

    function settingsRow(key, label, hint, control) {
      return h("div", {
        key: key,
        style: {
          display: "flex", alignItems: "center", gap: "16px",
          padding: "10px 0",
          borderBottom: SETTINGS_DIVIDER
        }
      },
        h("div", { style: { flex: 1, minWidth: 0 } },
          h("div", { style: { fontSize: "12.5px" } }, label),
          hint ? h("div", { style: Object.assign({}, S.dim, { marginTop: "2px" }) }, hint) : null
        ),
        control
      );
    }

    var LOG_FIELDS = [
      { key: "logFontSize", label: "日志字号 (px)", type: "number", min: 9, max: 20, step: 1 },
      { key: "logLineHeight", label: "日志行高", type: "number", min: 1, max: 2.4, step: 0.1 },
      { key: "logMaxLines", label: "日志最多显示行数", type: "number", min: 50, max: 5000, step: 50 }
    ];

    var LOG_COLOR_FIELDS = [
      { key: "logColorBuild", label: "编译", fallback: CHANNEL.build },
      { key: "logColorFlash", label: "烧录", fallback: CHANNEL.flash },
      { key: "logColorSerial", label: "串口", fallback: CHANNEL.serial },
      { key: "logColorSys", label: "系统", fallback: CHANNEL.sys },
      { key: "logBgFrom", label: "渐变起", fallback: "#0d1117" },
      { key: "logBgTo", label: "渐变止", fallback: "#161b22" }
    ];

    function SettingsCard() {
      var valueBox = React.useState({});
      var value = valueBox[0], setValue = valueBox[1];
      var revBox = React.useState(undefined);
      var revision = revBox[0], setRevision = revBox[1];
      var statusBox = React.useState("loading");
      var status = statusBox[0], setStatus = statusBox[1];
      var msgBox = React.useState("");
      var message = msgBox[0], setMessage = msgBox[1];
      var writableBox = React.useState(true);
      var writable = writableBox[0], setWritable = writableBox[1];
      var dragBox = React.useState(null);
      var dragFrom = dragBox[0], setDragFrom = dragBox[1];
      var overBox = React.useState(null);
      var dragOver = overBox[0], setDragOver = overBox[1];

      React.useEffect(function () {
        var alive = true;
        fetch(API + "/settings/describe").then(function (r) { return r.json(); }).then(function (data) {
          if (!alive) return;
          var ns = (data.namespaces || [])[0];
          if (!ns) { setStatus("unavailable"); return; }
          setValue(ns.value || {});
          setRevision(ns.revision);
          setWritable(data.writable !== false);
          setStatus("ready");
        }).catch(function (error) {
          if (alive) { setStatus("unavailable"); setMessage(String(error.message || error)); }
        });
        return function () { alive = false; };
      }, []);

      function update(key, next) {
        setValue(function (prev) { var copy = Object.assign({}, prev); copy[key] = next; return copy; });
      }

      function reorder(from, to) {
        update("cardOrder", moveCard(resolveOrder(value.cardOrder), from, to).join(","));
      }

      function save() {
        var ops = buildOps(value);
        setMessage("保存中…");
        fetch(API + "/settings/mutate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ops: ops, revision: revision })
        }).then(function (r) { return r.json(); }).then(function (result) {
          if (result.ok) {
            var merged = result.namespace ? mergeForm(value, result.namespace.value) : value;
            setValue(merged);
            if (result.namespace) setRevision(result.namespace.revision);
            setMessage("已保存");
            lookStore.set(presentationFromForm(merged));
            // Toolchain paths are consumed by the bridge process: hand them over now
            // instead of waiting for the host to re-apply the plugin.
            post("set-tools", {
              uv4Path: String(merged.uv4Path || ""),
              cubeMxPath: String(merged.cubeMxPath || ""),
              pythonPath: String(merged.pythonPath || ""),
              project: String(merged.project || "")
            }).catch(function () { /* the profile still holds them for the next start */ });
          } else {
            setMessage(result.code === "SETTINGS_CONFLICT" ? "设置已在别处被修改，请刷新后重试" : ("保存失败：" + (result.message || result.code)));
          }
        }).catch(function (error) { setMessage("保存失败：" + String(error.message || error)); });
      }

      var card = { display: "flex", flexDirection: "column", gap: "10px", padding: "14px", borderRadius: "10px", border: "1px solid rgba(127,127,127,0.18)", color: "inherit" };
      if (status === "loading") return h("div", { style: card }, h("div", { style: S.dim }, "读取设置…"));
      if (status === "unavailable") return h("div", { style: card }, h("div", { style: S.dim }, "设置服务不可用" + (message ? "：" + message : "")));

      return h("div", { style: card },
        h("div", { style: { fontSize: "15px", fontWeight: 600 } }, "STM32 工具链"),
        h("div", { style: S.dim }, "这里只配置这台机器上的工具链（编译器/生成器/桥接）；烧录相关参数在「STM32 总管」页面里。"),

        settingsGroup("group-basic", "常规"),
        settingsRow("enabled", "启用插件", "开关需要宿主重载插件（重启 DSH）才生效",
          h(Toggle, {
            checked: value.enabled !== false,
            onChange: function (next) { update("enabled", next); },
            disabled: !writable
          })),
        settingsRow("announce", "把 STM32 工作规范注入系统提示", "改动后需重启 DSH（系统提示在插件加载时注入）",
          h(Toggle, {
            checked: value.announceToAgent !== false,
            onChange: function (next) { update("announceToAgent", next); },
            disabled: !writable
          })),
        settingsGroup("group-toolchain", "工具链", "留空的路径交给自动探测"),
        FIELDS.map(function (field) {
          var hint = field.restart ? "改动后需重启 DSH 才生效（由宿主启动参数决定）" : null;
          return settingsRow(field.key, field.label, hint,
            h("input", {
              style: Object.assign({}, S.input, { width: field.type === "number" ? "120px" : field.wide ? "320px" : "240px", opacity: writable ? 1 : 0.5 }),
              type: field.type === "number" ? "number" : "text",
              placeholder: field.placeholder || "",
              value: value[field.key] === undefined || value[field.key] === null ? "" : String(value[field.key]),
              disabled: !writable,
              onChange: function (e) { update(field.key, e.target.value); }
            })
          );
        }),
        settingsGroup("group-log", "日志文字", "只影响面板里那块日志"),
        LOG_FIELDS.map(function (field) {
          return settingsRow(field.key, field.label, null,
            h("input", {
              style: Object.assign({}, S.input, { width: "120px", opacity: writable ? 1 : 0.5 }),
              type: "number",
              min: field.min, max: field.max, step: field.step,
              value: value[field.key] === undefined || value[field.key] === null ? "" : String(value[field.key]),
              disabled: !writable,
              onChange: function (e) { update(field.key, e.target.value); }
            })
          );
        }),
        settingsRow("logWrap", "自动换行", "关闭后长行横向滚动",
          h(Toggle, { checked: value.logWrap !== false, onChange: function (next) { update("logWrap", next); }, disabled: !writable })),
        settingsRow("logTime", "显示时间戳", "每行前缀 HH:MM:SS",
          h(Toggle, { checked: value.logTimestamps === true, onChange: function (next) { update("logTimestamps", next); }, disabled: !writable })),

        settingsGroup("group-log-color", "日志颜色", "留空即用主题默认色"),
        settingsRow("logBgGradient", "背景渐变", "日志区背景用线性渐变",
          h(Toggle, { checked: value.logBgGradient === true, onChange: function (next) { update("logBgGradient", next); }, disabled: !writable })),
        h("div", {
          style: {
            display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            gap: "8px 18px", padding: "10px 0", borderBottom: SETTINGS_DIVIDER
          }
        }, LOG_COLOR_FIELDS.map(function (field) {
          var isStop = field.key === "logBgFrom" || field.key === "logBgTo";
          var dimmed = isStop && value.logBgGradient !== true;
          return h("label", {
            key: field.key,
            style: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0, opacity: dimmed ? 0.45 : 1 }
          },
            h("input", {
              type: "color",
              value: value[field.key] || field.fallback,
              disabled: !writable || dimmed,
              onChange: function (e) { update(field.key, e.target.value); },
              style: { width: "38px", height: "24px", padding: 0, border: "1px solid var(--dsw-alias-border-l, rgba(127,127,127,0.3))", borderRadius: "6px", background: "transparent", cursor: "pointer", flex: "0 0 auto" }
            }),
            h("span", { style: { fontSize: "12.5px" } }, field.label),
            h("span", { style: Object.assign({}, S.dim, { marginLeft: "auto", whiteSpace: "nowrap" }) }, value[field.key] || "默认")
          );
        })),

        h("div", { style: { paddingTop: "12px" } },
          h("div", { style: { fontSize: "12.5px", fontWeight: 600, marginBottom: "6px" } }, "日志预览"),
          h("div", { style: Object.assign({}, S.dim, { marginBottom: "8px" }) }, "随上面的调整实时变化，不用先保存"),
          h(LogSample, { prefs: logPrefs(value) })
        ),

        settingsGroup("group-order", "状态卡排序", "按住右侧 ≡ 拖动；1–4 在第一行，5–8 在第二行"),
        h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
          resolveOrder(value.cardOrder).map(function (id, index) {
            var label = "—";
            CARDS.forEach(function (card) { if (card.id === id) label = card.label; });
            var isDragging = dragFrom === index;
            var isTarget = dragOver === index && dragFrom !== null && dragFrom !== index;
            return h("div", {
              key: id,
              draggable: writable,
              title: writable ? "拖动排序（第 " + (index + 1) + " 位）" : "设置不可写",
              onDragStart: function (event) {
                setDragFrom(index);
                if (event.dataTransfer) {
                  event.dataTransfer.effectAllowed = "move";
                  try { event.dataTransfer.setData("text/plain", String(index)); } catch (error) { /* older hosts */ }
                }
              },
              onDragEnter: function (event) {
                event.preventDefault();
                if (dragFrom !== null && dragFrom !== index) setDragOver(index);
              },
              onDragOver: function (event) {
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
              },
              onDrop: function (event) {
                event.preventDefault();
                if (dragFrom !== null) reorder(dragFrom, index);
                setDragFrom(null);
                setDragOver(null);
              },
              onDragEnd: function () { setDragFrom(null); setDragOver(null); },
              style: {
                display: "flex", alignItems: "center", gap: "8px",
                padding: "4px 8px", borderRadius: "7px",
                border: "1px solid " + (isTarget ? "rgba(76,154,255,0.75)" : "rgba(127,127,127,0.22)"),
                background: isTarget ? "rgba(76,154,255,0.10)" : "transparent",
                opacity: isDragging ? 0.4 : writable ? 1 : 0.55,
                cursor: writable ? "grab" : "not-allowed"
              }
            },
              h("span", { style: { width: "16px", textAlign: "right", opacity: 0.5, fontSize: "11.5px" } }, String(index + 1)),
              h("span", { style: { flex: 1, fontSize: "12.5px" } }, label),
              h("span", { style: { opacity: 0.45, fontSize: "11px" } }, index < 4 ? "行1" : "行2"),
              h("span", { style: { opacity: 0.55, fontSize: "14px", letterSpacing: "-1px", userSelect: "none" }, title: "拖动" }, "≡")
            );
          })
        ),

        h("div", { style: Object.assign({}, S.row, { marginTop: "4px" }) },
          h("span", { style: S.dim }, message),
          h("span", { style: { flex: 1 } }),
          h("button", { style: S.btnPrimary, onClick: save, disabled: !writable }, "保存")
        ),
        h("div", { style: S.dim }, "修订号 " + (revision === undefined ? "—" : revision) + " · 只写本插件命名空间 stm32-toolchain")
      );
    }

    function SidebarIcon() {
      return h("span", { style: { fontWeight: 700, fontSize: "11px", letterSpacing: "0.5px" } }, "MCU");
    }

    var inject = ["slots"];
    function apply(ctx) {
      var desktopPicker = globalThis.__DSH_DIRECTORY_PICKER__;
      if (desktopPicker && typeof desktopPicker.pick === "function") {
        directoryPicker = function () { return Promise.resolve(desktopPicker.pick()); };
      }
      if (typeof ctx.inject === "function") {
        ctx.inject(["sessions"], function (sctx) { sessionsService = sctx.sessions || null; });
        ctx.inject(["uiWorkspace"], function (sctx) {
          var workspace = sctx.uiWorkspace;
          if (workspace) workspaceService = workspace;
          if (!directoryPicker && workspace && typeof workspace.pickDirectory === "function") {
            directoryPicker = function () { return workspace.pickDirectory(); };
          }
        });
      }
      ctx.slots.inject("conversation.session.header.actions", function () {
        var unregister = ctx.slots.register({
          name: "conversation.session.header.actions",
          id: ID + "-bind",
          order: 50,
          label: function () { return "绑定 STM32"; },
          inject: function (sessionId) { return { sessionId: sessionId } }
        }, BindSessionButton);
        return function () { unregister(); };
      });
      ctx.slots.inject("sidebar.panellist", function () {
        var unregister = ctx.slots.register({ name: "sidebar.panellist", id: ID, order: 30, label: function () { return "STM32 总管"; } }, SidebarIcon);
        return function () { unregister(); };
      });
      ctx.slots.inject("main", function () {
        var unregister = ctx.slots.register({ name: "main", key: ID, order: 30, label: function () { return "STM32"; } }, Dashboard);
        return function () { unregister(); };
      });
      ctx.slots.inject("settings.section", function () {
        var unregister = ctx.slots.register({
          name: "settings.section",
          id: ID,
          order: 40,
          label: function () { return "STM32 工具链"; }
        }, SettingsCard);
        return function () { unregister(); };
      });
    }

    module.exports = {
      apply: apply,
      inject: inject,
      __internals: {
        presentationFromForm: presentationFromForm, resolveLook: resolveLook, lookStore: lookStore, splitRoots: splitRoots,
        buildOps: buildOps, mergeForm: mergeForm,
        resolveOrder: resolveOrder, moveCard: moveCard, logPrefs: logPrefs, lineColor: lineColor,
        logBackground: logBackground, LOG_SAMPLES: LOG_SAMPLES, CARDS: CARDS, DEFAULT_ORDER: DEFAULT_ORDER
      }
    };
    return module.exports;
  }
});
