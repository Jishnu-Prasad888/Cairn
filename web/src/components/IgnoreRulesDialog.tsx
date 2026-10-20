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

import { browseLibrary, getIgnoreRules, saveIgnoreRules, triggerIndex } from '../api/queries';
import type { IgnoreRule, LibraryListing } from '../api/queries';
import type { Library } from '../api/types';
import { Dialog } from './Dialog';
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

/** Walks one library's folders and files and offers each as something to ignore. */
function LibraryBrowser({
  library,
  isIgnored,
  onIgnore,
  onClose,
}: {
  library: Library;
  isIgnored: (rule: IgnoreRule) => boolean;
  onIgnore: (rule: IgnoreRule) => void;
  onClose: () => void;
}) {
  const [target, setTarget] = useState('');
  const [listing, setListing] = useState<LibraryListing | null>(null);
  const [failure, setFailure] = useState<{ target: string; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    browseLibrary(library.id, target)
      .then((resp) => {
        if (cancelled) return;
        setListing(resp);
        setFailure(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setFailure({ target, message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [library.id, target]);

  const atRoot = !listing || listing.path === '';
  const here = listing?.path ?? '';

  const ignoreButton = (rule: IgnoreRule, label: string, title: string) => {
    const done = isIgnored(rule);
    return (
      <button
        type="button"
        className="button ignore-browser-action"
        onClick={() => onIgnore(rule)}
        disabled={done}
        title={done ? 'Already ignored' : title}
      >
        {done ? 'Ignored' : label}
      </button>
    );
  };

  return (
    <div className="folder-browser" data-testid="library-browser">
      <div className="folder-browser-bar">
        <button
          type="button"
          className="button"
          onClick={() => listing && setTarget(listing.parent)}
          disabled={atRoot}
        >
          ↑ Up
        </button>
        <code className="folder-browser-path" title={here || library.root}>
          {listing ? `/${here}` : '…'}
        </code>
        {!atRoot && ignoreButton({ kind: 'path', pattern: here }, 'Ignore this folder', here)}
      </div>
      <ul className="folder-browser-list ignore-browser-list">
        {failure && failure.target === target && <li className="error-text">{failure.message}</li>}
        {listing && listing.dirs.length === 0 && listing.files.length === 0 && (
          <li className="muted">This folder is empty.</li>
        )}
        {listing?.dirs.map((dir) => (
          <li key={dir.path} className="ignore-browser-row">
            <button
              type="button"
              className="folder-browser-item"
              onClick={() => setTarget(dir.path)}
              title={`Open ${dir.name}`}
            >
              <span aria-hidden="true">📁</span> {dir.name}
            </button>
            {ignoreButton({ kind: 'path', pattern: dir.path }, 'Ignore', `Ignore ${dir.path}`)}
          </li>
        ))}
        {listing?.files.map((file) => {
          const ext = extensionOf(file.name);
          return (
            <li key={file.path} className="ignore-browser-row">
              <span className="ignore-browser-file" title={file.path}>
                <span aria-hidden="true">📄</span> {file.name}
              </span>
              {ext &&
                ignoreButton(
                  { kind: 'extension', pattern: ext },
                  `All .${ext}`,
                  `Ignore every .${ext} file`,
                )}
              {ignoreButton({ kind: 'path', pattern: file.path }, 'Ignore', `Ignore ${file.path}`)}
            </li>
          );
        })}
        {listing?.truncated && (
          <li className="muted">Only the first files of this folder are shown.</li>
        )}
      </ul>
      <div className="folder-browser-actions">
        <button type="button" className="button" onClick={onClose}>
          Done browsing
        </button>
      </div>
    </div>
  );
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
            isIgnored={isIgnored}
            onIgnore={add}
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
