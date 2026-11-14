import { Channel, invoke } from '@tauri-apps/api/core';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';

import type { TerminalContent } from '../../workspace/model';
import type { PaneProps } from '../pane-props';

import { toBytes } from './pty-chunk';
import { bufferText } from './terminal-text';
import { whenQuiet } from './when-quiet';

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

export function TerminalPane({ paneId, name, content, active, debug }: PaneProps<TerminalContent>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);

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
    terminalRef.current = terminal;

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

    // A pane in a hidden tab keeps its size but a collapsed one has none.
    // Fitting to nothing would shrink the shell to one column.
    function fitIfVisible() {
      if (host !== null && host.clientWidth > 0 && host.clientHeight > 0) {
        fit.fit();
      }
    }
    fitIfVisible();

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
      content.commands.length === 0
        ? null
        : whenQuiet(
            () => {
              const typed = content.commands.map((command) => `${command}\r`).join('');
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

    const observer = new ResizeObserver(fitIfVisible);
    observer.observe(host);

    invoke('pty_spawn', {
      id,
      paneId,
      cwd: content.directory,
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
          invoke('debug_snapshot', { id: name, text }).catch(report);
        }, DEBUG_SNAPSHOT_MS)
      : null;

    return () => {
      disposed = true;
      startup?.cancel();
      if (snapshotTimer !== null) {
        window.clearInterval(snapshotTimer);
      }
      observer.disconnect();
      inputSubscription.dispose();
      resizeSubscription.dispose();
      invoke('pty_kill', { id }).catch(report);
      terminalRef.current = null;
      terminal.dispose();
    };
  }, [paneId, name, content, debug]);

  useEffect(() => {
    if (active) {
      terminalRef.current?.focus();
    }
  }, [active]);

  return <div className="terminal-host" ref={hostRef} />;
}
