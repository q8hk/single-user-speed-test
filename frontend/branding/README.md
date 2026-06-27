Place a custom `logo.svg` or `logo.png` in this folder to replace the default
LibreSpeed logo after copying `frontend/` assets into a web root.

If both files exist, `logo.svg` is used first. The browser UI can use SVG or
PNG directly. The generated share image can use PNG directly and can use SVG
when the PHP server has Imagick available; otherwise it falls back to the
built-in text wordmark.
