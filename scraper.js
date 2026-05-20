const { ipcRenderer } = require('electron');
const log = (...args) => console.log('[scraper.js]', ...args);

setTimeout(() => {
  setInterval(() => {
    try {
      log('--- Ciclo de scraping ---');
      const matchLiveContainer = document.querySelector('.match-live');
      const firstMatch = matchLiveContainer || document.querySelector('.game-matches .match');

      if (!firstMatch) {
        ipcRenderer.send('match-data', { isLive: false, statusText: 'Searching for matches...' });
        return;
      }

      const isLive    = !!matchLiveContainer;
      const rows      = firstMatch.querySelectorAll('tr');
      let teamsMap    = {};
      let currentTeam = 'Player';

      for (const row of rows) {
        const teamNameTd = row.querySelector('td.team-name');
        if (teamNameTd) { currentTeam = teamNameTd.textContent.trim(); continue; }

        const nameTd = row.querySelector('td.name');
        if (nameTd) {
          const minTd   = row.querySelectorAll('td.min')[2];
          const padTd   = row.querySelector('td.pad');
          const rightTd = row.querySelector('td.right');

          // Nombre de texto puro (sin banderas/SVG) — clave de búsqueda en la ventana temporal
          const profileLink = nameTd.querySelector('.limit-name a');
          const nameText    = profileLink?.textContent?.trim() || '';

          if (!teamsMap[currentTeam]) teamsMap[currentTeam] = [];
          teamsMap[currentTeam].push({
            numberSvg: minTd   ? minTd.innerHTML.trim()    : '',
            nameHtml:  nameTd.innerHTML.trim(),
            nameText,                                   // texto plano del jugador
            civ:       padTd   ? padTd.textContent.trim()  : '?',
            elo:       rightTd ? rightTd.textContent.trim(): '',
          });
        }
      }

      const teamKeys = Object.keys(teamsMap);
      if (teamKeys.length === 1 && teamsMap[teamKeys[0]].length === 2) {
        const [p1, p2] = teamsMap[teamKeys[0]];
        teamsMap = { 'Player 1': [p1], 'Player 2': [p2] };
      }

      log(`✅ Enviando datos (${Object.keys(teamsMap).length} equipos)`);
      ipcRenderer.send('match-data', {
        teams: teamsMap,
        isLive,
        statusText: isLive ? 'LIVE' : 'Last Match',
      });

    } catch (e) {
      log('💥 EXCEPCIÓN:', e.message);
      console.error(e);
    }
  }, 3000);
}, 5000);
