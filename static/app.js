var allFiles = [];
var selected = {};

function cleanName(name) {
  name = name.replace(/\.[^.]+$/, '');
  name = name.replace(/[\.\-_]/g, ' ');
  name = name.replace(/(?:1080p|720p|2160p|4k|bluray|brrip|webrip|web dl|x264|x265|hevc|aac|ac3|dts|remux|repack|proper|eztv|rarbg|yts|yify|\[.*?\]|\(.*?\))/gi, '');
  name = name.replace(/\b[sS]\d{2}[eE]\d{2}\b/, '');
  return name.replace(/\s+/g, ' ').trim();
}

function getPoster(name, fid) {
  var key = 'poster_' + fid;
  var cached = sessionStorage.getItem(key);
  if (cached !== null) {
    if (cached) {
      var img = document.getElementById('thumb-' + fid);
      if (img) img.src = cached;
    }
    return;
  }
  var q = cleanName(name);
  fetch('/api/poster?q=' + encodeURIComponent(q))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      sessionStorage.setItem(key, data.poster || '');
      if (data.poster) {
        var img = document.getElementById('thumb-' + fid);
        if (img) img.src = data.poster;
      }
    })
    .catch(function() { sessionStorage.setItem(key, ''); });
}

if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

function showToast(message, type) {
  var container = document.getElementById('toasts');
  if (!container) return;
  var t = document.createElement('div');
  t.className = 'toast toast-' + (type || 'info');
  t.textContent = message;
  container.appendChild(t);
  requestAnimationFrame(function() {
    requestAnimationFrame(function() { t.classList.add('show'); });
  });
  setTimeout(function() {
    t.classList.remove('show');
    setTimeout(function() { if (t.parentNode) t.parentNode.removeChild(t); }, 250);
  }, 4500);
}

function playBeep(isError) {
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = isError ? 300 : 880;
    gain.gain.value = 0.3;
    osc.start();
    osc.stop(ctx.currentTime + (isError ? 0.3 : 0.15));
    if (!isError) {
      setTimeout(function() {
        var osc2 = ctx.createOscillator();
        var gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.frequency.value = 1100;
        gain2.gain.value = 0.3;
        osc2.start();
        osc2.stop(ctx.currentTime + 0.15);
      }, 150);
    }
  } catch(e) {}
}

function notify(title, body, isError) {
  showToast(title + (body ? ': ' + body : ''), isError ? 'err' : 'ok');
  playBeep(isError);
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body: body });
  }
}

var _scanIv = null;

function doScan() {
  document.getElementById('scan-btn').disabled = true;
  document.getElementById('scan-status').textContent = 'Iniciando...';
  document.getElementById('grid').innerHTML = '<div class="loading">Escaneando librería...</div>';
  selected = {};
  updateSelectionBar();
  if (_scanIv) { clearInterval(_scanIv); _scanIv = null; }
  var bar = document.getElementById('scan-bar');
  var fill = document.getElementById('scan-bar-fill');
  if (bar) bar.classList.add('active');
  if (fill) { fill.style.animation = ''; fill.style.marginLeft = ''; fill.style.width = ''; }

  fetch('/api/scan', {method: 'POST'})
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) {
        if (bar) bar.classList.remove('active');
        document.getElementById('scan-status').textContent = data.error;
        document.getElementById('scan-btn').disabled = false;
        showToast('Error: ' + data.error, 'err');
        return;
      }
      _scanIv = setInterval(function() {
        fetch('/api/scan_status')
          .then(function(r) { return r.json(); })
          .then(function(s) {
            if (s.total > 0) {
              var pct = Math.min(99, Math.round(s.current / s.total * 100));
              document.getElementById('scan-status').textContent = s.current + ' / ' + s.total;
              if (fill) { fill.style.animation = 'none'; fill.style.marginLeft = '0'; fill.style.width = pct + '%'; }
            }
            if (s.done) {
              clearInterval(_scanIv); _scanIv = null;
              if (fill) fill.style.width = '100%';
              setTimeout(function() { if (bar) bar.classList.remove('active'); if (fill) fill.style.width = ''; }, 800);
              if (s.error) {
                document.getElementById('scan-status').textContent = 'Error';
                document.getElementById('grid').innerHTML = '<div class="loading" style="color:#8a3a3a">Error: ' + s.error + '</div>';
                document.getElementById('scan-btn').disabled = false;
                showToast('Error al escanear: ' + s.error, 'err');
                return;
              }
              allFiles = s.files || [];
              doFilter();
              updateStats();
              document.getElementById('scan-status').textContent = allFiles.length + ' archivos';
              document.getElementById('scan-btn').disabled = false;
              showToast('Scan completado — ' + allFiles.length + ' archivos', 'ok');
            }
          });
      }, 500);
    })
    .catch(function(e) {
      if (bar) bar.classList.remove('active');
      document.getElementById('grid').innerHTML = '<div class="loading" style="color:#8a3a3a">Error: ' + e + '</div>';
      document.getElementById('scan-btn').disabled = false;
      showToast('Error al escanear: ' + e, 'err');
    });
}

