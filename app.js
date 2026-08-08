/* =============================================
   8CTANE BASEBALL — PITCH INTELLIGENCE
   app.js
   ============================================= */

/* ==================== BASELINES ==================== */
let MLB_BASELINES = {};

fetch('baselines.json')
  .then(r => r.json())
  .then(data => { MLB_BASELINES = data; })
  .catch(() => { console.warn('baselines.json not found — running without MLB comparisons.'); });

function getBaseline(pt, metric) {
  const b = MLB_BASELINES[pt] || MLB_BASELINES[pt === 'FA' ? 'FF' : null];
  return b ? b[metric] : null;
}
// matchShapeCluster(), findPitchComps(), findArsenalComps() now live in
// mlb-shape-match.js (shared with athletes-v2.js) — loaded via <script> tag.

function deltaTag(val, baseline, higherIsBetter) {
  if (baseline === null || val === null || isNaN(val) || isNaN(baseline)) return '';
  const diff = val - baseline;
  const pct = Math.abs(diff).toFixed(1);
  if (Math.abs(diff) < 0.5) return `<span class="delta neutral">~avg</span>`;
  const better = higherIsBetter ? diff > 0 : diff < 0;
  const arrow = diff > 0 ? '▲' : '▼';
  const cls = better ? 'delta-good' : 'delta-bad';
  return `<span class="${cls}">${arrow}${pct}</span>`;
}

function veloDelta(val, baseline) {
  if (!baseline || !val || isNaN(val)) return '';
  const diff = (parseFloat(val) - baseline).toFixed(1);
  const cls = diff >= 0 ? 'delta-good' : 'delta-bad';
  const arrow = diff >= 0 ? '▲' : '▼';
  return `<span class="${cls}">${arrow}${Math.abs(diff)}</span>`;
}

const PITCH_COLORS = {
  FF:'#378ADD', FA:'#378ADD', SI:'#888780', FC:'#534AB7',
  SL:'#E24B4A', ST:'#D85A30', CU:'#1D9E75', KC:'#1D9E75',
  FS:'#BA7517', CH:'#BA7517', CS:'#1D9E75', OTHER:'#555566'
};
const PITCH_NAMES = {
  FF:'4-Seam', FA:'4-Seam', SI:'Sinker', FC:'Cutter',
  SL:'Slider', ST:'Sweeper', CU:'Curveball', KC:'Knuckle-Curve',
  FS:'Splitter', CH:'Changeup', CS:'Slow Curve', OTHER:'Other'
};
const COUNT_ORDER = ['0-0','0-1','0-2','1-0','1-1','1-2','2-0','2-1','2-2','3-0','3-1','3-2'];

const charts = {};
let singleData = null;
let multiData = { s1: null, s2: null };
let currentMode = 'single';

/* ==================== UTILITIES ==================== */
const pf = v => parseFloat(v) || 0;
const pc = pt => PITCH_COLORS[pt] || '#555566';
const pn = pt => PITCH_NAMES[pt] || pt;

function avg(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }

function valClass(val, goodBelow, warnBelow) {
  if (val === '—' || val === null) return 'v-num';
  const n = parseFloat(val);
  if (goodBelow !== undefined) {
    if (n <= goodBelow) return 'v-good';
    if (n <= warnBelow) return 'v-warn';
    return 'v-bad';
  }
  return 'v-num';
}

function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

/* ==================== PRINT FIX ====================
   Chart.js sizes each canvas off its container at creation time. Tabs other
   than the active one are display:none when their charts are built, so those
   canvases get a 0x0 size and never repaint on their own. The print stylesheet
   forces every .tab-panel visible, but that alone doesn't tell Chart.js to
   redraw. `beforeprint` fires after the browser has already switched to the
   print stylesheet/layout, so this is the right moment to force every chart
   to resize (and therefore redraw) at its new, visible size. */
window.addEventListener('beforeprint', () => {
  Object.values(charts).forEach(chart => { if (chart) chart.resize(); });
});

/* ==================== PITCH INFERENCE ==================== */
function inferPitchType(r) {
  const v = pf(r.release_speed), hb = pf(r.pfx_x), vb = pf(r.pfx_z);
  if (v >= 90) return 'FF';
  if (v >= 84) return (hb > 0.5 && vb > 0.2) ? 'SI' : (hb < -0.2 ? 'FC' : 'FS');
  if (v >= 78) return (hb > 0.5 && vb < 0) ? 'ST' : 'CU';
  return 'CU';
}

/* ==================== PARSE ROWS ==================== */
function parseRows(rows) {
  rows.forEach(r => {
    let pt = (r.pitch_type || '').trim().toUpperCase();
    if (!pt || pt === '') pt = inferPitchType(r);
    if (!PITCH_COLORS[pt]) pt = 'OTHER';
    r._pt = pt;
  });
  return rows;
}

/* ==================== BUILD PITCH MAP ==================== */
function buildPitchMap(rows) {
  const map = {};
  const STRIKE_ZONES = new Set(['1','2','3','4','5','6','7','8','9']);

  rows.forEach(r => {
    const pt = r._pt;
    if (!map[pt]) map[pt] = {
      count:0, velos:[], whiffs:0, cstrikes:0, balls:0, fouls:0, hip:0,
      launch_speeds:[], xwobas:[], xbas:[], xslgs:[], events:[],
      pfx_xs:[], pfx_zs:[], spins:[], locations:[], spray:[],
      pfx_x_raw:[], pfx_z_raw:[], rel_xs:[], rel_zs:[], exts:[], throws:[],
      lhh:{count:0,whiffs:0,cstrikes:0,hip:0,velos:[],xbas:[],xslgs:[],totalStrikes:0,gb:0,fb:0,ld:0,bip:0},
      rhh:{count:0,whiffs:0,cstrikes:0,hip:0,velos:[],xbas:[],xslgs:[],totalStrikes:0,gb:0,fb:0,ld:0,bip:0},
    };
    const s = map[pt];
    s.count++;

    if (r.release_speed)    s.velos.push(pf(r.release_speed));
    if (r.pfx_x)            s.pfx_xs.push(-pf(r.pfx_x)*12);
    if (r.pfx_z)            s.pfx_zs.push(pf(r.pfx_z)*12);
    if (r.release_spin_rate) s.spins.push(pf(r.release_spin_rate));
    // Raw (unscaled, feet) shape/release values for MLB shape-matched comparison
    if (r.pfx_x)              s.pfx_x_raw.push(pf(r.pfx_x));
    if (r.pfx_z)              s.pfx_z_raw.push(pf(r.pfx_z));
    if (r.release_pos_x)      s.rel_xs.push(pf(r.release_pos_x));
    if (r.release_pos_z)      s.rel_zs.push(pf(r.release_pos_z));
    if (r.release_extension)  s.exts.push(pf(r.release_extension));
    if (r.p_throws)           s.throws.push(r.p_throws);

    const stand = (r.stand||'').toUpperCase();
    const side  = stand==='L' ? s.lhh : stand==='R' ? s.rhh : null;
    if (side) { side.count++; if(r.release_speed) side.velos.push(pf(r.release_speed)); }

    const desc = r.description || '';
    const isStrikeResult = desc.includes('swinging_strike')||desc.includes('called_strike')||desc.includes('foul')||desc==='hit_into_play'||desc==='foul_tip';

    if (desc.includes('swinging_strike') || desc === 'missed_bunt') {
      s.whiffs++; if(side) side.whiffs++;
    } else if (desc.includes('called_strike')) {
      s.cstrikes++; if(side) side.cstrikes++;
    } else if (desc === 'ball' || desc === 'blocked_ball') {
      s.balls++;
    } else if (desc.includes('foul')) {
      s.fouls++;
    } else if (desc === 'hit_into_play') {
      s.hip++; if(side) side.hip++;
      if (r.launch_speed) { s.launch_speeds.push(pf(r.launch_speed)); if(side) side.bip++; }
      if (r.estimated_woba_using_speedangle) s.xwobas.push(pf(r.estimated_woba_using_speedangle));
      const xba  = pf(r.estimated_ba_using_speedangle);
      const xslg = pf(r.estimated_slg_using_speedangle);
      if (xba  && side) side.xbas.push(xba);
      if (xslg && side) side.xslgs.push(xslg);
      s.xbas.push(xba); s.xslgs.push(xslg);
      const bbt = (r.bb_type||'').toLowerCase();
      if (side && bbt) { if(bbt==='ground_ball')side.gb++;else if(bbt==='fly_ball')side.fb++;else if(bbt==='line_drive')side.ld++; }
      // Spray chart
      const hcx=pf(r.hc_x), hcy=pf(r.hc_y);
      if (hcx&&hcy) s.spray.push([+hcx.toFixed(1), +hcy.toFixed(1), bbt, pf(r.launch_speed)||null, stand]);
    }
    if (isStrikeResult && side) side.totalStrikes++;
    if (r.events) s.events.push(r.events);

    // Pitch location
    const px=pf(r.plate_x), pz=pf(r.plate_z);
    if (px&&pz) {
      const outcome = desc.includes('swinging_strike')?'W':desc.includes('called_strike')?'CS':desc==='hit_into_play'?'HIP':desc.includes('foul')?'F':'B';
      s.locations.push([+px.toFixed(2), +pz.toFixed(2), outcome, stand]);
    }
  });
  return map;
}

/* ==================== SORTED PITCHES ==================== */
function sortedPitches(pitchMap) {
  return Object.entries(pitchMap).sort((a,b) => b[1].count - a[1].count);
}

