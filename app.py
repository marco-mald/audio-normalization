#!/usr/bin/env python3
from flask import Flask, jsonify, request, send_from_directory
import subprocess, json, os, glob, threading, time, urllib.request, urllib.parse, re

app = Flask(__name__, static_folder='static')

MEDIA_DIR = "/mnt/ADATA"
TMDB_API_KEY = os.environ.get('TMDB_API_KEY', '')
FFPROBE = "/usr/lib/jellyfin-ffmpeg/ffprobe"
FFMPEG = "/usr/lib/jellyfin-ffmpeg/ffmpeg"

jobs = {}
library_cache = []
cache_lock = threading.Lock()
active_paths = set()
active_paths_lock = threading.Lock()
scan_status = {'running': False, 'done': False, 'current': 0, 'total': 0, 'last_file': '', 'error': None}
_cpu_state = {'prev': None}
_cpu_lock = threading.Lock()

def get_file_info(filepath):
    try:
        r = subprocess.run([FFPROBE, '-v', 'quiet', '-print_format', 'json', '-show_streams', filepath],
            capture_output=True, text=True, timeout=30)
        data = json.loads(r.stdout)
        streams = data.get('streams', [])
        audio = []
        height = 0
        for s in streams:
            if s.get('codec_type') == 'video' and not height:
                height = s.get('height', 0)
            if s.get('codec_type') == 'audio':
                audio.append({
                    'index': s.get('index'),
                    'codec': s.get('codec_name', ''),
                    'channels': s.get('channels', 0),
                    'lang': s.get('tags', {}).get('language', 'und'),
                    'title': s.get('tags', {}).get('title', ''),
                    'is_default': bool(s.get('disposition', {}).get('default', 0))
                })
        return audio, height
    except:
        return [], 0

def classify(tracks, height):
    if height >= 1440: return '4k'
    if not tracks: return 'error'
    defaults = [t for t in tracks if t['is_default']]
    if not defaults:
        defaults = tracks[:1]
    if any(t['codec'] == 'aac' and t['channels'] <= 2 for t in defaults):
        return 'ok'
    if any(t['codec'] == 'aac' and t['channels'] <= 2 for t in tracks):
        return 'needs-fix'
    return 'no-aac'

def scan_library_async():
    global library_cache
    scan_status.update({'running': True, 'done': False, 'current': 0, 'total': 0, 'last_file': '', 'error': None})
    try:
        all_paths = []
        for ext in ['*.mkv', '*.mp4']:
            all_paths.extend(sorted(glob.glob(os.path.join(MEDIA_DIR, '**', ext), recursive=True)))
        all_paths = [p for p in all_paths if not p.endswith('.tmp.mkv') and not p.endswith('.deltmp.mkv')]
        scan_status['total'] = len(all_paths)
        results = []
        for i, fp in enumerate(all_paths):
            scan_status['current'] = i
            scan_status['last_file'] = os.path.basename(fp)
            tracks, height = get_file_info(fp)
            results.append({
                'id': str(i),
                'name': os.path.basename(fp),
                'path': os.path.dirname(fp).replace(MEDIA_DIR, ''),
                'filepath': fp,
                'tracks': tracks,
                'status': classify(tracks, height)
            })
        scan_status['current'] = len(all_paths)
        with cache_lock:
            library_cache = results
    except Exception as e:
        scan_status['error'] = str(e)
    finally:
        scan_status['running'] = False
        scan_status['done'] = True

def cleanup_old_jobs():
    cutoff = time.time() - 600
    for k in list(jobs.keys()):
        if jobs[k].get('done') and jobs[k].get('completed_at', 0) < cutoff:
            del jobs[k]

