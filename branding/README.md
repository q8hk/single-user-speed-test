Place a custom `logo.svg` or `logo.png` in this folder to replace the default
LibreSpeed logo in deployments that serve the modern UI from the repository
root.

If both files exist, `logo.svg` is used first. The browser UI can use SVG or
PNG directly. The generated share image can use PNG directly and can use SVG
when the PHP server has Imagick available; otherwise it falls back to the
built-in text wordmark.
