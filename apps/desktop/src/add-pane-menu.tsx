import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';

import type { PaneContent } from './workspace/model';

export interface AddPaneChoice {
  label: string;
  content: PaneContent;
}

export interface AddPaneMenuProps {
  choices: readonly AddPaneChoice[];
  disabled: boolean;
  onAdd: (content: PaneContent) => void;
}

/** One button that opens the list of pane types. Choosing one adds that pane. */
export function AddPaneMenu({ choices, disabled, onAdd }: AddPaneMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  function items(): HTMLButtonElement[] {
    return Array.from(listRef.current?.querySelectorAll('button') ?? []);
  }

  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) {
      buttonRef.current?.focus();
    }
  }

  function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const all = items();
    const at = all.findIndex((item) => item === document.activeElement);
    const last = all.length - 1;
    let next: number | null = null;
    if (event.key === 'ArrowDown') {
      next = at >= last ? 0 : at + 1;
    } else if (event.key === 'ArrowUp') {
      next = at <= 0 ? last : at - 1;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = last;
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') {
      close(false);
    }
    if (next !== null) {
      event.preventDefault();
      all[next]?.focus();
    }
  }

  useEffect(() => {
    if (!open) {
      return;
    }
    listRef.current?.querySelector('button')?.focus();

    function onPointerDown(event: PointerEvent) {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        setOpen(false);
      }
    }
    // A click inside a web pane's frame never reaches this document. The
    // window losing focus to the frame is what says it happened.
    function onWindowBlur() {
      setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [open]);

  return (
    <div className="add-pane" ref={rootRef}>
      <button
        ref={buttonRef}
        className="add-pane-button"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={() => {
          setOpen((was) => !was);
        }}
      >
        Add pane
      </button>
      {open ? (
        <div
          className="add-pane-list"
          id={listId}
          ref={listRef}
          role="menu"
          aria-label="Add pane"
          onKeyDown={onListKeyDown}
        >
          {choices.map((choice) => (
            <button
              className="add-pane-item"
              type="button"
              role="menuitem"
              key={choice.label}
              onClick={() => {
                setOpen(false);
                onAdd(choice.content);
              }}
            >
              {choice.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
