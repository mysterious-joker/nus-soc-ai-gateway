# Minimal verification fixtures

- `ok.wav`: synthetic “OK”, generated locally with macOS `say -v Samantha`, converted to mono 16 kHz signed 16-bit PCM with `afconvert`. Contains no user recording or account data.
- `square.png`: a programmatically generated, opaque white 32 × 32 RGBA PNG. Used as the input to an image-edit request.

These bundled inputs avoid asking users to upload files or generating upstream audio just to test transcription. Generated verification output is discarded; ordinary gateway usage and endpoint checks are still recorded.