function updateStats() {
  var ok = allFiles.filter(function(f) { return f.status === 'ok'; }).length;
  var noAac = allFiles.filter(function(f) { return f.status === 'no-aac'; }).length;
  var fix = allFiles.filter(function(f) { return f.status === 'needs-fix'; }).length;
  var skip = allFiles.filter(function(f) { return f.status === '4k'; }).length;
  document.getElementById('b-total').textContent = allFiles.length + ' files';
  document.getElementById('b-issues').textContent = (noAac + fix) + ' issues';
  document.getElementById('stats').innerHTML =
    '<div class="stat"><span style="color:#4a8a4a">' + ok + '</span> OK</div>' +
    '<div class="stat"><span style="color:#8a6a3a">' + fix + '</span> AAC not default</div>' +
    '<div class="stat"><span style="color:#8a3a3a">' + noAac + '</span> missing AAC 2.0</div>' +
    '<div class="stat"><span style="color:#333">' + skip + '</span> 4K skipped</div>';
}

function doFilter() {
  var search = document.getElementById('search').value.toLowerCase();
  var type = document.getElementById('ftype').value;
  var filtered = allFiles.filter(function(f) {
    var ms = f.name.toLowerCase().indexOf(search) >= 0 || f.path.toLowerCase().indexOf(search) >= 0;
    var mt = type === 'all' || f.status === type;
    return ms && mt;
  });
  renderFiles(filtered);
}

function sbadge(s) {
  if (s === 'ok') return '<span class="tbadge tok">AAC default OK</span>';
  if (s === 'needs-fix') return '<span class="tbadge twarn">AAC not default</span>';
  if (s === 'no-aac') return '<span class="tbadge terr">No AAC 2.0</span>';
  return '<span class="tbadge tskip">4K skip</span>';
}

function toggleSelect(fid, ev) {
  ev.stopPropagation();
  if (selected[fid]) {
    delete selected[fid];
  } else {
    selected[fid] = true;
  }
  var cb = document.getElementById('cb-' + fid);
  if (cb) cb.checked = !!selected[fid];
  var row = document.getElementById('row-' + fid);
  if (row) row.classList.toggle('selected', !!selected[fid]);
  updateSelectionBar();
}

function updateSelectionBar() {
  var count = Object.keys(selected).length;
  var bar = document.getElementById('sel-bar');
  if (count > 0) {
    bar.style.display = 'flex';
    document.getElementById('sel-count').textContent = count + ' selected';
  } else {
    bar.style.display = 'none';
  }
}

function normalizeSelected() {
  var ids = Object.keys(selected);
  if (!ids.length) return;
  if (!confirm('Normalize ' + ids.length + ' selected files?')) return;
  var total = ids.length;
  if (total > 1) showToast('Cola iniciada: ' + total + ' archivos', 'info');
  var i = 0;
  function next() {
    if (i >= ids.length) {
      if (total > 1) showToast('Cola completada: ' + total + ' archivos procesados', 'ok');
      return;
    }
    var currentId = ids[i++];
    doNormalize(currentId, next, true);
  }
  next();
}

function clearSelection() {
  selected = {};
  document.querySelectorAll('.file-row.selected').forEach(function(r) { r.classList.remove('selected'); });
  document.querySelectorAll('.cb').forEach(function(c) { c.checked = false; });
  updateSelectionBar();
}