def normalize_file(filepath, tracks, job_id, surround_indices=None):
    log = jobs[job_id]['log']
    try:
        name = os.path.basename(filepath)
        ext = os.path.splitext(filepath)[1].lower()
        output = os.path.splitext(filepath)[0] + '.mkv'
        temp = output + '.tmp.mkv'

        r = subprocess.run([FFPROBE, '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', filepath],
            capture_output=True, text=True, timeout=30)
        try:
            jobs[job_id]['total_duration'] = float(r.stdout.strip())
        except:
            jobs[job_id]['total_duration'] = 0

        log.append('Processing: ' + name)
        if surround_indices is not None:
            surrounds = [t for t in tracks if t['index'] in surround_indices] or tracks[:1]
        else:
            surrounds = [t for t in tracks if t['channels'] >= 6] or tracks[:1]
        cmd = [FFMPEG, '-i', filepath, '-map', '0:v', '-c:v', 'copy']
        for i, surr in enumerate(surrounds):
            ai = str(i)
            cmd += ['-map', '0:' + str(surr['index']),
                    '-c:a:' + ai, 'aac', '-ac:a:' + ai, '2', '-b:a:' + ai, '192k',
                    '-disposition:a:' + ai, 'default' if i == 0 else '0']
            lang = surr.get('lang', 'und')
            if lang and lang != 'und':
                cmd += ['-metadata:s:a:' + ai, 'language=' + lang,
                        '-metadata:s:a:' + ai, 'title=AAC 2.0 ' + lang.upper()]
        n_aac = len(surrounds)
        for i, t in enumerate(tracks):
            ai = str(n_aac + i)
            cmd += ['-map', '0:' + str(t['index']), '-c:a:' + ai, 'copy', '-disposition:a:' + ai, '0']
        cmd += ['-sn', '-metadata', 'title=' + os.path.splitext(name)[0], temp, '-y']
        log.append('Running ffmpeg...')

        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, bufsize=0)
        jobs[job_id]['proc'] = proc
        buf = b''
        while True:
            chunk = proc.stderr.read(512)
            if not chunk:
                break
            buf += chunk
            parts = buf.replace(b'\r', b'\n').split(b'\n')
            buf = parts[-1]
            for part in parts[:-1]:
                line = part.decode('utf-8', errors='replace').strip()
                if line:
                    log.append(line)
                    if len(log) > 40:
                        del log[2]
        proc.wait()

        if proc.returncode not in (0, -15):
            log.append('ERROR: ffmpeg rc=' + str(proc.returncode))
            if os.path.exists(temp): os.remove(temp)
        elif proc.returncode == -15:
            if os.path.exists(temp): os.remove(temp)
        elif not os.path.exists(temp) or os.path.getsize(temp) < 1024*1024:
            log.append('ERROR: output invalid')
            if os.path.exists(temp): os.remove(temp)
        else:
            os.rename(temp, output)
            if ext == '.mp4' and output != filepath:
                os.remove(filepath)
                log.append('OK: Converted to MKV')
            else:
                log.append('OK: Updated ' + name)
    except Exception as e:
        log.append('ERROR: ' + str(e))
    finally:
        jobs[job_id]['done'] = True
        jobs[job_id]['completed_at'] = time.time()
        with active_paths_lock:
            active_paths.discard(filepath)

@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

@app.route('/api/scan', methods=['POST'])
def api_scan():
    if scan_status['running']:
        return jsonify({'error': 'scan already running'})
    threading.Thread(target=scan_library_async, daemon=True).start()
    return jsonify({'ok': True})

@app.route('/api/scan_status')
def api_scan_status():
    status = dict(scan_status)
    if status['done']:
        with cache_lock:
            status['files'] = list(library_cache)
    return jsonify(status)

@app.route('/api/file/<fid>')
def api_file(fid):
    f = next((x for x in library_cache if x['id'] == fid), None)
    if not f: return jsonify({'error': 'not found'}), 404
    t, h = get_file_info(f['filepath'])
    f['tracks'] = t
    f['status'] = classify(t, h)
    return jsonify(f)

@app.route('/api/normalize', methods=['POST'])
def api_normalize():
    data = request.json
    fid = data.get('file_id')
    f = next((x for x in library_cache if x['id'] == fid), None)
    if not f: return jsonify({'error': 'not found'}), 404
    with active_paths_lock:
        if f['filepath'] in active_paths:
            return jsonify({'error': 'already processing this file'}), 409
        active_paths.add(f['filepath'])
    cleanup_old_jobs()
    surround_indices = data.get('surround_indices')
    jid = 'job_' + fid + '_' + str(len(jobs))
    jobs[jid] = {'log': [], 'done': False}
    threading.Thread(target=normalize_file, args=(f['filepath'], f['tracks'], jid),
                     kwargs={'surround_indices': surround_indices}, daemon=True).start()
    return jsonify({'job_id': jid})

