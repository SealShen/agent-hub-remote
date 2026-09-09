// md — tiny markdown renderer for agent + system message bodies.
// Supports: headings (# ## ###), code fences (``` lang), inline code (`x`),
// bold (**x**), italic (*x*), links [text](url), bare http(s) URLs,
// bullet + ordered lists, > quote, pipe tables (| a | b | + |---|:--:| row).
// Bold/italic/link text re-parse one level (so **[x](url)** works).
// enableRedmineLinks turns #12345 / #12345#note-2 in plain text into Redmine
// links (window.AHR_splitRedmineIssueRefs from redmine-links.js); disabled
// inside code spans and anchor text to avoid nested anchors.
// Intentionally minimal. Lines wrap with pre-wrap.

const MD_INLINE_RE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s<>"'`)\]）】」]+)/;

function redmineInline(text, keyPrefix) {
  const split = window.AHR_splitRedmineIssueRefs;
  if (!split) return text;
  const parts = split(text);
  if (!parts.some(p => p.href)) return text;
  return parts.map((p, i) => p.href ? (
    <a className="md-a redmine-issue-link" key={`${keyPrefix}-${i}`} href={p.href} target="_blank" rel="noopener noreferrer">{p.text}</a>
  ) : p.text);
}

function mdInline(text, opts = {}) {
  const out = [];
  let rest = text;
  let key = 0;
  function pushPlain(value) {
    if (!value) return;
    const rendered = opts.enableRedmineLinks ? redmineInline(value, `rm-${key++}`) : value;
    if (Array.isArray(rendered)) out.push(...rendered);
    else out.push(rendered);
  }
  while (rest) {
    const m = rest.match(MD_INLINE_RE);
    if (!m) { pushPlain(rest); break; }
    if (m.index > 0) pushPlain(rest.slice(0, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) {
      const codeText = tok.slice(1, -1);
      const isWindowsFile = !!opts.sessionId && /^[a-z]:[\\/]/i.test(codeText);
      if (isWindowsFile) {
        const href = `/session/${encodeURIComponent(opts.sessionId)}/file?path=${encodeURIComponent(codeText)}`;
        out.push(<span className="md-file" key={key++} role="group" aria-label="本機檔案"><code>{codeText}</code><span className="md-file-actions"><CopyBtn text={codeText}/><a className="md-file-download" href={href} download title="下載檔案" aria-label={`下載 ${codeText}`}><span aria-hidden="true">↓</span></a></span></span>);
      } else out.push(<code className="md-code" key={key++}>{codeText}</code>);
    } else if (tok.startsWith('**')) out.push(<strong key={key++}>{mdInline(tok.slice(2, -2), opts)}</strong>);
    else if (tok.startsWith('*')) out.push(<em key={key++}>{mdInline(tok.slice(1, -1), opts)}</em>);
    else if (tok.startsWith('[')) {
      const lm = tok.match(/\[([^\]]+)\]\(([^)\s]+)\)/);
      if (lm) out.push(<a className="md-a" key={key++} href={lm[2]} target="_blank" rel="noreferrer">{mdInline(lm[1], { ...opts, enableRedmineLinks: false })}</a>);
      else pushPlain(tok);
    } else {
      const href = tok.replace(/[.,;:!?。，；：、]+$/, '');
      out.push(<a className="md-a" key={key++} href={href} target="_blank" rel="noreferrer">{href}</a>);
      if (href.length < tok.length) pushPlain(tok.slice(href.length));
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

function isTableRow(line) { return /^\s*\|.*\|\s*$/.test(line); }
function isTableSep(line) { return /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line); }
function tableCells(line) { return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()); }

