/*
 * Cookie consent.
 * Categories actually used by this site:
 *  - necessary: the session cookie (nexcore_session) that keeps you
 *    signed in, and this consent cookie itself. Always on, can't be disabled.
 *  - functional: an optional cookie (nexcore_ui) that remembers your
 *    last-open folder and grid/list view. Only set if you opt in.
 *  - analytics: not wired up to anything in this demo. The toggle exists
 *    so the pattern is here if analytics are ever added, but choosing
 *    "on" does not currently cause any tracking to run.
 */

const CONSENT_COOKIE = 'nexcore_consent';
const UI_PREF_COOKIE = 'nexcore_ui';
const CONSENT_MAX_AGE = 60*60*24*180; // 180 days

function getCookieC(name){
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[2]) : null;
}
function setCookieC(name, value, maxAgeSeconds){
  document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${maxAgeSeconds}; path=/; SameSite=Lax`;
}
function deleteCookieC(name){
  document.cookie = `${name}=; max-age=0; path=/; SameSite=Lax`;
}

function readConsent(){
  const raw = getCookieC(CONSENT_COOKIE);
  if(!raw) return null;
  try{ return JSON.parse(raw); } catch(e){ return null; }
}

function writeConsent(prefs){
  setCookieC(CONSENT_COOKIE, JSON.stringify(prefs), CONSENT_MAX_AGE);
  if(!prefs.functional){
    deleteCookieC(UI_PREF_COOKIE);
  }
  applyConsent(prefs);
}

function applyConsent(prefs){
  document.dispatchEvent(new CustomEvent('consent-changed', { detail: prefs }));
}

function saveUIPref(data){
  const consent = readConsent();
  if(consent && consent.functional){
    setCookieC(UI_PREF_COOKIE, JSON.stringify(data), CONSENT_MAX_AGE);
  }
}
function readUIPref(){
  const raw = getCookieC(UI_PREF_COOKIE);
  if(!raw) return null;
  try{ return JSON.parse(raw); } catch(e){ return null; }
}

function buildConsentBannerHTML(){
  return `
    <div class="consent-banner" id="consentBanner" role="dialog" aria-live="polite" aria-label="Cookie preferences">
      <div class="consent-copy">
        <strong>This site uses a couple of cookies.</strong>
        <p>One keeps you signed in. An optional one remembers your last folder and view.
        <a href="/legal/cookie-policy.html">Read the cookie policy</a>.</p>
      </div>
      <div class="consent-actions">
        <button class="btn btn-text" id="consentManage" type="button">Manage</button>
        <button class="btn btn-ghost" id="consentReject" type="button">Necessary only</button>
        <button class="btn btn-primary" id="consentAccept" type="button">Accept all</button>
      </div>
    </div>
  `;
}

function buildPreferencesModalHTML(current){
  const f = current ? current.functional : false;
  const a = current ? current.analytics : false;
  return `
    <div class="modal-backdrop" id="prefsBackdrop">
      <div class="modal" role="dialog" aria-label="Cookie preferences">
        <h2>Cookie preferences</h2>
        <p class="modal-sub">Choose what you're comfortable with. You can change this anytime from the footer.</p>

        <div class="modal-row">
          <div class="row-copy">
            <strong>Necessary</strong>
            <p>Keeps you signed in and remembers this choice. Can't be turned off.</p>
          </div>
          <label class="switch">
            <input type="checkbox" checked disabled>
            <span class="track"><span class="thumb"></span></span>
          </label>
        </div>

        <div class="modal-row">
          <div class="row-copy">
            <strong>Functional</strong>
            <p>Remembers your last-open folder and grid/list view between visits.</p>
          </div>
          <label class="switch">
            <input type="checkbox" id="prefFunctional" ${f ? 'checked' : ''}>
            <span class="track"><span class="thumb"></span></span>
          </label>
        </div>

        <div class="modal-row">
          <div class="row-copy">
            <strong>Analytics</strong>
            <p>Not currently used on this site — no tracking runs either way.</p>
          </div>
          <label class="switch">
            <input type="checkbox" id="prefAnalytics" ${a ? 'checked' : ''}>
            <span class="track"><span class="thumb"></span></span>
          </label>
        </div>

        <div class="modal-actions">
          <button class="btn btn-ghost" id="prefsCancel" type="button">Cancel</button>
          <button class="btn btn-primary" id="prefsSave" type="button">Save preferences</button>
        </div>
      </div>
    </div>
  `;
}

function openPreferencesModal(){
  const existing = document.getElementById('prefsBackdrop');
  if(existing) existing.remove();
  const current = readConsent() || { necessary:true, functional:false, analytics:false };
  const wrap = document.createElement('div');
  wrap.innerHTML = buildPreferencesModalHTML(current);
  document.body.appendChild(wrap.firstElementChild);

  const backdrop = document.getElementById('prefsBackdrop');
  document.getElementById('prefsCancel').addEventListener('click', () => backdrop.remove());
  backdrop.addEventListener('click', (e) => { if(e.target === backdrop) backdrop.remove(); });
  document.getElementById('prefsSave').addEventListener('click', () => {
    const prefs = {
      necessary: true,
      functional: document.getElementById('prefFunctional').checked,
      analytics: document.getElementById('prefAnalytics').checked
    };
    writeConsent(prefs);
    backdrop.remove();
    hideBanner();
  });
}

function hideBanner(){
  const b = document.getElementById('consentBanner');
  if(b) b.remove();
}

function initConsentBanner(){
  applyConsent(readConsent() || { necessary:true, functional:false, analytics:false });

  if(readConsent()) return; // already decided

  const wrap = document.createElement('div');
  wrap.innerHTML = buildConsentBannerHTML();
  document.body.appendChild(wrap.firstElementChild);

  document.getElementById('consentAccept').addEventListener('click', () => {
    writeConsent({ necessary:true, functional:true, analytics:true });
    hideBanner();
  });
  document.getElementById('consentReject').addEventListener('click', () => {
    writeConsent({ necessary:true, functional:false, analytics:false });
    hideBanner();
  });
  document.getElementById('consentManage').addEventListener('click', openPreferencesModal);
}

document.addEventListener('DOMContentLoaded', initConsentBanner);
