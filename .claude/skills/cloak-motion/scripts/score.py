"""Cloak sting score: synthesizes a soft, glassy soundtrack from a list of cues timed to the animation.

    python3 score.py cues.json out.wav

cues.json (every key is optional except duration; times in seconds):
{
  "duration": 13,
  "pad":    [[0, 10.7, "Dmaj9"], [10.3, 2.7, "Gmaj7/B"]],   // start, length, chord (bed under the story, then the lockup)
  "type":   [[0.7, 2.2, "npm install @cloakely/sdk viem"]], // start, end, text: one soft key tick per character
  "enter":  [2.4],                                         // a key press
  "pop":    [[2.55, 880], [2.77, 1108.73]],                // soft glass pops as cards and lines land (time, Hz)
  "whoosh": [[3.7, 0.8]],                                  // airy pass between beats (start, length)
  "riser":  [[7.55, 1.0]],                                 // builds INTO the given time (end, length)
  "click":  [7.55],                                        // a UI click
  "impact": [7.85],                                        // soft sub drop + air + pluck: a stamp, a seal, a reveal landing
  "lockup": [10.35],                                       // reverse swell into the end card, sub, shimmer on the mark
  "chime":  [11.0]                                         // light chime as the tagline lands
}

Built on the same palette as every Cloak sting so far: a Dmaj9 bed that resolves to Gmaj7(#11)/B on the end card,
a short stereo room, gentle soft clip, normalized to -1 dBFS.
"""
import json
import sys
import wave

import numpy as np

SR = 48000
CHORDS = {
    "Dmaj9": [146.83, 220.0, 277.18, 329.63, 369.99, 554.37],
    "Gmaj7/B": [123.47, 196.0, 293.66, 369.99, 440.0, 587.33],
}
POP_NOTES = [880.0, 987.77, 1108.73, 1318.51, 1479.98, 1760.0]

cues = json.load(open(sys.argv[1]))
DUR = float(cues["duration"])
N = int(SR * DUR)
t = np.arange(N) / SR
rng = np.random.default_rng(7)
L = np.zeros(N)
R = np.zeros(N)


def add(sig, start, gain=1.0, pan=0.0):
    i = int(start * SR)
    j = min(N, i + len(sig))
    if j <= i:
        return
    s = sig[: j - i] * gain
    L[i:j] += s * np.sqrt(0.5 * (1 - pan))
    R[i:j] += s * np.sqrt(0.5 * (1 + pan))


def lowpass(x, cutoff):
    """One-pole low-pass; cutoff may be an array (per-sample sweep)."""
    c = np.broadcast_to(np.asarray(cutoff, dtype=float), x.shape)
    a = np.exp(-2 * np.pi * c / SR)
    y = np.empty_like(x)
    acc = 0.0
    for n in range(len(x)):
        acc = (1 - a[n]) * x[n] + a[n] * acc
        y[n] = acc
    return y


def env(n, a, r):
    e = np.ones(n)
    na, nr = int(a * SR), int(r * SR)
    if na:
        e[:na] = np.linspace(0, 1, na) ** 2
    if nr:
        e[-nr:] *= np.linspace(1, 0, nr) ** 1.5
    return e


def voice(freq, dur, bright=0.35, detune=0.0025):
    n = int(dur * SR)
    tt = np.arange(n) / SR
    out = np.zeros(n)
    for d in (-detune, 0, detune):
        f = freq * (1 + d)
        for h, amp in ((1, 1.0), (2, bright), (3, bright * 0.45), (4, bright * 0.2)):
            out += amp * np.sin(2 * np.pi * f * h * tt + rng.uniform(0, 6.28))
    return out / 6


