import { useEffect, useEffectEvent, useReducer, useRef, useState } from 'react';
import type { KeyboardEvent, SyntheticEvent } from 'react';

import type { WebContent } from '../../workspace/model';
import { useDebugSnapshot } from '../debug-snapshot';
import type { PaneProps } from '../pane-props';

import {
  NO_HOME,
  START_SHORTCUTS,
  displayAddress,
  mayRefuseFraming,
  needsHome,
  resolveAddress,
} from './address';
import type { AddressResult } from './address';
import {
  EMPTY_HISTORY,
  backUrl,
  currentUrl,
  forwardUrl,
  historyReducer,
  initialHistory,
} from './history';
import type { HistoryState } from './history';
import { loadHome } from './home';
import './web-pane.css';

const SLOW_LOAD_MS = 10_000;
const COPIED_MS = 1500;
const FRAME_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads' as const;
const FRAMING_HINT =
  'Some sites refuse to load inside another app. If this stays blank, copy the address and open it in your browser.';

function report(error: unknown) {
  console.error('[web-pane]', error);
}

/** The history a pane starts with. A `~` path waits for the home folder. */
function startHistory(address: string): HistoryState {
  if (address === '' || needsHome(address)) {
    return EMPTY_HISTORY;
  }
  const result = resolveAddress(address, null);
  return result.ok ? initialHistory(result.url) : EMPTY_HISTORY;
}

