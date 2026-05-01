import {
  auth, db,
  onAuthStateChanged, signOut,
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, addDoc, getDocs, query, where,
  onSnapshot, serverTimestamp, orderBy
} from './firebase_config.js';
import { t } from './i18n.js';

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════
let currentUser = null;
let userProfile = null;
let currentZonaId = null;
let currentCajonId = null;
let countdownTimer = null;
let zonaUnsubscribe = null;   // Firestore real-time listener unsubscriber

// Zone pin positions (% on map image)
const PIN_POSITIONS = {
  E2: { top: '52%', left: '18%' },
  E3: { top: '38%', left: '13%' },
  E5: { top: '15%', left: '52%' },
  E6: { top: '22%', left: '55%' },
};

// Default zone config (used to seed Firestore if zones don't exist)
const DEFAULT_ZONES = {
  E2: { nombre: 'Central (E2)', cajones: 16, discapacitados: ['P15', 'P16'], motos: ['P13', 'P14'], bicicletas: ['P11', 'P12'] },
  E3: { nombre: 'Norte (E3)', cajones: 12, discapacitados: ['P11', 'P12'], motos: ['P9', 'P10'], bicicletas: ['P7', 'P8'] },
  E5: { nombre: 'Sur (E5)', cajones: 10, discapacitados: ['P1', 'P2'], motos: ['P7', 'P8'], bicicletas: ['P5', 'P6'] },
  E6: { nombre: 'Este (E6)', cajones: 8, discapacitados: ['P3', 'P4'], motos: ['P5', 'P6'], bicicletas: ['P3', 'P4'] },
};

// ═══════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════
onAuthStateChanged(auth, async (user) => {
  const loading = document.getElementById('loading-screen');

  if (!user) {
    window.location.href = 'index.html';
    return;
  }

  currentUser = user;

  try {
    // Load or create user profile
    const snap = await getDoc(doc(db, 'usuarios', user.uid));
    if (snap.exists()) {
      userProfile = snap.data();
    } else {
      // Fallback profile
      userProfile = { nombre: user.email, idInstitucional: '', discapacidad: false };
    }

    // Seed zones in Firestore if they don't exist
    await seedZones();

    // Update UI
    const greeting = document.getElementById('user-greeting');
    if (greeting) greeting.textContent = userProfile.nombre || user.email;

    // Setup drag on map
    setupMapDrag();

    // Apply theme
    cargarTema();

    // Apply language translations
    applyHomeTranslations();

    // Check if user has an active reservation
    await checkActiveReservation();

    // Load pin availability overview
    await loadPinStatus();

  } catch (err) {
    console.error('Init error:', err);
  }

  loading.style.opacity = '0';
  setTimeout(() => loading.style.display = 'none', 400);
});