function renderFiles(files) {
  var grid = document.getElementById('grid');
  if (!files.length) { grid.innerHTML = '<div class="loading">No files match</div>'; return; }
  var html = '';
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var defaultCount = f.tracks.filter(function(t) { return t.is_default; }).length;
    var tracks = '';
    for (var j = 0; j < f.tracks.length; j++) {
      var t = f.tracks[j];
      var showSetDefault = !t.is_default || defaultCount > 1;
      tracks += '<div class="track-item">' +
        '<span class="ti">' + t.index + '</span>' +
        '<span class="tc">' + t.codec + '</span>' +
        '<span class="tch">' + t.channels + 'ch</span>' +
        '<span class="tl">' + t.lang + '</span>' +
        '<span class="tt">' + (t.title || '—') + '</span>' +
        (showSetDefault
          ? '<button class="btn btn-sm" style="font-size:10px;padding:2px 6px" onclick="event.stopPropagation();setDefault(\'' + f.id + '\',' + t.index + ')">Set default</button>'
          : '<span class="tdef">DEFAULT</span>') +
        '<button class="btn btn-sm" style="font-size:10px;padding:2px 5px;color:#7a3a3a;border-color:#2a1414" onclick="event.stopPropagation();deleteTrack(\'' + f.id + '\',' + t.index + ')" title="Eliminar pista">✕</button>' +
        '</div>';
    }
    var normBtn = f.status !== '4k'
      ? '<button class="btn btn-sm ' + (f.status !== 'ok' ? 'btn-green' : '') + '" onclick="event.stopPropagation();doNormalize(\'' + f.id + '\')">Normalize</button>'
      : '';
    var isSelected = !!selected[f.id];
    html += '<div class="file-row' + (isSelected ? ' selected' : '') + '" id="row-' + f.id + '">' +
      '<div class="file-header" onclick="togglePanel(\'' + f.id + '\')">' +
        '<input type="checkbox" class="cb" id="cb-' + f.id + '" ' + (isSelected ? 'checked' : '') +
          ' onclick="toggleSelect(\'' + f.id + '\', event)" style="margin-right:4px;cursor:pointer">' +
        '<img id="thumb-' + f.id + '" class="thumb" src="" alt="">' +
        '<div style="flex:1;min-width:0">' +
          '<div class="file-name">' + f.name + '</div>' +
          '<div class="file-path">' + f.path + '</div>' +
        '</div>' +
        sbadge(f.status) +
        '<div class="progress-wrap" id="prog-' + f.id + '" style="display:none;min-width:120px">' +
          '<div class="progress-bar"><div class="progress-fill" id="pfill-' + f.id + '"></div></div>' +
          '<span class="prog-text" id="ptext-' + f.id + '">0%</span>' +
        '</div>' +
      '</div>' +
      '<div class="panel" id="panel-' + f.id + '">' +
        '<div class="track-list">' + tracks + '</div>' +
        '<div class="actions">' +
          (f.status !== '4k' ? '<button class="btn btn-sm btn-green" onclick="doNormalize(\'' + f.id + '\')">Normalize (AAC 2.0 first)</button>' : '') +
          '<button class="btn btn-sm" onclick="doRefresh(\'' + f.id + '\')">Refresh</button>' +
        '</div>' +
        '<div class="log" id="log-' + f.id + '"></div>' +
      '</div>' +
    '</div>';
  }
  grid.innerHTML = html;
  for (var k = 0; k < files.length; k++) {
    getPoster(files[k].name, files[k].id);
  }
}

function togglePanel(id) {
  var p = document.getElementById('panel-' + id);
  if (p) p.classList.toggle('open');
}


function setDefault(fid, trackIdx) {
  var f = null;
  for (var i = 0; i < allFiles.length; i++) {
    if (allFiles[i].id === fid) { f = allFiles[i]; break; }
  }
  if (!f) return;
  var name = f.name;
  if (!confirm('Set track ' + trackIdx + ' as default audio for:\n' + name)) return;

  var log = document.getElementById('log-' + fid);
  if (log) { log.className = 'log open'; log.textContent = 'Setting default track ' + trackIdx + '...'; }
  var panel = document.getElementById('panel-' + fid);
  if (panel) panel.classList.add('open');

  fetch('/api/set_default', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({file_id: fid, track_index: trackIdx})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (log) {
      if (data.ok) {
        log.innerHTML = '<span class="lok">Default set to track ' + trackIdx + ' - OK</span>';
        notify('Default track set', name, false);
        doRefresh(fid);
      } else {
        log.innerHTML = '<span class="lerr">ERROR: ' + (data.error || 'unknown') + '</span>';
        notify('Set default FAILED', name, true);
      }
    }
  })
  .catch(function(e) {
    if (log) log.innerHTML = '<span class="lerr">ERROR: ' + e + '</span>';
  });
}