export function WebPane({ name, content, active, debug, actions }: PaneProps<WebContent>) {
  const [history, dispatch] = useReducer(historyReducer, content.url, startHistory);
  // What is typed in the address field. Null shows the current address.
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loadedVisit, setLoadedVisit] = useState(0);
  const [slowVisit, setSlowVisit] = useState(0);
  const [hintDismissed, setHintDismissed] = useState(false);
  const [copied, setCopied] = useState(false);

  const addressRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(false);
  // The last `content.url` this pane has acted on or reported itself. A prop
  // equal to it is an echo and must not load the frame again.
  const handledRef = useRef(currentUrl(history) === '' ? '' : content.url);

  const url = currentUrl(history);
  const shown = displayAddress(url);
  const loaded = url !== '' && loadedVisit === history.visit;
  const slow = url !== '' && !loaded && slowVisit === history.visit;
  const back = backUrl(history);
  const forward = forwardUrl(history);
  const showHint = !hintDismissed && mayRefuseFraming(url);

  function recordAddress(next: string) {
    handledRef.current = next;
    actions.replaceContent({ type: 'web', url: next });
  }

  function finish(result: AddressResult, fromPerson: boolean) {
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setMessage(null);
    setDraft(null);
    dispatch({ type: 'navigate', url: result.url });
    if (fromPerson) {
      recordAddress(result.url);
    }
  }

  function open(address: string, fromPerson: boolean) {
    if (!needsHome(address)) {
      finish(resolveAddress(address, null), fromPerson);
      return;
    }
    loadHome().then(
      (home) => {
        if (mountedRef.current) {
          finish(resolveAddress(address, home), fromPerson);
        }
      },
      (error: unknown) => {
        report(error);
        if (mountedRef.current) {
          setMessage(NO_HOME);
        }
      },
    );
  }

  function move(type: 'back' | 'forward', target: string | null) {
    if (target === null) {
      return;
    }
    setMessage(null);
    setDraft(null);
    dispatch({ type });
    recordAddress(target);
  }

  function reload() {
    setMessage(null);
    dispatch({ type: 'reload' });
  }

  function focusAddress() {
    addressRef.current?.focus();
    addressRef.current?.select();
  }

  function onSubmit(event: SyntheticEvent) {
    event.preventDefault();
    open(draft ?? shown, true);
  }

  function onAddressKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      setDraft(null);
      setMessage(null);
    }
  }

  function copyAddress() {
    navigator.clipboard.writeText(shown).then(
      () => {
        if (mountedRef.current) {
          setCopied(true);
        }
      },
      (error: unknown) => {
        report(error);
        if (mountedRef.current) {
          setMessage('Could not copy the address.');
        }
      },
    );
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const openFromOutside = useEffectEvent((address: string) => {
    open(address, false);
  });

  useEffect(() => {
    if (content.url === handledRef.current) {
      return;
    }
    handledRef.current = content.url;
    if (content.url !== '') {
      openFromOutside(content.url);
    }
  }, [content.url]);

  useEffect(() => {
    if (active && url === '') {
      addressRef.current?.focus();
    }
  }, [active, url]);

  useEffect(() => {
    if (!active) {
      return;
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      const plainCommand = event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      if (plainCommand && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        focusAddress();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [active]);

  useEffect(() => {
    if (url === '' || loaded) {
      return;
    }
    const visit = history.visit;
    const timer = window.setTimeout(() => {
      setSlowVisit(visit);
    }, SLOW_LOAD_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [url, loaded, history.visit]);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => {
      setCopied(false);
    }, COPIED_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [copied]);

  useDebugSnapshot(
    name,
    debug,
    () =>
      `url=${url} loaded=${String(loaded)} history=${String(history.index + 1)}/${String(history.entries.length)}`,
  );

  return (
    <div className="web-pane">
      <form className="web-toolbar" onSubmit={onSubmit}>
        <button
          type="button"
          className="web-button"
          aria-label="Back"
          title="Back"
          disabled={back === null}
          onClick={() => {
            move('back', back);
          }}
        >
          {'←'}
        </button>
        <button
          type="button"
          className="web-button"
          aria-label="Forward"
          title="Forward"
          disabled={forward === null}
          onClick={() => {
            move('forward', forward);
          }}
        >
          {'→'}
        </button>
        <button
          type="button"
          className="web-button"
          aria-label="Reload"
          title="Reload"
          disabled={url === ''}
          onClick={reload}
        >
          {'↻'}
        </button>
        <input
          ref={addressRef}
          className="web-address"
          type="text"
          aria-label="Address"
          placeholder="Type a URL, localhost:3000 or a file path"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          value={draft ?? shown}
          onChange={(event) => {
            setDraft(event.target.value);
            setMessage(null);
          }}
          onKeyDown={onAddressKeyDown}
        />
        <button
          type="button"
          className="web-button web-copy"
          aria-label="Copy address"
          title="Copy address"
          disabled={url === ''}
          onClick={copyAddress}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </form>
      <div className="web-loading" data-loading={url !== '' && !loaded} aria-hidden="true" />
      {message !== null && (
        <p className="web-line web-message" role="alert">
          {message}
        </p>
      )}
      {showHint && (
        <p className="web-line web-hint">
          <span className="web-line-text">{FRAMING_HINT}</span>
          <button
            type="button"
            className="web-button"
            aria-label="Dismiss hint"
            title="Dismiss"
            onClick={() => {
              setHintDismissed(true);
            }}
          >
            {'×'}
          </button>
        </p>
      )}
      {slow && (
        <p className="web-line web-notice" role="status">
          <span className="web-line-text">Still loading.</span>
          <button type="button" className="web-button web-retry" onClick={reload}>
            Retry
          </button>
        </p>
      )}
      {url === '' ? (
        <div className="web-start">
          <p className="web-start-title">Open a page</p>
          <p className="web-start-text">
            Type a URL, a host or a file path above, or pick a local server.
          </p>
          <ul className="web-shortcuts">
            {START_SHORTCUTS.map((shortcut) => (
              <li key={shortcut}>
                <button
                  type="button"
                  className="web-shortcut"
                  onClick={() => {
                    open(shortcut, true);
                  }}
                >
                  {shortcut}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <iframe
          key={history.visit}
          className="web-frame"
          title={`Web page: ${shown}`}
          src={url}
          sandbox={FRAME_SANDBOX}
          referrerPolicy="no-referrer"
          onLoad={() => {
            setLoadedVisit(history.visit);
          }}
        />
      )}
    </div>
  );
}
