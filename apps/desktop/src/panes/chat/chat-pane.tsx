import { Channel, invoke } from '@tauri-apps/api/core';
import {
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { z } from 'zod';

import type { Badge, ChatContent } from '../../workspace/model';
import { useDebugSnapshot } from '../debug-snapshot';
import { homeDirectory } from '../editor/fs-api';
import type { PaneActions, PaneProps } from '../pane-props';

import { ADAPTERS, AGENT_IDS, type AgentId, isAgentId, toAgentId } from './adapters';
import './chat-pane.css';
import { DEFAULT_MODE, MODE_IDS, MODE_LABELS, type ModeId, isModeId } from './modes';
import {
  EMPTY_TRANSCRIPT,
  type TranscriptItem,
  transcriptReducer,
  transcriptText,
} from './transcript';
import { folderKey, isHomeDirectory, isTrustedFolder, needsHome, trustFolder } from './trust';

const exitSchema = z.object({
  exitCode: z.number().nullable(),
  stderr: z.string(),
});

const REMARK_PLUGINS = [remarkGfm];
// How close to the bottom still counts as "following the newest content".
const FOLLOW_SLACK_PX = 24;
const COMPOSER_MAX_PX = 132;
const DONE_BADGE: Badge = { text: 'done', color: null };
const FAILED_BADGE: Badge = { text: 'failed', color: '#ff7b72' };

function report(error: unknown) {
  console.error('[chat-pane]', error);
}

function errorText(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  return error instanceof Error ? error.message : String(error);
}

interface ChatLinkProps {
  href?: string | undefined;
  children?: ReactNode;
  onOpen: (url: string) => void;
}

/** A link that never navigates the app window. Web links open in a pane. */
function ChatLink({ href, children, onOpen }: ChatLinkProps) {
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    if (href !== undefined && /^https?:\/\//i.test(href)) {
      onOpen(href);
    }
  }
  return (
    <a href={href} onClick={onClick}>
      {children}
    </a>
  );
}

interface ChatItemProps {
  item: TranscriptItem;
  onOpenLink: (url: string) => void;
}

const ChatItem = memo(function ChatItem({ item, onOpenLink }: ChatItemProps) {
  switch (item.kind) {
    case 'user':
      return <div className="chat-item chat-user">{item.text}</div>;
    case 'assistant':
      return (
        <div className="chat-item chat-assistant" data-streaming={item.streaming}>
          <Markdown
            remarkPlugins={REMARK_PLUGINS}
            components={{
              a: ({ href, children }) => (
                <ChatLink href={href} onOpen={onOpenLink}>
                  {children}
                </ChatLink>
              ),
              // An agent's reply can be steered by what it reads. An image
              // that loaded by itself would let such text send data out in
              // the address, with no click. Show it as a link instead.
              img: ({ src, alt }) => (
                <ChatLink href={typeof src === 'string' ? src : undefined} onOpen={onOpenLink}>
                  {alt === undefined || alt === '' ? 'image' : `image: ${alt}`}
                </ChatLink>
              ),
            }}
          >
            {item.text}
          </Markdown>
          {item.stopped ? <div className="chat-stopped">Stopped</div> : null}
        </div>
      );
    case 'tool':
      return (
        <div className="chat-item chat-tool">
          <span className="chat-tool-name">{item.name}</span>
          {item.summary === '' ? null : <span className="chat-tool-summary"> {item.summary}</span>}
        </div>
      );
    case 'note':
      return <div className="chat-item chat-note">{item.text}</div>;
    case 'error':
      return (
        <div className="chat-item chat-error" role="alert">
          {item.text}
        </div>
      );
  }
});

