/* Voice dictation for the composer (Web Speech API). Loaded as a plain script; exposes window.HVAC_VOICE.
 * Works in Safari (iOS 14.5+, macOS) and Chrome/Edge (Android, desktop). Firefox has no recognizer: the
 * mic button stays hidden there. Audio is processed by the browser's speech service, not by this app. */
(function () {
  "use strict";
  var Recognizer = typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : undefined;
  var active = null;

  /** Join interim transcripts into one string, spacing words and keeping the final/interim split. */
  function collect(results) {
    var finalText = "";
    var interim = "";
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var t = r[0] ? r[0].transcript : "";
      if (r.isFinal) finalText += t;
      else interim += t;
    }
    return { finalText: finalText.trim(), interim: interim.trim() };
  }

  /** Technician vocabulary the recognizers get wrong often. Pure; tested in app.test.ts via HVAC_UI. */
  function normalizeDictation(text) {
    var s = String(text || "");
    // "are" (a common mis-hearing of "R") only counts in front of a lettered blend, so "temps are 22" stays a sentence.
    var rules = [
      [/\b(?:r|are)[ -]?(?:four|4) ?(?:ten|10) ?a\b/gi, "R-410A"],
      [/\b(?:r|are)[ -]?(?:four|4) ?(?:fifty|5) ?(?:four|4) ?b\b/gi, "R-454B"],
      [/\b(?:r|are)[ -]?(?:one|1) ?(?:thirty[ -]?four|thirty|34) ?(?:four)? ?a\b/gi, "R-134a"],
      [/\b(?:r|are)[ -]?(?:four|4) ?(?:oh|o|0) ?(?:seven|7) ?c\b/gi, "R-407C"],
      [/\b(?:r|are)[ -]?(?:four|4) ?(?:oh|o|0) ?(?:four|4) ?a\b/gi, "R-404A"],
      [/\br[ -]?(?:22|twenty[ -]?two)\b/gi, "R-22"],
      [/\br[ -]?(?:32|thirty[ -]?two)\b/gi, "R-32"],
      [/\br-?(\d{3})([abc])\b/gi, function (_m, n, l) { return "R-" + n + (n === "134" ? l.toLowerCase() : l.toUpperCase()); }],
      [/\bp ?s ?i(?: ?g)?\b/gi, "psig"],
      [/\bsuper ?heat\b/gi, "superheat"],
      [/\bsub ?cooling\b/gi, "subcooling"],
      [/\b(t ?x ?v|thermostatic expansion valve)\b/gi, "TXV"],
      [/\b(r ?t ?u)\b/gi, "RTU"],
      [/\b(degrees?|deg\.?) (fahrenheit|f)\b/gi, "°F"],
      [/(\d) degrees\b/gi, "$1 °F"],
      [/\bdelta ?t\b/gi, "ΔT"],
      [/\bamp(s|erage)?\b/gi, "A"],
    ];
    for (var i = 0; i < rules.length; i++) s = s.replace(rules[i][0], rules[i][1]);
    return s.replace(/\s+/g, " ").trim();
  }

  function start(opts) {
    if (!Recognizer) return null;
    if (active) stop();
    var rec = new Recognizer();
    rec.lang = (opts && opts.lang) || (navigator.language || "en-US");
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    var ended = false;
    rec.onresult = function (ev) {
      var c = collect(ev.results);
      if (opts && opts.onText) opts.onText(c.finalText, c.interim);
    };
    rec.onerror = function (ev) {
      var code = ev && ev.error ? ev.error : "unknown";
      var message =
        code === "not-allowed" || code === "service-not-allowed"
          ? "Microphone access was blocked. Allow it for this site in the browser settings."
          : code === "no-speech"
            ? "No speech heard."
            : code === "network"
              ? "Speech recognition needs a connection."
              : "Dictation stopped (" + code + ").";
      if (opts && opts.onError) opts.onError(code, message);
    };
    rec.onend = function () {
      if (ended) return;
      ended = true;
      if (active === rec) active = null;
      if (opts && opts.onEnd) opts.onEnd();
    };
    try {
      rec.start();
    } catch (e) {
      if (opts && opts.onError) opts.onError("start-failed", "Dictation could not start.");
      return null;
    }
    active = rec;
    return rec;
  }

  function stop() {
    if (!active) return;
    var rec = active;
    active = null;
    try {
      rec.stop();
    } catch (e) {
      /* already stopped */
    }
  }

  var api = {
    supported: Boolean(Recognizer),
    start: start,
    stop: stop,
    isListening: function () {
      return Boolean(active);
    },
    normalizeDictation: normalizeDictation,
    collect: collect,
  };
  if (typeof window !== "undefined") window.HVAC_VOICE = api;
  if (typeof globalThis !== "undefined") globalThis.HVAC_VOICE = api;
})();
