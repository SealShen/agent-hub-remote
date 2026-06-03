// rename — small bottom-anchored modal with a single input.
// Reachable from options panel's "rename" row and row-actions sheet.

const { useState: useStateRN, useEffect: useEffectRN, useRef: useRefRN } = React;

function Rename({ session, onClose, onSave }) {
  const [value, setValue] = useStateRN(session.name);
  const ref = useRefRN(null);
  const accent = window.ACCENTS[session.accent || 0];

  useEffectRN(() => {
    // focus + select on mount
    const t = setTimeout(() => {
      if (ref.current) {
        ref.current.focus();
        ref.current.select();
      }
    }, 60);
    return () => clearTimeout(t);
  }, []);

  function save() {
    const v = value.trim();
    if (!v) return;
    onSave(v);
  }

  return (
    <>
      <div className="sheet-scrim" onClick={onClose}/>
      <div className="rn-sheet" style={{ '--accent': accent }}>
        <div className="rn-head">
          rename session
        </div>
        <div className="rn-input-wrap">
          <div className="rn-input">
            <span className="rn-tic">$</span>
            <input
              ref={ref}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); save(); }
                if (e.key === 'Escape') onClose();
              }}
              placeholder="session name"
              maxLength={120}
            />
          </div>
        </div>
        <div className="rn-foot">
          <button className="btn" onClick={onClose}>cancel</button>
          <button
            className="btn primary"
            disabled={!value.trim() || value.trim() === session.name}
            onClick={save}>
            save
          </button>
        </div>
      </div>
    </>
  );
}

Object.assign(window, { Rename });
