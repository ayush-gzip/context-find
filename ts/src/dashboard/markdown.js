"use strict";
// Small Markdown renderer for agent text. Every character of the source is
// escaped before any tag is added, so transcript HTML can never become markup.
(function (root) {
  const esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/,
    LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/,
    HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
    RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/,
    QUOTE = /^\s{0,3}>\s?/,
    DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  // Emphasis and links run on escaped text; code spans and links are swapped
  // for placeholders first so their contents are not formatted again.
  function inline(text) {
    const saved = [],
      keep = (html) => `\u0000${saved.push(html) - 1}\u0000`;
    let s = String(text).replace(
      /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g,
      (_, __, code) => keep(`<code>${esc(code.trim())}</code>`),
    );
    s = esc(s);
    s = s.replace(
      /\[([^\]\n]+)\]\(\s*([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\s*\)/g,
      (_, label, href) =>
        /^(https?:\/\/|mailto:)/i.test(href)
          ? keep(
              `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`,
            )
          : keep(`<span class="md-link" title="${href}">${label}</span>`),
    );
    // Stop a bare URL at an escaped quote or bracket, then drop closing punctuation.
    s = s.replace(
      /\bhttps?:\/\/(?:(?!&(?:quot|#39|lt|gt);)[^\s\u0000])+/g,
      (match) => {
        const url = match.replace(/[.,;:!?)\]]+$/, "");
        return (
          keep(
            `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
          ) + match.slice(url.length)
        );
      },
    );
    s = s
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
      .replace(
        /(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g,
        "$1<em>$2</em>",
      )
      .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => saved[Number(i)]);
  }

  function code(lines, lang) {
    return `<div class="md-code"><div class="md-code-head"><span>${esc(lang || "text")}</span><button type="button" class="md-copy" data-copy-code>Copy</button></div><pre><code>${esc(lines.join("\n"))}</code></pre></div>`;
  }

  /** Lines from a fence to its matching close; an open fence (still streaming) runs to the end. */
  function fenced(lines, i, indent) {
    const [, , mark, lang] = lines[i].match(FENCE),
      body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const close = lines[j].trim();
      if (
        close[0] === mark[0] &&
        close.length >= mark.length &&
        /^(`+|~+)$/.test(close)
      ) {
        j++;
        break;
      }
      body.push(lines[j].slice(Math.min(indent, lines[j].search(/\S|$/))));
    }
    return { html: code(body, lang), next: j };
  }

  function cells(row) {
    return row
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  }

  function table(lines, i) {
    const head = cells(lines[i]),
      align = cells(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":")
          ? "center"
          : c.endsWith(":")
            ? "right"
            : "",
      ),
      cell = (tag, c, k) =>
        `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ""}>${inline(c)}</${tag}>`;
    let j = i + 2,
      body = "";
    for (; j < lines.length && lines[j].includes("|") && lines[j].trim(); j++)
      body += `<tr>${cells(lines[j])
        .map((c, k) => cell("td", c, k))
        .join("")}</tr>`;
    return {
      html: `<div class="md-table"><table><thead><tr>${head.map((c, k) => cell("th", c, k)).join("")}</tr></thead><tbody>${body}</tbody></table></div>`,
      next: j,
    };
  }

  function list(lines, i) {
    const items = [];
    let j = i;
    while (j < lines.length) {
      const m = lines[j].match(LIST);
      if (m) {
        const marker = m[2],
          task = m[3].match(/^\[([ xX])\]\s+(.*)$/);
        items.push({
          indent: m[1].length,
          ordered: /\d/.test(marker),
          start: parseInt(marker, 10) || 1,
          body: [
            task
              ? `<span class="md-task">${task[1] === " " ? "○" : "✓"}</span> ${inline(task[2])}`
              : inline(m[3]),
          ],
        });
        j++;
        continue;
      }
      const blank = !lines[j].trim(),
        nextIndented =
          blank && j + 1 < lines.length && /^\s{2,}\S/.test(lines[j + 1]);
      if (blank && !nextIndented) break;
      if (blank) {
        j++;
        continue;
      }
      if (!/^\s{2,}\S/.test(lines[j]) && items.length && !/^\s/.test(lines[j]))
        break;
      const last = items[items.length - 1];
      if (FENCE.test(lines[j])) {
        const block = fenced(lines, j, lines[j].search(/\S/));
        last.body.push(block.html);
        j = block.next;
      } else {
        last.body.push("<br>" + inline(lines[j].trim()));
        j++;
      }
    }
    let html = "";
    const stack = [];
    for (const it of items) {
      let top = stack[stack.length - 1];
      while (top && it.indent < top.indent) {
        html += `</li></${top.tag}>`;
        stack.pop();
        top = stack[stack.length - 1];
      }
      if (!top || it.indent > top.indent) {
        const tag = it.ordered ? "ol" : "ul";
        html += `<${tag}${it.ordered && it.start !== 1 ? ` start="${it.start}"` : ""}>`;
        stack.push({ indent: it.indent, tag });
      } else html += "</li>";
      html += "<li>" + it.body.join("");
    }
    while (stack.length) html += `</li></${stack.pop().tag}>`;
    return { html, next: j };
  }

  function blocks(lines) {
    let html = "",
      i = 0,
      para = [];
    const flush = () => {
      if (para.length) html += `<p>${para.map(inline).join("<br>")}</p>`;
      para = [];
    };
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if (!line.trim()) {
        flush();
        i++;
      } else if (FENCE.test(line)) {
        flush();
        const block = fenced(lines, i, line.search(/\S/));
        html += block.html;
        i = block.next;
      } else if ((m = line.match(HEADING))) {
        flush();
        const level = Math.min(6, m[1].length + 2);
        html += `<h${level} class="md-h${m[1].length}">${inline(m[2])}</h${level}>`;
        i++;
      } else if (RULE.test(line)) {
        flush();
        html += "<hr>";
        i++;
      } else if (QUOTE.test(line)) {
        flush();
        const quoted = [];
        for (; i < lines.length && QUOTE.test(lines[i]); i++)
          quoted.push(lines[i].replace(QUOTE, ""));
        html += `<blockquote>${blocks(quoted)}</blockquote>`;
      } else if (
        LIST.test(line) &&
        !(para.length && /^\s*\d/.test(line) && !/^\s*1[.)]/.test(line))
      ) {
        flush();
        const block = list(lines, i);
        html += block.html;
        i = block.next;
      } else if (
        line.includes("|") &&
        i + 1 < lines.length &&
        DIVIDER.test(lines[i + 1]) &&
        lines[i + 1].includes("-")
      ) {
        flush();
        const block = table(lines, i);
        html += block.html;
        i = block.next;
      } else {
        para.push(line.trim());
        i++;
      }
    }
    flush();
    return html;
  }

  function markdown(text) {
    return blocks(
      String(text ?? "")
        .replace(/\u0000/g, "")
        .replace(/\r\n?/g, "\n")
        .split("\n"),
    );
  }
  root.cfindMarkdown = { markdown, esc };
})(globalThis);
