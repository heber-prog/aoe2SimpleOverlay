const { ipcRenderer } = require('electron');

// Notifica al proceso principal del ancho real del overlay contenido
let isDragModeActive = false;
let currentScale = parseFloat(localStorage.getItem('aoe2OverlayScale')) || 1;

function applyScale(scale) {
  const overlayEl = document.getElementById('overlay');
  if (overlayEl) {
    overlayEl.style.transform = `scale(${scale})`;
    overlayEl.style.transformOrigin = 'top left';
  }
}

function reportOverlaySize(force = false) {
  // Cuando se llama con requestAnimationFrame, recibe un timestamp numérico (truthy), ¡lo que se interpretaba erróneamente como force!
  const isForced = force === true;
  
  if (isDragModeActive && !isForced) return;
  const overlayEl = document.getElementById('overlay');
  if (overlayEl) {
    // getBoundingClientRect es exacto con transform: scale (al contrario que con zoom)
    const { width, height } = overlayEl.getBoundingClientRect();
    
    ipcRenderer.send('overlay-size', { 
      width: Math.ceil(width) + 8, 
      height: Math.ceil(height) + 8, 
      force: isForced
    });
  }
}

let lastWinW = window.innerWidth;
let lastWinH = window.innerHeight;

window.addEventListener('resize', () => {
  if (isDragModeActive) {
    // Si la ventana no cambió físicamente de tamaño, es un evento fantasma por cambio de DOM
    if (window.innerWidth === lastWinW && window.innerHeight === lastWinH) {
      return;
    }
    lastWinW = window.innerWidth;
    lastWinH = window.innerHeight;

    const overlayEl = document.getElementById('overlay');
    // Con transform: scale, los offsetWidth no mutan engañosamente
    const baseW = overlayEl.offsetWidth;
    const baseH = overlayEl.offsetHeight;
    
    const scaleX = window.innerWidth / (baseW + 20);
    const scaleY = window.innerHeight / (baseH + 20);
    const newScale = Math.max(0.3, Math.min(scaleX, scaleY));
    
    currentScale = newScale;
    applyScale(currentScale);
  }
});

// Apply scale on startup just in case
document.addEventListener('DOMContentLoaded', () => {
  applyScale(currentScale);
});


const statusEl = document.getElementById('status');
const matchBlock = document.getElementById('match-block');
const p1Container = document.getElementById('p1-container');
const p2Container = document.getElementById('p2-container');

ipcRenderer.on('update-ui', (event, data) => {
  let statusMsg = data.statusText || "Aoe2 Match";

  // Status text logic 
  if (data.isLive) {
    statusEl.innerText = "" + statusMsg;
    statusEl.classList.add('live');
  } else {
    statusEl.innerText = statusMsg || "Match finished";
    statusEl.classList.remove('live');
  }

  // Mostramos SIEMPRE el bloque si hay equipos
  matchBlock.classList.remove('hidden');

  p1Container.innerHTML = '';
  p2Container.innerHTML = '';

  const teamNames = Object.keys(data.teams || {});

  // Helper: construye el HTML del ELO en dos renglones
  function buildEloHtml(p) {
    const line1 = [];
    if (p.elo1v1)    line1.push(`<b>1v1</b> ${p.elo1v1}`);
    if (p.elo1v1Max) line1.push(`<b>MAX</b> ${p.elo1v1Max}`);
    const line2 = p.elo ? `<b>TG</b> ${p.elo}` : '';
    const parts = [];
    if (line1.length) parts.push(line1.join(' · '));
    if (line2)        parts.push(line2);
    return parts.join('<br>');
  }

  // Render Team 1 (Izquierda)
  if (teamNames.length >= 1) {
    const team1 = data.teams[teamNames[0]];
    team1.forEach(p => {
      const eloHtml = buildEloHtml(p);
      p1Container.innerHTML += `
              <div class="player-block" style="flex-direction: row; text-align: left;">
                <div class="min-svg">${p.numberSvg}</div>
                <div class="player-info">
                  <span class="name">${p.nameHtml}</span>
                  <span class="civ">${p.civ}</span>
                  <span class="elo">${eloHtml}</span>
                </div>
              </div>
            `;
    });
  }

  // Render Team 2 (Derecha)
  if (teamNames.length >= 2) {
    const team2 = data.teams[teamNames[1]];
    team2.forEach(p => {
      const eloHtml = buildEloHtml(p);
      p2Container.innerHTML += `
              <div class="player-block" style="flex-direction: row-reverse; text-align: right;">
                <div class="min-svg">${p.numberSvg}</div>
                <div class="player-info" style="align-items: flex-end;">
                  <span class="name" style="flex-direction: row-reverse;">${p.nameHtml}</span>
                  <span class="civ">${p.civ}</span>
                  <span class="elo">${eloHtml}</span>
                </div>
              </div>
            `;
    });
  }


  // Espera al siguiente frame para medir el layout ya renderizado
  requestAnimationFrame(reportOverlaySize);
});

// ── Tecla Ins: activar/desactivar modo arrastre ───────────────────────────────
ipcRenderer.on('toggle-drag-mode', (event, { isDragMode, profileId }) => {
  const overlayEl = document.getElementById('overlay');
  const editPanel = document.getElementById('edit-panel');
  const profileInput = document.getElementById('profile-input');
  
  isDragModeActive = isDragMode;

  if (isDragMode) {
    overlayEl.style.webkitAppRegion = 'drag';
    overlayEl.classList.add('drag-mode');
    editPanel.classList.remove('invisible');
    if (profileId) profileInput.value = profileId;
    profileInput.focus();
  } else {
    overlayEl.style.webkitAppRegion = 'no-drag';
    overlayEl.classList.remove('drag-mode');
    editPanel.classList.add('invisible');
    // Save scale and snap window to new size
    localStorage.setItem('aoe2OverlayScale', currentScale);
    reportOverlaySize();
  }
});

// Botón refresh: re-scrapear con el ID ingresado
document.getElementById('refresh-btn').addEventListener('click', () => {
  const newId = document.getElementById('profile-input').value.trim();
  if (newId) ipcRenderer.send('refresh-profile', newId);
});

// Botón reset size: restaurar a escala 1:1
document.getElementById('reset-size-btn').addEventListener('click', () => {
  currentScale = 1;
  applyScale(currentScale);
  localStorage.setItem('aoe2OverlayScale', currentScale);
  reportOverlaySize(true); // forzar resize incluso estando en drag mode
});



