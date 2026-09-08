/* =========================================================
   EnergyGuard — script.js
   Sistema de Monitoramento Inteligente de Energia (TCC)
   -----------------------------------------------------------
   Este arquivo está organizado em módulos comentados:
   1. Configuração e estado global
   2. Geração de dados simulados (+ ponto de integração futura com API real)
   3. Detecção de anomalias (simplificação didática do Isolation Forest)
   4. Renderização de UI (cards, tabelas, gráficos)
   5. Navegação entre seções (SPA simples)
   6. Loop de atualização em tempo real
   ========================================================= */

/* =========================================================
   1. CONFIGURAÇÃO E ESTADO GLOBAL
   ========================================================= */
const CONFIG = {
  updateIntervalMs: 3000,     // intervalo de "chegada" de novos dados do ESP32
  tariffPerKwh: 0.80,          // tarifa estimada em R$/kWh
  powerAnomalyThreshold: 1800, // W — acima disso é tratado como pico anômalo
  historyLimit: 2000,          // máximo de leituras mantidas em memória
};

// Estado central da aplicação. Em uma versão real, isso viria do backend.
const state = {
  readings: [],          // histórico completo de leituras {timestamp, voltage, current, power, energy, cost, status, anomaly}
  energyAccumulated: 0,  // kWh acumulado no "dia" simulado
  startTime: Date.now(),
  lastUpdate: Date.now(),
  currentPeriod: 'hour',  // período selecionado no gráfico de consumo
  charts: {},
};

/* =========================================================
   2. GERAÇÃO / OBTENÇÃO DE DADOS
   -----------------------------------------------------------
   fetchEnergyData() é o ÚNICO ponto de contato com a "fonte de dados".
   Hoje ela gera valores simulados. No futuro, basta substituir o
   corpo da função por uma chamada real:

     async function fetchEnergyData() {
       const res = await fetch('/api/energy');
       return await res.json();
     }

   O restante do sistema (cards, gráficos, detecção de anomalias)
   não precisa ser alterado, pois todos consomem o mesmo formato
   de objeto retornado aqui.
   ========================================================= */

// Guarda o "estado físico" simulado para gerar variações suaves e realistas
const simState = {
  basePower: 750,     // W — carga base da residência
  trendPhase: 0,
};

function simulateReading() {
  // Variação suave de tensão da rede (120–130V)
  const voltage = 127 + (Math.sin(Date.now() / 60000) * 2) + (Math.random() - 0.5) * 1.2;

  // Potência com padrão diário simulado (curva suave) + ruído natural
  simState.trendPhase += 0.05;
  const dailyCurve = Math.sin(simState.trendPhase) * 220;
  let power = simState.basePower + dailyCurve + (Math.random() - 0.5) * 90;

  // Ocasionalmente injeta um pico anômalo (equipamento de alto consumo ligando, curto, etc.)
  const forcedAnomaly = Math.random() < 0.035;
  if (forcedAnomaly) {
    power += 900 + Math.random() * 900;
  }

  power = Math.max(80, power);
  const current = power / voltage;
  const timestamp = new Date();

  return { voltage, current, power, timestamp, forcedAnomaly };
}

async function fetchEnergyData() {
  // ---- INTEGRAÇÃO FUTURA -------------------------------------------------
  // const response = await fetch(CONFIG.apiEndpoint || '/api/energy');
  // if (!response.ok) throw new Error('Falha ao consultar API de energia');
  // const data = await response.json();
  // return data;
  // -------------------------------------------------------------------------

  // Modo simulado (padrão para o TCC / demonstração)
  const sample = simulateReading();
  const hoursFraction = CONFIG.updateIntervalMs / 3600000;
  const energyIncrement = (sample.power / 1000) * hoursFraction;
  state.energyAccumulated += energyIncrement;

  return {
    voltage: sample.voltage,
    current: sample.current,
    power: sample.power,
    energy: state.energyAccumulated,
    cost: state.energyAccumulated * CONFIG.tariffPerKwh,
    timestamp: sample.timestamp.toISOString(),
    forcedAnomaly: sample.forcedAnomaly,
  };
}

