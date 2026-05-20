const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron');
const path = require('path');

// ─── DEBUG: captura errores silenciosos del proceso principal ───────────────
process.on('uncaughtException', (err) => console.error('[CRASH] uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('[CRASH] unhandledRejection:', err));
// ────────────────────────────────────────────────────────────────────────────

let overlayWindow;
let scraperWindow;
let setupWindow;
let isDragMode = false;
let isManuallyPositioned = false;
let currentProfileId = null;
let currentProfileUrl = null;

// ── Cache de ELO 1v1 por nombre de jugador ────────────────────────────────────
// Estados: ausente = nunca intentado | 'loading' | null = sin datos | {elo1v1, elo1v1Max}
const player1v1Cache = {};

async function fetchPlayer1v1Elo(playerName) {
  if (playerName in player1v1Cache) return;
  if (!currentProfileUrl) return;
  player1v1Cache[playerName] = 'loading';
  console.log(`[1v1] 🔍 ${playerName}`);

  const tempWin = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: false }
  });

  // Simula el click en el link del jugador y retorna true si fue encontrado
  async function tryClick() {
    return tempWin.webContents.executeJavaScript(`
      (function() {
        const links = [...document.querySelectorAll('span.limit-name a')];
        const link  = links.find(a => a.textContent.trim() === ${JSON.stringify(playerName)});
        if (!link) return false;
        link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      })()
    `, true /* userGesture */);
  }

  // Espera la dashboard-table con "Ladder" y extrae ELO 1v1
  // Retorna { elo1v1, elo1v1Max } | null (sin datos) | 'not-navigated' (URL no cambió)
  async function waitForElo(timeoutMs) {
    return tempWin.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const start   = Date.now();
        const limit   = ${timeoutMs};
        const prevUrl = location.href;
        const check   = setInterval(() => {
          const elapsed    = Date.now() - start;
          const urlChanged = location.href !== prevUrl;
          const allTables  = [...document.querySelectorAll('table.dashboard-table')];
          const table      = allTables.find(t =>
            [...t.querySelectorAll('span')].some(s => s.textContent.trim() === 'Ladder')
          );
          if (table) {
            clearInterval(check);
            const rows   = [...table.querySelectorAll('tbody tr')];
            const row1v1 = rows.find(r => r.querySelector('td')?.textContent.includes('1v1 Random Map'));
            if (!row1v1) { resolve(null); return; }
            const tds = [...row1v1.querySelectorAll('td')];
            resolve(tds.length >= 4
              ? { elo1v1: tds[2].textContent.trim(), elo1v1Max: tds[3].textContent.trim() }
              : null);
          } else if (elapsed >= limit) {
            clearInterval(check);
            resolve(urlChanged ? null : 'not-navigated');
          }
        }, 5000);
      })
    `);
  }

  try {
    // 1. Cargar la página del perfil principal y esperar render de Svelte
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout load')), 20000);
      tempWin.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
      tempWin.webContents.once('did-fail-load', (_, __, err) => { clearTimeout(timer); reject(new Error(err)); });
      tempWin.loadURL(currentProfileUrl);
    });
    await new Promise(r => setTimeout(r, 5000)); // esperar render Svelte

    // 2. Primer intento (~15s para obtener el ELO)
    let clicked = await tryClick();
    let result = null;

    if (clicked) {
      console.log(`[1v1] 🖱️ Click #1 para: ${playerName}`);
      result = await waitForElo(15000);
    }

    // 3. Reintento si: link no encontrado O página no navegó (max 30s desde inicio)
    if (!clicked || result === 'not-navigated') {
      console.log(`[1v1] 🔄 Reintentando: ${playerName}`);
      await new Promise(r => setTimeout(r, 2000));
      clicked = await tryClick();
      if (clicked) {
        console.log(`[1v1] 🖱️ Click #2 para: ${playerName}`);
        result = await waitForElo(8000); // ~30s totales desde inicio
      } else {
        result = null;
      }
    }

    // Normalizar 'not-navigated' → null
    if (result === 'not-navigated') result = null;

    player1v1Cache[playerName] = result;
    console.log(`[1v1] ${result ? '✅' : '⚠️'} ${playerName}:`, result);

  } catch (e) {
    console.error(`[1v1] 💥 ${playerName}:`, e.message);
    player1v1Cache[playerName] = null;
  } finally {
    // Siempre cerrar la ventana al terminar (éxito, sin datos o error)
    if (!tempWin.isDestroyed()) tempWin.close();
  }
}

function enrichWithCached1v1(teams) {
  for (const team of Object.values(teams || {})) {
    for (const player of team) {
      const cached = player1v1Cache[player.nameText];
      if (cached && cached !== 'loading') {
        player.elo1v1 = cached.elo1v1;
        player.elo1v1Max = cached.elo1v1Max;
      }
    }
  }
}
// ─────────────────────────────────────────────────────────────────────────────

function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 420,
    height: 350,
    frame: false,
    resizable: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  setupWindow.setMenuBarVisibility(false);
  setupWindow.loadFile('setup.html');
}

