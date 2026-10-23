/**
 * Which photos machine learning skips, and which it always analyses.
 *
 * A rule is a folder (with everything in it) or one file, typed or picked by
 * browsing the library. "Skip" keeps photos out of face recognition and
 * similar images; their faces are discarded. "Always include" analyses
 * photos fully, inside a skipped folder or past the crowd limit. Saving
 * applies the rules in the background.
 */

import { useEffect, useState } from 'react';

import { getMLRules, saveMLRules, type MLRule } from '../api/queries';
import type { Library } from '../api/types';
import { Dialog } from './Dialog';
import { type BrowserEntry, LibraryBrowser } from './LibraryBrowser';
import { FolderOpenIcon } from './ServerFolderBrowser';
import { Icon } from './ui/Icon';
import './IgnoreRulesDialog.css';
import './ServerFolderBrowser.css';

type Kind = MLRule['kind'];

const KINDS: Array<{ kind: Kind; label: string; hint: string }> = [
  {
    kind: 'skip',
    label: 'Skip',
    hint: 'Left out of face recognition and similar images. Faces already found there are discarded.',
  },
  {
    kind: 'always',
    label: 'Always include',
    hint: 'Analysed fully, even inside a skipped folder or with more faces than the crowd limit.',
  },
];

/** Rules use library-relative paths; accept an absolute one inside the library. */
function canonicalMLPath(root: string, path: string): string {
  const base = root.replace(/\/+$/, '');
  let p = path.trim();
  if (p === base) p = '';
  else if (p.startsWith(`${base}/`)) p = p.slice(base.length + 1);
  return p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

export default function MLRulesDialog({
  library,
  onClose,
  onSaved,
}: {
  library: Library;
  onClose: () => void;
  onSaved?: (rules: MLRule[]) => void;
}) {
  const [rules, setRules] = useState<MLRule[] | null>(null);
  const [kind, setKind] = useState<Kind>('skip');
  const [path, setPath] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMLRules(library.id)
      .then((resp) => {
        if (!cancelled) setRules(resp.rules ?? []);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setRules([]);
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [library.id]);

  const kindOf = (p: string) => (rules ?? []).find((r) => r.path === p)?.kind;

  // One path has one kind: adding it again with the other kind switches it.
  const add = (rule: MLRule) => {
    const p = canonicalMLPath(library.root, rule.path);
    if (!p || kindOf(p) === rule.kind) return;
    setRules((prev) => [...(prev ?? []).filter((r) => r.path !== p), { kind: rule.kind, path: p }]);
    setDirty(true);
    setError(null);
  };

  const remove = (p: string) => {
    setRules((prev) => (prev ?? []).filter((r) => r.path !== p));
    setDirty(true);
  };

  const save = async () => {
    if (!rules) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await saveMLRules(library.id, rules);
      onSaved?.(saved.rules);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const browserActions = (entry: BrowserEntry) => {
    const current = kindOf(entry.path);
    return (
      <>
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            className="button ignore-browser-action"
            onClick={() => add({ kind: k.kind, path: entry.path })}
            disabled={current === k.kind}
            title={`${k.label}: ${entry.path}`}
          >
            {current === k.kind ? (k.kind === 'skip' ? 'Skipped' : 'Included') : k.label}
          </button>
        ))}
      </>
    );
  };

  const current = KINDS.find((k) => k.kind === kind) ?? KINDS[0]!;
  const list = (k: Kind, empty: string) => {
    const items = (rules ?? []).filter((r) => r.kind === k);
    if (items.length === 0) return <p className="library-hint">{empty}</p>;
    return (
      <ul className="ignore-rule-list" data-testid={`ml-rules-${k}`}>
        {items.map((rule) => (
          <li key={rule.path} className="ignore-rule">
            <code className="ignore-rule-pattern" title={rule.path}>
              {rule.path}
            </code>
            <button
              type="button"
              className="icon-button ignore-rule-remove"
              onClick={() => remove(rule.path)}
              aria-label={`Remove the rule for ${rule.path}`}
              title="Remove"
            >
              <Icon name="close" size={16} />
            </button>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <Dialog
      open
      size="medium"
      title={`What machine learning looks at in ${library.name}`}
      onClose={onClose}
      dismissible={!busy}
      testId="ml-rules-dialog"
      footer={
        <>
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary-button"
            onClick={() => void save()}
            disabled={busy || !dirty || rules === null}
            data-testid="save-ml-rules"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="library-form">
        <div className="library-field">
          <span>Add a rule</span>
          <div className="segmented" role="radiogroup" aria-label="Rule">
            {KINDS.map((k) => (
              <button
                key={k.kind}
                type="button"
                role="radio"
                aria-checked={kind === k.kind}
                className={kind === k.kind ? 'segmented-item active' : 'segmented-item'}
                onClick={() => setKind(k.kind)}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>

        <div className="library-field">
          <label htmlFor="ml-rule-path">Folder or file</label>
          <form
            className="library-path-row"
            onSubmit={(e) => {
              e.preventDefault();
              add({ kind, path });
              setPath('');
            }}
          >
            <input
              id="ml-rule-path"
              type="text"
              className="library-input"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="Screenshots or 2019/concert.jpg"
              autoFocus
              data-testid="ml-rule-path"
            />
            <button
              type="button"
              className="button library-browse"
              onClick={() => setBrowsing((open) => !open)}
              aria-expanded={browsing}
              title="Browse this library's folders and files"
              data-testid="ml-rule-browse"
            >
              <FolderOpenIcon />
              <span>Browse</span>
            </button>
            <button
              type="submit"
              className="button library-browse"
              disabled={path.trim() === '' || rules === null}
              data-testid="ml-rule-add"
            >
              <Icon name="plus" size={18} />
              <span>Add</span>
            </button>
          </form>
          <p className="library-hint">
            {current.hint} A path inside the library, relative to its folder or absolute; a folder
            counts with everything in it.
          </p>
        </div>

        {browsing && (
          <LibraryBrowser
            library={library}
            actions={browserActions}
            onClose={() => setBrowsing(false)}
          />
        )}

        {rules === null ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <div className="library-field">
              <span>Skipped</span>
              {list('skip', 'Nothing is skipped.')}
            </div>
            <div className="library-field">
              <span>Always included</span>
              {list('always', 'Nothing has been singled out to always include.')}
            </div>
          </>
        )}

        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
