// md — tiny markdown renderer for agent + system message bodies.
// Supports: headings (# ## ###), code fences (``` lang), inline code (`x`),
// bold (**x**), italic (*x*), links [text](url), bullet + ordered lists, > quote.
// Intentionally minimal — no tables, no nesting. Lines wrap with pre-wrap.

const MD_INLINE_RE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]]+\]\([^)\s]+\))/;

function mdInline(text) {
  const out = [];
  let rest = text;
  let key = 0;
  while (rest) {
    const m = rest.match(MD_INLINE_RE);
    if (!m) { out.push(rest); break; }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) {
      out.push(<code className="md-code" key={key++}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith('**')) {
      out.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('*')) {
      out.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    } else if (tok.startsWith('[')) {
      const lm = tok.match(/\[([^\]]+)\]\(([^)\s]+)\)/);
      if (lm) {
        out.push(
          <a className="md-a" key={key++} href={lm[2]} target="_blank" rel="noreferrer">{lm[1]}</a>
        );
      } else {
        out.push(tok);
      }
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

function mdBlocks(text) {
  const lines = String(text || '').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // code fence
    if (line.trimStart().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        code.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ kind: 'code', lang, text: code.join('\n') });
      continue;
    }

    // heading
    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) {
      blocks.push({ kind: 'h', level: h[1].length, text: h[2] });
      i++;
      continue;
    }

    // quote
    if (line.startsWith('> ')) {
      const lns = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        lns.push(lines[i].slice(2));
        i++;
      }
      blocks.push({ kind: 'quote', text: lns.join('\n') });
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'olist', items });
      continue;
    }
    // bullet list
    if (/^[-*]\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'ulist', items });
      continue;
    }

    // blank line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // paragraph (run until blank / fence / heading / list)
    const para = [line];
    i++;
    while (i < lines.length) {
      const ln = lines[i];
      if (ln.trim() === '') break;
      if (ln.trimStart().startsWith('```')) break;
      if (/^#{1,3}\s/.test(ln)) break;
      if (/^[-*]\s/.test(ln)) break;
      if (/^\s*\d+\.\s/.test(ln)) break;
      if (ln.startsWith('> ')) break;
      para.push(ln);
      i++;
    }
    blocks.push({ kind: 'p', text: para.join('\n') });
  }
  return blocks;
}

function CopyBtn({ text }) {
  const [status, setStatus] = React.useState('idle');
  function resetSoon() {
    setTimeout(() => setStatus('idle'), 1800);
  }
  function handleCopy() {
    if (!navigator.clipboard?.writeText) {
      setStatus('fail');
      resetSoon();
      return;
    }
    navigator.clipboard.writeText(text).then(() => {
      setStatus('done');
      resetSoon();
    }).catch(() => {
      setStatus('fail');
      resetSoon();
    });
  }
  return (
    <button
      className={'pre-copy' + (status === 'done' ? ' done' : status === 'fail' ? ' fail' : '')}
      onClick={handleCopy}
    >
      {status === 'done' ? '✓ copied' : status === 'fail' ? '✗ failed' : 'copy'}
    </button>
  );
}

function codeFenceClass(lang) {
  const token = String(lang || '').trim().split(/\s+/)[0] || '';
  const safe = token
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return 'md-pre' + (safe ? ` lang-${safe}` : '');
}

function MD({ text }) {
  const blocks = React.useMemo(() => mdBlocks(text), [text]);
  return (
    <>
      {blocks.map((b, idx) => {
        if (b.kind === 'code') {
          return (
            <div className={codeFenceClass(b.lang)} key={idx}>
              <div className="pre-head">
                <span>{b.lang || ''}</span>
                <CopyBtn text={b.text} />
              </div>
              <pre style={{ margin: 0 }}><code>{b.text}</code></pre>
            </div>
          );
        }
        if (b.kind === 'h') {
          const Tag = `h${b.level}`;
          return <Tag key={idx} className={`md-h md-h${b.level}`}>{mdInline(b.text)}</Tag>;
        }
        if (b.kind === 'ulist') {
          return (
            <ul key={idx} className="md-list">
              {b.items.map((it, i) => <li key={i}>{mdInline(it)}</li>)}
            </ul>
          );
        }
        if (b.kind === 'olist') {
          return (
            <ol key={idx} className="md-list ord">
              {b.items.map((it, i) => <li key={i}>{mdInline(it)}</li>)}
            </ol>
          );
        }
        if (b.kind === 'quote') {
          return <div key={idx} className="md-quote">{mdInline(b.text)}</div>;
        }
        return <p key={idx} className="md-p">{mdInline(b.text)}</p>;
      })}
    </>
  );
}

Object.assign(window, { MD, mdInline, mdBlocks });