/* ==================== MODE TOGGLE ==================== */
function toggleMode() {
  currentMode = currentMode === 'single' ? 'multi' : 'single';
  const isSingle = currentMode === 'single';
  document.getElementById('upload-single').style.display = isSingle ? '' : 'none';
  document.getElementById('upload-multi').style.display  = isSingle ? 'none' : '';
  document.getElementById('report-single').style.display = 'none';
  document.getElementById('report-multi').style.display  = 'none';
  document.getElementById('mode-badge').textContent = isSingle ? 'SINGLE START' : 'MULTI-START';
  document.getElementById('toggle-mode-btn').textContent = isSingle ? 'Switch to Multi-Start' : 'Switch to Single';
}

/* ==================== SINGLE FILE HANDLING ==================== */
const dropSingle = document.getElementById('drop-single');
const fileSingle = document.getElementById('file-single');

dropSingle.addEventListener('dragover', e => { e.preventDefault(); dropSingle.classList.add('dragging'); });
dropSingle.addEventListener('dragleave', () => dropSingle.classList.remove('dragging'));
dropSingle.addEventListener('drop', e => {
  e.preventDefault(); dropSingle.classList.remove('dragging');
  if (e.dataTransfer.files[0]) processFileSingle(e.dataTransfer.files[0]);
});
dropSingle.addEventListener('click', e => { if (!e.target.classList.contains('btn-primary')) fileSingle.click(); });
fileSingle.addEventListener('change', e => { if (e.target.files[0]) processFileSingle(e.target.files[0]); });

function processFileSingle(file) {
  Papa.parse(file, {
    header: true, skipEmptyLines: true,
    complete: r => { buildSingleReport(r.data); },
    error: err => alert('Could not parse CSV: ' + err.message)
  });
}

function resetSingle() {
  Object.keys(charts).forEach(destroyChart);
  document.getElementById('report-single').style.display = 'none';
  document.getElementById('upload-single').style.display = '';
  fileSingle.value = '';
  singleData = null;
}

/* ==================== MULTI FILE HANDLING ==================== */
['1','2'].forEach(slot => {
  const fileEl = document.getElementById(`file-start${slot}`);
  const dropEl = document.getElementById(`drop-start${slot}`);
  dropEl.addEventListener('dragover', e => { e.preventDefault(); dropEl.classList.add('dragging'); });
  dropEl.addEventListener('dragleave', () => dropEl.classList.remove('dragging'));
  dropEl.addEventListener('drop', e => {
    e.preventDefault(); dropEl.classList.remove('dragging');
    if (e.dataTransfer.files[0]) processFileMulti(e.dataTransfer.files[0], slot);
  });
  dropEl.addEventListener('click', e => { if (!e.target.classList.contains('btn-primary')) fileEl.click(); });
  fileEl.addEventListener('change', e => { if (e.target.files[0]) processFileMulti(e.target.files[0], slot); });
});

function processFileMulti(file, slot) {
  Papa.parse(file, {
    header: true, skipEmptyLines: true,
    complete: r => {
      const rows = parseRows(r.data);
      multiData[`s${slot}`] = { rows, file: file.name };
      document.getElementById(`status-${slot}`).textContent = `✓ ${file.name}`;
      document.getElementById(`drop-start${slot}`).style.borderColor = 'var(--cyan)';
      const btn = document.getElementById('btn-compare');
      if (multiData.s1 && multiData.s2) { btn.disabled = false; btn.style.opacity = '1'; }
    }
  });
}

function resetMulti() {
  document.getElementById('report-multi').style.display = 'none';
  document.getElementById('upload-multi').style.display = '';
  multiData = { s1: null, s2: null };
  ['1','2'].forEach(s => {
    document.getElementById(`status-${s}`).textContent = 'No file loaded';
    document.getElementById(`drop-start${s}`).style.borderColor = '';
    document.getElementById(`file-start${s}`).value = '';
  });
  const btn = document.getElementById('btn-compare');
  btn.disabled = true; btn.style.opacity = '.4';
}

/* ==================== TAB SWITCHING ==================== */
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab;
    document.querySelectorAll('#main-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${name}`));
  });
});

/* ==================== BUILD SINGLE REPORT ==================== */
let analyzerLocColor = 'pitch';
let analyzerLocHand  = 'all';

