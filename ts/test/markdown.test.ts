import test from "node:test";
import assert from "node:assert/strict";
import "../src/dashboard/markdown.js";

const { markdown } = (globalThis as any).cfindMarkdown as {
  markdown: (text: string) => string;
};

test("Markdown keeps transcript HTML as text", () => {
  for (const attack of [
    "<img src=x onerror=alert(1)>",
    "<script>alert(1)</script>",
    "[x](javascript:alert(1))",
    "[x](JAVASCRIPT:alert(1))",
    '[x](https://a.com/" onmouseover="alert(1))',
    "`<b>` **<i>** <svg/onload=alert(1)>",
    "```\n</code></pre><script>alert(1)</script>\n```",
    "| <img src=x> | b |\n|---|---|\n| <script> | `</td>` |",
    'https://a.com/"onmouseover=alert(1)',
  ]) {
    const html = markdown(attack);
    assert.doesNotMatch(html, /<(img|script|svg|i|b)\b/i, attack);
    assert.doesNotMatch(html, /href="(?!https?:\/\/)/i, attack);
    assert.doesNotMatch(html, /\son\w+="/i, attack);
  }
});

test("Markdown renders code, lists, tables and links for chat bubbles", () => {
  const html = markdown(
    "Steps:\n1. Run:\n   ```sh\n   npm test\n   ```\n2. Read `out`\n   - nested\n\n| a | b |\n|:--|--:|\n| 1 | **2** |\n\nSee [docs](https://example.com/a?b=1&c=2).",
  );
  assert.match(html, /<ol><li>Run:<div class="md-code">/);
  assert.match(html, /<span>sh<\/span>/);
  assert.match(html, /<code>npm test<\/code>/);
  assert.match(
    html,
    /<li>Read <code>out<\/code><ul><li>nested<\/li><\/ul><\/li><\/ol>/,
  );
  assert.match(html, /<th>a<\/th>/);
  assert.match(html, /<td style="text-align:right"><strong>2<\/strong><\/td>/);
  assert.match(
    html,
    /<a href="https:\/\/example.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs<\/a>/,
  );
  const code = markdown("```py\ndef f():\n\treturn  1\n```");
  assert.match(code, /<code>def f\(\):\n\treturn  1<\/code>/);
  assert.match(
    markdown("```\nstill streaming"),
    /<code>still streaming<\/code>/,
  );
  assert.equal(
    markdown("snake_case __init__.py"),
    "<p>snake_case __init__.py</p>",
  );
});