export function ChatPane({ name, content, active, debug, actions }: PaneProps<ChatContent>) {
  const [transcript, dispatch] = useReducer(transcriptReducer, EMPTY_TRANSCRIPT);
  const [agent, setAgent] = useState<AgentId>(() => toAgentId(content.agent));
  const [mode, setMode] = useState<ModeId>(content.mode ?? DEFAULT_MODE);
  const [draft, setDraft] = useState('');
  /** The home directory, asked for only when the directory starts with `~/`. */
  const [home, setHome] = useState<string | null>(null);
  const [homeSettled, setHomeSettled] = useState(false);
  /** The folder the person answered "Not now" for, so it is asked once. */
  const [declinedFolder, setDeclinedFolder] = useState<string | null>(null);
  /** Bumped when a folder is trusted, so the pane reads the list again. */
  const [, setTrustVersion] = useState(0);

  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  /** The id of the run in progress. Output from any other run is dropped. */
  const runIdRef = useRef<string | null>(null);
  const followRef = useRef(true);
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const activeRef = useRef(active);
  activeRef.current = active;
  const actionsRef = useRef<PaneActions>(actions);
  actionsRef.current = actions;

  const running = transcript.status === 'running';
  const directory = content.directory;
  const trustTextId = useId();

  // Trust comes only from the list the Trust button writes. The pane's
  // content, which a layout file or a link can set, has no say in it.
  const folder = folderKey(directory, home);
  const trusted = isHomeDirectory(directory) || (folder !== null && isTrustedFolder(folder));
  const needsTrust = ADAPTERS[agent].asksFolderTrust && !trusted;
  const resolvingFolder = folder === null && needsHome(directory) && !homeSettled;
  const askingTrust = needsTrust && folder !== null && declinedFolder !== folder;
  const showUntrusted = needsTrust && !askingTrust && !resolvingFolder;

  useDebugSnapshot(name, debug, () => transcriptText(agent, mode, transcript));

  /** Ends the run in progress, if there is one, and stops listening to it. */
  function cancelRun(): boolean {
    const id = runIdRef.current;
    if (id === null) {
      return false;
    }
    runIdRef.current = null;
    invoke('agent_cancel', { id }).catch(report);
    return true;
  }

  const cancelRunRef = useRef(cancelRun);
  cancelRunRef.current = cancelRun;

  function startNewChat() {
    cancelRun();
    dispatch({ type: 'reset' });
    followRef.current = true;
  }

  function send() {
    const text = draft.trim();
    if (text === '' || running || askingTrust) {
      return;
    }
    // A run that reported an error may not have exited yet. Let it go.
    cancelRun();
    const id = crypto.randomUUID();
    const adapter = ADAPTERS[agent];
    runIdRef.current = id;
    followRef.current = true;
    dispatch({ type: 'send', text });
    setDraft('');

    // An agent can report an error and still exit with code 0.
    let reportedError = false;
    const onLine = new Channel<string>();
    onLine.onmessage = (line) => {
      if (runIdRef.current !== id) {
        return;
      }
      for (const event of adapter.parseLine(line)) {
        if (event.type === 'error') {
          reportedError = true;
        }
        dispatch({ type: 'event', event });
      }
    };

    const onExit = new Channel<unknown>();
    onExit.onmessage = (message) => {
      if (runIdRef.current !== id) {
        return;
      }
      runIdRef.current = null;
      const exit = exitSchema.safeParse(message);
      dispatch({
        type: 'exit',
        exitCode: exit.success ? exit.data.exitCode : null,
        stderr: exit.success ? exit.data.stderr : '',
      });
      const failed = !exit.success || exit.data.exitCode !== 0 || reportedError;
      if (!activeRef.current) {
        actionsRef.current.setBadge(failed ? FAILED_BADGE : DONE_BADGE);
      }
    };

    invoke('agent_run', {
      id,
      agent,
      args: adapter.buildArgs({ mode, directory, sessionId: transcript.sessionId, trusted }),
      cwd: directory,
      prompt: text,
      onLine,
      onExit,
    }).catch((error: unknown) => {
      if (runIdRef.current === id) {
        runIdRef.current = null;
        dispatch({ type: 'start-failed', message: errorText(error) });
        if (!activeRef.current) {
          actionsRef.current.setBadge(FAILED_BADGE);
        }
      }
    });
  }

  function stop() {
    if (cancelRun()) {
      dispatch({ type: 'stop' });
    }
  }

  function onTrust() {
    if (folder !== null && trustFolder(folder)) {
      setTrustVersion((version) => version + 1);
      composerRef.current?.focus();
    }
  }

  function onNotNow() {
    setDeclinedFolder(folder);
    composerRef.current?.focus();
  }

  function onAgentChange(event: ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value;
    if (!isAgentId(next) || next === agent) {
      return;
    }
    // The ref moves first, so the content change coming back from the
    // workspace matches it and does not start a second new chat.
    agentRef.current = next;
    setAgent(next);
    startNewChat();
    actions.replaceContent({ ...content, agent: next });
  }

  function onModeChange(event: ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value;
    if (isModeId(next) && next !== mode) {
      setMode(next);
      // Kept in the pane's content, so a restored window opens in it.
      actions.replaceContent({ ...content, mode: next });
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }

  function onListScroll() {
    const list = listRef.current;
    if (list !== null) {
      followRef.current = list.scrollHeight - list.scrollTop - list.clientHeight <= FOLLOW_SLACK_PX;
    }
  }

  const onOpenLink = useCallback((url: string) => {
    actionsRef.current.openPane({ type: 'web', url });
  }, []);

  useEffect(() => {
    if (!needsHome(directory)) {
      return;
    }
    let current = true;
    homeDirectory()
      .then((path) => {
        if (current) {
          setHome(path);
        }
      })
      .catch(report)
      .finally(() => {
        if (current) {
          setHomeSettled(true);
        }
      });
    return () => {
      current = false;
    };
  }, [directory]);

  // The agent changed from outside the pane, a layout file for example.
  useEffect(() => {
    const next = toAgentId(content.agent);
    if (next !== agentRef.current) {
      agentRef.current = next;
      setAgent(next);
      cancelRunRef.current();
      dispatch({ type: 'reset' });
    }
  }, [content.agent]);

  // The mode changed from outside the pane, a layout file for example.
  useEffect(() => {
    setMode(content.mode ?? DEFAULT_MODE);
  }, [content.mode]);

  useEffect(() => {
    if (active) {
      actionsRef.current.setBadge(null);
      composerRef.current?.focus();
    }
  }, [active]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (list !== null && followRef.current) {
      list.scrollTop = list.scrollHeight;
    }
  }, [transcript.items]);

  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (composer !== null) {
      composer.style.height = 'auto';
      composer.style.height = `${String(Math.min(composer.scrollHeight, COMPOSER_MAX_PX))}px`;
    }
  }, [draft]);

  // A run must not outlive its pane.
  useEffect(() => {
    return () => {
      cancelRunRef.current();
    };
  }, []);

  return (
    <div className="chat-pane">
      <div className="chat-header">
        <select className="chat-select" aria-label="Agent" value={agent} onChange={onAgentChange}>
          {AGENT_IDS.map((id) => (
            <option key={id} value={id}>
              {ADAPTERS[id].label}
            </option>
          ))}
        </select>
        <span className="chat-directory" title="Working directory">
          {directory ?? '~'}
        </span>
        <select
          className="chat-select"
          aria-label="Mode"
          data-mode={mode}
          value={mode}
          onChange={onModeChange}
        >
          {MODE_IDS.map((id) => (
            <option key={id} value={id}>
              {MODE_LABELS[id]}
            </option>
          ))}
        </select>
        <button type="button" className="chat-new" onClick={startNewChat}>
          New chat
        </button>
      </div>

      <div className="chat-list" ref={listRef} onScroll={onListScroll}>
        {transcript.items.length === 0 ? (
          <p className="chat-empty">
            Ask {ADAPTERS[agent].label} something. It runs in {directory ?? '~'}. Mode:{' '}
            {MODE_LABELS[mode]}.
          </p>
        ) : null}
        {transcript.items.map((item) => (
          <ChatItem key={item.key} item={item} onOpenLink={onOpenLink} />
        ))}
        {running ? <div className="chat-working">Working…</div> : null}
      </div>

      {askingTrust ? (
        <div className="chat-trust" role="group" aria-label="Folder trust">
          <p className="chat-trust-text" id={trustTextId}>
            Trust this folder? Its own agent settings, skills and hooks will apply.
          </p>
          <button type="button" className="chat-trust-yes" data-primary="true" onClick={onTrust}>
            Trust
          </button>
          <button type="button" className="chat-trust-no" onClick={onNotNow}>
            Not now
          </button>
        </div>
      ) : null}
      {showUntrusted ? (
        <div className="chat-trust" role="status">
          <p className="chat-trust-text">
            Folder not trusted. Its own agent settings, hooks, skills, instructions file (CLAUDE.md)
            and tool servers are off, so a skill installed in this folder will not run.
          </p>
          {folder === null ? null : (
            <button type="button" className="chat-trust-yes" onClick={onTrust}>
              Trust folder
            </button>
          )}
        </div>
      ) : null}

      <div className="chat-composer" data-waiting={askingTrust ? 'trust' : undefined}>
        <textarea
          ref={composerRef}
          className="chat-input"
          aria-label="Message"
          aria-describedby={askingTrust ? trustTextId : undefined}
          placeholder={
            askingTrust
              ? 'Answer the trust question above to send'
              : `Message ${ADAPTERS[agent].label}`
          }
          rows={1}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={onComposerKeyDown}
        />
        {running ? (
          <button type="button" className="chat-stop" onClick={stop}>
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="chat-send"
            disabled={draft.trim() === '' || askingTrust}
            title={askingTrust ? 'Answer the question above first' : undefined}
            onClick={send}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