function setAnalyzerLocColor(color, btn) {
  analyzerLocColor = color;
  document.querySelectorAll('.loc-color-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderLocations();
}
function setAnalyzerLocHand(hand, btn) {
  analyzerLocHand = hand;
  document.querySelectorAll('.loc-hand-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderLocations();
}

function buildSingleReport(rawRows) {
  const rows = parseRows(rawRows);
  if (!rows.length) return;

  const pitchMap = buildPitchMap(rows);
  const total = rows.length;
  const pitcherName = rows[0].player_name || 'Unknown Pitcher';
  const gameDate = rows[0].game_date || '';
  const hand = rows[0].p_throws || 'R';
  const homeTeam = rows[0].home_team || '';
  const awayTeam = rows[0].away_team || '';
  const opp = homeTeam && awayTeam ? `${awayTeam} @ ${homeTeam}` : (homeTeam || awayTeam);

  const rhhRows = rows.filter(r => r.stand === 'R');
  const lhhRows = rows.filter(r => r.stand === 'L');
  const rhhMap = buildPitchMap(rhhRows);
  const lhhMap = buildPitchMap(lhhRows);

  const countMap = {};
  COUNT_ORDER.forEach(c => countMap[c] = {});
  rows.forEach(r => {
    const cnt = `${r.balls}-${r.strikes}`;
    if (!countMap[cnt]) countMap[cnt] = {};
    countMap[cnt][r._pt] = (countMap[cnt][r._pt]||0) + 1;
  });

  const hardContact = rows.filter(r => {
    const ev = pf(r.launch_speed);
    return (ev >= 90 && r.events) || ['triple','double','home_run'].includes(r.events);
  }).sort((a,b) => pf(b.launch_speed) - pf(a.launch_speed));

  const totalWhiffs = Object.values(pitchMap).reduce((a,s)=>a+s.whiffs, 0);
  const totalCS = Object.values(pitchMap).reduce((a,s)=>a+s.cstrikes, 0);
  const walks = rows.filter(r => r.events === 'walk' || r.events === 'hit_by_pitch').length;
  const ks    = rows.filter(r => r.events === 'strikeout').length;
  const hrs   = rows.filter(r => r.events === 'home_run').length;
  const hits  = rows.filter(r => ['single','double','triple','home_run'].includes(r.events||'')).length;
  const ffMap = pitchMap['FF'] || pitchMap['FA'];
  const avgVelo  = ffMap?.velos.length ? avg(ffMap.velos).toFixed(1) : '—';
  const peakVelo = ffMap?.velos.length ? Math.max(...ffMap.velos).toFixed(1) : '—';

  // Innings pitched from outs recorded
  const outEvents = new Set(['field_out','strikeout','force_out','grounded_into_double_play','sac_fly','sac_bunt','fielders_choice_out','double_play','triple_play']);
  const outsRecorded = rows.reduce((a,r) => {
    const ev = r.events||'';
    if (ev==='grounded_into_double_play'||ev==='double_play') return a+2;
    if (ev==='triple_play') return a+3;
    if (outEvents.has(ev)) return a+1;
    return a;
  }, 0);
  const ip = outsRecorded/3;
  const fip  = ip > 0 ? (((13*hrs + 3*walks - 2*ks) / ip) + 3.10).toFixed(2) : '—';
  const whip = ip > 0 ? ((walks + hits) / ip).toFixed(2) : '—';

  // PA-level: Race to 2K, Putaway%
  const paMap = {};
  rows.forEach(r => { const pa=r.at_bat_number||''; if(!pa)return; if(!paMap[pa])paMap[pa]=[]; paMap[pa].push(r); });
  let race2k_total=0,race2k_hit=0,putaway_total=0,putaway_k=0;
  Object.values(paMap).forEach(paPitches => {
    const sorted=[...paPitches].sort((a,b)=>(+a.pitch_number||0)-(+b.pitch_number||0));
    race2k_total++;
    let strikes=0;
    for(let i=0;i<Math.min(3,sorted.length);i++){
      const d=sorted[i].description||'';
      if(d.includes('swinging_strike')||d.includes('called_strike')||d.includes('foul')||d==='foul_tip'){strikes++;if(strikes>=2){race2k_hit++;break;}}
    }
    const maxStrikes=Math.max(...sorted.map(p=>+(p.strikes||0)));
    if(maxStrikes>=2){putaway_total++;if(sorted[sorted.length-1].events==='strikeout')putaway_k++;}
  });
  const race2kPct  = race2k_total  ? (race2k_hit/race2k_total*100).toFixed(1)   : '—';
  const putawayPct = putaway_total ? (putaway_k/putaway_total*100).toFixed(1) : '—';

  // F-Strike%, 1-1 Strike%
  let fp_total=0,fp_strikes=0,oo_total=0,oo_strikes=0;
  rows.forEach(r => {
    const b=+(r.balls||0),s=+(r.strikes||0);
    const isStrike=(r.description||'').includes('swinging_strike')||(r.description||'').includes('called_strike')||(r.description||'').includes('foul')||r.description==='hit_into_play'||r.description==='foul_tip';
    if(b===0&&s===0){fp_total++;if(isStrike)fp_strikes++;}
    if(b===1&&s===1){oo_total++;if(isStrike)oo_strikes++;}
  });
  const fpStrikePct  = fp_total ? (fp_strikes/fp_total*100).toFixed(1)  : '—';
  const oonStrikePct = oo_total ? (oo_strikes/oo_total*100).toFixed(1) : '—';

  singleData = { rows, pitchMap, rhhMap, lhhMap, countMap, hardContact, total, pitcherName, gameDate, hand, opp, avgVelo, peakVelo, totalWhiffs, totalCS, walks, ks, hrs, hits, ip, fip, whip, race2kPct, putawayPct, fpStrikePct, oonStrikePct };

  renderPlayerHeader();
  renderArsenal();
  renderSplits();
  renderCounts();
  renderMovement();
  renderHardContact();
  renderLocations();
  renderAIInsight();

  document.getElementById('upload-single').style.display = 'none';
  document.getElementById('report-single').style.display = '';

  // Reset to first tab
  document.querySelectorAll('#main-tabs .tab').forEach((t,i) => t.classList.toggle('active', i===0));
  document.querySelectorAll('.tab-panel').forEach((p,i) => p.classList.toggle('active', i===0));
}

/* ---- Player Header ---- */
function renderPlayerHeader() {
  const { pitcherName, gameDate, hand, opp, total, walks, ks, rows } = singleData;
  document.getElementById('ph-name').textContent = pitcherName;
  document.getElementById('ph-meta').innerHTML =
    `<span class="player-meta-item">${gameDate}</span>
     <span class="player-meta-item">vs. ${opp}</span>
     <span class="player-meta-item">${hand}HP</span>`;

  // RA = runs allowed (from post_bat_score changes)
  const ra = rows.reduce((a, r, i) => {
    const before = +(r.bat_score||0);
    const after  = +(r.post_bat_score||0);
    return a + Math.max(0, after - before);
  }, 0);

  document.getElementById('ph-kpis').innerHTML = [
    { v: total,  l: 'Pitches' },
    { v: ks,     l: 'K'       },
    { v: walks,  l: 'BB'      },
    { v: ra,     l: 'RA'      },
  ].map(k => `<div class="kpi"><div class="kpi-val mono">${k.v}</div><div class="kpi-lbl">${k.l}</div></div>`).join('');
}


/* ---- Arsenal ---- */
function renderArsenal() {
  const { pitchMap, total } = singleData;
  const sorted = sortedPitches(pitchMap);
  const hasBaselines = Object.keys(MLB_BASELINES).length > 0;

  // Update table headers to include MLB avg columns if baselines loaded
  document.querySelector('#arsenal-table thead tr').innerHTML = hasBaselines
    ? `<th>Pitch</th><th>N</th><th>Usage</th><th>Avg velo</th>
       <th>Whiff%</th><th>MLB avg</th><th>CSW%</th><th>MLB avg</th>
       <th>xwOBA</th><th>MLB avg</th><th>Avg EV</th>`
    : `<th>Pitch</th><th>N</th><th>Usage</th><th>Avg velo</th>
       <th>Whiff%</th><th>CSW%</th><th>Ball%</th><th>HIP</th><th>Avg EV</th><th>xwOBA</th>`;

  document.getElementById('arsenal-tbody').innerHTML = sorted.map(([pt, s]) => {
    const usagePct = (s.count/total*100).toFixed(1);
    const avgV  = s.velos.length ? avg(s.velos).toFixed(1) : '—';
    const whiff = s.count ? (s.whiffs/s.count*100).toFixed(1) : 0;
    const csw   = s.count ? ((s.whiffs+s.cstrikes)/s.count*100).toFixed(1) : 0;
    const ball  = s.count ? (s.balls/s.count*100).toFixed(0) : 0;
    const avgEV = s.launch_speeds.length ? avg(s.launch_speeds).toFixed(1) : '—';
    const xwoba = s.xwobas.length ? avg(s.xwobas).toFixed(3) : '—';
    const wC  = whiff >= 30 ? 'v-good' : whiff >= 15 ? 'v-warn' : 'v-bad';
    const cC  = csw >= 30 ? 'v-good' : csw >= 20 ? 'v-warn' : 'v-bad';
    const xwC = xwoba !== '—' ? (parseFloat(xwoba) <= .250 ? 'v-good' : parseFloat(xwoba) <= .350 ? 'v-warn' : 'v-bad') : 'v-num';

    // Shape-matched cluster (velo/movement/release-point aware) — falls back
    // to the flat pitch-type average if there isn't enough shape data yet.
    const throwsMode = s.throws.length ? (s.throws.filter(t=>t==='L').length > s.throws.length/2 ? 'L' : 'R') : null;
    const shapeMatch = throwsMode ? matchShapeCluster(
      pt, throwsMode,
      s.velos.length ? avg(s.velos) : null,
      s.pfx_x_raw.length ? avg(s.pfx_x_raw) : null,
      s.pfx_z_raw.length ? avg(s.pfx_z_raw) : null,
      s.rel_xs.length ? avg(s.rel_xs) : null,
      s.rel_zs.length ? avg(s.rel_zs) : null,
      s.exts.length ? avg(s.exts) : null
    ) : null;

    const mlbWhiff   = shapeMatch ? shapeMatch.metrics.whiff_pct   : getBaseline(pt, 'whiff_pct');
    const mlbCsw     = shapeMatch ? shapeMatch.metrics.csw_pct     : getBaseline(pt, 'csw_pct');
    const mlbXwoba   = shapeMatch ? shapeMatch.metrics.xwoba       : getBaseline(pt, 'avg_xwoba');
    const mlbVelo    = shapeMatch ? shapeMatch.centroid.velo       : getBaseline(pt, 'avg_velo');
    const shapeNote  = shapeMatch ? `<span class="shape-match-tag" title="Compared to ${shapeMatch.n.toLocaleString()} MLB pitches with a similar velo/shape/release, not the full pitch-type average">shape-matched (n=${shapeMatch.n.toLocaleString()})</span>` : '';

    const pitchComps = throwsMode ? findPitchComps(
      pt, throwsMode,
      s.velos.length ? avg(s.velos) : null,
      s.pfx_x_raw.length ? avg(s.pfx_x_raw) : null,
      s.pfx_z_raw.length ? avg(s.pfx_z_raw) : null,
      s.rel_xs.length ? avg(s.rel_xs) : null,
      s.rel_zs.length ? avg(s.rel_zs) : null,
      s.exts.length ? avg(s.exts) : null,
      3
    ) : [];
    const compsNote = pitchComps.length
      ? `<div class="mlb-comp-tag" title="MLB pitchers with the closest matching velo/shape/release for this pitch">Comps: ${pitchComps.map(c=>c.name.split(', ').reverse().join(' ')).join(' · ')}</div>`
      : '';

    if (hasBaselines) {
      return `<tr>
        <td><span class="pitch-chip"><span class="pitch-dot" style="background:${pc(pt)}"></span>${pn(pt)}</span>${shapeNote ? `<div style="margin-top:2px">${shapeNote}</div>` : ''}${compsNote}</td>
        <td class="v-num">${s.count}</td>
        <td><div class="usage-bar-wrap">
          <div class="usage-bar-bg"><div class="usage-bar-fill" style="width:${usagePct}%;background:${pc(pt)}"></div></div>
          <span class="v-num" style="font-size:11px">${usagePct}%</span>
        </div></td>
        <td class="v-num">${avgV} ${veloDelta(avgV, mlbVelo)}</td>
        <td class="${wC}">${whiff}%</td>
        <td class="mlb-avg">${mlbWhiff !== null ? mlbWhiff+'%' : '—'} ${deltaTag(parseFloat(whiff), mlbWhiff, true)}</td>
        <td class="${cC}">${csw}%</td>
        <td class="mlb-avg">${mlbCsw !== null ? mlbCsw+'%' : '—'} ${deltaTag(parseFloat(csw), mlbCsw, true)}</td>
        <td class="${xwC}">${xwoba}</td>
        <td class="mlb-avg">${mlbXwoba !== null ? mlbXwoba : '—'} ${deltaTag(parseFloat(xwoba), mlbXwoba, false)}</td>
        <td class="v-num">${avgEV}</td>
      </tr>`;
    } else {
      return `<tr>
        <td><span class="pitch-chip"><span class="pitch-dot" style="background:${pc(pt)}"></span>${pn(pt)}</span></td>
        <td class="v-num">${s.count}</td>
        <td><div class="usage-bar-wrap">
          <div class="usage-bar-bg"><div class="usage-bar-fill" style="width:${usagePct}%;background:${pc(pt)}"></div></div>
          <span class="v-num" style="font-size:11px">${usagePct}%</span>
        </div></td>
        <td class="v-num">${avgV}</td>
        <td class="${wC}">${whiff}%</td>
        <td class="${cC}">${csw}%</td>
        <td class="v-num">${ball}%</td>
        <td class="v-num">${s.hip}</td>
        <td class="v-num">${avgEV}</td>
        <td class="${xwC}">${xwoba}</td>
      </tr>`;
    }
  }).join('');

  // Whole-arsenal MLB comp — "you pitch like..." banner
  const banner = document.getElementById('arsenal-comp-banner');
  if (banner) {
    const athleteArsenal = {};
    sorted.forEach(([pt, s]) => {
      const throwsMode = s.throws.length ? (s.throws.filter(t=>t==='L').length > s.throws.length/2 ? 'L' : 'R') : null;
      if (!throwsMode || !s.velos.length || !s.pfx_x_raw.length || !s.pfx_z_raw.length || !s.rel_xs.length || !s.rel_zs.length || !s.exts.length) return;
      const sign = throwsMode === 'L' ? -1 : 1;
      athleteArsenal[pt === 'FA' ? 'FF' : pt] = {
        usage_pct: s.count/total*100,
        velo: avg(s.velos),
        hb_norm: avg(s.pfx_x_raw) * sign,
        vb: avg(s.pfx_z_raw),
        side_norm: avg(s.rel_xs) * sign,
        height: avg(s.rel_zs),
        ext: avg(s.exts),
      };
    });
    const arsenalComps = Object.keys(athleteArsenal).length ? findArsenalComps(athleteArsenal, 3) : [];
    banner.innerHTML = arsenalComps.length
      ? `<div class="arsenal-comp-banner">
           <span class="arsenal-comp-lbl">Arsenal comps (velo, shape &amp; release across the whole mix):</span>
           ${arsenalComps.map(c => `<span class="arsenal-comp-chip">${c.name.split(', ').reverse().join(' ')}</span>`).join('')}
         </div>`
      : '';
  }

  // Donut
  destroyChart('mix-chart');
  charts['mix-chart'] = new Chart(document.getElementById('mix-chart'), {
    type: 'doughnut',
    data: { labels: sorted.map(([pt])=>pn(pt)), datasets: [{ data: sorted.map(([,s])=>s.count), backgroundColor: sorted.map(([pt])=>pc(pt)), borderWidth: 2, borderColor: '#111316' }] },
    options: { responsive:true, maintainAspectRatio:false, cutout:'58%', plugins:{ legend:{ display:true, position:'right', labels:{ color:'#72747c', font:{size:11,family:'DM Mono'}, padding:10 } } } }
  });

  // CSW bar
  destroyChart('csw-chart');
  const cswVals = sorted.map(([,s]) => s.count ? Math.round((s.whiffs+s.cstrikes)/s.count*100) : 0);
  charts['csw-chart'] = new Chart(document.getElementById('csw-chart'), {
    type: 'bar',
    data: { labels: sorted.map(([pt])=>pn(pt)), datasets: [{ data:cswVals, backgroundColor:sorted.map(([pt])=>pc(pt)), borderRadius:3, borderSkipped:false }] },
    options: { responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}},
      scales:{ y:{ beginAtZero:true, max:65, ticks:{callback:v=>v+'%',color:'#72747c',font:{size:10}}, grid:{color:'rgba(255,255,255,0.04)'} }, x:{ticks:{color:'#72747c',font:{size:10}},grid:{display:false}} } }
  });
}

