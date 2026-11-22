# Lyra sings a song in her own singing voice (Chris, 2026-11-22: her singing voice id for Seed-VC,
# https://github.com/Plachtaa/seed-vc).
#   1. Demucs splits the song into vocals and music
#   2. the vocals are moved by whole octaves if the singer sits far from her range (the key stays the same)
#   3. Seed-VC's 44 kHz singing model (pitch-following) turns the voice into hers, from a sung reference clip
#      made with her singing voice on Fish Audio (lyra_singing_ref.wav)
#   4. her vocals are mixed back over the music
# usage: venv\Scripts\python lyra_sing.py <song> <out.mp3> [--ref ref.wav] [--start S --length L] [--steps 30]
import argparse, os, subprocess, sys, shutil, tempfile, glob, json
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SEEDVC = os.path.join(HERE, 'seed-vc')
PY = sys.executable
FFMPEG = os.environ.get('FFMPEG_PATH') or shutil.which('ffmpeg') or 'ffmpeg'


def run(cmd, cwd=None, what=''):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding='utf-8', errors='replace')
    if r.returncode != 0:
        raise SystemExit(f'{what} failed: {(r.stderr or r.stdout)[-800:]}')
    return r


def median_pitch(path):
    """median sung pitch (Hz) of a voice track, from its voiced frames"""
    import librosa
    y, sr = librosa.load(path, sr=16000, mono=True, duration=120)
    f0 = librosa.yin(y, fmin=70, fmax=1000, sr=sr, frame_length=1024)
    rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=256)[0]
    n = min(len(f0), len(rms))
    f0, rms = f0[:n], rms[:n]
    voiced = f0[(rms > np.percentile(rms, 60)) & (f0 > 70) & (f0 < 1000)]
    return float(np.median(voiced)) if len(voiced) > 20 else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('song')
    ap.add_argument('out')
    ap.add_argument('--ref', default=os.path.join(HERE, 'lyra_singing_ref.wav'))
    ap.add_argument('--start', type=float, default=0)
    ap.add_argument('--length', type=float, default=0)
    ap.add_argument('--steps', type=int, default=30)
    ap.add_argument('--shift', type=int, default=None, help='semitones; default: whole octaves toward her range')
    ap.add_argument('--keep', action='store_true', help='keep the work folder (stems) next to the output')
    a = ap.parse_args()

    work = tempfile.mkdtemp(prefix='lyra-sing-')
    try:
        # the part of the song to sing, as 44.1 kHz stereo wav
        src = os.path.join(work, 'song.wav')
        cut = (['-ss', str(a.start)] if a.start else []) + (['-t', str(a.length)] if a.length else [])
        run([FFMPEG, '-v', 'error', '-y', *cut, '-i', a.song, '-ac', '2', '-ar', '44100', src], what='reading the song')

        # 1. vocals and music
        run([PY, '-m', 'demucs', '--two-stems', 'vocals', '-n', 'htdemucs', '-o', work, src], what='separating the vocals')
        stems = os.path.join(work, 'htdemucs', 'song')
        vocals, music = os.path.join(stems, 'vocals.wav'), os.path.join(stems, 'no_vocals.wav')

        # 2. whole octaves toward her range (keeps the key)
        shift = a.shift
        if shift is None:
            hers, theirs = median_pitch(a.ref), median_pitch(vocals)
            shift = int(12 * round(np.log2(hers / theirs))) if hers and theirs else 0
            shift = max(-12, min(12, shift))
            print(f'pitch: hers {hers and round(hers)} Hz, the singer {theirs and round(theirs)} Hz -> {shift:+d} semitones', flush=True)

        # 3. her voice (Seed-VC 44 kHz singing model, f0-conditioned)
        conv = os.path.join(work, 'converted')
        os.makedirs(conv, exist_ok=True)
        run([PY, 'inference.py', '--source', vocals, '--target', a.ref, '--output', conv,
             '--diffusion-steps', str(a.steps), '--length-adjust', '1.0', '--inference-cfg-rate', '0.7',
             '--f0-condition', 'True', '--auto-f0-adjust', 'False', '--semi-tone-shift', str(shift), '--fp16', 'True'],
            cwd=SEEDVC, what='converting her voice')
        hers = sorted(glob.glob(os.path.join(conv, '*.wav')), key=os.path.getmtime)[-1]

        # 4. her vocals over the music (vocals a touch forward), loudness evened out
        os.makedirs(os.path.dirname(os.path.abspath(a.out)) or '.', exist_ok=True)
        run([FFMPEG, '-v', 'error', '-y', '-i', music, '-i', hers, '-filter_complex',
             '[1:a]aresample=44100,volume=1.15[v];[0:a][v]amix=inputs=2:duration=longest:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[m]',
             '-map', '[m]', '-ar', '44100', '-b:a', '192k', a.out], what='mixing')
        if a.keep:
            keep = os.path.splitext(a.out)[0] + '_stems'
            os.makedirs(keep, exist_ok=True)
            for f, n in ((vocals, 'original_vocals.wav'), (music, 'music.wav'), (hers, 'lyra_vocals.wav')):
                shutil.copy(f, os.path.join(keep, n))
        print(json.dumps({'ok': True, 'out': a.out, 'shift': shift}), flush=True)
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    main()
