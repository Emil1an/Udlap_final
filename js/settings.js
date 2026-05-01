import {
  auth, db,
  onAuthStateChanged, signOut,
  doc, getDoc, updateDoc
} from './firebase_config.js';
import { translations, getLang, t } from './i18n.js';

let currentUser = null;

// Apply all translatable text on the settings page
function applyTranslations() {
  const lang = getLang();
  const T = translations[lang];

  document.querySelector('h1').textContent = T.settings_title;
  document.querySelector('[data-i18n="section_appearance"]').textContent = T.section_appearance;
  document.querySelector('[data-i18n="label_dark_mode"]').textContent = T.label_dark_mode;
  document.querySelector('[data-i18n="label_font_size"]').textContent = T.label_font_size;
  document.querySelector('[data-i18n="section_notifications"]').textContent = T.section_notifications;
  document.querySelector('[data-i18n="label_push_notif"]').textContent = T.label_push_notif;
  document.querySelector('[data-i18n="section_vehicle"]').textContent = T.section_vehicle;
  document.querySelector('[data-i18n="label_type"]').textContent = T.label_type;
  document.querySelector('[data-i18n="label_plates"]').textContent = T.label_plates;
  document.querySelector('[data-i18n="label_disability_s"]').textContent = T.label_disability_s;
  document.querySelector('[data-i18n="section_account"]').textContent = T.section_account;
  document.getElementById('save-btn').textContent = T.btn_save;
  document.getElementById('logout-btn').textContent = T.btn_logout;

  // Font size options
  const fs = document.getElementById('fontSize');
  fs.options[0].text = T.font_small;
  fs.options[1].text = T.font_medium;
  fs.options[2].text = T.font_large;

  // Vehicle options
  const vt = document.getElementById('vehiculoTipo');
  vt.options[0].text = T.vehicle_car;
  vt.options[1].text = T.vehicle_moto;
  vt.options[2].text = T.vehicle_bike;

  // Plates placeholder
  document.getElementById('vehPlacas').placeholder = T.label_plates;

  document.documentElement.lang = lang;
}

onAuthStateChanged(auth, async (user) => {
  const loading = document.getElementById('loading-screen');

  if (!user) {
    window.location.href = 'index.html';
    return;
  }

  currentUser = user;

  // Load profile from Firestore
  const snap = await getDoc(doc(db, 'usuarios', user.uid));
  if (snap.exists()) {
    const data = snap.data();
    document.getElementById('profile-name').textContent = data.nombre || user.email;
    document.getElementById('profile-id').textContent = `ID: ${data.idInstitucional || '—'}`;
    document.getElementById('avatar-letter').textContent = (data.nombre || 'U')[0].toUpperCase();
    const vehSelect = document.getElementById('vehiculoTipo');
    if (vehSelect) vehSelect.value = data.vehiculo || 'coche';
    const placas = document.getElementById('vehPlacas');
    if (placas) placas.value = data.placas || '';
    const discap = document.getElementById('discapToggle');
    if (discap) discap.checked = data.discapacidad || false;
  }

  // Theme
  const theme = localStorage.getItem('theme') || 'light';
  const darkToggle = document.getElementById('darkToggle');
  if (darkToggle) {
    darkToggle.checked = theme === 'dark';
    if (theme === 'dark') document.body.classList.add('dark-mode');
  }

  // Font size
  const font = localStorage.getItem('fontSize') || 'medium';
  const fontSelect = document.getElementById('fontSize');
  if (fontSelect) { fontSelect.value = font; applyFontSize(font); }

  // Language
  const langSelect = document.getElementById('langSelect');
  if (langSelect) langSelect.value = getLang();

  // Apply translations after loading all values
  applyTranslations();

  // --- Event listeners ---
  darkToggle?.addEventListener('change', function () {
    localStorage.setItem('theme', this.checked ? 'dark' : 'light');
    document.body.classList.toggle('dark-mode', this.checked);
  });

  fontSelect?.addEventListener('change', function () {
    localStorage.setItem('fontSize', this.value);
    applyFontSize(this.value);
  });

  langSelect?.addEventListener('change', function () {
    localStorage.setItem('lang', this.value);
    applyTranslations();
  });

  document.getElementById('vehiculoTipo')?.addEventListener('change', function () {
    const row = document.getElementById('placas-row');
    if (row) row.style.display = this.value === 'bicicleta' ? 'none' : 'flex';
  });

  loading.style.opacity = '0';
  setTimeout(() => loading.style.display = 'none', 400);
});

function applyFontSize(size) {
  const sizes = { small: '13px', medium: '15px', large: '19px' };
  document.body.style.fontSize = sizes[size] || '15px';
}

window.guardarCambios = async function () {
  const btn = document.getElementById('save-btn');
  btn.innerHTML = `<span class="btn-spinner"></span>${t('saving')}`;
  btn.disabled = true;

  try {
    await updateDoc(doc(db, 'usuarios', currentUser.uid), {
      vehiculo: document.getElementById('vehiculoTipo').value,
      placas: document.getElementById('vehPlacas').value.trim(),
      discapacidad: document.getElementById('discapToggle').checked,
    });
    btn.textContent = t('save_ok');
    setTimeout(() => { btn.textContent = t('btn_save'); btn.disabled = false; }, 2000);
  } catch (e) {
    console.error(e);
    btn.textContent = t('save_err');
    btn.disabled = false;
  }
};

window.logout = async function () {
  if (!confirm(t('confirm_logout'))) return;
  await signOut(auth);
  window.location.href = 'index.html';
};