function mdBlocks(text) {
  const lines = String(text || '').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fenceOpen = line.trimStart().match(/^(`{3,})(.*)$/);
    if (fenceOpen) {
      const fenceMarker = fenceOpen[1]; const lang = fenceOpen[2].trim(); const code = []; i++;
      const closeRe = new RegExp('^`{' + fenceMarker.length + ',}\\s*$');
      while (i < lines.length && !closeRe.test(lines[i].trimStart())) { code.push(lines[i]); i++; }
      i++; blocks.push({ kind: 'code', lang, text: code.join('\n') }); continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) { blocks.push({ kind: 'h', level: h[1].length, text: h[2] }); i++; continue; }
    if (line.startsWith('> ')) { const lns=[]; while(i<lines.length&&lines[i].startsWith('> ')){lns.push(lines[i].slice(2));i++;} blocks.push({kind:'quote',text:lns.join('\n')}); continue; }
    if (isTableRow(line) && i+1<lines.length && isTableSep(lines[i+1])) {
      const head=tableCells(line); const align=tableCells(lines[i+1]).map(c=>{const l=c.startsWith(':');const r=c.endsWith(':');return l&&r?'center':r?'right':'left';}); const rows=[]; i+=2;
      while(i<lines.length&&isTableRow(lines[i])&&!isTableSep(lines[i])){rows.push(tableCells(lines[i]));i++;}
      blocks.push({kind:'table',head,align,rows}); continue;
    }
    if (/^\s*\d+\.\s/.test(line)) { const items=[]; while(i<lines.length&&/^\s*\d+\.\s/.test(lines[i])){items.push(lines[i].replace(/^\s*\d+\.\s+/,''));i++;} blocks.push({kind:'olist',items}); continue; }
    if (/^[-*]\s/.test(line)) { const items=[]; while(i<lines.length&&/^[-*]\s/.test(lines[i])){items.push(lines[i].replace(/^[-*]\s+/,''));i++;} blocks.push({kind:'ulist',items}); continue; }
    if (line.trim()===''){i++;continue;}
    const para=[line]; i++;
    while(i<lines.length){const ln=lines[i]; if(ln.trim()===''||ln.trimStart().startsWith('```')||/^#{1,3}\s/.test(ln)||/^[-*]\s/.test(ln)||/^\s*\d+\.\s/.test(ln)||ln.startsWith('> ')||(isTableRow(ln)&&isTableSep(lines[i+1]||'')))break; para.push(ln); i++;}
    blocks.push({kind:'p',text:para.join('\n')});
  }
  return blocks;
}

function CopyBtn({ text }) {
  const [status, setStatus] = React.useState('idle');
  function resetSoon(){setTimeout(()=>setStatus('idle'),1800);}
  function handleCopy(){if(!navigator.clipboard?.writeText){setStatus('fail');resetSoon();return;} navigator.clipboard.writeText(text).then(()=>{setStatus('done');resetSoon();}).catch(()=>{setStatus('fail');resetSoon();});}
  return <button className={'pre-copy'+(status==='done'?' done':status==='fail'?' fail':'')} onClick={handleCopy}>{status==='done'?'✓ copied':status==='fail'?'✗ failed':'copy'}</button>;
}
function codeFenceClass(lang){const token=String(lang||'').trim().split(/\s+/)[0]||'';const safe=token.toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'');return 'md-pre'+(safe?` lang-${safe}`:'');}
function MD({ text, enableRedmineLinks, sessionId }) {
  const blocks=React.useMemo(()=>mdBlocks(text),[text]);
  const inlineOpts=React.useMemo(()=>({enableRedmineLinks:!!enableRedmineLinks,sessionId}),[enableRedmineLinks,sessionId]);
  return <>{blocks.map((b,idx)=>{
    if(b.kind==='code')return <div className={codeFenceClass(b.lang)} key={idx}><div className="pre-head"><span>{b.lang||''}</span><CopyBtn text={b.text}/></div><pre style={{margin:0}}><code>{b.text}</code></pre></div>;
    if(b.kind==='h'){const Tag=`h${b.level}`;return <Tag key={idx} className={`md-h md-h${b.level}`}>{mdInline(b.text,inlineOpts)}</Tag>;}
    if(b.kind==='ulist')return <ul key={idx} className="md-list">{b.items.map((it,i)=><li key={i}>{mdInline(it,inlineOpts)}</li>)}</ul>;
    if(b.kind==='olist')return <ol key={idx} className="md-list ord">{b.items.map((it,i)=><li key={i}>{mdInline(it,inlineOpts)}</li>)}</ol>;
    if(b.kind==='quote')return <div key={idx} className="md-quote">{mdInline(b.text,inlineOpts)}</div>;
    if(b.kind==='table')return <div className="md-table-wrap" key={idx}><table className="md-table"><thead><tr>{b.head.map((c,ci)=><th key={ci} style={{textAlign:b.align[ci]||'left'}}>{mdInline(c,inlineOpts)}</th>)}</tr></thead><tbody>{b.rows.map((r,ri)=><tr key={ri}>{r.map((c,ci)=><td key={ci} style={{textAlign:b.align[ci]||'left'}}>{mdInline(c,inlineOpts)}</td>)}</tr>)}</tbody></table></div>;
    return <p key={idx} className="md-p">{mdInline(b.text,inlineOpts)}</p>;
  })}</>;
}
Object.assign(window,{MD,mdInline,mdBlocks,redmineInline});