/* =========================================================
   3. DETECÇÃO DE ANOMALIAS
   -----------------------------------------------------------
   Em produção, este papel é do modelo de Isolation Forest treinado
   em Python (offline) e servido via API. Para fins de demonstração
   no front-end, usamos uma heurística estatística equivalente:
   pontuação de anomalia baseada no desvio da potência em relação
   à média móvel recente (quanto maior o desvio, mais "isolado"
   o ponto está — mesma ideia central do Isolation Forest).
   ========================================================= */
function classifyReading(reading, recentWindow) {
  const powers = recentWindow.map(r => r.power);
  const mean = powers.reduce((a, b) => a + b, 0) / (powers.length || 1);
  const variance = powers.reduce((a, b) => a + (b - mean) ** 2, 0) / (powers.length || 1);
  const std = Math.sqrt(variance) || 1;
  const zScore = (reading.power - mean) / std;

  let status = 'normal';
  let anomaly = false;

  if (reading.power >= CONFIG.powerAnomalyThreshold || zScore > 2.6) {
    status = 'anomalia';
    anomaly = true;
  } else if (zScore > 1.6 || reading.power >= CONFIG.powerAnomalyThreshold * 0.8) {
    status = 'atencao';
  }

  return { status, anomaly, zScore };
}

/* =========================================================
   4. RENDERIZAÇÃO DE UI
   ========================================================= */
const fmt = {
  w: v => `${v.toFixed(0)}`,
  v: v => v.toFixed(1).replace('.', ','),
  a: v => v.toFixed(2).replace('.', ','),
  kwh: v => v.toFixed(2).replace('.', ','),
  brl: v => `R$ ${v.toFixed(2).replace('.', ',')}`,
  time: d => new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
  hm: d => new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
};

const CARD_DEFS = [
  { key: 'power', label: 'Potência Atual', icon: 'P', unit: 'W', accent: 'var(--amber)' },
  { key: 'voltage', label: 'Tensão', icon: 'V', unit: 'V', accent: 'var(--purple)' },
  { key: 'current', label: 'Corrente', icon: 'A', unit: 'A', accent: 'var(--blue)' },
  { key: 'energy', label: 'Consumo', icon: 'C', unit: 'kWh', accent: 'var(--green)' },
  { key: 'cost', label: 'Custo Estimado', icon: 'R$', unit: '', accent: '#f472b6' },
  { key: 'status', label: 'Status', icon: '◎', unit: '', accent: 'var(--green)' },
];

function buildCardsSkeleton() {
  const grid = document.getElementById('cardsGrid');
  grid.innerHTML = CARD_DEFS.map(def => `
    <div class="metric-card" style="--accent:${def.accent}" id="card-${def.key}">
      <div class="metric-head">
        <div class="metric-icon">${def.icon}</div>
        <span class="metric-label">${def.label}</span>
      </div>
      <div class="metric-value" id="val-${def.key}">--</div>
      <div id="foot-${def.key}"></div>
    </div>
  `).join('');
}

function renderCards(latest) {
  document.getElementById('val-power').innerHTML = `${fmt.w(latest.power)}<small>W</small>`;
  document.getElementById('val-voltage').innerHTML = `${fmt.v(latest.voltage)}<small>V</small>`;
  document.getElementById('val-current').innerHTML = `${fmt.a(latest.current)}<small>A</small>`;
  document.getElementById('val-energy').innerHTML = `${fmt.kwh(latest.energy)}<small>kWh</small>`;
  document.getElementById('val-cost').innerHTML = `${fmt.brl(latest.cost)}`;

  const footMap = {
    normal: { text: 'Dentro do padrão', cls: '' },
    atencao: { text: 'Consumo elevado', cls: 'warn' },
    anomalia: { text: 'Anomalia detectada', cls: 'danger' },
  };
  const f = footMap[latest.status];
  ['power', 'voltage', 'current'].forEach(k => {
    document.getElementById(`foot-${k}`).innerHTML =
      `<div class="metric-foot ${f.cls}"><span class="dot"></span>${f.text}</div>`;
  });
  document.getElementById('foot-energy').innerHTML =
    `<div class="metric-foot"><span class="dot"></span>Hoje até agora</div>`;
  document.getElementById('foot-cost').innerHTML =
    `<div class="metric-foot"><span class="dot"></span>Tarifa: R$ ${CONFIG.tariffPerKwh.toFixed(2)}/kWh</div>`;

  const statusLabels = { normal: '🟢 Normal', atencao: '🟡 Atenção', anomalia: '🔴 Anomalia' };
  document.getElementById('val-status').innerHTML =
    `<span class="status-badge-card ${latest.status}">${statusLabels[latest.status]}</span>`;
}

