/**
 * What a library's scans leave out.
 *
 * A person can ignore a folder or file inside the library, every file of one
 * type, or anything whose name matches a pattern (`Thumbs.db`, `*.tmp`,
 * `@eaDir`). Paths can be typed or picked by browsing the library's own
 * folders and files. Saving starts a scan, which hides files a new rule covers
 * and brings back ones a removed rule no longer does.
 */

import { useEffect, useState } from 'react';

import { getIgnoreRules, saveIgnoreRules, triggerIndex } from '../api/queries';
import type { IgnoreRule } from '../api/queries';
import type { Library } from '../api/types';
import { Dialog } from './Dialog';
import { type BrowserEntry, LibraryBrowser } from './LibraryBrowser';
import { FolderOpenIcon } from './ServerFolderBrowser';
import { Icon } from './ui/Icon';
import './IgnoreRulesDialog.css';
import './ServerFolderBrowser.css';

type Kind = IgnoreRule['kind'];

const KINDS: Array<{ kind: Kind; label: string; placeholder: string; hint: string }> = [
  {
    kind: 'path',
    label: 'Folder or file',
    placeholder: '2019/raw',
    hint: 'A path inside the library, relative to its folder or absolute. A folder is ignored with everything in it.',
  },
  {
    kind: 'extension',
    label: 'File type',
    placeholder: 'xmp',
    hint: 'An extension, with or without the dot. Matches any letter case.',
  },
  {
    kind: 'name',
    label: 'Name',
    placeholder: 'Thumbs.db or *.tmp',
    hint: 'A file or folder name anywhere in the library. Use * and ? as wildcards; matches any letter case.',
  },
];

const KIND_LABEL: Record<Kind, string> = {
  path: 'Path',
  extension: 'Type',
  name: 'Name',
};

