function inline(parent, text) {
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const t = m[0];
    const el = document.createElement(t.startsWith('**') ? 'strong' : t[0] === '`' ? 'code' : 'em');
    el.textContent = t.startsWith('**') ? t.slice(2, -2) : t.slice(1, -1);
    parent.append(el);
    last = m.index + t.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

const isTableLine = (l) => /^\s*\|.*\|\s*$/.test(l);
const isListLine = (l) => /^\s*([-*]|\d+\.)\s+/.test(l);
const isSpecial = (l) => /^#{1,4}\s/.test(l) || isTableLine(l) || isListLine(l) || /^>/.test(l) || /^---+\s*$/.test(l);

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

export function renderMarkdown(text) {
  const root = document.createDocumentFragment();
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const el = document.createElement('h' + Math.min(h[1].length + 2, 5));
      inline(el, h[2]);
      root.append(el);
      i++;
      continue;
    }
    if (/^---+\s*$/.test(line)) {
      root.append(document.createElement('hr'));
      i++;
      continue;
    }
    if (isTableLine(line)) {
      const rows = [];
      while (i < lines.length && isTableLine(lines[i])) rows.push(lines[i++]);
      const table = document.createElement('table');
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      rows.forEach((row, index) => {
        if (/^[\s|:-]+$/.test(row)) return;
        const tr = table.insertRow();
        for (const c of cells(row)) {
          const cell = document.createElement(index === 0 ? 'th' : 'td');
          inline(cell, c);
          tr.append(cell);
        }
      });
      wrap.append(table);
      root.append(wrap);
      continue;
    }
    if (isListLine(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (i < lines.length && isListLine(lines[i])) {
        const li = document.createElement('li');
        inline(li, lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        list.append(li);
        i++;
      }
      root.append(list);
      continue;
    }
    if (/^>/.test(line)) {
      const quote = document.createElement('blockquote');
      const parts = [];
      while (i < lines.length && /^>/.test(lines[i])) parts.push(lines[i++].replace(/^>\s?/, ''));
      inline(quote, parts.join(' '));
      root.append(quote);
      continue;
    }
    const parts = [];
    while (i < lines.length && lines[i].trim() && !isSpecial(lines[i])) parts.push(lines[i++].trim());
    const p = document.createElement('p');
    inline(p, parts.join(' '));
    root.append(p);
  }
  return root;
}