/* ---- Splits ---- */
function renderSplitsTable(map, total, bodyId) {
  const sorted = sortedPitches(map);
  document.getElementById(bodyId).innerHTML = sorted.map(([pt, s]) => {
    const usagePct = total ? (s.count/total*100).toFixed(1) : '—';
    const whiff = s.count ? (s.whiffs/s.count*100).toFixed(0) : 0;
    const csw   = s.count ? ((s.whiffs+s.cstrikes)/s.count*100).toFixed(0) : 0;
    const xwoba = s.xwobas.length ? avg(s.xwobas).toFixed(3) : '—';
    const wC = whiff >= 30 ? 'v-good' : whiff >= 15 ? 'v-warn' : 'v-bad';
    const xC = xwoba !== '—' ? (xwoba <= .250 ? 'v-good' : xwoba <= .350 ? 'v-warn' : 'v-bad') : 'v-num';
    return `<tr>
      <td><span class="pitch-chip"><span class="pitch-dot" style="background:${pc(pt)}"></span>${pn(pt)}</span></td>
      <td class="v-num">${s.count}</td>
      <td class="v-num">${usagePct}%</td>
      <td class="${wC}">${whiff}%</td>
      <td class="${wC}">${csw}%</td>
      <td class="${xC}">${xwoba}</td>
    </tr>`;
  }).join('');
}

function renderSplitDonut(map, canvasId) {
  destroyChart(canvasId);
  const sorted = sortedPitches(map);
  charts[canvasId] = new Chart(document.getElementById(canvasId), {
    type: 'doughnut',
    data: { labels: sorted.map(([pt])=>pn(pt)), datasets:[{ data:sorted.map(([,s])=>s.count), backgroundColor:sorted.map(([pt])=>pc(pt)), borderWidth:2, borderColor:'#111316' }] },
    options: { responsive:true, maintainAspectRatio:false, cutout:'55%', plugins:{ legend:{ display:true, position:'right', labels:{ color:'#72747c', font:{size:10,family:'DM Mono'}, padding:8 } } } }
  });
}

function renderSplits() {
  const { rhhMap, lhhMap, rhhRows, lhhRows } = singleData;
  const rhhTotal = Object.values(rhhMap).reduce((a,s)=>a+s.count,0);
  const lhhTotal = Object.values(lhhMap).reduce((a,s)=>a+s.count,0);
  renderSplitsTable(rhhMap, rhhTotal, 'splits-rhh');
  renderSplitsTable(lhhMap, lhhTotal, 'splits-lhh');
  renderSplitDonut(rhhMap, 'split-rhh-chart');
  renderSplitDonut(lhhMap, 'split-lhh-chart');
}

/* ---- Counts ---- */
function renderCounts() {
  const { countMap, pitchMap } = singleData;
  const allTypes = sortedPitches(pitchMap).map(([pt])=>pt).slice(0,6);
  const validCounts = COUNT_ORDER.filter(c => countMap[c] && Object.keys(countMap[c]).length);

  document.getElementById('count-grid').innerHTML = validCounts.map(cnt => {
    const cm = countMap[cnt];
    const ctotal = Object.values(cm).reduce((a,b)=>a+b,0);
    const sorted = Object.entries(cm).sort((a,b)=>b[1]-a[1]);
    return `<div class="count-cell">
      <div class="count-lbl">${cnt}</div>
      ${sorted.slice(0,4).map(([pt,n]) => {
        const pct = Math.round(n/ctotal*100);
        return `<div class="count-row">
          <span style="width:22px;font-size:10px;color:var(--muted);font-family:'DM Mono',monospace">${pt}</span>
          <div class="count-bar-bg"><div class="count-bar-fill" style="width:${pct}%;background:${pc(pt)}"></div></div>
          <span style="font-size:10px;font-family:'DM Mono',monospace;color:var(--muted);width:28px;text-align:right">${pct}%</span>
        </div>`;
      }).join('')}
      <div class="count-total">${ctotal} pitches</div>
    </div>`;
  }).join('');

  destroyChart('count-stack-chart');
  const datasets = allTypes.map(pt => ({
    label: pn(pt),
    data: validCounts.map(cnt => {
      const cm = countMap[cnt]||{};
      const ct = Object.values(cm).reduce((a,b)=>a+b,0);
      return ct ? Math.round((cm[pt]||0)/ct*100) : 0;
    }),
    backgroundColor: pc(pt), borderWidth: 0,
  }));
  charts['count-stack-chart'] = new Chart(document.getElementById('count-stack-chart'), {
    type: 'bar',
    data: { labels: validCounts, datasets },
    options: {
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ display:true, position:'bottom', labels:{ color:'#72747c', font:{size:10,family:'DM Mono'}, padding:12, boxWidth:10 } } },
      scales:{
        x:{ stacked:true, ticks:{color:'#72747c',font:{size:10,family:'DM Mono'}}, grid:{display:false} },
        y:{ stacked:true, max:100, ticks:{callback:v=>v+'%',color:'#72747c',font:{size:10}}, grid:{color:'rgba(255,255,255,0.04)'} }
      }
    }
  });
}

/* ---- Movement ---- */
/* VAA / HAA computed at plate using kinematic equations
   vx_f = vx0 + ax*t,  vy_f = vy0 + ay*t,  vz_f = vz0 + az*t
   t ≈ distance_to_plate / |vy0|  (60.5ft - extension) */
function computeApproachAngles(r) {
  const vx0 = pf(r.vx0), vy0 = pf(r.vy0), vz0 = pf(r.vz0);
  const ax  = pf(r.ax),  ay  = pf(r.ay),  az  = pf(r.az);
  const ext = pf(r.release_extension) || 6.0;
  if (!vy0) return { vaa: null, haa: null };
  const dist = 60.5 - ext;           // ft from release to plate
  const t    = dist / Math.abs(vy0); // time in seconds
  const vxf  = vx0 + ax * t;
  const vyf  = vy0 + ay * t;
  const vzf  = vz0 + az * t;
  const vaa  = Math.atan(vzf / Math.abs(vyf)) * (180 / Math.PI);
  const haa  = Math.atan(vxf / Math.abs(vyf)) * (180 / Math.PI);
  return { vaa: +vaa.toFixed(1), haa: +haa.toFixed(1) };
}

