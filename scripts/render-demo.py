#!/usr/bin/env python3
"""Render the public README demo without using real local transcripts."""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 1100, 620
BG = (12, 14, 18)
PANEL = (20, 23, 29)
FG = (222, 226, 232)
MUTED = (125, 135, 150)
ACCENT = (96, 165, 250)
GREEN = (80, 200, 120)
YELLOW = (240, 190, 80)
HIGHLIGHT = (30, 39, 52)

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
BOLD_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"

font = ImageFont.truetype(FONT, 22)
small = ImageFont.truetype(FONT, 18)
bold = ImageFont.truetype(BOLD_FONT, 22)
large = ImageFont.truetype(BOLD_FONT, 30)

frames: list[Image.Image] = []
durations: list[int] = []


def terminal():
    image = Image.new("RGB", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        (18, 18, WIDTH - 18, HEIGHT - 18),
        radius=16,
        fill=PANEL,
        outline=(50, 55, 65),
        width=2,
    )
    for index, color in enumerate(((255, 95, 86), (255, 189, 46), (39, 201, 63))):
        draw.ellipse((42 + index * 28, 38, 56 + index * 28, 52), fill=color)
    draw.text((WIDTH - 220, 34), "context-find", font=small, fill=MUTED)
    return image, draw


def add_frame(lines, *, search=None, selected=None, footer=None, duration=500):
    image, draw = terminal()
    y = 82

    for index, parts in enumerate(lines):
        if selected is not None and index == selected:
            draw.rounded_rectangle((38, y - 6, WIDTH - 38, y + 29), radius=7, fill=HIGHLIGHT)

        x = 48
        for text, color, line_font in parts:
            selected_font = line_font or font
            draw.text((x, y), text, font=selected_font, fill=color)
            x += draw.textlength(text, font=selected_font)
        y += 36

    if search is not None:
        search_y = HEIGHT - 105
        draw.line((40, search_y - 14, WIDTH - 40, search_y - 14), fill=(48, 53, 63), width=1)
        draw.text((48, search_y), "/ ", font=bold, fill=ACCENT)
        draw.text((78, search_y), search, font=font, fill=FG)
        cursor_x = 78 + draw.textlength(search, font=font)
        draw.rectangle((cursor_x + 2, search_y + 2, cursor_x + 13, search_y + 26), fill=FG)

    if footer:
        draw.text((48, HEIGHT - 66), footer, font=small, fill=MUTED)

    frames.append(image)
    durations.append(duration)


add_frame(
    [[("$ ", GREEN, bold), ("context-find", FG, bold)]],
    footer="Search and resume Claude Code + Codex conversations",
    duration=900,
)

rows = [
    [("325 conversations  ", FG, bold), ("across this machine", MUTED, small)],
    [("2m   ", MUTED, small), ("codex   ", ACCENT, bold), ("~/work/api-gateway       ", FG, small), ("add retry with exponential backoff", FG, small)],
    [("18m  ", MUTED, small), ("claude  ", YELLOW, bold), ("~/work/payments          ", FG, small), ("verify GNAP signature input", FG, small)],
    [("1h   ", MUTED, small), ("codex   ", ACCENT, bold), ("~/work/infra             ", FG, small), ("debug nginx rate limit", FG, small)],
    [("3h   ", MUTED, small), ("claude  ", YELLOW, bold), ("~/work/context-find      ", FG, small), ("make remote search progressive", FG, small)],
    [("1d   ", MUTED, small), ("codex   ", ACCENT, bold), ("~/work/backend           ", FG, small), ("fix redis reconnect loop", FG, small)],
]

add_frame(rows, search="", footer="↑↓ move   v read   enter/r resume   / search", duration=850)
for query in ("rate", "rate limit", "rate limit retry"):
    add_frame(
        rows,
        search=query,
        footer="type to filter every visible conversation",
        duration=350 if query != "rate limit retry" else 700,
    )

filtered = [
    [("2 matches  ", FG, bold), ("for transcript text: rate limit retry", MUTED, small)],
    [("2m   ", MUTED, small), ("codex   ", ACCENT, bold), ("~/work/api-gateway       ", FG, small), ("add retry with exponential backoff", FG, small)],
    [("5d   ", MUTED, small), ("claude  ", YELLOW, bold), ("~/work/worker            ", FG, small), ("handle upstream rate-limit retry", FG, small)],
]
add_frame(filtered, search="rate limit retry", selected=1, footer="enter to open · r to resume", duration=850)

reader = [
    [("CODEX  ", ACCENT, bold), ("~/work/api-gateway", FG, bold)],
    [("2026-09-17 21:42", MUTED, small)],
    [("", FG, font)],
    [("YOU", GREEN, bold)],
    [("add retry with exponential backoff and jitter when the API", FG, small)],
    [("returns 429; keep the retry budget bounded", FG, small)],
    [("", FG, font)],
    [("ASSISTANT", ACCENT, bold)],
    [("I’d keep retry state per request and cap both attempts and total", FG, small)],
    [("elapsed time. Honor Retry-After when it is present...", FG, small)],
]
add_frame(reader, footer="r resume this conversation   q back", duration=1200)

resume = [
    [("CODEX  ", ACCENT, bold), ("~/work/api-gateway", FG, bold)],
    [("", FG, font)],
    [("✓ found the conversation you meant", GREEN, bold)],
    [("", FG, font)],
    [("$ ", GREEN, bold), ("codex resume 019fef02-9ecc-7bb0-8f8c-c3af852b6cd6", FG, font)],
    [("resuming session…", MUTED, small)],
]
add_frame(resume, footer="find it → read it → resume it", duration=1600)

output = Path("assets/demo.gif")
output.parent.mkdir(parents=True, exist_ok=True)
frames[0].save(
    output,
    save_all=True,
    append_images=frames[1:],
    duration=durations,
    loop=0,
    optimize=True,
    disposal=2,
)
print(f"wrote {output} ({output.stat().st_size} bytes)")
