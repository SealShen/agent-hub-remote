// slash — command registry + autocomplete popup.
// Detection rule: composer value matches /^\/[\w-]*( .*)?$/ → show popup.
// Tap a row to either fill the composer with the command (when args are required)
// or send immediately (when args is empty).

const SLASH_COMMANDS = [
  { name: '/help',    sub: 'list available commands' },
  { name: '/clear',   sub: 'fresh thread · keep session' },
  { name: '/compact', sub: 'summarize history to free context' },
  { name: '/rewind',  args: '[turn]', sub: 'discard from a user turn onward' },
  { name: '/model',   args: '<name>', sub: 'switch model' },
  { name: '/cd',      args: '<path>', sub: 'change working dir' },
  { name: '/cost',    sub: 'token usage + spend' },
  { name: '/fork',    sub: 'duplicate session from here' },
  { name: '/init',    sub: 'generate CLAUDE.md for this cwd' },
  { name: '/resume',  sub: 'resume after restart / interruption' },
  { name: '/login',   sub: 're-auth with agent-hub' },
  { name: '/exit',    sub: 'archive + close this session' },
];

window.SLASH_COMMANDS = SLASH_COMMANDS;

// parse value into command + remainder
window.parseSlash = function parseSlash(value) {
  const m = value.match(/^\/([\w-]*)(?:\s+(.*))?$/);
  if (!m) return null;
  return { cmd: '/' + m[1], args: m[2] || '' };
};

// is the value a slash trigger (popup should show)
window.isSlashTrigger = function isSlashTrigger(value) {
  // show only when there's no space yet (still typing the command name)
  return /^\/[\w-]*$/.test(value);
};

// ─── popup component ───────────────────────────────────────
function SlashPopup({ query, onPick, accent }) {
  const filtered = React.useMemo(() => {
    const q = (query || '').toLowerCase().replace(/^\//, '');
    if (!q) return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.sub.toLowerCase().includes(q));
  }, [query]);
  const [active, setActive] = React.useState(0);

  React.useEffect(() => { setActive(0); }, [query]);

  function fire(c) {
    onPick(c);
  }

  return (
    <div className="slash-pop" style={{ '--accent': accent }}>
      <div className="sp-head">
        <span>slash commands</span>
        <span className="sp-q">{query || '/'}</span>
        <span style={{ flex: 1 }}/>
        <span>{filtered.length} match</span>
      </div>
      <div className="sp-list">
        {filtered.length === 0 ? (
          <div className="sp-empty">no command matches “{query}”</div>
        ) : filtered.map((c, i) => (
          <button
            key={c.name}
            className={`sp-row ${i === active ? 'on' : ''}`}
            onPointerEnter={() => setActive(i)}
            onClick={() => fire(c)}>
            <span className="sp-name">{c.name}</span>
            {c.args && <span className="sp-args">{c.args}</span>}
            <span className="sp-sub">{c.sub}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { SlashPopup });
