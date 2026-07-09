# AudioSlice

Live microphone spectrum analyzer — fit-to-screen web app.

- Live spectrogram (log frequency)
- **Band** — select a frequency range (HI/LO) and hear only that band in headphones
- **Full** — unfiltered mic monitor
- Presets: Birds, Speech, Low
- Works on modern phones, tablets, and desktops (Safari / Chrome)

## Local

```bash
cd ~/audioslice-app
python3 -m http.server 8008
# open http://127.0.0.1:8008
```

Mic access requires a secure context (HTTPS or localhost).

## Deploy

Static files → Vercel. Live: **https://audioslice.markmaga.com**

## Note

Wired headphones give the most reliable full-range monitoring. Bluetooth + live mic can be limited by the OS (call-quality path).