function updateTopbar(latest) {
  document.getElementById('lastUpdateText').textContent = '0s';
  const pill = document.getElementById('connectionPill');
  pill.innerHTML = `<span class="status-dot online"></span> Dispositivo conectado`;
  document.getElementById('sidebarLastUpdate').textContent = fmt.hm(latest.timestamp);
}

function showAlertIfNeeded(latest) {
  const banner = document.getElementById('alertBanner');
  if (latest.anomaly) {
    const excessKw = ((latest.power - CONFIG.powerAnomalyThreshold) / 1000);
    const msg = excessKw > 0
      ? `Foi identificado um consumo de ${excessKw.toFixed(1)} kW acima do comportamento esperado.`
      : `Foi identificado um padrão de consumo fora do esperado para este horário.`;
    document.getElementById('alertMessage').textContent = msg;
    banner.classList.remove('hidden');
  }
}

function updateIaPanel() {
  const total = state.readings.length;
  const anomalies = state.readings.filter(r => r.anomaly).length;
  const percent = total ? ((anomalies / total) * 100) : 0;

  document.getElementById('miniTotal').textContent = total;
  document.getElementById('miniAnomalies').textContent = anomalies;
  document.getElementById('miniPercent').textContent = `${percent.toFixed(1)}%`;

  const box = document.getElementById('iaStatusBox');
  const latest = state.readings[state.readings.length - 1];
  if (latest && latest.anomaly) {
    box.innerHTML = `
      <div class="ia-icon bad">!</div>
      <div>
        <strong style="color:var(--red)">Anomalia detectada</strong>
        <p>O modelo identificou um padrão de consumo fora da curva esperada.</p>
      </div>`;
  } else {
    box.innerHTML = `
      <div class="ia-icon ok">✓</div>
      <div>
        <strong>Consumo dentro do padrão</strong>
        <p>Nenhuma anomalia detectada no comportamento atual (Isolation Forest).</p>
      </div>`;
  }

  const navBadge = document.getElementById('navAnomalyCount');
  navBadge.textContent = anomalies;
  navBadge.dataset.zero = anomalies === 0 ? 'true' : 'false';
}

function updateSummary() {
  const total = state.readings.length;
  const avgPower = total ? state.readings.reduce((a, r) => a + r.power, 0) / total : 0;
  const maxPower = total ? Math.max(...state.readings.map(r => r.power)) : 0;
  const uptimeMs = Date.now() - state.startTime;
  const h = Math.floor(uptimeMs / 3600000);
  const m = Math.floor((uptimeMs % 3600000) / 60000);

  document.getElementById('sumEnergy').textContent = `${fmt.kwh(state.energyAccumulated)} kWh`;
  document.getElementById('sumAvgPower').textContent = `${fmt.w(avgPower)} W`;
  document.getElementById('sumMaxPower').textContent = `${fmt.w(maxPower)} W`;
  document.getElementById('sumUptime').textContent = `${h}h ${m}m`;
}

/* ----------------- Tabelas ----------------- */
function badgeHtml(status) {
  const labels = { normal: '🟢 Normal', atencao: '🟡 Atenção', anomalia: '🔴 Anomalia' };
  return `<span class="badge ${status}">${labels[status]}</span>`;
}