@app.route('/api/job/<jid>')
def api_job(jid):
    j = jobs.get(jid, {'log': ['not found'], 'done': True})
    return jsonify({'log': j.get('log', []), 'done': j.get('done', True), 'total_duration': j.get('total_duration', 0)})


@app.route('/api/set_default', methods=['POST'])
def api_set_default():
    data = request.json
    fid = data.get('file_id')
    track_index = data.get('track_index')
    f = next((x for x in library_cache if x['id'] == fid), None)
    if not f:
        return jsonify({'ok': False, 'error': 'file not found'})
    
    filepath = f['filepath']
    ext = os.path.splitext(filepath)[1].lower()
    
    if ext == '.mp4':
        return jsonify({'ok': False, 'error': 'MP4 not supported, normalize first to convert to MKV'})
    
    tracks, _ = get_file_info(filepath)
    cmd = ['mkvpropedit', filepath]
    for i, t in enumerate(tracks):
        track_sel = 'track:a' + str(i + 1)
        if t['index'] == track_index:
            cmd += ['--edit', track_sel, '--set', 'flag-default=1']
        else:
            cmd += ['--edit', track_sel, '--set', 'flag-default=0']
    
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if r.returncode == 0:
            # Refresh cache
            new_tracks, new_height = get_file_info(filepath)
            f['tracks'] = new_tracks
            f['status'] = classify(new_tracks, new_height)
            return jsonify({'ok': True})
        else:
            return jsonify({'ok': False, 'error': r.stderr or r.stdout})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)})

def delete_track_job(filepath, remaining, job_id, fid):
    log = jobs[job_id]['log']
    try:
        r = subprocess.run([FFPROBE, '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', filepath],
            capture_output=True, text=True, timeout=30)
        try:
            jobs[job_id]['total_duration'] = float(r.stdout.strip())
        except:
            jobs[job_id]['total_duration'] = 0

        temp = filepath + '.deltmp.mkv'
        cmd = [FFMPEG, '-i', filepath, '-map', '0:v', '-c:v', 'copy']
        for i, t in enumerate(remaining):
            ai = str(i)
            cmd += ['-map', '0:' + str(t['index']), '-c:a:' + ai, 'copy',
                    '-disposition:a:' + ai, 'default' if t.get('is_default') else '0']
        cmd += ['-sn', temp, '-y']
        log.append('Remuxing...')

        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, bufsize=0)
        jobs[job_id]['proc'] = proc
        buf = b''
        while True:
            chunk = proc.stderr.read(512)
            if not chunk:
                break
            buf += chunk
            parts = buf.replace(b'\r', b'\n').split(b'\n')
            buf = parts[-1]
            for part in parts[:-1]:
                line = part.decode('utf-8', errors='replace').strip()
                if line:
                    log.append(line)
                    if len(log) > 40:
                        del log[2]
        proc.wait()

        if proc.returncode not in (0, -15):
            log.append('ERROR: ffmpeg rc=' + str(proc.returncode))
            if os.path.exists(temp): os.remove(temp)
        elif proc.returncode == -15:
            if os.path.exists(temp): os.remove(temp)
        elif not os.path.exists(temp) or os.path.getsize(temp) < 1024*1024:
            log.append('ERROR: output invalid')
            if os.path.exists(temp): os.remove(temp)
        else:
            os.rename(temp, filepath)
            f = next((x for x in library_cache if x['id'] == fid), None)
            if f:
                new_tracks, new_height = get_file_info(filepath)
                f['tracks'] = new_tracks
                f['status'] = classify(new_tracks, new_height)
            log.append('OK: Track deleted')
    except Exception as e:
        log.append('ERROR: ' + str(e))
    finally:
        jobs[job_id]['done'] = True
        jobs[job_id]['completed_at'] = time.time()
        with active_paths_lock:
            active_paths.discard(filepath)