function cancelJob(jid) {
  fetch('/api/cancel/' + jid, {method: 'POST'})
    .then(function(r) { return r.json(); })
    .then(function(d) { showToast(d.ok ? 'Job cancelado' : ('No se pudo cancelar: ' + (d.error || '')), d.ok ? 'info' : 'err'); })
    .catch(function(e) { showToast('Error: ' + e, 'err'); });
}

function _pollJob(jid, progWrap, pfill, ptext, log, startTime, onDone) {
  var lastPct = 0;

  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-sm';
  cancelBtn.style.cssText = 'font-size:10px;padding:2px 5px;color:#7a3a3a;border-color:#2a1414;flex-shrink:0;margin-left:2px';
  cancelBtn.title = 'Cancelar';
  cancelBtn.textContent = '✕';
  cancelBtn.onclick = function() { cancelBtn.disabled = true; cancelJob(jid); };
  if (progWrap) progWrap.appendChild(cancelBtn);

  var iv = setInterval(function() {
    fetch('/api/job/' + jid)
      .then(function(r) { return r.json(); })
      .then(function(s) {
        var pct = 0, eta = '';
        for (var i = 0; i < s.log.length; i++) {
          var l = s.log[i];
          var speedMatch = l.match(/speed=\s*([\d.]+)x/);
          var timeMatch = l.match(/time=(\d+):(\d+):([\d.]+)/);
          if (timeMatch && s.total_duration) {
            var secs = parseInt(timeMatch[1])*3600 + parseInt(timeMatch[2])*60 + parseFloat(timeMatch[3]);
            pct = Math.min(99, Math.round(secs / s.total_duration * 100));
            if (speedMatch) {
              var rem = (s.total_duration - secs) / parseFloat(speedMatch[1]);
              eta = ' ~' + Math.round(rem) + 's';
            }
          }
        }
        if (pct === 0 && s.log.length > 2) {
          pct = Math.min(90, Math.round((Date.now() - startTime) / 1000 / 3 * 5));
        }
        if (pct > lastPct) lastPct = pct;
        if (pfill) pfill.style.width = lastPct + '%';
        if (ptext) ptext.textContent = lastPct + '%' + eta;

        var filtered = [];
        for (var i = 0; i < s.log.length; i++) {
          if (!s.log[i].match(/^frame=|^video:|^\[/)) filtered.push(s.log[i]);
        }
        var visible = filtered.slice(-12);
        var html = '';
        for (var i = 0; i < visible.length; i++) {
          var l = visible[i];
          var cls = l.indexOf('OK') >= 0 ? 'lok' : l.indexOf('ERROR') >= 0 ? 'lerr' : '';
          html += '<span' + (cls ? ' class="' + cls + '"' : '') + '>' + l + '</span>\n';
        }
        if (html) { log.innerHTML = html; log.scrollTop = log.scrollHeight; }

        if (s.done) {
          clearInterval(iv);
          if (cancelBtn && cancelBtn.parentNode) cancelBtn.parentNode.removeChild(cancelBtn);
          var ok = s.log.some(function(l) { return l.indexOf('OK') >= 0; });
          if (ok) {
            if (pfill) pfill.style.width = '100%';
            if (ptext) ptext.textContent = '100%';
          } else {
            if (pfill) { pfill.style.width = '100%'; pfill.style.background = '#5a1a1a'; }
            if (ptext) { ptext.textContent = 'Error'; ptext.style.color = '#8a3a3a'; }
          }
          if (onDone) onDone(ok);
        }
      });
  }, 800);
}

function doNormalize(fid, onDone, forceAuto) {
  if (forceAuto) { _startNormalize(fid, null, onDone); return; }

  var f = null;
  for (var i = 0; i < allFiles.length; i++) {
    if (allFiles[i].id === fid) { f = allFiles[i]; break; }
  }
  var surrounds = f ? f.tracks.filter(function(t) { return t.channels >= 6; }) : [];

  if (surrounds.length <= 1) { _startNormalize(fid, null, onDone); return; }

  var log = document.getElementById('log-' + fid);
  var panel = document.getElementById('panel-' + fid);
  if (!log) return;
  if (panel) panel.classList.add('open');
  log.className = 'log open';

  var html = '<div style="color:#888;margin-bottom:6px;font-size:11px">Elige pistas a convertir a AAC 2.0:</div>';
  for (var i = 0; i < surrounds.length; i++) {
    var t = surrounds[i];
    var label = t.codec + ' · ' + t.channels + 'ch · ' + t.lang + (t.title ? ' · ' + t.title : '');
    html += '<label style="display:flex;align-items:center;gap:6px;margin-bottom:4px;cursor:pointer;font-size:11px">' +
      '<input type="checkbox" checked data-idx="' + t.index + '" style="accent-color:#4a6a9a">' +
      '<span style="color:#ccc">' + label + '</span></label>';
  }
  html += '<div style="display:flex;gap:6px;margin-top:8px">' +
    '<button class="btn btn-sm btn-green" id="npick-ok-' + fid + '">Normalizar</button>' +
    '<button class="btn btn-sm" id="npick-cancel-' + fid + '">Cancelar</button></div>';
  log.innerHTML = html;

  document.getElementById('npick-cancel-' + fid).onclick = function() {
    log.className = 'log'; log.innerHTML = '';
    if (onDone) onDone();
  };
  document.getElementById('npick-ok-' + fid).onclick = function() {
    var cbs = log.querySelectorAll('input[data-idx]');
    var sel = [];
    for (var i = 0; i < cbs.length; i++) {
      if (cbs[i].checked) sel.push(parseInt(cbs[i].getAttribute('data-idx')));
    }
    if (!sel.length) { showToast('Selecciona al menos un idioma', 'err'); return; }
    _startNormalize(fid, sel, onDone);
  };
}

function _startNormalize(fid, surroundIndices, onDone) {
  var log = document.getElementById('log-' + fid);
  if (!log) return;
  log.className = 'log open';
  log.textContent = 'Starting...';
  var panel = document.getElementById('panel-' + fid);
  if (panel) panel.classList.add('open');

  var progWrap = document.getElementById('prog-' + fid);
  var pfill = document.getElementById('pfill-' + fid);
  var ptext = document.getElementById('ptext-' + fid);
  if (progWrap) progWrap.style.display = 'flex';
  if (pfill) { pfill.style.width = '0%'; pfill.style.background = '#2a6a2a'; }
  if (ptext) { ptext.textContent = '0%'; ptext.style.color = ''; }

  fetch('/api/normalize', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({file_id: fid, surround_indices: surroundIndices})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.error) {
      if (log) log.innerHTML = '<span class="lerr">' + data.error + '</span>';
      showToast(data.error, 'err');
      if (progWrap) progWrap.style.display = 'none';
      if (onDone) onDone();
      return;
    }
    _pollJob(data.job_id, progWrap, pfill, ptext, log, Date.now(), function(ok) {
      var fname = (allFiles.find ? (allFiles.find(function(x) { return x.id === fid; }) || {}) : {}).name;
      notify(ok ? 'Normalize completo' : 'Normalize FAILED', fname || fid, !ok);
      doRefresh(fid);
      setTimeout(function() {
        if (progWrap) progWrap.style.display = 'none';
        if (onDone) onDone();
      }, 3000);
    });
  });
}

