import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

/**
 * Inline name field for a thought: Enter or leaving the field saves, Escape cancels. An empty name
 * gives the thought back its automatic label (shown as the placeholder).
 */
export function LabelField({
  initial,
  placeholder,
  onDone,
}: {
  initial: string;
  placeholder: string;
  /** The typed name (null when cancelled) and how the field was left. Called once. */
  onDone: (value: string | null, by: 'key' | 'blur') => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (v: string | null, by: 'key' | 'blur') => {
    if (done.current) return;
    done.current = true;
    onDone(v, by);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(value, 'key');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(null, 'key');
    }
  };
  return (
    <input
      ref={ref}
      type="text"
      className="nb-label-field"
      data-reader-field=""
      aria-label="Thought name"
      placeholder={placeholder}
      maxLength={120}
      autoComplete="off"
      spellCheck={false}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(value, 'blur')}
    />
  );
}