@app.route('/api/delete_track', methods=['POST'])
def api_delete_track():
    data = request.json
    fid = data.get('file_id')
    track_index = data.get('track_index')
    f = next((x for x in library_cache if x['id'] == fid), None)
    if not f:
        return jsonify({'error': 'file not found'})
    filepath = f['filepath']
    if os.path.splitext(filepath)[1].lower() == '.mp4':
        return jsonify({'error': 'MP4 not supported, normalize first'})
    tracks, _ = get_file_info(filepath)
    remaining = [t for t in tracks if t['index'] != track_index]
    if not remaining:
        return jsonify({'error': 'Cannot delete the only audio track'})
    with active_paths_lock:
        if filepath in active_paths:
            return jsonify({'error': 'already processing this file'}), 409
        active_paths.add(filepath)
    cleanup_old_jobs()
    jid = 'del_' + fid + '_' + str(track_index) + '_' + str(len(jobs))
    jobs[jid] = {'log': [], 'done': False, 'total_duration': 0}
    threading.Thread(target=delete_track_job, args=(filepath, remaining, jid, fid), daemon=True).start()
    return jsonify({'job_id': jid})

@app.route('/api/cancel/<jid>', methods=['POST'])
def api_cancel(jid):
    j = jobs.get(jid)
    if not j:
        return jsonify({'ok': False, 'error': 'not found'})
    proc = j.get('proc')
    if proc and proc.poll() is None:
        proc.terminate()
        j['log'].append('Cancelled')
        return jsonify({'ok': True})
    return jsonify({'ok': False, 'error': 'not running'})

@app.route('/api/sysinfo')
def api_sysinfo():
    cpu_pct = 0
    try:
        with open('/proc/stat') as f:
            parts = f.readline().split()
        vals = [int(x) for x in parts[1:8]]
        idle = vals[3] + vals[4]
        total = sum(vals)
        with _cpu_lock:
            prev = _cpu_state['prev']
            if prev:
                dt = total - prev[0]
                di = idle - prev[1]
                cpu_pct = round((1 - di / dt) * 100, 1) if dt > 0 else 0
            _cpu_state['prev'] = (total, idle)
    except:
        pass
    active = sum(1 for j in jobs.values() if not j.get('done'))
    return jsonify({'cpu': cpu_pct, 'active_jobs': active, 'cores': os.cpu_count() or 1})

def clean_filename(name):
    name = os.path.splitext(name)[0]
    name = re.sub(r'[\.\-_]', ' ', name)
    name = re.sub(r'(?i)(1080p|720p|2160p|4k|bluray|brrip|webrip|web dl|x264|x265|hevc|aac|ac3|dts|remux|repack|proper|eztv|rarbg|yts|yify|\[.*?\]|\(.*?\))', '', name)
    name = re.sub(r'\b[sS]\d{2}[eE]\d{2}\b', '', name)
    name = re.sub(r'\s+', ' ', name).strip()
    return name

poster_cache = {}

@app.route('/api/poster')
def api_poster():
    q = request.args.get('q', '').strip()
    if not q or not TMDB_API_KEY:
        return jsonify({'poster': None})
    if q in poster_cache:
        return jsonify({'poster': poster_cache[q]})
    try:
        url = 'https://api.themoviedb.org/3/search/multi?api_key=' + TMDB_API_KEY + '&query=' + urllib.parse.quote(q) + '&page=1'
        req = urllib.request.Request(url, headers={'User-Agent': 'MediaManager/1.0'})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
        results = data.get('results', [])
        if results:
            poster_path = results[0].get('poster_path')
            if poster_path:
                poster_cache[q] = '/api/img/' + poster_path.lstrip('/')
                return jsonify({'poster': poster_cache[q]})
        poster_cache[q] = None
        return jsonify({'poster': None})
    except:
        return jsonify({'poster': None})

@app.route('/api/img/<path:path>')
def api_img(path):
    try:
        url = 'https://image.tmdb.org/t/p/w185/' + path
        req = urllib.request.Request(url, headers={'User-Agent': 'MediaManager/1.0'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            img_data = resp.read()
            content_type = resp.headers.get('Content-Type', 'image/jpeg')
        from flask import Response
        return Response(img_data, content_type=content_type, headers={'Cache-Control': 'public, max-age=604800'})
    except:
        return '', 404

if __name__ == '__main__':
    print('Media Manager -> http://localhost:5000')
    app.run(host='0.0.0.0', port=5000, debug=False, use_reloader=True)