function deleteTrack(fid, trackIdx) {
  if (!confirm('¿Eliminar pista ' + trackIdx + '? El archivo será remuxeado.')) return;
  var log = document.getElementById('log-' + fid);
  var panel = document.getElementById('panel-' + fid);
  if (!log) return;
  if (panel) panel.classList.add('open');
  log.className = 'log open';
  log.textContent = 'Iniciando remux...';

  var progWrap = document.getElementById('prog-' + fid);
  var pfill = document.getElementById('pfill-' + fid);
  var ptext = document.getElementById('ptext-' + fid);
  if (progWrap) progWrap.style.display = 'flex';
  if (pfill) { pfill.style.width = '0%'; pfill.style.background = '#2a6a2a'; }
  if (ptext) { ptext.textContent = '0%'; ptext.style.color = ''; }

  fetch('/api/delete_track', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({file_id: fid, track_index: trackIdx})
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (!data.job_id) {
      log.innerHTML = '<span class="lerr">ERROR: ' + (data.error || 'unknown') + '</span>';
      notify('Error al eliminar pista', data.error || '', true);
      if (progWrap) progWrap.style.display = 'none';
      return;
    }
    _pollJob(data.job_id, progWrap, pfill, ptext, log, Date.now(), function(ok) {
      notify(ok ? 'Pista ' + trackIdx + ' eliminada' : 'Error al eliminar pista', '', !ok);
      if (ok) doRefresh(fid);
      setTimeout(function() { if (progWrap) progWrap.style.display = 'none'; }, 3000);
    });
  })
  .catch(function(e) {
    log.innerHTML = '<span class="lerr">ERROR: ' + e + '</span>';
    notify('Error al eliminar pista', String(e), true);
    if (progWrap) progWrap.style.display = 'none';
  });
}

