/* Learnza languages: English, Yorùbá, Hausa, Igbo and Naijá Pidgin.
 *
 * Three choices are kept apart (Settings > Language):
 *   ui    - the language of the app's screens, menus, buttons, messages
 *   ai    - the language Learnza and the research assistant teach and answer in (the server does that part)
 *   voice - the language used to listen to the student and to speak back
 *
 * The screens are translated from the catalogue files in /i18n/<code>.json (English text -> translation). Only text that
 * is in the catalogue is changed, word for word, so lecture notes, questions, answers, formulas, names and anything the
 * student typed are never touched. Anything missing from a catalogue simply stays in English. The English-only page
 * costs nothing: nothing is loaded and no observer runs until another language is chosen.
 */
(function () {
  'use strict';
  var LANGS = [
    { code: 'en', name: 'English', native: 'English', sr: 'en-NG' },
    { code: 'yo', name: 'Yoruba', native: 'Yorùbá', sr: 'yo-NG' },
    { code: 'ha', name: 'Hausa', native: 'Hausa', sr: 'ha-NG' },
    { code: 'ig', name: 'Igbo', native: 'Igbo', sr: 'ig-NG' },
    { code: 'pcm', name: 'Nigerian Pidgin', native: 'Naijá Pidgin', sr: 'en-NG' },
  ];
  var BY = {}; LANGS.forEach(function (l) { BY[l.code] = l; });
  var STORE = 'lz_lang';

  var prefs = { ui: 'en', ai: 'en', voice: 'en' };
  var exact = Object.create(null);      // 'English text' -> 'translation'
  var patterns = [];                    // [{ re, parts, out }] for entries with {0}, {1} placeholders
  var loaded = {};                      // code -> true once its catalogue is in
  var catalogues = {};                  // code -> raw map
  var seen = new WeakMap();             // text node / element -> what we last wrote and the English it came from
  var observer = null;
  var pending = null;
  var busy = false;
  var pickedAtLogin = false;           // the student chose a language on the sign-in screen, before this sign-in

  function readStore() {
    try { var s = JSON.parse(localStorage.getItem(STORE) || 'null'); if (s) { ['ui', 'ai', 'voice'].forEach(function (k) { if (BY[s[k]]) prefs[k] = s[k]; }); } } catch (e) { /* storage may be blocked */ }
  }
  function writeStore() { try { localStorage.setItem(STORE, JSON.stringify(prefs)); } catch (e) { /* ignore */ } }

  // ---------------------------------------------------------------- catalogue -> lookup tables
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function prepare(map) {
    exact = Object.create(null); patterns = [];
    Object.keys(map).forEach(function (k) {
      var v = map[k];
      if (typeof v !== 'string' || !v) return;
      if (/\{(\d|n|m)\}/.test(k)) {
        // {0}..{9} stand for any text, {n} and {m} only for a number
        var names = [];
        var re = new RegExp('^' + k.split(/(\{(?:\d|n|m)\})/).map(function (part) {
          var t = part.match(/^\{(\d|n|m)\}$/);
          if (t) { names.push(t[1]); return /\d/.test(t[1]) ? '(.+?)' : '(\\d+(?:[.,]\\d+)?)'; }
          return esc(part);
        }).join('') + '$');
        patterns.push({ re: re, names: names, out: v, len: k.length });
      } else exact[k] = v;
    });
    patterns.sort(function (a, b) { return b.len - a.len; });
  }

  function load(code) {
    if (code === 'en') return Promise.resolve({});
    if (catalogues[code]) return Promise.resolve(catalogues[code]);
    return fetch('/i18n/' + code + '.json', { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error('catalogue'); return r.json(); })
      .then(function (m) { catalogues[code] = m; return m; })
      .catch(function () { return {}; });   // no catalogue: everything stays in English
  }

  // ---------------------------------------------------------------- translating text
  var LEAD = /^[^\p{L}\p{N}"'“]+/u;         // emoji, arrows, +, ✕ and the like in front of a label
  var TRAIL = /[^\p{L}\p{N}"'”)]+$/u;       // ..., :, →, ! after a label
  function lookup(core) {
    var v = exact[core];
    if (v) return v;
    for (var i = 0; i < patterns.length; i++) {
      var pt = patterns[i], m = core.match(pt.re);
      if (m) return pt.out.replace(/\{(\d|n|m)\}/g, function (_, name) { var at = pt.names.indexOf(name); var piece = at < 0 ? '' : m[at + 1]; return /\d/.test(name) ? (lookup(piece) || piece) : piece; });
    }
    return null;
  }
  // "30 objective · 15 minutes · 30 marks": each part on its own
  function lookupParts(core) {
    if (core.indexOf(' · ') < 0) return null;
    var any = false;
    var out = core.split(' · ').map(function (p) { var h = lookup(p.trim()); if (h) any = true; return h || p; });
    return any ? out.join(' · ') : null;
  }
  function translate(text) {
    if (prefs.ui === 'en' || !text) return null;
    var core = text.trim();
    if (!core || core.length > 220) return null;
    var hit = lookup(core) || lookupParts(core);
    if (hit) return hit;
    // "✕ Exit", "← Back", "Next →", "Generating…": translate the words, keep the marks around them
    var lead = (core.match(LEAD) || [''])[0];
    var rest = core.slice(lead.length);
    var trail = (rest.match(TRAIL) || [''])[0];
    var mid = trail ? rest.slice(0, rest.length - trail.length) : rest;
    if (!mid || (!lead && !trail)) return null;
    hit = lookup(mid);
    return hit ? lead + hit + trail : null;
  }
  function t(text, vars) {
    var out = text;
    if (prefs.ui !== 'en') { var hit = translate(String(text)); if (hit) out = hit; }
    if (vars) out = String(out).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] == null ? m : vars[k]; });
    return out;
  }

  // ---------------------------------------------------------------- the page
  var SKIP_TAG = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, PRE: 1, NOSCRIPT: 1, SVG: 1, MATH: 1 };
  var ATTRS = ['placeholder', 'title', 'aria-label'];
  function skipped(el) {
    for (var e = el; e && e.nodeType === 1; e = e.parentNode) {
      if (SKIP_TAG[(e.tagName || '').toUpperCase()] || (e.hasAttribute && (e.hasAttribute('data-i18n-skip') || e.isContentEditable))) return true;
    }
    return false;
  }

  function doText(node) {
    var rec = seen.get(node);
    var cur = node.nodeValue;
    var src = cur;
    if (rec && rec.out === cur) src = rec.src;       // still what we wrote: go back to the English it came from
    if (prefs.ui === 'en') {
      if (rec && rec.out === cur) { node.nodeValue = rec.src; seen.delete(node); }
      return;
    }
    var hit = translate(src);
    if (hit) {
      var lead = src.match(/^\s*/)[0], trail = src.match(/\s*$/)[0];
      var out = lead + hit + trail;
      if (out !== cur) node.nodeValue = out;
      seen.set(node, { src: src, out: out });
    } else if (rec) seen.delete(node);
  }
  function doAttrs(el) {
    var rec = seen.get(el) || {};
    var changed = false;
    ATTRS.forEach(function (a) {
      if (!el.hasAttribute(a)) return;
      var cur = el.getAttribute(a), r = rec[a], src = cur;
      if (r && r.out === cur) src = r.src;
      if (prefs.ui === 'en') { if (r && r.out === cur) { el.setAttribute(a, r.src); delete rec[a]; changed = true; } return; }
      var hit = translate(src);
      if (hit) { if (hit !== cur) el.setAttribute(a, hit); rec[a] = { src: src, out: hit }; changed = true; }
      else if (r) { delete rec[a]; }
    });
    if (el.tagName === 'INPUT' && /^(button|submit)$/i.test(el.type) && el.value) {
      var cv = el.value, rv = rec.value, sv = rv && rv.out === cv ? rv.src : cv;
      if (prefs.ui === 'en') { if (rv && rv.out === cv) el.value = rv.src; }
      else { var h2 = translate(sv); if (h2) { el.value = h2; rec.value = { src: sv, out: h2 }; changed = true; } }
    }
    if (changed || seen.has(el)) seen.set(el, rec);
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { if (!skipped(root.parentNode)) doText(root); return; }
    if (root.nodeType !== 1 || skipped(root)) return;
    doAttrs(root);
    var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: function (n) {
        if (n.nodeType === 1) return (SKIP_TAG[n.tagName.toUpperCase()] || n.hasAttribute('data-i18n-skip') || n.isContentEditable) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    var n;
    while ((n = tw.nextNode())) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
  }

  function apply(root) {
    busy = true;
    try { walk(root || document.body); } catch (e) { /* a failed pass leaves the page in English */ }
    busy = false;
  }

  function flush() {
    if (!pending) return;
    var batch = pending; pending = null;
    if (observer) observer.disconnect();
    busy = true;
    try { batch.forEach(function (n) { if (n.isConnected !== false) walk(n); }); } catch (e) { /* ignore */ }
    busy = false;
    if (observer && prefs.ui !== 'en') observe();
  }
  function queue(n) {
    if (!pending) { pending = []; setTimeout(flush, 20); if (window.requestAnimationFrame) window.requestAnimationFrame(flush); }   // a hidden tab never runs animation frames, so a timer goes too
    pending.push(n);
  }
  function observe() {
    if (!observer) {
      observer = new MutationObserver(function (list) {
        if (busy) return;
        list.forEach(function (m) {
          if (m.type === 'childList') m.addedNodes.forEach(function (n) { if (n.nodeType === 1 || n.nodeType === 3) queue(n); });
          else if (m.type === 'characterData') queue(m.target);
          else if (m.type === 'attributes') queue(m.target);
        });
      });
    }
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  // alert / confirm / prompt speak the chosen language too
  var nativeDialogs = { alert: window.alert, confirm: window.confirm, prompt: window.prompt };
  function wrapDialogs() {
    ['alert', 'confirm', 'prompt'].forEach(function (k) {
      window[k] = function (msg, def) { return nativeDialogs[k].call(window, typeof msg === 'string' ? t(msg) : msg, def); };
    });
  }

  // ---------------------------------------------------------------- changing language
  function setUi(code) {
    if (!BY[code]) code = 'en';
    prefs.ui = code;
    document.documentElement.lang = code === 'pcm' ? 'en' : code;
    return load(code).then(function (m) {
      prepare(m);
      if (!document.body) return;
      if (observer) observer.disconnect();
      apply(document.body);
      if (code !== 'en') observe();
      [].forEach.call(document.querySelectorAll('.lz-lang-pick select'), function (sel) { sel.value = code; });
      try { window.dispatchEvent(new CustomEvent('lzlangchange', { detail: { ui: code } })); } catch (e) { /* old browser */ }
    });
  }

  // The settings the server keeps for a signed-in user win over what this device remembers.
  function sync(user) {
    if (!user) return Promise.resolve();
    var next = { ui: BY[user.uiLanguage] ? user.uiLanguage : 'en', ai: BY[user.aiLanguage] ? user.aiLanguage : 'en', voice: BY[user.voiceLanguage] ? user.voiceLanguage : 'en' };
    var uiChanged = next.ui !== prefs.ui;
    prefs.ai = next.ai; prefs.voice = next.voice;
    writeStore();
    return uiChanged ? (writeStoreWith(next.ui), setUi(next.ui)) : Promise.resolve();
  }
  function writeStoreWith(ui) { prefs.ui = ui; writeStore(); }

  // After signing in: a language picked on the sign-in screen is kept and saved to the account; otherwise the account's own
  // settings apply (so they follow the student from one device to another).
  function afterLogin(user, api) {
    if (pickedAtLogin && user) {
      pickedAtLogin = false;
      var change = { ui: prefs.ui, ai: prefs.ai, voice: prefs.voice };
      return api ? api('/auth/me/language', { method: 'PATCH', body: change }).catch(function () { /* kept on this device */ }) : Promise.resolve();
    }
    return sync(user);
  }

  // Save a change (any of ui / ai / voice) on this device at once, and on the account when signed in.
  function save(change, api) {
    var before = { ui: prefs.ui, ai: prefs.ai, voice: prefs.voice };
    Object.keys(change).forEach(function (k) { if (BY[change[k]]) prefs[k] = change[k]; });
    writeStore();
    var p = change.ui && change.ui !== before.ui ? setUi(change.ui) : Promise.resolve();
    if (!api) return p;
    return p.then(function () { return api('/auth/me/language', { method: 'PATCH', body: change }); });
  }

  // ---------------------------------------------------------------- voice helpers
  function voiceTag() { return (BY[prefs.voice] || BY.en).sr; }
  // The browser's own voice for a language, when the device has one (most have none for Yoruba, Hausa or Igbo).
  function pickVoice(code) {
    var syn = window.speechSynthesis;
    if (!syn || !syn.getVoices) return null;
    var voices = syn.getVoices() || [];
    var want = (BY[code] || BY.en);
    var base = want.sr.split('-')[0].toLowerCase();
    var exactV = voices.filter(function (v) { return v.lang && v.lang.toLowerCase().replace('_', '-') === want.sr.toLowerCase(); })[0];
    if (exactV) return exactV;
    var sameLang = voices.filter(function (v) { return v.lang && v.lang.toLowerCase().indexOf(base) === 0; })[0];
    if (sameLang) return sameLang;
    if (code === 'en' || code === 'pcm') return voices.filter(function (v) { return /^en[-_](NG|GB|US|ZA)/i.test(v.lang || ''); })[0] || voices.filter(function (v) { return /^en/i.test(v.lang || ''); })[0] || null;
    return null;     // no browser voice for this language
  }

  // ---------------------------------------------------------------- Settings > Language
  function optionsHtml(sel) { return LANGS.map(function (l) { return '<option value="' + l.code + '"' + (l.code === sel ? ' selected' : '') + '>' + l.native + (l.native !== l.name ? ' (' + l.name + ')' : '') + '</option>'; }).join(''); }
  function settingsHtml() {
    var same = prefs.ui === prefs.ai && prefs.ai === prefs.voice;
    return '<div class="settings-card" id="lz-lang-card" style="padding:14px 16px;">' +
      '<div class="field" style="margin-bottom:12px;"><label>App language</label><select id="lz-lang-ui">' + optionsHtml(prefs.ui) + '</select><div class="meta" style="margin-top:4px;">Menus, buttons, messages and help text.</div></div>' +
      '<label style="display:flex;gap:8px;align-items:center;margin:0 0 12px;font-weight:600;cursor:pointer;"><input type="checkbox" id="lz-lang-same"' + (same ? ' checked' : '') + '> Use this language for the Learnza and voice too</label>' +
      '<div id="lz-lang-more"' + (same ? ' hidden' : '') + '>' +
      '<div class="field" style="margin-bottom:12px;"><label>Learnza teaching language</label><select id="lz-lang-ai">' + optionsHtml(prefs.ai) + '</select><div class="meta" style="margin-top:4px;">What the Learnza Lecturer and the research assistant write and say. Formulas, units and official exam terms stay as they are.</div></div>' +
      '<div class="field" style="margin-bottom:4px;"><label>Voice language</label><select id="lz-lang-voice">' + optionsHtml(prefs.voice) + '</select><div class="meta" style="margin-top:4px;">The language you speak in and the Learnza speaks back in. If your device has no voice for it, the Learnza shows the words and speaks in English or Pidgin.</div></div>' +
      '</div></div>';
  }
  function wireSettings(root, ctx) {
    var ui = root.querySelector('#lz-lang-ui'), ai = root.querySelector('#lz-lang-ai'), vo = root.querySelector('#lz-lang-voice'), same = root.querySelector('#lz-lang-same'), more = root.querySelector('#lz-lang-more');
    if (!ui) return;
    function persist(change) {
      save(change, ctx && ctx.api).then(function () { if (ctx && ctx.toast) ctx.toast(t('Language saved')); })
        .catch(function (e) { if (ctx && ctx.toast) ctx.toast((e && e.message) || t('Could not save the language.')); });
    }
    ui.addEventListener('change', function () {
      if (same.checked) { ai.value = ui.value; vo.value = ui.value; persist({ ui: ui.value, ai: ui.value, voice: ui.value }); }
      else persist({ ui: ui.value });
    });
    ai.addEventListener('change', function () { persist({ ai: ai.value }); });
    vo.addEventListener('change', function () { persist({ voice: vo.value }); });
    same.addEventListener('change', function () {
      more.hidden = same.checked;
      if (same.checked) { ai.value = ui.value; vo.value = ui.value; persist({ ai: ui.value, voice: ui.value }); }
    });
  }

  // A small language switch for the sign-in screens, where there is no account yet.
  function mountPicker(host) {
    if (!host || host.querySelector('.lz-lang-pick')) return;
    var d = document.createElement('div');
    d.className = 'lz-lang-pick';
    d.innerHTML = '<span aria-hidden="true">🌐</span><select aria-label="Language">' + optionsHtml(prefs.ui) + '</select>';
    d.querySelector('select').addEventListener('change', function (e) { pickedAtLogin = true; save({ ui: e.target.value, ai: e.target.value, voice: e.target.value }); });
    host.appendChild(d);
  }


  // ---------------------------------------------------------------- listening and speaking
  // listen(): one spoken question. Uses the voice language; if the browser cannot recognise that language it says so
  // (onFallback) and listens for English instead, so the student is never left with a dead microphone.
  function listen(o) {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { if (o.onError) o.onError('unsupported'); return null; }
    var ctl = { rec: null, stopped: false, stop: function () { ctl.stopped = true; try { ctl.rec && ctl.rec.stop(); } catch (e) { /* already stopped */ } } };
    var heard = false, usedFallback = false;
    function begin(tag) {
      var r = new SR();
      ctl.rec = r;
      r.lang = tag; r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
      var finalText = '';
      r.onstart = function () { if (o.onStart) o.onStart(tag); };
      r.onresult = function (e) {
        var text = '';
        for (var i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
        heard = true; finalText = text.trim();
        if (o.onText) o.onText(finalText);
      };
      r.onerror = function (e) {
        if (e.error === 'language-not-supported' && !usedFallback && tag !== 'en-NG') {
          usedFallback = true;
          if (o.onFallback) o.onFallback(tag);
          r.onend = null;
          setTimeout(function () { if (!ctl.stopped) begin('en-NG'); }, 50);
          return;
        }
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { if (o.onError) o.onError('denied'); }
        else if (e.error === 'no-speech' || e.error === 'aborted') { /* handled in onend */ }
        else if (o.onError) o.onError(e.error || 'failed');
      };
      r.onend = function () { if (ctl.stopped) { if (o.onEnd) o.onEnd(false, ''); return; } if (o.onEnd) o.onEnd(heard, finalText); };
      try { r.start(); } catch (e) { if (o.onError) o.onError('failed'); }
    }
    begin(voiceTag());
    return ctl;
  }

  var player = null;
  function stopSpeaking() {
    if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ } }
    if (player) { try { player.stop(); } catch (e) { /* ignore */ } player = null; }
  }
  function playPcm(b64, rate) {
    var bin = atob(b64), n = bin.length >> 1;
    var AC = window.AudioContext || window.webkitAudioContext;
    var ctx = new AC();
    var buf = ctx.createBuffer(1, n, rate || 24000), ch = buf.getChannelData(0);
    for (var i = 0; i < n; i++) { var v = (bin.charCodeAt(2 * i + 1) << 8) | bin.charCodeAt(2 * i); if (v & 0x8000) v -= 0x10000; ch[i] = v / 32768; }
    var src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination);
    var handle = { stop: function () { try { src.onended = null; src.stop(); ctx.close(); } catch (e) { /* ignore */ } } };
    handle.done = new Promise(function (res) { src.onended = function () { try { ctx.close(); } catch (e) { /* ignore */ } res(); }; });
    src.start();
    return handle;
  }
  // speak(): read text aloud in the language it is written in. A voice the browser already has is used when there is one;
  // otherwise the server makes the voice. Resolves with how it was spoken: 'browser', 'server' or 'none' (nothing could
  // be spoken, so the words stay on screen).
  function speak(text, o) {
    o = o || {};
    stopSpeaking();
    var code = o.lang || prefs.ai;
    var plain = String(text || '').replace(/[*_#`>]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!plain) return Promise.resolve('none');
    var voice = pickVoice(code);
    if (voice && window.speechSynthesis) {
      return new Promise(function (resolve) {
        var u = new SpeechSynthesisUtterance(plain.slice(0, 3500));
        u.voice = voice; u.lang = voice.lang; u.rate = 0.98;
        u.onstart = function () { if (o.onStart) o.onStart('browser'); };
        u.onend = function () { resolve('browser'); };
        u.onerror = function () { resolve('browser'); };
        window.speechSynthesis.speak(u);
      });
    }
    if (o.api) {
      return o.api('/research-assistant/speak', { method: 'POST', body: { text: plain } }).then(function (r) {
        if (o.onStart) o.onStart('server');
        player = playPcm(r.data, r.sampleRate);
        return player.done.then(function () { return 'server'; });
      }).catch(function () { return 'none'; });
    }
    return Promise.resolve('none');
  }

  function init() {
    readStore();
    wrapDialogs();
    var go = function () { if (prefs.ui !== 'en') setUi(prefs.ui); else document.documentElement.lang = 'en'; };
    if (document.body) go(); else document.addEventListener('DOMContentLoaded', go);
  }

  window.LZI18N = {
    LANGS: LANGS, get prefs() { return prefs; }, t: t, apply: apply, sync: sync, afterLogin: afterLogin, save: save, setUi: setUi,
    playPcm: playPcm, listen: listen, speak: speak, stopSpeaking: stopSpeaking, settingsHtml: settingsHtml, wireSettings: wireSettings, mountPicker: mountPicker, voiceTag: voiceTag, pickVoice: pickVoice, init: init,
    codeName: function (c) { return (BY[c] || BY.en).name; },
  };
  init();
})();
