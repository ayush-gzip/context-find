# Records demo frames from synthetic transcripts. Use demo/render.sh to produce assets/demo.gif.
#   demo/render.sh
Output "demo/frames/"

Set FontSize 18
Set Width 1200
Set Height 640
Set Padding 16
Set Theme "Dracula"
Set CursorBlink false
Set TypingSpeed 40ms

# Point every store at demo/home so no real conversation is read or shown.
Hide
Type `node demo/seed.mjs >/dev/null && export HOME="$PWD/demo/home" CLAUDE_CONFIG_DIR="$PWD/demo/home/.claude" CODEX_HOME="$PWD/demo/home/.codex" && context-find() { node ts/dist/cli.js --local "$@"; } && clear`
Enter
Sleep 500ms
Show

# 1. Search transcript text across both agents, then read one.
Type `context-find "rate limit"`
Sleep 500ms
Enter
Sleep 2.5s
Down
Sleep 800ms
Type "v"
Sleep 3s
Type "q"
Sleep 800ms
Escape
Sleep 800ms
Hide
Type "clear"
Enter
Show

# 2. Browse everything, narrow live with /.
Type "context-find"
Sleep 500ms
Enter
Sleep 2s
Type "/"
Sleep 400ms
Type "docker"
Sleep 2s
Escape
Sleep 500ms
Escape
Sleep 800ms
Hide
Type "clear"
Enter
Show

# 3. Which machines are searchable.
Type "context-find --list-machines"
Sleep 500ms
Enter
Sleep 3.5s
