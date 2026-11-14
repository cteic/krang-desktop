import { Channel, invoke } from '@tauri-apps/api/core';
import {
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { z } from 'zod';

import type { ChatContent } from '../../workspace/model';
import { useDebugSnapshot } from '../debug-snapshot';
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

const exitSchema = z.object({
  exitCode: z.number().nullable(),
  stderr: z.string(),
});

const REMARK_PLUGINS = [remarkGfm];
// How close to the bottom still counts as "following the newest content".
const FOLLOW_SLACK_PX = 24;
const COMPOSER_MAX_PX = 132;

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
  const [mode, setMode] = useState<ModeId>(DEFAULT_MODE);
  const [draft, setDraft] = useState('');

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
    if (text === '' || running) {
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

    const onLine = new Channel<string>();
    onLine.onmessage = (line) => {
      if (runIdRef.current !== id) {
        return;
      }
      for (const event of adapter.parseLine(line)) {
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
      if (!activeRef.current) {
        actionsRef.current.setBadge({ text: 'done', color: null });
      }
    };

    invoke('agent_run', {
      id,
      agent,
      args: adapter.buildArgs({ mode, directory, sessionId: transcript.sessionId }),
      cwd: directory,
      prompt: text,
      onLine,
      onExit,
    }).catch((error: unknown) => {
      if (runIdRef.current === id) {
        runIdRef.current = null;
        dispatch({ type: 'start-failed', message: errorText(error) });
      }
    });
  }

  function stop() {
    if (cancelRun()) {
      dispatch({ type: 'stop' });
    }
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
    actions.replaceContent({ type: 'chat', agent: next, directory });
  }

  function onModeChange(event: ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value;
    if (isModeId(next)) {
      setMode(next);
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

      <div className="chat-composer">
        <textarea
          ref={composerRef}
          className="chat-input"
          aria-label="Message"
          placeholder={`Message ${ADAPTERS[agent].label}`}
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
          <button type="button" className="chat-send" disabled={draft.trim() === ''} onClick={send}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
