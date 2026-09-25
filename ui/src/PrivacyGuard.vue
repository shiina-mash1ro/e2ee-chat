<template>
  <Teleport to="body">
    <div v-if="locked || trying" class="privacy-screen" :class="{ 'privacy-dark': dark }" role="status" aria-label="Loading"
      @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="cancel" @contextmenu.prevent @dragstart.prevent>
      <div class="privacy-spinner" aria-hidden="true"></div>
    </div>
    <div v-if="settings && !locked && !trying" class="privacy-settings" role="dialog" aria-modal="true" :aria-label="t('privacy.title')" @keydown.esc="settings = false">
      <section :class="{ 'privacy-dark': dark }">
        <h2>{{ t('privacy.title') }}</h2>
        <p>{{ t('privacy.instructions') }}</p>
        <div class="privacy-grid"><button v-for="(key, q) in quadrants" :key="q" @click="append(q)">{{ t(key) }}</button></div>
        <p>{{ draft.map(q => t(quadrants[q])).join(' → ') || '—' }}</p>
        <div class="privacy-buttons">
          <button @click="draft = draft.slice(0, -1); tested = false">{{ t('privacy.undo') }}</button>
          <button @click="draft = [...DEFAULT_GESTURE]; tested = false">{{ t('privacy.reset') }}</button>
          <button :disabled="!validGesture(draft)" @click="tryGesture">{{ t('privacy.try') }}</button>
          <button :disabled="!tested" @click="save">{{ t('privacy.save') }}</button>
          <button @click="settings = false">{{ t('privacy.cancel') }}</button>
        </div>
        <p role="status">{{ tested ? t('privacy.passed') : t('privacy.required') }}</p>
      </section>
    </div>
  </Teleport>
</template>
<script setup>
import { ref, watch, onBeforeUnmount, nextTick } from 'vue';
import { createGesture, DEFAULT_GESTURE, validGesture } from './privacy-gesture.js';
import { observeMessageVisibility } from './message-visibility.js';
import { t as translate, onLocaleChange } from './i18n.js';
const props = defineProps({ roomActive: Boolean, dark: Boolean });
const emit = defineEmits(['lock-change', 'unlock']);
const revision = ref(0);
const t = key => { revision.value; return translate(key); };
const stopLocale = onLocaleChange(() => revision.value++);
const media = matchMedia('(hover: hover) and (pointer: fine)');
const desktop = ref(media.matches);
const enabled = ref(false), path = ref([...DEFAULT_GESTURE]);
const storageKey = 'e2ee-chat-enhanced-hide';
try { const saved = JSON.parse(localStorage.getItem(storageKey)); if (saved?.version === 1 && validGesture(saved.path)) { path.value = saved.path; enabled.value = saved.enabled === true; } } catch {}
const locked = ref(false), settings = ref(false), trying = ref(false), tested = ref(false), draft = ref([...path.value]);
const quadrants = ['privacy.tl', 'privacy.tr', 'privacy.bl', 'privacy.br'];
let gesture, trialTimer;
const foreground = () => document.hasFocus() && document.visibilityState === 'visible';
function cancel() { gesture?.cancel(); }
function down(e) { if (!foreground()) return; gesture = createGesture(trying.value ? draft.value : path.value); gesture.down(e, innerWidth, innerHeight); e.preventDefault(); }
function move(e) { gesture?.move(e, innerWidth, innerHeight); }
function up(e) {
  if (!foreground() || !gesture?.up(e, innerWidth, innerHeight)) return;
  if (trying.value) { clearTimeout(trialTimer); trying.value = false; tested.value = true; }
  else { emit('unlock'); locked.value = false; }
}
function append(q) { if (draft.value.length < 8 && draft.value.at(-1) !== q) { draft.value.push(q); tested.value = false; } }
function openSettings() { if (locked.value || !desktop.value) return; draft.value = [...path.value]; tested.value = false; settings.value = true; }
function toggle(value) { if (locked.value) return; if (value) openSettings(); else { enabled.value = false; persist(); } }
function persist() { try { localStorage.setItem(storageKey, JSON.stringify({ version: 1, enabled: enabled.value, path: path.value })); } catch {} }
function save() { if (!tested.value || !validGesture(draft.value)) return; path.value = [...draft.value]; enabled.value = true; persist(); settings.value = false; }
function tryGesture() { cancel(); tested.value = false; trying.value = true; trialTimer = setTimeout(() => { trying.value = false; cancel(); }, 7000); }
const originals = new Map();
function conceal() {
  for (const el of document.body.children) {
    if (el.classList.contains('privacy-screen')) continue;
    if (!originals.has(el)) originals.set(el, { inert: el.inert, aria: el.getAttribute('aria-hidden') });
    el.inert = true; el.setAttribute('aria-hidden', 'true');
  }
}
const observer = new MutationObserver(conceal);
function restore() {
  observer.disconnect(); document.body.classList.remove('privacy-concealed');
  for (const [el, old] of originals) { el.inert = old.inert; if (old.aria === null) el.removeAttribute('aria-hidden'); else el.setAttribute('aria-hidden', old.aria); }
  originals.clear();
}
watch([locked, trying], async ([isLocked, isTrying]) => {
  emit('lock-change', isLocked);
  if (isLocked || isTrying) {
    document.activeElement?.blur?.();
    document.body.classList.add('privacy-concealed'); conceal(); observer.observe(document.body, { childList: true }); await nextTick(); if (locked.value || trying.value) conceal();
  } else restore();
}, { flush: 'sync' });
const stopVisibility = observeMessageVisibility(window, document, (visible, reason) => {
  if (visible) return;
  cancel();
  if (trying.value) { clearTimeout(trialTimer); trying.value = false; }
  if (props.roomActive && desktop.value && enabled.value && ['pointerleave', 'blur', 'visibilitychange', 'pagehide'].includes(reason)) { settings.value = false; locked.value = true; }
});
function resize() { cancel(); }
function mediaChange() { desktop.value = media.matches; cancel(); if (!desktop.value) { locked.value = false; trying.value = false; } }
media.addEventListener('change', mediaChange);
window.addEventListener('resize', resize);
window.visualViewport?.addEventListener('resize', resize);
watch(() => props.roomActive, () => { locked.value = false; cancel(); });
onBeforeUnmount(() => { stopVisibility(); stopLocale(); clearTimeout(trialTimer); restore(); media.removeEventListener('change', mediaChange); window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize); });
defineExpose({ desktop, enabled, openSettings, toggle });
</script>
<style>
body.privacy-concealed > :not(.privacy-screen) { visibility: hidden !important; }
.privacy-screen { position: fixed; inset: 0; z-index: 2147483647; background: #f5f7fa; display: grid; place-items: center; touch-action: none; user-select: none; }
.privacy-dark { background: #181c22 !important; color: #eee; }
.privacy-spinner { width: 34px; height: 34px; border: 3px solid #89939b44; border-top-color: #89939b; border-radius: 50%; animation: privacy-spin 1s linear infinite; }
@keyframes privacy-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .privacy-spinner { animation: none; } }
.privacy-settings { position: fixed; inset: 0; z-index: 99999; display: grid; place-items: center; background: #0007; }
.privacy-settings section { background: white; color: #222; padding: 24px; border-radius: 12px; width: min(540px, 90vw); max-height: 90vh; overflow: auto; }
.privacy-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; direction: ltr; }
.privacy-grid button { min-height: 68px; }
.privacy-settings button { padding: 9px 12px; cursor: pointer; }
.privacy-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
.privacy-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
</style>
