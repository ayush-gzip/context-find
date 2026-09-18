const WORDMARK = [
  "▄█████  ▄▄▄  ▄▄  ▄▄ ▄▄▄▄▄▄ ▄▄▄▄▄ ▄▄ ▄▄ ▄▄▄▄▄▄   ██████ ▄▄ ▄▄  ▄▄ ▄▄▄▄  ",
  "██     ██▀██ ███▄██   ██   ██▄▄  ▀█▄█▀   ██     ██▄▄   ██ ███▄██ ██▀██ ",
  "▀█████ ▀███▀ ██ ▀██   ██   ██▄▄▄ ██ ██   ██     ██     ██ ██ ▀██ ████▀",
];

const PLAIN = [
  "▗▄▄▖ ▗▄▖ ▗▖  ▗▖▗▄▄▄▖▗▄▄▄▖▗▖  ▗▖▗▄▄▄▖    ▗▄▄▄▖▗▄▄▄▖▗▖  ▗▖▗▄▄▄ ",
  "▐▌   ▐▌ ▐▌▐▛▚▖▐▌  █  ▐▌    ▝▚▞▘   █      ▐▌     █  ▐▛▚▖▐▌▐▌  █",
  "▐▌   ▐▌ ▐▌▐▌ ▝▜▌  █  ▐▛▀▀▘  ▐▌    █      ▐▛▀▀▘  █  ▐▌ ▝▜▌▐▌  █",
  "▝▚▄▄▖▝▚▄▞▘▐▌  ▐▌  █  ▐▙▄▄▖▗▞▘▝▚▖  █      ▐▌   ▗▄█▄▖▐▌  ▐▌▐▙▄▄▀",
];

const TAGLINE =
  "every claude code conversation, every directory, every machine";

export const WIDTH = Math.max(...WORDMARK.map((line) => line.length));

export function lines(asciiOnly = false): string[] {
  return [...(asciiOnly ? PLAIN : WORDMARK)];
}

export function text(asciiOnly = false): string {
  return lines(asciiOnly).join("\n") + "\n\n  " + TAGLINE + "\n";
}