def whoosh(at, dur, gain=0.14, lo=300, hi=3800, pan=0.0):
    n = int(dur * SR)
    w = lowpass(rng.normal(0, 1, n), np.concatenate([np.geomspace(lo, hi, n // 2), np.geomspace(hi, lo, n - n // 2)]))
    w *= np.sin(np.linspace(0, np.pi, n)) ** 2
    add(w, at, gain, pan=pan)


def pop(at, f, gain=0.042, pan=0.0):
    n = int(0.5 * SR)
    tt = np.arange(n) / SR
    add(np.sin(2 * np.pi * f * tt) * np.exp(-tt / 0.18) * (1 - np.exp(-tt / 0.003)), at, gain, pan=pan)


def sub_drop(at, gain, f0=70, f1=42, dur=1.6):
    n = int(dur * SR)
    tt = np.arange(n) / SR
    fs = f0 * np.exp(-tt * 3) + f1
    add(np.sin(2 * np.pi * np.cumsum(fs) / SR) * np.exp(-tt / 0.45), at, gain)


# ── pad bed ──
pads = cues.get("pad", [[0, DUR - 2.4, "Dmaj9"], [DUR - 2.7, 2.7, "Gmaj7/B"]])
for k, (at, dur, name) in enumerate(pads):
    last = k == len(pads) - 1 and k > 0
    for f in CHORDS[name]:
        n = int(dur * SR)
        s = voice(f, dur, bright=0.5 if last else 0.35) * env(n, 0.25 if last else 1.6, min(1.6, dur / 2))
        add(s, at, 0.08 if last else 0.07, pan=rng.uniform(-0.5, 0.5))
L *= 1 + 0.06 * np.sin(2 * np.pi * 0.35 * t)
R *= 1 + 0.06 * np.sin(2 * np.pi * 0.35 * t)

# ── typing ──
for at0, at1, text in cues.get("type", []):
    for i, ch in enumerate(text):
        at = at0 + i * (at1 - at0) / len(text)
        n = int(0.04 * SR)
        tt = np.arange(n) / SR
        key = (np.sin(2 * np.pi * (1900 + 140 * (i % 3)) * tt) * 0.5 + rng.normal(0, 1, n) * 0.5) * np.exp(-tt / 0.006)
        add(key - lowpass(key, 700), at, 0.05 if ch == " " else 0.08, pan=rng.uniform(-0.3, 0.3))
for at in cues.get("enter", []):
    n = int(0.12 * SR)
    tt = np.arange(n) / SR
    add((np.sin(2 * np.pi * 1300 * tt) + rng.normal(0, 0.6, n)) * np.exp(-tt / 0.012), at, 0.1)

# ── pops, whooshes, risers, clicks ──
for k, p in enumerate(cues.get("pop", [])):
    at, f = (p, POP_NOTES[k % len(POP_NOTES)]) if isinstance(p, (int, float)) else p
    pop(at, f, pan=-0.4 + 0.2 * (k % 5))
for k, (at, dur) in enumerate(cues.get("whoosh", [])):
    whoosh(at, dur, pan=0.15 if k % 2 == 0 else -0.15)
for end, dur in cues.get("riser", []):
    n = int(dur * SR)
    add(lowpass(rng.normal(0, 1, n), np.geomspace(500, 6500, n)) * np.linspace(0, 1, n) ** 2.4, end - dur, 0.18)
for at in cues.get("click", []):
    n = int(0.05 * SR)
    tt = np.arange(n) / SR
    c = (np.sin(2 * np.pi * 2400 * tt) * 0.6 + rng.normal(0, 1, n) * 0.4) * np.exp(-tt / 0.004)
    add(c - lowpass(c, 900), at, 0.22)

# ── impact: a stamp or reveal landing ──
for at in cues.get("impact", []):
    sub_drop(at, 0.5)
    n = int(1.6 * SR)
    tt = np.arange(n) / SR
    add(lowpass(rng.normal(0, 1, n), 2500) * np.exp(-tt / 0.18), at, 0.1)
    for f, g in ((1174.66, 0.07), (1760.0, 0.045)):
        add(np.sin(2 * np.pi * f * tt) * np.exp(-tt / 0.6), at, g, pan=0.15)

# ── lockup: swell into the end card, sub, shimmer on the mark ──
for at in cues.get("lockup", []):
    n = int(0.5 * SR)
    add(lowpass(rng.normal(0, 1, n), np.geomspace(400, 9000, n)) * np.linspace(0, 1, n) ** 3, at - 0.5, 0.25)
    sub_drop(at, 0.5, f0=90, f1=46, dur=1.8)
    n = int(1.8 * SR)
    tt = np.arange(n) / SR
    for f, g, d in ((1479.98, 0.07, 1.2), (2217.46, 0.05, 1.0), (2959.96, 0.035, 0.8)):
        add(np.sin(2 * np.pi * f * tt) * np.exp(-tt / d) * (1 - np.exp(-tt / 0.004)), at + 0.02, g, pan=rng.uniform(-0.4, 0.4))
for at in cues.get("chime", []):
    n = int(1.4 * SR)
    tt = np.arange(n) / SR
    for f, g in ((880.0, 0.05), (1318.51, 0.035)):
        add(np.sin(2 * np.pi * f * tt) * np.exp(-tt / 0.7) * (1 - np.exp(-tt / 0.003)), at, g, pan=0.25)

# ── room: a short stereo reverb (decaying noise impulse) ──
irn = int(1.9 * SR)
it = np.arange(irn) / SR
irL = rng.normal(0, 1, irn) * np.exp(-it / 0.42)
irR = rng.normal(0, 1, irn) * np.exp(-it / 0.42)
irL[0] = irR[0] = 0


def conv(x, ir):
    m = len(x) + len(ir)
    size = 1 << (m - 1).bit_length()
    y = np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(ir, size), size)[: len(x)]
    return y / np.sqrt(np.sum(ir ** 2))


L2 = L + 0.28 * conv(L, irL)
R2 = R + 0.28 * conv(R, irR)
fade = np.ones(N)
fade[: int(0.08 * SR)] = np.linspace(0, 1, int(0.08 * SR))
fade[-int(0.9 * SR):] = np.linspace(1, 0, int(0.9 * SR)) ** 1.6
mix = np.stack([L2 * fade, R2 * fade], axis=1)
mix = np.tanh(mix * 1.2) / np.tanh(1.2)
mix *= 10 ** (-1 / 20) / np.max(np.abs(mix))
with wave.open(sys.argv[2], "wb") as f:
    f.setnchannels(2)
    f.setsampwidth(2)
    f.setframerate(SR)
    f.writeframes((mix * 32767).astype(np.int16).tobytes())
print("ok", sys.argv[2])