function renderMovement() {
  const { rows, pitchMap } = singleData;
  const sorted = sortedPitches(pitchMap);

  // Scatter plot — clean, centered axes
  destroyChart('movement-chart');
  charts['movement-chart'] = new Chart(document.getElementById('movement-chart'), {
    type: 'scatter',
    data: { datasets: sorted.map(([pt]) => ({
      label: pn(pt),
      data: rows.filter(r => r._pt===pt && r.pfx_x && r.pfx_z)
                .map(r => ({ x: -pf(r.pfx_x)*12, y: pf(r.pfx_z)*12 })),
      backgroundColor: pc(pt) + 'cc',
      pointRadius: 5, pointHoverRadius: 8,
    }))},
    options: {
      responsive: true, maintainAspectRatio: false,
      layout: { padding: { top: 16, right: 8, bottom: 8, left: 8 } },
      plugins: {
        legend: { display: true, position: 'right', labels: { color:'#72747c', font:{ size:11, family:'DM Mono' }, padding:14, boxWidth:10 } },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: HB ${ctx.parsed.x.toFixed(1)}", IVB ${ctx.parsed.y.toFixed(1)}"` } }
      },
      scales: {
        x: {
          position: 'center',
          title: { display: false },
          ticks: { color:'#72747c', font:{size:10}, stepSize: 5 },
          grid: { color:'rgba(255,255,255,0.06)' },
          min: -25, max: 25,
        },
        y: {
          position: 'center',
          title: { display: false },
          ticks: { color:'#72747c', font:{size:10}, stepSize: 5 },
          grid: { color:'rgba(255,255,255,0.06)' },
          min: -20, max: 25,
        }
      }
    }
  });

  // Build per-pitch stat objects with VAA/HAA and spin
  const pitchStats = sorted.map(([pt, s]) => {
    const pitchRows = rows.filter(r => r._pt === pt);
    const angles = pitchRows.map(computeApproachAngles).filter(a => a.vaa !== null);
    const avgVAA = angles.length ? avg(angles.map(a => a.vaa)) : null;
    const avgHAA = angles.length ? avg(angles.map(a => a.haa)) : null;
    const peakVelo = s.velos.length ? Math.max(...s.velos) : null;
    const avgSpin  = s.spins.length ? Math.round(avg(s.spins)) : null;
    return {
      pt,
      avgVelo:  s.velos.length    ? avg(s.velos).toFixed(1)   : '—',
      peakVelo: peakVelo           ? peakVelo.toFixed(1)        : '—',
      avgSpin:  avgSpin            ? avgSpin+'rpm'              : '—',
      ivb:      s.pfx_zs.length   ? avg(s.pfx_zs).toFixed(1)  : '—',
      hb:       s.pfx_xs.length   ? avg(s.pfx_xs).toFixed(1)  : '—',
      vaa:      avgVAA !== null    ? avgVAA.toFixed(1)          : '—',
      haa:      avgHAA !== null    ? avgHAA.toFixed(1)          : '—',
    };
  });

  const header = `<div class="mov-header-row">
    <div class="mov-header-label">Pitch</div>
    <div class="mov-header-stats">
      <div class="mov-header-stat">Avg velo</div>
      <div class="mov-header-stat">Peak velo</div>
      <div class="mov-header-stat">Spin</div>
      <div class="mov-header-stat">IVB</div>
      <div class="mov-header-stat">HB</div>
      <div class="mov-header-stat">VAA</div>
      <div class="mov-header-stat">HAA</div>
    </div>
  </div>`;

  const statRows = pitchStats.map(p => `
    <div class="mov-pitch-row">
      <div class="mov-pitch-label">
        <span class="pitch-dot" style="background:${pc(p.pt)};width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:8px;flex-shrink:0"></span>
        <span class="mov-pitch-name">${pn(p.pt)}</span>
      </div>
      <div class="mov-stat-group">
        <div class="mov-stat"><div class="mov-stat-val">${p.avgVelo}</div></div>
        <div class="mov-stat"><div class="mov-stat-val">${p.peakVelo}</div></div>
        <div class="mov-stat"><div class="mov-stat-val">${p.avgSpin}</div></div>
        <div class="mov-stat"><div class="mov-stat-val">${p.ivb}"</div></div>
        <div class="mov-stat"><div class="mov-stat-val">${p.hb}"</div></div>
        <div class="mov-stat"><div class="mov-stat-val">${p.vaa}°</div></div>
        <div class="mov-stat"><div class="mov-stat-val">${p.haa}°</div></div>
      </div>
    </div>
  `).join('');

  document.getElementById('movement-stat-cards').innerHTML = header + statRows;
}

/* ---- Hard Contact ---- */
function renderHardContact() {
  const { hardContact, pitchMap, rows } = singleData;
  const wrap = document.getElementById('hc-table-wrap');
  if (!hardContact.length) {
    wrap.innerHTML = '<div class="empty-state">No hard contact events (EV ≥ 90 or XBH) in this dataset.</div>';
  } else {
    wrap.innerHTML = `<table class="data-table">
      <thead><tr><th>Pitch</th><th>EV (mph)</th><th>LA</th><th>Event</th><th>xwOBA</th><th>Count</th><th>Description</th></tr></thead>
      <tbody>${hardContact.slice(0,20).map(r => {
        const ev = pf(r.launch_speed);
        const evC = ev >= 105 ? 'ev-elite' : ev >= 95 ? 'ev-hard' : 'ev-ok';
        const xw = r.estimated_woba_using_speedangle ? pf(r.estimated_woba_using_speedangle).toFixed(3) : '—';
        return `<tr>
          <td><span class="pitch-chip"><span class="pitch-dot" style="background:${pc(r._pt)}"></span>${pn(r._pt)}</span></td>
          <td><span class="ev-pill ${evC}">${ev.toFixed(1)}</span></td>
          <td class="v-num">${r.launch_angle||'—'}°</td>
          <td style="font-size:12px">${(r.events||'in play').replace(/_/g,' ')}</td>
          <td class="v-num">${xw}</td>
          <td class="mono" style="font-size:11px">${r.balls}-${r.strikes}</td>
          <td style="font-size:11px;color:var(--muted)">${(r.des||'').substring(0,60)}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  }

  // Avg EV chart
  const sorted = sortedPitches(pitchMap);
  const evByPitch = sorted.map(([pt,s]) => ({ pt, avgEV: s.launch_speeds.length ? avg(s.launch_speeds) : 0, n: s.launch_speeds.length })).filter(d=>d.n>0);

  destroyChart('ev-chart');
  charts['ev-chart'] = new Chart(document.getElementById('ev-chart'), {
    type: 'bar', indexAxis: 'y',
    data: { labels:evByPitch.map(d=>pn(d.pt)), datasets:[{ data:evByPitch.map(d=>+d.avgEV.toFixed(1)), backgroundColor:evByPitch.map(d=>pc(d.pt)), borderRadius:3, borderSkipped:false }] },
    options: { responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}},
      scales:{ x:{ min:60, ticks:{callback:v=>v+' mph',color:'#72747c',font:{size:10}}, grid:{color:'rgba(255,255,255,0.04)'}}, y:{ticks:{color:'#72747c',font:{size:11}},grid:{display:false}} } }
  });

  // Hard hit %
  const hhByPitch = sorted.map(([pt,s]) => {
    const hh = s.launch_speeds.filter(ev=>ev>=95).length;
    return { pt, pct: s.launch_speeds.length ? Math.round(hh/s.launch_speeds.length*100) : 0, n: s.launch_speeds.length };
  }).filter(d=>d.n>0);

  destroyChart('hh-chart');
  charts['hh-chart'] = new Chart(document.getElementById('hh-chart'), {
    type: 'bar', indexAxis: 'y',
    data: { labels:hhByPitch.map(d=>pn(d.pt)), datasets:[{ data:hhByPitch.map(d=>d.pct), backgroundColor:hhByPitch.map(d=>pc(d.pt)), borderRadius:3, borderSkipped:false }] },
    options: { responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}},
      scales:{ x:{ beginAtZero:true, max:100, ticks:{callback:v=>v+'%',color:'#72747c',font:{size:10}}, grid:{color:'rgba(255,255,255,0.04)'}}, y:{ticks:{color:'#72747c',font:{size:11}},grid:{display:false}} } }
  });
}

/* ---- Insights ---- */
function renderLocations() {
  if (!singleData) return;
  const { pitchMap, rows } = singleData;
  const wrap = document.getElementById('locations-wrap');
  if (!wrap) return;

  const OUTCOME_COLORS = { W:'#e91e8c', CS:'#00d4ff', HIP:'#BA7517', F:'#534AB7', B:'rgba(255,255,255,0.15)' };
  const OUTCOME_LABELS = { W:'Whiff', CS:'Called Strike', HIP:'In Play', F:'Foul', B:'Ball' };

  // Collect locations per pitch type
  const pitchLocs = {};
  const allSpray = [];
  Object.entries(pitchMap).forEach(([pt, s]) => {
    if (s.locations && s.locations.length) {
      pitchLocs[pt] = s.locations.filter(loc => analyzerLocHand==='all' || loc[3]===analyzerLocHand);
    }
    if (s.spray && s.spray.length) {
      s.spray.filter(sp => analyzerLocHand==='all' || sp[4]===analyzerLocHand).forEach(sp => allSpray.push({x:sp[0],y:sp[1],bbt:sp[2],ev:sp[3],pt}));
    }
  });

  const hasLocs = Object.values(pitchLocs).some(l=>l.length>0);
  if (!hasLocs && !allSpray.length) {
    wrap.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:2rem">No location data available in this CSV.</div>';
    return;
  }

  // Combined pitch location chart
  const W=280, H=320, PAD=24;
  const xMin=-1.75, xMax=1.75, zMin=0.5, zMax=5.0;
  const toSvgX = x => PAD+(x-xMin)/(xMax-xMin)*(W-PAD*2);
  const toSvgZ = z => H-PAD-(z-zMin)/(zMax-zMin)*(H-PAD*2);
  const szX1=toSvgX(-0.71), szX2=toSvgX(0.71), szZ1=toSvgZ(3.5), szZ2=toSvgZ(1.5);

  const allDots = [];
  Object.entries(pitchLocs).forEach(([pt, locs]) => {
    locs.forEach(loc => {
      const [x,z,outcome] = loc;
      const cx=toSvgX(x), cy=toSvgZ(z);
      if(cx<PAD-10||cy<PAD-10||cx>W+10||cy>H+10) return;
      allDots.push({cx,cy,color:analyzerLocColor==='pitch'?pc(pt):(OUTCOME_COLORS[outcome]||'#444'),priority:outcome==='W'?3:outcome==='CS'?2:outcome==='HIP'?1:0,pt,outcome});
    });
  });
  allDots.sort((a,b)=>a.priority-b.priority);
  const dots = allDots.map(({cx,cy,color,outcome})=>`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${outcome==='W'?5:4}" fill="${color}" fill-opacity="0.75" stroke="${color}" stroke-width="0.5"/>`).join('');

  const ptCounts={};allDots.forEach(({pt})=>ptCounts[pt]=(ptCounts[pt]||0)+1);
  const pitchLeg=Object.entries(ptCounts).sort((a,b)=>b[1]-a[1]).map(([pt,n])=>`<span style="display:inline-flex;align-items:center;gap:4px;margin-right:8px;font-size:11px;color:var(--muted)"><span style="width:8px;height:8px;border-radius:50%;background:${pc(pt)};display:inline-block"></span>${pn(pt)} ${n}</span>`).join('');
  const outLeg=Object.entries(OUTCOME_COLORS).map(([k,c])=>`<span style="display:inline-flex;align-items:center;gap:4px;margin-right:8px;font-size:11px;color:var(--muted)"><span style="width:8px;height:8px;border-radius:50%;background:${c};display:inline-block"></span>${OUTCOME_LABELS[k]}</span>`).join('');
  const totalLocs=allDots.length;

  const locChart=`<div class="loc-zone-card"><div class="loc-zone-title" style="font-family:'Barlow Condensed',sans-serif;font-size:15px;font-weight:700;margin-bottom:.5rem">Pitch Locations <span style="font-size:11px;color:var(--muted);font-weight:400">${totalLocs} pitches</span></div><svg width="${W}" height="${H}" style="display:block"><rect x="${PAD}" y="${PAD}" width="${W-PAD*2}" height="${H-PAD*2}" fill="rgba(255,255,255,0.02)" rx="2"/><rect x="${szX1}" y="${szZ1}" width="${szX2-szX1}" height="${szZ2-szZ1}" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.35)" stroke-width="1.5" rx="1"/>${[1,2].map(i=>`<line x1="${szX1+(szX2-szX1)/3*i}" y1="${szZ1}" x2="${szX1+(szX2-szX1)/3*i}" y2="${szZ2}" stroke="rgba(255,255,255,0.12)" stroke-width="0.75"/>`).join('')}${[1,2].map(i=>`<line x1="${szX1}" y1="${szZ1+(szZ2-szZ1)/3*i}" x2="${szX2}" y2="${szZ1+(szZ2-szZ1)/3*i}" stroke="rgba(255,255,255,0.12)" stroke-width="0.75"/>`).join('')}<rect x="${toSvgX(-1.05)}" y="${toSvgZ(4.0)}" width="${toSvgX(1.05)-toSvgX(-1.05)}" height="${toSvgZ(1.0)-toSvgZ(4.0)}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1" stroke-dasharray="4,3" rx="2"/><polygon points="${toSvgX(0)},${H-PAD+4} ${toSvgX(-0.28)},${H-PAD-4} ${toSvgX(-0.28)},${H-PAD} ${toSvgX(0.28)},${H-PAD} ${toSvgX(0.28)},${H-PAD-4}" fill="rgba(255,255,255,0.25)"/><text x="${W/2}" y="${H-2}" text-anchor="middle" font-size="9" fill="rgba(255,255,255,0.2)">← Inside · Outside →</text>${dots}</svg><div style="margin-top:8px;line-height:2">${analyzerLocColor==='pitch'?pitchLeg:outLeg}</div></div>`;

  // Spray chart
  let sprayChart='';
  if (allSpray.length) {
    const SW=340,SH=310;
    const hpX=SW/2,hpY=SH-18;
    const lfX=22,lfY=95,rfX=SW-22,rfY=95,cfX=SW/2,cfY=10;
    const b1X=hpX+72,b1Y=hpY-72,b2X=hpX,b2Y=hpY-144,b3X=hpX-72,b3Y=hpY-72;
    const wtLfX=lfX-14,wtLfY=lfY+8,wtRfX=rfX+14,wtRfY=rfY+8,wtCfY=cfY-14;
    const HX_CENTER=125,HX_RANGE=90,HY_HOME=200,HY_FENCE=45;
    const toX=(hcx,hcy)=>{const d=Math.max(0,Math.min(1,(hcy-HY_FENCE)/(HY_HOME-HY_FENCE)));return hpX+(hcx-HX_CENTER)/HX_RANGE*(SW/2-25)*(1-d*0.05);};
    const toY=(hcx,hcy)=>{const d=Math.max(0,Math.min(1.1,(hcy-HY_FENCE)/(HY_HOME-HY_FENCE)));return hpY-(1-d)*(hpY-cfY-10);};
    const BB_COLORS={ground_ball:'#c13584',line_drive:'#f0d44a',fly_ball:'#4a9e4a',popup:'#e05c2a'};
    const BB_LABELS={ground_ball:'Ground Ball',line_drive:'Line Drive',fly_ball:'Fly Ball',popup:'Popup'};
    const ptC2={};allSpray.forEach(({pt})=>ptC2[pt]=(ptC2[pt]||0)+1);
    const sDots=allSpray.map(({x,y,bbt,ev,pt})=>{const sx=toX(x,y),sy=toY(x,y);if(sx<5||sy<5||sx>SW-5||sy>SH+5)return'';const color=analyzerLocColor==='pitch'?pc(pt):(BB_COLORS[bbt]||'#888');const hard=ev&&ev>=95;return`<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${hard?6:4.5}" fill="${color}" fill-opacity="0.92" stroke="${hard?'#fff':'rgba(0,0,0,0.35)'}" stroke-width="${hard?1.5:0.5}"/>`;}).join('');
    const sLeg=analyzerLocColor==='pitch'?Object.entries(ptC2).sort((a,b)=>b[1]-a[1]).map(([pt])=>`<span style="display:inline-flex;align-items:center;gap:4px;margin-right:10px;font-size:11px;color:var(--muted)"><span style="width:8px;height:8px;border-radius:50%;background:${pc(pt)};display:inline-block"></span>${pn(pt)}</span>`).join(''):Object.entries(BB_COLORS).map(([k,c])=>`<span style="display:inline-flex;align-items:center;gap:4px;margin-right:10px;font-size:11px;color:var(--muted)"><span style="width:8px;height:8px;border-radius:50%;background:${c};display:inline-block"></span>${BB_LABELS[k]}</span>`).join('');
    sprayChart=`<div class="loc-zone-card"><div class="loc-zone-title" style="font-family:'Barlow Condensed',sans-serif;font-size:15px;font-weight:700;margin-bottom:.5rem">Spray Chart <span style="font-size:11px;color:var(--muted);font-weight:400">${allSpray.length} batted balls</span></div><svg width="${SW}" height="${SH}" style="display:block"><path d="M ${hpX} ${hpY} L ${wtLfX} ${wtLfY} Q ${cfX} ${wtCfY} ${wtRfX} ${wtRfY} Z" fill="rgba(110,78,30,0.6)"/><path d="M ${hpX} ${hpY} L ${lfX} ${lfY} Q ${cfX} ${cfY} ${rfX} ${rfY} Z" fill="rgba(35,72,35,0.75)"/><path d="M ${lfX} ${lfY} Q ${cfX} ${cfY} ${rfX} ${rfY}" fill="none" stroke="rgba(255,255,255,0.6)" stroke-width="2.5"/><line x1="${hpX}" y1="${hpY}" x2="${wtLfX-8}" y2="${wtLfY+4}" stroke="rgba(255,255,255,0.55)" stroke-width="1.5"/><line x1="${hpX}" y1="${hpY}" x2="${wtRfX+8}" y2="${wtRfY+4}" stroke="rgba(255,255,255,0.55)" stroke-width="1.5"/><path d="M ${hpX} ${hpY} L ${b1X+20} ${b1Y+12} L ${b2X} ${b2Y-8} L ${b3X-20} ${b3Y+12} Z" fill="rgba(130,88,35,0.5)"/><polygon points="${hpX},${hpY} ${b1X},${b1Y} ${b2X},${b2Y} ${b3X},${b3Y}" fill="rgba(35,72,35,0.85)"/><line x1="${hpX}" y1="${hpY}" x2="${b1X}" y2="${b1Y}" stroke="rgba(255,255,255,0.2)" stroke-width="1"/><line x1="${b1X}" y1="${b1Y}" x2="${b2X}" y2="${b2Y}" stroke="rgba(255,255,255,0.2)" stroke-width="1"/><line x1="${b2X}" y1="${b2Y}" x2="${b3X}" y2="${b3Y}" stroke="rgba(255,255,255,0.2)" stroke-width="1"/><line x1="${b3X}" y1="${b3Y}" x2="${hpX}" y2="${hpY}" stroke="rgba(255,255,255,0.2)" stroke-width="1"/><ellipse cx="${hpX}" cy="${(hpY+b2Y)/2+6}" rx="9" ry="7" fill="rgba(130,88,35,0.7)"/><rect x="${b2X-5}" y="${b2Y-5}" width="10" height="10" fill="rgba(235,230,210,0.9)" transform="rotate(45,${b2X},${b2Y})" rx="1"/><rect x="${b1X-5}" y="${b1Y-5}" width="10" height="10" fill="rgba(235,230,210,0.9)" transform="rotate(45,${b1X},${b1Y})" rx="1"/><rect x="${b3X-5}" y="${b3Y-5}" width="10" height="10" fill="rgba(235,230,210,0.9)" transform="rotate(45,${b3X},${b3Y})" rx="1"/><polygon points="${hpX},${hpY-5} ${hpX-8},${hpY-12} ${hpX-8},${hpY+4} ${hpX+8},${hpY+4} ${hpX+8},${hpY-12}" fill="rgba(235,230,210,0.9)"/>${sDots}</svg><div style="margin-top:8px;line-height:2">${sLeg}</div><div style="font-size:10px;color:var(--muted);margin-top:2px">White outline = hard hit (95+ mph EV)</div></div>`;
  }

  wrap.innerHTML = `<div style="display:flex;flex-wrap:wrap;gap:1.5rem">${locChart}${sprayChart}</div>`;
}

/* ---- AI Insight ---- */
async function renderAIInsight() {
  const container = document.getElementById('ai-insight-content');
  if (!singleData) return;
  const SCRIPT_URL = localStorage.getItem('8ctane_script_url') || '';
  if (!SCRIPT_URL) {
    container.innerHTML = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:1.5rem;font-size:13px;color:var(--muted)">
      <strong style="color:var(--text)">AI Insight requires Apps Script connection.</strong><br>
      Go to the Athletes page, paste your Apps Script URL in ⚙ Configure, then reload this page.
    </div>`;
    return;
  }

  container.innerHTML = `<div style="text-align:center;padding:3rem;color:var(--muted);font-size:13px"><div style="width:28px;height:28px;border:2px solid var(--border2);border-top-color:var(--cyan);border-radius:50%;animation:spin .7s linear infinite;margin:0 auto 1rem"></div>Generating AI analysis...</div>`;

  const { pitchMap, total, pitcherName, hand, gameDate, opp, walks, ks, fip, whip, race2kPct, putawayPct, fpStrikePct, oonStrikePct } = singleData;
  const sorted = sortedPitches(pitchMap);
  const mlb = (typeof MLB_BASELINE_REF !== 'undefined') ? MLB_BASELINE_REF : {};

  const pitchLines = sorted.map(([pt, s]) => {
    const whiff = s.count ? (s.whiffs/s.count*100).toFixed(1) : 0;
    const csw   = s.count ? ((s.whiffs+s.cstrikes)/s.count*100).toFixed(1) : 0;
    const xwoba = s.xwobas.length ? avg(s.xwobas).toFixed(3) : 'N/A';
    const xba   = s.xbas.length  ? avg(s.xbas).toFixed(3)   : 'N/A';
    const xslg  = s.xslgs.length ? avg(s.xslgs).toFixed(3)  : 'N/A';
    const velo  = s.velos.length  ? avg(s.velos).toFixed(1)  : '?';
    const ivb   = s.pfx_zs.length ? avg(s.pfx_zs).toFixed(1) : '?';
    const hb    = s.pfx_xs.length ? avg(s.pfx_xs).toFixed(1) : '?';
    const spin  = s.spins.length  ? Math.round(avg(s.spins))+'rpm' : 'N/A';
    const mlbW  = mlb[pt]?.whiff_pct;
    return `${pn(pt)} (${pt}): ${(s.count/total*100).toFixed(0)}% usage | ${velo}mph | Spin:${spin} | IVB:${ivb}" HB:${hb}" | Whiff:${whiff}% (MLB:${mlbW||'?'}%) | CSW:${csw}% | xwOBA:${xwoba} | xBA:${xba} | xSLG:${xslg}`;
  }).join('\n');

  const prompt = `You are a pitching coach at 8ctane Baseball analyzing a pitcher's outing. Write directly to the pitcher. Direct, encouraging, specific. Use "you"/"your". NEVER mention psStuff+ unless provided.

PITCHER: ${pitcherName} (${hand}HP)
OUTING: ${gameDate} vs ${opp} | ${total} pitches | ${ks}K ${walks}BB
FIP:${fip} | WHIP:${whip} | F-Strike%:${fpStrikePct}% | Race to 2K:${race2kPct}% | Putaway%:${putawayPct}%

ARSENAL (IVB/HB in inches, arm-side positive):
${pitchLines}

RULES: Lead with strengths. Flag shape gaps (big IVB FB + big breaking ball = needs bridging pitch). ALWAYS include MLB comp with same handedness. Recommend pitch add only if clear gap. Never suggest knuckleball/eephus. 30%+ whiff = elite. F-Strike% below 58% or Putaway% below 28% should lead concerns.

JSON only — no markdown:
{"headline":"2-3 words","summary":"3-4 sentences","pitchBlurbs":[{"pitch":"...","blurb":"1-2 sentences on shape/results"}],"strengths":[{"title":"...","detail":"..."}],"concerns":[{"title":"...","detail":"..."}],"arsenalAssessment":{"keepPitches":[{"pitch":"...","reason":"..."}],"developPitches":[{"pitch":"...","reason":"..."}],"addPitch":{"pitch":"...","reason":"..."},"removePitch":{"pitch":"...","reason":"..."}},"mlbComp":{"name":"...","reason":"2-3 sentences"},"splitAdvice":{"vsRHH":"...","vsLHH":"..."},"developmentPriorities":["...","...","..."]}`;

  try {
    const res = await fetch(`${SCRIPT_URL}?action=analyze`, {
      method:'POST', body: JSON.stringify({ action:'analyze', messages:[{role:'user',content:prompt}] })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const raw = data.text||''; const match = raw.match(/\{[\s\S]*\}/);
    const a = JSON.parse(match?match[0]:raw);

    const strengthCards=(a.strengths||[]).map(s=>`<div class="insight-card good"><div class="insight-title">${s.title}</div><div class="insight-body">${s.detail}</div></div>`).join('');
    const concernCards=(a.concerns||[]).map(s=>`<div class="insight-card danger"><div class="insight-title">${s.title}</div><div class="insight-body">${s.detail}</div></div>`).join('');
    const keepP=(a.arsenalAssessment?.keepPitches||[]).map(p=>`<div class="arsenal-rec keep">✓ <strong>${p.pitch}</strong> — ${p.reason}</div>`).join('');
    const devP=(a.arsenalAssessment?.developPitches||[]).map(p=>`<div class="arsenal-rec develop">↑ <strong>${p.pitch}</strong> — ${p.reason}</div>`).join('');
    const addP=a.arsenalAssessment?.addPitch?`<div class="arsenal-rec add">+ Add: <strong>${a.arsenalAssessment.addPitch.pitch}</strong> — ${a.arsenalAssessment.addPitch.reason}</div>`:'';
    const remP=a.arsenalAssessment?.removePitch?`<div class="arsenal-rec remove">− <strong>${a.arsenalAssessment.removePitch.pitch}</strong> — ${a.arsenalAssessment.removePitch.reason}</div>`:'';
    const blurbs=(a.pitchBlurbs||[]).map(pb=>{
      const key=Object.keys(PITCH_NAMES).find(k=>PITCH_NAMES[k]===pb.pitch)||'OTHER';
      return`<div style="background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:.75rem 1.125rem;margin-bottom:.5rem"><div style="display:flex;align-items:center;gap:6px;margin-bottom:4px"><span style="width:9px;height:9px;border-radius:50%;background:${pc(key)};display:inline-block;flex-shrink:0"></span><span style="font-family:'Barlow Condensed',sans-serif;font-size:15px;font-weight:700">${pb.pitch}</span></div><div style="font-size:13px;color:var(--muted);line-height:1.65">${pb.blurb}</div></div>`;
    }).join('');
    const mlbComp=a.mlbComp?.name?`<div class="section" style="margin-top:1.5rem"><div class="section-hd">MLB Comparison</div><div style="background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--cyan);border-radius:8px;padding:.875rem 1.25rem"><div style="font-family:'Barlow Condensed',sans-serif;font-size:18px;font-weight:800;color:var(--cyan);margin-bottom:4px">${a.mlbComp.name}</div><div style="font-size:13px;color:var(--muted);line-height:1.65">${a.mlbComp.reason}</div></div></div>`:'';

    container.innerHTML=`
      <div style="font-family:'Barlow Condensed',sans-serif;font-size:30px;font-weight:800;margin-bottom:.5rem;line-height:1.1">${a.headline||''}</div>
      <div style="font-size:14px;color:var(--muted);line-height:1.75;max-width:680px;margin-bottom:1.5rem">${a.summary||''}</div>
      ${blurbs?`<div class="section-hd">Pitch Breakdown</div>${blurbs}`:''}
      <div class="section-hd" style="margin-top:1.5rem">Strengths &amp; concerns</div>
      <div class="insight-grid">${strengthCards}${concernCards}</div>
      <div class="section-hd" style="margin-top:1.5rem">Arsenal</div>
      <div style="display:flex;flex-direction:column;gap:.5rem;margin-bottom:1.5rem">${keepP}${devP}${addP}${remP}</div>
      ${mlbComp}
      <div class="section-hd" style="margin-top:1.5rem">Splits</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1.5rem">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:1rem 1.25rem"><div style="font-family:'Barlow Condensed',sans-serif;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#378ADD;margin-bottom:.5rem">vs. Right-handed</div><div style="font-size:12px;color:var(--muted);line-height:1.65">${a.splitAdvice?.vsRHH||''}</div></div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:1rem 1.25rem"><div style="font-family:'Barlow Condensed',sans-serif;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#D85A30;margin-bottom:.5rem">vs. Left-handed</div><div style="font-size:12px;color:var(--muted);line-height:1.65">${a.splitAdvice?.vsLHH||''}</div></div>
      </div>
      <div class="section-hd">Development priorities</div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">${(a.developmentPriorities||[]).map((p,i)=>`<div style="display:flex;align-items:flex-start;gap:1rem;padding:.75rem 1.25rem;border-bottom:1px solid var(--border);font-size:13px;color:var(--muted);line-height:1.6"><span style="font-family:'DM Mono',monospace;font-size:11px;color:var(--cyan);min-width:16px;padding-top:2px;flex-shrink:0">${i+1}</span><span>${p}</span></div>`).join('')}</div>`;
  } catch(e) {
    container.innerHTML = `<div style="color:var(--danger);font-size:13px;padding:1rem">Could not generate insights: ${e.message}</div>`;
  }
}


/* ==================== MULTI-START COMPARISON ==================== */
function runComparison() {
  const s1 = multiData.s1, s2 = multiData.s2;
  if (!s1||!s2) return;

  const pm1 = buildPitchMap(s1.rows), pm2 = buildPitchMap(s2.rows);
  const t1 = s1.rows.length, t2 = s2.rows.length;
  const name = s1.rows[0].player_name || 'Pitcher';
  const d1 = s1.rows[0].game_date||'Start 1', d2 = s2.rows[0].game_date||'Start 2';

  document.getElementById('multi-name').textContent = name;
  document.getElementById('multi-meta').innerHTML = `<span class="player-meta-item">${d1}</span> <span class="player-meta-item">vs.</span> <span class="player-meta-item">${d2}</span>`;

  // All pitch types across both
  const allPT = [...new Set([...Object.keys(pm1),...Object.keys(pm2)])].sort((a,b)=>(pm1[b]?.count||0)+(pm2[b]?.count||0)-(pm1[a]?.count||0)-(pm2[a]?.count||0));

  // Grouped bar — pitch mix
  destroyChart('multi-mix-chart');
  charts['multi-mix-chart'] = new Chart(document.getElementById('multi-mix-chart'), {
    type: 'bar',
    data: {
      labels: allPT.map(pn),
      datasets: [
        { label: d1, data: allPT.map(pt => t1?+((pm1[pt]?.count||0)/t1*100).toFixed(1):0), backgroundColor: allPT.map(pt=>pc(pt)+'bb'), borderSkipped:false, borderRadius:3 },
        { label: d2, data: allPT.map(pt => t2?+((pm2[pt]?.count||0)/t2*100).toFixed(1):0), backgroundColor: allPT.map(pt=>pc(pt)), borderSkipped:false, borderRadius:3 },
      ]
    },
    options: { responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ display:true, position:'top', labels:{ color:'#72747c', font:{size:11,family:'DM Mono'}, padding:16 } } },
      scales:{
        y:{ beginAtZero:true, ticks:{callback:v=>v+'%',color:'#72747c',font:{size:10}}, grid:{color:'rgba(255,255,255,0.04)'}},
        x:{ticks:{color:'#72747c',font:{size:11}},grid:{display:false}}
      }
    }
  });

  // Metrics grid
  const w1 = s1.rows.filter(r=>r.description?.includes('swinging_strike')).length;
  const w2 = s2.rows.filter(r=>r.description?.includes('swinging_strike')).length;
  const bb1 = s1.rows.filter(r=>r.events==='walk').length;
  const bb2 = s2.rows.filter(r=>r.events==='walk').length;
  const k1  = s1.rows.filter(r=>r.events==='strikeout').length;
  const k2  = s2.rows.filter(r=>r.events==='strikeout').length;
  const ff1 = pm1['FF']||pm1['FA']; const ff2 = pm2['FF']||pm2['FA'];
  const av1 = ff1?.velos.length ? avg(ff1.velos).toFixed(1) : '—';
  const av2 = ff2?.velos.length ? avg(ff2.velos).toFixed(1) : '—';

  document.getElementById('multi-metrics-grid').innerHTML = [
    { lbl:'Pitches',       v1:t1,                     v2:t2 },
    { lbl:'4S avg velo',   v1:av1+' mph',             v2:av2+' mph' },
    { lbl:'Whiff rate',    v1:(w1/t1*100).toFixed(1)+'%', v2:(w2/t2*100).toFixed(1)+'%' },
    { lbl:'Walks',         v1:bb1,                    v2:bb2 },
    { lbl:'Strikeouts',    v1:k1,                     v2:k2 },
  ].map(m => `<div class="chart-card" style="display:flex;align-items:center;justify-content:space-between;padding:1rem 1.5rem">
    <div>
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin-bottom:6px;font-family:'Barlow Condensed',sans-serif">${m.lbl}</div>
      <div style="display:flex;gap:2rem">
        <div><div class="kpi-val mono" style="font-size:22px">${m.v1}</div><div class="kpi-lbl">${d1}</div></div>
        <div><div class="kpi-val mono" style="font-size:22px">${m.v2}</div><div class="kpi-lbl">${d2}</div></div>
      </div>
    </div>
  </div>`).join('');

  // Movement comparison scatter
  destroyChart('multi-movement-chart');
  const ds1 = allPT.map(pt => ({
    label:`${pn(pt)} (${d1})`,
    data: s1.rows.filter(r=>r._pt===pt&&r.pfx_x&&r.pfx_z).map(r=>({x:-pf(r.pfx_x)*12,y:pf(r.pfx_z)*12})),
    backgroundColor: pc(pt)+'99', pointRadius:4, pointStyle:'circle',
  }));
  const ds2 = allPT.map(pt => ({
    label:`${pn(pt)} (${d2})`,
    data: s2.rows.filter(r=>r._pt===pt&&r.pfx_x&&r.pfx_z).map(r=>({x:-pf(r.pfx_x)*12,y:pf(r.pfx_z)*12})),
    backgroundColor: pc(pt), pointRadius:4, pointStyle:'triangle',
  }));
  charts['multi-movement-chart'] = new Chart(document.getElementById('multi-movement-chart'), {
    type:'scatter',
    data:{ datasets:[...ds1,...ds2] },
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ display:true, position:'right', labels:{ color:'#72747c', font:{size:10,family:'DM Mono'}, padding:8 } } },
      scales:{
        x:{ position:'center', title:{display:false}, ticks:{color:'#72747c',font:{size:10},stepSize:5}, grid:{color:'rgba(255,255,255,0.06)'}, min:-25, max:25 },
        y:{ position:'center', title:{display:false}, ticks:{color:'#72747c',font:{size:10},stepSize:5}, grid:{color:'rgba(255,255,255,0.06)'}, min:-20, max:25 }
      }
    }
  });

  // Trend insights
  const trendInsights = [];
  allPT.forEach(pt => {
    const u1 = pm1[pt]?.count ? pm1[pt].count/t1*100 : 0;
    const u2 = pm2[pt]?.count ? pm2[pt].count/t2*100 : 0;
    const delta = u2-u1;
    if (Math.abs(delta) >= 8) {
      const dir = delta > 0 ? 'increased' : 'decreased';
      const type = delta > 0 && (pt==='ST'||pt==='CU'||pt==='FC') ? 'good' : delta > 0 && (pt==='FF'||pt==='FA') ? 'warn' : 'neutral';
      trendInsights.push({ type, title:`${pn(pt)} usage ${dir} ${Math.abs(delta).toFixed(0)}pp`, body:`${d1}: ${u1.toFixed(0)}% → ${d2}: ${u2.toFixed(0)}%. ${delta<0&&(pt==='FF'||pt==='FA')?'Fastball dependency trending down — positive direction.':delta>0&&(pt==='ST')?'Sweeper usage increasing — keep this trend going.':'Monitor whether this shift correlates with better outcomes.'}` });
    }
  });
  if (bb2 < bb1) trendInsights.push({ type:'good', title:'Walk rate improved', body:`${bb1} walks in ${d1} → ${bb2} in ${d2}. Improved command or better trust in secondaries in full counts.` });
  if (bb2 > bb1) trendInsights.push({ type:'warn', title:'Walk rate increased', body:`${bb1} walks in ${d1} → ${bb2} in ${d2}. Review full-count sequencing — fastball in 3-2 is likely the cause.` });

  document.getElementById('multi-insights').innerHTML = trendInsights.slice(0,6).map(i =>
    `<div class="insight-card ${i.type||''}">
      <div class="insight-title">${i.title}</div>
      <div class="insight-body">${i.body}</div>
    </div>`).join('') || '<div class="empty-state">No significant trends detected between these two starts.</div>';

  document.getElementById('upload-multi').style.display = 'none';
  document.getElementById('report-multi').style.display = '';
}