function doRefresh(fid) {
  fetch('/api/file/' + fid)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      for (var i = 0; i < allFiles.length; i++) {
        if (allFiles[i].id === fid) { allFiles[i] = data; break; }
      }
      updateStats();
      doFilter();
      setTimeout(function() {
        var p = document.getElementById('panel-' + fid);
        if (p) p.classList.add('open');
      }, 60);
    });
}

var _cpuHistory = [];

function _drawCpu(pct, activeJobs, cores) {
  var color = pct < 50 ? '#4a8a4a' : pct < 80 ? '#9a7a3a' : '#8a3a3a';
  var fillRgba = pct < 50 ? 'rgba(74,138,74,0.1)' : pct < 80 ? 'rgba(154,122,58,0.1)' : 'rgba(138,58,58,0.1)';
  var el = document.getElementById('cpu-pct');
  if (el) { el.textContent = Math.round(pct) + '%'; el.style.color = color; }
  var jel = document.getElementById('cpu-jobs');
  if (jel) jel.textContent = activeJobs + (activeJobs === 1 ? ' job' : ' jobs');
  var cel = document.getElementById('cpu-cores');
  if (cel && cores) cel.textContent = cores + ' cores';

  var canvas = document.getElementById('cpu-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  var step = w / 59;

  // Guide lines at 50% and 80%
  ctx.lineWidth = 1;
  [0.5, 0.8].forEach(function(lvl) {
    var y = Math.round(h - lvl * h) + 0.5;
    ctx.strokeStyle = '#181818';
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  });

  if (_cpuHistory.length < 2) return;

  var startIdx = 60 - _cpuHistory.length;

  // Filled area
  ctx.beginPath();
  for (var i = 0; i < _cpuHistory.length; i++) {
    var x = (startIdx + i) * step;
    var y = h - (_cpuHistory[i] / 100) * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.lineTo((startIdx + _cpuHistory.length - 1) * step, h);
  ctx.lineTo(startIdx * step, h);
  ctx.closePath();
  ctx.fillStyle = fillRgba;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  for (var i = 0; i < _cpuHistory.length; i++) {
    var x = (startIdx + i) * step;
    var y = h - (_cpuHistory[i] / 100) * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

(function startCpuMonitor() {
  setInterval(function() {
    fetch('/api/sysinfo')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        _cpuHistory.push(d.cpu);
        if (_cpuHistory.length > 60) _cpuHistory.shift();
        _drawCpu(d.cpu, d.active_jobs, d.cores);
      })
      .catch(function() {});
  }, 1000);
})();

function doNormalizeAll() {
  var toFix = allFiles.filter(function(f) { return f.status === 'no-aac' || f.status === 'needs-fix'; });
  if (!toFix.length) { alert('Nothing to fix!'); return; }
  if (!confirm('Normalize ' + toFix.length + ' files?')) return;
  var total = toFix.length;
  showToast('Cola iniciada: ' + total + ' archivos', 'info');
  var i = 0;
  function next() {
    if (i >= toFix.length) {
      showToast('Cola completada: ' + total + ' archivos procesados', 'ok');
      return;
    }
    var currentId = toFix[i++].id;
    doNormalize(currentId, next, true);
  }
  next();
}