/** The extension of a file name, without the dot, or '' when it has none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** The library's rules use relative paths; accept an absolute one inside it. */
function relativeTo(root: string, path: string): string {
  const base = root.replace(/\/+$/, '');
  if (path === base) return '';
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

function canonical(rule: IgnoreRule, root: string): IgnoreRule {
  let pattern = rule.pattern.trim();
  if (rule.kind === 'path') pattern = relativeTo(root, pattern).replace(/^\/+|\/+$/g, '');
  if (rule.kind === 'extension') pattern = pattern.replace(/^\*?\./, '').toLowerCase();
  return { kind: rule.kind, pattern };
}

export default function IgnoreRulesDialog({
  library,
  onClose,
  onSaved,
}: {
  library: Library;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [rules, setRules] = useState<IgnoreRule[] | null>(null);
  const [kind, setKind] = useState<Kind>('path');
  const [pattern, setPattern] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getIgnoreRules(library.id)
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

  const current = KINDS.find((k) => k.kind === kind) ?? KINDS[0]!;

  const isIgnored = (rule: IgnoreRule) => {
    const c = canonical(rule, library.root);
    return (rules ?? []).some((r) => r.kind === c.kind && r.pattern === c.pattern);
  };

  const add = (rule: IgnoreRule) => {
    const c = canonical(rule, library.root);
    if (!c.pattern || isIgnored(c)) return;
    setRules((prev) => [...(prev ?? []), c]);
    setDirty(true);
    setError(null);
  };

  const ignoreButton = (rule: IgnoreRule, label: string, title: string) => {
    const done = isIgnored(rule);
    return (
      <button
        type="button"
        className="button ignore-browser-action"
        onClick={() => add(rule)}
        disabled={done}
        title={done ? 'Already ignored' : title}
      >
        {done ? 'Ignored' : label}
      </button>
    );
  };

  const browserActions = (entry: BrowserEntry) => {
    const rule: IgnoreRule = { kind: 'path', pattern: entry.path };
    if (entry.kind === 'here') return ignoreButton(rule, 'Ignore this folder', entry.path);
    const ext = entry.kind === 'file' ? extensionOf(entry.name) : '';
    return (
      <>
        {ext &&
          ignoreButton(
            { kind: 'extension', pattern: ext },
            `All .${ext}`,
            `Ignore every .${ext} file`,
          )}
        {ignoreButton(rule, 'Ignore', `Ignore ${entry.path}`)}
      </>
    );
  };

  const addTyped = () => {
    add({ kind, pattern });
    setPattern('');
  };

  const remove = (index: number) => {
    setRules((prev) => (prev ?? []).filter((_, i) => i !== index));
    setDirty(true);
  };

  const save = async () => {
    if (!rules) return;
    setBusy(true);
    setError(null);
    try {
      await saveIgnoreRules(library.id, rules);
      // The scan applies the new rules: files they cover drop out of every
      // page, and files a removed rule covered come back with their tags.
      await triggerIndex(library.id);
      onSaved?.();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      size="medium"
      title={`Ignored in ${library.name}`}
      onClose={onClose}
      dismissible={!busy}
      testId="ignore-rules-dialog"
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
            data-testid="save-ignore-rules"
          >
            {busy ? 'Saving…' : 'Save and rescan'}
          </button>
        </>
      }
    >
      <div className="library-form">
        <div className="library-field">
          <span>Ignore by</span>
          <div className="segmented" role="radiogroup" aria-label="Ignore by">
            {KINDS.map((k) => (
              <button
                key={k.kind}
                type="button"
                role="radio"
                aria-checked={kind === k.kind}
                className={kind === k.kind ? 'segmented-item active' : 'segmented-item'}
                onClick={() => {
                  setKind(k.kind);
                  if (k.kind !== 'path') setBrowsing(false);
                }}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>

        <div className="library-field">
          <label htmlFor="ignore-pattern">{current.label}</label>
          <form
            className="library-path-row"
            onSubmit={(e) => {
              e.preventDefault();
              addTyped();
            }}
          >
            <input
              id="ignore-pattern"
              type="text"
              className="library-input"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder={current.placeholder}
              autoFocus
              data-testid="ignore-pattern-input"
            />
            {kind === 'path' && (
              <button
                type="button"
                className="button library-browse"
                onClick={() => setBrowsing((open) => !open)}
                aria-expanded={browsing}
                title="Browse this library's folders and files"
                data-testid="browse-library"
              >
                <FolderOpenIcon />
                <span>Browse</span>
              </button>
            )}
            <button
              type="submit"
              className="button library-browse"
              disabled={pattern.trim() === '' || rules === null}
              data-testid="add-ignore-rule"
            >
              <Icon name="plus" size={18} />
              <span>Add</span>
            </button>
          </form>
          <p className="library-hint">{current.hint}</p>
        </div>

        {browsing && kind === 'path' && (
          <LibraryBrowser
            library={library}
            actions={browserActions}
            onClose={() => setBrowsing(false)}
          />
        )}

        <div className="library-field">
          <span>Ignored now</span>
          {rules === null ? (
            <p className="muted">Loading…</p>
          ) : rules.length === 0 ? (
            <p className="library-hint">
              Nothing is ignored. Every file in the library is indexed.
            </p>
          ) : (
            <ul className="ignore-rule-list" data-testid="ignore-rule-list">
              {rules.map((rule, i) => (
                <li key={`${rule.kind}:${rule.pattern}`} className="ignore-rule">
                  <span className="ignore-rule-kind">{KIND_LABEL[rule.kind]}</span>
                  <code className="ignore-rule-pattern" title={rule.pattern}>
                    {rule.kind === 'extension' ? `.${rule.pattern}` : rule.pattern}
                  </code>
                  <button
                    type="button"
                    className="icon-button ignore-rule-remove"
                    onClick={() => remove(i)}
                    aria-label={`Stop ignoring ${rule.pattern}`}
                    title="Stop ignoring"
                  >
                    <Icon name="close" size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="library-hint">
            Files already indexed that a rule covers are hidden after the scan. Their tags and
            albums are kept, and come back if you remove the rule.
          </p>
        </div>

        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
