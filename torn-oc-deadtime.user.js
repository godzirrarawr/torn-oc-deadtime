// ==UserScript==
// @name         Torn OC Deadtime
// @namespace    https://torn.com/
// @version      2.11.0
// @author       godzirrarawr
// @description  Marks deadtime on your faction's OC cards and puts a red border on the best crime to join (paused crews first). No API key needed.
// @match        https://www.torn.com/factions.php*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      143.198.231.254
// @run-at       document-start
// @homepageURL  https://github.com/godzirrarawr/torn-oc-deadtime
// @updateURL    https://raw.githubusercontent.com/godzirrarawr/torn-oc-deadtime/main/torn-oc-deadtime.user.js
// @downloadURL  https://raw.githubusercontent.com/godzirrarawr/torn-oc-deadtime/main/torn-oc-deadtime.user.js
// ==/UserScript==

// Beta testers: Raging_Raven [2482622], SpitefulHorse [3907936], LightNex [3522637]

/*
 * How it gets data
 * ----------------------------------------------------------------------------
 * No API key, and the script never sends any request of its own. When you open
 * the faction Crimes tab, Torn's page loads its crime list
 * (page.php?sid=organizedCrimesData&step=crimeList). This script reads that
 * response as it passes by, so it only ever sees what you loaded yourself.
 * It never clicks, joins, or acts for you. While the tab is in the background
 * it does nothing: no redraws, no dashboard requests.
 *
 * Faction dashboard (optional)
 * ----------------------------------------------------------------------------
 * The pick also asks the faction's Next Crime dashboard (DASHBOARD_URL) for
 * its recommendation for you: faction min-CPR per role, TornStats CPR, its own
 * ranking. Only a plain GET is sent: no key, no ID, no Torn data. If the
 * dashboard has nothing for you (e.g. you're already in a crime) or can't be
 * reached, the script falls back to its own pick below.
 *
 * Deadtime
 * ----------------------------------------------------------------------------
 * Slots plan one at a time, 24h each. Joining an empty slot means waiting for
 * every filled slot to finish: deadtime = sum of (100 - spent%) x 24h.
 * Verified against Torn's own endTime values.
 *
 * Which crime gets the red border (faction Joining Priority)
 * ----------------------------------------------------------------------------
 * Only slots where your CPR meets the faction minimum (FACTION_MIN_CPR) and
 * the OC level is in your chosen range. Then, in order:
 *   1. Paused crimes (>=1 member, timer expired)
 *   2. Crimes that will become paused within 12h (soonest first)
 *   3. Empty crimes (0/X members)
 *   4. The next closest crime to pause (over 12h)
 * While you're already in a crime there is no pick (you can only be in one);
 * the bar just shows your crime's status.
 *
 * Join guard
 * ----------------------------------------------------------------------------
 * Clicking JOIN on a slot where your CPR is below the faction minimum is
 * stopped, with a notice explaining why. "I know, let me join" unlocks that
 * slot for 15s; you then click Torn's JOIN yourself (the script never clicks
 * it for you).
 *
 * Where each slot's minimum comes from, first match wins:
 *   1. the faction dashboard (min_cpr on every open/running slot it reports;
 *      admins edit these under ROLE WEIGHT > MIN CPR RULES)
 *   2. FACTION_MIN_CPR below, for crimes the dashboard isn't showing
 *   3. DEFAULT_MIN_CPR, shown as a grey "≥75?" tag so a guess is never
 *      mistaken for the faction's rule
 *
 * If the faction dashboard has suggestions for you, the pick is the first
 * option its "Available Now" panel shows you (same band and priority rules);
 * otherwise the local data is used.
 * The dashboard's slot is kept even when another open slot in that crime has
 * a higher CPR (its ranking weighs roles); the bar notes when that happens.
 *
 * TornPDA
 * ----------------------------------------------------------------------------
 * Works in TornPDA's userscript manager too. Set the script's injection time
 * to "Start" so it sees the crime list load; if it was injected late, the bar
 * says so: switch to another Crimes sub-tab and back. The dashboard request
 * uses PDA_httpGet when GM_xmlhttpRequest isn't available.
 */

