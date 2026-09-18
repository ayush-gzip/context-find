#!/bin/sh
# vhs 0.12 fails silently against ffmpeg 9, so capture frames and encode the gif ourselves.
set -e
cd "$(dirname "$0")/.."
rm -rf demo/frames
vhs demo.tape >/dev/null
ffmpeg -y -loglevel error -r 50 -i demo/frames/frame-text-%05d.png -r 50 -i demo/frames/frame-cursor-%05d.png \
  -filter_complex "[0][1]overlay,fps=15,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" assets/demo.gif
rm -rf demo/frames demo/home
echo "wrote assets/demo.gif"