function startOverlay(config) {
  const { profileId, moveHotkey, toggleHotkey } = config;
  currentProfileId = profileId;
  currentProfileUrl = 'https://aoe2recs.com/profile/' + profileId;
  if (setupWindow) {
    setupWindow.close();
  }

  // 1. Overlay transparente
  overlayWindow = new BrowserWindow({
    width: 600,
    height: 450,
    transparent: true,
    frame: false,
    resizable: false, // Default is false unless in drag mode
    alwaysOnTop: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.loadFile('index.html');
  const display = screen.getPrimaryDisplay();
  const scaleFactor = display.scaleFactor;
  const screenWidth = Math.round(display.bounds.width / scaleFactor);
  overlayWindow.setPosition(screenWidth - 650, 50);

  // Asegura que siempre esté por encima del juego incluso al interactuar
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');

  // ── Teclas Dinámicas ──────────────────────────────────────────
  try {
    globalShortcut.register(moveHotkey, () => {
      if (!overlayWindow) return;
      isDragMode = !isDragMode;
      if (isDragMode) {
        overlayWindow.setIgnoreMouseEvents(false);
        overlayWindow.setResizable(true);
        // Re-afirmar alwaysOnTop
        overlayWindow.setAlwaysOnTop(true, 'screen-saver');
      } else {
        overlayWindow.setIgnoreMouseEvents(true, { forward: true });
        overlayWindow.setResizable(false);
        overlayWindow.setAlwaysOnTop(true, 'screen-saver');
        isManuallyPositioned = true;
      }
      overlayWindow.webContents.send('toggle-drag-mode', { isDragMode, profileId: currentProfileId });
    });
  } catch (err) {
    console.warn(`[HOTKEY] Fallo al registrar Move Hotkey: ${moveHotkey}`);
  }

  try {
    globalShortcut.register(toggleHotkey, () => {
      if (!overlayWindow) return;
      // Bug de Electron en Windows: usar hide() en transparent:true rompe el buffer de renderizado y no vuelve a mostrarse.
      // Opacity resuelve esto a la perfección de forma visual.
      const isHidden = overlayWindow.getOpacity() === 0;

      if (isHidden) {
        overlayWindow.setOpacity(1);
      } else {
        overlayWindow.setOpacity(0);
        // Si el usuario oculta la ventana mientras está en drag-mode, lo cancelamos para que no consuma clics
        if (isDragMode) {
          isDragMode = false;
          overlayWindow.setIgnoreMouseEvents(true, { forward: true });
          overlayWindow.setResizable(false);
          overlayWindow.webContents.send('toggle-drag-mode', { isDragMode, profileId: currentProfileId });
        }
      }
    });
  } catch (err) {
    console.warn(`[HOTKEY] Fallo al registrar Toggle Hotkey: ${toggleHotkey}`);
  }

  overlayWindow.on('closed', () => {
    globalShortcut.unregisterAll();
    isDragMode = false;
    isManuallyPositioned = false;
    app.quit();
  });

  // 2. Ventana oculta para web scraping
  scraperWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'scraper.js'),
    }
  });

  scraperWindow.loadURL('https://aoe2recs.com/profile/' + profileId);
  // scraperWindow.webContents.openDevTools({ mode: 'detach' }); // ← debug
  // overlayWindow.webContents.openDevTools({ mode: 'detach' });  // ← debug
}

app.whenReady().then(() => {
  createSetupWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createSetupWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.on('start-overlay', (event, config) => {
  startOverlay(config);
});

ipcMain.on('setup-minimize', () => {
  if (setupWindow) setupWindow.minimize();
});

ipcMain.on('setup-close', () => {
  app.quit();
});

// Escuchar datos del scraper, enriquecer con ELO 1v1 y enviar al overlay
ipcMain.on('match-data', (event, data) => {
  if (!overlayWindow) return;

  enrichWithCached1v1(data.teams);
  overlayWindow.webContents.send('update-ui', data);

  const pending = [];
  for (const team of Object.values(data.teams || {})) {
    for (const player of team) {
      if (player.nameText && !(player.nameText in player1v1Cache)) {
        pending.push(fetchPlayer1v1Elo(player.nameText));
      }
    }
  }
  if (pending.length > 0) {
    Promise.all(pending).then(() => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        enrichWithCached1v1(data.teams);
        overlayWindow.webContents.send('update-ui', data);
      }
    });
  }
});

// Redimensionar y (si no fue movido manualmente) reposicionar la ventana
ipcMain.on('overlay-size', (event, { width, height, force }) => {
  if (!overlayWindow || (isDragMode && !force)) return; // Ignoramos auto-size si estamos redimensionando a mano, salvo force
  // Para evitar errores de tamaño mínimo, aseguramos un mínimo de ventana
  const safeWidth = Math.max(100, width);
  const safeHeight = Math.max(50, height);
  const currentBounds = overlayWindow.getBounds();

  // Evitar micro-brincos de 1-2 pixels cuando el innerHTML se actualiza cada 3 segundos
  if (force || Math.abs(currentBounds.width - safeWidth) > 2 || Math.abs(currentBounds.height - safeHeight) > 2) {
    overlayWindow.setSize(safeWidth, safeHeight);
    if (!isManuallyPositioned) {
      const display = screen.getPrimaryDisplay();
      const scaleFactor = display.scaleFactor;
      const screenWidth = Math.round(display.bounds.width / scaleFactor);
      overlayWindow.setPosition(screenWidth - safeWidth - 50, 50);
    }
  }
});

// Re-scrapear con un nuevo profile ID ingresado desde el overlay
ipcMain.on('refresh-profile', (event, newProfileId) => {
  if (!newProfileId) return;
  currentProfileId = newProfileId;
  currentProfileUrl = 'https://aoe2recs.com/profile/' + newProfileId;
  Object.keys(player1v1Cache).forEach(k => delete player1v1Cache[k]);
  if (scraperWindow) scraperWindow.loadURL(currentProfileUrl);
});
