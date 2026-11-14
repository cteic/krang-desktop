import { Channel, invoke } from '@tauri-apps/api/core';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';

import type { TerminalNode } from './layout/layout';
import { toBytes } from './pty-chunk';
import { bufferText } from './terminal-text';
import { whenQuiet } from './when-quiet';

export interface TerminalPaneProps {
  node: TerminalNode;
  title: string;
  accent: string;
  autoFocus: boolean;
  debug: boolean;
}

interface ExitInfo {
  exitCode: number;
  success: boolean;
}

// Escape then carriage return. Terminal agents read it as "insert a newline",
// the same as Option+Enter, where a bare Enter would submit the prompt.
const NEWLINE_WITHOUT_SUBMIT = '\u001b\r';
const DEBUG_SNAPSHOT_MS = 1000;
const PROMPT_QUIET_MS = 500;
const PROMPT_WAIT_LIMIT_MS = 4000;

function report(error: unknown) {
  console.error('[terminal-pane]', error);
}

export function TerminalPane({ node, title, accent, autoFocus, debug }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }

    // A fresh id per mount. React runs this effect twice in development, and
    // the second shell must not collide with the first one's teardown.
    const id = crypto.randomUUID();
    let disposed = false;
    let renderer = 'dom';

    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: '"SF Mono", Menlo, Monaco, monospace',
      fontSize: 13,
      macOptionIsMeta: true,
      scrollback: 10000,
      theme: { background: '#0b0e14', foreground: '#c9d1d9' },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);

    // The GPU renderer is what keeps full-screen redraws from tearing. If the
    // context is lost or never starts, the DOM renderer takes over.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        renderer = 'dom';
      });
      terminal.loadAddon(webgl);
      renderer = 'webgl';
    } catch (error) {
      report(error);
    }

    fit.fit();

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.key === 'Enter' && event.shiftKey && !event.metaKey && !event.ctrlKey) {
        if (event.type === 'keydown') {
          invoke('pty_write', { id, data: NEWLINE_WITHOUT_SUBMIT }).catch(report);
        }
        return false;
      }
      return true;
    });

    // Startup commands are typed into the shell, one line each, exactly as if
    // entered by hand. The shell stays open afterwards, which a `-c`
    // invocation would not. They wait for the prompt to settle first.
    const startup =
      node.commands.length === 0
        ? null
        : whenQuiet(
            () => {
              const typed = node.commands.map((command) => `${command}\r`).join('');
              invoke('pty_write', { id, data: typed }).catch(report);
            },
            PROMPT_QUIET_MS,
            PROMPT_WAIT_LIMIT_MS,
          );

    const onData = new Channel<unknown>();
    onData.onmessage = (message) => {
      if (!disposed) {
        terminal.write(toBytes(message));
        startup?.touch();
      }
    };

    const onExit = new Channel<ExitInfo>();
    onExit.onmessage = (info) => {
      if (!disposed) {
        terminal.write(`\r\n[process exited with code ${String(info.exitCode)}]\r\n`);
      }
    };

    const inputSubscription = terminal.onData((data) => {
      invoke('pty_write', { id, data }).catch(report);
    });
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      invoke('pty_resize', { id, cols, rows }).catch(report);
    });

    const observer = new ResizeObserver(() => {
      fit.fit();
    });
    observer.observe(host);

    function onFocusIn() {
      setActive(true);
    }
    function onFocusOut() {
      setActive(false);
    }
    host.addEventListener('focusin', onFocusIn);
    host.addEventListener('focusout', onFocusOut);

    invoke('pty_spawn', {
      id,
      cwd: node.directory,
      program: null,
      args: null,
      cols: terminal.cols,
      rows: terminal.rows,
      onData,
      onExit,
    }).catch((error: unknown) => {
      startup?.cancel();
      report(error);
      terminal.write(`\r\n[could not start a shell: ${String(error)}]\r\n`);
    });

    const snapshotTimer = debug
      ? window.setInterval(() => {
          const header = `renderer=${renderer} cols=${String(terminal.cols)} rows=${String(terminal.rows)}\n`;
          const text = header + bufferText(terminal.buffer.active);
          invoke('debug_snapshot', { id: node.id, text }).catch(report);
        }, DEBUG_SNAPSHOT_MS)
      : null;

    if (autoFocus) {
      terminal.focus();
    }

    return () => {
      disposed = true;
      startup?.cancel();
      if (snapshotTimer !== null) {
        window.clearInterval(snapshotTimer);
      }
      host.removeEventListener('focusin', onFocusIn);
      host.removeEventListener('focusout', onFocusOut);
      observer.disconnect();
      inputSubscription.dispose();
      resizeSubscription.dispose();
      invoke('pty_kill', { id }).catch(report);
      terminal.dispose();
    };
  }, [node, autoFocus, debug]);

  return (
    <section className="pane" data-active={active} data-pane-id={node.id}>
      <header className="pane-title" style={{ background: accent }}>
        {title}
      </header>
      <div className="pane-body" ref={hostRef} />
    </section>
  );
}