// ═══════════════════════════════════════════════════════════════════════════
// FIRESTORE SEED - ensure zones exist
// ═══════════════════════════════════════════════════════════════════════════
async function seedZones() {
  for (const [id, config] of Object.entries(DEFAULT_ZONES)) {
    const ref = doc(db, 'estacionamientos', id);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        id,
        ...config,
        cajonesList: Array.from({ length: config.cajones }, (_, i) => ({
          id: `P${i + 1}`,
          estado: 'libre',           // libre | ocupado | reservado
          reservadoPor: null,
          reservadoEn: null,
        }))
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAP DRAG
// ═══════════════════════════════════════════════════════════════════════════
function setupMapDrag() {
  const viewport = document.getElementById('map-viewport');
  const mapCont = document.getElementById('map-container');
  if (!viewport || !mapCont) return;

  let isDragging = false, startX, startY, initLeft, initTop;
  let hasMoved = false;

  const start = (e) => {
    isDragging = true; hasMoved = false;
    const ev = e.touches ? e.touches[0] : e;
    startX = ev.clientX; startY = ev.clientY;
    initLeft = mapCont.offsetLeft;
    initTop = mapCont.offsetTop;
    mapCont.style.cursor = 'grabbing';
  };

  const move = (e) => {
    if (!isDragging) return;
    e.preventDefault();
    const ev = e.touches ? e.touches[0] : e;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) hasMoved = true;
    mapCont.style.left = (initLeft + dx) + 'px';
    mapCont.style.top = (initTop + dy) + 'px';
  };

  const stop = () => { isDragging = false; mapCont.style.cursor = 'grab'; };

  viewport.addEventListener('mousedown', start);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', stop);
  viewport.addEventListener('touchstart', start, { passive: false });
  window.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('touchend', stop);
}

// ═══════════════════════════════════════════════════════════════════════════
// LOAD PIN AVAILABILITY (overview dots on map)
// ═══════════════════════════════════════════════════════════════════════════
async function loadPinStatus() {
  for (const id of Object.keys(DEFAULT_ZONES)) {
    const pin = document.getElementById(`pin-${id}`);
    if (!pin) continue;
    try {
      const snap = await getDoc(doc(db, 'estacionamientos', id));
      if (snap.exists()) {
        const data = snap.data();
        const libres = (data.cajonesList || []).filter(c => c.estado === 'libre').length;
        const total = data.cajones || 0;
        pin.className = `pin ${libres === 0 ? 'full' : 'available'}`;
        pin.innerHTML = `<span>${id}</span><span class="pin-label">${libres}/${total}</span>`;
      }
    } catch (e) { /* silently fail */ }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SHOW ZONE (real-time listener)
// ═══════════════════════════════════════════════════════════════════════════
window.showZona = function (idZona) {
  currentZonaId = idZona;

  // Highlight selected pin
  Object.keys(DEFAULT_ZONES).forEach(id => {
    const p = document.getElementById(`pin-${id}`);
    if (p) p.classList.remove('selected');
  });
  const selPin = document.getElementById(`pin-${idZona}`);
  if (selPin) selPin.classList.add('selected');

  // Show UI elements
  document.getElementById('stats-row').style.display = 'grid';
  document.getElementById('grid-dinamico').style.display = 'grid';
  document.getElementById('zona-placeholder').style.display = 'none';
  document.getElementById('legend').style.display = 'flex';
  document.getElementById('realtime-indicator').style.display = 'flex';

  // Unsub previous listener
  if (zonaUnsubscribe) zonaUnsubscribe();

  // Real-time listener on this zone
  zonaUnsubscribe = onSnapshot(doc(db, 'estacionamientos', idZona), (snap) => {
    if (!snap.exists()) return;
    renderZona(snap.data());
  });
};

// ═══════════════════════════════════════════════════════════════════════════
// RENDER ZONE GRID
// ═══════════════════════════════════════════════════════════════════════════
function renderZona(zona) {
  const titulo = document.getElementById('titulo-zona');
  const contenedor = document.getElementById('grid-dinamico');
  if (titulo) titulo.textContent = zona.nombre;

  const cajones = zona.cajonesList || [];
  const discap = zona.discapacitados || [];
  const motos = zona.motos || [];
  const bicicletas = zona.bicicletas || [];

  const libres = cajones.filter(c => c.estado === 'libre').length;
  const ocupados = cajones.filter(c => c.estado !== 'libre').length;

  // Update stats
  document.getElementById('stat-libres').textContent = libres;
  document.getElementById('stat-ocupados').textContent = ocupados;
  document.getElementById('stat-discap').textContent = discap.length;
  document.getElementById('stat-moto').textContent = motos.length;

  // Warn if full
  if (libres === 0) mostrarNotificacion(`⚠️ ${zona.nombre} está lleno. Busca otra zona.`);

  contenedor.innerHTML = '';

  cajones.forEach(cajon => {
    const { id: idCajon, estado, reservadoPor } = cajon;
    const esMio = reservadoPor === currentUser?.uid;
    const esOcupado = estado !== 'libre';
    const div = document.createElement('div');

    let classes = 'spot';
    if (esMio) classes += ' reserved-by-me';
    else if (esOcupado) classes += ' occupied';
    else classes += ' free';

    if (discap.includes(idCajon)) classes += ' disabled-spot';
    if (motos.includes(idCajon)) classes += ' moto-spot';
    if (bicicletas.includes(idCajon)) classes += ' bike-spot';

    div.className = classes;
    div.textContent = idCajon;

    if (!esOcupado || esMio) {
      div.onclick = () => {
        if (esMio) {
          // Show active QR again
          mostrarQRActivo();
        } else {
          // Check: does user have a discapacidad mismatch?
          if (discap.includes(idCajon) && !userProfile?.discapacidad) {
            mostrarNotificacion(t('notif_disabled_only'));
            return;
          }
          abrirModal(currentZonaId, idCajon, zona.nombre, discap, motos, bicicletas);
        }
      };
    }

    contenedor.appendChild(div);
  });

  // Update pin availability badge
  const pin = document.getElementById(`pin-${currentZonaId}`);
  if (pin) {
    pin.className = `pin selected ${libres === 0 ? 'full' : 'available'}`;
    pin.innerHTML = `<span>${currentZonaId}</span><span class="pin-label">${libres}/${cajones.length}</span>`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// OPEN MODAL
// ═══════════════════════════════════════════════════════════════════════════
function abrirModal(idZona, idCajon, nombreZona, discap, motos, bicicletas) {
  // If user already has an active reservation
  if (userProfile?.reservaActiva) {
    mostrarNotificacion(t('notif_already_res'));
    return;
  }

  currentCajonId = idCajon;

  let tipo = t('spot_type_normal');
  if (discap.includes(idCajon)) tipo = t('spot_type_disabled');
  if (motos.includes(idCajon)) tipo = t('spot_type_moto');
  if (bicicletas.includes(idCajon)) tipo = t('spot_type_bike');

  document.getElementById('modal-zona-nombre').textContent = nombreZona;
  document.getElementById('modal-cajon-numero').textContent = idCajon;
  document.getElementById('modal-tipo-cajon').textContent = tipo;
  document.getElementById('vista-confirmacion').style.display = 'block';
  document.getElementById('vista-qr').style.display = 'none';
  document.getElementById('modal-seleccion').style.display = 'flex';
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIRM RESERVATION
// ═══════════════════════════════════════════════════════════════════════════
window.confirmarReserva = async function () {
  const btn = document.getElementById('confirm-btn');
  const zonaNombre = document.getElementById('modal-zona-nombre').textContent;

  btn.innerHTML = '<span class="btn-spinner"></span>Reservando...';
  btn.disabled = true;

  try {
    const zonaRef = doc(db, 'estacionamientos', currentZonaId);
    const zonaSnap = await getDoc(zonaRef);
    const zonaData = zonaSnap.data();
    const cajones = zonaData.cajonesList || [];

    // Double-check availability
    const cajonObj = cajones.find(c => c.id === currentCajonId);
    if (!cajonObj || cajonObj.estado !== 'libre') {
      mostrarNotificacion(t('notif_spot_taken'));
      btn.textContent = t('btn_confirm');
      btn.disabled = false;
      cerrarModal();
      return;
    }

    const ahora = new Date();
    const expiraEn = new Date(ahora.getTime() + 15 * 60 * 1000);

    // Update cajon in Firestore
    const nuevaLista = cajones.map(c =>
      c.id === currentCajonId
        ? { ...c, estado: 'reservado', reservadoPor: currentUser.uid, reservadoEn: ahora.toISOString(), expiraEn: expiraEn.toISOString() }
        : c
    );

    await updateDoc(zonaRef, { cajonesList: nuevaLista });

    // Create reservation document
    const resRef = await addDoc(collection(db, 'reservaciones'), {
      uid: currentUser.uid,
      zonaId: currentZonaId,
      zonaNombre,
      cajonId: currentCajonId,
      estado: 'activa',
      creadoEn: ahora.toISOString(),
      expiraEn: expiraEn.toISOString(),
    });

    // Update user profile
    await updateDoc(doc(db, 'usuarios', currentUser.uid), {
      reservaActiva: { resId: resRef.id, zonaId: currentZonaId, cajonId: currentCajonId, zonaNombre, expiraEn: expiraEn.toISOString() }
    });
    if (userProfile) {
      userProfile.reservaActiva = { resId: resRef.id, zonaId: currentZonaId, cajonId: currentCajonId, zonaNombre, expiraEn: expiraEn.toISOString() };
    }

    // Show QR
    generarQR(zonaNombre, currentCajonId);
    iniciarTemporizador(15 * 60);
    mostrarBadgeActivo(zonaNombre, currentCajonId);

    document.getElementById('vista-confirmacion').style.display = 'none';
    document.getElementById('vista-qr').style.display = 'block';

  } catch (err) {
    console.error('Error al reservar:', err);
    mostrarNotificacion('❌ Error al reservar. Intenta de nuevo.');
  }

  btn.textContent = t('btn_confirm');
  btn.disabled = false;
};

// ═══════════════════════════════════════════════════════════════════════════
// GENERATE QR
// ═══════════════════════════════════════════════════════════════════════════
function generarQR(zonaNombre, cajonId) {
  const qrData = JSON.stringify({
    uid: currentUser.uid,
    zona: zonaNombre,
    cajon: cajonId,
    ts: Date.now()
  });

  new QRious({
    element: document.getElementById('codigo-qr'),
    value: qrData,
    size: 170,
    foreground: '#FF6B00',
    background: '#FFFFFF'
  });

  document.getElementById('qr-zona-info').textContent = zonaNombre;
  document.getElementById('qr-cajon-info').textContent = cajonId;
  document.getElementById('qr-usuario-info').textContent = userProfile?.nombre || currentUser.email;
}

// ═══════════════════════════════════════════════════════════════════════════
// TIMER
// ═══════════════════════════════════════════════════════════════════════════
function iniciarTemporizador(segundos) {
  clearInterval(countdownTimer);
  let tiempo = segundos;

  countdownTimer = setInterval(async () => {
    tiempo--;
    const min = Math.floor(tiempo / 60);
    const segs = tiempo % 60;
    const str = `${min}:${segs < 10 ? '0' : ''}${segs}`;

    const display = document.getElementById('timer');
    if (display) {
      display.textContent = str;
      if (tiempo <= 120) display.classList.add('timer-urgent');
    }

    const badgeTimer = document.getElementById('active-res-timer');
    if (badgeTimer) badgeTimer.textContent = str;

    if (tiempo === 120) mostrarNotificacion(t('notif_2min'));

    if (tiempo <= 0) {
      clearInterval(countdownTimer);
      await liberarLugar(currentZonaId, currentCajonId, true);
      mostrarNotificacion(t('notif_expired'));
      cerrarModal();
      ocultarBadgeActivo();
    }
  }, 1000);
}

function reanudarTemporizador(expiraEnStr) {
  const expiraEn = new Date(expiraEnStr);
  const ahora = new Date();
  const restanMs = expiraEn - ahora;
  const restanSegs = Math.floor(restanMs / 1000);

  if (restanSegs <= 0) {
    // Already expired
    liberarLugar(currentZonaId, currentCajonId, true);
    return;
  }

  iniciarTemporizador(restanSegs);
}

// ═══════════════════════════════════════════════════════════════════════════
// CHECK ACTIVE RESERVATION ON LOAD
// ═══════════════════════════════════════════════════════════════════════════
async function checkActiveReservation() {
  if (!userProfile?.reservaActiva) return;

  const { zonaId, cajonId, zonaNombre, expiraEn, resId } = userProfile.reservaActiva;

  // Check if still valid
  const ahora = new Date();
  const expira = new Date(expiraEn);
  if (ahora >= expira) {
    // Expired while offline
    await liberarLugar(zonaId, cajonId, true);
    return;
  }

  currentZonaId = zonaId;
  currentCajonId = cajonId;

  mostrarBadgeActivo(zonaNombre, cajonId);
  reanudarTemporizador(expiraEn);
}

// ═══════════════════════════════════════════════════════════════════════════
// SHOW QR AGAIN (active reservation)
// ═══════════════════════════════════════════════════════════════════════════
window.mostrarQRActivo = function () {
  if (!userProfile?.reservaActiva) return;
  const { zonaNombre, cajonId, expiraEn } = userProfile.reservaActiva;

  generarQR(zonaNombre, cajonId);

  // Sync timer display
  const restanMs = new Date(expiraEn) - new Date();
  const restanSegs = Math.max(0, Math.floor(restanMs / 1000));
  const min = Math.floor(restanSegs / 60);
  const segs = restanSegs % 60;
  const timer = document.getElementById('timer');
  if (timer) timer.textContent = `${min}:${segs < 10 ? '0' : ''}${segs}`;

  document.getElementById('vista-confirmacion').style.display = 'none';
  document.getElementById('vista-qr').style.display = 'block';
  document.getElementById('modal-seleccion').style.display = 'flex';
};

// ═══════════════════════════════════════════════════════════════════════════
// LIBERAR LUGAR
// ═══════════════════════════════════════════════════════════════════════════
async function liberarLugar(zonaId, cajonId, esAutomatico = false) {
  try {
    // Update zone spot
    const zonaRef = doc(db, 'estacionamientos', zonaId);
    const zonaSnap = await getDoc(zonaRef);
    if (zonaSnap.exists()) {
      const cajones = zonaSnap.data().cajonesList || [];
      const nuevaLista = cajones.map(c =>
        c.id === cajonId
          ? { id: c.id, estado: 'libre', reservadoPor: null, reservadoEn: null, expiraEn: null }
          : c
      );
      await updateDoc(zonaRef, { cajonesList: nuevaLista });
    }

    // Mark reservation as expired/cancelled
    if (userProfile?.reservaActiva?.resId) {
      await updateDoc(doc(db, 'reservaciones', userProfile.reservaActiva.resId), {
        estado: esAutomatico ? 'expirada' : 'cancelada',
        finalizadoEn: new Date().toISOString()
      });
    }

    // Clear user active reservation
    await updateDoc(doc(db, 'usuarios', currentUser.uid), { reservaActiva: null });
    if (userProfile) userProfile.reservaActiva = null;

    clearInterval(countdownTimer);
    ocultarBadgeActivo();

    // Refresh grid if viewing same zone
    if (currentZonaId === zonaId) await loadPinStatus();

  } catch (err) {
    console.error('Error liberando lugar:', err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CANCEL ACTIVE RESERVATION
// ═══════════════════════════════════════════════════════════════════════════
window.cancelarReservacionActual = async function () {
  if (!confirm(t('confirm_cancel_res'))) return;

  await liberarLugar(currentZonaId, currentCajonId, false);
  mostrarNotificacion(t('notif_cancelled'));
  cerrarModal();
};

// ═══════════════════════════════════════════════════════════════════════════
// BADGE ACTIVO
// ═══════════════════════════════════════════════════════════════════════════
function mostrarBadgeActivo(zonaNombre, cajonId) {
  const badge = document.getElementById('active-res-badge');
  const info = document.getElementById('active-res-info');
  if (badge) badge.style.display = 'flex';
  if (info) info.textContent = `${zonaNombre} – ${cajonId}`;
}

function ocultarBadgeActivo() {
  const badge = document.getElementById('active-res-badge');
  if (badge) badge.style.display = 'none';
}

// ═══════════════════════════════════════════════════════════════════════════
// HISTORIAL (from Firestore)
// ═══════════════════════════════════════════════════════════════════════════
window.verReservaciones = async function () {
  const lista = document.getElementById('lista-reservas');
  lista.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:20px;">${t('loading_history')}</p>`;
  document.getElementById('modal-historial').style.display = 'flex';

  try {
    const q = query(
      collection(db, 'reservaciones'),
      where('uid', '==', currentUser.uid),
      orderBy('creadoEn', 'desc')
    );
    const snap = await getDocs(q);
    const reservas = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (reservas.length === 0) {
      lista.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🅿️</div>
          <div class="empty-title">${t('empty_history')}</div>
          <div class="empty-desc">${t('empty_history_desc')}</div>
        </div>`;
      return;
    }

    lista.innerHTML = '';
    reservas.forEach(res => {
      const card = document.createElement('div');
      card.className = 'reserva-card';
      const fecha = res.creadoEn ? new Date(res.creadoEn).toLocaleString('es-MX') : '—';
      const estadoEmoji = res.estado === 'activa' ? '🟢' : res.estado === 'cancelada' ? '🔴' : '⏱';
      card.innerHTML = `
        <div class="reserva-card-inner">
          <div>
            <strong>${estadoEmoji} ${res.zonaNombre}</strong><br>
            <span>Cajón: ${res.cajonId}</span><br>
            <small>${fecha}</small>
          </div>
          <span style="font-size:11px;color:var(--text-muted);font-weight:600;text-transform:uppercase;">${res.estado}</span>
        </div>`;
      lista.appendChild(card);
    });

  } catch (err) {
    console.error(err);
    lista.innerHTML = `<p style="text-align:center;color:var(--red-occupied);">${t('err_history')}</p>`;
  }
};

window.borrarHistorial = async function () {
  if (!confirm(t('confirm_clear'))) return;

  try {
    const q = query(
      collection(db, 'reservaciones'),
      where('uid', '==', currentUser.uid),
      where('estado', 'in', ['cancelada', 'expirada'])
    );
    const snap = await getDocs(q);
    for (const d of snap.docs) await deleteDoc(d.ref);
    await verReservaciones();
    mostrarNotificacion(t('notif_cleared'));
  } catch (e) {
    console.error(e);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// SOPORTE
// ═══════════════════════════════════════════════════════════════════════════
window.abrirSoporte = function () {
  document.getElementById('modal-soporte').style.display = 'flex';
  switchSoporte('reglas');
};

window.switchSoporte = function (seccion) {
  const tabs = ['tabReglas', 'tabReporte', 'tabTutorial'];
  const secciones = ['seccion-reglas', 'seccion-reporte', 'seccion-tutorial'];
  const map = { reglas: 0, reporte: 1, tutorial: 2 };
  const idx = map[seccion] ?? 0;

  tabs.forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', i === idx);
  });
  secciones.forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', i !== idx);
  });
};

window.enviarReporte = async function () {
  const tipo = document.getElementById('tipoReporte').value;
  const desc = document.getElementById('descReporte').value.trim();

  if (!desc) { mostrarNotificacion('⚠️ Escribe una descripción del problema.'); return; }

  try {
    await addDoc(collection(db, 'reportes'), {
      uid: currentUser.uid,
      nombre: userProfile?.nombre || 'Anónimo',
      tipo,
      descripcion: desc,
      zona: currentZonaId || null,
      cajon: currentCajonId || null,
      creadoEn: new Date().toISOString()
    });
    document.getElementById('descReporte').value = '';
    document.getElementById('modal-soporte').style.display = 'none';
    mostrarNotificacion(t('notif_report_ok'));
  } catch (e) {
    mostrarNotificacion(t('notif_report_err'));
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// NOTIFICATION BANNER
// ═══════════════════════════════════════════════════════════════════════════
window.mostrarNotificacion = function (msg) {
  const banner = document.getElementById('notif-banner');
  if (!banner) { console.log(msg); return; }
  banner.textContent = msg;
  banner.classList.add('show');
  setTimeout(() => banner.classList.remove('show'), 4500);
};

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════
window.cerrarModal = function () {
  document.getElementById('modal-seleccion').style.display = 'none';
};

function cargarTema() {
  const theme = localStorage.getItem('theme') || 'light';
  document.body.classList.toggle('dark-mode', theme === 'dark');
}

// ═══════════════════════════════════════════════════════════════════════════
// HOME PAGE TRANSLATIONS
// ═══════════════════════════════════════════════════════════════════════════
function applyHomeTranslations() {
  const el = (id) => document.getElementById(id);
  const qs = (sel) => document.querySelector(sel);

  const mapHint = qs('.map-hint');
  if (mapHint) mapHint.textContent = t('map_hint');

  const sectionMap = qs('.section-label');
  if (sectionMap) sectionMap.textContent = t('section_map');

  const realtimeEl = el('realtime-indicator');
  if (realtimeEl) realtimeEl.textContent = t('realtime');

  const statFree = qs('#stats-row .stat-pill.green .lbl');
  if (statFree) statFree.textContent = t('stat_free');

  const statOcc = qs('#stats-row .stat-pill.red .lbl');
  if (statOcc) statOcc.textContent = t('stat_occupied');

  const placeholder = el('zona-placeholder');
  if (placeholder) placeholder.innerHTML = `<div style="font-size:36px;margin-bottom:10px;">📍</div>${t('placeholder_map')}`;

  // Modal - reserve
  const modalTitle = qs('#vista-confirmacion .modal-title');
  if (modalTitle) modalTitle.textContent = t('modal_reserve_title');
  const modalSub = qs('#vista-confirmacion .modal-subtitle');
  if (modalSub) modalSub.textContent = t('modal_reserve_sub');
  const infoWarning = qs('.info-warning');
  if (infoWarning) infoWarning.textContent = t('info_warning');
  const confirmBtn = el('confirm-btn');
  if (confirmBtn) confirmBtn.textContent = t('btn_confirm');

  // Modal - QR
  const qrTitle = qs('#vista-qr .modal-title');
  if (qrTitle) qrTitle.textContent = t('qr_title');
  const timerLabel = qs('.timer-label');
  if (timerLabel) timerLabel.textContent = t('timer_label');
  const btnCancelRes = qs('#vista-qr .danger-btn');
  if (btnCancelRes) btnCancelRes.textContent = t('btn_cancel_res');
  const btnClose = qs('#vista-qr .secondary-btn');
  if (btnClose) btnClose.textContent = t('btn_close');

  // Support modal
  const suppTitle = el('soporte-title');
  if (suppTitle) suppTitle.textContent = t('support_title');
  const tabRules = el('tabReglas');
  if (tabRules) tabRules.textContent = t('tab_rules');
  const tabReport = el('tabReporte');
  if (tabReport) tabReport.textContent = t('tab_report');
  const tabTutorial = el('tabTutorial');
  if (tabTutorial) tabTutorial.textContent = t('tab_tutorial');

  // Rules list (dynamic)
  const rulesList = el('rules-list');
  if (rulesList) {
    rulesList.innerHTML = t('rules').map(r => `<li>${r}</li>`).join('');
  }

  // Tutorial steps (dynamic)
  const tutorialContainer = el('tutorial-steps');
  if (tutorialContainer) {
    const steps = t('tutorial_steps') || [];
    tutorialContainer.innerHTML = steps.map((step, i) => `
      <div class="tutorial-step" style="animation-delay:${i * 0.05}s">
        <div class="step-number">${i + 1}</div>
        <div class="step-content">
          <div class="step-title">${step.title}</div>
          <div class="step-desc">${step.desc}</div>
          ${step.note ? `<div class="step-note">${step.note}</div>` : ''}
        </div>
      </div>`).join('');
  }

  const reportPlaceholder = el('descReporte');
  if (reportPlaceholder) reportPlaceholder.placeholder = t('report_desc_placeholder');
  const tipoReporte = el('tipoReporte');
  if (tipoReporte) {
    tipoReporte.options[0].text = t('report_type_occupied');
    tipoReporte.options[1].text = t('report_type_error');
    tipoReporte.options[2].text = t('report_type_other');
  }
  const sendReportBtn = el('send-report-btn');
  if (sendReportBtn) sendReportBtn.textContent = t('btn_send_report');
  const soporteCloseBtn = el('soporte-close-btn');
  if (soporteCloseBtn) soporteCloseBtn.textContent = t('btn_close');

  // History modal
  const histTitle = qs('#modal-historial .modal-title');
  if (histTitle) histTitle.textContent = t('history_title');
  const histSub = qs('#modal-historial .modal-subtitle');
  if (histSub) histSub.textContent = t('history_subtitle');
  const clearBtn = qs('#modal-historial .danger-btn');
  if (clearBtn) clearBtn.textContent = t('btn_clear_history');

  // Legend
  const legendItems = document.querySelectorAll('.legend-item');
  if (legendItems.length >= 5) {
    legendItems[0].lastChild.textContent = ` ${t('legend_free')}`;
    legendItems[1].lastChild.textContent = ` ${t('legend_occupied')}`;
    legendItems[2].lastChild.textContent = ` ${t('legend_mine')}`;
  }

  // Active badge
  const activeBadgeText = qs('.active-res-badge .badge-text');
  if (activeBadgeText && activeBadgeText.textContent.includes('Reservación')) {
    activeBadgeText.textContent = t('active_res');
  }

  document.documentElement.lang = localStorage.getItem('lang') || 'es';
}