(function () {
  'use strict';

  // ---- settings (edit here) -----------------------------------------------
  // Faction minimum CPR: DEFAULT_MIN_CPR for most crimes, with per-role
  // exceptions. Role names are matched ignoring '#' and spaces ("Robber 1" = "Robber #1").
  const DEFAULT_MIN_CPR = 75;
  const FACTION_MIN_CPR = {
    'Blast from the Past': { 'Bomber': 75, 'Engineer': 75, 'Hacker': 70, 'Muscle': 75, 'Picklock #1': 70, 'Picklock #2': 70 },
    'Break the Bank': { 'Robber': 64, 'Thief #1': 60, 'Thief #2': 72, 'Muscle #1': 64, 'Muscle #2': 63, 'Muscle #3': 72 },
    'Stacking the Deck': { 'Cat Burglar': 68, 'Driver': 50, 'Imitator': 68, 'Hacker': 68 },
    'Ace in the Hole': { 'Hacker': 63, 'Driver': 53, 'Imitator': 63, 'Muscle #1': 63, 'Muscle #2': 63 },
    'Clinical Precision': { 'Cat Burglar': 70, 'Cleaner': 70, 'Imitator': 75, 'Assassin': 70 },
    'Bidding War': { 'Driver': 75, 'Robber #1': 70, 'Robber #2': 75, 'Robber #3': 75, 'Bomber #1': 70, 'Bomber #2': 75 },
  };
  const PAUSE_SOON_H = 12;   // "will become paused within 12h"
  const roleKey = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[#\s]/g, '');
  const MIN_LOOKUP = new Map(Object.entries(FACTION_MIN_CPR).map(([crime, roles]) =>
    [roleKey(crime), new Map(Object.entries(roles).map(([role, v]) => [roleKey(role), v]))]));
  // dashMins: crime -> role -> min, filled in from the dashboard response
  let dashMins = null;
  function minInfo(crimeName, role) {
    const c = roleKey(crimeName), r = roleKey(role);
    const d = dashMins && dashMins.get(c) && dashMins.get(c).get(r);
    if (d != null) return { min: d, src: 'dashboard' };
    const roles = MIN_LOOKUP.get(c);
    const v = roles && roles.get(r);
    if (v != null) return { min: v, src: 'list' };
    return { min: DEFAULT_MIN_CPR, src: 'guess' };
  }
  const minCprFor = (crimeName, role) => minInfo(crimeName, role).min;
  // false when neither the dashboard nor FACTION_MIN_CPR has it (DEFAULT_MIN_CPR is a guess)
  const minKnown = (crimeName, role) => minInfo(crimeName, role).src !== 'guess';
  const DASHBOARD_URL = 'http://143.198.231.254:5005/api/recommendations'; // '' to disable
  const DASHBOARD_EVERY_MS = 5 * 60 * 1000; // re-ask the dashboard at most this often

  const CYCLE_H = 24;
  const TICK_MS = 60 * 1000; // local re-render so countdowns stay current (no network)

  // OC level range for the pick, set from the bar and saved in this browser
  const MAX_LEVEL = 10;
  function getRange() {
    try {
      const v = JSON.parse(localStorage.getItem('ocdt_levels') || 'null');
      if (v && v.min >= 1 && v.max <= MAX_LEVEL && v.min <= v.max) return v;
    } catch (e) {}
    return { min: 1, max: MAX_LEVEL };
  }
  function setRange(min, max) {
    if (min > max) [min, max] = [max, min];
    try { localStorage.setItem('ocdt_levels', JSON.stringify({ min, max })); } catch (e) {}
  }
  function getHide() { try { return localStorage.getItem('ocdt_hide') === '1'; } catch (e) { return false; } }
  function setHide(v) { try { localStorage.setItem('ocdt_hide', v ? '1' : '0'); } catch (e) {} }
  function levelOk(lvl) {
    const { min, max } = getRange();
    return !lvl || (lvl >= min && lvl <= max);
  }

  // ---- read Torn's own crime list responses -------------------------------
  const crimes = new Map(); // ID -> { crime, seenAt }

  function ingest(text) {
    let json;
    try { json = JSON.parse(text); } catch (e) { return; }
    if (!json || !json.success || !Array.isArray(json.data)) return;
    const seenAt = Date.now() / 1000;
    if (!json.startFrom) {
      // fresh first page of a view: drop stale crimes of the same status
      const statuses = new Set(json.data.map((c) => c.status));
      const ids = new Set(json.data.map((c) => c.ID));
      for (const [id, v] of crimes) if (statuses.has(v.crime.status) && !ids.has(id)) crimes.delete(id);
    }
    for (const c of json.data) if (c && c.ID) crimes.set(c.ID, { crime: c, seenAt });
    scheduleRender(50);
  }

  // Hooks must run in the page itself (the userscript sandbox can't see the
  // page's own fetch). Inject a tiny hook that hands matching responses back
  // as a DOM event; fall back to patching unsafeWindow if injection is blocked.
  function pageHook() {
    const RX = /sid=organizedCrimesData.*step=crimeList|step=crimeList.*sid=organizedCrimesData/i;
    const send = (t) => { try { window.dispatchEvent(new CustomEvent('ocdt-crimes', { detail: String(t) })); } catch (e) {} };
    const of = window.fetch;
    if (of) {
      window.fetch = function (input) {
        const p = of.apply(this, arguments);
        try {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          if (RX.test(url)) p.then((r) => r.clone().text()).then(send).catch(() => {});
        } catch (e) {}
        return p;
      };
    }
    const xo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { if (RX.test(String(url))) this.addEventListener('load', () => { try { send(this.responseText); } catch (e) {} }); } catch (e) {}
      return xo.apply(this, arguments);
    };
    document.documentElement.setAttribute('data-ocdt-hook', '1');
  }
  window.addEventListener('ocdt-crimes', (e) => ingest(e.detail));
  try {
    const sc = document.createElement('script');
    sc.textContent = `(${pageHook})();`;
    (document.head || document.documentElement).appendChild(sc);
    sc.remove();
  } catch (e) {}
  // documentElement can still be null this early (TornPDA "Start", some
  // engines): then nothing was injected and we patch the window directly
  if (!(document.documentElement && document.documentElement.hasAttribute('data-ocdt-hook'))) {
    // inline script blocked or no document yet: patch the page window directly
    try {
      const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      const RX = /sid=organizedCrimesData.*step=crimeList|step=crimeList.*sid=organizedCrimesData/i;
      const of = W.fetch;
      if (of) {
        W.fetch = function (input) {
          const p = of.apply(this, arguments);
          try {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (RX.test(url)) p.then((r) => r.clone().text()).then(ingest).catch(() => {});
          } catch (e) {}
          return p;
        };
      }
      const xo = W.XMLHttpRequest.prototype.open;
      W.XMLHttpRequest.prototype.open = function (method, url) {
        try { if (RX.test(String(url))) this.addEventListener('load', () => { try { ingest(this.responseText); } catch (e) {} }); } catch (e) {}
        return xo.apply(this, arguments);
      };
    } catch (e) { console.warn('[OC Deadtime] could not hook page requests', e); }
  }

  // ---- faction dashboard recommendation -----------------------------------
  const dash = { at: 0, busy: false, rows: null, err: '' };
  // Tampermonkey/Violentmonkey: GM_xmlhttpRequest. TornPDA: PDA_httpGet (goes
  // through the app, so the http dashboard isn't blocked as mixed content).
  const hasGM = typeof GM_xmlhttpRequest === 'function';
  const hasPDA = typeof PDA_httpGet === 'function';
  function httpGet(url) {
    if (hasGM) {
      return new Promise((resolve, reject) => GM_xmlhttpRequest({
        method: 'GET', url, timeout: 30000,
        onload: (r) => resolve(r.responseText),
        onerror: () => reject(new Error('dashboard unreachable')),
        ontimeout: () => reject(new Error('dashboard timed out')),
      }));
    }
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('dashboard timed out')), 30000); });
    return Promise.race([Promise.resolve(PDA_httpGet(url, {})), timeout]).then((r) => {
      clearTimeout(timer);
      if (r == null) throw new Error('dashboard unreachable');
      if (typeof r === 'string') return r;
      if (r.status && (r.status < 200 || r.status >= 300)) throw new Error('dashboard unreachable');
      return r.responseText ?? r.body ?? '';
    }, (e) => {
      clearTimeout(timer);
      throw /timed out/.test(e && e.message) ? e : new Error('dashboard unreachable');
    });
  }
  function refreshDashboard(force) {
    if (!DASHBOARD_URL || dash.busy || !(hasGM || hasPDA)) return;
    if (!force && Date.now() - dash.at < DASHBOARD_EVERY_MS) return;
    dash.busy = true;
    httpGet(DASHBOARD_URL).then((text) => {
      try {
        const d = JSON.parse(text);
        if (d.error) throw new Error(d.error);
        dash.rows = d.available_now_rows || [];
        dash.err = '';
        // every slot the dashboard reports carries the faction's min for it
        const mins = new Map();
        for (const x of [...(d.rows || []), ...(d.filled_slots || []), ...dash.rows]) {
          const v = x && Number(x.min_cpr);
          if (!x || !x.crime_name || !(x.slot_label || x.role) || x.min_cpr == null || !Number.isFinite(v)) continue;
          const c = roleKey(x.crime_name);
          if (!mins.has(c)) mins.set(c, new Map());
          mins.get(c).set(roleKey(x.slot_label || x.role), v);
        }
        if (mins.size) dashMins = mins;
      } catch (e) { dash.err = 'dashboard: bad response'; }
    }, (e) => { dash.err = (e && e.message) || 'dashboard unreachable'; })
      .then(() => { dash.busy = false; dash.at = Date.now(); scheduleRender(50); });
  }

  // Mirrors the dashboard's "Available Now" panel (renderRecAvailableNow in
  // its dashboard.js) so the script's pick is that panel's first option:
  //   - free now (available_in_hours <= 0)
  //   - never the first seat of an empty crew outside your CPR band
  //   - keep only the options closest to your band (an elite with an
  //     elite-level crime open isn't offered the L3 one)
  //   - meets the faction min CPR, then the dashboard's priority_rank, which
  //     already puts paused / soon-to-pause crews first
  // Your OC level range applies on top.
  const BAND_RANK = { developing: 0, core: 1, elite: 2 };
  const banded = (r) => r.cpr_band != null && r.level_band != null && r.cpr_band in BAND_RANK && r.level_band in BAND_RANK;
  const bandDistance = (r) => Math.abs(BAND_RANK[r.cpr_band] - BAND_RANK[r.level_band]);
  function dashboardPick(uid) {
    if (!dash.rows || !uid) return null;
    let mine = dash.rows.filter((r) => String(r.user_id) === String(uid) && r.available_in_hours <= 0 &&
      !(r.tier === 3 && banded(r) && r.cpr_band !== r.level_band));
    const dists = mine.filter((r) => r.meets_min_cpr && banded(r)).map(bandDistance);
    if (dists.length) { const best = Math.min(...dists); mine = mine.filter((r) => !banded(r) || bandDistance(r) <= best); }
    const ok = mine.filter((r) => r.meets_min_cpr && levelOk(Number(r.level)))
      .sort((a, b) => (a.priority_rank ?? 1e9) - (b.priority_rank ?? 1e9));
    return ok[0] || null;
  }

  // ---- who am I -----------------------------------------------------------
  function myId() {
    try {
      const a = document.querySelector('.settings-menu > .link > a');
      const m = a && /XID=(\d+)/i.exec(a.href);
      if (m) return m[1];
    } catch (e) {}
    const c = /(?:^|;\s*)uid=(\d+)/.exec(document.cookie);
    return c ? c[1] : '';
  }

  // ---- analysis -----------------------------------------------------------
  function analyse({ crime, seenAt }, now, me) {
    const slots = crime.playerSlots || [];
    let filled = 0, remainingH = 0, mine = null;
    const open = [];
    for (const s of slots) {
      const p = s.player;
      if (p) {
        filled++;
        if (me && String(p.ID) === String(me)) mine = s;
        const pct = Math.max(0, Math.min(100, Number(p.spentPercent) || 0));
        remainingH += (100 - pct) / 100 * CYCLE_H;
      } else {
        open.push({
          position: s.name || s.key || '?',
          min: minCprFor((crime.scenario || {}).name, s.name),
          minKnown: minKnown((crime.scenario || {}).name, s.name),
          cpr: s.successChance == null ? null : Number(s.successChance),
          needsItem: !!(s.requirement && s.requirement.doesExist === false),
          item: s.requirement ? s.requirement.name : '',
        });
      }
    }
    const sc = crime.scenario || {};
    const untouched = filled === 0;
    const deadline = seenAt + remainingH * 3600;
    const deadH = Math.max(0, (deadline - now) / 3600);
    const paused = !untouched && open.length > 0 && (crime.phaseStatus === 'paused' || deadline <= now);
    for (const o of open) o.ok = o.cpr == null || o.cpr >= o.min;
    const bestSlot = open.slice().sort((a, b) => (b.ok - a.ok) || (a.needsItem - b.needsItem) || ((b.cpr ?? -1) - (a.cpr ?? -1)))[0] || null;
    return {
      crime, id: crime.ID, name: sc.name || `Crime ${crime.ID}`, level: Number(sc.level) || 0,
      deadH, paused, untouched, filled, total: slots.length, open, bestSlot, mine, expiresAt: crime.expiresAt,
    };
  }

  // Faction Joining Priority tier: 1 paused, 2 pauses within 12h, 3 empty crew, 4 later
  function tierOf(r) {
    if (r.paused) return 1;
    if (r.untouched) return 3;
    return r.deadH <= PAUSE_SOON_H ? 2 : 4;
  }
  const TIER_TEXT = { 1: 'paused crew, join first', 2: 'pauses within 12h', 3: 'empty crew', 4: 'next to pause' };

  function choosePick(rows) {
    return rows.filter((r) => r.bestSlot && r.bestSlot.ok && levelOk(r.level))
      .sort((a, b) => (tierOf(a) - tierOf(b)) || (a.bestSlot.needsItem - b.bestSlot.needsItem) ||
        (a.deadH - b.deadH) || (b.level - a.level) || ((b.bestSlot.cpr ?? 0) - (a.bestSlot.cpr ?? 0)))[0] || null;
  }

  function fmtH(h) {
    if (h < 0.05) return '0h';
    if (h < 1) return Math.round(h * 60) + 'm';
    return (Math.round(h * 10) / 10).toString().replace(/\.0$/, '') + 'h';
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---- styles -------------------------------------------------------------
  const css = `
    #ocdt-bar{display:flex !important;flex-wrap:wrap;align-items:center;gap:6px 14px;margin:8px 0 !important;padding:8px 12px !important;
      background:#1b1b1b !important;color:#e6e6e6 !important;border:1px solid #555 !important;border-left:4px solid #e53935 !important;
      border-radius:5px;font:13px/1.45 Arial,sans-serif !important;opacity:1 !important;filter:none !important;
      pointer-events:auto !important;box-shadow:0 1px 4px rgba(0,0,0,.5);position:relative;z-index:1}
    #ocdt-bar *{opacity:1 !important;filter:none !important}
    #ocdt-bar b{color:#fff !important}
    #ocdt-bar .ocdt-go{cursor:pointer;color:#ff6e66 !important;font-weight:bold;text-decoration:underline dotted}
    #ocdt-bar .ocdt-go:hover{color:#ffa39c !important}
    #ocdt-bar .ocdt-muted{color:#a8a8a8 !important}
    #ocdt-bar .ocdt-paused{color:#ffb74d !important;font-weight:bold}
    .ocdt-cbadge{display:inline-block;margin-left:8px;padding:1px 7px;border-radius:3px;font:bold 11px Arial,sans-serif;vertical-align:middle;white-space:nowrap}
    .ocdt-cbadge.ocdt-zero{background:#245c24;color:#cfc}
    .ocdt-cbadge.ocdt-mid{background:#5c4b14;color:#ffe9a8}
    .ocdt-cbadge.ocdt-bad{background:#5c1e1e;color:#fcc}
    .ocdt-cbadge.ocdt-you{background:#26323f;color:#9cf}
    .ocdt-cbadge.ocdt-out{opacity:.35}
    .ocdt-hidden{display:none !important}
    #ocdt-bar input[type=checkbox]{margin:0 2px 0 8px;vertical-align:middle;cursor:pointer;accent-color:#e53935}
    #ocdt-guard{position:absolute;z-index:100000;max-width:290px;padding:9px 11px;background:#2a1212;color:#fde;
      border:1px solid #e53935;border-left:4px solid #e53935;border-radius:5px;font:12px/1.45 Arial,sans-serif;
      box-shadow:0 4px 14px rgba(0,0,0,.6)}
    #ocdt-guard b{color:#fff}
    #ocdt-guard .ocdt-g-row{display:flex;gap:6px;margin-top:7px}
    #ocdt-guard button{flex:1;padding:3px 6px;border-radius:3px;border:1px solid #777;background:#3a3a3a;color:#eee;
      font:11px Arial,sans-serif;cursor:pointer}
    #ocdt-guard button.ocdt-g-ok{border-color:#e53935;background:#5a1a1a}
    .ocdt-min{display:inline-block;flex:0 0 auto;margin-left:4px;margin-right:4px;padding:0 3px;border-radius:2px;font:bold 10px Arial,sans-serif;
      vertical-align:middle;background:#333;color:#ccc;text-transform:none}
    .ocdt-min.ocdt-min-ok{background:#1f4d1f;color:#9f9}
    .ocdt-min.ocdt-min-low{background:#5a1a1a;color:#f99}
    .ocdt-min.ocdt-min-guess{background:#333;color:#999;font-style:italic}
    #ocdt-bar .ocdt-info{display:flex;flex-wrap:wrap;gap:6px 14px;flex:1 1 240px;min-width:0}
    #ocdt-bar .ocdt-ctrl{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-left:auto;white-space:nowrap;color:#a8a8a8 !important}
    #ocdt-bar select{background:#2b2b2b !important;color:#fff !important;border:1px solid #666 !important;border-radius:3px;
      padding:1px 3px;font:12px Arial,sans-serif;cursor:pointer}
    .ocdt-cbadge.ocdt-star{background:#d32f2f;color:#fff}
    .ocdt-card-best{outline:3px solid #e53935 !important;outline-offset:-1px;
      box-shadow:0 0 14px 3px rgba(229,57,53,.65) !important}
    .ocdt-slot-best{outline:2px solid #ff5252 !important;outline-offset:1px;
      box-shadow:0 0 10px 3px rgba(255,82,82,.85) !important;animation:ocdt-pulse 1.2s ease-in-out infinite}
    @keyframes ocdt-pulse{50%{box-shadow:0 0 3px 1px rgba(255,82,82,.35)}}
    #ocdt-hint{position:fixed;left:8px;right:8px;bottom:12px;z-index:100000;display:flex;align-items:center;gap:10px;
      max-width:520px;margin:0 auto;padding:9px 11px;background:#2a1212;color:#fde;border:1px solid #e53935;
      border-left:4px solid #e53935;border-radius:5px;font:13px/1.4 Arial,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.6)}
    #ocdt-hint b{color:#fff}
    #ocdt-hint button{margin-left:auto;padding:4px 9px;border:1px solid #777;border-radius:3px;background:#3a3a3a;color:#eee;cursor:pointer}
    @media (max-width:600px){
      #ocdt-bar{padding:8px !important}
      #ocdt-bar .ocdt-ctrl{margin-left:0;white-space:normal;flex-wrap:wrap}
      #ocdt-bar select{padding:3px 4px;font-size:14px}
      #ocdt-bar input[type=checkbox]{width:18px;height:18px}
      #ocdt-guard{max-width:calc(100vw - 16px);box-sizing:border-box}
      #ocdt-guard button{padding:8px 6px;font-size:13px}
    }
  `;
  function ensureStyle() {
    if (document.getElementById('ocdt-style')) return;
    const s = document.createElement('style'); s.id = 'ocdt-style'; s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  // ---- DOM helpers --------------------------------------------------------
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const ownText = (el) => norm([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' '));
  const textIs = (el, t) => (el.children.length === 0 ? norm(el.textContent) : ownText(el)) === t;
  const OURS = '#ocdt-bar, .ocdt-cbadge, .ocdt-min, #ocdt-guard, #ocdt-hint';

  // A card is found from its title, then confirmed by climbing to the smallest
  // block holding every slot label and member name, so two crews running the
  // same scenario don't get mixed up.
  function findCards(rs) {
    const names = new Set(rs.map((r) => norm(r.name)));
    const titles = [...document.querySelectorAll('div, span, p, h4, h5, a')]
      .filter((el) => !el.closest(OURS) && names.has(el.children.length === 0 ? norm(el.textContent) : ownText(el)));
    const claimed = new Set();
    const out = new Map();
    for (const r of rs) {
      const name = norm(r.name);
      const slots = r.crime.playerSlots || [];
      const must = [...slots.map((s) => norm(s.name)), ...slots.filter((s) => s.player).map((s) => norm(s.player.name))];
      for (const t of titles) {
        if (!textIs(t, name)) continue;
        let up = t.parentElement, card = null;
        for (let i = 0; i < 10 && up; i++, up = up.parentElement) {
          // never climb into a block that holds another crime's title
          if (titles.some((o) => o !== t && up.contains(o))) break;
          const txt = norm(up.textContent);
          if (must.every((m) => txt.includes(m))) { card = up; break; }
        }
        if (card && !claimed.has(card)) { claimed.add(card); out.set(r.id, { card, title: t }); break; }
      }
    }
    return out;
  }

  function findSlotElement(position, root) {
    const label = norm(position);
    const m = [...root.querySelectorAll('div, span, p, li, button')].filter((el) => !el.closest(OURS) && textIs(el, label));
    if (!m.length) return null;
    // prefer the copy sitting next to a Join button (the empty slot)
    return m.find((el) => { let up = el; for (let i = 0; i < 4 && up; i++, up = up.parentElement) if (/join/i.test(up.textContent)) return true; return false; }) || m[0];
  }

  function slotBox(el, card) {
    let up = el;
    for (let i = 0; i < 5 && up && up !== card; i++, up = up.parentElement) {
      if (/join/i.test(up.textContent)) return up;
    }
    return el.parentElement || el;
  }

  // ---- render -------------------------------------------------------------
  let lastPickId = null, lastCards = new Map(), lastAll = [];

  function render() {
    // background tab: do nothing at all (no redraw, no dashboard request)
    // until you come back to it
    if (document.hidden || !/tab=crimes/.test(location.hash) || !document.body) return;
    ensureStyle();
    const now = Date.now() / 1000;
    const me = myId();
    const all = [...crimes.values()].map((v) => analyse(v, now, me));
    const myCrime = all.find((r) => r.mine);
    const rows = all.filter((r) => r.open.length > 0 && !r.mine && (!r.expiresAt || r.expiresAt > now));
    refreshDashboard(false);
    // already in a crime: you can only be in one, so don't suggest another
    const rec = myCrime ? null : dashboardPick(me);
    let pick = null, source = 'local';
    if (myCrime) {
      // no pick
    } else if (rec) {
      const row = rows.find((r) => String(r.id) === String(rec.crime_id));
      const slot = row && row.open.find((s) => norm(s.position) === norm(rec.slot_label));
      pick = row
        ? { ...row, bestSlot: { ...(slot || row.bestSlot), position: rec.slot_label, cpr: rec.predicted_cpr ?? (slot && slot.cpr) } }
        : { id: rec.crime_id, name: rec.crime_name, level: rec.level, paused: !!rec.paused_now, deadH: rec.paused_now ? 0 : (rec.hours_to_pause || 0),
            bestSlot: { position: rec.slot_label, cpr: rec.predicted_cpr, needsItem: false, item: '' } };
      pick.minCpr = rec.min_cpr;
      source = 'dashboard';
    } else {
      pick = choosePick(rows);
    }
    const shown = new Set(rows.map((r) => r.id));
    const cards = findCards(all);
    lastPickId = pick ? pick.id : null;
    lastCards = cards;
    lastAll = all;

    // badges on every card with open slots, plus your own
    for (const r of all) {
      const hit = cards.get(r.id);
      if (!hit) continue;
      let cls, txt, tip;
      if (r.mine) { cls = 'ocdt-you'; txt = 'YOU'; tip = 'You are in this crime'; }
      else if (!shown.has(r.id)) continue;
      else {
        const h = r.deadH;
        cls = h < 0.05 ? 'ocdt-zero' : h > CYCLE_H ? 'ocdt-bad' : 'ocdt-mid';
        txt = `${h < 0.05 ? '✅' : h > CYCLE_H ? '⛔' : '⏱'} ${fmtH(h)} dead`;
        tip = r.paused ? 'Paused: the crew is stuck until someone joins. Your cycle starts the moment you join.'
          : r.untouched ? 'Nobody in yet: starts when you join'
          : h > CYCLE_H ? `You'd wait ~${fmtH(h)}, longer than a full cycle. Usually skip.`
          : `Your cycle would start ~${fmtH(h)} after you join`;
      }
      if (!r.mine && !levelOk(r.level)) { cls += ' ocdt-out'; tip += ` (outside your L${getRange().min}–${getRange().max} range)`; }
      if (pick && r.id === pick.id) { cls += ' ocdt-star'; txt = `★ JOIN ${r.paused ? 'FIRST' : 'THIS'} · ${txt}`; }
      if (!r.mine && r.bestSlot && !r.bestSlot.ok) tip += ` · your CPR is below the faction minimum for every open slot`;
      let b = hit.title.parentElement.querySelector(`.ocdt-cbadge[data-id="${r.id}"]`);
      if (!b) { b = document.createElement('span'); b.dataset.id = r.id; hit.title.after(b); }
      const want = `ocdt-cbadge ${cls}`;
      if (b.className !== want) b.className = want;
      if (b.textContent !== txt) b.textContent = txt;
      if (b.title !== tip) b.title = tip;
    }

    // hide crimes outside the level range if asked (never your own)
    const hide = getHide();
    let hiddenCount = 0;
    for (const r of all) {
      const hit = cards.get(r.id);
      if (!hit) continue;
      const h = hide && !r.mine && !levelOk(r.level);
      if (h) hiddenCount++;
      if (hit.card.classList.contains('ocdt-hidden') !== h) hit.card.classList.toggle('ocdt-hidden', h);
    }

    // faction minimum CPR tag on every slot (green = meets it, red = below)
    for (const r of all) {
      const hit = cards.get(r.id);
      if (!hit) continue;
      for (const s of r.crime.playerSlots || []) {
        const label = findSlotElement(s.name, hit.card);
        if (!label) continue;
        const min = minCprFor(r.name, s.name);
        const known = minKnown(r.name, s.name);
        const cpr = s.successChance == null ? null : Number(s.successChance);
        // grey "≥75?" = not on the faction list, using the default as a guess
        const cls = `ocdt-min ${!known ? 'ocdt-min-guess' : cpr == null ? '' : cpr >= min ? 'ocdt-min-ok' : 'ocdt-min-low'}`;
        const who = s.player ? s.player.name : 'you';
        const src = minInfo(r.name, s.name).src;
        const tip = (src === 'dashboard' ? `Faction minimum CPR ${min}% for ${s.name} (from the dashboard)`
          : src === 'list' ? `Faction minimum CPR ${min}% for ${s.name} (from the script's list; dashboard not showing this crime)`
          : `No faction minimum known for ${s.name} in ${r.name}; using the default ${min}%`) + (cpr == null ? '' : ` · ${who}: ${cpr}%`);
        const label_ = `≥${min}${known ? '' : '?'}`;
        // next to the label, not inside it: Torn truncates long role names
        // ("SABOTEUR #1...") on narrow screens, which would hide the tag
        const old = label.querySelector(':scope > .ocdt-min');
        if (old) old.remove();
        let tag = label.nextElementSibling;
        if (!tag || !tag.classList.contains('ocdt-min')) { tag = document.createElement('span'); label.after(tag); }
        if (tag.className !== cls) tag.className = cls;
        if (tag.textContent !== label_) tag.textContent = label_;
        if (tag.title !== tip) tag.title = tip;
      }
    }

    // red border on the pick and a pulse on its slot
    const pickCard = pick && cards.get(pick.id) ? cards.get(pick.id).card : null;
    document.querySelectorAll('.ocdt-card-best').forEach((x) => x !== pickCard && x.classList.remove('ocdt-card-best'));
    let pickSlot = null;
    if (pickCard) {
      if (!pickCard.classList.contains('ocdt-card-best')) pickCard.classList.add('ocdt-card-best');
      const el = findSlotElement(pick.bestSlot.position, pickCard);
      pickSlot = el && slotBox(el, pickCard);
    }
    document.querySelectorAll('.ocdt-slot-best').forEach((x) => x !== pickSlot && x.classList.remove('ocdt-slot-best'));
    if (pickSlot && !pickSlot.classList.contains('ocdt-slot-best')) pickSlot.classList.add('ocdt-slot-best');

    renderBar(myCrime, pick, rows, cards, source, hiddenCount);
  }

  // Injected after Torn already loaded the list (e.g. TornPDA set to "End"):
  // there is nothing to match cards against, so say how to reload it.
  let hintDismissed = false;
  const startedAt = Date.now();
  function renderHint(show) {
    let h = document.getElementById('ocdt-hint');
    if (!show || hintDismissed) { if (h) h.remove(); return; }
    if (h) return;
    h = document.createElement('div');
    h.id = 'ocdt-hint';
    h.innerHTML = `<span><b>OC Deadtime:</b> no crime data yet. Switch to another Crimes tab and back to load it.</span>
      <button type="button" aria-label="Dismiss">✕</button>`;
    h.querySelector('button').addEventListener('click', () => { hintDismissed = true; h.remove(); });
    document.body.appendChild(h);
  }

  // slim inline bar above the crime list (not a popup)
  function renderBar(myCrime, pick, rows, cards, source, hiddenCount) {
    const firstCard = cards.size ? [...cards.values()][0].card : null;
    renderHint(!crimes.size && Date.now() - startedAt > 3000 &&
      [...document.querySelectorAll('button')].some((b) => /^\s*join\s*$/i.test(b.textContent || '')));
    let bar = document.getElementById('ocdt-bar');
    if (!firstCard && !bar) return;
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'ocdt-bar';
      const opts = (sel) => Array.from({ length: MAX_LEVEL }, (_, i) => `<option value="${i + 1}"${i + 1 === sel ? ' selected' : ''}>${i + 1}</option>`).join('');
      const { min, max } = getRange();
      bar.innerHTML = `<div class="ocdt-info"></div>
        <label class="ocdt-ctrl" title="Only pick OCs in this level range">OC levels
          <select data-r="min">${opts(min)}</select> to <select data-r="max">${opts(max)}</select>
          <input type="checkbox" data-r="hide"${getHide() ? ' checked' : ''}>hide others</label>`;
      bar.addEventListener('change', (e) => {
        if (e.target.dataset.r === 'hide') { setHide(e.target.checked); render(); return; }
        const [a, b] = [...bar.querySelectorAll('select')].map((x) => Number(x.value));
        setRange(a, b);
        const r = getRange();
        bar.querySelector('[data-r=min]').value = r.min;
        bar.querySelector('[data-r=max]').value = r.max;
        render();
      });
    }
    // sit just above Torn's crime list, outside it, so its styles don't dim the bar
    if (firstCard) {
      const list = firstCard.parentElement;
      const host = list.parentElement || list;
      const before = host === list ? firstCard : list;
      if (bar.nextElementSibling !== before) host.insertBefore(bar, before);
    }

    const parts = [];
    if (myCrime) {
      const r = myCrime;
      const state = r.paused ? `<span class="ocdt-paused">paused</span>, waiting on ${r.open.map((s) => esc(s.position)).join(', ')}`
        : r.open.length ? `${r.open.length} slot${r.open.length > 1 ? 's' : ''} open` : 'crew full';
      parts.push(`<span>You're in <b>${esc(r.name)}</b> as ${esc(r.mine.name)} · ${state}</span>`);
    }
    if (pick) {
      const s = pick.bestSlot;
      const t = pick.untouched !== undefined ? tierOf(pick) : (pick.paused ? 1 : pick.deadH <= PAUSE_SOON_H ? 2 : 4);
      const why = t === 1 ? TIER_TEXT[1] : `${TIER_TEXT[t]} · ${fmtH(pick.deadH)} dead`;
      const src = source === 'dashboard' ? `via dashboard${pick.minCpr != null ? `, min ${pick.minCpr}%` : ''}` : 'local pick';
      // dashboard chose a slot other than the highest-CPR one we'd pick: say so
      const localRow = source === 'dashboard' ? rows.find((r) => String(r.id) === String(pick.id)) : null;
      const alt = localRow && localRow.bestSlot;
      const prefers = alt && alt.ok && alt.cpr != null && norm(alt.position) !== norm(s.position) && (s.cpr == null || alt.cpr > s.cpr)
        ? ` · <span class="ocdt-muted" title="The faction dashboard ranks roles, not just CPR. Its pick is kept.">dashboard prefers ${esc(s.position)} over ${esc(alt.position)} (${Math.round(alt.cpr)}%)</span>` : '';
      parts.push(`<span>${myCrime ? 'Best open' : '★ Join'}: <span class="ocdt-go" data-go="1">${esc(pick.name)} → ${esc(s.position)}${s.cpr != null ? ` (${Math.round(s.cpr)}%)` : ''}</span> · ${why}${s.needsItem ? ` · 🔧 needs ${esc(s.item)}` : ''}${prefers} <span class="ocdt-muted">(${src})</span></span>`);
    } else if (!myCrime) {
      parts.push('<span class="ocdt-muted">No open slot fits right now.</span>');
    }
    const pausedCount = rows.filter((r) => r.paused && levelOk(r.level)).length;
    if (pausedCount) parts.push(`<span class="ocdt-muted">${pausedCount} paused crew${pausedCount > 1 ? 's need' : ' needs'} members</span>`);
    if (dash.err) parts.push(`<span class="ocdt-muted" title="Using the local pick instead">⚠ ${esc(dash.err)}</span>`);
    const { min, max } = getRange();
    if (!pick && (min > 1 || max < MAX_LEVEL)) parts.push(`<span class="ocdt-muted">(only L${min}–${max})</span>`);
    if (hiddenCount) parts.push(`<span class="ocdt-muted">${hiddenCount} crime${hiddenCount > 1 ? 's' : ''} outside L${min}–${max} hidden</span>`);
    const info = bar.querySelector('.ocdt-info');
    const html = parts.join('');
    if (info.innerHTML !== html) info.innerHTML = html;
  }

  // ---- click the bar to jump to the pick ----------------------------------
  document.addEventListener('click', (e) => {
    const go = e.target.closest && e.target.closest('#ocdt-bar .ocdt-go');
    if (!go || !lastPickId) return;
    const hit = lastCards.get(lastPickId);
    const target = (hit && (hit.card.querySelector('.ocdt-slot-best') || hit.card));
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    else location.hash = `#/tab=crimes&crimeId=${lastPickId}`;
  });

  // ---- join guard: stop JOIN when your CPR is under the faction minimum ----
  const GUARD_UNLOCK_MS = 15000;
  const unlocked = new Map(); // "crimeId|slot" -> expiry time

  // Which crime + open slot does this JOIN button belong to?
  function slotForButton(btn) {
    for (const r of lastAll) {
      const hit = lastCards.get(r.id);
      if (!hit || !hit.card.contains(btn)) continue;
      for (const o of r.open) {
        const el = findSlotElement(o.position, hit.card);
        if (el && slotBox(el, hit.card).contains(btn)) return { r, o };
      }
      return null;
    }
    return null;
  }

  function closeGuard() { const g = document.getElementById('ocdt-guard'); if (g) g.remove(); }

  function showGuard(btn, r, o, key) {
    closeGuard();
    const g = document.createElement('div');
    g.id = 'ocdt-guard';
    g.innerHTML = `<b>Hold on: your CPR is too low for this slot.</b><br>
      Your CPR <b>${Math.round(o.cpr)}%</b> is below the ${o.minKnown ? 'faction' : 'default'} minimum <b>${o.min}%</b>${o.minKnown ? '' : ' (no faction minimum known)'} for
      <b>${esc(o.position)}</b> in ${esc(r.name)}.
      <div class="ocdt-g-row"><button type="button" class="ocdt-g-cancel">OK, don't join</button>
      <button type="button" class="ocdt-g-ok">I know, let me join</button></div>`;
    document.body.appendChild(g);
    const rect = btn.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.scrollX + rect.right - g.offsetWidth, window.scrollX + document.documentElement.clientWidth - g.offsetWidth - 8));
    g.style.left = `${left}px`;
    g.style.top = `${window.scrollY + rect.bottom + 6}px`;
    g.querySelector('.ocdt-g-cancel').addEventListener('click', closeGuard);
    g.querySelector('.ocdt-g-ok').addEventListener('click', () => {
      unlocked.set(key, Date.now() + GUARD_UNLOCK_MS);
      g.innerHTML = `<b>Unlocked for 15s.</b> Click Torn's JOIN again to join ${esc(o.position)}.`;
      setTimeout(() => { if (document.getElementById('ocdt-guard') === g) g.remove(); }, 5000);
    });
  }

  // Capture phase on document runs before Torn's own click handlers.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('button, a, [role="button"]');
    if (!btn || btn.closest('#ocdt-guard, #ocdt-bar') || !/^\s*join\s*$/i.test(btn.textContent || '')) return;
    if (!/tab=crimes/.test(location.hash)) return;
    const hit = slotForButton(btn);
    if (!hit || hit.o.cpr == null || hit.o.ok) return;            // unknown or meets minimum: let it through
    const key = `${hit.r.id}|${hit.o.position}`;
    if ((unlocked.get(key) || 0) > Date.now()) { unlocked.delete(key); closeGuard(); return; }
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    showGuard(btn, hit.r, hit.o, key);
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeGuard(); });

  // ---- keep it applied as Torn re-renders ---------------------------------
  let renderTimer;
  function scheduleRender(ms) { clearTimeout(renderTimer); renderTimer = setTimeout(render, ms); }

  function init() {
    new MutationObserver((muts) => {
      if (muts.every((m) => m.target.closest && m.target.closest(OURS))) return;
      scheduleRender(300);
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('hashchange', () => scheduleRender(100));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRender(50); });
    setInterval(() => { if (!document.hidden) render(); }, TICK_MS);
    render();
    setTimeout(render, 3500); // late-injection check (see renderHint)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