function renderHistoryTable(rows) {
  const body = document.getElementById('historyTableBody');
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="6" style="color:var(--text-dim); font-family:var(--font-ui);">Nenhum registro encontrado para os filtros selecionados.</td></tr>`;
    return;
  }
  body.innerHTML = rows.slice(-100).reverse().map(r => `
    <tr>
      <td>${fmt.time(r.timestamp)}</td>
      <td>${fmt.v(r.voltage)} V</td>
      <td>${fmt.a(r.current)} A</td>
      <td>${fmt.w(r.power)} W</td>
      <td>${fmt.kwh(r.energy)} kWh</td>
      <td>${badgeHtml(r.status)}</td>
    </tr>`).join('');
}

function renderAnomalyTable() {
  const anomalies = state.readings.filter(r => r.status !== 'normal');
  const body = document.getElementById('anomalyTableBody');
  if (!anomalies.length) {
    body.innerHTML = `<tr><td colspan="5" style="color:var(--text-dim); font-family:var(--font-ui);">Nenhuma anomalia registrada até o momento.</td></tr>`;
  } else {
    body.innerHTML = anomalies.slice(-50).reverse().map(r => `
      <tr>
        <td>${fmt.time(r.timestamp)}</td>
        <td>${fmt.w(r.power)} W</td>
        <td>${fmt.kwh(r.energy)} kWh</td>
        <td>${badgeHtml(r.status)}</td>
        <td>${r.anomaly ? 'Anomalia (Isolation Forest)' : 'Atenção (limite estatístico)'}</td>
      </tr>`).join('');
  }

  const total = state.readings.length;
  const count = state.readings.filter(r => r.anomaly).length;
  const percent = total ? (count / total) * 100 : 0;
  const last = [...state.readings].reverse().find(r => r.anomaly);

  document.getElementById('anomTotal').textContent = total;
  document.getElementById('anomCount').textContent = count;
  document.getElementById('anomPercent').textContent = `${percent.toFixed(1)}%`;
  document.getElementById('anomLast').textContent = last ? fmt.time(last.timestamp) : '--';
}

/* ----------------- Monitoramento (tempo real) ----------------- */
function renderLiveView(latest) {
  document.getElementById('liveVoltage').textContent = fmt.v(latest.voltage);
  document.getElementById('liveCurrent').textContent = fmt.a(latest.current);
  document.getElementById('livePower').textContent = fmt.w(latest.power);
  document.getElementById('livePF').textContent = (0.9 + Math.random() * 0.08).toFixed(2);
  document.getElementById('monTimestamp').textContent = fmt.hm(latest.timestamp);
}

/* =========================================================
   GRÁFICOS (Chart.js)
   ========================================================= */
const chartDefaults = {
  color: '#8fa89b',
  grid: 'rgba(255,255,255,0.05)',
};

function createLineChart(ctx, { label, color, yLabel }) {
  return new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [{
      label, data: [], borderColor: color, backgroundColor: color + '22',
      fill: true, tension: 0.35, pointRadius: 0, borderWidth: 2,
    }]},
    options: {
      responsive: true,
      animation: { duration: 300 },
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: '#101a15', borderColor: '#1f2e26', borderWidth: 1, titleColor: '#eaf3ec', bodyColor: '#8fa89b' },
      },
      scales: {
        x: { ticks: { color: chartDefaults.color, maxTicksLimit: 8 }, grid: { color: chartDefaults.grid } },
        y: { title: { display: !!yLabel, text: yLabel, color: chartDefaults.color }, ticks: { color: chartDefaults.color }, grid: { color: chartDefaults.grid } },
      },
    },
  });
}

function initCharts() {
  state.charts.consumption = createLineChart(document.getElementById('consumptionChart'), { label: 'Consumo (kWh)', color: '#22c55e', yLabel: 'kWh' });
  state.charts.power = createLineChart(document.getElementById('powerChart'), { label: 'Potência (W)', color: '#f5b942', yLabel: 'W' });
  state.charts.live = new Chart(document.getElementById('liveChart'), {
    type: 'line',
    data: { labels: [], datasets: [
      { label: 'Tensão (V)', data: [], borderColor: '#a78bfa', yAxisID: 'y', tension: .35, pointRadius: 0, borderWidth: 2 },
      { label: 'Corrente (A)', data: [], borderColor: '#38bdf8', yAxisID: 'y1', tension: .35, pointRadius: 0, borderWidth: 2 },
    ]},
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: chartDefaults.color } } },
      scales: {
        x: { ticks: { color: chartDefaults.color, maxTicksLimit: 8 }, grid: { color: chartDefaults.grid } },
        y: { position: 'left', ticks: { color: '#a78bfa' }, grid: { color: chartDefaults.grid } },
        y1: { position: 'right', ticks: { color: '#38bdf8' }, grid: { drawOnChartArea: false } },
      },
    },
  });
  state.charts.report = createLineChart(document.getElementById('reportChart'), { label: 'Consumo diário (kWh)', color: '#22c55e', yLabel: 'kWh' });
}

function filterByPeriod(period) {
  const now = Date.now();
  const ranges = { hour: 3600000, day: 86400000, week: 7 * 86400000, month: 30 * 86400000 };
  const span = ranges[period] || ranges.hour;
  return state.readings.filter(r => now - new Date(r.timestamp).getTime() <= span);
}

function updateConsumptionChart() {
  const data = filterByPeriod(state.currentPeriod);
  const step = Math.max(1, Math.floor(data.length / 60));
  const sampled = data.filter((_, i) => i % step === 0);
  state.charts.consumption.data.labels = sampled.map(r => fmt.hm(r.timestamp));
  state.charts.consumption.data.datasets[0].data = sampled.map(r => r.energy);
  state.charts.consumption.update('none');
}

function updatePowerChart() {
  const recent = state.readings.slice(-40);
  state.charts.power.data.labels = recent.map(r => fmt.hm(r.timestamp));
  state.charts.power.data.datasets[0].data = recent.map(r => r.power);
  state.charts.power.update('none');
}

function updateLiveChart() {
  const recent = state.readings.slice(-30);
  state.charts.live.data.labels = recent.map(r => fmt.hm(r.timestamp));
  state.charts.live.data.datasets[0].data = recent.map(r => r.voltage);
  state.charts.live.data.datasets[1].data = recent.map(r => r.current);
  state.charts.live.update('none');
}

/* =========================================================
   5. NAVEGAÇÃO ENTRE SEÇÕES (SPA simples)
   ========================================================= */
const VIEW_META = {
  dashboard: { title: 'Dashboard', subtitle: 'Visão geral do consumo de energia em tempo real' },
  monitoramento: { title: 'Monitoramento', subtitle: 'Leitura ao vivo dos sensores conectados ao ESP32' },
  historico: { title: 'Histórico', subtitle: 'Consulta e filtragem de leituras armazenadas' },
  anomalias: { title: 'Anomalias', subtitle: 'Ocorrências detectadas pelo modelo de Machine Learning' },
  relatorios: { title: 'Relatórios', subtitle: 'Geração de relatórios de consumo para exportação' },
  configuracoes: { title: 'Configurações', subtitle: 'Parâmetros do dispositivo, do modelo e da API' },
};

function switchView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));

  const meta = VIEW_META[view];
  document.getElementById('viewTitle').textContent = meta.title;
  document.getElementById('viewSubtitle').textContent = meta.subtitle;

  closeSidebarOnMobile();

  if (view === 'historico') renderHistoryTable(state.readings);
  if (view === 'anomalias') renderAnomalyTable();
  if (view === 'relatorios') renderReportView();
}

function closeSidebarOnMobile() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('show');
}

/* =========================================================
   RELATÓRIOS (agregação diária simples a partir do histórico)
   ========================================================= */
function renderReportView() {
  const period = document.getElementById('reportPeriod').value;
  const days = period === 'month' ? 30 : 7;
  const buckets = {};
  const now = Date.now();

  state.readings.forEach(r => {
    const t = new Date(r.timestamp).getTime();
    if (now - t > days * 86400000) return;
    const dayKey = new Date(r.timestamp).toLocaleDateString('pt-BR');
    buckets[dayKey] = (buckets[dayKey] || 0);
  });

  // Como a simulação roda por poucos minutos, usamos o dia atual como referência
  const todayKey = new Date().toLocaleDateString('pt-BR');
  buckets[todayKey] = state.energyAccumulated;

  const labels = Object.keys(buckets);
  const values = Object.values(buckets);

  state.charts.report.data.labels = labels;
  state.charts.report.data.datasets[0].data = values;
  state.charts.report.update();

  const total = state.readings.length;
  const anomalies = state.readings.filter(r => r.anomaly).length;
  document.getElementById('reportSummary').innerHTML = `
    <div class="summary-item"><span class="summary-icon" style="color:var(--green)">⚡</span><div><strong>${fmt.kwh(state.energyAccumulated)} kWh</strong><small>Consumo total no período</small></div></div>
    <div class="summary-item"><span class="summary-icon" style="color:#f472b6">💰</span><div><strong>${fmt.brl(state.energyAccumulated * CONFIG.tariffPerKwh)}</strong><small>Custo estimado</small></div></div>
    <div class="summary-item"><span class="summary-icon" style="color:var(--red)">⚠️</span><div><strong>${anomalies}</strong><small>Anomalias no período</small></div></div>
    <div class="summary-item"><span class="summary-icon" style="color:var(--blue)">📊</span><div><strong>${total}</strong><small>Medições registradas</small></div></div>
  `;
}

function exportCsv() {
  const header = 'timestamp,voltage,current,power,energy,cost,status\n';
  const rows = state.readings.map(r =>
    `${r.timestamp},${r.voltage.toFixed(2)},${r.current.toFixed(2)},${r.power.toFixed(1)},${r.energy.toFixed(3)},${r.cost.toFixed(2)},${r.status}`
  ).join('\n');
  const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'energyguard_historico.csv';
  a.click();
  URL.revokeObjectURL(url);
}

/* =========================================================
   6. LOOP DE ATUALIZAÇÃO EM TEMPO REAL
   ========================================================= */
async function tick() {
  const data = await fetchEnergyData();
  const recentWindow = state.readings.slice(-20);
  const classification = classifyReading(data, recentWindow);

  const reading = {
    ...data,
    status: classification.status,
    anomaly: classification.anomaly || data.forcedAnomaly,
  };
  if (reading.anomaly) reading.status = 'anomalia';

  state.readings.push(reading);
  if (state.readings.length > CONFIG.historyLimit) state.readings.shift();
  state.lastUpdate = Date.now();

  renderCards(reading);
  updateTopbar(reading);
  showAlertIfNeeded(reading);
  updateIaPanel();
  updateSummary();
  updateConsumptionChart();
  updatePowerChart();

  const activeView = document.querySelector('.view.active').id;
  if (activeView === 'view-monitoramento') { renderLiveView(reading); updateLiveChart(); }
  if (activeView === 'view-historico') renderHistoryTable(state.readings);
  if (activeView === 'view-anomalias') renderAnomalyTable();
}

function startUpdateLoop() {
  tick();
  setInterval(tick, CONFIG.updateIntervalMs);

  // Contador de "há Xs" no topo, atualizado a cada segundo
  setInterval(() => {
    const secs = Math.floor((Date.now() - state.lastUpdate) / 1000);
    document.getElementById('lastUpdateText').textContent = `${secs}s`;
  }, 1000);
}

/* =========================================================
   INICIALIZAÇÃO E EVENTOS DE UI
   ========================================================= */
function bindEvents() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  document.getElementById('menuToggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('overlay').classList.add('show');
  });
  document.getElementById('overlay').addEventListener('click', closeSidebarOnMobile);

  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      state.currentPeriod = chip.dataset.period;
      updateConsumptionChart();
    });
  });

  document.getElementById('refreshBtn').addEventListener('click', tick);
  document.getElementById('alertClose').addEventListener('click', () => {
    document.getElementById('alertBanner').classList.add('hidden');
  });
  document.getElementById('alertDetailsBtn').addEventListener('click', () => switchView('anomalias'));

  document.getElementById('applyFilters').addEventListener('click', () => {
    const status = document.getElementById('filterStatus').value;
    const period = document.getElementById('filterPeriod').value;
    let rows = period === 'all' ? state.readings : filterByPeriod(period);
    if (status !== 'all') rows = rows.filter(r => r.status === status);
    renderHistoryTable(rows);
  });

  document.getElementById('generateReport').addEventListener('click', renderReportView);
  document.getElementById('reportPeriod').addEventListener('change', renderReportView);
  document.getElementById('exportCsv').addEventListener('click', exportCsv);

  document.getElementById('cfgThreshold').addEventListener('change', e => {
    CONFIG.powerAnomalyThreshold = Number(e.target.value) || CONFIG.powerAnomalyThreshold;
  });
  document.getElementById('cfgInterval').addEventListener('change', () => {
    // Em uma versão real isso reiniciaria o polling com o novo intervalo.
  });
}

function init() {
  buildCardsSkeleton();
  initCharts();
  bindEvents();
  startUpdateLoop();
}

document.addEventListener('DOMContentLoaded', init);
